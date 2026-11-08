// Markdown syntax extensions for Obsidian-style notes:
//   ---            YAML front matter at the top (banner, datetime, kanban-plugin…)
//   [[Note|alias]] wiki links,  ![[image.png|caption]] embeds.

import { tags } from '@lezer/highlight';

export const Frontmatter = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    { name: 'FrontmatterMark', style: tags.processingInstruction },
  ],
  parseBlock: [{
    name: 'Frontmatter',
    before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
      const marks = [cx.elt('FrontmatterMark', 0, 3)];
      let end = -1;
      let lines = 0;
      while (cx.nextLine()) {
        if (++lines > 400) break;
        if (/^(---|\.\.\.)\s*$/.test(line.text)) {
          marks.push(cx.elt('FrontmatterMark', cx.lineStart, cx.lineStart + 3));
          end = cx.lineStart + line.text.length;
          cx.nextLine();
          break;
        }
      }
      if (end < 0) return true; // unclosed: leave the lines unstyled
      cx.addElement(cx.elt('Frontmatter', 0, end, marks));
      return true;
    },
  }],
};

export const WikiLinks = {
  defineNodes: [
    { name: 'WikiLink', style: tags.link },
    { name: 'WikiEmbed', style: tags.link },
    { name: 'WikiMark', style: tags.processingInstruction },
  ],
  parseInline: [{
    name: 'WikiLink',
    before: 'Link',
    parse(cx, next, pos) {
      let start = pos;
      let embed = false;
      if (next === 33 /* ! */ && cx.char(pos + 1) === 91 && cx.char(pos + 2) === 91) {
        embed = true;
        pos += 1;
      } else if (!(next === 91 /* [ */ && cx.char(pos + 1) === 91)) return -1;
      const rest = cx.slice(pos + 2, cx.end);
      const close = rest.indexOf(']]');
      if (close <= 0) return -1;
      const inner = rest.slice(0, close);
      if (inner.includes('\n') || inner.includes('[[')) return -1;
      const end = pos + 2 + close;
      return cx.addElement(cx.elt(embed ? 'WikiEmbed' : 'WikiLink', start, end + 2, [
        cx.elt('WikiMark', start, pos + 2),
        cx.elt('WikiMark', end, end + 2),
      ]));
    },
  }],
};

/** Parses "target#heading|alias" from the inside of [[ ]]. */
export function parseWiki(inner) {
  const bar = inner.indexOf('|');
  const alias = bar >= 0 ? inner.slice(bar + 1) : '';
  let target = bar >= 0 ? inner.slice(0, bar) : inner;
  const hash = target.indexOf('#');
  const heading = hash >= 0 ? target.slice(hash + 1) : '';
  if (hash >= 0) target = target.slice(0, hash);
  return { target: target.trim(), heading: heading.trim(), alias };
}

/** Very small YAML reader for front matter: top-level "key: value" pairs and "- item" lists. */
export function parseYaml(src) {
  const out = {};
  let listKey = null;
  for (const raw of (src || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) || (listKey && /^-\s+(.*)$/.exec(line));
    if (item && listKey) {
      if (!Array.isArray(out[listKey])) out[listKey] = [];
      out[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const val = kv[2].trim();
      listKey = val === '' ? kv[1] : null;
      out[kv[1]] = val === '' ? '' : val.startsWith('[') && val.endsWith(']')
        ? val.slice(1, -1).split(',').map((v) => unquote(v.trim())).filter(Boolean)
        : unquote(val);
    }
  }
  return out;
}

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** The front matter block of a note: {from, to, body, data} or null. */
export function readFrontmatter(text) {
  const m = /^﻿?---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!m) return null;
  return { from: 0, to: m[0].length, body: m[1], data: parseYaml(m[1]) };
}

/** Returns new note text with `key` set (or removed when value is null) in the front matter. */
export function setFrontmatterKey(text, key, value) {
  const fm = readFrontmatter(text);
  const line = value == null ? null : `${key}: ${/[:#\[\]{}!|>'"]/.test(value) ? JSON.stringify(value) : value}`;
  if (!fm) {
    if (line == null) return text;
    return `---\n${line}\n---\n${text.startsWith('\n') ? '' : '\n'}${text}`;
  }
  const lines = fm.body.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (i >= 0) {
    // Drop list continuation lines of the old value.
    let j = i + 1;
    while (j < lines.length && /^\s+-\s/.test(lines[j])) j++;
    if (line == null) lines.splice(i, j - i);
    else lines.splice(i, j - i, line);
  } else if (line != null) lines.unshift(line);
  const body = lines.filter((l, idx) => l.trim() || idx < lines.length - 1).join('\n');
  if (!body.trim()) return text.slice(fm.to).replace(/^\n/, '');
  return `---\n${body}\n---\n` + text.slice(fm.to);
}
