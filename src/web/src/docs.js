// Tabs and documents: loading, autosave, closing, renaming.
//
// Autosave rule: a file is written only when its text was actually edited (and only once
// the text differs from what is on disk). Opening the app, switching tabs or closing
// tabs never rewrites untouched notes.

import * as api from './api.js';
import {
  settings, activeWsId, tabsByWs, activeByWs, mainView, persisted, recorder, editorInfo, workspaces,
  setTabs, setActive, patchTab, findTab, saveState, toast, findNote, upsertNote, removeNote, loadNotes,
  wsForPath, wsById, hostInfo, notesByWs, replaceWorkspace, hasFullList,
} from './store.js';
import * as ed from './editor/editor.js';
import { Reload } from './editor/editor.js';
import { basename, stem, extOf, deriveTitle, isAbs, joinPath, dirname, decodeLink, debounce } from './util.js';
import { askChoice, prompt as askText, confirm as askConfirm } from './ui/dialogs.jsx';
import { openMenu } from './ui/menu.jsx';
import { editorMenuItems } from './editor/editmenu.js';
import { Annotation } from '@codemirror/state';
import { resolveName, fileUrl, cleanTarget, onLinksChanged, invalidateFiles } from './links.js';
import { renamePreviewDoc } from './previews.js';
import { readFrontmatter, setFrontmatterKey } from './editor/mdext.js';
import { bannerOf } from './editor/frontmatter.js';
import { resolveAssetUrl, readFileAsDataUrl } from './util.js';

/** key → Doc */
export const docs = new Map();
let shown = null; // key currently displayed in the editor

const newDoc = (key) => ({
  key,
  ext: extOf(key) || 'md',
  external: isAbs(key),
  state: null,
  loaded: false,
  loading: null,
  savedText: '',
  encoding: 'utf8',
  eol: 'crlf',
  mtime: 0,
  readOnly: false,
  changeSeq: 0,
  savedSeq: 0,
  saveTimer: null,
  saving: null,
  saveAgain: false,
  scrollTop: 0,
  autoTitle: false,
  createdHere: false,
  lastSaved: 0,
});

export const isDirty = (d) => !!d && d.loaded && d.changeSeq !== d.savedSeq;
const autosaveOn = (d) => settings.value.autosave && (!d.external || settings.value.autosaveExternal);

export function shownKey() {
  return shown;
}

export function docTitle(key) {
  const n = findNote(key);
  return n ? n.title : stem(key);
}

function makeTab(key) {
  const n = findNote(key);
  const ext = extOf(key);
  return {
    key,
    title: n ? n.title : stem(key),
    ext,
    external: isAbs(key),
    dirty: false,
    saving: false,
    color: n ? n.color : null,
    missing: false,
    kind: ext === 'canvas' ? 'canvas' : n && n.kind ? n.kind : undefined,
  };
}

/** Kanban and canvas tabs show their board unless switched to "Edit as text". */
export function isBoardTab(tab) {
  return !!tab && !tab.asText && (tab.kind === 'kanban' || tab.kind === 'canvas');
}

export function setTabAsText(key, asText) {
  patchTab(key, { asText: !!asText });
  if (asText) requestAnimationFrame(() => ed.focusEditor());
}

/** Adds a tab (after the active one) without activating it. */
export function ensureTab(wsId, key) {
  setTabs(wsId, (tabs) => {
    if (tabs.some((t) => t.key === key)) return tabs;
    const active = activeByWs.value[wsId];
    const i = tabs.findIndex((t) => t.key === active);
    const next = tabs.slice();
    next.splice(i >= 0 ? i + 1 : next.length, 0, makeTab(key));
    return next;
  });
}

// ───────────────────────────── loading & showing ─────────────────────────────

async function loadDoc(key) {
  let doc = docs.get(key);
  if (doc && doc.loaded) return doc;
  if (doc && doc.loading) return doc.loading;
  if (!doc) {
    doc = newDoc(key);
    docs.set(key, doc);
  }
  const d = doc;
  d.loading = (async () => {
    try {
      const r = await api.call('note.read', { path: d.key });
      d.savedText = r.text;
      d.encoding = r.encoding;
      d.eol = r.eol;
      d.mtime = r.mtime;
      d.readOnly = !!r.readOnly;
      d.state = ed.createState(d.key, d.ext, r.text, d.readOnly);
      d.loaded = true;
      d.changeSeq = d.savedSeq = 0;
      const note = findNote(d.key);
      d.autoTitle = !!(note && note.autoTitle);
      d.kind = kindOfText(d.ext, r.text);
      patchTab(d.key, { missing: false, kind: d.kind, loaded: true });
      return d;
    } catch (e) {
      console.warn('load failed', d.key, e);
      patchTab(d.key, { missing: true });
      docs.delete(d.key);
      return null;
    } finally {
      d.loading = null;
    }
  })();
  return d.loading;
}

function stashShown() {
  if (!shown) return;
  const d = docs.get(shown);
  const view = ed.getView();
  if (d && view && view.state.facet(ed.docRef).key === shown) {
    d.state = view.state;
    d.scrollTop = view.scrollDOM.scrollTop;
  }
}

export async function activateTab(key, { focus = true, term = null } = {}) {
  const wsId = activeWsId.value;
  if (shown !== key) stashShown();
  setActive(wsId, key);
  mainView.value = { kind: 'editor' };
  const doc = await loadDoc(key);
  if (activeByWs.value[activeWsId.value] !== key) return;
  if (!doc) {
    shown = null;
    ed.clearView();
    updateWindowTitle();
    return;
  }
  if (shown !== key) {
    doc.state = ed.showState(doc.state, doc.scrollTop);
    shown = key;
  }
  touchRecent(key);
  updateWindowTitle();
  refreshInfo();
  if (term) ed.revealTerm(term);
  // A board (kanban/canvas) takes the focus itself; the hidden text editor must not get keystrokes.
  if (focus) requestAnimationFrame(() => { const t = findTab(key); if (!isBoardTab(t && t.tab)) ed.focusEditor(); });
}

export async function openNote(key, { wsId = null, activate = true, focus = true, term = null } = {}) {
  const owner = wsForPath(key);
  const target = wsId || (owner ? owner.id : activeWsId.value);
  if (activate && target !== activeWsId.value) await switchWorkspace(target, { restoreTab: false });
  ensureTab(target, key);
  if (activate) await activateTab(key, { focus, term });
}

/** Opens a file given by its absolute path (Explorer, Open dialog, drag & drop). */
export async function openPath(abs) {
  const root = (hostInfo.value.notesRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const f = abs.replace(/\\/g, '/');
  if (root && f.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    const rel = f.slice(root.length + 1);
    const ws = wsForPath(rel);
    if (ws && !notesByWs.value[ws.id]) await loadNotes(ws.id);
    return openNote(rel);
  }
  if (!/\.(md|markdown|txt)$/i.test(abs)) {
    if (!(await askConfirm({ title: 'Open as text?', body: `${basename(abs)} is not a .md or .txt file. Open it as plain text anyway?`, ok: 'Open' }))) return;
  }
  return openNote(abs, { wsId: activeWsId.value });
}

export async function switchWorkspace(id, { restoreTab = true } = {}) {
  if (!id || id === activeWsId.value) return;
  stashShown();
  activeWsId.value = id;
  mainView.value = { kind: 'editor' };
  if (!notesByWs.value[id]) {
    try { await loadNotes(id); } catch (e) { toast(e.message, 'error'); }
  } else if (!hasFullList(id)) {
    // Preloaded without previews: show it now, fill in previews and covers right after.
    loadNotes(id).catch(() => {});
  }
  const key = activeByWs.value[id];
  if (restoreTab && key) await activateTab(key, { focus: false });
  else if (!key) {
    shown = null;
    ed.clearView();
  }
  saveState();
  updateWindowTitle();
}

// ───────────────────────────── editing & saving ─────────────────────────────

/** Called for every editor update (wired in editor.js). */
/** Marks changes made by the kanban/canvas views themselves (they don't need to re-read them). */
export const FromBoard = Annotation.define();
const watchers = new Map();

/** Calls fn() when a document's text changes from outside the caller (typing, undo, reload…). */
export function watchDoc(key, fn) {
  if (!watchers.has(key)) watchers.set(key, new Set());
  watchers.get(key).add(fn);
  return () => watchers.get(key)?.delete(fn);
}

function notifyWatchers(key) {
  const set = watchers.get(key);
  if (set) for (const fn of [...set]) { try { fn(); } catch (e) { console.error(e); } }
}

export function kindOfText(ext, text) {
  if (ext === 'canvas') return 'canvas';
  if (ext !== 'md' && ext !== 'markdown') return 'note';
  const fm = readFrontmatter(text.slice(0, 4000));
  return fm && fm.data['kanban-plugin'] !== undefined ? 'kanban' : 'note';
}

export function getDocText(key) {
  const d = docs.get(key);
  return d && d.loaded ? d.state.doc.toString() : null;
}

/** Replaces a document's text with a minimal change (keeps undo granular). */
export function setDocText(key, text, own = true) {
  const d = docs.get(key);
  if (!d || !d.loaded || d.readOnly) return false;
  const cur = d.state.doc.toString();
  if (cur === text) return false;
  let a = 0;
  while (a < cur.length && a < text.length && cur.charCodeAt(a) === text.charCodeAt(a)) a++;
  let b = 0;
  while (b < cur.length - a && b < text.length - a && cur.charCodeAt(cur.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
  return applyToDoc(key, {
    changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) },
    annotations: own ? FromBoard.of(true) : undefined,
    userEvent: 'input.board',
  });
}

export function onEditorUpdate(u) {
  const ref = u.state.facet(ed.docRef);
  const doc = docs.get(ref.key);
  if (!doc) return;
  doc.state = u.state;
  if (u.docChanged && !u.transactions.some((t) => t.annotation(FromBoard))) notifyWatchers(ref.key);
  if (u.docChanged) {
    const reload = u.transactions.every((t) => t.annotation(Reload));
    if (!reload) markChanged(doc);
    else if (!isDirty(doc)) patchTab(doc.key, { dirty: false });
  }
  if ((u.docChanged || u.selectionSet) && ref.key === shown) refreshInfo();
}

function markChanged(doc) {
  doc.changeSeq++;
  patchTab(doc.key, { dirty: true });
  scheduleSave(doc);
}

function scheduleSave(doc, delay) {
  if (!autosaveOn(doc)) return;
  clearTimeout(doc.saveTimer);
  doc.saveTimer = setTimeout(() => saveDoc(doc.key), delay ?? settings.value.autosaveDelay);
}

/** Writes a note if (and only if) its text differs from the file. */
export function saveDoc(key, { force = false } = {}) {
  const doc = docs.get(key);
  if (!doc || !doc.loaded || doc.readOnly) return Promise.resolve(true);
  clearTimeout(doc.saveTimer);
  doc.saveTimer = null;
  if (doc.saving) {
    doc.saveAgain = true;
    return doc.saving;
  }
  const text = doc.state.doc.toString();
  const seq = doc.changeSeq;
  if (text === doc.savedText && !force) {
    doc.savedSeq = seq;
    patchTab(doc.key, { dirty: false });
    return Promise.resolve(true);
  }
  patchTab(doc.key, { saving: true });
  doc.saving = (async () => {
    try {
      const r = await api.call('note.write', { path: doc.key, text, encoding: doc.encoding, eol: doc.eol, expectMtime: doc.mtime, force });
      if (r.conflict) return await resolveConflict(doc, r.mtime);
      doc.mtime = r.mtime;
      doc.savedText = text;
      doc.savedSeq = seq;
      doc.lastSaved = Date.now();
      if (doc.changeSeq === seq) patchTab(doc.key, { dirty: false });
      const n = findNote(doc.key);
      if (n) upsertNote({ ...n, mtime: r.mtime, size: text.length, preview: text.slice(0, 360) });
      if (doc.autoTitle) await autoRename(doc, text);
      return true;
    } catch (e) {
      toast(`Could not save “${docTitle(doc.key)}”: ${e.message}`, 'error', 7000);
      return false;
    } finally {
      doc.saving = null;
      patchTab(doc.key, { saving: false });
      if (doc.saveAgain) {
        doc.saveAgain = false;
        if (isDirty(doc)) scheduleSave(doc, 30);
      }
      if (doc.key === shown) refreshInfo();
    }
  })();
  return doc.saving;
}

async function resolveConflict(doc, diskMtime) {
  const title = docTitle(doc.key);
  const choice = await askChoice({
    title: 'Changed outside MarkNotes',
    body: `“${title}” was modified by another program since you opened it. Which version do you want to keep?`,
    choices: [
      { id: 'mine', label: 'Keep my version', primary: true },
      { id: 'disk', label: 'Load the version on disk' },
    ],
  });
  if (choice === 'disk') {
    await reloadDoc(doc.key);
    return true;
  }
  doc.mtime = diskMtime;
  doc.saving = null;
  return saveDoc(doc.key, { force: true });
}

export async function saveAll() {
  const keys = [...docs.values()].filter(isDirty).map((d) => d.key);
  const res = await Promise.all(keys.map((k) => saveDoc(k)));
  return res.every(Boolean);
}

/** Before the window closes: write pending edits, drop empty notes made this session. */
export async function flushAll() {
  for (const d of docs.values()) clearTimeout(d.saveTimer);
  const pending = [...docs.values()].filter((d) => d.saving).map((d) => d.saving);
  await Promise.all(pending);
  const dirty = [...docs.values()].filter((d) => isDirty(d) && !d.readOnly);
  const results = await Promise.all(dirty.map((d) => saveDoc(d.key)));
  for (const d of [...docs.values()]) {
    if (d.createdHere && d.loaded && !d.state.doc.toString().trim()) {
      try {
        if (await api.call('note.deleteIfEmpty', { path: d.key })) {
          for (const ws of Object.keys(tabsByWs.value)) setTabs(ws, (tabs) => tabs.filter((t) => t.key !== d.key));
        }
      } catch { /* ignore */ }
    }
  }
  return results.every(Boolean);
}

/** Replaces the text with what is on disk (keeps undo history). */
export async function reloadDoc(key) {
  const doc = docs.get(key);
  if (!doc || !doc.loaded) return;
  const r = await api.call('note.read', { path: key });
  doc.savedText = r.text;
  doc.mtime = r.mtime;
  doc.encoding = r.encoding;
  doc.eol = r.eol;
  const spec = { changes: { from: 0, to: doc.state.doc.length, insert: r.text }, annotations: Reload.of(true) };
  applyToDoc(key, spec);
  doc.savedSeq = doc.changeSeq;
  patchTab(key, { dirty: false, missing: false });
}

/** Applies a change to a note whether or not it is the visible one. */
export function applyToDoc(key, spec) {
  const doc = docs.get(key);
  if (!doc || !doc.loaded) return false;
  const view = ed.getView();
  if (key === shown && view.state.facet(ed.docRef).key === key) {
    view.dispatch(spec);
  } else {
    const tr = doc.state.update(spec);
    doc.state = tr.state;
    if (tr.docChanged && !tr.annotation(Reload)) markChanged(doc);
    if (tr.docChanged && !tr.annotation(FromBoard)) notifyWatchers(key);
  }
  return true;
}

function sanitizeTitle(t) {
  let s = (t || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s~$]+/, '').replace(/[.\s]+$/, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/[.\s]+$/, '');
  return s;
}

async function autoRename(doc, text) {
  const title = sanitizeTitle(deriveTitle(text));
  if (!title) return;
  const cur = stem(doc.key);
  if (cur === title || cur.replace(/ \(\d+\)$/, '') === title) return;
  try {
    const dto = await api.call('note.rename', { path: doc.key, title });
    if (dto && dto.path !== doc.key) renameKey(doc.key, dto.path, dto);
  } catch (e) {
    console.warn('auto rename failed', e);
  }
}

/** A note moved or was renamed: update every reference to its key. */
export function renameKey(oldKey, newKey, dto = null) {
  renamePreviewDoc(oldKey, newKey);
  const doc = docs.get(oldKey);
  if (doc) {
    docs.delete(oldKey);
    doc.key = newKey;
    doc.ext = extOf(newKey) || doc.ext;
    if (doc.state) doc.state.facet(ed.docRef).key = newKey;
    docs.set(newKey, doc);
  }
  if (shown === oldKey) shown = newKey;
  const nextTabs = {};
  for (const [ws, arr] of Object.entries(tabsByWs.value)) {
    nextTabs[ws] = arr.map((t) => (t.key === oldKey ? { ...t, key: newKey, title: dto ? dto.title : stem(newKey), ext: extOf(newKey) } : t));
  }
  tabsByWs.value = nextTabs;
  const nextActive = { ...activeByWs.value };
  for (const ws of Object.keys(nextActive)) if (nextActive[ws] === oldKey) nextActive[ws] = newKey;
  activeByWs.value = nextActive;
  persisted.recent = (persisted.recent || []).map((k) => (k === oldKey ? newKey : k));
  persisted.closedTabs = (persisted.closedTabs || []).map((c) => (c.key === oldKey ? { ...c, key: newKey } : c));
  for (const kind of ['codeBlocks', 'spine']) {
    if (persisted[kind] && persisted[kind][oldKey]) {
      persisted[kind][newKey] = persisted[kind][oldKey];
      delete persisted[kind][oldKey];
    }
  }
  if (recorder.value.target === oldKey) recorder.value = { ...recorder.value, target: newKey };
  const prevNote = findNote(oldKey);
  removeNote(oldKey);
  if (dto) upsertNote({ ...dto, preview: dto.preview ?? (prevNote ? prevNote.preview : null) });
  saveState();
  updateWindowTitle();
}

/** Prefix rename (folder or workspace renamed on disk). */
export function renamePrefix(oldPrefix, newPrefix) {
  const keys = new Set([...docs.keys(), ...Object.values(tabsByWs.value).flat().map((t) => t.key)]);
  for (const k of keys) {
    if (k.toLowerCase().startsWith(oldPrefix.toLowerCase())) renameKey(k, newPrefix + k.slice(oldPrefix.length));
  }
}

// ───────────────────────────── closing ─────────────────────────────

function pushClosed(key, wsId) {
  const list = (persisted.closedTabs || []).filter((c) => c.key !== key);
  list.push({ key, wsId });
  persisted.closedTabs = list.slice(-40);
}

async function prepareClose(key) {
  const doc = docs.get(key);
  if (!doc || !doc.loaded) return true;
  if (doc.saving) await doc.saving;
  if (isDirty(doc)) {
    if (autosaveOn(doc)) {
      const ok = await saveDoc(key);
      if (!ok) {
        const c = await askChoice({
          title: 'Not saved',
          body: `“${docTitle(key)}” could not be saved. Close it anyway and lose the changes?`,
          choices: [{ id: 'close', label: 'Close anyway', danger: true }, { id: 'cancel', label: 'Keep open', primary: true }],
        });
        if (c !== 'close') return false;
      }
    } else {
      const c = await askChoice({
        title: 'Save changes?',
        body: `Do you want to save the changes to “${docTitle(key)}”?`,
        choices: [{ id: 'save', label: 'Save', primary: true }, { id: 'discard', label: "Don't save", danger: true }, { id: 'cancel', label: 'Cancel' }],
      });
      if (c === 'cancel' || !c) return false;
      if (c === 'save' && !(await saveDoc(key))) return false;
    }
  }
  if (doc.createdHere && !doc.state.doc.toString().trim()) {
    try {
      if (await api.call('note.deleteIfEmpty', { path: key })) {
        removeNote(key);
        doc.discarded = true;
      }
    } catch { /* keep it */ }
  }
  return true;
}

function dropDoc(key) {
  if (findTab(key)) return;
  const d = docs.get(key);
  if (d) clearTimeout(d.saveTimer);
  docs.delete(key);
  if (shown === key) shown = null;
}

export async function closeTab(key, { wsId = activeWsId.value } = {}) {
  if (!(await prepareClose(key))) return false;
  const tabs = tabsByWs.value[wsId] || [];
  const idx = tabs.findIndex((t) => t.key === key);
  if (idx < 0) return true;
  const wasActive = activeByWs.value[wsId] === key;
  if (wasActive && shown === key) stashShown();
  const discarded = docs.get(key)?.discarded;
  setTabs(wsId, (arr) => arr.filter((t) => t.key !== key));
  if (!discarded) pushClosed(key, wsId);
  dropDoc(key);
  if (wasActive) {
    const rest = tabsByWs.value[wsId] || [];
    const next = rest[Math.min(idx, rest.length - 1)];
    if (wsId === activeWsId.value) {
      if (next) await activateTab(next.key, { focus: true });
      else showEmpty(wsId);
    } else setActive(wsId, next ? next.key : null);
  }
  refreshNoteCounts(wsId);
  return true;
}

function showEmpty(wsId) {
  setActive(wsId, null);
  shown = null;
  ed.clearView();
  updateWindowTitle();
}

/**
 * Closes many tabs at once. Only notes with unsaved edits are written; everything
 * else just closes. Returns how many were closed.
 */
export async function closeTabs(keys, { wsId = activeWsId.value, undoToast = true } = {}) {
  const tabs = tabsByWs.value[wsId] || [];
  const target = tabs.filter((t) => keys.includes(t.key));
  const closed = [];
  for (const t of target) {
    if (await prepareClose(t.key)) closed.push(t.key);
  }
  if (!closed.length) return 0;
  const active = activeByWs.value[wsId];
  if (closed.includes(active)) stashShown();
  setTabs(wsId, (arr) => arr.filter((t) => !closed.includes(t.key)));
  for (const k of closed) {
    if (!docs.get(k)?.discarded) pushClosed(k, wsId);
    dropDoc(k);
  }
  if (closed.includes(active)) {
    const rest = tabsByWs.value[wsId] || [];
    if (rest.length && wsId === activeWsId.value) await activateTab(rest[rest.length - 1].key);
    else showEmpty(wsId);
  }
  saveState();
  refreshNoteCounts(wsId);
  if (undoToast && closed.length > 1) {
    toast(`Closed ${closed.length} tabs`, 'info', 7000, {
      label: 'Undo',
      run: async () => {
        for (const k of closed) ensureTab(wsId, k);
        if (closed.includes(active)) await activateTab(active);
      },
    });
  }
  return closed.length;
}

export function closeAllTabs(wsId = activeWsId.value) {
  return closeTabs((tabsByWs.value[wsId] || []).map((t) => t.key), { wsId });
}

export function closeOtherTabs(key, wsId = activeWsId.value) {
  return closeTabs((tabsByWs.value[wsId] || []).filter((t) => t.key !== key).map((t) => t.key), { wsId });
}

export function closeTabsToRight(key, wsId = activeWsId.value) {
  const tabs = tabsByWs.value[wsId] || [];
  const i = tabs.findIndex((t) => t.key === key);
  return closeTabs(tabs.slice(i + 1).map((t) => t.key), { wsId });
}

/** Closes tabs that were not edited in this session and are not opened in the last N days. */
export function closeUntouchedTabs(wsId = activeWsId.value) {
  const keys = (tabsByWs.value[wsId] || []).filter((t) => {
    const d = docs.get(t.key);
    return !(d && (isDirty(d) || d.lastSaved)) && t.key !== activeByWs.value[wsId];
  }).map((t) => t.key);
  return closeTabs(keys, { wsId });
}

export async function reopenClosedTab() {
  const list = persisted.closedTabs || [];
  while (list.length) {
    const c = list.pop();
    const exists = await api.call('note.stat', { paths: [c.key] }).then((r) => r[0]?.exists).catch(() => false);
    if (exists) {
      const ws = c.wsId && wsById(c.wsId) ? c.wsId : null;
      await openNote(c.key, { wsId: ws });
      saveState();
      return;
    }
  }
  toast('No recently closed tabs');
}

export function moveTab(wsId, fromKey, toIndex) {
  setTabs(wsId, (tabs) => {
    const i = tabs.findIndex((t) => t.key === fromKey);
    if (i < 0) return tabs;
    const next = tabs.slice();
    const [t] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(toIndex > i ? toIndex - 1 : toIndex, next.length)), 0, t);
    return next;
  });
}

export function cycleTab(dir) {
  const wsId = activeWsId.value;
  const tabs = tabsByWs.value[wsId] || [];
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.key === activeByWs.value[wsId]);
  const next = tabs[(i + dir + tabs.length) % tabs.length];
  activateTab(next.key);
}

// ───────────────────────────── creating ─────────────────────────────

export function defaultFolder(wsId) {
  const ws = wsById(wsId);
  if (!ws) return '';
  const st = persisted.ws[wsId] || {};
  if (st.lastFolder !== undefined && (st.lastFolder === '' ? ws.looseCount > 0 || ws.linked : ws.folders.some((f) => f.path === st.lastFolder))) return st.lastFolder;
  // Opened folders (Obsidian vaults) default to their root, like Obsidian does.
  return ws.linked || !ws.folders.length ? '' : ws.folders[0].path;
}

export async function newNote({ wsId = activeWsId.value, folder = null, text = '', title = null, ext = null } = {}) {
  if (!wsId) {
    toast('Create a workspace first', 'warning');
    return null;
  }
  const f = folder ?? defaultFolder(wsId);
  const dto = await api.call('note.create', { wsId, folder: f, title, ext: ext || settings.value.defaultExt, text, autoTitle: !title });
  if (!notesByWs.value[wsId]) await loadNotes(wsId);
  upsertNote(dto);
  const doc = newDoc(dto.path);
  doc.createdHere = !text;
  docs.set(dto.path, doc);
  await openNote(dto.path, { wsId });
  const d = docs.get(dto.path);
  if (d) d.autoTitle = !title;
  refreshNoteCounts(wsId);
  return dto;
}

export const refreshNoteCounts = debounce(async (wsId) => {
  try {
    const ws = await api.call('ws.get', { id: wsId });
    replaceWorkspace(ws);
  } catch { /* workspace may be gone */ }
}, 250);

// ───────────────────────────── misc ─────────────────────────────

function touchRecent(key) {
  const r = (persisted.recent || []).filter((k) => k !== key);
  r.unshift(key);
  persisted.recent = r.slice(0, 60);
  saveState();
}

export function updateWindowTitle() {
  const key = activeByWs.value[activeWsId.value];
  const ws = workspaces.value.find((w) => w.id === activeWsId.value);
  const parts = [];
  if (key && mainView.value.kind === 'editor') parts.push(docTitle(key));
  if (ws) parts.push(ws.name);
  parts.push('MarkNotes');
  api.call('app.setTitle', { title: parts.join(' — ') }).catch(() => {});
}

const refreshInfo = debounce(() => {
  const view = ed.getView();
  if (!view || !shown) return;
  const s = view.state;
  const head = s.selection.main.head;
  const line = s.doc.lineAt(head);
  let sel = 0;
  for (const r of s.selection.ranges) sel += r.to - r.from;
  let words = 0;
  if (settings.value.showWordCount && s.doc.length < 2_000_000) {
    const text = s.doc.toString();
    const m = text.match(/[\p{L}\p{N}_'’-]+/gu);
    words = m ? m.length : 0;
  }
  const d = docs.get(shown);
  editorInfo.value = {
    line: line.number, col: head - line.from + 1, chars: s.doc.length, words, selection: sel,
    encoding: d?.encoding, eol: d?.eol, ext: d?.ext, readOnly: d?.readOnly, dirty: isDirty(d), saving: !!d?.saving,
    lastSaved: d?.lastSaved || 0, external: d?.external, lines: s.doc.lines,
  };
}, 120);

export { refreshInfo };

/** Window got focus: pick up files changed by other programs. */
export async function checkExternalChanges() {
  const loaded = [...docs.values()].filter((d) => d.loaded && !d.saving);
  if (!loaded.length) return;
  let stats;
  try { stats = await api.call('note.stat', { paths: loaded.map((d) => d.key) }); } catch { return; }
  for (const s of stats) {
    const d = docs.get(s.path);
    if (!d) continue;
    if (!s.exists) {
      patchTab(d.key, { missing: true });
      continue;
    }
    if (Math.abs(s.mtime - d.mtime) > 2) {
      if (!isDirty(d)) await reloadDoc(d.key);
      else {
        toast(`“${docTitle(d.key)}” changed on disk. Your edits will overwrite it when saved.`, 'warning', 9000, {
          label: 'Load disk version',
          run: () => reloadDoc(d.key),
        });
        d.mtime = s.mtime;
      }
    } else patchTab(d.key, { missing: false });
  }
}

// ───────────────────────────── images ─────────────────────────────

export async function saveImage(key, dataUrl, name) {
  if (!key) throw new Error('Open a note first');
  return api.call('asset.save', { notePath: key, data: dataUrl, name });
}

export function imageMenu(info) {
  const { x, y, link, noteKey, pos, view, wiki } = info;
  const args = { notePath: noteKey, link, wiki: !!wiki };
  openMenu(x, y, [
    {
      label: 'Rename image…', icon: 'pencil', run: async () => {
        const current = decodeLink(link).split('/').pop().replace(/\.[^.]+$/, '');
        const name = await askText({ title: 'Rename image', label: 'New name', value: current, ok: 'Rename', selectAll: true });
        if (!name || name === current) return;
        try {
          await saveDoc(noteKey);
          const open = [...docs.values()].filter((d) => d.loaded).map((d) => d.key);
          const r = await api.call('asset.rename', { ...args, newName: name, openPaths: open });
          for (const e of r.edits || []) replaceLinkInDoc(e.path, e.from, e.to);
          // ![[name.png]] embeds (and covers) are found by name: patch the open notes too.
          const ws = wsForPath(noteKey);
          if (r.oldName && r.name && r.oldName !== r.name) {
            for (const d of docs.values()) if (d.loaded && (!ws || wsForPath(d.key) === ws)) replaceWikiInDoc(d.key, r.oldName, r.name);
          }
          if (ws) invalidateFiles(ws.id);
          for (const p of r.updated || []) {
            const n = findNote(p);
            if (n) upsertNote({ ...n });
          }
          toast(`Image renamed to ${r.name}`, 'success');
        } catch (e) {
          toast('Rename failed: ' + e.message, 'error', 6000);
        }
      },
    },
    { label: 'Copy image', icon: 'copy', run: () => api.call('asset.copy', args).then((ok) => toast(ok ? 'Image copied' : 'Image not found', ok ? 'success' : 'error')) },
    { label: 'Open image', icon: 'external', run: () => api.call('asset.open', args) },
    { label: 'Show in folder', icon: 'folder', run: () => api.call('asset.reveal', args) },
    { sep: true },
    {
      label: 'Delete image', icon: 'trash', danger: true, run: async () => {
        if (!(await askConfirm({ title: 'Delete image?', body: 'The image file goes to the Recycle Bin and is removed from this note.', ok: 'Delete', danger: true }))) return;
        try {
          await api.call('asset.delete', args);
          const s = view.state;
          const line = s.doc.lineAt(Math.min(pos, s.doc.length));
          const re = wiki ? /!\[\[[^\]\n]*\]\]/g : /!\[[^\]]*\]\([^)]*\)/g;
          let m;
          while ((m = re.exec(line.text))) {
            if (m[0].includes(link)) {
              const from = line.from + m.index;
              const to = from + m[0].length;
              const whole = line.text.trim() === m[0];
              view.dispatch({ changes: { from: whole ? line.from : from, to: whole ? Math.min(line.to + 1, s.doc.length) : to } });
              break;
            }
          }
          const ws = wsForPath(noteKey);
          if (ws) invalidateFiles(ws.id);
        } catch (e) {
          toast('Delete failed: ' + e.message, 'error');
        }
      },
    },
  ]);
}

function replaceLinkInDoc(key, from, to) {
  const d = docs.get(key);
  if (!d || !d.loaded) return;
  const text = d.state.doc.toString();
  const changes = [];
  const needle = '(' + from + ')';
  let i = text.indexOf(needle);
  while (i >= 0) {
    changes.push({ from: i + 1, to: i + 1 + from.length, insert: to });
    i = text.indexOf(needle, i + needle.length);
  }
  const needle2 = '(<' + decodeLink(from) + '>)';
  i = text.indexOf(needle2);
  while (i >= 0) {
    changes.push({ from: i + 1, to: i + needle2.length - 1, insert: to });
    i = text.indexOf(needle2, i + needle2.length);
  }
  if (changes.length) applyToDoc(key, { changes });
}

function replaceWikiInDoc(key, oldName, newName) {
  const d = docs.get(key);
  if (!d || !d.loaded) return;
  const text = d.state.doc.toString();
  const changes = [];
  const re = /\[\[([^\]|#\n]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const target = m[1];
    const file = target.slice(target.lastIndexOf('/') + 1);
    if (file.toLowerCase() !== oldName.toLowerCase()) continue;
    const from = m.index + 2 + (target.length - file.length);
    changes.push({ from, to: from + file.length, insert: newName });
  }
  if (changes.length) applyToDoc(key, { changes });
}

// ───────────────────────────── covers ─────────────────────────────

function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}

/** Adds or replaces the cover (front matter `banner:`, compatible with Obsidian's banner plugins). */
export async function pickCover(key) {
  const d = docs.get(key);
  if (!d || !d.loaded) return;
  const file = await pickImageFile();
  if (!file) return;
  try {
    const data = await readFileAsDataUrl(file);
    const r = await saveImage(key, data, file.name);
    const value = r.wiki ? `![[${r.link}]]` : r.link;
    const text = d.state.doc.toString();
    const fm = readFrontmatter(text);
    const keyName = fm ? (['banner', 'cover', 'image', 'cover-image'].find((k) => fm.data[k] !== undefined) || 'banner') : 'banner';
    const ws = wsForPath(key);
    if (ws) invalidateFiles(ws.id);
    setDocText(key, setFrontmatterKey(text, keyName, value), false);
    const n = findNote(key);
    if (n) upsertNote({ ...n, cover: r.url });
  } catch (e) {
    toast('Could not set the cover: ' + e.message, 'error');
  }
}

export function removeCover(key) {
  const text = getDocText(key);
  if (text == null) return;
  let next = text;
  for (const k of ['banner', 'cover', 'image', 'cover-image', 'banner_y', 'banner-y']) next = setFrontmatterKey(next, k, null);
  setDocText(key, next, false);
  const n = findNote(key);
  if (n) upsertNote({ ...n, cover: null });
}

export function hasCover(key) {
  const text = getDocText(key);
  if (text == null) return false;
  const fm = readFrontmatter(text.slice(0, 24000));
  return !!(fm && bannerOf(fm.data));
}

export function bannerMenu(info) {
  openMenu(info.x, info.y, [
    { label: 'Change cover image…', icon: 'image', run: () => pickCover(info.noteKey) },
    { label: 'Remove cover', icon: 'trash', danger: true, run: () => removeCover(info.noteKey) },
  ]);
}

/** URL for an image written in a note: a wiki name, a banner value or a relative path. */
export function resolveImage(fromKey, raw, wiki) {
  let target = raw;
  if (!wiki) {
    const c = cleanTarget(raw);
    if (!c) return null;
    target = c.target;
  }
  const r = resolveName(fromKey, target);
  if (r.pending) return undefined;
  if (r.path) return fileUrl(r.path);
  return wiki ? null : resolveAssetUrl(fromKey, target);
}

// ───────────────────────────── [[links]] ─────────────────────────────

const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

export async function openWiki(target, path, fromKey) {
  if (path) {
    if (IMG_RE.test(path)) api.call('asset.open', { notePath: fromKey, link: target, wiki: true });
    else if (/\.(md|markdown|txt|canvas)$/i.test(path)) openNote(path);
    else api.call('app.reveal', { path });
    return;
  }
  // Obsidian behaviour: following a link to a note that does not exist creates it.
  const ws = wsForPath(fromKey);
  if (!ws) {
    toast(`“${target}” was not found`, 'warning');
    return;
  }
  const from = findNote(fromKey);
  const name = target.split('/').pop();
  await newNote({ wsId: ws.id, folder: from ? from.folder : '', title: name, text: '' });
}

export const KANBAN_TEMPLATE = '---\n\nkanban-plugin: board\n\n---\n\n## To Do\n\n\n\n## Doing\n\n\n\n## Done\n\n**Complete**\n\n\n\n%% kanban:settings\n```\n{"kanban-plugin":"board"}\n```\n%%\n';

export function newKanban(opts = {}) {
  return newNote({ ...opts, title: opts.title || 'Kanban', text: KANBAN_TEMPLATE, ext: 'md' });
}

export function newCanvas(opts = {}) {
  return newNote({ ...opts, title: opts.title || 'Canvas', text: '', ext: 'canvas' });
}

// ───────────────────────────── links ─────────────────────────────

export function openLink(href, fromKey) {
  if (!href) return;
  let h = href.trim().replace(/^<|>$/g, '');
  if (/^www\./i.test(h)) h = 'https://' + h;
  if (/^(https?:|mailto:)/i.test(h)) {
    api.call('app.openExternal', { url: h });
    return;
  }
  const dec = decodeLink(h).split('#')[0];
  if (/\.(md|markdown|txt)$/i.test(dec)) {
    const target = isAbs(dec) ? dec : joinPath(dirname(fromKey), dec);
    if (isAbs(target)) openPath(target);
    else openNote(target);
    return;
  }
  toast('Only web links and links to notes can be opened', 'warning');
}

export async function dropFiles(files) {
  try {
    const paths = await api.dropFiles(files);
    for (const p of paths) await openPath(p);
  } catch (e) {
    toast('Could not open the dropped files: ' + e.message, 'error');
  }
}

export const plainNext = { value: false };

export function codeState(key, id) {
  return persisted.codeBlocks?.[key]?.[id] || null;
}

export function setCodeState(key, id, patch) {
  if (!key) return;
  const all = persisted.codeBlocks || (persisted.codeBlocks = {});
  const forNote = all[key] || (all[key] = {});
  const next = { ...(forNote[id] || {}), ...patch };
  if (!next.c && (next.w === undefined || next.w === (settings.value.codeWrapDefault ? 1 : 0))) delete forNote[id];
  else forNote[id] = next;
  if (!Object.keys(forNote).length) delete all[key];
  saveState();
}

function editorMenu(e, view, ref) {
  openMenu(e.clientX, e.clientY, editorMenuItems(view, {
    markdown: ref.kind === 'md',
    search: (q) => { mainView.value = { kind: 'search', q }; },
    find: () => ed.openSearchPanel(view),
  }), { minWidth: 230 });
}

let readyResolve;
export const editorReadyPromise = new Promise((r) => { readyResolve = r; });

/** Creates the single CodeMirror view inside the main area. */
export function editorReady(el) {
  if (ed.getView()) return;
  ed.initEditor(el, {
    settings: () => settings.peek(),
    onUpdate: onEditorUpdate,
    openLink,
    imageMenu,
    saveImage,
    toast: (m, k, ms) => toast(m, k, ms),
    dropFiles,
    plainNext,
    codeState,
    setCodeState,
    editorMenu,
    openWiki,
    bannerMenu,
    resolveWiki: (fromKey, target) => resolveName(fromKey, target),
    resolveImage,
    noteTitle: (key) => docTitle(key),
  });
  // When the [[link]] index arrives, re-render links and images of the visible note.
  onLinksChanged(() => ed.refreshDecorations());
  readyResolve();
}

export function currentDoc() {
  return shown ? docs.get(shown) : null;
}

export function patchTabColor(key, color) {
  patchTab(key, { color });
}
