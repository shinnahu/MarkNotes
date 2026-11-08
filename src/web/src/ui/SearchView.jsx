import { useEffect, useRef, useState } from 'preact/hooks';
import { mainView, activeWsId, workspaces, wsById } from '../store.js';
import { openNote } from '../docs.js';
import * as api from '../api.js';
import { Icon } from './icons.jsx';
import { relTime, debounce } from '../util.js';
import { Avatar } from './dialogs.jsx';

function highlight(text, q) {
  const terms = (q.match(/"[^"]+"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, '')).filter((t) => t.length > 0);
  if (!terms.length) return text;
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const n = norm(text);
  const marks = [];
  for (const t of terms) {
    const nt = norm(t);
    let i = n.indexOf(nt);
    while (i >= 0 && marks.length < 50) {
      marks.push([i, i + nt.length]);
      i = n.indexOf(nt, i + nt.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    out.push(text.slice(pos, a));
    out.push(<mark>{text.slice(a, b)}</mark>);
    pos = b;
  }
  out.push(text.slice(pos));
  return out;
}

export function SearchView() {
  const v = mainView.value;
  const [q, setQ] = useState(v.q || '');
  const [scope, setScope] = useState(v.scope || 'ws');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const run = useRef(debounce(async (query, sc) => {
    if (!query.trim()) { setRes(null); return; }
    setBusy(true);
    try {
      const r = await api.call('search.query', { q: query, wsId: sc === 'ws' ? activeWsId.value : null, limit: 200 });
      setRes(r);
    } catch (e) {
      setRes([]);
    } finally { setBusy(false); }
  }, 220)).current;

  useEffect(() => { input.current && input.current.focus(); }, []);
  useEffect(() => { run(q, scope); mainView.value = { kind: 'search', q, scope }; }, [q, scope]);

  return (
    <div class="search-view">
      <div class="search-head">
        <div class="search-box">
          <Icon name="search" size={18} />
          <input ref={input} placeholder="Search in notes… (use quotes for exact phrases)" value={q} onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && res && res[0]) openNote(res[0].path, { term: q }); }} />
          {busy ? <span class="spinner" /> : null}
        </div>
        <div class="seg">
          <button class={scope === 'ws' ? 'on' : ''} onClick={() => setScope('ws')}>This workspace</button>
          <button class={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All workspaces</button>
        </div>
      </div>
      <div class="search-results">
        {res === null ? (
          <div class="search-hint muted">
            <p>Type to search titles and text of every note. Accents don't matter (“informacion” finds “información”).</p>
            <p>Tip: <kbd>Ctrl+K</kbd> jumps to a note by its name from anywhere.</p>
          </div>
        ) : res.length === 0 ? (
          <div class="search-hint muted">No notes found.</div>
        ) : (
          <>
            <div class="section-title">{res.length}{res.length >= 200 ? '+' : ''} result{res.length === 1 ? '' : 's'}</div>
            {res.map((r) => {
              const ws = wsById(r.wsId);
              return (
                <button key={r.path} class="result" onClick={() => openNote(r.path, { term: q })}>
                  <div class="result-top">
                    {scope === 'all' && ws ? <Avatar ws={ws} size={18} /> : null}
                    <span class="result-title">{highlight(r.title, q)}</span>
                    <span class="chip">{scope === 'all' && ws ? `${ws.name} › ` : ''}{r.folder || 'Unfiled'}</span>
                    <span class="muted small">{relTime(r.mtime)}</span>
                  </div>
                  <div class="result-snippet">{highlight(r.snippet, q)}</div>
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export { workspaces };
