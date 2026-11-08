import { signal } from '@preact/signals';
import { toasts, dismissToast } from '../store.js';
import { Icon } from './icons.jsx';

export function Toasts() {
  const list = toasts.value;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={'toast ' + t.kind}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : t.kind === 'warning' ? 'alert' : 'info'} size={16} />
          <span class="toast-text">{t.text}</span>
          {t.action ? (
            <button class="toast-action" onClick={() => { dismissToast(t.id); t.action.run(); }}>{t.action.label}</button>
          ) : null}
          <button class="toast-x" onClick={() => dismissToast(t.id)} title="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

/** Discord-style tooltips (rendered at the top level so nothing clips them). */
export const tip = signal(null);

export function showTip(el, text, side = 'right') {
  // No hover on a phone: a tap would leave the tip on screen.
  if (!el || !text || document.documentElement.classList.contains('mobile')) return;
  const r = el.getBoundingClientRect();
  tip.value = side === 'right'
    ? { text, side, x: r.right + 12, y: r.top + r.height / 2 }
    : { text, side, x: r.left + r.width / 2, y: r.bottom + 8 };
}

export function hideTip() {
  tip.value = null;
}

export function Tooltip() {
  const t = tip.value;
  if (!t) return null;
  return <div class={'tooltip ' + t.side} style={{ left: t.x, top: t.y }}>{t.text}</div>;
}

export const tipProps = (text, side = 'right') => ({
  onMouseEnter: (e) => showTip(e.currentTarget, text, side),
  onMouseLeave: hideTip,
  onMouseDown: hideTip,
});
