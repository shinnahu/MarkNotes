import { useEffect, useRef, useState } from 'preact/hooks';
import {
  mainView, activeKey, activeTab, activeWs, settings, editorInfo, findNote, setSetting, hostInfo, persisted,
  currentNotes, toast, redoKeyLabel,
} from '../store.js';
import * as ed from '../editor/editor.js';
import {
  toggleWrap, cycleHeading, insertCodeBlock, insertLink, toggleLinePrefix, insertBlock, insertTable,
} from '../editor/commands.js';
import { insertImageFiles } from '../editor/paste.js';
import {
  newNote, closeTab, openNote, saveDoc, docs, isDirty, openPath, editorReady, pickCover, removeCover, hasCover,
  newKanban, newCanvas, isBoardTab, setTabAsText,
} from '../docs.js';
import { renameNote, moveNote, deleteNote, setNoteColor, togglePin, saveCopyAs, saveAsPdf, canSavePdf, importExternal, createFolder } from '../actions.js';
import { TabBar } from './TabBar.jsx';
import { mobile, MobileBar } from './Mobile.jsx';
import { syncState, addPc } from './PhoneSync.jsx';
import { GridView } from './GridView.jsx';
import { SearchView } from './SearchView.jsx';
import { Icon, Logo } from './icons.jsx';
import { FolderGlyph } from './FolderGlyph.jsx';
import { openMenu } from './menu.jsx';
import { tipProps } from './Toasts.jsx';
import { openQuickSwitcher } from './QuickSwitcher.jsx';
import { Avatar, gifPlays } from './dialogs.jsx';
import * as api from '../api.js';
import { relTime, fullDate, basename } from '../util.js';

function ToolBtn({ icon, tip, run, active }) {
  return (
    <button class={'tool' + (active ? ' on' : '')} onMouseDown={(e) => e.preventDefault()} onClick={run} {...tipProps(tip, 'below')}>
      <Icon name={icon} size={17} />
    </button>
  );
}

/** Commands for the open canvas board (boards/canvas.js listens). */
function canvasAction(key, action) {
  window.dispatchEvent(new CustomEvent('mn-canvas', { detail: { key, action } }));
}

function withView(fn) {
  return () => {
    const v = ed.getView();
    if (v) fn(v);
  };
}

/** The open note's ⋯ menu (note header on the PC, top bar on the phone). */
function openNoteMenu(x, y) {
  const tab = activeTab.value;
  if (!tab) return;
  const note = findNote(tab.key);
  const boardKind = tab.kind === 'kanban' || tab.kind === 'canvas' ? tab.kind : null;
  const board = isBoardTab(tab);
  const isMd = !board && (tab.ext === 'md' || tab.ext === 'markdown' || settings.value.txtAsMarkdown);
  const coverable = isMd && !boardKind && tab.ext !== 'txt' && docs.get(tab.key)?.loaded;
  const phone = mobile.value;
  {
    const s = settings.value;
    const cover = coverable && hasCover(tab.key);
    openMenu(x, y, [
      boardKind && { label: board ? 'Edit as text' : `Show as ${boardKind === 'kanban' ? 'board' : 'canvas'}`, icon: board ? 'code' : boardKind, run: () => setTabAsText(tab.key, board) },
      boardKind === 'canvas' && board && { label: 'Reload link previews', icon: 'refresh', run: () => canvasAction(tab.key, 'reloadPreviews') },
      boardKind === 'canvas' && board && { label: 'Read-only', icon: 'lock', checked: !!(persisted.canvasReadOnly && persisted.canvasReadOnly[tab.key]), run: () => canvasAction(tab.key, 'toggleReadOnly') },
      !board && { label: 'Find', icon: 'search', hint: 'Ctrl+F', run: withView((v) => ed.openSearchPanel(v)) },
      !board && { label: 'Find & replace', icon: 'refresh', hint: 'Ctrl+H', run: withView((v) => ed.openSearchPanel(v)) },
      coverable && { sep: true },
      coverable && { label: cover ? 'Change cover image…' : 'Add cover image…', icon: 'image', run: () => pickCover(tab.key) },
      cover && { label: 'Remove cover', icon: 'x', run: () => removeCover(tab.key) },
      { sep: true },
      note && { label: 'Rename…', icon: 'pencil', hint: 'F2', run: () => renameNote(note) },
      note && { label: 'Move to…', icon: 'move', run: () => moveNote(note) },
      note && { label: note.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', run: () => togglePin(note) },
      note && { swatches: true, value: note.color, onPick: (c) => setNoteColor(note, c) },
      !note && !phone && { label: 'Copy into my notes…', icon: 'download', run: () => importExternal(tab.key) },
      !phone && { label: 'Save a copy as…', icon: 'save', run: () => saveCopyAs(tab.key) },
      !phone && canSavePdf(tab.key) && { label: 'Save as PDF…', icon: 'file-down', run: () => saveAsPdf(tab.key) },
      !phone && { label: 'Show in Explorer', icon: 'folder', run: () => api.call('app.reveal', { path: tab.key }) },
      !board && { sep: true },
      !board && { label: 'Word wrap', checked: s.wordWrap, run: () => setSetting('wordWrap', !s.wordWrap) },
      !board && { label: 'Line numbers', checked: s.lineNumbers, run: () => setSetting('lineNumbers', !s.lineNumbers) },
      !board && { label: 'Live preview (hide markdown symbols)', checked: s.livePreview, run: () => setSetting('livePreview', !s.livePreview) },
      !board && { label: 'Code windows', checked: s.codeWindows, run: () => setSetting('codeWindows', !s.codeWindows) },
      note && { sep: true },
      note && { label: 'Delete note', icon: 'trash', danger: true, run: () => deleteNote(note) },
    ], { anchorRight: true, minWidth: 250 });
  }
}

function NoteHeader() {
  const tab = activeTab.value;
  const ws = activeWs.value;
  const imgInput = useRef(null);
  if (!tab) return null;
  const note = findNote(tab.key);
  const boardKind = tab.kind === 'kanban' || tab.kind === 'canvas' ? tab.kind : null;
  const board = isBoardTab(tab);
  const isMd = !board && (tab.ext === 'md' || tab.ext === 'markdown' || settings.value.txtAsMarkdown);
  const folderMeta = note && ws ? ws.folders.find((f) => f.path === note.folder) : null;
  const more = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openNoteMenu(r.right, r.bottom + 4);
  };

  return (
    <div class="note-header">
      <div class="crumbs">
        {note && ws ? (
          <>
            <span class="crumb-ws"><Avatar ws={ws} size={18} play={gifPlays(true, false)} /></span>
            <button class="crumb crumb-folder" onClick={() => { mainView.value = { kind: 'folder', folder: note.folder || '' }; }}
              title={note.folder ? `${note.folder.split('/').join(' › ')}\nShow this folder` : 'Show the notes of this workspace'}>
              <FolderGlyph icon={folderMeta && folderMeta.icon} size={14} style={{ color: folderMeta && folderMeta.color || undefined }} />
              {note.folder ? note.folder.split('/').pop() : ws.name}
            </button>
            <Icon name="chevron-right" size={14} class="crumb-sep" />
            <button class="crumb crumb-title" onClick={() => renameNote(note)} title="Rename (F2)">{tab.title}</button>
            <span class="crumb-meta" title={`Created ${fullDate(note.ctime)}\nEdited ${fullDate(note.mtime)}`}>edited {relTime(note.mtime)}</span>
          </>
        ) : (
          <>
            <Icon name="external" size={15} class="crumb-sep" />
            <span class="crumb crumb-title" title={tab.key}>{basename(tab.key)}</span>
            <span class="crumb-meta ext-path" title={tab.key}>{tab.key}</span>
            <button class="btn tiny ghost" onClick={() => importExternal(tab.key)}>Copy into my notes</button>
          </>
        )}
      </div>
      <div class="toolbar" role="toolbar">
        {boardKind ? (
          <div class="seg board-toggle">
            <button class={board ? 'on' : ''} onClick={() => setTabAsText(tab.key, false)} {...tipProps(boardKind === 'kanban' ? 'Board' : 'Canvas', 'below')}><Icon name={boardKind} size={15} /></button>
            <button class={board ? '' : 'on'} onClick={() => setTabAsText(tab.key, true)} {...tipProps('Edit as text', 'below')}><Icon name="code" size={15} /></button>
          </div>
        ) : null}
        {isMd ? (
          <>
            {boardKind ? <span class="tool-sep" /> : null}
            <ToolBtn icon="heading" tip="Heading (Ctrl+1/2/3)" run={withView((v) => cycleHeading(v))} />
            <ToolBtn icon="bold" tip="Bold (Ctrl+B)" run={withView((v) => toggleWrap(v, '**'))} />
            <ToolBtn icon="italic" tip="Italic (Ctrl+I)" run={withView((v) => toggleWrap(v, '*'))} />
            <ToolBtn icon="strike" tip="Strikethrough (Ctrl+Shift+X)" run={withView((v) => toggleWrap(v, '~~'))} />
            <span class="tool-sep" />
            <ToolBtn icon="list" tip="Bullet list" run={withView((v) => toggleLinePrefix(v, 'bullet'))} />
            <ToolBtn icon="list-ordered" tip="Numbered list" run={withView((v) => toggleLinePrefix(v, 'number'))} />
            <ToolBtn icon="list-check" tip="Checklist" run={withView((v) => toggleLinePrefix(v, 'task'))} />
            <ToolBtn icon="quote" tip="Quote" run={withView((v) => toggleLinePrefix(v, 'quote'))} />
            <span class="tool-sep" />
            <ToolBtn icon="code" tip="Code block (Ctrl+Shift+C)" run={withView((v) => insertCodeBlock(v))} />
            <ToolBtn icon="table" tip="Table" run={withView((v) => insertTable(v))} />
            <ToolBtn icon="link" tip="Link (Ctrl+Shift+K)" run={withView((v) => insertLink(v))} />
            <ToolBtn icon="image" tip="Insert image" run={() => imgInput.current && imgInput.current.click()} />
            <ToolBtn icon="hr" tip="Divider line" run={withView((v) => insertBlock(v, '---'))} />
            <input ref={imgInput} type="file" accept="image/*" multiple hidden onChange={(e) => {
              const files = [...(e.currentTarget.files || [])];
              e.currentTarget.value = '';
              const v = ed.getView();
              if (v && files.length) insertImageFiles(v, files);
            }} />
          </>
        ) : null}
        {boardKind || isMd ? <span class="tool-sep" /> : null}
        <ToolBtn icon="undo" tip="Undo (Ctrl+Z)" run={() => ed.editorUndo()} />
        <ToolBtn icon="redo" tip={`Redo (${redoKeyLabel()})`} run={() => ed.editorRedo()} />
        <button class="tool" onClick={more} {...tipProps('More', 'below')}><Icon name="more" size={18} /></button>
      </div>
    </div>
  );
}

function EmptyState() {
  const ws = activeWs.value;
  const recent = (persisted.recent || []).map((k) => findNote(k)).filter(Boolean).filter((n) => !ws || n.wsId === ws.id).slice(0, 6);
  return (
    <div class="empty-state">
      <Logo size={64} />
      <h2>{ws ? ws.name : 'MarkNotes'}</h2>
      <p class="muted">{mobile.value ? 'Open ☰ to pick a note, or make a new one.' : 'No tabs open. Your notes are safe in their folders.'}</p>
      <div class="empty-actions">
        <button class="btn primary" onClick={() => newNote()}><Icon name="file-plus" size={16} /> New note {mobile.value ? null : <kbd>Ctrl+N</kbd>}</button>
        <button class="btn" onClick={() => openQuickSwitcher()}><Icon name="search" size={16} /> Find a note {mobile.value ? null : <kbd>Ctrl+K</kbd>}</button>
        {mobile.value ? null : (
          <button class="btn" onClick={async () => { const files = await api.call('note.openDialog'); for (const f of files || []) await openPath(f); }}>
            <Icon name="file" size={16} /> Open file… <kbd>Ctrl+O</kbd>
          </button>
        )}
        {ws ? <button class="btn" onClick={() => { mainView.value = { kind: 'all' }; }}><Icon name="grid" size={16} /> Browse all notes</button> : null}
        {mobile.value && !(syncState.value?.pcs || []).length ? <button class="btn" onClick={() => addPc()}><Icon name="refresh" size={16} /> Sync with my PC…</button> : null}
      </div>
      {ws ? (
        <div class="empty-actions secondary">
          <button class="btn ghost small" onClick={() => newKanban()}><Icon name="kanban" size={15} /> New kanban board</button>
          <button class="btn ghost small" onClick={() => newCanvas()}><Icon name="canvas" size={15} /> New canvas</button>
        </div>
      ) : null}
      {recent.length ? (
        <div class="empty-recent">
          <div class="section-title">Recently opened</div>
          {recent.map((n) => (
            <button key={n.path} class="recent-item" onClick={() => openNote(n.path)}>
              <Icon name="file-text" size={15} /> <span>{n.title}</span> <span class="muted small">{n.folder} · {relTime(n.mtime)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MissingNote({ tab }) {
  return (
    <div class="empty-state">
      <Icon name="alert" size={40} />
      <h2>This file is gone</h2>
      <p class="muted">“{tab.title}” was moved or deleted outside MarkNotes.</p>
      <div class="empty-actions">
        <button class="btn primary" onClick={() => closeTab(tab.key)}>Close tab</button>
      </div>
    </div>
  );
}

function StatusBar() {
  const info = editorInfo.value;
  const tab = activeTab.value;
  const view = mainView.value;
  const s = settings.value;
  if (!s.showStatusBar) return null;
  const doc = tab ? docs.get(tab.key) : null;
  let saveText = '';
  let saveCls = '';
  if (tab && view.kind === 'editor' && doc && doc.loaded) {
    if (doc.readOnly) { saveText = 'Read-only'; saveCls = 'warn'; }
    else if (tab.saving) { saveText = 'Saving…'; }
    else if (tab.dirty) { saveText = s.autosave ? 'Editing…' : 'Unsaved changes (Ctrl+S)'; saveCls = s.autosave ? '' : 'warn'; }
    else if (doc.lastSaved) { saveText = 'Saved'; saveCls = 'ok'; }
    else { saveText = 'Up to date'; }
  }
  return (
    <footer class="statusbar">
      <div class="sb-left">
        {saveText ? <span class={'sb-item save ' + saveCls}>{saveCls === 'ok' ? <Icon name="check" size={13} /> : null}{saveText}</span> : null}
        {tab && view.kind === 'editor' && doc && doc.loaded ? (
          <>
            {s.showWordCount ? <span class="sb-item">{info.words.toLocaleString()} words</span> : null}
            <span class="sb-item">{info.chars.toLocaleString()} chars</span>
            {info.selection ? <span class="sb-item">{info.selection} selected</span> : null}
          </>
        ) : null}
      </div>
      <div class="sb-right">
        {tab && view.kind === 'editor' && doc && doc.loaded ? (
          <>
            <span class="sb-item">Ln {info.line}, Col {info.col}</span>
            <button class="sb-item btnlike" onClick={() => setSetting('zoom', 100)} title="Zoom (Ctrl + / Ctrl − / Ctrl 0)">{s.zoom}%</button>
            <span class="sb-item">{(info.ext || 'md').toUpperCase()}</span>
            <span class="sb-item" title="Line endings are kept as the file had them">{info.eol === 'lf' ? 'LF' : info.eol === 'cr' ? 'CR' : 'CRLF'}</span>
            <span class="sb-item">{{ utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', ansi: 'ANSI' }[info.encoding] || 'UTF-8'}</span>
          </>
        ) : null}
      </div>
    </footer>
  );
}

// Board views are only downloaded when a kanban/canvas is opened (keeps startup light).
const BOARD_VIEWS = { kanban: () => import('./KanbanView.jsx'), canvas: () => import('./CanvasView.jsx') };
const boardViews = {};

// Workspace pages, also downloaded only when opened.
const PAGES = { guide: () => import('./GuideView.jsx'), browse: () => import('./BrowseFolders.jsx') };
const pages = {};

function PageHost({ kind }) {
  const [, setReady] = useState(0);
  useEffect(() => {
    if (pages[kind]) return undefined;
    let alive = true;
    PAGES[kind]().then((m) => { pages[kind] = m.default; if (alive) setReady((x) => x + 1); })
      .catch((e) => toast('Could not open the page: ' + e.message, 'error'));
    return () => { alive = false; };
  }, [kind]);
  const Page = pages[kind];
  return Page ? <Page /> : <div class="board-host loading" />;
}

function BoardHost({ tab }) {
  const kind = tab.kind;
  const [, setReady] = useState(0);
  useEffect(() => {
    if (boardViews[kind]) return undefined;
    let alive = true;
    BOARD_VIEWS[kind]()
      .then((m) => { boardViews[kind] = m.default; if (alive) setReady((x) => x + 1); })
      .catch((e) => toast('Could not open the board view: ' + e.message, 'error'));
    return () => { alive = false; };
  }, [kind]);
  const View = boardViews[kind];
  const doc = docs.get(tab.key);
  if (!View || !doc || !doc.loaded) return <div class="board-host loading" />;
  return <div class={'board-host ' + kind}><View key={tab.key} docKey={tab.key} /></div>;
}

export function Main() {
  const v = mainView.value;
  const key = activeKey.value;
  const tab = activeTab.value;
  const host = useRef(null);
  useEffect(() => {
    if (host.current) editorReady(host.current);
  }, []);
  const board = v.kind === 'editor' && tab && !tab.missing && isBoardTab(tab);
  const showEditor = v.kind === 'editor' && key && tab && !tab.missing && !board;
  return (
    <main class="main">
      {mobile.value ? <MobileBar onMore={(e) => { const r = e.currentTarget.getBoundingClientRect(); openNoteMenu(r.right, r.bottom + 4); }} /> : <TabBar />}
      {v.kind === 'editor' && tab && !tab.missing ? <NoteHeader /> : null}
      <div class="main-body">
        <div class={'editor-host' + (settings.value.readableWidth ? ' readable' : '')} ref={host} style={{ display: showEditor ? '' : 'none' }} />
        {board ? <BoardHost tab={tab} /> : null}
        {v.kind === 'editor' && !key ? <EmptyState /> : null}
        {v.kind === 'editor' && tab && tab.missing ? <MissingNote tab={tab} /> : null}
        {v.kind === 'folder' || v.kind === 'all' || v.kind === 'recent' ? <GridView /> : null}
        {v.kind === 'search' ? <SearchView /> : null}
        {v.kind === 'guide' || v.kind === 'browse' ? <PageHost kind={v.kind} /> : null}
      </div>
      <StatusBar />
    </main>
  );
}
