// App state (Preact signals) + persistence of settings.json / state.json through the host.

import { signal, computed } from '@preact/signals';
import * as api from './api.js';
import { debounce, uid } from './util.js';

export const DEFAULT_SETTINGS = {
  version: 1,
  theme: 'discord-dark',
  customThemes: [],
  accent: '',
  editorFont: '',
  editorFontSize: 15,
  editorLineHeight: 1.65,
  readableWidth: true,
  editorMaxWidth: 920,
  wordWrap: true,
  lineNumbers: false,
  spellcheck: false,
  livePreview: true,
  codeWindows: true,
  autoCodeBlocks: true,
  codeWrapDefault: true,
  codeMaxHeight: 420,
  codeLineNumbers: false,
  autosave: true,
  autosaveDelay: 800,
  autosaveExternal: true,
  defaultExt: 'md',
  txtAsMarkdown: false,
  linkClick: 'ctrl',
  plainLinks: true,
  linkPreviews: true,
  webEmbeds: true,
  videoVolume: 35,
  videoPlayerVolume: 1,
  canvasMomentum: true,
  canvasMomentumAmount: 50,
  canvasLineWidth: 3,
  uiAnimations: true,
  recorderButton: '',
  maxImageWidth: 800,
  captionPadding: 10,
  gifAvatars: 'active',
  gridLayoutScope: 'workspace',
  confirmDelete: true,
  sidebarSort: 'modified',
  gridSort: 'modified',
  showWordCount: true,
  showStatusBar: true,
  notesRoot: '',
  // PC: answer MarkNotes on the phone (Settings › Phone). Phone: sync by itself when the PC can be reached.
  phoneSync: false,
  syncAuto: true,
  // Phone: days after which the trash deletes items for good; 0 = never (they stay until deleted in Settings › Trash).
  trashDays: 0,
  // Phone: days after which past syncs and the old versions they kept are deleted (both devices); 0 = never.
  historyDays: 0,
  registerFileTypes: true,
  zoom: 100,
  // Redo with ctrl+shift+z or ctrl+y (Settings › Shortcuts); the other key does nothing.
  redoKey: 'ctrl+shift+z',
  // Save as PDF: white paper; paper a4 | letter | legal, margins narrow | normal | wide, size small | medium | large.
  pdf: {
    paper: 'a4',
    landscape: false,
    margins: 'normal',
    size: 'medium',
    pageNumbers: false,
  },
  asr: {
    model: 'large-v3-turbo-q5_0',
    language: 'auto',
    gpu: true,
    mic: true,
    desktop: true,
    micDevice: '',
    desktopDevice: '',
    prompt: '',
    labels: true,
    timestamps: true,
    target: 'current',
  },
};

export const settings = signal({ ...DEFAULT_SETTINGS });
/** The redo shortcut picked in Settings › Shortcuts, as tooltips and menus show it. */
export const redoKeyLabel = () => (settings.value.redoKey === 'ctrl+y' ? 'Ctrl+Y' : 'Ctrl+Shift+Z');
export const boot = signal({ ready: false, error: null });
export const hostInfo = signal({});

/** Ordered workspaces (WorkspaceDto from the host). */
export const workspaces = signal([]);
export const activeWsId = signal(null);
/** wsId → NoteDto[] */
export const notesByWs = signal({});
/** wsId → Tab[] ; Tab = {key, title, ext, external, dirty, saving, color, missing} */
export const tabsByWs = signal({});
/** wsId → active tab key */
export const activeByWs = signal({});
/** What the main area shows: {kind:'editor'} | {kind:'folder', folder} | {kind:'all'} | {kind:'recent'} | {kind:'search', q} */
export const mainView = signal({ kind: 'editor' });

export const ui = signal({
  sidebarCollapsed: false,
  railCollapsed: false,
  sidebarWidth: 248,
  settingsOpen: null,
  quickOpen: false,
});

export const modal = signal(null);
export const menu = signal(null);
export const toasts = signal([]);
export const recorder = signal({ state: 'idle', levels: {}, pending: 0, started: 0, target: null, backend: null, message: '' });
export const editorInfo = signal({ line: 1, col: 1, words: 0, chars: 0, selection: 0 });

export const activeWs = computed(() => workspaces.value.find((w) => w.id === activeWsId.value) || null);
export const currentTabs = computed(() => tabsByWs.value[activeWsId.value] || []);
export const activeKey = computed(() => activeByWs.value[activeWsId.value] || null);
export const activeTab = computed(() => currentTabs.value.find((t) => t.key === activeKey.value) || null);
export const currentNotes = computed(() => notesByWs.value[activeWsId.value] || []);

/** Persisted UI state (state.json): tabs per workspace, expanded folders, … */
export const persisted = {
  version: 1,
  activeWorkspace: null,
  workspaceOrder: [],
  ws: {},
  closedTabs: [],
  codeBlocks: {},
  recent: [],
  sidebarWidth: 248,
  sidebarCollapsed: false,
};

const saveStateNow = () => {
  persisted.activeWorkspace = activeWsId.value;
  persisted.workspaceOrder = workspaces.value.map((w) => w.id);
  for (const w of workspaces.value) {
    const tabs = tabsByWs.value[w.id] || [];
    // Update in place: UI code keeps references to these objects (expanded folders, last folder…).
    const st = wsState(w.id);
    st.tabs = tabs.map((t) => t.key);
    st.active = activeByWs.value[w.id] || null;
  }
  persisted.sidebarWidth = ui.value.sidebarWidth;
  persisted.sidebarCollapsed = ui.value.sidebarCollapsed;
  persisted.railCollapsed = ui.value.railCollapsed;
  return api.call('app.saveState', { state: persisted }).catch((e) => console.error('saveState', e));
};
export const saveState = debounce(saveStateNow, 400);
export const flushState = () => { saveState.cancel(); return saveStateNow(); };

const saveSettingsNow = () => api.call('app.saveSettings', { settings: settings.value }).catch((e) => toast('Could not save settings: ' + e.message, 'error'));
const saveSettingsDebounced = debounce(saveSettingsNow, 300);
export const flushSettings = () => { saveSettingsDebounced.cancel(); return saveSettingsNow(); };

export function setSetting(path, value) {
  const next = structuredClone(settings.value);
  const parts = path.split('.');
  let o = next;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = { ...(o[parts[i]] || {}) };
  o[parts[parts.length - 1]] = value;
  settings.value = next;
  saveSettingsDebounced();
}

export function updateSettings(patch) {
  settings.value = { ...settings.value, ...patch };
  saveSettingsDebounced();
}

export function wsState(id) {
  if (!persisted.ws[id]) persisted.ws[id] = {};
  return persisted.ws[id];
}

// ───────────── toasts ─────────────

export function toast(text, kind = 'info', ms = 3200, action = null) {
  const id = uid();
  toasts.value = [...toasts.value, { id, text, kind, action }];
  setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

// ───────────── tabs helpers ─────────────

export function setTabs(wsId, fn) {
  const cur = tabsByWs.value[wsId] || [];
  const next = fn(cur);
  if (next !== cur) {
    tabsByWs.value = { ...tabsByWs.value, [wsId]: next };
    saveState();
  }
}

export function setActive(wsId, key) {
  if (activeByWs.value[wsId] === key) return;
  activeByWs.value = { ...activeByWs.value, [wsId]: key };
  saveState();
}

/** Updates a tab (by key) in every workspace it appears in. */
export function patchTab(key, patch) {
  let changed = false;
  const next = { ...tabsByWs.value };
  for (const ws of Object.keys(next)) {
    const arr = next[ws];
    const i = arr.findIndex((t) => t.key === key);
    if (i >= 0) {
      const merged = { ...arr[i], ...patch };
      if (Object.keys(patch).some((k) => arr[i][k] !== merged[k])) {
        next[ws] = arr.slice();
        next[ws][i] = merged;
        changed = true;
      }
    }
  }
  if (changed) tabsByWs.value = next;
}

export function findTab(key) {
  for (const [ws, arr] of Object.entries(tabsByWs.value)) {
    const t = arr.find((x) => x.key === key);
    if (t) return { wsId: ws, tab: t };
  }
  return null;
}

// ───────────── notes list helpers ─────────────

export function setNotes(wsId, list) {
  notesByWs.value = { ...notesByWs.value, [wsId]: list };
}

export function upsertNote(dto) {
  if (!dto || !dto.wsId) return;
  const list = notesByWs.value[dto.wsId];
  if (!list) return;
  const i = list.findIndex((n) => n.path === dto.path);
  const next = list.slice();
  if (i >= 0) next[i] = { ...next[i], ...dto, preview: dto.preview ?? next[i].preview };
  else next.push(dto);
  setNotes(dto.wsId, next);
}

export function patchNote(path, patch) {
  for (const [ws, list] of Object.entries(notesByWs.value)) {
    if (!list) continue;
    const i = list.findIndex((n) => n.path === path);
    if (i >= 0) {
      const next = list.slice();
      next[i] = { ...next[i], ...patch };
      setNotes(ws, next);
      return next[i];
    }
  }
  return null;
}

export function removeNote(path) {
  for (const [ws, list] of Object.entries(notesByWs.value)) {
    if (list && list.some((n) => n.path === path)) setNotes(ws, list.filter((n) => n.path !== path));
  }
}

// path → note, rebuilt only when a notes list changes (lookups stay instant with thousands of notes).
let noteIndex = new Map();
let noteIndexOf = null;

export function findNote(path) {
  const all = notesByWs.value;
  if (noteIndexOf !== all) {
    noteIndex = new Map();
    for (const list of Object.values(all)) if (list) for (const n of list) noteIndex.set(n.path, n);
    noteIndexOf = all;
  }
  return noteIndex.get(path) || null;
}

// Workspaces whose list came with previews/covers (background preloads skip reading files).
const fullLists = new Set();
export const hasFullList = (wsId) => fullLists.has(wsId);

export async function loadNotes(wsId, preview = true) {
  const list = await api.call('ws.notes', { id: wsId, preview });
  setNotes(wsId, list);
  if (preview) fullLists.add(wsId);
  return list;
}

export async function refreshWorkspaces() {
  const list = await api.call('ws.list');
  setWorkspaces(list);
  return list;
}

export function setWorkspaces(list) {
  const order = persisted.workspaceOrder || [];
  const sorted = list.slice().sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    if (ia < 0 && ib < 0) return a.name.localeCompare(b.name);
    if (ia < 0) return 1;
    if (ib < 0) return -1;
    return ia - ib;
  });
  workspaces.value = sorted;
}

export function replaceWorkspace(ws) {
  workspaces.value = workspaces.value.map((w) => (w.id === ws.id ? ws : w));
}

export function wsById(id) {
  return workspaces.value.find((w) => w.id === id) || null;
}

/** The workspace a note path belongs to (paths start with the workspace folder name). */
export function wsForPath(path) {
  if (!path || /^[a-zA-Z]:[\\/]/.test(path)) return null;
  const dir = path.split('/')[0];
  return workspaces.value.find((w) => w.dir.toLowerCase() === dir.toLowerCase()) || null;
}
