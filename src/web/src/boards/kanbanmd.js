// Kanban boards stored as markdown, in the format of the Obsidian Kanban plugin:
//
//   ---
//
//   kanban-plugin: board
//
//   ---
//
//   ## To Do
//
//   - [ ] #Feature [[Some note]]
//   - [ ] A card
//   	with a second line
//
//
//   ## Done
//
//   **Complete**
//   - [x] Finished card
//
//
//   ***
//
//   ## Archive
//
//   - [x] Old card
//
//   %% kanban:settings
//   ```
//   {"kanban-plugin":"board"}
//   ```
//   %%
//
// The front matter is kept byte for byte; lanes are written the way the plugin writes them, so a
// board edited here and in Obsidian produces the same file.

const LANE_RX = /^##\s+(.*?)\s*$/;
const ITEM_RX = /^[-*+]\s+(?:\[(.)\]\s?)?(.*)$/;
const COMPLETE_RX = /^\*\*Complete\*\*\s*$/;

/** @returns {{head:string, lanes:Lane[], archive:string, settings:object|null, settingsRaw:string, indent:string}} */
export function parseBoard(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  let i = 0;

  // Front matter and anything before the first lane: kept as it is.
  if (/^---\s*$/.test(lines[0] || '')) {
    let j = 1;
    while (j < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[j])) j++;
    i = Math.min(j + 1, lines.length);
  }
  while (i < lines.length && !LANE_RX.test(lines[i]) && !isTailStart(lines, i)) i++;
  const head = lines.slice(0, i).join('\n');

  const lanes = [];
  let indent = '\t';
  let lane = null;
  let item = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isTailStart(lines, i)) break;
    const h = LANE_RX.exec(line);
    if (h) {
      lane = { title: h[1].replace(/<br>/g, ' '), rawTitle: h[1], complete: false, items: [], extra: [] };
      lanes.push(lane);
      item = null;
      continue;
    }
    if (!lane) continue;
    if (COMPLETE_RX.test(line)) { lane.complete = true; item = null; continue; }
    const m = ITEM_RX.exec(line);
    if (m && !/^\s/.test(line)) {
      item = { check: m[1] === undefined ? null : m[1], text: m[2] };
      lane.items.push(item);
      continue;
    }
    if (item && /^[ \t]+\S/.test(line)) {
      // Continuation of a multi-line card (the plugin indents extra lines with a tab or spaces).
      const ind = /^[ \t]+/.exec(line)[0];
      if (lane.items.length && item === lane.items[lane.items.length - 1]) indent = ind.startsWith('\t') ? '\t' : ind.length >= 4 ? '    ' : ind;
      item.text += '\n' + line.replace(/^(\t| {1,4})/, '');
      continue;
    }
    item = null;
    if (line.trim()) lane.extra.push(line);
  }

  // Archive (after a *** line) and the settings block are kept as they are.
  const rest = lines.slice(i).join('\n');
  const s = rest.indexOf('%% kanban:settings');
  const archive = (s >= 0 ? rest.slice(0, s) : rest).replace(/\s+$/, '');
  const settingsRaw = s >= 0 ? rest.slice(s) : '';
  let settings = null;
  if (settingsRaw) {
    const j = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(settingsRaw);
    if (j) { try { settings = JSON.parse(j[1]); } catch { settings = null; } }
  }
  return { head, lanes, archive, settings, settingsRaw, indent };
}

function isTailStart(lines, i) {
  const l = lines[i];
  if (l.startsWith('%% kanban:settings')) return true;
  if (/^\*\*\*\s*$/.test(l)) {
    // The plugin writes "***" then "## Archive".
    for (let j = i + 1; j < lines.length && j < i + 4; j++) if (lines[j].trim()) return /^##\s+Archive\s*$/i.test(lines[j]);
  }
  return false;
}

export function itemToMd(item, indent = '\t') {
  const box = item.check === null ? '' : `[${item.check || ' '}] `;
  const text = String(item.text || '').trim().replace(/\r\n?/g, '\n').replace(/\n/g, '\n' + indent);
  return `- ${box}${text}`;
}

export function serializeBoard(board) {
  let head = board.head;
  if (!head.trim()) head = '---\n\nkanban-plugin: board\n\n---\n';
  // The plugin leaves one blank line between the front matter and the first lane.
  let out = head.replace(/\n*$/, '') + '\n\n';
  for (const lane of board.lanes) {
    const lines = [`## ${lane.rawTitle.trim().replace(/\n/g, '<br>')}`, ''];
    if (lane.complete) lines.push('**Complete**');
    for (const it of lane.items) lines.push(itemToMd(it, board.indent));
    for (const x of lane.extra || []) lines.push(x);
    lines.push('', '', '');
    out += lines.join('\n');
  }
  if (board.archive && board.archive.trim()) out += board.archive.replace(/\s+$/, '');
  if (board.settings) {
    out += ['', '', '%% kanban:settings', '```', JSON.stringify(board.settings), '```', '%%'].join('\n');
  } else if (board.settingsRaw) {
    out += '\n\n' + board.settingsRaw.replace(/^\s+/, '');
  } else {
    out += ['', '', '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%'].join('\n');
  }
  return out;
}

/** Appends cards to the archive section (creating it the way the plugin does). */
export function archiveItems(board, items) {
  if (!items.length) return;
  const md = items.map((it) => itemToMd(it, board.indent)).join('\n');
  board.archive = board.archive && board.archive.trim()
    ? board.archive.replace(/\s+$/, '') + '\n' + md
    : ['***', '', '## Archive', '', md].join('\n');
}

export function cloneBoard(b) {
  return {
    ...b,
    lanes: b.lanes.map((l) => ({ ...l, items: l.items.map((it) => ({ ...it })), extra: (l.extra || []).slice() })),
    settings: b.settings ? JSON.parse(JSON.stringify(b.settings)) : null,
  };
}

// ───────────────────────────── card text → HTML ─────────────────────────────

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const TAG_RX = /(^|[\s(])(#[\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;

/** Tags of a card, in order ("#Bug"). */
export function cardTags(text) {
  const out = [];
  for (const m of String(text).matchAll(TAG_RX)) if (!out.includes(m[2])) out.push(m[2]);
  return out;
}

/**
 * Renders a card's markdown to safe HTML: [[links]] (no underline, clickable), ![[images]],
 * **bold**, *italic*, ~~strike~~, ==highlight==, `code`, [links](url), #tags, @{dates}.
 * opts: { tagStyle(tag) → css string, image(target) → url|null|undefined, hideTags }
 */
export function cardHtml(text, opts = {}) {
  const lines = String(text || '').replace(/\s\^[A-Za-z0-9-]+$/m, '').split('\n');
  const out = [];
  for (let raw of lines) {
    let bullet = '';
    const b = /^\s*[-*+]\s+(?:\[(.)\]\s+)?/.exec(raw);
    if (b) {
      bullet = b[1] !== undefined ? (b[1] === ' ' ? '☐ ' : '☑ ') : '• ';
      raw = raw.slice(b[0].length);
    }
    out.push(esc(bullet) + inline(raw, opts));
  }
  return out.join('<br>');
}

function inline(src, opts) {
  // Pull out the pieces that must not be touched by the other rules first.
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;
  s = s.replace(/`([^`]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/!\[\[([^\]\n]+)\]\]/g, (_, inner) => {
    const [target, alias = ''] = inner.split('|');
    const url = opts.image ? opts.image(target.trim()) : null;
    if (url) {
      const w = /^\d{2,4}$/.test(alias.trim()) ? ` style="max-width:${+alias.trim()}px"` : '';
      return keep(`<img class="kb-img" src="${esc(url)}" alt=""${w} loading="lazy" decoding="async">`);
    }
    return keep(`<span class="kb-embed">${esc(alias || target)}</span>`);
  });
  s = s.replace(/\[\[([^\]\n]+)\]\]/g, (_, inner) => {
    const bar = inner.indexOf('|');
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const label = bar >= 0 ? inner.slice(bar + 1) : target.replace(/#/, ' › ');
    return keep(`<a class="kb-wiki" data-wiki="${esc(target.split('#')[0])}">${esc(label)}</a>`);
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => keep(`<a class="kb-link" data-href="${esc(href)}">${esc(label)}</a>`));
  s = s.replace(/\bhttps?:\/\/[^\s<]+/g, (u) => keep(`<a class="kb-link" data-href="${esc(u)}">${esc(u)}</a>`));
  s = s.replace(/@\{([^}\n]+)\}/g, (_, d) => keep(`<span class="kb-date">📅 ${esc(d)}</span>`));
  s = s.replace(/@@\{([^}\n]+)\}/g, (_, d) => keep(`<span class="kb-date">🕑 ${esc(d)}</span>`));
  s = s.replace(TAG_RX, (_, pre, tag) => (opts.hideTags ? pre : pre + keep(tagHtml(tag, opts))));
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>');
  if (opts.hideTags) s = s.replace(/\s{2,}/g, ' ').trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[+n]);
}

export function tagHtml(tag, opts = {}) {
  const st = opts.tagStyle ? opts.tagStyle(tag) : '';
  return `<span class="kb-tag"${st ? ` style="${esc(st)}"` : ''}>${esc(tag)}</span>`;
}

/** Card text for previews and titles: no markdown symbols, links shown by name. */
export function cardPlain(text) {
  return String(text || '').split('\n')[0]
    .replace(/!?\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, t, a) => a || t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~=`]/g, '')
    .trim();
}
