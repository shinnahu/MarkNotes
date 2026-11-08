// Markdown formatting commands used by the toolbar and shortcuts. All are normal
// transactions, so undo and redo work on them.

import { editCell } from './tables.js';
import { EditorSelection } from '@codemirror/state';

/** Wraps the selection in `mark` (or removes it when already wrapped). */
export function toggleWrap(view, mark, placeholder = 'text') {
  const { state } = view;
  const len = mark.length;
  const tr = state.changeByRange((range) => {
    const before = state.sliceDoc(range.from - len, range.from);
    const after = state.sliceDoc(range.to, range.to + len);
    if (before === mark && after === mark) {
      return {
        changes: [{ from: range.from - len, to: range.from }, { from: range.to, to: range.to + len }],
        range: EditorSelection.range(range.from - len, range.to - len),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    if (text.length >= 2 * len && text.startsWith(mark) && text.endsWith(mark)) {
      return {
        changes: { from: range.from, to: range.to, insert: text.slice(len, text.length - len) },
        range: EditorSelection.range(range.from, range.to - 2 * len),
      };
    }
    if (range.empty) {
      // Word under the caret, or a placeholder.
      const word = state.wordAt(range.head);
      if (word) {
        return {
          changes: [{ from: word.from, insert: mark }, { from: word.to, insert: mark }],
          range: EditorSelection.cursor(range.head + len),
        };
      }
      return {
        changes: { from: range.from, insert: mark + placeholder + mark },
        range: EditorSelection.range(range.from + len, range.from + len + placeholder.length),
      };
    }
    return {
      changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + len, range.to + len),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  view.focus();
  return true;
}

function selectedLines(state) {
  const lines = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return [...lines].sort((x, y) => x - y).map((n) => state.doc.line(n));
}

const PREFIXES = [/^(\s*)(#{1,6}\s)/, /^(\s*)(>\s?)/, /^(\s*)([-*+]\s\[[ xX]\]\s)/, /^(\s*)([-*+]\s)/, /^(\s*)(\d+[.)]\s)/];

function stripPrefix(text) {
  for (const re of PREFIXES) {
    const m = re.exec(text);
    if (m) return { indent: m[1], prefix: m[2], rest: text.slice(m[0].length) };
  }
  const m = /^(\s*)/.exec(text);
  return { indent: m[1], prefix: '', rest: text.slice(m[1].length) };
}

/** Sets a line prefix such as "- ", "1. ", "> ", "- [ ] " or "## ", toggling it off if all lines have it. */
export function toggleLinePrefix(view, kind) {
  const { state } = view;
  const lines = selectedLines(state);
  const test = {
    bullet: /^[-*+]\s(?!\[[ xX]\])/,
    number: /^\d+[.)]\s/,
    task: /^[-*+]\s\[[ xX]\]\s/,
    quote: /^>\s?/,
  }[kind];
  const all = lines.every((l) => test.test(stripPrefix(l.text).prefix || ''));
  const changes = [];
  let n = 1;
  for (const line of lines) {
    const { indent, prefix, rest } = stripPrefix(line.text);
    if (!line.text.trim() && lines.length > 1) continue;
    let next;
    if (all) next = indent + rest;
    else {
      const p = kind === 'bullet' ? '- ' : kind === 'number' ? `${n++}. ` : kind === 'task' ? '- [ ] ' : '> ';
      next = indent + p + (/^#{1,6}\s/.test(prefix) ? prefix : '') + rest;
    }
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true });
  view.focus();
  return true;
}

/** Cycles the current line(s) through heading levels: none → H1 → H2 → H3 → none. */
export function cycleHeading(view, level) {
  const { state } = view;
  const changes = [];
  for (const line of selectedLines(state)) {
    const m = /^(\s*)(#{1,6})\s/.exec(line.text);
    const cur = m ? m[2].length : 0;
    const next = level !== undefined ? (cur === level ? 0 : level) : cur >= 3 ? 0 : cur + 1;
    const body = m ? line.text.slice(m[0].length) : line.text.replace(/^\s+/, '');
    const indent = m ? m[1] : /^\s*/.exec(line.text)[0];
    changes.push({ from: line.from, to: line.to, insert: indent + (next ? '#'.repeat(next) + ' ' : '') + body });
  }
  view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
  return true;
}

/** Wraps the selection in a fenced code block, or inserts an empty one. */
export function insertCodeBlock(view, lang = '') {
  const { state } = view;
  const r = state.selection.main;
  const fromLine = state.doc.lineAt(r.from);
  const toLine = state.doc.lineAt(r.to);
  if (!r.empty) {
    const text = state.sliceDoc(fromLine.from, toLine.to);
    const insert = '```' + lang + '\n' + text + '\n```';
    const after = toLine.to >= state.doc.length ? '\n' : '';
    view.dispatch({
      changes: { from: fromLine.from, to: toLine.to, insert: insert + after },
      selection: { anchor: fromLine.from + insert.length + (after ? 1 : 0) },
      userEvent: 'input.format',
    });
  } else {
    const pre = r.from > fromLine.from ? '\n' : '';
    const insert = pre + '```' + lang + '\n\n```\n';
    view.dispatch({
      changes: { from: r.from, insert },
      selection: { anchor: r.from + pre.length + 3 + lang.length + 1 },
      userEvent: 'input.format',
    });
  }
  view.focus();
  return true;
}

export function insertLink(view) {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to);
  const isUrl = /^https?:\/\/\S+$/.test(text);
  const insert = isUrl ? `[](${text})` : `[${text || 'link text'}](https://)`;
  const sel = isUrl ? r.from + 1 : text ? r.from + text.length + 3 : r.from + 1;
  const selEnd = isUrl ? r.from + 1 : text ? r.from + insert.length - 1 : r.from + 10;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: sel, head: selEnd }, userEvent: 'input.format' });
  view.focus();
  return true;
}

export function insertText(view, text, selectInserted = false) {
  const r = view.state.selection.main;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: selectInserted ? { anchor: r.from, head: r.from + text.length } : { anchor: r.from + text.length },
    userEvent: 'input',
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

/** Inserts a block (image, rule…) on its own line. */
export function insertBlock(view, text) {
  const { state } = view;
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  const pre = r.from > line.from || line.text.trim() ? (r.from === line.from ? '' : '\n') : '';
  const atLineEnd = r.to === state.doc.lineAt(r.to).to;
  const post = atLineEnd && r.to < state.doc.length ? '' : '\n';
  const insert = pre + text + post;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length }, userEvent: 'input', scrollIntoView: true });
  view.focus();
  return true;
}

export function insertDateTime(view) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return insertText(view, `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);
}

/** Tab: indent lists / selections, otherwise insert a real tab like Notepad. */
export function smartTab(view) {
  const { state } = view;
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  if (!r.empty || /^\s*([-*+]|\d+[.)])\s/.test(line.text) || state.selection.ranges.length > 1) {
    const changes = selectedLines(state).map((l) => ({ from: l.from, insert: '    ' }));
    view.dispatch({ changes, userEvent: 'input.indent' });
    return true;
  }
  view.dispatch(state.replaceSelection('\t'));
  return true;
}

export function smartUntab(view) {
  const { state } = view;
  const changes = [];
  for (const l of selectedLines(state)) {
    const m = /^( {1,4}|\t)/.exec(l.text);
    if (m) changes.push({ from: l.from, to: l.from + m[0].length });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'delete.dedent' });
  return true;
}

/** Sets the heading level of the selected lines (0 = normal text, "Body"). */
export function setHeading(view, level) {
  const changes = [];
  for (const line of selectedLines(view.state)) {
    const m = /^(\s*)(#{1,6})\s/.exec(line.text);
    const indent = m ? m[1] : /^\s*/.exec(line.text)[0];
    const body = m ? line.text.slice(m[0].length) : line.text.slice(indent.length);
    const next = indent + (level ? '#'.repeat(level) + ' ' : '') + body;
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  if (changes.length) view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
  return true;
}

/** Removes bold, italic, strikethrough, highlight, inline code and math marks from the selection. */
export function clearFormatting(view) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    if (range.empty) return { range };
    const text = state.sliceDoc(range.from, range.to);
    let out = text;
    for (let i = 0; i < 3; i++) {
      out = out.replace(/(\*\*|__|~~|==)(?=\S)([\s\S]*?\S)\1/g, '$2')
        .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1$2')
        .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/\$(?=\S)([^$\n]*?\S)\$/g, '$1');
    }
    return { changes: { from: range.from, to: range.to, insert: out }, range: EditorSelection.range(range.from, range.from + out.length) };
  });
  view.dispatch(state.update(tr, { userEvent: 'input.format' }));
  view.focus();
  return true;
}

/** [[selection]] (or [[]] with the caret inside), Obsidian's "Add link". */
export function insertWikiLink(view) {
  const r = view.state.selection.main;
  const text = view.state.sliceDoc(r.from, r.to);
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: `[[${text}]]` },
    selection: text ? { anchor: r.from + 2, head: r.from + 2 + text.length } : { anchor: r.from + 2 },
    userEvent: 'input.format',
  });
  view.focus();
  return true;
}

const NEW_TABLE = '| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n|          |          |          |';

/** A new table, with the first column's name selected right in the table (live preview), ready to be typed over. */
export function insertTable(view) {
  const at = view.state.selection.main.from;
  insertBlock(view, NEW_TABLE);
  const i = view.state.sliceDoc(at, at + NEW_TABLE.length + 2).indexOf('| Column 1');
  if (i >= 0) view.dispatch({ selection: { anchor: at + i + 2 }, annotations: editCell.of({ selectAll: true }) });
  return true;
}

/** A callout ("> [!note]") around the selected lines, or an empty one. */
export function insertCallout(view) {
  const { state } = view;
  const r = state.selection.main;
  if (!r.empty) {
    const from = state.doc.lineAt(r.from);
    const to = state.doc.lineAt(r.to);
    const body = state.sliceDoc(from.from, to.to).split('\n').map((l) => '> ' + l).join('\n');
    view.dispatch({ changes: { from: from.from, to: to.to, insert: '> [!note]\n' + body }, userEvent: 'input.format' });
    view.focus();
    return true;
  }
  return insertBlock(view, '> [!note]\n> ');
}

export function insertMathBlock(view) {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to);
  const line = state.doc.lineAt(r.from);
  const pre = r.from > line.from ? '\n' : '';
  const insert = `${pre}$$\n${text}\n$$\n`;
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + pre.length + 3 + text.length }, userEvent: 'input.format' });
  view.focus();
  return true;
}
