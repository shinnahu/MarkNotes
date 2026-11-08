import { useState, useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  activeWs, currentNotes, mainView, activeKey, settings, wsState, saveState, tabsByWs, activeWsId, findNote, ui,
  toast, upsertNote, setSetting, recorder,
} from '../store.js';
import { openNote, newNote, newKanban, newCanvas, refreshNoteCounts } from '../docs.js';
import {
  createFolder, folderMenu, noteMenu, workspaceMenu, moveNote, moveItems, copyItems, deleteItems, itemsLabel, reorderFolders, createWorkspace,
  importMenu, setWorkspaceFeature, moveFolder, rootMenu, inFolder, sidebarClip, clipItems, pasteInto,
} from '../actions.js';
import * as api from '../api.js';
import { Icon } from './icons.jsx';
import { FolderGlyph } from './FolderGlyph.jsx';
import { RecorderPanel } from './Recorder.jsx';
import { openSettings } from './Settings.jsx';
import { tipProps } from './Toasts.jsx';
import { relTime, fullDate } from '../util.js';
import { openMenu } from './menu.jsx';
import { AnimatedImage } from './AnimatedImage.jsx';

/** "Newest first" uses the note's date property (Obsidian `datetime:`/`date:`) when it has one. */
const dateOf = (n) => (n.date && Date.parse(n.date)) || n.ctime;

export function sortNotes(list, how) {
  const arr = list.slice();
  const by = how === 'name' ? (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
    : how === 'created' ? (a, b) => dateOf(b) - dateOf(a)
      : how === 'oldest' ? (a, b) => dateOf(a) - dateOf(b)
      : (a, b) => b.mtime - a.mtime;
  arr.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || by(a, b));
  return arr;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const FOLDER_SORTS = {
  name: byName,
  recent: (a, b) => b.latest - a.latest || byName(a, b),
  newest: (a, b) => ((b.meta && b.meta.ctime) || 0) - ((a.meta && a.meta.ctime) || 0) || byName(a, b),
  oldest: (a, b) => ((a.meta && a.meta.ctime) || 0) - ((b.meta && b.meta.ctime) || 0) || byName(a, b),
};

/** Folder tree of a workspace: [{path, name, meta, children, notes, total, latest}]. sort: custom|name|recent|newest|oldest */
export function buildTree(ws, notes, sort = 'custom') {
  const root = { path: '', name: '', meta: null, children: [], notes: [], total: 0 };
  const byPath = new Map([['', root]]);
  for (const f of ws.folders) byPath.set(f.path.toLowerCase(), { path: f.path, name: f.name, meta: f, children: [], notes: [], total: 0 });
  for (const f of ws.folders) {
    const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    (byPath.get(parent.toLowerCase()) || root).children.push(byPath.get(f.path.toLowerCase()));
  }
  for (const n of notes) (byPath.get((n.folder || '').toLowerCase()) || root).notes.push(n);
  const count = (node) => {
    node.total = node.notes.length + node.children.reduce((s, c) => s + count(c), 0);
    node.latest = Math.max(0, ...node.notes.map((n) => n.mtime), ...node.children.map((c) => c.latest));
    return node.total;
  };
  count(root);
  const by = FOLDER_SORTS[sort];
  if (by) {
    const sortAll = (node) => { node.children.sort(by); node.children.forEach(sortAll); };
    sortAll(root);
  }
  return root;
}

export const FOLDER_SORT_LABELS = [['custom', 'Custom order (drag to reorder)'], ['name', 'Name'], ['recent', 'Recently edited'], ['newest', 'Newest first'], ['oldest', 'Oldest first']];
const NOTE_SORT_LABELS = [['modified', 'Last edited'], ['name', 'Name'], ['created', 'Newest first'], ['oldest', 'Oldest first']];

function sortMenu(e, ws) {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  const st = wsState(ws.id);
  const cur = st.folderSort || 'custom';
  const noteSort = settings.value.sidebarSort;
  openMenu(r.right, r.bottom + 4, [
    { title: 'Sort folders' },
    ...FOLDER_SORT_LABELS.map(([id, label]) => ({ label, checked: cur === id, run: () => { st.folderSort = id; saveState(); bump.value++; } })),
    { sep: true },
    { title: 'Sort notes' },
    ...NOTE_SORT_LABELS.map(([id, label]) => ({ label, checked: noteSort === id, run: () => setSetting('sidebarSort', id) })),
  ], { anchorRight: true, minWidth: 250 });
}

// Re-renders the sidebar when a per-workspace view option changes (it lives in persisted state).
const bump = signal(0);

export const KIND_ICON = { kanban: 'kanban', canvas: 'canvas' };

// ── several notes and folders at once: Ctrl+click adds or removes one, Shift+click selects a range (like Explorer) ──
// Rows are keyed 'n:<note path>' and 'f:<workspace id>|<folder path>'.
const selection = signal(new Set());
let anchor = null; // where a Shift range starts
const noteKey = (path) => `n:${path}`;
const folderKey = (wsId, path) => `f:${wsId}|${path}`;

export function clearSidebarSelection() {
  if (selection.value.size) selection.value = new Set();
}

/** The rows as shown, top to bottom (collapsed folders hide theirs). */
const shownKeys = () => [...document.querySelectorAll('.sidebar .note-row[data-path], .sidebar .folder-row[data-folder]')]
  .map((r) => (r.dataset.path ? noteKey(r.dataset.path) : folderKey(r.dataset.ws, r.dataset.folder)));

/** The selected rows that are shown, top to bottom. What is inside a selected folder goes with it. */
function selectedItems() {
  const keys = shownKeys().filter((k) => selection.value.has(k));
  const all = keys.filter((k) => k.startsWith('f:')).map((k) => ({ wsId: k.slice(2, k.indexOf('|')), path: k.slice(k.indexOf('|') + 1) }));
  const folders = all.filter((f) => !all.some((g) => g !== f && g.wsId === f.wsId && inFolder(f.path, g.path)));
  const notes = keys.filter((k) => k.startsWith('n:')).map((k) => findNote(k.slice(2))).filter(Boolean)
    .filter((n) => !folders.some((f) => f.wsId === n.wsId && n.folder && inFolder(n.folder, f.path)));
  return { notes, folders, shown: keys.length };
}

/** A click on a row with Ctrl or Shift changes the selection and returns true; a plain click clears it. */
function selectClick(e, key) {
  const add = e.ctrlKey || e.metaKey;
  const open = mainView.value.kind === 'editor' && activeKey.value ? noteKey(activeKey.value) : null;
  if (e.shiftKey) {
    const rows = shownKeys();
    const from = rows.indexOf(anchor && rows.includes(anchor) ? anchor : open);
    const to = rows.indexOf(key);
    const range = from < 0 || to < 0 ? [key] : rows.slice(Math.min(from, to), Math.max(from, to) + 1);
    selection.value = new Set(add ? [...selection.value, ...range] : range);
    if (from < 0) anchor = key;
    return true;
  }
  if (add) {
    const next = new Set(selection.value);
    // The open note looks selected, so a selection that starts now includes it.
    if (!next.size && open && open !== key && shownKeys().includes(open)) next.add(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selection.value = next;
    anchor = key;
    return true;
  }
  clearSidebarSelection();
  anchor = key;
  return false;
}

/** Right-click on one of several selected rows: a menu for all of them. False when it isn't one. */
function selectionMenu(e, key) {
  const items = selectedItems();
  if (!selection.value.has(key) || items.shown < 2) { clearSidebarSelection(); return false; }
  const what = itemsLabel(items);
  openMenu(e.clientX, e.clientY, [
    { title: `${items.shown} selected` },
    { label: `Cut ${what}`, icon: 'scissors', hint: 'Ctrl+X', run: () => { clipItems('cut', items); clearSidebarSelection(); } },
    { label: `Copy ${what}`, icon: 'copy', hint: 'Ctrl+C', run: () => { clipItems('copy', items); clearSidebarSelection(); } },
    { label: `Duplicate ${what}`, icon: 'copy-plus', run: async () => { await copyItems(items, null, { duplicate: true }); clearSidebarSelection(); } },
    { label: `Move ${what} to…`, icon: 'move', run: async () => { await moveItems(items); clearSidebarSelection(); } },
    { label: `Copy ${what} to…`, icon: 'copy-to', run: async () => { await copyItems(items); clearSidebarSelection(); } },
    { sep: true },
    { label: `Delete ${what}…`, icon: 'trash', danger: true, hint: 'Del', run: async () => { if (await deleteItems(items)) clearSidebarSelection(); } },
  ]);
  return true;
}

/** Cut rows look faded until they are pasted. */
function isCut(key) {
  const c = sidebarClip.value;
  if (!c || c.mode !== 'cut') return false;
  if (key.startsWith('n:')) return c.notes.includes(key.slice(2));
  const i = key.indexOf('|');
  return c.folders.some((f) => f.wsId === key.slice(2, i) && f.path === key.slice(i + 1));
}

/** Where Ctrl+V pastes: into the folder clicked last, the folder of the note clicked last, or the top level. */
function pasteTarget() {
  if (anchor && anchor.startsWith('f:') && shownKeys().includes(anchor)) {
    const i = anchor.indexOf('|');
    return { wsId: anchor.slice(2, i), folder: anchor.slice(i + 1) };
  }
  const n = anchor && anchor.startsWith('n:') ? findNote(anchor.slice(2)) : null;
  if (n && n.wsId === activeWsId.value) return { wsId: n.wsId, folder: n.folder || '' };
  return { wsId: activeWsId.value, folder: '' };
}

// The rows a multi-row drag carries (drag data can't be read while hovering, only on drop).
let dragItems = null;
// The note a one-note drag from the sidebar carries.
let dragNote = null;

/** Something dragged that can go to the top level (outside every folder): true when it was accepted. */
function topLevelOver(e) {
  const t = e.dataTransfer.types;
  let ok = false;
  if (t.includes('application/x-mn-items')) ok = !!dragItems && (dragItems.notes.some((n) => n.folder) || dragItems.folders.some((f) => f.path.includes('/')));
  else if (t.includes('application/x-mn-folder')) ok = !!dragFolder && dragFolder.includes('/');
  else if (t.includes('application/x-mn-note')) { const n = dragNote && findNote(dragNote); ok = !n || !!n.folder; }
  if (ok) e.preventDefault();
  return ok;
}

/** A drop at the top level of the workspace: notes and folders leave their folders. */
function topLevelDrop(e, ws) {
  const many = droppedItems(e);
  const f = e.dataTransfer.getData('application/x-mn-folder');
  const p = e.dataTransfer.getData('application/x-mn-note');
  dragItems = null;
  dragNote = null;
  if (!many && !f && !p) return;
  e.preventDefault();
  clearSidebarSelection();
  if (many) moveItems(many, { wsId: ws.id, folder: '' });
  else if (f) moveFolder(ws.id, f, '');
  else {
    const n = findNote(p);
    if (n && (n.folder || n.wsId !== ws.id)) moveNote(n, { wsId: ws.id, folder: '' });
  }
}

/** Dragging one of several selected rows takes all of them: true when it did. */
function startMultiDrag(e, key) {
  if (!selection.value.has(key)) return false;
  const items = selectedItems();
  if (items.notes.length + items.folders.length < 2) return false;
  dragItems = items;
  e.dataTransfer.setData('application/x-mn-items', JSON.stringify({ notes: items.notes.map((n) => n.path), folders: items.folders }));
  e.dataTransfer.effectAllowed = 'move';
  dragBadge(e, itemsLabel(items));
  return true;
}

/** What a multi-row drag dropped: {notes, folders}. */
function droppedItems(e) {
  try {
    const d = JSON.parse(e.dataTransfer.getData('application/x-mn-items') || 'null');
    if (!d) return null;
    return { notes: (d.notes || []).map((p) => findNote(p)).filter(Boolean), folders: d.folders || [] };
  } catch { return null; }
}

/** "3 notes" under the pointer while several notes are dragged. */
function dragBadge(e, text) {
  const b = document.createElement('div');
  b.className = 'drag-badge';
  b.textContent = text;
  document.body.appendChild(b);
  e.dataTransfer.setDragImage(b, -10, -6);
  setTimeout(() => b.remove(), 0);
}

/** True while a transcription is being written into this note. */
export function recordingInto(path) {
  const r = recorder.value;
  return r.target === path && (r.state === 'running' || r.state === 'finishing');
}

function NoteRow({ note, active, depth }) {
  const dirty = (tabsByWs.value[activeWsId.value] || []).some((t) => t.key === note.path && t.dirty);
  const key = noteKey(note.path);
  const selected = selection.value.has(key);
  return (
    <div class={'row note-row' + (active ? ' active' : '') + (selected ? ' selected' : '') + (isCut(key) ? ' cut' : '')} data-path={note.path} draggable
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      title={`${note.title}\nEdited ${fullDate(note.mtime)}`}
      onDragStart={(e) => {
        // Dragging one of several selected rows takes all of them (onto a folder).
        if (startMultiDrag(e, key)) return;
        clearSidebarSelection();
        dragNote = note.path;
        e.dataTransfer.setData('application/x-mn-note', note.path);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => { dragItems = null; dragNote = null; }}
      onClick={(e) => { if (!selectClick(e, key)) openNote(note.path); }}
      onContextMenu={(e) => { e.preventDefault(); if (!selectionMenu(e, key)) noteMenu(note, e.clientX, e.clientY); }}>
      {recordingInto(note.path) ? <span class="rec-dot" title="Transcribing into this note" />
        : KIND_ICON[note.kind] ? <Icon name={KIND_ICON[note.kind]} size={13} class="row-kind" />
          : <span class="note-dot" style={{ background: note.color || 'transparent', borderColor: note.color || undefined }} />}
      <span class="row-label">{note.title}</span>
      {note.pinned ? <Icon name="pin" size={12} class="row-pin" /> : null}
      {dirty ? <span class="row-dirty" /> : <span class="row-meta">{relTime(note.mtime)}</span>}
    </div>
  );
}

const PAGE = 150;

function NotesList({ notes, depth }) {
  const [limit, setLimit] = useState(PAGE);
  const active = activeKey.value;
  const editor = mainView.value.kind === 'editor';
  const sorted = sortNotes(notes, settings.value.sidebarSort);
  return (
    <>
      {sorted.slice(0, limit).map((n) => <NoteRow key={n.path} note={n} depth={depth} active={editor && n.path === active} />)}
      {sorted.length > limit ? (
        <button class="row more-row" style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => setLimit(limit + PAGE * 4)}>
          Show {Math.min(sorted.length - limit, PAGE * 4)} more…
        </button>
      ) : null}
    </>
  );
}

// The folder being dragged (drag data can't be read while hovering, only on drop).
let dragFolder = null;

/** Where a folder dropped on a row goes: the middle puts it inside, the top/bottom edge before/after. */
function zoneOf(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  return y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
}

function FolderRow({ ws, node, depth, siblings }) {
  const st = wsState(ws.id);
  const expanded = !!(st.expanded && st.expanded[node.path]);
  const [, force] = useState(0);
  const [drop, setDrop] = useState(null); // 'before' | 'after' | 'inside' while something is dragged over
  const view = mainView.value;
  const selected = view.kind === 'folder' && view.folder === node.path;
  const active = activeKey.value;
  const containsActive = !expanded && active && active.toLowerCase().startsWith(`${ws.dir}/${node.path}/`.toLowerCase());
  const folder = node.meta || { path: node.path, name: node.name };
  const key = folderKey(ws.id, node.path);

  const toggle = () => {
    const s = wsState(ws.id);
    s.expanded = { ...(s.expanded || {}), [node.path]: !(s.expanded && s.expanded[node.path]) };
    s.lastFolder = node.path;
    saveState();
    force((x) => x + 1);
  };
  const openCards = (e) => {
    e.stopPropagation();
    mainView.value = { kind: 'folder', folder: node.path };
    wsState(ws.id).lastFolder = node.path;
    saveState();
  };

  return (
    <div class="folder">
      <div class={'row folder-row' + (selected ? ' active' : '') + (selection.value.has(key) ? ' selected' : '') + (isCut(key) ? ' cut' : '') + (drop ? ` drop-${drop}` : '') + (containsActive ? ' has-active' : '')}
        data-folder={node.path} data-ws={ws.id}
        style={{ paddingLeft: `${4 + depth * 14}px` }}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          if (startMultiDrag(e, key)) return;
          clearSidebarSelection();
          dragFolder = node.path;
          e.dataTransfer.setData('application/x-mn-folder', node.path);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => { dragFolder = null; dragItems = null; }}
        onDragOver={(e) => {
          const t = e.dataTransfer.types;
          if (t.includes('application/x-mn-items')) {
            // Several rows: into this folder, not into one of them (or below one).
            if (dragItems && dragItems.folders.some((f) => f.wsId === ws.id && inFolder(node.path, f.path))) return;
            e.preventDefault();
            e.stopPropagation();
            if (drop !== 'inside') setDrop('inside');
          } else if (t.includes('application/x-mn-folder')) {
            // Middle of the row: put the folder inside. Top/bottom edge: place it before/after (reorder).
            if (dragFolder && (dragFolder === node.path || node.path.toLowerCase().startsWith(dragFolder.toLowerCase() + '/'))) return;
            e.preventDefault();
            e.stopPropagation();
            const where = zoneOf(e);
            if (where !== drop) setDrop(where);
          } else if (t.includes('application/x-mn-note') || t.includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            if (drop !== 'inside') setDrop('inside');
          }
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const where = zoneOf(e);
          setDrop(null);
          const path = e.dataTransfer.getData('application/x-mn-note');
          const f = e.dataTransfer.getData('application/x-mn-folder');
          const many = droppedItems(e);
          if (many) {
            clearSidebarSelection();
            moveItems(many, { wsId: ws.id, folder: node.path });
          } else if (path) {
            const n = findNote(path);
            if (n && (n.folder !== node.path || n.wsId !== ws.id)) moveNote(n, { wsId: ws.id, folder: node.path });
          } else if (f && f !== node.path) {
            if (where === 'inside') {
              await moveFolder(ws.id, f, node.path);
              return;
            }
            // Before/after this row: the folder joins this row's level (moving there first if needed).
            const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
            const moved = await moveFolder(ws.id, f, parent);
            if (!moved) return;
            const names = (siblings || []).map((s) => s.path).filter((p) => p !== f && p !== moved);
            const at = names.indexOf(node.path);
            names.splice(at < 0 ? names.length : where === 'after' ? at + 1 : at, 0, moved);
            const st2 = wsState(ws.id);
            if (st2.folderSort && st2.folderSort !== 'custom') { st2.folderSort = 'custom'; saveState(); bump.value++; }
            reorderFolders(ws.id, names);
          } else if (e.dataTransfer.files.length) {
            const paths = await api.dropFiles([...e.dataTransfer.files]);
            const imported = await api.call('note.import', { paths, wsId: ws.id, folder: node.path });
            imported.forEach(upsertNote);
            refreshNoteCounts(ws.id);
            toast(`Imported ${imported.length} file${imported.length === 1 ? '' : 's'} into ${node.name}`, 'success');
          }
        }}
        onClick={(e) => { if (!selectClick(e, key)) toggle(); }}
        onContextMenu={(e) => { e.preventDefault(); if (!selectionMenu(e, key)) folderMenu(ws.id, folder, e.clientX, e.clientY); }}>
        <span class={'row-chevron' + (expanded ? ' open' : '')}><Icon name="chevron-right" size={14} /></span>
        <FolderGlyph icon={folder.icon} open={expanded} style={{ color: folder.color || undefined }} />
        <span class="row-label">{node.name}</span>
        <span class="row-count">{node.total}</span>
        <button class="row-add" title="Show as cards" onClick={openCards}><Icon name="grid" size={13} /></button>
        <button class="row-add" title="New note in this folder" onClick={(e) => { e.stopPropagation(); newNote({ wsId: ws.id, folder: node.path }); }}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {expanded ? (
        <div class="folder-children">
          {node.children.map((c) => <FolderRow key={c.path} ws={ws} node={c} depth={depth + 1} siblings={node.children} />)}
          {node.notes.length ? <NotesList notes={node.notes} depth={depth + 1} /> : null}
          {!node.notes.length && !node.children.length ? <div class="row empty-row" style={{ paddingLeft: `${22 + depth * 14}px` }}>Empty folder</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function newMenu(e, ws) {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.right, r.bottom + 4, [
    { label: 'Note', icon: 'file-text', hint: 'Ctrl+N', run: () => newNote({ wsId: ws.id }) },
    { label: 'Kanban board', icon: 'kanban', run: () => newKanban({ wsId: ws.id }) },
    { label: 'Canvas', icon: 'canvas', run: () => newCanvas({ wsId: ws.id }) },
    { sep: true },
    { label: 'Folder…', icon: 'folder-plus', run: () => createFolder(ws.id) },
  ], { anchorRight: true });
}

export function Sidebar() {
  const ws = activeWs.value;
  const notes = currentNotes.value;
  const view = mainView.value;
  const [catOpen, setCatOpen] = useState(true);
  const [bannerHover, setBannerHover] = useState(false);
  const [rootDrop, setRootDrop] = useState(false);
  const [spaceDrop, setSpaceDrop] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        clearSidebarSelection();
        // Esc also calls off a cut (like Explorer), unless it is closing a menu or a dialog.
        if (sidebarClip.value && sidebarClip.value.mode === 'cut' && !document.querySelector('.menu, .modal-layer')) sidebarClip.value = null;
      }
      // Ctrl+X / Ctrl+C / Ctrl+V on sidebar rows, unless the keys belong to something else (an editor, a field, a canvas).
      const k = e.key.length === 1 ? e.key.toLowerCase() : '';
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (k === 'x' || k === 'c' || k === 'v')) {
        const a = document.activeElement;
        if (a && a !== document.body && !a.closest('.sidebar')) return;
        if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
        if (k === 'v') {
          if (!sidebarClip.value) return;
          e.preventDefault();
          const t = pasteTarget();
          pasteInto(t.wsId, t.folder).then(clearSidebarSelection);
          return;
        }
        const items = selectedItems();
        if (!items.notes.length && !items.folders.length) return;
        e.preventDefault();
        clipItems(k === 'x' ? 'cut' : 'copy', items);
        clearSidebarSelection();
        return;
      }
      // Delete: the selected rows, unless the keys are going somewhere else (an editor, a field).
      if (e.key === 'Delete' && !e.repeat && selection.value.size) {
        const a = document.activeElement;
        if (a && a !== document.body && !a.closest('.sidebar')) return;
        const items = selectedItems();
        if (!items.notes.length && !items.folders.length) return;
        e.preventDefault();
        deleteItems(items).then((done) => { if (done) clearSidebarSelection(); });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ws) {
    return (
      <aside class="sidebar">
        <header class="sidebar-header"><span class="ws-name">MarkNotes</span></header>
        <div class="sidebar-scroll sidebar-empty">
          <p>Create your first workspace to start writing.</p>
          <button class="btn primary" onClick={createWorkspace}>Create a workspace</button>
          {document.documentElement.classList.contains('mobile') ? null : <button class="btn ghost" onClick={(e) => importMenu(e.currentTarget)}>Open or import…</button>}
        </div>
        <RecorderPanel />
      </aside>
    );
  }

  bump.value; // eslint-disable-line no-unused-expressions
  const tree = buildTree(ws, notes, wsState(ws.id).folderSort || 'custom');
  const header = (
    <header class={'sidebar-header' + (ws.bannerUrl ? ' over-banner' : '')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); workspaceMenu(ws, r.left + 8, r.bottom + 4); }}>
      {ws.linked ? <Icon name={ws.vault ? 'vault' : 'link'} size={15} class="ws-linked" title={ws.root} /> : null}
      <span class="ws-name">{ws.name}</span>
      <Icon name="chevron-down" size={18} />
    </header>
  );

  return (
    <aside class="sidebar">
      {ws.bannerUrl ? (
        <div class="sb-banner" onMouseEnter={() => setBannerHover(true)} onMouseLeave={() => setBannerHover(false)}
          onContextMenu={(e) => { e.preventDefault(); workspaceMenu(ws, e.clientX, e.clientY); }}>
          <AnimatedImage src={ws.bannerUrl} playing={!ws.bannerHover || bannerHover} class="sb-banner-img" />
          {header}
        </div>
      ) : header}
      <div class={'sidebar-scroll' + (spaceDrop ? ' drop-top' : '')} onClick={(e) => { if (e.target === e.currentTarget) clearSidebarSelection(); }}
        onContextMenu={(e) => { if (e.target !== e.currentTarget) return; e.preventDefault(); rootMenu(ws, e.clientX, e.clientY); }}
        onDragOver={(e) => {
          // The empty space under the tree is the top level too.
          const here = e.target === e.currentTarget && topLevelOver(e);
          if (here !== spaceDrop) setSpaceDrop(here);
        }}
        onDragLeave={(e) => { if (e.target === e.currentTarget) setSpaceDrop(false); }}
        onDrop={(e) => { setSpaceDrop(false); if (e.target === e.currentTarget) topLevelDrop(e, ws); }}>
        <button class="sb-search" onClick={() => { mainView.value = { kind: 'search', q: view.q || '' }; }}>
          <Icon name="search" size={15} />
          <span>Search notes</span>
        </button>
        <div class="row nav-row" onClick={() => newNote()}>
          <Icon name="file-plus" size={18} /><span class="row-label">New note</span><kbd>Ctrl+N</kbd>
          <button class="row-add always" title="New kanban board, canvas or folder" onClick={(e) => newMenu(e, ws)}><Icon name="chevron-down" size={14} /></button>
        </div>
        <div class={'row nav-row' + (view.kind === 'all' ? ' active' : '')} onClick={() => { mainView.value = { kind: 'all' }; }}>
          <Icon name="grid" size={18} /><span class="row-label">All notes</span><span class="row-count">{notes.length}</span>
        </div>
        <div class={'row nav-row' + (view.kind === 'recent' ? ' active' : '')} onClick={() => { mainView.value = { kind: 'recent' }; }}>
          <Icon name="clock" size={18} /><span class="row-label">Recent</span>
        </div>
        {ws.guideOn || ws.browseOn ? <div class="sb-sep" /> : null}
        {ws.guideOn ? (
          <div class={'row nav-row' + (view.kind === 'guide' ? ' active' : '')} onClick={() => { mainView.value = { kind: 'guide' }; }}
            onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [{ label: 'Remove Workspace Guide', icon: 'x', run: () => setWorkspaceFeature(ws, 'guide', false) }]); }}>
            <Icon name="signpost" size={18} /><span class="row-label">Workspace Guide</span>
          </div>
        ) : null}
        {ws.browseOn ? (
          <div class={'row nav-row' + (view.kind === 'browse' ? ' active' : '')} onClick={() => { mainView.value = { kind: 'browse' }; }}
            onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, [{ label: 'Remove Browse Folders', icon: 'x', run: () => setWorkspaceFeature(ws, 'browse', false) }]); }}>
            <Icon name="list-search" size={18} /><span class="row-label">Browse Folders</span>
          </div>
        ) : null}

        <div class={'sb-category' + (rootDrop ? ' drop' : '')}
          onDragOver={(e) => { if (topLevelOver(e)) setRootDrop(true); }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={(e) => { setRootDrop(false); topLevelDrop(e, ws); }}
          onContextMenu={(e) => { e.preventDefault(); rootMenu(ws, e.clientX, e.clientY); }}
          title="Drop folders or notes here to move them to the top level">
          <button class="cat-toggle" onClick={() => setCatOpen(!catOpen)}>
            <Icon name={catOpen ? 'chevron-down' : 'chevron-right'} size={12} /> FOLDERS
          </button>
          <span class="cat-tools">
            <button class="cat-add" onClick={(e) => sortMenu(e, ws)} {...tipProps('Sort folders and notes', 'below')}>
              <Icon name="sort" size={15} />
            </button>
            <button class="cat-add" onClick={() => createFolder(ws.id)} {...tipProps('Create folder', 'below')}>
              <Icon name="plus" size={16} />
            </button>
          </span>
        </div>
        {catOpen ? (
          <>
            {tree.children.map((c) => <FolderRow key={c.path} ws={ws} node={c} depth={0} siblings={tree.children} />)}
            {tree.notes.length ? <NotesList notes={tree.notes} depth={0} /> : null}
            {ws.folders.length === 0 && !tree.notes.length ? (
              <button class="row add-folder-row" onClick={() => createFolder(ws.id)}>
                <Icon name="folder-plus" size={16} /> <span class="row-label">Create a folder</span>
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <RecorderPanel />
    </aside>
  );
}

/** Opens the folders above a note in the sidebar and points at it (a canvas card's "Reveal file in navigation"). */
export function revealInSidebar(path) {
  const n = findNote(path);
  if (!n) return;
  if (ui.value.sidebarCollapsed) toggleSidebar();
  const st = wsState(n.wsId);
  const exp = { ...(st.expanded || {}) };
  let acc = '';
  for (const part of (n.folder || '').split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${part}` : part;
    exp[acc] = true;
  }
  st.expanded = exp;
  saveState();
  bump.value++;
  setTimeout(() => {
    const row = [...document.querySelectorAll('.sidebar .note-row')].find((r) => r.dataset.path === path);
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth; // eslint-disable-line no-void
    row.classList.add('flash');
  }, 80);
}

export function toggleSidebar() {
  ui.value = { ...ui.value, sidebarCollapsed: !ui.value.sidebarCollapsed };
  saveState();
}

export { openSettings };
