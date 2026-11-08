// Tables pasted from Word, Outlook or web pages (HTML) and from WordPad (RTF) become markdown tables; the rest
// of what was pasted stays plain text, as before. Excel and Google Sheets give tab-separated text instead
// (spreadsheetRows in tablemd.js).

import { rowsToMarkdown } from './tablemd.js';

const BLOCK = /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|TR|DL|DT|DD|HR|FIGURE|CAPTION)$/;
const SKIP = /^(STYLE|SCRIPT|HEAD|TITLE|META|LINK|XML|NOSCRIPT|TEMPLATE|IMG|SVG)$/;

/** mark around the text, the spaces around it kept outside: " **bold** ". */
function wrap(inner, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

/** What is inside a cell as markdown: bold, italic, strike, code, links; paragraphs and <br> as line breaks. */
function inlineMd(node) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { s += n.textContent.replace(/\s+/g, ' '); continue; }
    if (n.nodeType !== 1 || SKIP.test(n.tagName)) continue;
    const tag = n.tagName;
    if (tag === 'BR') { s += '\n'; continue; }
    const inner = inlineMd(n);
    if (BLOCK.test(tag)) {
      const t = inner.trim();
      if (t) s += (s && !s.endsWith('\n') ? '\n' : '') + t + '\n';
      continue;
    }
    const st = n.getAttribute('style') || '';
    let out = inner;
    if (tag === 'CODE') out = wrap(out, '`');
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') out = wrap(out, '~~');
    if (tag === 'I' || tag === 'EM' || /font-style\s*:\s*italic/i.test(st)) out = wrap(out, '*');
    if (tag === 'B' || tag === 'STRONG' || /font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) out = wrap(out, '**');
    if (tag === 'A') {
      const href = n.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href) && out.trim()) out = `[${out.trim()}](${href})`;
    }
    s += out;
  }
  return s;
}

const pad = (rows) => {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
};

function rowsOf(table) {
  const rows = [];
  for (const tr of table.rows) {
    const cells = [];
    for (const td of tr.cells) {
      cells.push(inlineMd(td).replace(/\n+$/, '').replace(/[ \t]+/g, ' ').trim());
      for (let k = 1; k < (td.colSpan || 1); k++) cells.push('');
    }
    rows.push(cells);
  }
  return pad(rows);
}

const tidy = (t) => t.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Pasted HTML with a table (Word, Outlook, a web page) as markdown: its tables as markdown tables, the rest as
 * plain text. Null without a data table — tables used for layout (emails, newsletters) don't count.
 */
export function htmlTablesToMarkdown(html) {
  if (!html || !/<table[\s>]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = [...doc.querySelectorAll('table')];
  if (!tables.length || tables.some((t) => t.querySelector('table') || /presentation|none/i.test(t.getAttribute('role') || ''))) return null;
  const blocks = [];
  let text = '';
  let found = false;
  const flush = () => { const t = tidy(text); if (t) blocks.push(t); text = ''; };
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { text += n.textContent.replace(/\s+/g, ' '); continue; }
      if (n.nodeType !== 1 || SKIP.test(n.tagName)) continue;
      if (n.tagName === 'TABLE') {
        const rows = rowsOf(n);
        if (rows.length * (rows[0] ? rows[0].length : 0) >= 2) { flush(); blocks.push(rowsToMarkdown(rows)); found = true; }
        else text += n.textContent;
        continue;
      }
      if (n.tagName === 'BR') { text += '\n'; continue; }
      const block = BLOCK.test(n.tagName);
      if (block && text && !text.endsWith('\n')) text += '\n';
      walk(n);
      if (block && !text.endsWith('\n')) text += '\n';
    }
  };
  walk(doc.body);
  flush();
  return found ? blocks.join('\n\n') : null;
}

// RTF groups that hold no text of the document.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr',
  'headerf', 'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata',
  'colorschememapping', 'latentstyles', 'datastore', 'fldinst', 'filetbl', 'revtbl', 'userprops', 'nonshppict', 'shp', 'shpinst',
  'pgdsctbl', 'listtext', 'pntext', 'pntxtb', 'pntxta', 'bkmkstart', 'bkmkend', 'mmathPr', 'wgrffmtfilter', 'docvar', 'xe', 'tc']);
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** Pasted RTF with a table (WordPad, Word) as markdown: its tables as markdown tables, the rest as plain text. Null without a table. */
export function rtfTablesToMarkdown(rtf) {
  if (!rtf || !rtf.includes('\\cell')) return null;
  const blocks = [];
  let text = '';
  let cell = '';
  let row = [];
  let rows = [];
  let inRow = false;
  let skip = false;
  let uc = 1;
  let fallback = 0;
  const stack = [];
  const flushText = () => { const t = tidy(text); if (t) blocks.push(t); text = ''; };
  const endTable = () => {
    if (!rows.length) return;
    flushText();
    blocks.push(rowsToMarkdown(pad(rows)));
    rows = [];
  };
  const emit = (s) => {
    if (skip) return;
    if (fallback > 0) { fallback--; return; }
    if (inRow) { cell += s; return; }
    if (rows.length && s.trim()) endTable();
    text += s;
  };
  const startRow = () => { if (!inRow) { if (!rows.length) flushText(); inRow = true; cell = ''; row = []; } };
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { stack.push(skip); i++; continue; }
    if (ch === '}') { skip = stack.length ? stack.pop() : false; i++; continue; }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (ch !== '\\') { emit(ch); i++; continue; }
    const nx = rtf[i + 1];
    if (nx === '\\' || nx === '{' || nx === '}') { emit(nx); i += 2; continue; }
    if (nx === "'") { const code = parseInt(rtf.substr(i + 2, 2), 16); emit(CP1252[code] || String.fromCharCode(code)); i += 4; continue; }
    if (nx === '*') { skip = true; i += 2; continue; }
    if (nx === '~') { emit(' '); i += 2; continue; }
    const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 48));
    if (!m) { i += 2; continue; }
    i += m[0].length;
    const w = m[1];
    const arg = m[2] != null ? Number(m[2]) : null;
    if (RTF_SKIP.has(w)) { skip = true; continue; }
    if (skip) continue;
    switch (w) {
      case 'par': case 'line': case 'sect': case 'page': emit('\n'); break;
      case 'tab': emit(inRow ? ' ' : '\t'); break;
      case 'trowd': case 'intbl': startRow(); break;
      case 'cell': case 'nestcell': row.push(cell.replace(/\n+$/, '').trim()); cell = ''; break;
      case 'row': case 'nestrow':
        if (cell.trim()) row.push(cell.trim());
        if (row.length) rows.push(row);
        row = []; cell = ''; inRow = false;
        break;
      case 'u': if (arg != null) { emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); fallback = uc; } break;
      case 'uc': uc = arg ?? 1; break;
      case 'emdash': emit('—'); break;
      case 'endash': emit('–'); break;
      case 'lquote': emit('‘'); break;
      case 'rquote': emit('’'); break;
      case 'ldblquote': emit('“'); break;
      case 'rdblquote': emit('”'); break;
      case 'bullet': emit('•'); break;
      default: break;
    }
  }
  if (inRow && (row.length || cell.trim())) { if (cell.trim()) row.push(cell.trim()); rows.push(row); }
  endTable();
  flushText();
  return blocks.some((b) => b.startsWith('|')) ? blocks.join('\n\n') : null;
}
