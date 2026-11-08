// One CodeMirror view; every open tab keeps its own EditorState (text, undo history,
// selection), swapped in when the tab is shown.

import {
  EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars, rectangularSelection,
  crosshairCursor, lineNumbers, placeholder,
} from '@codemirror/view';
import { EditorState, Compartment, Facet, Annotation } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap, undo, redo, selectAll } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, indentUnit } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, setSearchQuery, SearchQuery, findNext } from '@codemirror/search';
import { appHighlight } from './highlight.js';
import { livePreview, plainLinks, linkClicks, previewHooks, refreshPreview } from './livepreview.js';
import { Frontmatter, WikiLinks } from './mdext.js';
import { frontmatterField, bodyStart } from './frontmatter.js';
import { tableField } from './tables.js';
import { linkCardField } from './linkcards.js';
import { codeBlocks, codeBlockStore } from './codeblocks.js';
import { smartPaste, pasteHooks } from './paste.js';
import { toggleWrap, cycleHeading, insertCodeBlock, insertLink, smartTab, smartUntab, insertDateTime, toggleLinePrefix } from './commands.js';
import { htmlBlocks } from './htmlblocks.js';

/** Marks programmatic changes that must not count as the user's edits (none today, kept for reloads). */
export const Reload = Annotation.define();

/** Mutable reference to the note a state belongs to ({key, kind}); updated when a note is renamed. */
export const docRef = Facet.define({ combine: (v) => v[0] || { key: '', kind: 'md' } });

const wrapC = new Compartment();
const numbersC = new Compartment();
const spellC = new Compartment();
const readOnlyC = new Compartment();
const previewC = new Compartment();

let view = null;
let app = null;
let configVersion = 0;
const stateVersion = new WeakMap();

const appKeymap = [
  { key: 'Mod-b', run: (v) => toggleWrap(v, '**') },
  { key: 'Mod-i', run: (v) => toggleWrap(v, '*') },
  { key: 'Mod-Shift-x', run: (v) => toggleWrap(v, '~~') },
  { key: 'Mod-e', run: (v) => toggleWrap(v, '`', 'code') },
  { key: 'Mod-Shift-c', run: (v) => insertCodeBlock(v) },
  { key: 'Mod-Shift-k', run: (v) => insertLink(v), preventDefault: true },
  { key: 'Mod-1', run: (v) => cycleHeading(v, 1) },
  { key: 'Mod-2', run: (v) => cycleHeading(v, 2) },
  { key: 'Mod-3', run: (v) => cycleHeading(v, 3) },
  { key: 'Mod-Shift-8', run: (v) => toggleLinePrefix(v, 'bullet') },
  { key: 'Mod-Shift-7', run: (v) => toggleLinePrefix(v, 'number') },
  { key: 'Mod-Shift-9', run: (v) => toggleLinePrefix(v, 'task') },
  { key: 'F5', run: (v) => insertDateTime(v), preventDefault: true },
  { key: 'Tab', run: smartTab, shift: smartUntab },
  // Redo: Ctrl+Shift+Z or Ctrl+Y, whichever is picked in Settings (main.jsx stops the other one before it gets here).
  { key: 'Mod-Shift-z', run: redo, preventDefault: true },
  { key: 'Mod-y', run: redo, preventDefault: true },
  { key: 'Mod-h', run: (v) => openSearchPanel(v), preventDefault: true },
  { key: 'Mod-a', run: selectAll },
];

function kindFor(ext) {
  const s = app.settings();
  if (ext === 'md' || ext === 'markdown') return 'md';
  return s.txtAsMarkdown ? 'md' : 'txt';
}

function previewExt(kind) {
  const s = app.settings();
  if (kind !== 'md') return [];
  return [s.livePreview ? [livePreview, frontmatterField, tableField, linkCardField] : [], s.codeWindows ? codeBlocks : []];
}

function previewHooksFor(ref) {
  return {
    noteKey: () => ref.key,
    openLink: (href) => app.openLink(href, ref.key),
    openWiki: (target, path) => app.openWiki(target, path, ref.key),
    imageMenu: (info) => app.imageMenu({ ...info, noteKey: ref.key }),
    bannerMenu: (info) => app.bannerMenu({ ...info, noteKey: ref.key }),
    linkMode: () => app.settings().linkClick,
    maxImage: () => app.settings().maxImageWidth,
    livePreview: () => app.settings().livePreview,
    resolveWiki: (target) => app.resolveWiki(ref.key, target),
    resolveImage: (target, wiki) => app.resolveImage(ref.key, target, wiki),
    noteTitle: () => app.noteTitle(ref.key),
  };
}

function pasteHooksFor(ref) {
  return {
    isMarkdown: () => ref.kind === 'md',
    autoCode: () => app.settings().autoCodeBlocks,
    saveImage: (data, name) => app.saveImage(ref.key, data, name),
    toast: (msg, kind, ms) => app.toast(msg, kind, ms),
    dropFiles: (files) => app.dropFiles(files),
    plainNext: app.plainNext,
  };
}

function extensions(ref, readOnly) {
  const s = app.settings();
  const md = ref.kind === 'md';
  return [
    docRef.of(ref),
    history({ minDepth: 2000, newGroupDelay: 700 }),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches({ minSelectionLength: 2, maxMatches: 300 }),
    search({ top: true }),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    syntaxHighlighting(appHighlight),
    wrapC.of(s.wordWrap ? EditorView.lineWrapping : []),
    numbersC.of(s.lineNumbers ? lineNumbers() : []),
    spellC.of(EditorView.contentAttributes.of({ spellcheck: s.spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' })),
    readOnlyC.of(EditorState.readOnly.of(!!readOnly)),
    placeholder('Start writing…'),
    keymap.of(appKeymap),
    md
      ? [markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [{ remove: ['IndentedCode'] }, Frontmatter, WikiLinks] }), previewC.of(previewExt('md'))]
      : [plainLinks, previewC.of([])],
    linkClicks,
    smartPaste,
    previewHooks.of(previewHooksFor(ref)),
    pasteHooks.of(pasteHooksFor(ref)),
    codeBlockStore.of({
      key: () => ref.key,
      get: (key, id) => app.codeState(key, id),
      set: (key, id, patch) => app.setCodeState(key, id, patch),
      defaults: () => ({ wrap: app.settings().codeWrapDefault, maxHeight: app.settings().codeMaxHeight, lineNumbers: app.settings().codeLineNumbers }),
      toast: (msg) => app.toast(msg, 'error'),
    }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.updateListener.of((u) => app.onUpdate(u)),
    EditorView.domEventHandlers({
      contextmenu(e, v) {
        // The phone: a long press on text is Android's own selection (Copy, Paste, Select all).
        if (e.defaultPrevented || document.documentElement.classList.contains('mobile')) return false;
        e.preventDefault();
        app.editorMenu(e, v, ref);
        return true;
      },
    }),
  ];
}

/**
 * A small live-preview editor for a canvas text card: its own text and undo history, the markdown look
 * of notes. opts: { parent, root (the canvas shadow root), doc, key (the canvas), renderHtml(html),
 * onDone(), onMenu(event, view) }.
 */
export function createCardEditor({ parent, root, doc, key, renderHtml, onDone, onMenu }) {
  const ref = { key, kind: 'md' };
  const s = app.settings();
  const done = () => { if (onDone) onDone(); return true; };
  return new EditorView({
    parent,
    root,
    state: EditorState.create({
      doc,
      extensions: [
        docRef.of(ref),
        history({ minDepth: 500, newGroupDelay: 700 }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        syntaxHighlighting(appHighlight),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: s.spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' }),
        placeholder('Write in markdown…'),
        keymap.of([{ key: 'Escape', run: done }, { key: 'Mod-Enter', run: done }]),
        keymap.of(appKeymap.filter((k) => k.key !== 'Mod-h')),
        markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [{ remove: ['IndentedCode'] }, Frontmatter, WikiLinks] }),
        s.livePreview ? [livePreview, tableField, renderHtml ? htmlBlocks(renderHtml) : []] : [],
        linkClicks,
        smartPaste,
        previewHooks.of(previewHooksFor(ref)),
        pasteHooks.of(pasteHooksFor(ref)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          contextmenu(e, v) {
            if (e.defaultPrevented) return false;
            e.preventDefault();
            if (onMenu) onMenu(e, v);
            return true;
          },
        }),
      ],
    }),
  });
}

export function initEditor(parent, hooks) {
  app = hooks;
  view = new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions: [EditorState.readOnly.of(true)] }),
  });
  // Cover banners span the whole editor width: expose the scroller and text-column widths.
  const measure = () => {
    const cs = getComputedStyle(view.contentDOM);
    const inner = view.contentDOM.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    view.dom.style.setProperty('--cm-w', `${view.scrollDOM.clientWidth}px`);
    view.dom.style.setProperty('--cm-c', `${Math.max(0, inner)}px`);
  };
  new ResizeObserver(measure).observe(view.scrollDOM);
  new ResizeObserver(measure).observe(view.contentDOM);
  measure();
  return view;
}

/** Re-renders decorations of the visible note (e.g. after the [[link]] index changed). */
export function refreshDecorations() {
  if (view && view.state.facet(docRef).key) view.dispatch({ effects: refreshPreview.of(null) });
}

export function getView() {
  return view;
}

/** Creates the state for a note's text. */
export function createState(key, ext, text, readOnly = false) {
  const ref = { key, kind: kindFor(ext) };
  // Start below the front matter so the properties stay folded.
  const start = ref.kind === 'md' ? Math.min(bodyStart(text), text.length) : 0;
  const state = EditorState.create({ doc: text, selection: { anchor: start }, extensions: extensions(ref, readOnly) });
  stateVersion.set(state, configVersion);
  return state;
}

export function refOf(state) {
  return state.facet(docRef);
}

function reconfigureEffects(state) {
  const s = app.settings();
  const ref = state.facet(docRef);
  return [
    wrapC.reconfigure(s.wordWrap ? EditorView.lineWrapping : []),
    numbersC.reconfigure(s.lineNumbers ? lineNumbers() : []),
    spellC.reconfigure(EditorView.contentAttributes.of({ spellcheck: s.spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' })),
    previewC.reconfigure(previewExt(ref.kind)),
  ];
}

/** Brings an inactive state up to date with the current settings. */
export function freshen(state) {
  if (stateVersion.get(state) === configVersion) return state;
  const next = state.update({ effects: reconfigureEffects(state) }).state;
  stateVersion.set(next, configVersion);
  return next;
}

/** Settings changed: reconfigure the visible editor; others update lazily. */
export function settingsChanged() {
  configVersion++;
  if (view && view.state.facet(docRef).key) {
    view.dispatch({ effects: reconfigureEffects(view.state) });
    stateVersion.set(view.state, configVersion);
  }
}

export function setReadOnly(readOnly) {
  if (view) view.dispatch({ effects: readOnlyC.reconfigure(EditorState.readOnly.of(readOnly)) });
}

/** Shows a state in the view and restores its scroll position. */
export function showState(state, scrollTop = 0) {
  state = freshen(state);
  view.setState(state);
  stateVersion.set(view.state, configVersion);
  requestAnimationFrame(() => {
    view.scrollDOM.scrollTop = scrollTop;
    requestAnimationFrame(() => { view.scrollDOM.scrollTop = scrollTop; });
  });
  return view.state;
}

export function clearView() {
  view.setState(EditorState.create({ doc: '', extensions: [EditorState.readOnly.of(true)] }));
}

export function focusEditor() {
  if (view) view.focus();
}

export function editorUndo() { return view && undo(view); }
export function editorRedo() { return view && redo(view); }

/** Highlights a search term after opening a note from search results. */
export function revealTerm(term) {
  if (!view || !term) return;
  const q = term.replace(/^"|"$/g, '').split(/\s+/)[0];
  if (!q) return;
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: q, caseSensitive: false })) });
  // Move to the first match without opening the panel.
  const text = view.state.doc.toString().toLowerCase();
  const i = text.indexOf(q.toLowerCase());
  if (i >= 0) view.dispatch({ selection: { anchor: i, head: i + q.length }, scrollIntoView: true });
  else findNext(view);
}

export { openSearchPanel };
