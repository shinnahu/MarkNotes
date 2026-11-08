// Themes are plain JSON: { id, name, author, base: 'dark'|'light', vars: {...}, css: '' }.
// They can be exported as .mntheme files and imported on another PC.

export const THEME_FORMAT = 'marknotes-theme';

/** Every variable a theme may set, with a label for the theme editor. */
export const THEME_VARS = [
  ['bg-0', 'Workspace rail'],
  ['bg-1', 'Sidebar & tab bar'],
  ['bg-2', 'Editor background'],
  ['bg-3', 'Raised panels'],
  ['bg-input', 'Inputs'],
  ['bg-hover', 'Hover'],
  ['bg-active', 'Selected item'],
  ['bg-modal', 'Dialogs & menus'],
  ['bg-code', 'Code block'],
  ['bg-code-head', 'Code block header'],
  ['border', 'Borders'],
  ['text', 'Text'],
  ['text-muted', 'Muted text'],
  ['text-strong', 'Headings / strong text'],
  ['accent', 'Accent'],
  ['accent-text', 'Text on accent'],
  ['link', 'Links'],
  ['danger', 'Danger'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['selection', 'Text selection'],
  ['caret', 'Caret'],
  ['check', 'Checkbox (checked)'],
  ['check-mark', 'Checkbox tick'],
  ['bullet', 'List bullets'],
  ['syn-keyword', 'Code: keywords'],
  ['syn-string', 'Code: strings'],
  ['syn-number', 'Code: numbers'],
  ['syn-comment', 'Code: comments'],
  ['syn-function', 'Code: functions'],
  ['syn-type', 'Code: types'],
  ['syn-variable', 'Code: variables'],
  ['syn-property', 'Code: properties'],
  ['syn-operator', 'Code: operators'],
  ['syn-tag', 'Code: tags'],
];

export const THEME_STYLE_VARS = [
  ['radius', 'Corner radius', '8px'],
  ['font-ui', 'Interface font', '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'],
  ['font-editor', 'Note font', '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'],
  ['font-mono', 'Code font', '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'],
  ['bg-image', 'Editor background image (CSS)', 'none'],
];

const darkBase = {
  'bg-0': '#1e1f22', 'bg-1': '#2b2d31', 'bg-2': '#313338', 'bg-3': '#2b2d31',
  'bg-input': '#1e1f22', 'bg-hover': '#393c41', 'bg-active': '#404249', 'bg-modal': '#313338',
  'bg-code': '#2b2d31', 'bg-code-head': '#232428', 'border': '#3f4147',
  'text': '#dbdee1', 'text-muted': '#949ba4', 'text-strong': '#f2f3f5',
  'accent': '#5865f2', 'accent-text': '#ffffff', 'link': '#00a8fc',
  'danger': '#f23f43', 'success': '#23a55a', 'warning': '#f0b232',
  'selection': 'rgba(88,101,242,0.35)', 'caret': '#f2f3f5',
  'syn-keyword': '#c792ea', 'syn-string': '#c3e88d', 'syn-number': '#f78c6c', 'syn-comment': '#7f848e',
  'syn-function': '#82aaff', 'syn-type': '#ffcb6b', 'syn-variable': '#dbdee1', 'syn-property': '#89ddff',
  'syn-operator': '#89ddff', 'syn-tag': '#f07178',
  'radius': '8px', 'bg-image': 'none',
};

const lightBase = {
  'bg-0': '#e3e5e8', 'bg-1': '#f2f3f5', 'bg-2': '#ffffff', 'bg-3': '#f2f3f5',
  'bg-input': '#e3e5e8', 'bg-hover': '#e8e9ec', 'bg-active': '#d7d9dd', 'bg-modal': '#ffffff',
  'bg-code': '#f2f3f5', 'bg-code-head': '#e6e7ea', 'border': '#d4d6db',
  'text': '#313338', 'text-muted': '#5c5e66', 'text-strong': '#060607',
  'accent': '#5865f2', 'accent-text': '#ffffff', 'link': '#006ce7',
  'danger': '#da373c', 'success': '#248046', 'warning': '#b8860b',
  'selection': 'rgba(88,101,242,0.25)', 'caret': '#060607',
  'syn-keyword': '#a626a4', 'syn-string': '#50a14f', 'syn-number': '#986801', 'syn-comment': '#a0a1a7',
  'syn-function': '#4078f2', 'syn-type': '#c18401', 'syn-variable': '#383a42', 'syn-property': '#0184bc',
  'syn-operator': '#0184bc', 'syn-tag': '#e45649',
  'radius': '8px', 'bg-image': 'none',
};

export const BUILTIN_THEMES = [
  { id: 'discord-dark', name: 'Discord Dark', author: 'MarkNotes', base: 'dark', vars: {} },
  {
    id: 'midnight', name: 'Midnight (AMOLED)', author: 'MarkNotes', base: 'dark',
    vars: {
      'bg-0': '#000000', 'bg-1': '#0a0a0c', 'bg-2': '#0e0f11', 'bg-3': '#141518', 'bg-input': '#141518',
      'bg-hover': '#1b1c20', 'bg-active': '#24262b', 'bg-modal': '#111214', 'bg-code': '#08090a', 'bg-code-head': '#141518',
      'border': '#202227',
    },
  },
  { id: 'discord-light', name: 'Discord Light', author: 'MarkNotes', base: 'light', vars: {} },
  {
    id: 'neon', name: 'Neon Arcade', author: 'MarkNotes', base: 'dark',
    vars: {
      'bg-0': '#06060c', 'bg-1': '#0c0c18', 'bg-2': '#10101f', 'bg-3': '#141428', 'bg-input': '#0a0a14',
      'bg-hover': '#1a1a33', 'bg-active': '#24244a', 'bg-modal': '#11112a', 'bg-code': '#0a0a16', 'bg-code-head': '#14142a',
      'border': '#2a2a55', 'text': '#e4e4ff', 'text-muted': '#8b8bc7', 'text-strong': '#ffffff',
      'accent': '#00e5ff', 'accent-text': '#001018', 'link': '#ff3ec9', 'selection': 'rgba(0,229,255,0.25)', 'caret': '#00e5ff',
      'syn-keyword': '#ff3ec9', 'syn-string': '#7cff6b', 'syn-number': '#ffd23f', 'syn-function': '#00e5ff', 'syn-type': '#ffa53f',
      'syn-comment': '#5d5d99', 'syn-property': '#9d8cff', 'syn-tag': '#ff6b9d',
      'bg-image': 'radial-gradient(1200px 600px at 100% 0%, rgba(255,62,201,0.08), transparent 60%), radial-gradient(900px 500px at 0% 100%, rgba(0,229,255,0.07), transparent 60%)',
    },
    css: `.cm-h1,.cm-h2{ text-shadow: 0 0 12px color-mix(in srgb, var(--accent) 60%, transparent); }
.rail-item.active .ws-avatar{ box-shadow: 0 0 0 2px var(--accent), 0 0 16px var(--accent); }
.tab.active{ box-shadow: inset 0 2px 0 var(--accent), 0 0 18px -6px var(--accent); }
.btn.primary{ box-shadow: 0 0 14px -2px var(--accent); }`,
  },
  {
    id: 'yorha', name: 'YoRHa', author: 'MarkNotes', base: 'light',
    vars: {
      'bg-0': '#b9b29a', 'bg-1': '#cdc6ad', 'bg-2': '#dad4bb', 'bg-3': '#d2cbb1', 'bg-input': '#cbc4a9',
      'bg-hover': '#c4bd9f', 'bg-active': '#4e4b42', 'bg-modal': '#d6d0b6', 'bg-code': '#cfc8ad', 'bg-code-head': '#c2bb9f',
      'border': '#a8a18a', 'text': '#4e4b42', 'text-muted': '#7d7765', 'text-strong': '#3a3830',
      'accent': '#4e4b42', 'accent-text': '#dad4bb', 'link': '#8a5a2b', 'danger': '#b33a2c', 'success': '#55693a', 'warning': '#9a6b1d',
      'selection': 'rgba(78,75,66,0.25)', 'caret': '#4e4b42', 'radius': '0px',
      'syn-keyword': '#7a3f2a', 'syn-string': '#55693a', 'syn-number': '#9a6b1d', 'syn-comment': '#958e77',
      'syn-function': '#3f5a6b', 'syn-type': '#7a5a2a', 'syn-variable': '#4e4b42', 'syn-property': '#5a4e6b', 'syn-operator': '#4e4b42', 'syn-tag': '#7a3f2a',
      'bg-image': 'repeating-linear-gradient(0deg, rgba(78,75,66,0.035) 0 2px, transparent 2px 4px)',
    },
    css: `body{ letter-spacing: .02em; }
.sidebar-header, .note-header .crumb-folder, .section-title, .tab-title { text-transform: uppercase; letter-spacing: .08em; }
.sidebar .row.active, .rail-item.active .ws-avatar { color: #dad4bb; }
.cm-h1::before{ content: "▮ "; color: var(--text-muted); }
.btn, .tab, .row, .card { border-radius: 0 !important; }`,
  },
  {
    id: 'eva01', name: 'EVA-01', author: 'MarkNotes', base: 'dark',
    vars: {
      'bg-0': '#130a1c', 'bg-1': '#1d0f2b', 'bg-2': '#241336', 'bg-3': '#2b1840', 'bg-input': '#160b22',
      'bg-hover': '#33204b', 'bg-active': '#43295f', 'bg-modal': '#22122f', 'bg-code': '#170c22', 'bg-code-head': '#200f30',
      'border': '#4a2f66', 'text': '#e7dcff', 'text-muted': '#a58fc7', 'text-strong': '#ffffff',
      'accent': '#7dff4f', 'accent-text': '#102006', 'link': '#ff9a3c', 'warning': '#ff9a3c', 'danger': '#ff4d5e',
      'selection': 'rgba(125,255,79,0.22)', 'caret': '#7dff4f', 'radius': '3px',
      'syn-keyword': '#ff9a3c', 'syn-string': '#7dff4f', 'syn-number': '#ffd65c', 'syn-function': '#b98cff', 'syn-type': '#ff9a3c',
      'syn-comment': '#7a6595', 'syn-property': '#9fe7ff', 'syn-tag': '#ff6b81',
      'bg-image': 'linear-gradient(135deg, rgba(125,255,79,0.04) 25%, transparent 25%) 0 0/24px 24px',
    },
    css: `.cm-h1, .cm-h2 { font-family: "Bahnschrift", "Segoe UI", sans-serif; font-stretch: condensed; letter-spacing: .04em; }
.sidebar-header { border-bottom: 2px solid var(--accent); }
.tab.active { box-shadow: inset 0 -2px 0 var(--warning); }`,
  },
  {
    id: 'ps2', name: 'PS2 System', author: 'MarkNotes', base: 'dark',
    vars: {
      'bg-0': '#000004', 'bg-1': '#030719', 'bg-2': '#050b24', 'bg-3': '#08102e', 'bg-input': '#02051a',
      'bg-hover': '#0c1a45', 'bg-active': '#12286a', 'bg-modal': '#061032', 'bg-code': '#030820', 'bg-code-head': '#071134',
      'border': '#16306e', 'text': '#c9d8ff', 'text-muted': '#6f86c4', 'text-strong': '#ffffff',
      'accent': '#4f9dff', 'accent-text': '#000814', 'link': '#8fc2ff', 'selection': 'rgba(79,157,255,0.3)', 'caret': '#40E2A0',
      'check': '#40E2A0', 'check-mark': '#00140c', 'bullet': '#FF69F8',
      'syn-keyword': '#8fc2ff', 'syn-string': '#9cf0c8', 'syn-number': '#ffd27a', 'syn-function': '#c2d4ff', 'syn-type': '#7ad3ff', 'syn-comment': '#4f5f8f',
      'bg-image': 'radial-gradient(1000px 520px at 70% 10%, rgba(40,90,220,0.22), transparent 65%), radial-gradient(700px 400px at 10% 90%, rgba(20,60,180,0.18), transparent 60%)',
    },
    css: `.cm-content, .sidebar, .tabbar { text-shadow: 0 0 6px rgba(79,157,255,0.25); }
.rail-item.active .ws-avatar { box-shadow: 0 0 18px rgba(79,157,255,0.8); }
.tab.active { box-shadow: inset 0 2px 0 #FF69F8; }`,
  },
  {
    id: 'ps1', name: 'PS1 Memory Card', author: 'MarkNotes', base: 'dark',
    // PlayStation button colours: square #FF69F8, triangle #40E2A0, circle #FF6666, cross #7CB2E8.
    vars: {
      'bg-0': '#1a1a1a', 'bg-1': '#2a2a2e', 'bg-2': '#34343a', 'bg-3': '#3c3c44', 'bg-input': '#222226',
      'bg-hover': '#45454f', 'bg-active': '#55556a', 'bg-modal': '#2e2e34', 'bg-code': '#26262b', 'bg-code-head': '#1e1e22',
      'border': '#5a5a66', 'text': '#e6e6e6', 'text-muted': '#a0a0aa', 'text-strong': '#ffffff',
      'accent': '#7CB2E8', 'accent-text': '#0e1a28', 'link': '#7CB2E8', 'success': '#40E2A0', 'danger': '#FF6666', 'warning': '#FF6666',
      'selection': 'rgba(124,178,232,0.32)', 'caret': '#40E2A0', 'radius': '2px',
      'check': '#40E2A0', 'check-mark': '#0b2a1f', 'bullet': '#FF69F8',
      'syn-keyword': '#FF69F8', 'syn-string': '#40E2A0', 'syn-number': '#FF6666', 'syn-function': '#7CB2E8', 'syn-type': '#FF6666',
      'syn-property': '#7CB2E8', 'syn-tag': '#FF69F8', 'syn-operator': '#c8c8d0',
      'bg-image': 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.12))',
    },
    css: `.tab.active { box-shadow: inset 0 2px 0 #FF69F8; }
.btn.primary { background: linear-gradient(180deg, #9cc6ef, #6aa3dc); color: #0e1a28; }`,
  },
  {
    id: 'dracula', name: 'Dracula', author: 'MarkNotes', base: 'dark',
    vars: {
      'bg-0': '#191a21', 'bg-1': '#21222c', 'bg-2': '#282a36', 'bg-3': '#2d2f3d', 'bg-input': '#1e1f29',
      'bg-hover': '#343746', 'bg-active': '#44475a', 'bg-modal': '#282a36', 'bg-code': '#21222c', 'bg-code-head': '#1b1c24',
      'border': '#44475a', 'text': '#f8f8f2', 'text-muted': '#9ea8d0', 'text-strong': '#ffffff',
      'accent': '#bd93f9', 'accent-text': '#1b1c24', 'link': '#8be9fd', 'success': '#50fa7b', 'danger': '#ff5555', 'warning': '#ffb86c',
      'selection': 'rgba(189,147,249,0.3)',
      'syn-keyword': '#ff79c6', 'syn-string': '#f1fa8c', 'syn-number': '#bd93f9', 'syn-comment': '#6272a4', 'syn-function': '#50fa7b',
      'syn-type': '#8be9fd', 'syn-property': '#66d9ef', 'syn-tag': '#ff79c6', 'syn-operator': '#ff79c6',
    },
  },
];

export function fullVars(theme) {
  const base = theme.base === 'light' ? lightBase : darkBase;
  const v = { ...base, ...(theme.vars || {}) };
  // Checkboxes and bullets use the theme's accent unless the theme picks its own colours.
  v.check = v.check || v.accent;
  v['check-mark'] = v['check-mark'] || v['accent-text'];
  v.bullet = v.bullet || v.accent;
  return v;
}

const SAFE_VALUE = /^[^;{}<>\\]*$/;
const KNOWN = new Set([...THEME_VARS.map((v) => v[0]), ...THEME_STYLE_VARS.map((v) => v[0])]);

/** Validates a theme coming from a file; returns a clean copy or throws. */
export function sanitizeTheme(input) {
  const t = typeof input === 'string' ? JSON.parse(input) : input;
  if (!t || typeof t !== 'object') throw new Error('Not a theme file');
  if (t.format && t.format !== THEME_FORMAT) throw new Error('Not a MarkNotes theme');
  const vars = {};
  for (const [k, v] of Object.entries(t.vars || {})) {
    if (!KNOWN.has(k) || typeof v !== 'string' || v.length > 4000 || !SAFE_VALUE.test(v)) continue;
    if (/url\(\s*['"]?(?!data:)/i.test(v)) continue; // only embedded images, the app is offline
    vars[k] = v;
  }
  let css = typeof t.css === 'string' ? t.css.slice(0, 60000) : '';
  css = css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?(?!data:)[^)]*\)/gi, 'none');
  return {
    id: 'custom-' + Math.random().toString(36).slice(2, 9),
    name: String(t.name || 'Imported theme').slice(0, 60),
    author: String(t.author || '').slice(0, 60),
    base: t.base === 'light' ? 'light' : 'dark',
    vars,
    css,
    custom: true,
  };
}

export function exportTheme(theme) {
  return JSON.stringify({
    format: THEME_FORMAT,
    version: 1,
    name: theme.name,
    author: theme.author || '',
    base: theme.base,
    vars: theme.vars || {},
    css: theme.css || '',
  }, null, 2);
}

let styleEl = null;

/** Applies a theme to the page and returns the colours for the native title bar. */
export function applyTheme(theme, overrides = {}) {
  const vars = { ...fullVars(theme), ...overrides };
  const root = document.documentElement;
  for (const k of KNOWN) root.style.removeProperty('--' + k);
  for (const [k, v] of Object.entries(vars)) if (v) root.style.setProperty('--' + k, v);
  root.dataset.base = theme.base;
  root.style.colorScheme = theme.base;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'theme-css';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = theme.css || '';
  return { bg: vars['bg-0'], text: vars['text'] };
}
