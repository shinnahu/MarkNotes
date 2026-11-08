// Small shared helpers.

export const isAbs = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** Normalises a path to forward slashes. */
export const fwd = (p) => (p || '').replace(/\\/g, '/');

export function dirname(p) {
  const f = fwd(p);
  const i = f.lastIndexOf('/');
  return i < 0 ? '' : f.slice(0, i);
}

export function basename(p) {
  const f = fwd(p);
  return f.slice(f.lastIndexOf('/') + 1);
}

export function stem(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

export function extOf(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/** Posix-style join + normalise ("a/b", "../c") → "a/c". Keeps a drive prefix. */
export function joinPath(base, rel) {
  const parts = (fwd(base) ? fwd(base) + '/' : '') + fwd(rel);
  const out = [];
  for (const seg of parts.split('/')) {
    if (seg === '' || seg === '.') { if (out.length === 0 && seg === '') out.push(''); continue; }
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..' && !/^[a-zA-Z]:$/.test(out[out.length - 1])) out.pop(); else out.push('..'); continue; }
    out.push(seg);
  }
  return out.join('/').replace(/^\/(?=[a-zA-Z]:)/, '');
}

export function decodeLink(dest) {
  let d = (dest || '').trim();
  if (d.startsWith('<') && d.endsWith('>')) d = d.slice(1, -1);
  try { return decodeURIComponent(d); } catch { return d; }
}

export function encodeLink(rel) {
  return fwd(rel).replace(/%/g, '%25').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
}

export const FILES_HOST = 'https://files.marknotes.example';

/** URL the WebView can load for a link found inside a note. */
export function resolveAssetUrl(noteKey, link) {
  const dec = decodeLink(link);
  if (/^data:image\//i.test(dec)) return dec;
  if (/^https?:\/\//i.test(dec)) return null; // offline app: remote images are not fetched
  let target;
  if (/^[a-zA-Z]:[\\/]/.test(dec)) target = fwd(dec);
  else if (/^file:\/\/\//i.test(dec)) target = fwd(dec.slice(8));
  else target = joinPath(dirname(noteKey), dec);
  const enc = target.split('/').map(encodeURIComponent).join('/');
  return `${FILES_HOST}/${isAbs(target) ? 'a' : 'r'}/${enc}`;
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

export function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

export const cls = (...a) => a.filter(Boolean).join(' ');

export function relTime(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const dt = new Date(ms);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fullDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Title for a note, taken from its first meaningful line. */
export function deriveTitle(text, maxLen = 60) {
  let src = text || '';
  // Front matter (cover, date, tags…) is not the title.
  const fm = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (fm) src = src.slice(fm[0].length);
  for (const raw of src.split('\n')) {
    let line = raw.trim();
    if (!line || /^(```|~~~)/.test(line) || /^[-*_=]{3,}$/.test(line) || /^!\[/.test(line)) continue;
    line = line.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '').replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '').replace(/^\d+[.)]\s+/, '');
    line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ');
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.length > maxLen) {
      const cut = line.slice(0, maxLen);
      const sp = cut.lastIndexOf(' ');
      line = (sp > 20 ? cut.slice(0, sp) : cut).trim();
    }
    return line.replace(/[. ]+$/, '');
  }
  return '';
}

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function initials(name) {
  const words = (name || '?').trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return [...words[0]][0].toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('');
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Square, centred thumbnail for workspace pictures (keeps files small). */
export async function makeAvatar(file, size = 256) {
  const url = await readFileAsDataUrl(file);
  if (/^data:image\/(gif|svg)/.test(url)) return url; // keep animations / vectors as they are
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(size, s);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/** Banner image: GIF/WebP kept as they are (animation), big photos scaled down to `maxW` pixels wide. */
export async function makeBanner(file, maxW = 1200) {
  const url = await readFileAsDataUrl(file);
  if (/^data:image\/(gif|webp|svg)/.test(url)) return url;
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = url;
  });
  if (img.naturalWidth <= maxW) return url;
  const c = document.createElement('canvas');
  c.width = maxW;
  c.height = Math.round(img.naturalHeight * maxW / img.naturalWidth);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  return /^data:image\/jpe?g/.test(url) ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png');
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
}
