// Applies theme + text preferences as CSS variables, and colours the native title bar.

import * as api from './api.js';
import { settings, updateSettings } from './store.js';
import { applyTheme, BUILTIN_THEMES } from './themes.js';

let lastChrome = '';

export function themeById(id) {
  const s = settings.peek();
  return [...BUILTIN_THEMES, ...(s.customThemes || [])].find((t) => t.id === id) || BUILTIN_THEMES[0];
}

export function applyAppearance() {
  const s = settings.peek();
  const theme = themeById(s.theme);
  const overrides = {};
  if (s.accent) overrides.accent = s.accent;
  if (s.editorFont) overrides['font-editor'] = s.editorFont;
  const chrome = applyTheme(theme, overrides);
  const root = document.documentElement;
  const st = root.style;
  st.setProperty('--editor-size', `${((s.editorFontSize || 15) * (s.zoom || 100) / 100).toFixed(1)}px`);
  st.setProperty('--editor-lh', String(s.editorLineHeight || 1.65));
  st.setProperty('--editor-max', `${s.editorMaxWidth || 920}px`);
  st.setProperty('--code-max', s.codeMaxHeight ? `${s.codeMaxHeight}px` : 'none');
  st.setProperty('--caption-pad', `${s.captionPadding ?? 10}px`);
  root.classList.toggle('code-numbers', !!s.codeLineNumbers);
  root.classList.toggle('plain-links', s.plainLinks !== false);
  root.classList.toggle('ui-anim', s.uiAnimations !== false);
  const key = `${chrome.bg}|${chrome.text}`;
  if (key !== lastChrome) {
    lastChrome = key;
    api.call('app.setChrome', chrome).catch(() => {});
    if (!s.chrome || s.chrome.bg !== chrome.bg || s.chrome.text !== chrome.text) updateSettings({ chrome });
  }
}
