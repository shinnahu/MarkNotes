// Notes saved as PDF, on white paper and fully offline. The note is laid out like a printed document (headings,
// lists, checklists, tables, code with colours, pictures with captions, link cards) on a print-only page inside
// this window, and the host prints that page with WebView2's own engine (bridge pdf.choose / pdf.print).
// Pictures come from disk and link cards only from previews already kept on this PC: nothing is fetched.
// Options: Settings › Import & export › PDF.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { StyleModule } from 'style-mod';
import * as api from '../api.js';
import { settings, DEFAULT_SETTINGS, persisted, saveState, toast, dismissToast, wsForPath, notesByWs, loadNotes } from '../store.js';
import { docs, docTitle, resolveImage } from '../docs.js';
import { loadFiles } from '../links.js';
import { readFrontmatter, parseWiki } from '../editor/mdext.js';
import { bannerOf, formatBannerDate } from '../editor/frontmatter.js';
import { captionHtml } from '../editor/livepreview.js';
import { appHighlight, loadParser, renderHighlighted, languageLabel } from '../editor/highlight.js';
import { SPINE_RX } from './spine.js';
import { youTubeId, hostOf } from './embeds.js';
import { resolveAssetUrl, decodeLink, extOf, clamp, cls } from '../util.js';

// Paper in inches, margins in millimetres, text in points.
const PAPERS = { a4: [8.27, 11.69], letter: [8.5, 11], legal: [8.5, 14] };
const MARGINS = { narrow: 12, normal: 18, wide: 25 };
const SIZES = { small: 10, medium: 11, large: 12 };
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
// A web link alone on its line: the note shows it as a preview card.
const ALONE = /^<?(https?:\/\/[^\s<>]+?)>?$|^\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)$/;
// Web addresses in plain .txt notes.
const URL_RX = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
const FOOTER = '<div style="width:100%;text-align:center;font:9px \'Segoe UI\',sans-serif;color:#80868b"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';
const PURIFY = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'script', 'textarea', 'select'] };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// ───────────────────────────── markdown → printable HTML ─────────────────────────────

let noteKey = '';

/** A picture as the note shows it: up to its own width (|300) or Settings › Maximum image width, caption in a box below. */
function picture(url, caption, width, link) {
  const name = decodeLink(link);
  if (!url) return `<span class="pdf-missing">🖼 Image not found: ${esc(name)}</span>`;
  const max = width || settings.peek().maxImageWidth || 0;
  const size = max ? ` style="max-width:min(100%, ${max}px)"` : '';
  const img = `<img src="${escAttr(url)}" alt="" data-link="${escAttr(name)}"`;
  return caption
    ? `<span class="pdf-figure"${size}>${img}><span class="pdf-caption">${captionHtml(caption)}</span></span>`
    : `${img} class="pdf-img"${size}>`;
}

const md = new Marked({ gfm: true, breaks: true });
md.use({
  // Like the editor: indented lines are text, not code.
  tokenizer: { code() { return undefined; } },
  extensions: [
    {
      // Obsidian comments (%% … %%, e.g. a kanban board's settings) are not shown.
      name: 'comment',
      level: 'block',
      start(src) { const m = /^%%/m.exec(src); return m ? m.index : undefined; },
      tokenizer(src) {
        const m = /^%%[\s\S]*?%%[ \t]*(?:\n|$)/.exec(src);
        return m ? { type: 'comment', raw: m[0] } : undefined;
      },
      renderer: () => '',
    },
    {
      name: 'commentInline',
      level: 'inline',
      start(src) { const i = src.indexOf('%%'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^%%[\s\S]*?%%/.exec(src);
        return m ? { type: 'commentInline', raw: m[0] } : undefined;
      },
      renderer: () => '',
    },
    {
      name: 'mark',
      level: 'inline',
      start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^==([^=\n]+)==/.exec(src);
        return m ? { type: 'mark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) } : undefined;
      },
      renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
    },
    {
      // [[Note|alias]] reads as text (other notes are not part of the PDF); ![[picture.png|caption]] is the picture.
      name: 'wiki',
      level: 'inline',
      start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : i > 0 && src[i - 1] === '!' ? i - 1 : i; },
      tokenizer(src) {
        const m = /^(!?)\[\[([^\]\n]+)\]\]/.exec(src);
        return m ? { type: 'wiki', raw: m[0], embed: !!m[1], inner: m[2] } : undefined;
      },
      renderer(t) {
        const { target, heading, alias } = parseWiki(t.inner);
        if (!t.embed) return `<span class="pdf-wiki">${esc(alias || (heading ? `${target} › ${heading}` : target))}</span>`;
        if (SPINE_RX.test(target)) return `<span class="pdf-embed">🎞 ${esc(target)}</span>`;
        if (!IMG_EXT.test(target)) return `<span class="pdf-embed">↪ ${esc(alias || target)}</span>`;
        const size = /^(\d{2,4})(?:x\d{2,4})?$/.exec(alias.trim());
        return picture(resolveImage(noteKey, target, true), size ? '' : alias, size ? +size[1] : 0, target);
      },
    },
    {
      // Filled from the cached preview by decorate(); a plain link when there is none.
      name: 'card',
      renderer: (t) => `<div class="pdf-card" data-url="${escAttr(t.url)}"><a href="${escAttr(t.url)}">${esc(t.url)}</a></div>\n`,
    },
  ],
  renderer: {
    code({ text, lang }) {
      const info = (lang || '').trim();
      const head = info ? `<div class="pdf-code-head">${esc(languageLabel(info))}</div>` : '';
      return `<div class="pdf-code" data-info="${escAttr(info)}">${head}<pre><code>${esc(text)}</code></pre></div>\n`;
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const h = decodeLink(href);
      if (/^(https?:|mailto:)/i.test(h)) return `<a href="${escAttr(href)}">${inner}</a>`;
      if (/^www\./i.test(h)) return `<a href="https://${escAttr(href)}">${inner}</a>`;
      // Links to other notes and files stay text: they are not part of this PDF.
      return `<span class="pdf-wiki">${inner}</span>`;
    },
    image({ href, text }) {
      let caption = text || '';
      let width = 0;
      const m = /\|(\d{2,4})$/.exec(caption);
      if (m) { width = +m[1]; caption = caption.slice(0, m.index); }
      if (/^https?:/i.test(decodeLink(href))) return `<span class="pdf-missing">🌐 Online image (not included, MarkNotes is offline): ${esc(href)}</span>`;
      return picture(resolveAssetUrl(noteKey, href), caption, width, href);
    },
    checkbox({ checked }) {
      return `<span class="pdf-check${checked ? ' on' : ''}"></span>`;
    },
    listitem(item) {
      if (!item.task) return false;
      // Only the item's own line is struck through when it is done, not the list under it.
      const own = item.tokens.filter((t) => t.type !== 'list');
      const sub = item.tokens.filter((t) => t.type === 'list');
      return `<li class="pdf-task${item.checked ? ' done' : ''}"><div class="pdf-task-text">${this.parser.parse(own)}</div>${this.parser.parse(sub)}</li>\n`;
    },
  },
});

function markdownHtml(src, cards) {
  const tokens = md.lexer(src);
  if (cards) {
    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i].type === 'paragraph' ? tokens[i].raw.trim() : '';
      const m = raw && !raw.includes('\n') ? ALONE.exec(raw) : null;
      if (m) tokens[i] = { type: 'card', raw: tokens[i].raw, url: m[1] || m[2] };
    }
  }
  return md.parser(tokens);
}

/** The cover (front matter `banner:`) and the note title under it, like the top of the note. */
function bannerHtml(key, cover, data, title) {
  const url = resolveImage(key, cover, false);
  const y = parseFloat(data.banner_y ?? data['banner-y'] ?? data.banner_position ?? '');
  const pos = isNaN(y) ? 50 : y <= 1 ? Math.round(y * 100) : clamp(y, 0, 100);
  const date = formatBannerDate(data.datetime || data.date);
  const banner = url
    ? `<div class="pdf-banner"><img src="${escAttr(url)}" alt="" style="object-position:50% ${pos}%">${date ? `<span class="pdf-banner-date">${esc(date)}</span>` : ''}</div>`
    : '';
  return `${banner}<div class="pdf-title">${esc(title)}</div>`;
}

function linkify(src) {
  let out = '';
  let last = 0;
  for (const m of src.matchAll(URL_RX)) {
    const u = m[0];
    out += esc(src.slice(last, m.index)) + `<a href="${escAttr(/^www\./i.test(u) ? 'https://' + u : u)}">${esc(u)}</a>`;
    last = m.index + u.length;
  }
  return out + esc(src.slice(last));
}

function documentHtml(key, text, title) {
  const src = text.replace(/\r\n?/g, '\n');
  const s = settings.peek();
  // Plain .txt notes stay plain text (only web addresses are links), unless they are formatted as markdown.
  if (extOf(key) === 'txt' && !s.txtAsMarkdown) return `<pre class="pdf-txt">${linkify(src)}</pre>`;
  let body = src;
  let head = '';
  const fm = readFrontmatter(src);
  if (fm) {
    body = src.slice(fm.to);
    const cover = bannerOf(fm.data);
    if (cover) head = bannerHtml(key, cover, fm.data, title);
  }
  noteKey = key;
  return `${head}<div class="pdf-body">${markdownHtml(body, s.linkPreviews !== false)}</div>`;
}

// ───────────────────────────── link cards (cached previews only) ─────────────────────────────

function el(tag, className, parent, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function img(className, src, parent) {
  const i = el('img', className, parent);
  i.alt = '';
  i.src = src;
  return i;
}

const postDate = (iso) => {
  try { return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''; } catch { return ''; }
};

function post(info, parent) {
  const head = el('div', 'pdf-tw-head', parent);
  if (info.avatar) img('pdf-tw-avatar', info.avatar, head);
  const who = el('div', '', head);
  el('div', 'pdf-tw-name', who, info.author || '');
  if (info.handle) el('div', 'pdf-tw-handle', who, '@' + info.handle);
  if (info.text) el('div', 'pdf-tw-text', parent, info.text);
  const pics = (info.media || []).filter((m) => m.image).slice(0, 4);
  if (pics.length) {
    const grid = el('div', 'pdf-tw-media', parent);
    for (const m of pics) img('', m.image, grid);
  }
}

function card(info, url) {
  const box = el('div', 'pdf-card');
  const a = el('a', 'pdf-card-box', box);
  a.href = url;
  if (info.kind === 'tweet') {
    post(info, a);
    if (info.quote) post(info.quote, el('div', 'pdf-tw-quote', a));
    el('div', 'pdf-card-site', a, ['X', postDate(info.date)].filter(Boolean).join(' · '));
  } else {
    el('div', 'pdf-card-site', a, info.site || hostOf(url));
    el('div', 'pdf-card-title', a, info.title || url);
    if (info.image) img('pdf-card-img' + (info.kind === 'youtube' || youTubeId(url) ? ' video' : ''), info.image, a);
  }
  el('div', 'pdf-card-url', a, url);
  return box;
}

// ───────────────────────────── layout ─────────────────────────────

async function decorate(root) {
  // The code colours are the editor's highlight classes; their rules are in the page once an editor ran.
  if (appHighlight.module) StyleModule.mount(document, appHighlight.module);
  const jobs = [];
  for (const box of root.querySelectorAll('.pdf-code')) {
    const code = box.querySelector('code');
    const text = code.textContent;
    jobs.push(loadParser(box.dataset.info || '').catch(() => null).then((parser) => renderHighlighted(code, text, parser)));
  }
  for (const c of root.querySelectorAll('.pdf-card[data-url]')) {
    const url = c.dataset.url;
    jobs.push(api.call('link.cached', { url }).catch(() => null).then((info) => {
      if (info) c.replaceWith(card(info, url));
      else c.classList.add('plain');
    }));
  }
  await Promise.all(jobs);
}

/** Waits for the pictures; the ones not found on disk say so, like in the note. */
async function settle(root) {
  const imgs = [...root.querySelectorAll('img')];
  await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((done) => {
    i.addEventListener('load', done, { once: true });
    i.addEventListener('error', done, { once: true });
    setTimeout(done, 20000);
  }))));
  for (const i of imgs) {
    if (i.naturalWidth) continue;
    const banner = i.closest('.pdf-banner');
    if (banner) banner.remove();
    else if (i.dataset.link != null) (i.closest('.pdf-figure') || i).replaceWith(el('span', 'pdf-missing', null, `🖼 Image not found: ${i.dataset.link}`));
    else i.remove();
  }
  await Promise.all(imgs.filter((i) => i.isConnected).map((i) => i.decode().catch(() => {})));
  await document.fonts.ready;
}

/** Tables wider than the page (many columns pasted from Excel) are scaled down to fit instead of being cut off. */
function fitWide(root) {
  for (const t of root.querySelectorAll('table')) {
    const p = t.parentElement;
    const cs = getComputedStyle(p);
    const avail = p.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let w = t.getBoundingClientRect().width;
    // Borders stay whole pixels, so the scale goes a little under the exact ratio; never below half size.
    let z = 1;
    while (w > avail + 0.5 && z > 0.5) {
      z = Math.max(0.5, z * Math.min(0.97, 0.99 * avail / w));
      t.style.zoom = String(z);
      w = t.getBoundingClientRect().width;
    }
    // Still too wide at half size: cells may break inside words.
    if (w > avail + 0.5) t.classList.add('pdf-squeeze');
  }
}

function options() {
  const p = { ...DEFAULT_SETTINGS.pdf, ...(settings.peek().pdf || {}) };
  const [w, h] = PAPERS[p.paper] || PAPERS.a4;
  const margin = (MARGINS[p.margins] || MARGINS.normal) / 25.4;
  const [pageW, pageH] = p.landscape ? [h, w] : [w, h];
  return {
    // CSS pixels are 1/96 inch on paper.
    width: Math.floor((pageW - 2 * margin) * 96),
    height: Math.floor((pageH - 2 * margin) * 96),
    size: SIZES[p.size] || SIZES.medium,
    print: { paperWidth: w, paperHeight: h, landscape: !!p.landscape, margin, footer: p.pageNumbers ? FOOTER : null },
  };
}

async function ensureLinks(key) {
  // [[name]] lookups need the workspace's lists of notes and files.
  const ws = wsForPath(key);
  if (!ws) return;
  if (!notesByWs.peek()[ws.id]) await loadNotes(ws.id, false).catch(() => {});
  await loadFiles(ws.id).catch(() => {});
}

let busy = false;

/** Saves note `key` as a PDF where the user picks (`path`: automated tests of a scratch profile skip the picker). */
export async function saveNotePdf(key, path = null) {
  if (busy) return null;
  busy = true;
  let root = null;
  let style = null;
  let wait = null;
  const pageTitle = document.title;
  try {
    const d = docs.get(key);
    const text = d && d.loaded ? d.state.doc.toString() : (await api.call('note.read', { path: key })).text;
    const title = docTitle(key);
    const target = await api.call('pdf.choose', { name: `${title}.pdf`, dir: persisted.pdfDir || null, path });
    if (!target) return null;
    persisted.pdfDir = target.slice(0, Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/')));
    saveState();
    wait = toast('Saving PDF…', 'info', 120000);
    const o = options();
    await ensureLinks(key);
    style = el('style', '', document.head, CSS);
    root = document.createElement('div');
    root.id = 'pdf-root';
    root.className = cls(settings.peek().plainLinks !== false && 'plain-links', settings.peek().codeLineNumbers && 'code-numbers');
    root.style.width = `${o.width}px`;
    root.style.setProperty('--pdf-size', `${o.size}pt`);
    root.style.setProperty('--pdf-page-h', `${o.height}px`);
    root.innerHTML = DOMPurify.sanitize(documentHtml(key, text, title), PURIFY);
    document.body.appendChild(root);
    await decorate(root);
    await settle(root);
    fitWide(root);
    document.title = title; // the PDF's title
    await api.call('pdf.print', o.print);
    toast(`Saved as PDF: ${target}`, 'success', 6000, { label: 'Open', run: () => api.call('pdf.open') });
    return target;
  } catch (e) {
    toast('Could not save the PDF: ' + e.message, 'error', 8000);
    return null;
  } finally {
    if (wait) dismissToast(wait);
    root?.remove();
    style?.remove();
    document.title = pageTitle;
    busy = false;
  }
}

// ───────────────────────────── look (white paper) ─────────────────────────────

const TICK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5.2 12.6l4.3 4.3L18.8 7.4' fill='none' stroke='%23fff' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";

const CSS = `
#pdf-root {
  --syn-keyword: #a626a4; --syn-string: #50a14f; --syn-number: #986801; --syn-comment: #a0a1a7; --syn-function: #4078f2;
  --syn-type: #c18401; --syn-variable: #383a42; --syn-property: #0184bc; --syn-operator: #0184bc; --syn-tag: #e45649;
  --text-muted: #5f6368; --text-strong: #111; --link: #0b57d0; --danger: #d93025;
  display: flow-root; font-family: var(--font-editor); font-size: var(--pdf-size, 11pt); line-height: 1.45; color: #1a1a1a;
  background: #fff; text-align: left; white-space: normal; overflow-wrap: break-word; font-weight: 400; font-style: normal;
  letter-spacing: normal; word-spacing: normal; text-transform: none; text-shadow: none;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; color-scheme: light;
}
@media screen { #pdf-root { position: fixed; left: -10000px; top: 0; visibility: hidden; pointer-events: none; } }
@media print {
  :root { color-scheme: light !important; }
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > :not(#pdf-root) { display: none !important; }
  #pdf-root { width: auto !important; }
}
#pdf-root *, #pdf-root *::before, #pdf-root *::after { box-sizing: border-box; }
.pdf-body > :first-child { margin-top: 0 !important; }
.pdf-body h1, .pdf-body h2, .pdf-body h3, .pdf-body h4, .pdf-body h5, .pdf-body h6 { color: #111; font-weight: 700; line-height: 1.25; break-after: avoid; break-inside: avoid; }
.pdf-body h1 { font-size: 1.6em; margin: 1.1em 0 .55em; padding-bottom: .25em; border-bottom: 1.5px solid #d0d7de; }
.pdf-body h2 { font-size: 1.3em; margin: 1.15em 0 .5em; }
.pdf-body h3 { font-size: 1.12em; margin: 1em 0 .4em; }
.pdf-body h4 { font-size: 1em; margin: .9em 0 .35em; }
.pdf-body h5, .pdf-body h6 { font-size: .95em; margin: .8em 0 .3em; color: #5f6368; }
.pdf-body p { margin: 0 0 .7em; orphans: 3; widows: 3; }
.pdf-body ul, .pdf-body ol { margin: 0 0 .7em; padding-left: 1.6em; }
.pdf-body li { margin: .15em 0; break-inside: avoid; }
.pdf-body li > p { margin: 0 0 .35em; }
.pdf-body li > ul, .pdf-body li > ol { margin: .15em 0 .25em; }
.pdf-body li::marker { color: #5f6368; }
.pdf-body li.pdf-task { list-style: none; }
.pdf-body li.pdf-task > .pdf-task-text > p:last-child { margin-bottom: .35em; }
.pdf-body li.pdf-task.done > .pdf-task-text { color: #80868b; text-decoration: line-through; text-decoration-color: #9aa0a6; }
.pdf-check { display: inline-block; width: .95em; height: .95em; margin: 0 .45em 0 -1.4em; border: 1.5px solid #80868b; border-radius: 3px; vertical-align: -.13em; }
.pdf-check.on { border-color: #3c4043; background: #3c4043 ${TICK} center / 90% no-repeat; }
.pdf-body blockquote { margin: 0 0 .7em; padding: .05em 0 .05em .9em; border-left: 3px solid #d0d7de; color: #4a4f55; }
.pdf-body blockquote > :last-child { margin-bottom: 0; }
.pdf-body hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.2em 0; }
.pdf-body mark { background: #fff1a8; color: inherit; padding: 0 .1em; border-radius: 2px; }
.pdf-body kbd { font: .85em var(--font-ui); padding: .05em .35em; border: 1px solid #d0d7de; border-radius: 4px; background: #f6f8fa; color: #3c4043; }
.pdf-body code { font-family: var(--font-mono); font-size: .88em; background: #f1f3f4; border-radius: 4px; padding: .08em .3em; }
#pdf-root a, .pdf-wiki { color: #0b57d0; text-decoration: none; }
#pdf-root.plain-links a, #pdf-root.plain-links .pdf-wiki { color: inherit; }
.pdf-embed { display: inline-block; padding: .05em .55em; border: 1px solid #d0d7de; border-radius: 5px; background: #f6f8fa; color: #5f6368; font-size: .92em; }

.pdf-code { margin: .45em 0 .9em; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; }
.pdf-code-head { padding: .25em .85em; border-bottom: 1px solid #d0d7de; border-radius: 6px 6px 0 0; background: #eef1f4; color: #5f6368; font: 600 .75em var(--font-ui); text-transform: lowercase; break-after: avoid; }
.pdf-code pre { margin: 0; padding: .65em .85em; font-family: var(--font-mono); font-size: .84em; line-height: 1.45; color: #383a42; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
.pdf-code pre code { display: block; font: inherit; background: none; padding: 0; border-radius: 0; }
.pdf-code .cc-line { display: block; min-height: 1.45em; }
#pdf-root.code-numbers .pdf-code code { counter-reset: ln; }
#pdf-root.code-numbers .pdf-code .cc-line { counter-increment: ln; position: relative; padding-left: 3em; }
#pdf-root.code-numbers .pdf-code .cc-line::before { content: counter(ln); position: absolute; left: 0; width: 2.2em; text-align: right; color: #9aa0a6; }

.pdf-body table { border-collapse: collapse; width: 100%; margin: .45em 0 .9em; font-size: .92em; line-height: 1.4; }
.pdf-body th, .pdf-body td { border: 1px solid #bbb; padding: .3em .5em; vertical-align: top; text-align: left; overflow-wrap: normal; }
.pdf-body th { background: #f0f0f0; color: #111; font-weight: 650; }
.pdf-body th[align="center"], .pdf-body td[align="center"] { text-align: center; }
.pdf-body th[align="right"], .pdf-body td[align="right"] { text-align: right; }
.pdf-body thead { display: table-header-group; }
.pdf-body tr { break-inside: avoid; }
.pdf-body table.pdf-squeeze th, .pdf-body table.pdf-squeeze td { overflow-wrap: anywhere; }

.pdf-img { display: inline-block; max-width: 100%; max-height: calc(var(--pdf-page-h) - 2em); height: auto; margin: .2em 0; vertical-align: top; border-radius: 4px; break-inside: avoid; }
.pdf-figure { display: inline-flex; flex-direction: column; max-width: 100%; margin: .2em 0; padding: 2px; border-radius: 3px; background: #f1f3f4; vertical-align: top; break-inside: avoid; }
.pdf-figure img { display: block; max-width: 100%; max-height: calc(var(--pdf-page-h) - 6em); height: auto; }
.pdf-caption { display: block; width: 0; min-width: 100%; padding: var(--caption-pad, 10px) 12px; text-align: center; font-size: .9em; line-height: 1.4; color: #3c4043; overflow-wrap: anywhere; }
.pdf-caption strong, .pdf-caption b { color: #111; }
.pdf-missing { display: inline-block; padding: .25em .7em; border-radius: 5px; background: #f1f3f4; color: #5f6368; font-size: .9em; }

.pdf-banner { position: relative; height: 2.3in; margin: 0 0 .7em; border-radius: 8px; overflow: hidden; background: #f1f3f4; break-inside: avoid; }
.pdf-banner img { display: block; width: 100%; height: 100%; object-fit: cover; }
.pdf-banner-date { position: absolute; top: .6em; right: .7em; padding: .2em .75em; border-radius: 1em; background: rgba(0, 0, 0, .45); color: #fff; font: 600 .78em var(--font-ui); }
.pdf-title { margin: 0 0 .6em; color: #111; font-size: 2em; font-weight: 800; line-height: 1.2; break-after: avoid; }

.pdf-card { margin: .35em 0 .9em; break-inside: avoid; }
.pdf-card.plain { margin: 0 0 .7em; }
#pdf-root .pdf-card-box { display: flex; flex-direction: column; gap: .3em; max-width: 32em; padding: .65em .85em; border: 1px solid #d0d7de; border-left: 4px solid #9aa0a6; border-radius: 6px; background: #f8f9fa; color: inherit; }
.pdf-card-site { color: #5f6368; font-size: .8em; }
.pdf-card-title { color: #0b57d0; font-weight: 650; }
#pdf-root.plain-links .pdf-card-title { color: #111; }
.pdf-card-img { display: block; max-width: 100%; max-height: 2.4in; border-radius: 4px; align-self: flex-start; }
.pdf-card-url { color: #80868b; font-size: .75em; overflow-wrap: anywhere; }
.pdf-tw-head { display: flex; align-items: center; gap: .55em; }
.pdf-tw-avatar { width: 2.1em; height: 2.1em; border-radius: 50%; object-fit: cover; }
.pdf-tw-name { color: #111; font-weight: 650; line-height: 1.2; }
.pdf-tw-handle { color: #5f6368; font-size: .85em; line-height: 1.2; }
.pdf-tw-text { white-space: pre-wrap; }
.pdf-tw-media { display: flex; flex-wrap: wrap; gap: 4px; }
.pdf-tw-media img { display: block; max-width: 100%; max-height: 2.2in; border-radius: 4px; }
.pdf-tw-quote { display: flex; flex-direction: column; gap: .3em; padding: .45em .7em; border: 1px solid #d0d7de; border-radius: 6px; font-size: .92em; }

.pdf-txt { margin: 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; orphans: 3; widows: 3; }
`;
