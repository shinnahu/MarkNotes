import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { openModal } from './dialogs.jsx';
import { Icon } from './icons.jsx';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function score(text, q) {
  const t = norm(text);
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx + (idx === 0 || /\W/.test(t[idx - 1]) ? 200 : 0);
  let ti = 0;
  let s = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    s += 10 - Math.min(found - ti, 9);
    ti = found + 1;
  }
  return s;
}

function PickerDialog({ title, placeholder, items, empty, close }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  useEffect(() => { input.current && input.current.focus(); }, []);
  const results = useMemo(() => {
    const query = norm(q.trim());
    if (!query) return items.slice(0, 200);
    const scored = [];
    for (const it of items) {
      const s = Math.max(score(it.label, query) * 2, score(it.sub || '', query));
      if (s > 0) scored.push([s, it]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, 200).map((x) => x[1]);
  }, [q, items]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const el = list.current && list.current.children[sel];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) close(results[sel]); }
  };
  return (
    <div class="quick picker" role="dialog" aria-label={title}>
      <div class="quick-head">
        <Icon name="search" size={18} />
        <input ref={input} value={q} placeholder={placeholder} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} />
      </div>
      <div class="quick-section">{title}</div>
      <div class="quick-list" ref={list}>
        {results.map((it, i) => (
          <button key={it.key} class={'quick-item' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => close(it)}>
            <Icon name={it.icon || 'file'} size={16} />
            <span class="quick-title">{it.label}</span>
            {it.sub ? <span class="quick-where">{it.sub}</span> : null}
          </button>
        ))}
        {!results.length ? <div class="picker-empty muted">{q.trim() ? 'Nothing matches.' : empty || 'Nothing here yet.'}</div> : null}
      </div>
      <div class="quick-foot muted"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>Esc</kbd> to close</div>
    </div>
  );
}

/** Lets the user pick one of `items` ({key, label, sub, icon}); resolves with it, or null. */
export function pickFrom({ title, placeholder = 'Type to filter…', items, empty }) {
  return openModal((close) => <PickerDialog title={title} placeholder={placeholder} items={items} empty={empty} close={close} />)
    .then((v) => v || null);
}
