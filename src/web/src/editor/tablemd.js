// Markdown tables as data: splitting rows into cells, inline cell markup, spreadsheet (TSV) paste.
// No editor or DOM dependencies, so it is easy to test.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Cells of a table row ({text, from}: from = offset of the text in the line). GFM rules: outer pipes optional, \| escapes, pipes in `code` kept. */
export function splitRow(line) {
  const out = [];
  const n = line.length;
  let i = 0;
  while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  if (line[i] === '|') i++;
  let start = i;
  let inCode = false;
  const trailingPipe = /\|\s*$/.test(line);
  for (; i <= n; i++) {
    const ch = line[i];
    if (i === n || (ch === '|' && !inCode && line[i - 1] !== '\\')) {
      const raw = line.slice(start, i);
      if (i === n && trailingPipe && raw.trim() === '' && out.length) break;
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: raw.trim(), from: start + lead });
      start = i + 1;
    } else if (ch === '`') inCode = !inCode;
  }
  return out;
}

export function alignOf(cell) {
  const t = cell.replace(/\s/g, '');
  if (/^:-+:$/.test(t)) return 'center';
  if (/^-+:$/.test(t)) return 'right';
  if (/^:-+$/.test(t)) return 'left';
  return '';
}

/** Inline markdown inside a cell: **bold**, *italic*, ~~strike~~, `code`, [links](…), [[wiki|alias]], <br>, bare URLs. */
export function cellHtml(src) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src.replace(/\\\|/g, '|');
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/<br\s*\/?>/gi, () => keep('<br>'));
  s = s.replace(/!?\[\[([^\]\n]+)\]\]/g, (_, inner) => {
    const bar = inner.indexOf('|');
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const label = bar >= 0 ? inner.slice(bar + 1) : target;
    return keep(`<span class="cm-md-wiki" data-wiki="${esc(target.split('#')[0])}">${esc(label)}</span>`);
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => keep(`<span class="cm-md-link" data-href="${esc(href)}">${esc(label)}</span>`));
  s = s.replace(/\bhttps?:\/\/[^\s<|]+/g, (u) => keep(`<span class="cm-md-url" data-href="${esc(u)}">${esc(u)}</span>`));
  s = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => slots[+k]);
}

/** A table's markdown as cell texts {head, align, body}; short rows are padded to the header's width. */
export function parseTable(text) {
  const lines = text.split('\n');
  const head = splitRow(lines[0] || '').map((c) => c.text);
  const pad = (cells) => Array.from({ length: Math.max(head.length, cells.length) }, (_, i) => cells[i] ?? '');
  const align = pad(lines[1] ? splitRow(lines[1]).map((c) => c.text) : []).map((a) => a || '---');
  const body = lines.slice(2).map((l) => pad(splitRow(l).map((c) => c.text)));
  return { head: pad(head), align, body };
}

/** Back to markdown, one row per line: | a | b |. */
export function formatTable({ head, align, body }) {
  const cols = head.length;
  const line = (cells) => `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(head), line(align.map((a) => a || '---')), ...body.map(line)].join('\n');
}

/** Rows of cell texts from table markdown (alignment row dropped). */
export function tableRows(text) {
  const lines = text.split('\n');
  return lines.filter((_, i) => i !== 1).map((l) => splitRow(l).map((c) => c.text));
}

/** cellHtml's links as plain HTML (wiki links as their text) for other apps. */
const exportHtml = (h) => h
  .replace(/<span class="cm-md-wiki" data-wiki="[^"]*">([\s\S]*?)<\/span>/g, '$1')
  .replace(/<span class="cm-md-(?:link|url)" data-href="([^"]*)">([\s\S]*?)<\/span>/g, '<a href="$1">$2</a>');

/** A markdown table as an HTML table for Word, Excel and Google Sheets (with borders: Word shows none without them). */
export function tableToHtml(text) {
  const rows = tableRows(text);
  const cols = rows[0] ? rows[0].length : 0;
  const cell = (tag, src) => `<${tag} style="border:1px solid #999;padding:4px 8px;vertical-align:top;text-align:left">${exportHtml(cellHtml(src || ''))}</${tag}>`;
  const head = `<tr>${(rows[0] || []).map((c) => cell('th', c)).join('')}</tr>`;
  const body = rows.slice(1).map((r) => `<tr>${Array.from({ length: cols }, (_, i) => cell('td', r[i])).join('')}</tr>`).join('');
  return `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

const isTableAt = (lines, i) => /^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]);

/** True when the markdown holds a table. */
export function hasTable(text) {
  const lines = text.split('\n');
  return lines.some((_, i) => isTableAt(lines, i));
}

/** Copied markdown as simple HTML for Word and other apps: tables as tables, headings, lists, paragraphs. */
export function markdownToHtml(text) {
  const lines = text.split('\n');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const inline = (s) => exportHtml(cellHtml(s));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isTableAt(lines, i)) {
      close();
      let j = i;
      while (j < lines.length && /^\s*\|/.test(lines[j])) j++;
      out.push(tableToHtml(lines.slice(i, j).join('\n')));
      i = j - 1;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    const ul = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(l);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(l);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); } else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (l.trim()) { close(); out.push(`<p>${inline(l)}</p>`); } else close();
  }
  close();
  return out.join('');
}

/** A cell's text without its markdown (for plain-text copies): links as their labels, no **, *, ~~, ==, `. */
export function plainCell(s) {
  return s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

export function toTsv(rows) {
  const cell = (c) => {
    const v = c.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n');
    return /[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map(cell).join('\t')).join('\r\n');
}

// ───────────────────────────── paste from spreadsheets ─────────────────────────────

/** Tab-separated text as Excel/Sheets put it on the clipboard (quoted cells may hold tabs, newlines, ""). */
export function parseTsv(text) {
  let t = text.replace(/\r\n?/g, '\n');
  if (t.endsWith('\n')) t = t.slice(0, -1);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** Clipboard text that is a table copied from a spreadsheet → rows, else null. */
export function spreadsheetRows(text, html) {
  if (!text || !text.includes('\t')) return null;
  const fromSheet = /<table[\s>]/i.test(html || '');
  const rows = parseTsv(text);
  if (rows.length < (fromSheet ? 1 : 2)) return null;
  const counts = rows.map((r) => r.length);
  const max = Math.max(...counts);
  if (max < 2) return null;
  // Without HTML, only accept a regular grid whose rows all start with a value
  // (tab-indented code must stay code).
  if (!fromSheet && (counts.some((c) => c !== max) || rows.some((r) => !r[0].trim()))) return null;
  // Drop columns that are empty in every row (trailing selection in Excel).
  let cols = max;
  while (cols > 1 && rows.every((r) => !(r[cols - 1] || '').trim())) cols--;
  return rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
}

export function rowsToMarkdown(rows) {
  const cols = rows[0].length;
  const fmt = (c) => c.trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  const line = (r) => `| ${r.map(fmt).join(' | ')} |`;
  return [line(rows[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}
