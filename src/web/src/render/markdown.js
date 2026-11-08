// Markdown → safe HTML for read-only views (canvas cards, the Workspace Guide), with Obsidian's
// [[links]] and ![[image]] embeds. marked + DOMPurify, loaded only with the views that need them.

import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { resolveImage } from '../docs.js';

const IMG_RX = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

// ───────────────────────────── markdown in text cards ─────────────────────────────

let renderKey = '';
const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [{
    name: 'wiki',
    level: 'inline',
    start: (src) => { const i = src.indexOf('[['); return i < 0 ? undefined : i > 0 && src[i - 1] === '!' ? i - 1 : i; },
    tokenizer(src) {
      const m = /^(!?)\[\[([^\]\n]+)\]\]/.exec(src);
      if (m) return { type: 'wiki', raw: m[0], embed: !!m[1], inner: m[2] };
      return undefined;
    },
    renderer(tok) {
      const bar = tok.inner.indexOf('|');
      const target = (bar >= 0 ? tok.inner.slice(0, bar) : tok.inner).trim();
      const alias = bar >= 0 ? tok.inner.slice(bar + 1) : '';
      if (tok.embed && IMG_RX.test(target)) {
        const url = resolveImage(renderKey, target, true);
        const w = /^\d{2,4}$/.test(alias.trim()) ? ` width="${+alias.trim()}"` : '';
        if (url) return `<img src="${escAttr(url)}" alt=""${w} loading="lazy" decoding="async">`;
        return `<span class="cv-missing">${escHtml(target)}</span>`;
      }
      const label = alias || target.replace('#', ' › ');
      return `<a class="internal-link" data-wiki="${escAttr(target.split('#')[0])}">${escHtml(label)}</a>`;
    },
  }],
  renderer: {
    image({ href, text }) {
      const url = /^https?:/i.test(href) ? null : resolveImage(renderKey, href, false);
      return url ? `<img src="${escAttr(url)}" alt="${escAttr(text || '')}" loading="lazy" decoding="async">` : `<span class="cv-missing">${escHtml(text || href)}</span>`;
    },
  },
});
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');

export function renderMarkdown(text, key) {
  renderKey = key;
  const html = md.parse(String(text || '').replace(/==([^=\n]+)==/g, '<mark>$1</mark>'));
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-wiki', 'loading', 'decoding'], FORBID_TAGS: ['style', 'form', 'input', 'button'] });
}
