import { ICONS } from '../editor/domicons.js';

export function Icon({ name, size = 18, class: cls = '', style, title }) {
  return (
    <svg class={'ic ' + cls} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={style} aria-hidden={title ? undefined : 'true'}>
      {title ? <title>{title}</title> : null}
      <path d={ICONS[name] || ICONS.info} />
    </svg>
  );
}

/** Small "MarkNotes" logo used in empty states. */
export function Logo({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
      <defs>
        <linearGradient id="lg-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7983ff" />
          <stop offset="0.5" stop-color="#5865f2" />
          <stop offset="1" stop-color="#8b3ffc" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="240" height="240" rx="62" fill="url(#lg-bg)" />
      <path d="M78 44 H156 L196 84 V196 A18 18 0 0 1 178 214 H78 A18 18 0 0 1 60 196 V62 A18 18 0 0 1 78 44 Z" fill="#fff" />
      <path d="M156 44 V70 A14 14 0 0 0 170 84 H196 Z" fill="#b9beff" />
      <path d="M106 132 L84 154 L106 176" fill="none" stroke="#5865f2" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M150 132 L172 154 L150 176" fill="none" stroke="#5865f2" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M136 124 L120 184" fill="none" stroke="#8b3ffc" stroke-width="12" stroke-linecap="round" />
    </svg>
  );
}
