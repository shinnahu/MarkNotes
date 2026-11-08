import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { workspaces, notesByWs, persisted, activeWsId, loadNotes, wsById, currentTabs } from '../store.js';
import { openNote, newNote } from '../docs.js';
import { Icon } from './icons.jsx';
import { Avatar } from './dialogs.jsx';
import { relTime } from '../util.js';

export const quickOpen = signal(false);

export async function openQuickSwitcher() {
  quickOpen.value = true;
  // Make sure every workspace's note list is known (cheap: names only).
  for (const w of workspaces.value) {
    if (!notesByWs.value[w.id]) {
      try { await loadNotes(w.id, false); } catch { /* ignore */ }
    }
  }
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Fuzzy score: consecutive and word-start matches score higher. */
function score(text, q) {
  const t = norm(text);
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx + (idx === 0 || /\W/.test(t[idx - 1]) ? 200 : 0);
  let ti = 0, s = 0, streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    s += 10 + streak * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return s;
}

export function QuickSwitcher() {
  if (!quickOpen.value) return null;
  return <QuickInner />;
}

function QuickInner() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  const listRef = useRef(null);
  useEffect(() => { input.current && input.current.focus(); }, []);

  const all = useMemo(() => {
    const out = [];
    for (const w of workspaces.value) for (const n of notesByWs.value[w.id] || []) out.push(n);
    return out;
  }, [notesByWs.value, workspaces.value]);

  const results = useMemo(() => {
    const query = norm(q.trim());
    if (!query) {
      const recent = (persisted.recent || []).map((k) => all.find((n) => n.path === k)).filter(Boolean);
      const open = currentTabs.value.map((t) => all.find((n) => n.path === t.key)).filter(Boolean);
      const seen = new Set();
      return [...recent, ...open, ...all.slice().sort((a, b) => b.mtime - a.mtime)]
        .filter((n) => (seen.has(n.path) ? false : seen.add(n.path))).slice(0, 30);
    }
    const scored = [];
    for (const n of all) {
      const sTitle = score(n.title, query);
      const sFolder = score(n.folder || '', query);
      const s = Math.max(sTitle * 2, sFolder);
      if (s > 0) scored.push([s + (n.wsId === activeWsId.value ? 50 : 0) + n.mtime / 1e13, n]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, 50).map((x) => x[1]);
  }, [q, all]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const el = listRef.current && listRef.current.children[sel];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const close = () => { quickOpen.value = false; };
  const pick = (n) => { close(); openNote(n.path); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - (q.trim() ? 0 : 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[sel]) pick(results[sel]);
      else if (q.trim()) { close(); newNote({ title: q.trim() }); }
    }
  };

  return (
    <div class="modal-layer qs-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="quick" role="dialog" aria-label="Find a note">
        <div class="quick-head">
          <Icon name="search" size={18} />
          <input ref={input} value={q} placeholder="Where do you want to go? Type a note or folder name…" onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} />
        </div>
        <div class="quick-section">{q.trim() ? 'Notes' : 'Recent'}</div>
        <div class="quick-list" ref={listRef}>
          {results.map((n, i) => {
            const ws = wsById(n.wsId);
            return (
              <button key={n.path} class={'quick-item' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => pick(n)}>
                <span class="note-dot" style={{ background: n.color || 'transparent', borderColor: n.color || undefined }} />
                <span class="quick-title">{n.title}</span>
                <span class="quick-where">{ws ? <Avatar ws={ws} size={16} /> : null}{ws ? ws.name : ''} › {n.folder || 'Unfiled'}</span>
                <span class="muted small">{relTime(n.mtime)}</span>
              </button>
            );
          })}
          {q.trim() ? (
            <button class={'quick-item create' + (sel === results.length ? ' sel' : '')} onMouseEnter={() => setSel(results.length)} onClick={() => { close(); newNote({ title: q.trim() }); }}>
              <Icon name="file-plus" size={16} /> <span class="quick-title">Create note “{q.trim()}”</span>
            </button>
          ) : null}
        </div>
        <div class="quick-foot muted"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close</div>
      </div>
    </div>
  );
}
