// Sync between MarkNotes on the PC and MarkNotes on an Android phone, over the home Wi-Fi only.
// PC: Settings › Phone (the PC answers; pairing asks for Allow here). Phone: Settings › Sync (the phone syncs).
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import * as api from '../api.js';
import {
  settings, setSetting, toast, hostInfo, refreshWorkspaces, loadNotes, notesByWs, activeWsId, workspaces,
} from '../store.js';
import { checkExternalChanges, flushAll, switchWorkspace } from '../docs.js';
import { Icon } from './icons.jsx';
import { openModal, Dialog, confirm } from './dialogs.jsx';
import { relTime, fmtBytes } from '../util.js';
import { openSettings } from './Settings.jsx';

export const isPhone = () => hostInfo.value && hostInfo.value.platform === 'android';

/** PC: the server's status. Phone: paired PCs, whether a sync runs, the last result. */
export const syncState = signal(null);
/** Phone: what the running sync is doing ({pc, ws, done, total, path}). */
export const syncProgress = signal(null);

export async function refreshSyncState() {
  try { syncState.value = await api.call('sync.status'); } catch { /* host without sync */ }
  return syncState.value;
}

api.on('sync.state', (s) => { syncState.value = s; if (s && !s.running) syncProgress.value = null; });
api.on('sync.progress', (p) => { syncProgress.value = p; });

// Both sides: a sync changed files here, so the lists and open notes are read again.
api.on('sync.changed', async (d) => {
  try {
    await refreshWorkspaces();
    const ids = ((d && d.workspaces) || []).filter((id) => workspaces.value.some((w) => w.id === id));
    // The open workspace may be gone (the phone's empty starter workspace replaced by the PC's).
    if (workspaces.value.length && !workspaces.value.some((w) => w.id === activeWsId.value)) {
      const next = workspaces.value.find((w) => ids.includes(w.id)) || workspaces.value[0];
      await switchWorkspace(next.id);
    }
    for (const id of ids) {
      if (id === activeWsId.value) await loadNotes(id);
      else if (notesByWs.value[id]) await loadNotes(id, false);
    }
    await checkExternalChanges();
  } catch (e) {
    console.error('sync.changed', e);
  }
});

const Spinner = () => <span class="sync-spin"><Icon name="refresh" size={15} /></span>;

// ───────────────────────────── PC: a phone asks to pair ─────────────────────────────

const asks = new Map();

api.on('sync.pairRequest', (d) => {
  const answer = (allow) => {
    asks.delete(d.id);
    api.call('sync.pairAnswer', { id: d.id, allow }).catch(() => {});
  };
  openModal((close) => {
    asks.set(d.id, close);
    return (
      <Dialog title="Pair a phone" onClose={() => { answer(false); close(); }}
        footer={<>
          <button class="btn ghost" onClick={() => { answer(false); close(); }}>Deny</button>
          <button class="btn primary" onClick={() => { answer(true); close(); }}>Allow</button>
        </>}>
        <p class="dialog-text"><b>{d.device}</b>{d.model && d.model !== d.device ? ` (${d.model})` : ''} wants to sync notes with this PC.</p>
        <div class="pair-code">{d.code}</div>
        <p class="dialog-text muted">Allow it only if your phone shows the same code.</p>
      </Dialog>
    );
  }, { dismissable: false });
});

api.on('sync.pairDone', (d) => {
  const close = asks.get(d.id);
  if (close) { asks.delete(d.id); close(); }
  if (d.result === 'paired') toast(`${d.device || 'The phone'} is linked to this PC.`, 'success', 5000);
  else if (d.result === 'timeout') toast('Pairing timed out. Try again from the phone.', 'warning', 6000);
});

/** PC: the Pair a phone window. Pairing is open only while it is on screen. */
function pairWindow() {
  api.call('sync.pairing', { on: true }).catch((e) => toast(e.message, 'error'));
  return openModal((close) => <PairWindow close={close} />).finally(() => {
    api.call('sync.pairing', { on: false }).catch(() => {});
  });
}

function PairWindow({ close }) {
  const s = syncState.value || {};
  const before = (s.devices || []).length;
  const [start] = useState(before);
  useEffect(() => {
    if ((s.devices || []).length > start) close();
  }, [(s.devices || []).length]);
  return (
    <Dialog title="Pair a phone" onClose={() => close()} width={500}
      footer={<button class="btn" onClick={() => close()}>Close</button>}>
      <ol class="pair-steps">
        <li>Install <b>MarkNotes for Android</b> on the phone (the MarkNotes-Android APK) and connect it to the same Wi-Fi as this PC.</li>
        <li>On the phone, open MarkNotes › Settings › <b>Sync</b> › <b>Add a PC</b>, and pick <b>{s.hostName || 'this PC'}</b>
          {s.addresses && s.addresses.length ? <> (or type <span class="mono">{s.addresses[0]}</span>)</> : null}.</li>
        <li>This PC then shows a 6-digit code. Click <b>Allow</b> if the phone shows the same one.</li>
      </ol>
      <div class="pair-wait"><Spinner /> Waiting for your phone…</div>
      {s.fingerprint ? <p class="set-hint">This PC's key: <span class="mono">{s.fingerprint}</span></p> : null}
    </Dialog>
  );
}

function Row({ label, hint, children }) {
  return (
    <div class="set-row">
      <div class="set-text">
        <div class="set-label">{label}</div>
        {hint ? <div class="set-hint">{hint}</div> : null}
      </div>
      <div class="set-control">{children}</div>
    </div>
  );
}

/** Settings › Phone, on the PC. */
export function PcPhoneSection() {
  const s = syncState.value || {};
  useEffect(() => { refreshSyncState(); }, []);
  const on = !!settings.value.phoneSync;
  const toggle = async () => {
    const next = !on;
    setSetting('phoneSync', next);
    try { syncState.value = await api.call('sync.setEnabled', { on: next }); } catch (e) { toast(e.message, 'error'); }
  };
  const unlink = async (d) => {
    if (!await confirm({ title: 'Unlink phone', body: `“${d.name}” will no longer sync with this PC. Its notes stay on the phone and here.`, ok: 'Unlink', danger: true })) return;
    try { syncState.value = await api.call('sync.unlink', { id: d.id }); } catch (e) { toast(e.message, 'error'); }
  };
  const clearHistory = async (id, name, bytes) => {
    if (!await confirm({
      title: 'Delete old versions?',
      body: `This PC keeps its versions of notes that syncs${name ? ` with “${name}”` : ''} replaced or deleted (${fmtBytes(bytes)}), so the phone can undo those syncs. After deleting them, those syncs can't be undone on this PC. The notes themselves stay, and deleted notes are still in the Recycle Bin.`,
      ok: 'Delete', danger: true,
    })) return;
    try { syncState.value = await api.call('sync.clearHistory', { id }); } catch (e) { toast(e.message, 'error'); }
  };
  const devices = s.devices || [];
  return (
    <>
      <h2>Phone</h2>
      <div class="set-group">
        <Row label="Sync with my phone" hint="MarkNotes for Android keeps the workspaces you pick in sync with this PC over your Wi-Fi. Notes go straight from the phone to this PC: no internet, account or other company.">
          <button role="switch" aria-checked={on} class={'switch' + (on ? ' on' : '')} onClick={toggle}><span /></button>
        </Row>
        {on && s.error ? <p class="set-hint warn">{s.error}</p> : null}
        {on && s.running ? (
          <Row label="This PC" hint="Phones find it on the same Wi-Fi while MarkNotes is open here.">
            <span class="mono small">{s.hostName}{s.addresses && s.addresses.length ? ' · ' + s.addresses.join(', ') : ''}</span>
          </Row>
        ) : null}
      </div>
      <div class="set-group">
        <div class="set-group-title">Linked phones</div>
        {devices.length ? devices.map((d) => (
          <div key={d.id} class="sync-item">
            <Icon name="smartphone" size={20} />
            <div class="sync-item-text">
              <div class="sync-item-name">{d.name}{s.active === d.id ? <span class="sync-live"> · syncing now</span> : null}</div>
              <div class="muted small">{d.lastSync ? `Last sync ${relTime(d.lastSync)}` : 'Not synced yet'}{d.history ? ` · old versions kept: ${fmtBytes(d.history)}` : ''}</div>
            </div>
            {d.history ? <button class="btn small ghost" onClick={() => clearHistory(d.id, d.name, d.history)}>Delete old versions</button> : null}
            <button class="btn small ghost danger" onClick={() => unlink(d)}>Unlink</button>
          </div>
        )) : <p class="set-hint">No phone is linked yet.</p>}
        {s.orphanHistory ? (
          <div class="sync-item">
            <Icon name="archive" size={20} />
            <div class="sync-item-text">
              <div class="sync-item-name">Phones no longer linked</div>
              <div class="muted small">Old versions kept: {fmtBytes(s.orphanHistory)}</div>
            </div>
            <button class="btn small ghost" onClick={() => clearHistory('orphans', '', s.orphanHistory)}>Delete old versions</button>
          </div>
        ) : null}
        <div class="btn-row">
          <button class="btn primary" disabled={!on || !s.running} onClick={pairWindow}><Icon name="plus" size={15} /> Pair a phone…</button>
        </div>
      </div>
      <div class="set-group">
        <div class="set-group-title">How it works</div>
        <p class="set-hint">The phone does the syncing: when MarkNotes opens on the phone, after you edit there, and every few minutes, it sends its changes and gets this PC's. Both must be on the same Wi-Fi and MarkNotes must be open on this PC. A note edited on both sides is kept twice (the phone's copy gets “(conflict …)” in its name); deleted notes go to the Recycle Bin.</p>
        <p class="set-hint">When a sync replaces or deletes a note here, this PC keeps the old version, so a sync can be undone from the phone (Settings › Sync with PC › Recent syncs). They are kept until you delete them, here or on the phone.</p>
        <p class="set-hint">If the phone can't find this PC, check that Windows allowed MarkNotes on private networks (Windows Security › Firewall › Allow an app) and that your Wi-Fi is set as a private network. MarkNotes uses port {s.port || 47830}.</p>
      </div>
    </>
  );
}

// ───────────────────────────── phone: syncing ─────────────────────────────

let lastRun = 0;
let pending = null;

/** Phone: syncs now (after saving open notes). manual = started by the user (errors are shown). */
export async function syncNow({ manual = false, hostId = null, reason = '' } = {}) {
  if (!isPhone()) return null;
  const st = syncState.value || await refreshSyncState();
  if (!st || !(st.pcs || []).length) {
    if (manual) addPc();
    return null;
  }
  if (st.running) return null;
  lastRun = Date.now();
  try { await flushAll(); } catch { /* still sync what is saved */ }
  let res;
  try {
    res = await api.call('sync.run', { hostId, reason });
  } catch (e) {
    if (manual) toast(e.message, 'error', 6000);
    return null;
  }
  if (!res || res.busy) return res;
  for (const r of res.results || []) {
    if (!r.ok) {
      if (manual || r.unpaired || r.identityChanged) toast(`${r.name}: ${r.error}`, 'error', 8000);
      continue;
    }
    const sum = r.summary;
    if (!sum) continue;
    const confirmList = Object.entries(sum.confirm || {});
    for (const [wsId, c] of confirmList) {
      const parts = [];
      if (c.onPc) parts.push(`${c.onPc} on ${c.pc}`);
      if (c.here) parts.push(`${c.here} on this phone`);
      const ok = await confirm({
        title: 'Delete many notes?',
        body: `Syncing “${c.name}” would delete ${parts.join(' and ')} (they were deleted on the other side). Nothing is lost: on the PC they go to the Recycle Bin, and on this phone to Settings › Trash, where you can restore them.`,
        ok: 'Delete them', cancel: 'Not now', danger: true,
      });
      if (ok) {
        const again = await api.call('sync.run', { hostId: r.hostId, allowDeletes: [wsId], reason: 'confirmed' }).catch((e) => { toast(e.message, 'error'); return null; });
        const done = again && (again.results || []).find((x) => x.hostId === r.hostId && x.ok && x.run);
        if (done) {
          toast(`Deleted ${parts.join(' and ')}.`, 'info', 15000,
            { label: 'Undo', run: () => undoSync({ hostId: r.hostId, run: done.run, pc: r.name, undoable: done.undoable }) });
        }
      }
    }
    for (const n of sum.notes || []) toast(n, 'info', 7000);
    if (sum.deletedHere && !manual) {
      toast(`${sum.deletedHere === 1 ? '1 item' : `${sum.deletedHere} items`} deleted on ${r.name} moved to the Trash here.`, 'info', 8000,
        { label: 'Open', run: () => openSettings('trash') });
    }
    if (sum.conflicts) toast(`${sum.conflicts} note${sum.conflicts > 1 ? 's were' : ' was'} edited on both sides: both versions are kept (look for “(conflict …)”).`, 'warning', 9000);
    if (manual) {
      const moved = sum.uploaded + sum.downloaded + sum.deletedHere + sum.deletedOnPc;
      toast(moved ? `Synced with ${r.name}: ${sum.uploaded} sent, ${sum.downloaded} received${sum.deletedHere + sum.deletedOnPc ? `, ${sum.deletedHere + sum.deletedOnPc} deleted` : ''}.` : `Up to date with ${r.name}.`, 'success', 3500);
    }
  }
  return res;
}

/** Phone: automatic sync (on open, back in the app, after edits, every few minutes) unless turned off. */
function autoOn() { return isPhone() && settings.value.syncAuto !== false && (syncState.value?.pcs || []).length > 0; }

export function scheduleSync(delay = 8000) {
  if (!isPhone()) return;
  clearTimeout(pending);
  pending = setTimeout(() => { if (autoOn()) syncNow({ reason: 'edit' }); }, delay);
}

export function startAutoSync() {
  if (!isPhone()) return;
  refreshSyncState().then(() => { if (autoOn()) setTimeout(() => syncNow({ reason: 'open' }), 1200); });
  api.on('app.focus', () => { if (autoOn() && Date.now() - lastRun > 20000) syncNow({ reason: 'resume' }); });
  api.on('app.background', () => { if (autoOn()) syncNow({ reason: 'background' }); });
  api.onCall((cmd) => {
    if (/^(note\.(write|create|rename|move|copy|delete|setMeta|append|import)|folder\.|ws\.(create|update|banner|setGuide|features|delete)|asset\.(save|import|rename|delete)|trash\.restore)/.test(cmd)) scheduleSync();
  });
  setInterval(() => {
    if (autoOn() && document.visibilityState === 'visible' && Date.now() - lastRun > 170000) syncNow({ reason: 'timer' });
  }, 60000);
}

/** Phone: find PCs on the Wi-Fi and pair with one. */
export function addPc() {
  return openModal((close) => <AddPc close={close} />, { wide: false });
}

function AddPc({ close }) {
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState(null);
  const [error, setError] = useState('');
  const scan = async () => {
    setFound(null);
    setError('');
    try { setFound(await api.call('sync.discover', {})); } catch (e) { setError(e.message); setFound([]); }
  };
  useEffect(() => {
    scan();
    return api.on('sync.pairCode', (d) => setCode(d.code));
  }, []);
  const pair = async (addr, port) => {
    setBusy(true);
    setError('');
    setCode(null);
    try {
      const pc = await api.call('sync.pair', { address: addr, port: port || 0 });
      await refreshSyncState();
      close();
      chooseWorkspaces(pc.hostId, true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setCode(null);
    }
  };
  if (busy) {
    return (
      <Dialog title="Add a PC" onClose={() => close()}>
        {code ? (
          <>
            <p class="dialog-text">The PC shows a code. Click <b>Allow</b> there if it is this one:</p>
            <div class="pair-code">{code}</div>
          </>
        ) : <div class="pair-wait"><Spinner /> Connecting…</div>}
      </Dialog>
    );
  }
  return (
    <Dialog title="Add a PC" onClose={() => close()}
      footer={<button class="btn ghost" onClick={() => close()}>Cancel</button>}>
      <p class="dialog-text muted">On the PC, open MarkNotes › Settings › <b>Phone</b> and click <b>Pair a phone</b>. The phone and the PC must be on the same Wi-Fi.</p>
      {error ? <p class="dialog-text warn">{error}</p> : null}
      {found === null ? <div class="pair-wait"><Spinner /> Looking for PCs…</div> : found.length ? (
        <div class="sync-list">
          {found.map((f) => (
            <button key={f.id + f.address} class="sync-item btnlike" onClick={() => pair(f.address, f.port)}>
              <Icon name="monitor" size={20} />
              <div class="sync-item-text">
                <div class="sync-item-name">{f.name}</div>
                <div class="muted small">{f.address}{f.paired ? ' · already linked' : f.pairing ? ' · ready to pair' : ' · open Pair a phone on the PC'}</div>
              </div>
              <Icon name="chevron-right" size={16} />
            </button>
          ))}
        </div>
      ) : <p class="dialog-text">No PC found. Is MarkNotes open on the PC, with Sync with my phone on?</p>}
      <div class="btn-row">
        <button class="btn" onClick={scan}><Icon name="refresh" size={15} /> Search again</button>
      </div>
      <div class="set-group-title">Or type the PC's address</div>
      <div class="pair-address">
        <input class="input" value={address} placeholder="192.168.0.10" inputMode="decimal" onInput={(e) => setAddress(e.currentTarget.value)} />
        <button class="btn primary" disabled={!address.trim()} onClick={() => pair(address.trim(), 0)}>Pair</button>
      </div>
    </Dialog>
  );
}

/** Phone: which workspaces are synced with a PC. */
export function chooseWorkspaces(hostId, first = false) {
  return openModal((close) => <ChooseWorkspaces hostId={hostId} first={first} close={close} />);
}

function ChooseWorkspaces({ hostId, first, close }) {
  const [data, setData] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [sendNew, setSendNew] = useState(true);
  useEffect(() => {
    api.call('sync.workspaces', { hostId }).then((d) => {
      setData(d);
      setPicked(new Set((d.workspaces || []).filter((w) => w.synced).map((w) => w.id)));
      setSendNew(d.pc ? d.pc.sendNew !== false : true);
    }).catch((e) => { toast(e.message, 'error'); close(); });
  }, []);
  const flip = (id) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id); else n.add(id);
    setPicked(n);
  };
  const save = async () => {
    try {
      await api.call('sync.choose', { hostId, ids: [...picked], sendNew });
      await refreshSyncState();
      close();
      syncNow({ manual: true, hostId });
    } catch (e) { toast(e.message, 'error'); }
  };
  const list = (data && data.workspaces) || [];
  const onPc = list.filter((w) => w.onPc);
  const mine = list.filter((w) => !w.onPc);
  return (
    <Dialog title={data && data.pc ? `Sync with ${data.pc.name}` : 'Workspaces'} onClose={() => close()} width={480}
      footer={<>
        <button class="btn ghost" onClick={() => close()}>{first ? 'Later' : 'Cancel'}</button>
        <button class="btn primary" disabled={!data} onClick={save}>Sync</button>
      </>}>
      {!data ? <div class="pair-wait"><Spinner /> Asking the PC…</div> : (
        <>
          {data.error ? <p class="dialog-text warn">{data.error}</p> : null}
          {onPc.length ? <div class="set-group-title">On the PC</div> : null}
          {onPc.map((w) => (
            <label key={w.id} class="sync-item check">
              <input type="checkbox" checked={picked.has(w.id)} onChange={() => flip(w.id)} />
              <span class="ws-dot" style={{ background: w.color || 'var(--accent)' }} />
              <div class="sync-item-text">
                <div class="sync-item-name">{w.name}</div>
                <div class="muted small">{w.notes} note{w.notes === 1 ? '' : 's'}{w.here ? ' · also on this phone' : ''}{w.linked ? ' · folder opened on the PC' : ''}</div>
              </div>
            </label>
          ))}
          {mine.length ? <div class="set-group-title">Only on this phone</div> : null}
          {mine.map((w) => (
            <label key={w.id} class="sync-item check">
              <input type="checkbox" checked={picked.has(w.id)} onChange={() => flip(w.id)} />
              <span class="ws-dot" />
              <div class="sync-item-text">
                <div class="sync-item-name">{w.name}</div>
                <div class="muted small">{w.notes} note{w.notes === 1 ? '' : 's'} · send it to the PC</div>
              </div>
            </label>
          ))}
          <label class="sync-item check">
            <input type="checkbox" checked={sendNew} onChange={() => setSendNew(!sendNew)} />
            <div class="sync-item-text">
              <div class="sync-item-name">Send workspaces I make on this phone</div>
              <div class="muted small">New workspaces go to the PC on the next sync.</div>
            </div>
          </label>
        </>
      )}
    </Dialog>
  );
}

// ───────────────────────────── phone: recent syncs and undo ─────────────────────────────

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const baseName = (p) => (p || '').split('/').pop();

/** "Today 10:02", "Yesterday 18:40", "Nov 3, 09:15". */
function dayTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${date}, ${time}`;
}

/** The time in a run id (r20261107-101502123-ab12). */
function runTime(run) {
  const m = /^r(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(run || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
}

function runSummary(r) {
  const c = r.counts || {};
  const pc = r.pc || 'the PC';
  const parts = [];
  const add = (n, text) => { if (n) parts.push(`${n} ${text}`); };
  add(c['here/replaced'], 'updated here');
  add(c['here/added'], 'new here');
  add(c['here/deleted'], 'deleted here');
  add(c['pc/replaced'], `updated on ${pc}`);
  add(c['pc/added'], `new on ${pc}`);
  add(c['pc/deleted'], `deleted on ${pc}`);
  add(c['both/conflict'], 'edited on both (both kept)');
  return parts.join(' · ') || 'Nothing changed';
}

function itemText(it, pc) {
  const where = it.side === 'here' ? 'here' : `on ${pc}`;
  if (it.undone) return `put back by an undo`;
  switch (it.kind) {
    case 'replaced': return `updated ${where}${it.can ? ' · old version kept' : ''}`;
    case 'deleted': return it.side === 'here' ? 'deleted here · in the Trash' : `deleted on ${pc}${it.can ? ' · old version kept' : ' · in its Recycle Bin'}`;
    case 'added': return `new ${where}`;
    case 'conflict': return `edited on both: the phone's version is “${baseName(it.copy)}”`;
    default: return it.kind;
  }
}

/** Undoes a sync run (asks first): what it deleted or replaced comes back on the phone and on the PC. */
export async function undoSync({ hostId, run, pc, undoable }) {
  const n = undoable || 0;
  const what = n === 1 ? 'the note' : n ? `the ${n} notes and files` : 'what';
  const ok = await confirm({
    title: 'Undo this sync?',
    body: `Puts back ${what} this sync deleted or replaced, on this phone and on ${pc}. What is there now is kept, so you can undo this too; notes it only added stay. ${pc} must be on the same Wi‑Fi, with MarkNotes open.`,
    ok: 'Undo sync',
  });
  if (!ok) return null;
  try {
    await flushAll();
  } catch { /* undo what is saved */ }
  try {
    const res = await api.call('sync.undo', { hostId, run });
    const parts = [`${res.restored} put back`];
    if (res.copies) parts.push(`${res.copies} kept next to a newer version as “(before sync)”`);
    if (res.skipped) parts.push(`${res.skipped} could not be`);
    toast(`Undone: ${parts.join(', ')}.`, res.skipped ? 'warning' : 'success', 8000);
    for (const t of res.notes || []) toast(t, 'info', 8000);
    return res;
  } catch (e) {
    toast(e.message, 'error', 9000);
    return null;
  }
}

/** Settings › Sync with PC: the last syncs with one PC, what each changed, and Undo. */
function RecentSyncs({ pc }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [limit, setLimit] = useState(12);
  const [busy, setBusy] = useState(false);
  const load = () => api.call('sync.history', { hostId: pc.hostId, limit }).then(setData).catch(() => setData({ runs: [] }));
  useEffect(() => { load(); }, [pc.lastSync, limit]);
  useEffect(() => api.on('sync.history', () => load()), [limit]);
  const runs = (data && data.runs) || [];
  const undo = async (r) => {
    setBusy(true);
    await undoSync({ hostId: pc.hostId, run: r.run, pc: pc.name, undoable: r.undoable });
    setBusy(false);
    load();
  };
  return (
    <div class="set-group recent-syncs">
      <div class="set-group-title">Recent syncs with {pc.name}</div>
      {data && !runs.length ? <p class="set-hint">Syncs that change something show here, with a button to undo them.</p> : null}
      {runs.map((r) => (
        <div key={r.run} class={'rs-run' + (open === r.run ? ' open' : '')}>
          <div class="rs-row">
            <button class="rs-head" onClick={() => setOpen(open === r.run ? null : r.run)} aria-expanded={open === r.run}>
              <Icon name={r.reason === 'undo' ? 'undo' : 'refresh'} size={16} />
              <span class="sync-item-text">
                <span class="rs-title">{r.reason === 'undo' ? `Undo · ${dayTime(r.at)}` : dayTime(r.at)}</span>
                <span class="muted small rs-sum">{runSummary(r)}</span>
              </span>
              <Icon name={open === r.run ? 'chevron-up' : 'chevron-down'} size={14} />
            </button>
            {r.undone ? <span class="rs-undone">Undone</span>
              : r.undoable ? <button class="btn small" disabled={busy} onClick={() => undo(r)}><Icon name="undo" size={14} /> Undo</button> : null}
          </div>
          {open === r.run ? (
            <ul class="rs-items">
              {r.reason === 'undo' && r.of ? <li class="muted small">Undid the sync from {dayTime(runTime(r.of))}</li> : null}
              {(r.items || []).map((it, i) => (
                <li key={i}>
                  <span class="rs-name">{baseName(it.p)}</span>
                  <span class="muted small">{it.wsName ? `${it.wsName} · ` : ''}{itemText(it, r.pc || pc.name)}</span>
                </li>
              ))}
              {r.count > (r.items || []).length ? <li class="muted small">…and {r.count - r.items.length} more</li> : null}
            </ul>
          ) : null}
        </div>
      ))}
      {data && data.more ? <button class="btn small ghost" onClick={() => setLimit(limit + 30)}>Show older syncs</button> : null}
    </div>
  );
}

/** Settings › Sync with PC: how long syncs and their old versions are kept, and deleting them. */
function SyncHistorySettings() {
  const days = Number(settings.value.historyDays) || 0;
  const setDays = async (next) => {
    if (next > 0 && !await confirm({
      title: `Keep old versions ${next} days?`,
      body: `Syncs older than ${next} days, and the versions of notes they kept, are deleted now and from then on: those syncs can no longer be undone. The notes themselves stay.`,
      ok: `Keep ${next} days`, danger: true,
    })) { syncState.value = { ...syncState.value }; return; }
    setSetting('historyDays', next);
    if (next > 0) await api.call('sync.pruneHistory', { days: next }).catch((e) => toast(e.message, 'error'));
  };
  const clear = async () => {
    if (!await confirm({
      title: 'Delete the sync history?',
      body: 'Past syncs can no longer be undone. The notes themselves stay. The old versions the PC kept are deleted at the next sync.',
      ok: 'Delete history', danger: true,
    })) return;
    try {
      const r = await api.call('sync.clearHistory', {});
      toast(r.deleted ? `${plural(r.deleted, 'sync')} deleted from the history.` : 'The history was already empty.', 'success', 4000);
    } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div class="set-group">
      <div class="set-group-title">Sync history</div>
      <Row label="Keep old versions" hint={days ? `Syncs and the versions they replaced or deleted are deleted ${days} days later, on this phone and on the PC.` : 'Forever: every sync can be undone until you delete its history here.'}>
        <select class="select" value={String(days)} onChange={(e) => setDays(Number(e.currentTarget.value))}>
          <option value="0">Forever</option>
          <option value="30">30 days</option>
        </select>
      </Row>
      <div class="btn-row"><button class="btn ghost danger" onClick={clear}>Delete history…</button></div>
    </div>
  );
}

/** Settings › Sync, on the phone. */
export function PhoneSyncSection() {
  const s = syncState.value || {};
  const p = syncProgress.value;
  useEffect(() => { refreshSyncState(); }, []);
  const forget = async (pc) => {
    if (!await confirm({ title: 'Forget this PC', body: `This phone stops syncing with “${pc.name}”. Notes stay on both. To sync again later, pair again.`, ok: 'Forget', danger: true })) return;
    try { syncState.value = await api.call('sync.forget', { hostId: pc.hostId }); } catch (e) { toast(e.message, 'error'); }
  };
  const pcs = s.pcs || [];
  return (
    <>
      <h2>Sync with PC</h2>
      <p class="set-hint">Your notes go straight between this phone and MarkNotes on your PC over the Wi-Fi: no internet, account or other company.</p>
      {pcs.map((pc) => (
        <div key={pc.hostId} class="set-group">
          <div class="sync-item">
            <Icon name="monitor" size={22} />
            <div class="sync-item-text">
              <div class="sync-item-name">{pc.name}</div>
              <div class="muted small">
                {s.running ? (p ? `Syncing ${p.ws}${p.total ? ` · ${p.done}/${p.total}` : ''}…` : 'Syncing…')
                  : pc.lastSync ? `Synced ${relTime(pc.lastSync)}` : 'Not synced yet'}
                {' · '}{(pc.workspaces || []).length} workspace{(pc.workspaces || []).length === 1 ? '' : 's'}
              </div>
            </div>
          </div>
          {pc.lastError && !s.running ? <p class="set-hint warn">{pc.lastError}</p> : null}
          <div class="btn-row">
            <button class="btn primary" disabled={s.running} onClick={() => syncNow({ manual: true, hostId: pc.hostId })}>{s.running ? <Spinner /> : <Icon name="refresh" size={15} />} Sync now</button>
            <button class="btn" onClick={() => chooseWorkspaces(pc.hostId)}><Icon name="layers" size={15} /> Workspaces…</button>
            <button class="btn ghost danger" onClick={() => forget(pc)}>Forget</button>
          </div>
        </div>
      ))}
      {pcs.map((pc) => <RecentSyncs key={'h' + pc.hostId} pc={pc} />)}
      <div class="set-group">
        <div class="set-group-title">{pcs.length ? 'Another PC' : 'Add your PC'}</div>
        <p class="set-hint">On the PC, open MarkNotes › Settings › Phone, turn on <b>Sync with my phone</b> and click <b>Pair a phone</b>.</p>
        <div class="btn-row"><button class="btn primary" onClick={addPc}><Icon name="plus" size={15} /> Add a PC…</button></div>
      </div>
      <div class="set-group">
        <Row label="Sync automatically" hint="When MarkNotes opens, when you come back to it, a few seconds after you edit, and every 3 minutes while it's open, when the PC can be reached.">
          <button role="switch" aria-checked={settings.value.syncAuto !== false} class={'switch' + (settings.value.syncAuto !== false ? ' on' : '')}
            onClick={() => setSetting('syncAuto', settings.value.syncAuto === false)}><span /></button>
        </Row>
      </div>
      {pcs.length ? <SyncHistorySettings /> : null}
    </>
  );
}

/** Phone: the panel at the bottom of the drawer: sync status (tap: sync now) and Settings. */
export function PhonePanel({ openSettings }) {
  const s = syncState.value;
  const p = syncProgress.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!s) refreshSyncState();
    const t = setInterval(() => tick((x) => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const pcs = (s && s.pcs) || [];
  let text = 'Sync with PC';
  let cls = '';
  if (pcs.length && s.running) {
    text = p && p.ws ? `Syncing ${p.ws}${p.total ? ` · ${p.done}/${p.total}` : ''}` : 'Syncing…';
    cls = ' running';
  } else if (pcs.length) {
    const pc = pcs[0];
    if (pc.lastError) { text = `Can't reach ${pc.name}`; cls = ' error'; }
    else { text = pc.lastSync ? `Synced ${relTime(pc.lastSync)}` : 'Not synced yet'; cls = ' ok'; }
  }
  return (
    <div class="user-panel phone-panel">
      <div class="user-row">
        <button class={'sync-status' + cls} onClick={() => (pcs.length ? syncNow({ manual: true }) : addPc())}>
          <span class="sync-ic"><Icon name="refresh" size={17} /></span>
          <span class="sync-text">{text}</span>
        </button>
        <span class="user-row-fill" />
        <button class="icon-btn" aria-label="Settings" onClick={() => openSettings()}><Icon name="settings" size={20} /></button>
      </div>
    </div>
  );
}
