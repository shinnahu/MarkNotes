import { useEffect, useState } from 'preact/hooks';
import * as api from '../api.js';
import { settings, setSetting, toast, activeWsId, refreshWorkspaces, loadNotes, workspaces, notesByWs } from '../store.js';
import { Icon } from './icons.jsx';
import { confirm } from './dialogs.jsx';
import { relTime, fmtBytes } from '../util.js';
import { isPhone } from './PhoneSync.jsx';

// Settings › Trash on the phone: what was deleted here, or removed here by a sync because it was deleted on the PC.
// It stays until restored or deleted for good; emptying by date happens only when the user picks it.

const DAY = 24 * 3600 * 1000;
const ICON = { note: 'file-text', canvas: 'canvas', image: 'image', video: 'film', folder: 'folder', workspace: 'layers', file: 'file' };

let lastAuto = 0;

/**
 * Phone start-up: empties the trash, and drops old syncs with the versions they kept, by date only if the user turned
 * that on (Settings › Trash, Settings › Sync with PC).
 */
export function installTrash() {
  if (!isPhone()) return;
  const run = () => {
    lastAuto = Date.now();
    const days = Number(settings.value.trashDays) || 0;
    if (days > 0) api.call('trash.autoEmpty', { days }).catch(() => {});
    const keep = Number(settings.value.historyDays) || 0;
    if (keep > 0) api.call('sync.pruneHistory', { days: keep }).catch(() => {});
  };
  run();
  api.on('app.focus', () => { if (Date.now() - lastAuto > 6 * 3600 * 1000) run(); });
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Items deleted together (same cause, within two minutes of each other) are shown, and can be restored, as one group. */
function groupItems(items) {
  const out = [];
  for (const it of items) {
    const g = out[out.length - 1];
    if (g && g.by === it.by && (g.pc || '') === (it.pc || '') && g.last - it.at <= 120000) {
      g.items.push(it);
      g.last = it.at;
    } else out.push({ by: it.by, pc: it.pc, at: it.at, last: it.at, items: [it] });
  }
  return out;
}

function cause(g) {
  return g.by === 'sync' ? `Deleted on ${g.pc || 'your PC'}, removed here by a sync` : 'Deleted on this phone';
}

function where(it) {
  const count = it.dir ? ` · ${plural(it.notes || 0, 'note')}` : '';
  if (it.kind === 'workspace') return `Workspace${count}`;
  if (!it.from) return `Goes back into the workspace you have open${count}`;
  const parts = it.from.split('/');
  return [it.ws || parts[0], ...parts.slice(1, -1)].join(' › ') + count;
}

async function reloadLists() {
  await refreshWorkspaces();
  const active = activeWsId.value;
  if (active) await loadNotes(active);
  for (const w of workspaces.value) {
    if (w.id !== active && notesByWs.value[w.id]) await loadNotes(w.id, false).catch(() => {});
  }
}

export function TrashSection() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.call('trash.list').then(setData).catch((e) => { toast(e.message, 'error'); setData({ items: [], bytes: 0 }); });
  useEffect(() => { load(); }, []);
  const items = (data && data.items) || [];
  const days = Number(settings.value.trashDays) || 0;

  const restore = async (list) => {
    setBusy(true);
    try {
      const r = await api.call('trash.restore', { ids: list.map((i) => i.id), wsId: activeWsId.value });
      const back = r.restored || [];
      for (const e of r.errors || []) toast(e.error, 'error', 7000);
      if (back.length) {
        await reloadLists().catch(() => {});
        toast(back.length === 1 ? `“${back[0].name}” is back${back[0].ws ? ` in ${back[0].ws}` : ''}.` : `${back.length} items are back where they were.`, 'success', 4000);
        const renamed = back.filter((x) => x.renamed);
        if (renamed.length) {
          toast(`${renamed.length === 1 ? `“${renamed[0].name}”` : plural(renamed.length, 'item')} came back with “(restored)” in the name: something else has the old name now.`, 'info', 8000);
        }
      }
    } catch (e) {
      toast(e.message, 'error');
    }
    setBusy(false);
    load();
  };

  const destroy = async (it) => {
    if (!await confirm({ title: 'Delete forever?', body: `“${it.name}” will be deleted for good. This can't be undone.`, ok: 'Delete forever', danger: true })) return;
    try { await api.call('trash.delete', { ids: [it.id] }); } catch (e) { toast(e.message, 'error'); }
    load();
  };

  const emptyAll = async () => {
    if (!await confirm({ title: 'Empty the trash?', body: `${plural(items.length, 'item')} will be deleted for good. This can't be undone.`, ok: 'Empty trash', danger: true })) return;
    try { await api.call('trash.empty'); } catch (e) { toast(e.message, 'error'); }
    load();
  };

  const setDays = async (next) => {
    if (next > 0) {
      const old = items.filter((i) => i.at < Date.now() - next * DAY).length;
      if (old && !await confirm({
        title: `Empty after ${next} days?`,
        body: `${plural(old, 'item')} in the trash ${old === 1 ? 'was' : 'were'} deleted more than ${next} days ago and will be deleted for good now. This can't be undone.`,
        ok: 'Delete them', danger: true,
      })) { load(); return; }
    }
    setSetting('trashDays', next);
    if (next > 0) {
      try { await api.call('trash.autoEmpty', { days: next }); } catch (e) { toast(e.message, 'error'); }
    }
    load();
  };

  return (
    <>
      <h2>Trash</h2>
      <p class="set-hint">What you delete on this phone waits here, and so does what a sync removes here because it was deleted on your PC. It stays until you restore it or delete it for good.</p>
      <div class="set-group">
        <div class="set-row">
          <div class="set-text">
            <div class="set-label">Empty the trash automatically</div>
            <div class="set-hint">{days ? `Items are deleted for good ${days} days after they were deleted.` : 'Never: items stay until you delete them here.'}</div>
          </div>
          <div class="set-control">
            <select class="select" value={String(days)} onChange={(e) => setDays(Number(e.currentTarget.value))}>
              <option value="0">Never</option>
              <option value="30">After 30 days</option>
            </select>
          </div>
        </div>
      </div>
      {data === null ? null : !items.length ? <p class="set-hint trash-empty"><Icon name="trash" size={16} /> The trash is empty.</p> : (
        <>
          <div class="trash-summary">
            <span class="muted small">{plural(items.length, 'item')} · {fmtBytes(data.bytes || 0)}</span>
            <button class="btn small ghost danger" disabled={busy} onClick={emptyAll}>Empty trash</button>
          </div>
          {groupItems(items).map((g) => (
            <div class="trash-group" key={g.items[0].id}>
              <div class="trash-head">
                <span class="trash-cause"><Icon name={g.by === 'sync' ? 'refresh' : 'smartphone'} size={14} /> {cause(g)} · {relTime(g.at)}</span>
                {g.items.length > 1 ? <button class="btn small" disabled={busy} onClick={() => restore(g.items)}><Icon name="undo" size={14} /> Restore all {g.items.length}</button> : null}
              </div>
              {g.items.map((it) => (
                <div class="sync-item trash-item" key={it.id}>
                  <Icon name={ICON[it.kind] || 'file'} size={20} />
                  <div class="sync-item-text">
                    <div class="sync-item-name">{it.name}</div>
                    <div class="muted small">{where(it)}</div>
                  </div>
                  <button class="btn small" disabled={busy} onClick={() => restore([it])}>Restore</button>
                  <button class="icon-btn" aria-label="Delete forever" title="Delete forever" disabled={busy} onClick={() => destroy(it)}><Icon name="trash" size={17} /></button>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </>
  );
}
