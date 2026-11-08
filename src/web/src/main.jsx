import './styles/app.css';
import { render } from 'preact';
import { effect } from '@preact/signals';
import * as api from './api.js';
import {
  settings, DEFAULT_SETTINGS, persisted, hostInfo, boot, setWorkspaces, workspaces, activeWsId, tabsByWs, activeByWs,
  loadNotes, ui, mainView, toast, flushState, flushSettings, setSetting, activeKey, findNote, notesByWs, refreshWorkspaces,
  setNotes, replaceWorkspace,
} from './store.js';
import {
  activateTab, openPath, newNote, closeTab, closeAllTabs, reopenClosedTab, cycleTab, switchWorkspace, saveDoc,
  flushAll, checkExternalChanges, editorReadyPromise, plainNext, docs,
} from './docs.js';
import { renameNote } from './actions.js';
import { applyAppearance } from './appearance.js';
import { applyVideoVolume } from './render/embeds.js';
import * as ed from './editor/editor.js';
import { App } from './ui/App.jsx';
import { openSettings, settingsOpen } from './ui/Settings.jsx';
import { openQuickSwitcher, quickOpen } from './ui/QuickSwitcher.jsx';
import { modalStack, confirm } from './ui/dialogs.jsx';
import { toggleSidebar } from './ui/Sidebar.jsx';
import { toggleRail } from './ui/Rail.jsx';
import { toggleRecording, stopRecording } from './ui/Recorder.jsx';
import { stem, extOf, isAbs, isTypingTarget } from './util.js';
import { recorder } from './store.js';
import { installMobile, openDrawer } from './ui/Mobile.jsx';
import { startAutoSync } from './ui/PhoneSync.jsx';
import { installTrash } from './ui/Trash.jsx';

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const EDITOR_KEYS = ['wordWrap', 'lineNumbers', 'spellcheck', 'livePreview', 'codeWindows', 'linkPreviews', 'plainLinks', 'webEmbeds'];

async function start() {
  const info = await api.call('app.init');
  hostInfo.value = info;
  const phone = info.platform === 'android';
  settings.value = merge(DEFAULT_SETTINGS, info.settings);
  // A phone has no Ctrl: a tap on a link opens it (until changed in Settings › Editor).
  if (phone && !(info.settings && info.settings.linkClick)) settings.value = { ...settings.value, linkClick: 'click' };
  if (phone) installMobile();
  Object.assign(persisted, info.state || {});
  persisted.ws = persisted.ws || {};
  ui.value = { ...ui.value, sidebarWidth: persisted.sidebarWidth || 248, sidebarCollapsed: !!persisted.sidebarCollapsed, railCollapsed: !!persisted.railCollapsed };
  applyAppearance();
  // Web videos (YouTube, X) may load inside the app only while the setting is on.
  api.call('app.setEmbeds', { on: settings.value.webEmbeds !== false }).catch(() => {});

  let list = info.workspaces || [];
  if (!list.length) {
    // First run: one workspace to start in.
    const ws = await api.call('ws.create', { name: 'Personal', color: '#5865f2', firstFolder: 'Notes' });
    list = [ws];
  }
  setWorkspaces(list);

  // Restore tabs per workspace (titles come from file names, no file is read yet).
  const tabs = {};
  const active = {};
  for (const w of workspaces.value) {
    const st = persisted.ws[w.id] || {};
    const keys = [...new Set((st.tabs || []).filter((k) => typeof k === 'string'))];
    tabs[w.id] = keys.map((key) => ({ key, title: stem(key), ext: extOf(key), external: isAbs(key), dirty: false, saving: false, color: null, missing: false }));
    active[w.id] = keys.includes(st.active) ? st.active : null;
  }
  tabsByWs.value = tabs;
  activeByWs.value = active;
  const first = workspaces.value.find((w) => w.id === persisted.activeWorkspace) || workspaces.value[0];
  activeWsId.value = first ? first.id : null;

  render(<App />, document.getElementById('root'));
  document.getElementById('boot')?.remove();
  await editorReadyPromise;

  if (first) {
    // The last note opens right away; the notes list (thousands of files in a big vault) loads
    // in parallel and fills the sidebar, tab colours and [[links]] when it arrives.
    const listing = loadNotes(first.id).catch((e) => { toast(e.message, 'error'); });
    const key = activeByWs.value[first.id];
    if (key) await activateTab(key, { focus: true });
    listing.then(() => {
      colorTabs(first.id);
      for (const d of docs.values()) {
        const n = findNote(d.key);
        if (n && d.loaded) d.autoTitle = !!n.autoTitle;
      }
      ed.refreshDecorations();
    });
  }
  boot.value = { ready: true, error: null };
  if (phone) {
    // Nothing open yet: the list of notes is the first thing to see.
    if (!first || !activeByWs.value[first.id]) openDrawer();
    startAutoSync();
    installTrash();
  }

  for (const f of info.launchFiles || []) await openPath(f);

  if (info.migration) {
    const m = info.migration;
    if (m.migrated) {
      toast(`Welcome to MarkNotes 2! Your ${m.notes} notes are now in the “Personal › Inbox” workspace (${m.tabs} tabs restored). A full backup of the old folder is at ${m.backupDir}`, 'success', 20000);
    } else if (m.error) {
      toast(m.error, 'error', 30000);
    }
  }
  api.call('app.ready').catch(() => {});

  // Load the other workspaces' lists in the background (quick switcher, rail drops).
  setTimeout(async () => {
    for (const w of workspaces.value) {
      if (!notesByWs.value[w.id]) {
        try { await loadNotes(w.id, false); } catch { /* ignore */ }
      }
    }
  }, 1500);

  let prev = settings.value;
  effect(() => {
    const s = settings.value;
    applyAppearance();
    if (EDITOR_KEYS.some((k) => s[k] !== prev[k])) ed.settingsChanged();
    if (s.webEmbeds !== prev.webEmbeds) api.call('app.setEmbeds', { on: s.webEmbeds !== false }).catch(() => {});
    if (s.videoVolume !== prev.videoVolume) applyVideoVolume();
    prev = s;
  });
}

function colorTabs(wsId) {
  const arr = tabsByWs.value[wsId] || [];
  let changed = false;
  const next = arr.map((t) => {
    const n = findNote(t.key);
    if (n && n.color !== t.color) { changed = true; return { ...t, color: n.color }; }
    return t;
  });
  if (changed) tabsByWs.value = { ...tabsByWs.value, [wsId]: next };
}

// ───────────────────────────── host events ─────────────────────────────

api.on('app.beforeClose', async () => {
  try {
    if (recorder.value.state !== 'idle') await stopRecording();
    await flushAll();
    await flushState();
    await flushSettings();
  } catch (e) {
    console.error(e);
  }
  api.call('app.closeReady', {}).catch(() => {});
});

// Phone: leaving the app writes what is being edited (the sync then sends it to the PC).
api.on('app.background', () => { flushAll().catch(() => {}); flushState().catch(() => {}); });

// Phone: text or a link shared from another app becomes a new note in the open workspace.
api.on('app.share', async (d) => {
  const text = String((d && d.text) || '').trim();
  const subject = String((d && d.subject) || '').trim();
  if (!text && !subject) return;
  try {
    await newNote({ text: text + '\n', title: subject && subject.length < 120 ? subject.replace(/[\\/:*?"<>|]/g, '-') : null });
  } catch (e) {
    toast(e.message, 'error');
  }
});

api.on('app.openFiles', async (d) => {
  for (const f of d.files || []) await openPath(f);
});

let lastRefresh = Date.now();
api.on('app.focus', async () => {
  await checkExternalChanges();
  if (Date.now() - lastRefresh > 15000 && activeWsId.value) {
    lastRefresh = Date.now();
    try {
      await refreshWorkspaces();
      await loadNotes(activeWsId.value);
      colorTabs(activeWsId.value);
    } catch { /* ignore */ }
  }
});

// ───────────────────────────── keyboard ─────────────────────────────

function overlayOpen() {
  return modalStack.value.length > 0 || !!settingsOpen.value || quickOpen.value;
}

window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };

  // Redo is Ctrl+Shift+Z or Ctrl+Y, as picked in Settings › Shortcuts: the other key does nothing, in text boxes too.
  if (ctrl && !e.altKey && (settings.value.redoKey === 'ctrl+y' ? k === 'z' && e.shiftKey : k === 'y')) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (ctrl && !e.shiftKey && (k === 'k' || k === 'p')) return run(() => { if (!quickOpen.value) openQuickSwitcher(); else quickOpen.value = false; });
  if (ctrl && k === ',') return run(() => openSettings());
  if (overlayOpen()) return;

  if (ctrl && !e.shiftKey && k === 'n') return run(() => newNote());
  if (ctrl && !e.shiftKey && k === 's') return run(async () => {
    const key = activeKey.value;
    if (key) { const ok = await saveDoc(key, { force: false }); if (ok) toast('Saved', 'success', 1200); }
  });
  if (ctrl && !e.shiftKey && k === 'o') return run(async () => { const files = await api.call('note.openDialog'); for (const f of files || []) await openPath(f); });
  if (ctrl && !e.shiftKey && (k === 'w' || k === 'F4')) return run(() => { if (activeKey.value) closeTab(activeKey.value); });
  if (ctrl && e.shiftKey && k === 'w') return run(() => closeAllTabs());
  if (ctrl && e.shiftKey && k === 't') return run(() => reopenClosedTab());
  if (ctrl && e.shiftKey && k === 'f') return run(() => { mainView.value = { kind: 'search', q: '' }; });
  if (ctrl && e.shiftKey && k === 'r') return run(() => toggleRecording());
  if (ctrl && k === 'Tab') return run(() => cycleTab(e.shiftKey ? -1 : 1));
  if (ctrl && k === 'PageDown') return run(() => cycleTab(1));
  if (ctrl && k === 'PageUp') return run(() => cycleTab(-1));
  if (ctrl && e.shiftKey && e.code === 'Backslash') return run(toggleRail);
  if (ctrl && k === '\\') return run(toggleSidebar);
  if (ctrl && (k === '=' || k === '+')) return run(() => setSetting('zoom', Math.min(220, settings.value.zoom + 10)));
  if (ctrl && (k === '-' || k === '_')) return run(() => setSetting('zoom', Math.max(60, settings.value.zoom - 10)));
  if (ctrl && k === '0') return run(() => setSetting('zoom', 100));
  if (ctrl && e.shiftKey && k === 'v') { plainNext.value = true; return; }
  if (e.altKey && !ctrl && (k === 'ArrowUp' || k === 'ArrowDown')) {
    return run(() => {
      const list = workspaces.value;
      const i = list.findIndex((w) => w.id === activeWsId.value);
      const next = list[(i + (k === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
      if (next) switchWorkspace(next.id);
    });
  }
  if (k === 'F2' && !ctrl) {
    const n = activeKey.value && findNote(activeKey.value);
    if (n) return run(() => renameNote(n));
  }
  if (k === 'Escape' && mainView.value.kind !== 'editor' && activeKey.value && !isTypingTarget(e.target)) return run(() => activateTab(activeKey.value));
}, true);

// Ctrl + wheel zooms the note text.
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const z = settings.value.zoom + (e.deltaY < 0 ? 10 : -10);
  setSetting('zoom', Math.max(60, Math.min(220, z)));
}, { passive: false });

// Files dropped anywhere outside the editor open as tabs.
window.addEventListener('dragover', (e) => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length || e.defaultPrevented) return;
  e.preventDefault();
  const paths = await api.dropFiles([...e.dataTransfer.files]);
  for (const p of paths) await openPath(p);
});

// Right-click anywhere without our own menu: nothing (no browser menu in an app).
window.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented) return;
  const editable = e.target.closest && e.target.closest('input, textarea');
  if (!editable && !(e.target.closest && e.target.closest('.cm-content'))) e.preventDefault();
});

start().catch((e) => {
  console.error(e);
  boot.value = { ready: false, error: String(e && e.stack || e) };
  render(<App />, document.getElementById('root'));
  document.getElementById('boot')?.remove();
});
