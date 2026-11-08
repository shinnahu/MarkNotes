// The right-click menu of text being edited (notes and canvas cards), laid out like Obsidian's:
// links, Format ▸, Paragraph ▸, Insert ▸, clipboard, and a search for the selected words.

import {
  toggleWrap, toggleLinePrefix, setHeading, clearFormatting, insertWikiLink, insertLink, insertTable,
  insertCallout, insertBlock, insertCodeBlock, insertMathBlock, insertDateTime,
} from './commands.js';
import { pasteFromClipboard } from './paste.js';

const headingOf = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^\s*(#{1,6})\s/.exec(line.text);
  return m ? m[1].length : 0;
};

/**
 * opts: { markdown (false for plain .txt), search(text), find() (Find / replace), dateTime }.
 */
export function editorMenuItems(view, opts = {}) {
  const sel = view.state.selection.main;
  const has = !sel.empty;
  const md = opts.markdown !== false;
  const level = md ? headingOf(view) : 0;
  const run = (fn) => () => { view.focus(); fn(view); };
  const selected = has ? view.state.sliceDoc(sel.from, sel.to).replace(/\s+/g, ' ').trim() : '';
  const short = selected.length > 24 ? selected.slice(0, 24) + '…' : selected;
  return [
    md && { label: 'Add link', icon: 'link', run: run(insertWikiLink) },
    md && { label: 'Add external link', icon: 'external', hint: 'Ctrl+Shift+K', run: run(insertLink) },
    md && { sep: true },
    md && {
      label: 'Format', icon: 'bold', submenu: [
        { label: 'Bold', icon: 'bold', hint: 'Ctrl+B', run: run((v) => toggleWrap(v, '**')) },
        { label: 'Italic', icon: 'italic', hint: 'Ctrl+I', run: run((v) => toggleWrap(v, '*')) },
        { label: 'Strikethrough', icon: 'strike', hint: 'Ctrl+Shift+X', run: run((v) => toggleWrap(v, '~~')) },
        { label: 'Highlight', icon: 'pen', run: run((v) => toggleWrap(v, '==')) },
        { sep: true },
        { label: 'Code', icon: 'code', hint: 'Ctrl+E', run: run((v) => toggleWrap(v, '`', 'code')) },
        { label: 'Math', icon: 'hash', run: run((v) => toggleWrap(v, '$', 'x')) },
        { sep: true },
        { label: 'Clear formatting', icon: 'x', disabled: !has, run: run(clearFormatting) },
      ],
    },
    md && {
      label: 'Paragraph', icon: 'list', submenu: [
        { label: 'Bullet list', icon: 'list', run: run((v) => toggleLinePrefix(v, 'bullet')) },
        { label: 'Numbered list', icon: 'list-ordered', run: run((v) => toggleLinePrefix(v, 'number')) },
        { label: 'Task list', icon: 'list-check', run: run((v) => toggleLinePrefix(v, 'task')) },
        { sep: true },
        ...[1, 2, 3, 4, 5, 6].map((h) => ({ label: `Heading ${h}`, icon: 'heading', checked: level === h ? true : undefined, hint: h <= 3 ? `Ctrl+${h}` : undefined, run: run((v) => setHeading(v, h)) })),
        { label: 'Body', icon: 'type', checked: level === 0 ? true : undefined, run: run((v) => setHeading(v, 0)) },
        { sep: true },
        { label: 'Quote', icon: 'quote', run: run((v) => toggleLinePrefix(v, 'quote')) },
      ],
    },
    md && {
      label: 'Insert', icon: 'plus', submenu: [
        { label: 'Table', icon: 'table', run: run(insertTable) },
        { label: 'Callout', icon: 'quote', run: run(insertCallout) },
        { label: 'Horizontal rule', icon: 'hr', run: run((v) => insertBlock(v, '---')) },
        { sep: true },
        { label: 'Code block', icon: 'code', hint: 'Ctrl+Shift+C', run: run((v) => insertCodeBlock(v)) },
        { label: 'Math block', icon: 'hash', run: run(insertMathBlock) },
        opts.dateTime !== false && { label: 'Date & time', icon: 'clock', hint: 'F5', run: run(insertDateTime) },
      ].filter(Boolean),
    },
    md && { sep: true },
    { label: 'Cut', icon: 'move', hint: 'Ctrl+X', disabled: !has, run: () => { view.focus(); document.execCommand('cut'); } },
    { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', disabled: !has, run: () => { view.focus(); document.execCommand('copy'); } },
    { label: 'Paste', icon: 'clipboard', hint: 'Ctrl+V', run: () => { view.focus(); pasteFromClipboard(view); } },
    { label: 'Paste as plain text', icon: 'clipboard', hint: 'Ctrl+Shift+V', run: () => { view.focus(); pasteFromClipboard(view, { plain: true }); } },
    { label: 'Select all', hint: 'Ctrl+A', run: () => { view.focus(); view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); } },
    (has && opts.search) || opts.find ? { sep: true } : null,
    has && opts.search && { label: `Search for “${short}”`, icon: 'search', run: () => opts.search(selected) },
    opts.find && { label: 'Find / replace', icon: 'search', hint: 'Ctrl+F', run: () => opts.find() },
  ];
}
