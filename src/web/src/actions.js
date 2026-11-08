// User actions on workspaces, folders and notes (used by the sidebar, grid, tabs and menus).

import { signal } from '@preact/signals';
import * as api from './api.js';
import {
  workspaces, activeWsId, settings, tabsByWs, persisted, saveState, toast, setNotes, notesByWs, loadNotes,
  replaceWorkspace, wsById, patchNote, removeNote, findNote, upsertNote, refreshWorkspaces, mainView, wsState,
  setTabs, setWorkspaces, updateSettings,
} from './store.js';
import {
  docs, switchWorkspace, closeTabs, closeTab, renameKey, renamePrefix, saveDoc, reloadDoc, openNote, newNote,
  patchTabColor, closeAllTabs, closeOtherTabs, closeTabsToRight, closeUntouchedTabs, refreshNoteCounts, isDirty,
  newKanban, newCanvas,
} from './docs.js';
import { workspaceDialog, folderDialog, moveDialog, confirm, prompt, askChoice } from './ui/dialogs.jsx';
import { openMenu } from './ui/menu.jsx';
import { BUILTIN_THEMES, exportTheme, sanitizeTheme } from './themes.js';
import { basename } from './util.js';
import { invalidateFiles } from './links.js';

const err = (prefix) => (e) => toast(`${prefix}: ${e.message}`, 'error', 7000);

/** True when a folder path is `folder` itself or inside it (paths are workspace-relative, '/'-separated). */
export function inFolder(path, folder) {
  const p = (path || '').toLowerCase();
  const f = (folder || '').toLowerCase();
  return !f || p === f || p.startsWith(f + '/');
}

// ───────────────────────────── workspaces ─────────────────────────────

/** Menu for the rail's import button: open a folder (e.g. an Obsidian vault) in place, or import a .mnpack. */
export function importMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const inRail = r.left < 90 && r.top > 0;
  const items = [
    { label: 'Open a folder as a workspace…', icon: 'vault', run: () => linkFolder() },
    { label: 'Import a .mnpack file…', icon: 'download', run: () => importPack() },
  ];
  if (inRail) openMenu(r.right + 10, r.top, items, { anchorY: r.bottom, minWidth: 250 });
  else openMenu(r.left, r.bottom + 4, items, { minWidth: 250 });
}

/** Opens an existing folder (an Obsidian vault, a folder of .md files…) as a workspace. Nothing is copied. */
export async function linkFolder(path = null) {
  let ws;
  try {
    ws = await api.call('ws.link', path ? { path } : {});
  } catch (e) { err('Could not open the folder')(e); return; }
  if (!ws) return;
  if (workspaces.value.some((w) => w.id === ws.id)) replaceWorkspace(ws);
  else workspaces.value = [...workspaces.value, ws];
  saveState();
  await switchWorkspace(ws.id);
  toast(`Opened “${ws.name}”. Its files stay where they are.`, 'success', 6000);
}

export async function createWorkspace() {
  const r = await workspaceDialog();
  if (!r) return;
  if (r.link) { await linkFolder(); return; }
  if (r.import) { await importPack(); return; }
  try {
    let ws = await api.call('ws.create', { name: r.name, color: r.color, icon: r.icon || '' });
    if (r.banner) ws = await api.call('ws.banner', { id: ws.id, data: r.banner, hover: !!r.bannerHover });
    workspaces.value = [...workspaces.value, ws];
    setNotes(ws.id, []);
    saveState();
    await switchWorkspace(ws.id);
    toast(`Workspace “${ws.name}” created`, 'success');
  } catch (e) { err('Could not create the workspace')(e); }
}

export async function editWorkspace(ws) {
  const r = await workspaceDialog(ws);
  if (!r) return;
  try {
    const args = { id: ws.id, name: r.name, color: r.color };
    if (r.icon) args.icon = r.icon;
    if (r.removeIcon) args.removeIcon = true;
    const res = await api.call('ws.update', args);
    if (res.oldDir) {
      renamePrefix(res.oldDir + '/', res.ws.dir + '/');
      await loadNotes(ws.id);
    }
    let next = res.ws;
    if (r.banner !== undefined || !!r.bannerHover !== !!ws.bannerHover) {
      next = await api.call('ws.banner', { id: ws.id, data: r.banner || '', remove: r.banner === null, hover: !!r.bannerHover });
    }
    replaceWorkspace(next);
  } catch (e) { err('Could not update the workspace')(e); }
}

export async function deleteWorkspace(ws) {
  if (ws.linked) {
    // Opened folders are never deleted: only MarkNotes forgets them.
    const ok = await confirm({
      title: `Remove “${ws.name}” from MarkNotes?`,
      body: `Only the shortcut goes away. The folder ${ws.root} and every file in it stay exactly as they are, and you can open it again any time.`,
      ok: 'Remove from MarkNotes',
    });
    if (!ok) return;
  } else {
    const notes = (notesByWs.value[ws.id] || []).length;
    const typed = await prompt({
      title: `Delete “${ws.name}”?`,
      sub: `The workspace folder${notes ? ` with its ${notes} notes` : ''} goes to the Windows Recycle Bin, so it can be restored from there. Type the workspace name to confirm.`,
      label: 'Workspace name',
      value: '',
      ok: 'Delete workspace',
      selectAll: false,
    });
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== ws.name.trim().toLowerCase()) {
      toast('The name did not match, nothing was deleted', 'warning');
      return;
    }
  }
  // Write pending edits first so the Recycle Bin copy is complete.
  const keys = (tabsByWs.value[ws.id] || []).map((t) => t.key);
  for (const k of keys) { const d = docs.get(k); if (d && isDirty(d)) await saveDoc(k); }
  for (const k of keys) docs.delete(k);
  try {
    await api.call('ws.delete', { id: ws.id });
  } catch (e) { err('Could not delete the workspace')(e); return; }
  tabsByWs.value = Object.fromEntries(Object.entries(tabsByWs.value).filter(([k]) => k !== ws.id));
  delete persisted.ws[ws.id];
  workspaces.value = workspaces.value.filter((w) => w.id !== ws.id);
  const next = workspaces.value[0];
  if (activeWsId.value === ws.id) {
    activeWsId.value = null;
    if (next) await switchWorkspace(next.id);
  }
  saveState();
  toast(ws.linked ? `“${ws.name}” removed from MarkNotes (its files were not touched)` : `“${ws.name}” moved to the Recycle Bin`, 'success');
}

export function moveWorkspace(id, toIndex) {
  const list = workspaces.value.slice();
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) return;
  const [w] = list.splice(i, 1);
  list.splice(Math.max(0, Math.min(toIndex > i ? toIndex - 1 : toIndex, list.length)), 0, w);
  workspaces.value = list;
  saveState();
}

/** Shows or hides the Workspace Guide ('guide') or Browse Folders ('browse') page of a workspace. The guide text is kept. */
export async function setWorkspaceFeature(ws, feature, on) {
  try {
    replaceWorkspace(await api.call('ws.features', { id: ws.id, [feature]: on }));
    if (on) {
      if (activeWsId.value !== ws.id) await switchWorkspace(ws.id);
      mainView.value = { kind: feature };
    } else if (mainView.value.kind === feature && activeWsId.value === ws.id) mainView.value = { kind: 'editor' };
  } catch (e) { err('Could not update the workspace')(e); }
}

export function workspaceMenu(ws, x, y) {
  openMenu(x, y, [
    { title: ws.linked ? `${ws.name} · opened folder` : ws.name },
    { label: 'New note', icon: 'file-plus', run: async () => { await switchWorkspace(ws.id); newNote({ wsId: ws.id }); } },
    { label: 'New folder…', icon: 'folder-plus', run: () => createFolder(ws.id) },
    { label: 'All notes', icon: 'grid', run: async () => { await switchWorkspace(ws.id); mainView.value = { kind: 'all' }; } },
    { sep: true },
    { label: 'Edit name & picture…', icon: 'pencil', run: () => editWorkspace(ws) },
    { label: 'Export / share workspace…', icon: 'upload', run: () => exportWorkspace(ws) },
    { label: 'Show in Explorer', icon: 'folder', run: () => api.call('ws.reveal', { id: ws.id }) },
    { sep: true },
    { label: ws.guideOn ? 'Remove Workspace Guide' : 'Add Workspace Guide', icon: 'signpost', run: () => setWorkspaceFeature(ws, 'guide', !ws.guideOn) },
    { label: ws.browseOn ? 'Remove Browse Folders' : 'Add Browse Folders', icon: 'list-search', run: () => setWorkspaceFeature(ws, 'browse', !ws.browseOn) },
    { sep: true },
    ws.linked
      ? { label: 'Remove from MarkNotes…', icon: 'x', danger: true, run: () => deleteWorkspace(ws) }
      : { label: 'Delete workspace…', icon: 'trash', danger: true, run: () => deleteWorkspace(ws) },
  ]);
}

// ───────────────────────────── folders ─────────────────────────────
// Folders are identified by their path inside the workspace ("Novel/EN"); `name` is the last part.

export async function createFolder(wsId = activeWsId.value, parent = '') {
  const r = await folderDialog(null, parent);
  if (!r) return null;
  try {
    const f = await api.call('folder.create', { wsId, name: r.name, parent: parent || '' });
    if (r.icon || r.color) await api.call('folder.setMeta', { wsId, name: f.path, icon: r.icon || '', color: r.color || '' });
    replaceWorkspace(await api.call('ws.get', { id: wsId }));
    const st = wsState(wsId);
    if (parent) st.expanded = { ...(st.expanded || {}), [parent]: true };
    st.lastFolder = f.path;
    saveState();
    return f.path;
  } catch (e) { err('Could not create the folder')(e); return null; }
}

export async function editFolder(wsId, folder) {
  const r = await folderDialog(folder);
  if (!r) return;
  try {
    let path = folder.path;
    if (r.name !== folder.name) {
      // Save edits first: files are about to move.
      for (const d of docs.values()) if (isDirty(d)) await saveDoc(d.key);
      const res = await api.call('folder.rename', { wsId, name: folder.path, newName: r.name });
      renamePrefix(res.oldPrefix, res.newPrefix);
      path = res.path;
      // Expanded state, "last folder" and the open card view follow the folder and everything inside it.
      const remap = (p) => (p && inFolder(p, folder.path) ? path + p.slice(folder.path.length) : p);
      const st = wsState(wsId);
      if (st.expanded) st.expanded = Object.fromEntries(Object.entries(st.expanded).map(([k, v]) => [remap(k), v]));
      st.lastFolder = remap(st.lastFolder);
      if (mainView.value.kind === 'folder' && mainView.value.folder) mainView.value = { ...mainView.value, folder: remap(mainView.value.folder) };
      invalidateFiles(wsId);
    }
    await api.call('folder.setMeta', { wsId, name: path, icon: r.icon || '', color: r.color || '' });
    replaceWorkspace(await api.call('ws.get', { id: wsId }));
    await loadNotes(wsId);
    saveState();
  } catch (e) { err('Could not update the folder')(e); }
}

export async function deleteFolder(wsId, folder) {
  const count = (notesByWs.value[wsId] || []).filter((n) => n.folder && inFolder(n.folder, folder.path)).length;
  const ok = await confirm({
    title: `Delete folder “${folder.name}”?`,
    body: count ? `It goes to the Windows Recycle Bin with its ${count} note${count === 1 ? '' : 's'} (subfolders included).` : 'The folder has no notes. It goes to the Windows Recycle Bin.',
    ok: 'Delete folder',
    danger: true,
  });
  if (!ok) return;
  if (!await deleteFolderNow(wsId, folder)) return;
  replaceWorkspace(await api.call('ws.get', { id: wsId }));
  invalidateFiles(wsId);
  await loadNotes(wsId);
  toast(`Folder “${folder.name}” moved to the Recycle Bin`, 'success');
}

/** Sends a folder to the Recycle Bin (its tabs close first), without asking. The caller reloads the workspace. */
async function deleteFolderNow(wsId, folder) {
  const ws = wsById(wsId);
  const prefix = `${ws.dir}/${folder.path}/`.toLowerCase();
  const keys = (tabsByWs.value[wsId] || []).filter((t) => t.key.toLowerCase().startsWith(prefix)).map((t) => t.key);
  for (const k of keys) { const d = docs.get(k); if (d && isDirty(d)) await saveDoc(k); }
  await closeTabs(keys, { wsId, undoToast: false });
  try {
    await api.call('folder.delete', { wsId, name: folder.path });
  } catch (e) { err('Could not delete the folder')(e); return false; }
  if (mainView.value.kind === 'folder' && mainView.value.folder && inFolder(mainView.value.folder, folder.path)) mainView.value = { kind: 'all' };
  return true;
}

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Moves a folder (and everything in it) inside another folder ('' = top level). Returns its new path, or null. */
export async function moveFolder(wsId, path, parent = '') {
  parent = parent || '';
  if (parent === parentOf(path)) return path;
  if (parent && inFolder(parent, path)) {
    toast('A folder can\'t go inside itself', 'warning');
    return null;
  }
  try {
    // Files are about to move: write pending edits first.
    for (const d of docs.values()) if (isDirty(d)) await saveDoc(d.key);
    const res = await api.call('folder.move', { wsId, name: path, parent });
    renamePrefix(res.oldPrefix, res.newPrefix);
    const remap = (p) => (p && inFolder(p, path) ? res.path + p.slice(path.length) : p);
    const st = wsState(wsId);
    st.expanded = Object.fromEntries(Object.entries(st.expanded || {}).map(([k, v]) => [remap(k), v]));
    if (parent) st.expanded[parent] = true; // show where it went
    st.lastFolder = remap(st.lastFolder);
    if (mainView.value.kind === 'folder' && mainView.value.folder) mainView.value = { ...mainView.value, folder: remap(mainView.value.folder) };
    invalidateFiles(wsId);
    replaceWorkspace(await api.call('ws.get', { id: wsId }));
    await loadNotes(wsId);
    saveState();
    return res.path;
  } catch (e) { err('Could not move the folder')(e); return null; }
}

/** `paths`: every sibling folder (same parent), in the new order. */
export async function reorderFolders(wsId, paths) {
  try {
    await api.call('folder.reorder', { wsId, names: paths });
    replaceWorkspace(await api.call('ws.get', { id: wsId }));
  } catch (e) { err('Could not reorder')(e); }
}

export function openFolderView(folder, layout = null) {
  if (layout && activeWsId.value) {
    persisted.gridLayouts = { ...(persisted.gridLayouts || {}), [settings.value.gridLayoutScope === 'all' ? '*' : activeWsId.value]: layout };
    saveState();
  }
  mainView.value = { kind: 'folder', folder };
}

// ── the sidebar's clipboard: Cut / Copy, then Paste into a folder (like Explorer) ──
/** {mode: 'cut' | 'copy', notes: [paths], folders: [{wsId, path}]} or null. Cut rows look faded until pasted. */
export const sidebarClip = signal(null);

export function clipItems(mode, { notes = [], folders = [] }) {
  if (!notes.length && !folders.length) return;
  sidebarClip.value = { mode, notes: notes.map((n) => n.path), folders: folders.map((f) => ({ wsId: f.wsId, path: f.path })) };
  toast(`${mode === 'cut' ? 'Cut' : 'Copied'} ${itemsLabel({ notes, folders })}: right-click a folder › Paste, or Ctrl+V`, 'info', 2600);
}

/** Pastes into a folder ('' = top level): what was cut moves there, what was copied is copied there. */
export async function pasteInto(wsId, folder) {
  const c = sidebarClip.value;
  if (!c) return;
  const items = { notes: c.notes.map((p) => findNote(p)).filter(Boolean), folders: c.folders };
  if (c.mode === 'cut') {
    sidebarClip.value = null;
    await moveItems(items, { wsId, folder });
  } else await copyItems(items, { wsId, folder });
}

const pasteItem = (wsId, folder) => sidebarClip.value && { label: 'Paste', icon: 'clipboard', hint: 'Ctrl+V', run: () => pasteInto(wsId, folder) };

/** Right-click on the sidebar's empty space: new things at the workspace's top level, outside every folder. */
export function rootMenu(ws, x, y) {
  openMenu(x, y, [
    { title: ws.name },
    { label: 'New folder…', icon: 'folder-plus', run: () => createFolder(ws.id) },
    { label: 'New note here', icon: 'file-plus', run: () => newNote({ wsId: ws.id, folder: '' }) },
    { label: 'New kanban board here', icon: 'kanban', run: () => newKanban({ wsId: ws.id, folder: '' }) },
    { label: 'New canvas here', icon: 'canvas', run: () => newCanvas({ wsId: ws.id, folder: '' }) },
    sidebarClip.value && { sep: true },
    pasteItem(ws.id, ''),
  ]);
}

export function folderMenu(wsId, folder, x, y) {
  const p = folder.path;
  openMenu(x, y, [
    { title: p.includes('/') ? p.split('/').join(' › ') : folder.name },
    { label: 'New subfolder…', icon: 'folder-plus', run: () => createFolder(wsId, p) },
    { label: 'New note here', icon: 'file-plus', run: () => newNote({ wsId, folder: p }) },
    { label: 'New kanban board here', icon: 'kanban', run: () => newKanban({ wsId, folder: p }) },
    { label: 'New canvas here', icon: 'canvas', run: () => newCanvas({ wsId, folder: p }) },
    { sep: true },
    { label: 'Open as cards', icon: 'grid', run: () => openFolderView(p, 'grid') },
    { label: 'Open as covers', icon: 'gallery', run: () => openFolderView(p, 'covers') },
    { sep: true },
    { label: 'Edit folder…', icon: 'pencil', run: () => editFolder(wsId, folder) },
    { label: 'Cut', icon: 'scissors', hint: 'Ctrl+X', run: () => clipItems('cut', { folders: [{ wsId, path: p }] }) },
    { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', run: () => clipItems('copy', { folders: [{ wsId, path: p }] }) },
    pasteItem(wsId, p),
    { label: 'Duplicate', icon: 'copy-plus', run: () => copyItems({ folders: [{ wsId, path: p }] }, null, { duplicate: true }) },
    { label: 'Copy to…', icon: 'copy-to', run: () => copyItems({ folders: [{ wsId, path: p }] }) },
    { swatches: true, value: folder.color, onPick: async (c) => { await api.call('folder.setMeta', { wsId, name: p, color: c || '' }); replaceWorkspace(await api.call('ws.get', { id: wsId })); } },
    { label: 'Show in Explorer', icon: 'folder', run: () => api.call('folder.reveal', { wsId, name: p }) },
    { sep: true },
    { label: 'Delete folder…', icon: 'trash', danger: true, run: () => deleteFolder(wsId, folder) },
  ]);
}

// ───────────────────────────── notes ─────────────────────────────

export async function renameNote(note) {
  const title = await prompt({ title: 'Rename note', label: 'Name', value: note.title, ok: 'Rename' });
  if (!title || title === note.title) return;
  try {
    const d = docs.get(note.path);
    if (d && (isDirty(d) || d.saving)) await saveDoc(note.path);
    const dto = await api.call('note.rename', { path: note.path, title });
    await api.call('note.setMeta', { path: dto.path, patch: { autoTitle: false } });
    renameKey(note.path, dto.path, { ...dto, autoTitle: false });
    const doc = docs.get(dto.path);
    if (doc) doc.autoTitle = false;
  } catch (e) { err('Could not rename')(e); }
}

export async function deleteNote(note) {
  if (settings.value.confirmDelete) {
    const ok = await confirm({ title: 'Delete note?', body: `“${note.title}” will go to the Windows Recycle Bin.`, ok: 'Delete', danger: true });
    if (!ok) return;
  }
  if (!await deleteNoteNow(note)) return;
  if (note.wsId) refreshNoteCounts(note.wsId);
  toast(`“${note.title}” moved to the Recycle Bin`, 'success');
}

/** Sends a note to the Recycle Bin (its tab closes first), without asking. */
async function deleteNoteNow(note) {
  const d = docs.get(note.path);
  if (d) {
    clearTimeout(d.saveTimer);
    d.changeSeq = d.savedSeq; // nothing to save, it is being deleted
  }
  for (const [wsId, tabs] of Object.entries(tabsByWs.value)) {
    if (tabs.some((t) => t.key === note.path)) await closeTab(note.path, { wsId });
  }
  try {
    await api.call('note.delete', { path: note.path });
    removeNote(note.path);
    return true;
  } catch (e) { err('Could not delete')(e); return false; }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 notes", "2 folders" or "5 items". */
export function itemsLabel({ notes = [], folders = [] }) {
  if (!folders.length) return plural(notes.length, 'note');
  if (!notes.length) return plural(folders.length, 'folder');
  return plural(notes.length + folders.length, 'item');
}

/**
 * Deletes several notes and folders at once (the sidebar's multi-selection) after one confirmation.
 * folders: [{wsId, path}]. True when it went ahead.
 */
export async function deleteItems({ notes = [], folders = [] }) {
  if (!notes.length && !folders.length) return false;
  const wsId = (folders[0] && folders[0].wsId) || notes[0].wsId;
  const inside = (notesByWs.value[wsId] || []).filter((n) => n.folder && folders.some((f) => f.wsId === n.wsId && inFolder(n.folder, f.path))).length;
  const parts = [];
  if (folders.length) parts.push(plural(folders.length, 'folder') + (inside ? ` (with ${plural(inside, 'note')} inside)` : ''));
  if (notes.length) parts.push(plural(notes.length, 'note'));
  const ok = await confirm({ title: `Delete ${parts.join(' and ')}?`, body: 'They go to the Windows Recycle Bin (subfolders included).', ok: 'Delete', danger: true });
  if (!ok) return false;
  let done = 0;
  for (const n of notes) if (await deleteNoteNow(n)) done++;
  for (const f of folders) if (await deleteFolderNow(f.wsId, f)) done++;
  if (folders.length) {
    replaceWorkspace(await api.call('ws.get', { id: wsId }));
    invalidateFiles(wsId);
    await loadNotes(wsId);
  }
  if (wsId) refreshNoteCounts(wsId);
  if (done) toast(`${plural(done, 'item')} moved to the Recycle Bin`, 'success');
  return true;
}

/** The move dialog's "new folder" choice: creates it and points t at it. */
async function createTargetFolder(t) {
  if (!t.create) return;
  const f = await api.call('folder.create', { wsId: t.wsId, name: t.create.name, parent: t.create.parent || '' });
  if (t.create.icon || t.create.color) await api.call('folder.setMeta', { wsId: t.wsId, name: f.path, icon: t.create.icon || '', color: t.create.color || '' });
  t.folder = f.path;
  delete t.create;
  replaceWorkspace(await api.call('ws.get', { id: t.wsId }));
}

/** Moves one note to t = {wsId, folder}, without asking or telling. Returns its new path. */
async function moveOneNote(note, t) {
  const d = docs.get(note.path);
  if (d && (isDirty(d) || d.saving)) await saveDoc(note.path);
  const res = await api.call('note.move', { path: note.path, wsId: t.wsId, folder: t.folder });
  const fromWs = note.wsId;
  renameKey(note.path, res.note.path, res.note);
  if (res.textChanged && docs.get(res.note.path)?.loaded) await reloadDoc(res.note.path);
  // Tabs follow the note into its new workspace.
  if (fromWs && fromWs !== t.wsId) {
    setTabs(fromWs, (tabs) => tabs.filter((x) => x.key !== res.note.path));
    if (!notesByWs.value[t.wsId]) await loadNotes(t.wsId);
    else upsertNote(res.note);
    refreshNoteCounts(fromWs);
    invalidateFiles(t.wsId);
  }
  return res.note.path;
}

const whereTo = (t) => { const ws = wsById(t.wsId); return `${ws ? ws.name : ''} › ${t.folder ? t.folder.split('/').join(' › ') : 'workspace root'}`; };

export async function moveNote(note, target = null, initialWs = null) {
  const t = target || await moveDialog({ title: `Move “${note.title}” to…`, wsId: note.wsId || activeWsId.value, folder: note.folder, initialWs });
  if (!t) return;
  try {
    await createTargetFolder(t);
    await moveOneNote(note, t);
    refreshNoteCounts(t.wsId);
    toast(`Moved to ${whereTo(t)}`, 'success');
  } catch (e) { err('Could not move the note')(e); }
}

/** Moves several notes at once (the sidebar's multi-selection): one dialog when no target is given, one message. */
/**
 * Moves several notes and folders at once (the sidebar's multi-selection): one dialog when no target is given,
 * one message. folders: [{wsId, path}]; they move inside their own workspace only.
 */
export async function moveItems({ notes = [], folders = [] }, target = null) {
  if (!notes.length && !folders.length) return;
  if (notes.length === 1 && !folders.length) { await moveNote(notes[0], target); return; }
  const wsId = (folders[0] && folders[0].wsId) || notes[0].wsId || activeWsId.value;
  const t = target || await moveDialog({ title: `Move ${itemsLabel({ notes, folders })} to…`, wsId, folder: notes.length ? notes[0].folder : null });
  if (!t) return;
  let moved = 0;
  let stayed = 0;
  try {
    await createTargetFolder(t);
    const dest = t.folder || '';
    for (const n of notes) {
      if (n.wsId === t.wsId && (n.folder || '') === dest) continue;
      await moveOneNote(n, t);
      moved++;
    }
    for (const f of folders) {
      if (f.wsId !== t.wsId) { stayed++; continue; }
      if (parentOf(f.path) === dest || inFolder(dest, f.path)) continue;
      if (await moveFolder(f.wsId, f.path, dest)) moved++;
    }
  } catch (e) { err('Could not move')(e); }
  refreshNoteCounts(t.wsId);
  if (moved) toast(`Moved ${plural(moved, 'item')} to ${whereTo(t)}`, 'success');
  if (stayed) toast('Folders can only move inside their own workspace', 'warning');
}

/**
 * Copies notes and folders: into a place picked in the move dialog (or `target`), or with duplicate each one next
 * to itself ("Note (2)", "Folder (2)"). One message. Folders are copied inside their own workspace only.
 */
export async function copyItems({ notes = [], folders = [] }, target = null, { duplicate = false } = {}) {
  if (!notes.length && !folders.length) return;
  const wsId = (folders[0] && folders[0].wsId) || notes[0].wsId || activeWsId.value;
  const one = notes.length + folders.length === 1 ? (notes[0] ? notes[0].title : folders[0].path.split('/').pop()) : null;
  const title = one ? `Copy “${one}” to…` : `Copy ${itemsLabel({ notes, folders })} to…`;
  const t = duplicate ? null : target || await moveDialog({ title, wsId, folder: notes.length ? notes[0].folder : null });
  if (!duplicate && !t) return;
  let done = 0;
  let stayed = 0;
  let name = null;
  const touched = new Set();
  try {
    if (t) await createTargetFolder(t);
    for (const n of notes) {
      // What is on screen gets copied.
      const d = docs.get(n.path);
      if (d && (isDirty(d) || d.saving)) await saveDoc(n.path);
      const dto = await api.call('note.copy', { path: n.path, wsId: duplicate ? n.wsId : t.wsId, folder: duplicate ? n.folder || '' : t.folder || '' });
      if (!notesByWs.value[dto.wsId]) await loadNotes(dto.wsId);
      else upsertNote(dto);
      touched.add(dto.wsId);
      name = name || dto.title;
      done++;
    }
    for (const f of folders) {
      const dest = duplicate ? parentOf(f.path) : t.folder || '';
      if (!duplicate && f.wsId !== t.wsId) { stayed++; continue; }
      if (inFolder(dest, f.path) && dest) { toast('A folder can\'t be copied inside itself', 'warning'); continue; }
      const ws = wsById(f.wsId);
      const prefix = `${ws.dir}/${f.path}/`.toLowerCase();
      for (const d of docs.values()) if (d.key.toLowerCase().startsWith(prefix) && isDirty(d)) await saveDoc(d.key);
      const r = await api.call('folder.copy', { wsId: f.wsId, name: f.path, parent: dest });
      touched.add(f.wsId);
      name = name || r.path.split('/').pop();
      done++;
    }
  } catch (e) { err('Could not copy')(e); }
  for (const id of touched) {
    if (folders.length) {
      replaceWorkspace(await api.call('ws.get', { id }));
      invalidateFiles(id);
      await loadNotes(id);
    }
    refreshNoteCounts(id);
  }
  if (done) {
    if (duplicate) toast(done === 1 ? `Duplicated as “${name}”` : `Duplicated ${plural(done, 'item')}`, 'success');
    else toast(`Copied ${done === 1 ? '' : plural(done, 'item') + ' '}to ${whereTo(t)}`, 'success');
  }
  if (stayed) toast('Folders can only be copied inside their own workspace', 'warning');
}

export async function setNoteColor(note, color) {
  try {
    await api.call('note.setMeta', { path: note.path, patch: { color: color || '' } });
    patchNote(note.path, { color });
    patchTabColor(note.path, color);
  } catch (e) { err('Could not set the colour')(e); }
}

export async function togglePin(note) {
  try {
    await api.call('note.setMeta', { path: note.path, patch: { pinned: !note.pinned } });
    patchNote(note.path, { pinned: !note.pinned });
  } catch (e) { err('Could not pin')(e); }
}

export async function saveCopyAs(key) {
  const d = docs.get(key);
  const text = d && d.loaded ? d.state.doc.toString() : (await api.call('note.read', { path: key })).text;
  const name = basename(key);
  const target = await api.call('note.saveAs', { name, text, encoding: d?.encoding || 'utf8', eol: d?.eol || 'crlf' });
  if (target) toast(`Saved a copy to ${target}`, 'success', 5000);
}

/** Markdown and text notes can be saved as PDF (not canvases). */
export const canSavePdf = (key) => /\.(md|markdown|txt)$/i.test(key || '');

/** Saves a note as a PDF on white paper (render/pdf.js, loaded the first time it is used). */
export function saveAsPdf(key) {
  return import('./render/pdf.js').then((m) => m.saveNotePdf(key)).catch((e) => toast('Could not save the PDF: ' + e.message, 'error'));
}

export async function importExternal(key) {
  // Copy a file opened from outside into the current workspace.
  const t = await moveDialog({ title: `Copy “${basename(key)}” into…`, wsId: activeWsId.value, folder: null });
  if (!t) return;
  if (t.create) {
    const f = await api.call('folder.create', { wsId: t.wsId, name: t.create.name, parent: t.create.parent || '' });
    t.folder = f.path;
    replaceWorkspace(await api.call('ws.get', { id: t.wsId }));
  }
  const d = docs.get(key);
  if (d && isDirty(d)) await saveDoc(key);
  const [dto] = await api.call('note.import', { paths: [key], wsId: t.wsId, folder: t.folder });
  if (dto) {
    if (!notesByWs.value[t.wsId]) await loadNotes(t.wsId);
    upsertNote(dto);
    refreshNoteCounts(t.wsId);
    await openNote(dto.path);
    toast('Copied into your notes', 'success');
  }
}

export function noteMenu(note, x, y) {
  const external = !note.wsId;
  openMenu(x, y, [
    { label: 'Open', icon: 'file-text', run: () => openNote(note.path) },
    !external && { label: note.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', run: () => togglePin(note) },
    !external && { label: 'Rename…', icon: 'pencil', hint: 'F2', run: () => renameNote(note) },
    !external && { label: 'Cut', icon: 'scissors', hint: 'Ctrl+X', run: () => clipItems('cut', { notes: [note] }) },
    !external && { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', run: () => clipItems('copy', { notes: [note] }) },
    !external && { label: 'Duplicate', icon: 'copy-plus', run: () => copyItems({ notes: [note] }, null, { duplicate: true }) },
    !external && { label: 'Move to…', icon: 'move', run: () => moveNote(note) },
    !external && { label: 'Copy to…', icon: 'copy-to', run: () => copyItems({ notes: [note] }) },
    external && { label: 'Copy into my notes…', icon: 'download', run: () => importExternal(note.path) },
    !external && { swatches: true, value: note.color, onPick: (c) => setNoteColor(note, c) },
    { sep: true },
    { label: 'Save a copy as…', icon: 'save', run: () => saveCopyAs(note.path) },
    canSavePdf(note.path) && { label: 'Save as PDF…', icon: 'file-down', run: () => saveAsPdf(note.path) },
    { label: 'Show in Explorer', icon: 'folder', run: () => api.call('app.reveal', { path: note.path }) },
    !external && { sep: true },
    !external && { label: 'Delete', icon: 'trash', danger: true, run: () => deleteNote(note) },
  ]);
}

export function tabMenu(tab, x, y) {
  const note = findNote(tab.key) || { path: tab.key, title: tab.title, wsId: null, folder: '' };
  openMenu(x, y, [
    { label: 'Close', icon: 'x', hint: 'Ctrl+W', run: () => closeTab(tab.key) },
    { label: 'Close other tabs', run: () => closeOtherTabs(tab.key) },
    { label: 'Close tabs to the right', run: () => closeTabsToRight(tab.key) },
    { label: 'Close untouched tabs', run: () => closeUntouchedTabs() },
    { label: 'Close all tabs', icon: 'close-all', hint: 'Ctrl+Shift+W', run: () => closeAllTabs() },
    { sep: true },
    note.wsId && { label: 'Rename…', icon: 'pencil', run: () => renameNote(note) },
    note.wsId && { label: 'Move to…', icon: 'move', run: () => moveNote(note) },
    !note.wsId && { label: 'Copy into my notes…', icon: 'download', run: () => importExternal(tab.key) },
    note.wsId && { swatches: true, value: note.color, onPick: (c) => setNoteColor(note, c) },
    { label: 'Show in Explorer', icon: 'folder', run: () => api.call('app.reveal', { path: tab.key }) },
    note.wsId && { sep: true },
    note.wsId && { label: 'Delete note', icon: 'trash', danger: true, run: () => deleteNote(note) },
  ]);
}

// ───────────────────────────── share / backup ─────────────────────────────

function themesForExport(includeCurrent = true) {
  const s = settings.value;
  const list = [...(s.customThemes || [])];
  if (includeCurrent && !list.some((t) => t.id === s.theme)) {
    const b = BUILTIN_THEMES.find((t) => t.id === s.theme);
    if (b && b.id !== 'discord-dark') list.push(b);
  }
  return list.map((t) => ({ name: t.name, json: exportTheme(t) }));
}

export async function exportWorkspace(ws) {
  const withTheme = await askChoice({
    title: `Export “${ws.name}”`,
    body: 'Creates one .mnpack file with every folder, note and image of this workspace (and its picture). Anyone with MarkNotes can import it and see it exactly like you do.',
    choices: [
      { id: 'theme', label: 'Export + my theme', primary: true },
      { id: 'plain', label: 'Export notes only' },
    ],
  });
  if (!withTheme) return;
  for (const d of docs.values()) if (isDirty(d)) await saveDoc(d.key);
  try {
    const path = await api.call('archive.exportWorkspace', { wsId: ws.id, themes: withTheme === 'theme' ? themesForExport(true) : [] });
    if (path) toast(`Exported to ${path}`, 'success', 6000);
  } catch (e) { err('Export failed')(e); }
}

export async function exportEverything() {
  for (const d of docs.values()) if (isDirty(d)) await saveDoc(d.key);
  try {
    const path = await api.call('archive.exportAll', { settings: JSON.stringify(settings.value), themes: themesForExport(false) });
    if (path) toast(`Backup saved to ${path}`, 'success', 6000);
  } catch (e) { err('Export failed')(e); }
}

export async function importPack(path = null) {
  let res;
  try {
    res = await api.call('archive.import', path ? { path } : {});
  } catch (e) { err('Import failed')(e); return; }
  if (!res) return;
  const s = settings.value;
  let themesAdded = 0;
  const custom = [...(s.customThemes || [])];
  for (const raw of res.themes || []) {
    try {
      const t = sanitizeTheme(raw);
      if (!custom.some((c) => c.name === t.name)) { custom.push(t); themesAdded++; }
    } catch { /* skip bad theme */ }
  }
  if (themesAdded) updateSettings({ customThemes: custom });
  if (res.settings && res.kind === 'full') {
    const apply = await confirm({ title: 'Apply preferences too?', body: 'This backup also contains preferences (theme, editor options, transcription). Apply them on this PC?', ok: 'Apply', cancel: 'Keep mine' });
    if (apply) {
      try {
        const incoming = JSON.parse(res.settings);
        delete incoming.notesRoot;
        delete incoming.chrome;
        updateSettings({ ...incoming, customThemes: custom });
      } catch { /* ignore */ }
    }
  }
  await refreshWorkspaces();
  const imported = res.workspaces || [];
  for (const w of imported) setNotes(w.id, null);
  if (imported.length) await switchWorkspace(imported[0].id);
  toast(`Imported ${imported.length} workspace${imported.length === 1 ? '' : 's'}${themesAdded ? ` and ${themesAdded} theme${themesAdded === 1 ? '' : 's'}` : ''}`, 'success', 6000);
}
