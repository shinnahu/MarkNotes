// Markdown tables in live preview: shown as real tables (cells wrap, like Obsidian) and edited in place. A click,
// or the caret arriving with the arrow keys, edits that cell right in the table (its markdown, e.g. **bold**, shows
// while it is edited); Tab / Enter / the arrows go from cell to cell, Esc leaves the table. The table's markdown
// shows only for "Edit table as text" (right-click), for a selection inside it (a search match) or with live
// preview off. Tables pasted from Excel / Google Sheets become markdown (tablemd.js).

import { StateField, StateEffect, Annotation } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { previewHooks, refreshPreview } from './livepreview.js';
import { openMenu } from '../ui/menu.jsx';
import { splitRow, alignOf, cellHtml, tableRows, toTsv, parseTable, formatTable, tableToHtml, plainCell } from './tablemd.js';
import { blockBox, onBlockBox } from './blockbox.js';

export { spreadsheetRows, rowsToMarkdown, parseTsv } from './tablemd.js';

/** A transaction that puts the caret in a table cell to edit it: {row, col, caret, selectAll} (all optional). */
export const editCell = Annotation.define();

/** "Edit table as text": the table ({from, to}) that shows its markdown while the caret stays in it. */
const showAsText = StateEffect.define();
const asTextField = StateField.define({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(showAsText)) return e.value;
    if (!v) return v;
    const from = tr.changes.mapPos(v.from, -1);
    const to = tr.changes.mapPos(v.to, 1);
    const s = tr.state.selection.main;
    return s.from >= from && s.to <= to ? { from, to } : null;
  },
});

// ── positions inside a table's text: rows are its lines (row 1 is the |---| line) ──

const toEdit = (src) => src.replace(/<br\s*\/?>/gi, '\n').replace(/\\\|/g, '|');
const fromEdit = (t) => t.replace(/\r/g, '').replace(/\n+$/, '').trim().replace(/\n/g, '<br>').replace(/\\?\|/g, (m) => (m === '|' ? '\\|' : m));

function lineStarts(lines) {
  const s = [];
  let o = 0;
  for (const l of lines) { s.push(o); o += l.length + 1; }
  return s;
}

/** Where the text of cell (row, col) is in the table's text. */
function cellAt(text, row, col) {
  const lines = text.split('\n');
  const starts = lineStarts(lines);
  const line = lines[row] || '';
  const c = splitRow(line)[col];
  if (c) return { from: starts[row] + c.from, len: c.text.length, missing: false };
  return { from: (starts[row] ?? text.length) + line.length, len: 0, missing: true };
}

/** The cell at an offset in the table's text, and the offset in that cell's text. */
function cellOf(text, off) {
  const lines = text.split('\n');
  const starts = lineStarts(lines);
  let row = lines.length - 1;
  while (row > 0 && starts[row] > off) row--;
  let inLine = off - starts[row];
  if (row === 1) { row = lines.length > 2 ? 2 : 0; inLine = 0; }
  const cells = splitRow(lines[row]);
  let col = 0;
  for (let i = 0; i < cells.length; i++) if (inLine >= cells[i].from - 1) col = i;
  const c = cells[col];
  return { row, col, offset: c ? Math.max(0, Math.min(c.text.length, inLine - c.from)) : 0 };
}

/** The table (whole lines) at a position, or null. */
function tableRange(state, pos) {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 5000), 50) || syntaxTree(state);
  let node = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Table') node = node.parent;
  if (!node) {
    node = tree.resolveInner(pos, -1);
    while (node && node.name !== 'Table') node = node.parent;
  }
  if (!node) return null;
  return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to };
}

function findWrap(view, from) {
  for (const w of view.contentDOM.querySelectorAll('.cm-md-table-wrap')) {
    try { if (view.posAtDOM(w) === from) return w; } catch { /* not in the document any more */ }
  }
  return null;
}

/** Puts the caret in cell (row, col) of the table at `from`; the editor plugin then edits that cell in place. */
function goToCell(view, from, row, col, opts = {}) {
  const range = tableRange(view.state, from);
  if (!range) return;
  const c = cellAt(view.state.sliceDoc(range.from, range.to), row, col);
  view.dispatch({ selection: { anchor: range.from + c.from }, annotations: editCell.of({ row, col, ...opts }), scrollIntoView: false });
}

// ── editing one cell ──

let active = null; // {view, wrap, td, row, col, src, orig, from (the table's position)}

function caretOffset(el) {
  const sel = el.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  const r = document.createRange();
  r.setStart(el, 0);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}

function placeCaret(el, offset, selectAll) {
  const sel = el.ownerDocument.getSelection();
  const r = document.createRange();
  const tn = el.firstChild;
  if (selectAll || !tn) {
    r.selectNodeContents(el);
    if (!selectAll) r.collapse(false);
  } else {
    r.setStart(tn, Math.min(offset, tn.length));
    r.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

function beginEdit(view, wrap, td, { caret = null, offset = 0, selectAll = false } = {}) {
  if (active && active.td === td) return;
  if (active) finishEdit();
  let from;
  try { from = view.posAtDOM(wrap); } catch { return; }
  const src = td._src || '';
  active = { view, wrap, td, row: +td.dataset.row, col: +td.dataset.col, src, orig: td.innerHTML, from };
  td.textContent = toEdit(src);
  td.contentEditable = 'plaintext-only';
  td.classList.add('editing');
  td.addEventListener('keydown', onCellKey);
  td.addEventListener('blur', onCellBlur);
  td.focus({ preventScroll: true });
  placeCaret(td, caret ?? toEdit(src.slice(0, offset)).length, selectAll);
}

function onCellBlur(e) {
  if (active && active.td === e.currentTarget) finishEdit();
}

/**
 * Writes the edited cell into the note and leaves it. to: the next cell {row, col, caret, selectAll}, a new row
 * {addRow, col}, or out of the table {exit: 'before' | 'after'}.
 */
function finishEdit({ to = null } = {}) {
  const a = active;
  if (!a) return;
  active = null;
  a.td.removeEventListener('keydown', onCellKey);
  a.td.removeEventListener('blur', onCellBlur);
  a.td.removeAttribute('contenteditable');
  a.td.classList.remove('editing');
  const text = fromEdit(a.td.innerText);
  if (text === a.src) a.td.innerHTML = a.orig;
  const { view } = a;
  const range = tableRange(view.state, a.from);
  if (!range || range.from !== a.from) return;
  const old = view.state.sliceDoc(range.from, range.to);
  let tableText = old;
  const changes = [];
  if (text !== a.src) {
    const c = cellAt(old, a.row, a.col);
    if (c.missing) {
      // A row shorter than the header: the whole row is written out.
      const t = parseTable(old);
      const cells = a.row === 0 ? t.head : t.body[a.row - 2];
      if (!cells) return;
      cells[a.col] = text;
      tableText = formatTable(t);
      changes.push({ from: range.from, to: range.to, insert: tableText });
    } else if (c.len === 0) {
      // An empty cell: the text goes between its pipes with one space on each side, "| text |".
      let s = c.from;
      while (s > 0 && old[s - 1] === ' ') s--;
      changes.push({ from: range.from + s, to: range.from + c.from, insert: ` ${text} ` });
      tableText = old.slice(0, s) + ` ${text} ` + old.slice(c.from);
    } else {
      if (old.slice(c.from, c.from + c.len) !== a.src) return; // changed meanwhile: keep what is there
      changes.push({ from: range.from + c.from, to: range.from + c.from + c.len, insert: text });
      tableText = old.slice(0, c.from) + text + old.slice(c.from + c.len);
    }
  }
  let selection;
  let ann = null;
  if (to && to.addRow) {
    const cols = splitRow(tableText.split('\n')[0]).length;
    const line = `\n|${'  |'.repeat(cols)}`;
    changes.push({ from: range.to, insert: line });
    tableText += line;
    to.row = tableText.split('\n').length - 1;
  }
  if (to && to.row != null) {
    const c = cellAt(tableText, to.row, to.col);
    selection = { anchor: range.from + c.from };
    ann = { row: to.row, col: to.col, caret: to.caret, selectAll: to.selectAll };
  } else if (to && to.exit === 'after') {
    const end = range.from + tableText.length;
    if (range.to < view.state.doc.length) selection = { anchor: end + 1 };
    else { changes.push({ from: range.to, insert: '\n' }); selection = { anchor: end + 1 }; }
  } else if (to && to.exit === 'before' && range.from > 0) selection = { anchor: range.from - 1 };
  if (changes.length || selection) {
    view.dispatch({ changes, selection, annotations: ann ? editCell.of(ann) : undefined, userEvent: 'input.table', scrollIntoView: !!(to && to.exit) });
  }
  if (to && to.exit) view.focus();
}

function onCellKey(e) {
  const a = active;
  if (!a || a.td !== e.currentTarget) return;
  const { row, col, td } = a;
  const cols = a.wrap.querySelectorAll('thead th').length;
  const bodyRows = a.wrap.querySelectorAll('tbody tr').length;
  const last = bodyRows ? bodyRows + 1 : 0;
  const below = row === 0 ? (bodyRows ? 2 : null) : row < last ? row + 1 : null;
  const above = row === 2 ? 0 : row > 2 ? row - 1 : null;
  const text = td.textContent;
  const caret = caretOffset(td);
  const sel = td.ownerDocument.getSelection();
  const collapsed = !sel || sel.isCollapsed;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'Tab') {
    stop();
    if (e.shiftKey) {
      if (col > 0) finishEdit({ to: { row, col: col - 1, selectAll: true } });
      else if (above != null) finishEdit({ to: { row: above, col: cols - 1, selectAll: true } });
    } else if (col < cols - 1) finishEdit({ to: { row, col: col + 1, selectAll: true } });
    else if (below != null) finishEdit({ to: { row: below, col: 0, selectAll: true } });
    else finishEdit({ to: { addRow: true, col: 0 } });
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    stop();
    finishEdit({ to: below != null ? { row: below, col, caret: Infinity } : { addRow: true, col } });
    return;
  }
  if (e.key === 'Escape') { stop(); finishEdit({ to: { exit: 'after' } }); return; }
  if (e.key === 'ArrowUp' && collapsed && !text.slice(0, caret).includes('\n')) {
    stop();
    finishEdit({ to: above != null ? { row: above, col, caret } : { exit: 'before' } });
    return;
  }
  if (e.key === 'ArrowDown' && collapsed && !text.slice(caret).includes('\n')) {
    stop();
    finishEdit({ to: below != null ? { row: below, col, caret } : { exit: 'after' } });
    return;
  }
  if (e.key === 'ArrowLeft' && collapsed && caret === 0 && col > 0) { stop(); finishEdit({ to: { row, col: col - 1, caret: Infinity } }); return; }
  if (e.key === 'ArrowRight' && collapsed && caret === text.length && col < cols - 1) { stop(); finishEdit({ to: { row, col: col + 1, caret: 0 } }); return; }
  // Shortcuts the app acts on (save, close the tab…): the cell's text goes into the note first.
  if ((e.ctrlKey || e.metaKey) && e.key.length === 1 && !'acvxzy'.includes(e.key.toLowerCase())) finishEdit();
}

// ── row / column changes (right-click) ──

function tableOp(view, from, fn) {
  if (active) finishEdit();
  const range = tableRange(view.state, from);
  if (!range) return;
  const t = parseTable(view.state.sliceDoc(range.from, range.to));
  if (fn(t) === false) return;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: formatTable(t) }, userEvent: 'input.table' });
}

const blankRow = (t) => t.head.map(() => '');

/** The table on the clipboard as a real table (HTML) for Word / Excel / Google Sheets, tab-separated as its text. */
async function copyTable(text) {
  const tsv = toTsv(tableRows(text).map((r) => r.map(plainCell)));
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([tableToHtml(text)], { type: 'text/html' }),
      'text/plain': new Blob([tsv], { type: 'text/plain' }),
    })]);
  } catch { await navigator.clipboard.writeText(tsv); }
}
const insertCol = (t, i) => { t.head.splice(i, 0, ''); t.align.splice(i, 0, '---'); for (const r of t.body) r.splice(i, 0, ''); };
const deleteCol = (t, i) => { t.head.splice(i, 1); t.align.splice(i, 1); for (const r of t.body) r.splice(i, 1); };

class TableWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  get estimatedHeight() { return this.text.split('\n').length * 30 + 10; }
  toDOM(view) {
    const lines = this.text.split('\n');
    const header = splitRow(lines[0]);
    const aligns = lines[1] ? splitRow(lines[1]).map((c) => alignOf(c.text)) : [];
    const cols = header.length;
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-md-tbl';
    const cell = (tag, c, row, ci) => {
      const el = document.createElement(tag);
      el.innerHTML = c ? cellHtml(c.text) : '';
      el.dataset.row = String(row);
      el.dataset.col = String(ci);
      el._src = c ? c.text : '';
      if (aligns[ci]) el.style.textAlign = aligns[ci];
      return el;
    };
    // Long text wraps, but a column never gets narrower than its longest word (capped), so short
    // values like "Esperando" stay on one line.
    const longest = new Array(cols).fill(3);
    lines.forEach((l, r) => {
      if (r === 1) return;
      splitRow(l).slice(0, cols).forEach((c, ci) => {
        const words = c.text.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, t, a) => a || t).replace(/[*_~`=]/g, '').split(/\s+|<br\s*\/?>/i);
        for (const w of words) if (!/^https?:/i.test(w)) longest[ci] = Math.max(longest[ci], Math.min(w.length, 16));
      });
    });
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    header.forEach((c, ci) => {
      const th = cell('th', c, 0, ci);
      th.style.minWidth = `calc(${longest[ci] + 1}ch + 22px)`;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (let r = 2; r < lines.length; r++) {
      const cells = splitRow(lines[r]);
      const tr = document.createElement('tr');
      for (let ci = 0; ci < cols; ci++) tr.appendChild(cell('td', cells[ci], r, ci));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap._edit = (row, col, opts) => {
      const td = wrap.querySelector(`[data-row="${row}"][data-col="${col}"]`);
      if (td) beginEdit(view, wrap, td, opts);
    };

    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const td = e.target.closest('td, th');
      if (td && active && active.td === td) return; // inside the cell being edited: the caret goes there
      const hooks = view.state.facet(previewHooks);
      const w = e.target.closest('[data-wiki]');
      const a = e.target.closest('[data-href]');
      if (w || (a && (hooks.linkMode() === 'click' || e.ctrlKey))) {
        e.preventDefault();
        if (w) {
          const target = w.getAttribute('data-wiki');
          const r = hooks.resolveWiki(target);
          hooks.openWiki(target, r && r.path ? r.path : null);
        } else hooks.openLink(a.getAttribute('data-href'));
        return;
      }
      if (!td) return;
      e.preventDefault();
      // Where the click was in the cell's text (cells without markup: the caret goes right there).
      let caret = null;
      const hit = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
      if (hit && td.contains(hit.startContainer) && td.textContent === toEdit(td._src || '')) {
        const r = document.createRange();
        r.setStart(td, 0);
        r.setEnd(hit.startContainer, hit.startOffset);
        caret = r.toString().length;
      }
      const row = +td.dataset.row;
      const col = +td.dataset.col;
      let from;
      try { from = view.posAtDOM(wrap); } catch { return; }
      if (active) finishEdit();
      view.focus();
      goToCell(view, from, row, col, { caret: caret ?? Infinity });
    });
    wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const td = e.target.closest('td, th');
      const row = td ? +td.dataset.row : 0;
      const col = td ? +td.dataset.col : 0;
      let from;
      try { from = view.posAtDOM(wrap); } catch { return; }
      if (active) finishEdit();
      const text = this.text;
      const op = (fn) => () => tableOp(view, from, fn);
      openMenu(e.clientX, e.clientY, [
        { label: 'Insert row above', icon: 'plus', disabled: row === 0, run: op((t) => { t.body.splice(row - 2, 0, blankRow(t)); }) },
        { label: 'Insert row below', icon: 'plus', run: op((t) => { t.body.splice(row === 0 ? 0 : row - 1, 0, blankRow(t)); }) },
        { label: 'Delete row', icon: 'trash', disabled: row === 0, run: op((t) => { t.body.splice(row - 2, 1); }) },
        { sep: true },
        { label: 'Insert column left', icon: 'plus', run: op((t) => insertCol(t, col)) },
        { label: 'Insert column right', icon: 'plus', run: op((t) => insertCol(t, col + 1)) },
        { label: 'Delete column', icon: 'trash', disabled: cols < 2, run: op((t) => deleteCol(t, col)) },
        { sep: true },
        {
          label: 'Edit table as text', icon: 'code', run: () => {
            const range = tableRange(view.state, from);
            if (!range) return;
            const c = cellAt(view.state.sliceDoc(range.from, range.to), row, col);
            view.dispatch({ effects: showAsText.of(range), selection: { anchor: range.from + c.from } });
            view.focus();
          },
        },
        { label: 'Copy table (Word, Excel, Sheets)', icon: 'copy', run: () => copyTable(text) },
        { label: 'Copy as markdown', icon: 'code', run: () => navigator.clipboard.writeText(text) },
      ]);
    });
    return blockBox(wrap);
  }
  destroy(dom) {
    // Taken off the screen while a cell is edited: what was typed is kept.
    if (active && dom.contains(active.wrap)) {
      const a = active;
      queueMicrotask(() => { if (active === a) finishEdit(); });
    }
  }
  ignoreEvent(e) { return !onBlockBox(e); }
}

function build(state) {
  const hooks = state.facet(previewHooks);
  if (!hooks.livePreview()) return Decoration.none;
  const asText = state.field(asTextField, false);
  const ranges = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Frontmatter' || node.name === 'HTMLBlock') return false;
      if (node.name !== 'Table') return undefined;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      // Its markdown shows for "Edit table as text" and for a selection inside it (a search match).
      const text = (asText && asText.from <= to && asText.to >= from) ||
        state.selection.ranges.some((r) => !r.empty && r.from >= from && r.to <= to);
      if (!text && to > from) ranges.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(from, to)), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

const tableDecos = StateField.define({
  create(state) {
    ensureSyntaxTree(state, Math.min(state.doc.length, 400_000), 80);
    return build(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured || tr.effects.some((e) => e.is(refreshPreview) || e.is(showAsText)) ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The caret in a shown table (a click, the arrow keys, Tab…): that cell is edited in place. */
const tableEditor = ViewPlugin.fromClass(class {
  update(u) {
    if (active && active.view === u.view && u.docChanged) active.from = u.changes.mapPos(active.from, -1);
    if (!u.selectionSet) return;
    const ann = u.transactions.map((t) => t.annotation(editCell)).find(Boolean);
    if (!ann && !u.view.hasFocus) return;
    const sel = u.state.selection.main;
    if (!sel.empty) return;
    const range = tableRange(u.state, sel.head);
    if (!range) return;
    const at = ann && ann.row != null ? ann : { ...cellOf(u.state.sliceDoc(range.from, range.to), sel.head - range.from), ...(ann || {}) };
    const { view } = u;
    const edit = (retry) => {
      const wrap = findWrap(view, range.from);
      if (wrap && wrap._edit) wrap._edit(at.row, at.col, { caret: at.caret, offset: at.offset || 0, selectAll: at.selectAll });
      else if (retry) setTimeout(() => edit(false), 80);
    };
    // The table's DOM is in place once this update is done (not waiting for a frame: none come while hidden).
    setTimeout(() => edit(true), 0);
  }
});

export const tableField = [asTextField, tableDecos, tableEditor];
