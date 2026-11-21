// Link previews (title + thumbnail), fetched by the host once per link and kept on disk.
// Each document tells the host which links it uses (sync), so previews of removed links are
// deleted and adding the link again downloads a fresh preview.

import * as api from './api.js';
import { settings, toast } from './store.js';

const pending = new Map(); // `${doc}\n${url}` → Promise<info|null>
const timers = new Map();

export const linkPreviewsOn = () => settings.peek().linkPreviews !== false;

/** {url, title, site, image, failed, kind, …} or null. */
export function getPreview(url, doc) {
  if (!linkPreviewsOn()) return Promise.resolve(null);
  const k = `${doc}\n${url}`;
  let p = pending.get(k);
  if (!p) {
    p = api.call('link.preview', { url, doc }).catch(() => null);
    pending.set(k, p);
    // What could not be fetched is asked again next time (the host decides when to try the site again).
    p.then((info) => { if ((!info || info.failed) && pending.get(k) === p) pending.delete(k); });
  }
  return p;
}

export function refreshLinkPreview(url, doc) {
  const p = api.call('link.refresh', { url, doc }).catch(() => null);
  pending.set(`${doc}\n${url}`, p);
  return p;
}

/**
 * "Open image" on a picture of an X post (pic from embeds.js pictureAt): X's large version opens in the usual
 * picture program. The host downloads it once and keeps it with the saved post.
 */
export function openPostPicture(url, pic) {
  return api.call('link.openImage', { url, quote: pic.quote, index: pic.index }).then((r) => {
    if (r && r.fallback) toast('X no longer has the large picture, so the saved one opened', 'info', 4500);
    else if (!r || !r.opened) toast('This picture was not saved', 'warning');
  }).catch((e) => toast('Could not open the picture: ' + e.message, 'error'));
}

/** The links a document uses right now (debounced). */
export function syncPreviews(doc, urls) {
  if (!doc || !linkPreviewsOn()) return;
  clearTimeout(timers.get(doc));
  const list = [...new Set(urls)];
  timers.set(doc, setTimeout(() => {
    timers.delete(doc);
    for (const k of [...pending.keys()]) if (k.startsWith(doc + '\n') && !list.includes(k.slice(doc.length + 1))) pending.delete(k);
    api.call('link.sync', { doc, urls: list }).catch(() => {});
  }, 1500));
}

/** A document got a new path: keep its previews. */
export function renamePreviewDoc(from, to) {
  for (const [k, p] of [...pending]) {
    if (k.startsWith(from + '\n')) {
      pending.delete(k);
      pending.set(to + k.slice(from.length), p);
    }
  }
  api.call('link.rename', { from, to }).catch(() => {});
}

export const isYouTube = (url) => /(?:youtube\.com\/(?:watch|shorts|embed|live)|youtu\.be\/)/i.test(url || '');
