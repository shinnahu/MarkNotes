import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.jsx';
import { SWATCHES } from './dialogs.jsx';
import { mobile } from './Mobile.jsx';

export const menuState = signal(null);

/**
 * items: {label, icon, run, danger, disabled, hint, checked} | {label, icon, submenu: items} | {sep:true} | {title}
 *        | {swatches:true, value, onPick}
 */
export function openMenu(x, y, items, opts = {}) {
  menuState.value = { x, y, items: items.filter(Boolean), ...opts };
}

export function closeMenu() {
  menuState.value = null;
}

export function menuAt(el, items, opts = {}) {
  const r = el.getBoundingClientRect();
  openMenu(opts.alignRight ? r.right : r.left, r.bottom + 4, items, { ...opts, anchorRight: !!opts.alignRight });
}

const actionable = (items) => items.map((it, i) => (it.label && !it.disabled ? i : -1)).filter((i) => i >= 0);

/** One list of items (the menu itself or one of its submenus). */
function MenuList({ items, focus, setFocus, onOpenSub, openSub, listRef, style, minWidth, cls = '' }) {
  return (
    <div ref={listRef} class={'menu' + cls} style={{ ...style, minWidth: minWidth || 200 }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} class="menu-sep" />;
        if (it.title) return <div key={i} class="menu-title">{it.title}</div>;
        if (it.swatches) {
          return (
            <div key={i} class="menu-swatches">
              <button class={'swatch none' + (!it.value ? ' on' : '')} title="No colour" onClick={() => { closeMenu(); it.onPick(null); }}><Icon name="x" size={11} /></button>
              {(it.colors || SWATCHES.slice(0, 9)).map((c) => (
                <button key={c} class={'swatch' + (it.value && it.value.toLowerCase() === c.toLowerCase() ? ' on' : '')} style={{ background: c }} onClick={() => { closeMenu(); it.onPick(c); }} />
              ))}
            </div>
          );
        }
        const sub = !!it.submenu;
        return (
          <button key={i} class={'menu-item' + (it.danger ? ' danger' : '') + (focus === i ? ' focus' : '') + (sub && openSub === i ? ' open' : '')} disabled={it.disabled}
            onMouseEnter={(e) => { setFocus(i); onOpenSub && onOpenSub(sub ? i : -1, e.currentTarget); }}
            onClick={(e) => {
              if (sub) { onOpenSub && onOpenSub(i, e.currentTarget, true); return; }
              closeMenu();
              it.run && it.run();
            }}>
            <span class="menu-icon">{it.checked !== undefined ? (it.checked ? <Icon name="check" size={15} /> : null) : it.icon ? <Icon name={it.icon} size={15} /> : null}</span>
            <span class="menu-label">{it.label}</span>
            {it.hint ? <span class="menu-hint">{it.hint}</span> : null}
            {sub ? <span class="menu-sub-arrow"><Icon name="chevron-right" size={14} /></span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function MenuHost() {
  return mobile.value ? <SheetHost /> : <PopupHost />;
}

// What only the PC can do (Explorer, PDF and copies through Windows dialogs, packs, folders opened in place).
const PC_ONLY = /Explorer|explorer|Save as PDF|Save a copy|Export \/ share|Show in folder|Copy image|Open image|Open a folder|\.mnpack|Copy into my notes/;

/** The phone: the menu is a sheet at the bottom; a submenu replaces the list (with Back). */
function SheetHost() {
  const m = menuState.value;
  const [stack, setStack] = useState([]);
  useEffect(() => { setStack([]); }, [m]);
  if (!m) return null;
  const clean = (list) => {
    const l = list.filter(Boolean).filter((it) => !(it.label && PC_ONLY.test(it.label)));
    // No separator at either end or twice in a row once PC-only entries are gone.
    return l.filter((it, i, arr) => !(it.sep && (i === 0 || i === arr.length - 1 || arr[i - 1].sep)));
  };
  let items = clean(m.items);
  for (const i of stack) items = clean((items[i] && items[i].submenu) || []);
  return (
    <>
      <div class="menu-layer" onPointerDown={(e) => { e.preventDefault(); closeMenu(); }} onContextMenu={(e) => e.preventDefault()} />
      <div class="menu sheet" role="menu" onContextMenu={(e) => e.preventDefault()}>
        <div class="menu-sheet-grip" />
        {stack.length ? (
          <button class="menu-item" onClick={() => setStack(stack.slice(0, -1))}>
            <span class="menu-icon"><Icon name="chevron-left" size={15} /></span><span class="menu-label">Back</span>
          </button>
        ) : null}
        {items.map((it, i) => {
          if (it.sep) return <div key={i} class="menu-sep" />;
          if (it.title) return <div key={i} class="menu-title">{it.title}</div>;
          if (it.swatches) {
            return (
              <div key={i} class="menu-swatches">
                <button class={'swatch none' + (!it.value ? ' on' : '')} title="No colour" onClick={() => { closeMenu(); it.onPick(null); }}><Icon name="x" size={11} /></button>
                {(it.colors || SWATCHES.slice(0, 9)).map((c) => (
                  <button key={c} class={'swatch' + (it.value && it.value.toLowerCase() === c.toLowerCase() ? ' on' : '')} style={{ background: c }} onClick={() => { closeMenu(); it.onPick(c); }} />
                ))}
              </div>
            );
          }
          const sub = !!it.submenu;
          return (
            <button key={i} class={'menu-item' + (it.danger ? ' danger' : '')} disabled={it.disabled}
              onClick={() => {
                if (sub) { setStack([...stack, i]); return; }
                closeMenu();
                it.run && it.run();
              }}>
              <span class="menu-icon">{it.checked !== undefined ? (it.checked ? <Icon name="check" size={15} /> : null) : it.icon ? <Icon name={it.icon} size={15} /> : null}</span>
              <span class="menu-label">{it.label}</span>
              {sub ? <span class="menu-sub-arrow"><Icon name="chevron-right" size={14} /></span> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

function PopupHost() {
  const m = menuState.value;
  const ref = useRef(null);
  const subRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [focus, setFocus] = useState(-1);
  // The open submenu: {index, anchor (rect of its item), pos, focus}.
  const [sub, setSub] = useState(null);
  const subTimer = useRef(0);

  useLayoutEffect(() => {
    setSub(null);
    if (!m || !ref.current) { setPos(null); return; }
    // Its size without the opening animation's scale (a rect now would be 4% short).
    const r = { width: ref.current.offsetWidth, height: ref.current.offsetHeight };
    let x = m.anchorRight ? m.x - r.width : m.x;
    let y = m.y;
    if (x + r.width > window.innerWidth - 8) x = window.innerWidth - r.width - 8;
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, (m.anchorY ?? m.y) - r.height - 4);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
    setFocus(-1);
  }, [m]);

  // Place the submenu next to its item, on the left when there is no room on the right.
  useLayoutEffect(() => {
    if (!sub || sub.pos || !subRef.current) return;
    const r = { width: subRef.current.offsetWidth, height: subRef.current.offsetHeight };
    const a = sub.anchor;
    let x = a.right - 2;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, a.left - r.width + 2);
    let y = a.top - 5;
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    setSub({ ...sub, pos: { x, y } });
  }, [sub]);

  const openSub = (index, el, now = false) => {
    clearTimeout(subTimer.current);
    if (index < 0) {
      // Leaving a submenu item for a plain one closes the submenu after a moment (diagonal moves keep it).
      subTimer.current = setTimeout(() => setSub(null), 250);
      return;
    }
    if (sub && sub.index === index) return;
    const anchor = el.getBoundingClientRect();
    const show = () => setSub({ index, anchor, pos: null, focus: -1 });
    if (now) show();
    else subTimer.current = setTimeout(show, 120);
  };

  useEffect(() => () => clearTimeout(subTimer.current), []);

  useEffect(() => {
    if (!m) return undefined;
    const inside = (t) => t instanceof Node && ((ref.current && ref.current.contains(t)) || (subRef.current && subRef.current.contains(t)));
    const close = (e) => { if (!inside(e.target)) closeMenu(); };
    const key = (e) => {
      const inSub = sub && sub.pos && sub.focus >= 0;
      const list = inSub ? m.items[sub.index].submenu.filter(Boolean) : m.items;
      const act = actionable(list);
      const cur = inSub ? sub.focus : focus;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (sub) setSub(null); else closeMenu();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const at = act.indexOf(cur);
        const next = e.key === 'ArrowDown' ? act[(at + 1) % act.length] : act[(at - 1 + act.length) % act.length];
        if (inSub) setSub({ ...sub, focus: next }); else setFocus(next);
      } else if (e.key === 'ArrowRight' && !inSub && focus >= 0 && m.items[focus].submenu) {
        e.preventDefault();
        const el = ref.current && ref.current.querySelectorAll(':scope > *')[focus];
        if (el) setSub({ index: focus, anchor: el.getBoundingClientRect(), pos: null, focus: actionable(m.items[focus].submenu.filter(Boolean))[0] ?? -1 });
      } else if (e.key === 'ArrowLeft' && inSub) {
        e.preventDefault();
        setSub(null);
      } else if (e.key === 'Enter' && cur >= 0) {
        e.preventDefault();
        const it = list[cur];
        if (it.submenu) {
          const el = ref.current && ref.current.querySelectorAll(':scope > *')[cur];
          if (el) setSub({ index: cur, anchor: el.getBoundingClientRect(), pos: null, focus: actionable(it.submenu.filter(Boolean))[0] ?? -1 });
          return;
        }
        closeMenu();
        it.run && it.run();
      }
    };
    const t = setTimeout(() => {
      // pointerdown, not mousedown: the canvas cancels the mouse events of the presses it handles.
      window.addEventListener('pointerdown', close, true);
      window.addEventListener('blur', closeMenu);
      window.addEventListener('resize', closeMenu);
    }, 0);
    window.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('keydown', key, true);
    };
  }, [m, focus, sub]);

  if (!m) return null;
  const subItems = sub && m.items[sub.index] && m.items[sub.index].submenu ? m.items[sub.index].submenu.filter(Boolean) : null;
  return (
    <>
      <MenuList items={m.items} focus={focus} setFocus={setFocus} onOpenSub={openSub} openSub={sub ? sub.index : -1} listRef={ref}
        minWidth={m.minWidth} style={{ left: pos ? pos.x : m.x, top: pos ? pos.y : m.y, visibility: pos ? 'visible' : 'hidden' }} />
      {subItems ? (
        <MenuList items={subItems} focus={sub.focus} setFocus={(i) => { clearTimeout(subTimer.current); setSub((s) => (s ? { ...s, focus: i } : s)); }}
          listRef={subRef} cls=" submenu" minWidth={180}
          style={{ left: sub.pos ? sub.pos.x : sub.anchor.right, top: sub.pos ? sub.pos.y : sub.anchor.top, visibility: sub.pos ? 'visible' : 'hidden' }} />
      ) : null}
    </>
  );
}
