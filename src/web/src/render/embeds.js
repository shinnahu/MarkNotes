// Playable link previews, shared by note link cards and canvas link cards:
//  • X posts: MarkNotes' own post card (author, text, pictures, quoted post) with a native video player,
//  • YouTube: the thumbnail, then the privacy-mode player (youtube-nocookie) in place on Play,
//  • other pages: title, site and picture.
// Web videos play inside MarkNotes while "Play web videos inside MarkNotes" is on (otherwise Play opens
// the browser). Local video/audio files of canvases play the same way.

import { settings, updateSettings } from '../store.js';
import { icon } from '../editor/domicons.js';

export const embedsOn = () => settings.peek().webEmbeds !== false;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; }
};
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K` : (n || 0).toLocaleString());
export const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };

const YT_RX = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
export const youTubeId = (url) => (YT_RX.exec(url || '') || [])[1] || null;
export const isTweetUrl = (url) => /(?:^|\/\/)(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[^/?#]+|i(?:\/web)?)\/status(?:es)?\/\d{5,25}/i.test(url || '');

/** Post text with clickable links, @mentions and #hashtags (they open in the browser). */
function tweetHtml(text) {
  return esc(text)
    .replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<span class="mn-link" data-href="${u}">${u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</span>`)
    .replace(/(^|[^\w/])@(\w{1,15})/g, (_, pre, h) => `${pre}<span class="mn-link" data-href="https://x.com/${h}">@${h}</span>`)
    .replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, (_, pre, tag) => `${pre}<span class="mn-link" data-href="https://x.com/hashtag/${encodeURIComponent(tag)}">#${tag}</span>`)
    .replace(/\n/g, '<br>');
}

function playButton(parent, kind, title) {
  const b = el('button', `mn-play ${kind}`, parent);
  b.type = 'button';
  b.title = title;
  return b;
}

function poster(fig, src, fit, onLoad) {
  const img = el('img', 'mn-poster' + (fit ? ' ' + fit : ''), fig);
  img.decoding = 'async';
  img.draggable = false;
  img.alt = '';
  img.addEventListener('load', () => { fig.classList.add('loaded'); onLoad && onLoad(); });
  img.addEventListener('error', () => fig.classList.add('loaded', 'broken'));
  img.src = src;
  return img;
}

// Play starts sooner when the connection to X's video server is already open and the first seconds
// are already loading: the pointer resting on a video starts that (nothing loads for videos never pointed at).
let warmed = false;
function warmVideoHost() {
  if (warmed || !embedsOn()) return;
  warmed = true;
  const l = document.createElement('link');
  l.rel = 'preconnect';
  l.href = 'https://video.twimg.com';
  document.head.appendChild(l);
}

function prepareVideo(fig, src) {
  if (fig._prepared || !embedsOn()) return;
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = src;
  fig._prepared = v;
}

// ── volume ──
// Every video MarkNotes plays goes through one volume (Settings › Editor › Video volume): web videos are mixed
// loud, nothing turns the loud ones down here the way YouTube's site does, and Windows gives MarkNotes its own
// level (100% at first) in the volume mixer. The setting is perceptual (50% sounds about half as loud as 100%).
// YouTube players get it as their volume; for other videos it is a gain under the player's own slider, and
// that slider is remembered from one video (and session) to the next.
let audioCtx = null;
const gains = new Set();
const ytFrames = new Set();
const masterVolume = () => {
  const p = Math.max(0, Math.min(100, Number(settings.peek().videoVolume ?? 35))) / 100;
  return p * p;
};
let saveTimer = 0;

/** Sends a video's sound through the app's volume (only when it loaded with CORS: otherwise it would be silenced). */
function routeVolume(v) {
  if (v._mnGain || !v.crossOrigin || (v.muted && v.loop)) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const src = audioCtx.createMediaElementSource(v);
    const g = audioCtx.createGain();
    g.gain.value = masterVolume();
    src.connect(g);
    g.connect(audioCtx.destination);
    v._mnGain = g;
    gains.add(g);
  } catch { /* it plays at its own volume */ }
}

/** As soon as the video's data is known to be readable, its sound goes through the app's volume. */
function useAppVolume(v) {
  if (v.readyState >= 1) routeVolume(v);
  else v.addEventListener('loadedmetadata', () => routeVolume(v), { once: true });
  const kept = Number(settings.peek().videoPlayerVolume);
  if (kept >= 0 && kept <= 1) v.volume = kept;
  v.addEventListener('volumechange', () => {
    if (v.muted) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (settings.peek().videoPlayerVolume !== v.volume) updateSettings({ videoPlayerVolume: v.volume }); }, 400);
  });
}

/** Tells a YouTube player (IFrame API) the app's video volume. */
function sendYouTubeVolume(frame) {
  if (!frame.isConnected) { ytFrames.delete(frame); return; }
  try {
    frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [Math.round(masterVolume() * 100)] }), 'https://www.youtube-nocookie.com');
  } catch { /* not loaded yet */ }
}

/** Settings › Video volume changed: the videos already playing follow. */
export function applyVideoVolume() {
  const vol = masterVolume();
  for (const g of gains) g.gain.value = vol;
  for (const f of [...ytFrames]) sendYouTubeVolume(f);
}

/**
 * A click on the picture plays or pauses at once. (Left to the browser, Play waits about 0.3 s to see whether
 * the click is the start of a double-click.) The controls bar works as usual.
 */
function instantToggle(v) {
  v.addEventListener('click', (e) => {
    const r = v.getBoundingClientRect();
    if (e.clientY > r.bottom - 52) return;
    e.preventDefault();
    if (v.paused || v.ended) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
  });
  // Double-clicking does not go full screen (the player's own button does).
  v.addEventListener('dblclick', (e) => e.preventDefault());
}

/** Starts a web/local video in place of its poster. */
function playVideo(fig, src, { posterUrl, gif = false, onFail } = {}) {
  fig.querySelectorAll('.mn-play, .mn-poster, .mn-badge').forEach((x) => x.remove());
  const ready = fig._prepared && fig._prepared.getAttribute('src') === src ? fig._prepared : null;
  fig._prepared = null;
  const v = ready || document.createElement('video');
  v.className = 'mn-player';
  fig.appendChild(v);
  v.playsInline = true;
  v.preload = 'auto';
  if (!ready) v.crossOrigin = 'anonymous';
  if (posterUrl) v.poster = posterUrl;
  if (gif) {
    // X "GIFs" are short silent videos that loop; a click pauses / resumes.
    v.muted = true;
    v.loop = true;
    v.addEventListener('click', (e) => { e.stopPropagation(); if (v.paused) v.play(); else v.pause(); });
  } else {
    v.controls = true;
    instantToggle(v);
    useAppVolume(v);
  }
  v.addEventListener('error', () => {
    // A server that refuses CORS: play it plainly (at its own volume) rather than not at all.
    if (v.crossOrigin && !v._plain) {
      v._plain = true;
      v.removeAttribute('crossorigin');
      v.src = src;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      return;
    }
    if (onFail) onFail();
  });
  if (!ready) v.src = src;
  else if (v.error) { onFail && onFail(); return v; }
  fig.classList.add('playing', 'loaded');
  const p = v.play();
  if (p && p.catch) p.catch(() => { /* the user can press play */ });
  return v;
}

function mediaFail(fig, url) {
  fig.innerHTML = '<div class="mn-media-error">This video could not be played here.' +
    (url ? `<br><span class="mn-link" data-href="${esc(url)}">Open it in the browser</span>` : '') + '</div>';
}

/**
 * Pictures and videos of a post: 1 fills the box, 2 side by side, 3 one big + two, 4 a 2×2 grid.
 * Videos show their poster and a Play button; they play here (or open the post when embeds are off).
 */
function mediaGrid(parent, list, url, opts) {
  const grid = el('div', `mn-grid n${Math.min(list.length, 4)}`, parent);
  const single = list.length === 1;
  if (single && list[0].ratio > 0 && !opts.fill) {
    const r = Math.max(0.56, Math.min(2.4, list[0].ratio));
    grid.style.aspectRatio = String(r);
    // Tall videos get a narrower box (at most 520 px high in notes), like on X.
    if (r < 1) grid.style.width = `min(100%, ${Math.round(520 * r)}px)`;
  }
  list.slice(0, 4).forEach((m) => {
    const fig = el('div', 'mn-media ' + (m.kind === 'photo' ? 'photo' : 'video'), grid);
    if (m.image) poster(fig, m.image, m.kind === 'photo' && !single ? 'cover' : '', opts.onResize);
    else fig.classList.add('loaded');
    if (m.kind === 'photo') return;
    if (m.kind === 'gif') el('span', 'mn-badge', fig).textContent = 'GIF';
    if (!m.video) return;
    warmVideoHost();
    // Resting on the post (not only on the video) starts loading its first video.
    const card = parent.closest('.mn-embed') || fig;
    let hover = 0;
    const warm = () => { clearTimeout(hover); hover = setTimeout(() => prepareVideo(fig, m.video), 90); };
    if (!card._warmFig) { card._warmFig = fig; card.addEventListener('pointerenter', () => card._warmFig && warm()); card.addEventListener('pointerleave', () => clearTimeout(hover)); }
    fig.addEventListener('pointerenter', warm);
    const play = playButton(fig, 'x', embedsOn() ? 'Play' : 'Open in the browser');
    play.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!embedsOn()) { opts.open(url); return; }
      playVideo(fig, m.video, { posterUrl: m.image, gif: m.kind === 'gif', onFail: () => mediaFail(fig, url) });
      opts.onPlay && opts.onPlay();
    });
  });
  return grid;
}

/**
 * Fills `box` with the preview of `url` (info from the host's link.preview, or null).
 * opts: { fill (canvas: the card fills the node), openLink(url), onResize(), onPlay() }.
 */
export function renderEmbed(box, info, url, opts = {}) {
  box.innerHTML = '';
  const o = { ...opts, open: (u) => (opts.openLink ? opts.openLink(u) : window.open(u)) };
  const root = el('div', 'mn-embed' + (opts.fill ? ' fill' : ''), box);
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-href]');
    if (a && root.contains(a)) { e.preventDefault(); e.stopPropagation(); o.open(a.getAttribute('data-href')); }
  });
  if (!info) {
    // Previews off or not fetched: YouTube still plays from its address.
    const id = youTubeId(url);
    if (id) renderYouTube(root, { videoId: id, title: url, site: 'YouTube' }, url, o);
    else renderPlain(root, url);
    return root;
  }
  if (info.kind === 'tweet') renderTweet(root, info, url, o);
  else if (info.failed) renderPlain(root, url);
  else if ((info.kind === 'youtube' && info.videoId) || youTubeId(url)) renderYouTube(root, { ...info, videoId: info.videoId || youTubeId(url) }, url, o);
  else renderPage(root, info, url, o);
  return root;
}

function renderPlain(root, url) {
  root.classList.add('mn-page', 'plain');
  const site = el('div', 'mn-site', root);
  site.appendChild(icon('globe', 14));
  site.appendChild(document.createTextNode(' ' + hostOf(url)));
  const t = el('div', 'mn-title mn-link', root);
  t.textContent = url;
  t.dataset.href = url;
}

function renderPage(root, info, url, o) {
  root.classList.add('mn-page');
  const text = el('div', 'mn-page-text', root);
  el('div', 'mn-site', text).textContent = info.site || hostOf(url);
  const t = el('div', 'mn-title mn-link', text);
  t.textContent = info.title || url;
  t.dataset.href = url;
  if (info.image) {
    const fig = el('div', 'mn-media mn-page-img', root);
    poster(fig, `${info.image}?w=${o.fill ? 1024 : 640}`, 'cover', o.onResize).addEventListener('error', () => { fig.remove(); o.onResize && o.onResize(); });
    fig.dataset.href = url;
  }
}

function renderYouTube(root, info, url, o) {
  root.classList.add('mn-yt');
  const fig = el('div', 'mn-media mn-video', root);
  if (info.image) poster(fig, info.image, 'cover', o.onResize);
  else fig.classList.add('loaded');
  const foot = el('div', 'mn-yt-foot', root);
  const t = el('div', 'mn-title mn-link', foot);
  t.textContent = info.title || url;
  t.dataset.href = url;
  el('div', 'mn-site', foot).textContent = info.site || 'YouTube';
  const play = playButton(fig, 'yt', embedsOn() ? 'Play' : 'Open in the browser');
  play.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!embedsOn()) { o.open(url); return; }
    fig.innerHTML = '';
    const start = /[?&#]t=(\d+)/.exec(url);
    // Everything is set before the frame joins the page: YouTube refuses to play (error 153) when the
    // request has no referrer, and the app page sends none by default (see index.html).
    const frame = el('iframe', 'mn-frame');
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.title = info.title || 'YouTube video';
    // enablejsapi: the player accepts the app's volume (sent a few times while it starts up).
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(info.videoId)}?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}${start ? '&start=' + start[1] : ''}`;
    ytFrames.add(frame);
    frame.addEventListener('load', () => { for (const ms of [0, 400, 1000, 2000, 3500]) setTimeout(() => sendYouTubeVolume(frame), ms); });
    fig.appendChild(frame);
    fig.classList.add('playing', 'loaded');
    o.onPlay && o.onPlay();
    o.onResize && o.onResize();
  });
}

function postHead(parent, info, url, small) {
  const head = el('div', 'mn-tweet-head' + (small ? ' small' : ''), parent);
  if (info.avatar) {
    const av = el('img', 'mn-avatar', head);
    av.src = info.avatar;
    av.draggable = false;
    av.alt = '';
  } else el('span', 'mn-avatar empty', head);
  const who = el('div', 'mn-tweet-who', head);
  who.innerHTML = `<div class="mn-tweet-name"><span class="mn-ellipsis">${esc(info.author || '')}</span>${info.verified ? '<span class="mn-verified" title="Verified account"></span>' : ''}</div>` +
    `<div class="mn-tweet-handle mn-link" data-href="https://x.com/${esc(info.handle || '')}">@${esc(info.handle || '')}</div>`;
  if (!small) {
    const x = el('span', 'mn-x mn-link', head);
    x.textContent = '𝕏';
    x.title = 'Open on X';
    x.dataset.href = url;
  }
  return head;
}

function renderTweet(root, info, url, o) {
  root.classList.add('mn-tweet');
  if (info.failed) {
    root.classList.add('unavailable');
    const box = el('div', 'mn-tweet-gone', root);
    el('span', 'mn-x', box).textContent = '𝕏';
    el('div', 'mn-gone-text', box).textContent = info.title || 'This post is unavailable.';
    const a = el('div', 'mn-link mn-gone-link', box);
    a.textContent = 'View on X';
    a.dataset.href = url;
    return;
  }
  const media = info.media || [];
  const quote = info.quote;
  if (!media.length && !(quote && quote.media && quote.media.length)) root.classList.add('no-media');
  postHead(root, info, url, false);
  if (info.text) el('div', 'mn-tweet-text', root).innerHTML = tweetHtml(info.text);
  if (media.length) mediaGrid(root, media, url, o);
  if (quote) {
    const q = el('div', 'mn-quote' + (quote.media && quote.media.length ? ' has-media' : ''), root);
    postHead(q, quote, quote.url || url, true);
    if (quote.text) el('div', 'mn-tweet-text', q).innerHTML = tweetHtml(quote.text);
    if (quote.media && quote.media.length) mediaGrid(q, quote.media, quote.url || url, o);
  }
  const foot = el('div', 'mn-tweet-foot', root);
  foot.innerHTML = `<span class="mn-date">${esc(info.date ? fmtDate(info.date) : '')}</span>` +
    (info.likes ? `<span class="mn-likes" title="Likes">♥ ${fmtCount(info.likes)}</span>` : '') +
    `<span class="mn-link mn-open" data-href="${esc(url)}">Open on X</span>`;
}

/** A video or audio file of a canvas: its first frame (or a music card) and a Play button. */
export function renderLocalMedia(box, src, kind, name, opts = {}) {
  box.innerHTML = '';
  const root = el('div', 'mn-embed fill mn-local ' + kind, box);
  if (kind === 'audio') {
    const head = el('div', 'mn-audio-head', root);
    head.appendChild(icon('music', 22));
    el('span', 'mn-ellipsis', head).textContent = name;
    const a = el('audio', 'mn-audio', root);
    a.controls = true;
    a.preload = 'metadata';
    a.crossOrigin = 'anonymous';
    a.src = src;
    a.addEventListener('play', () => useAppVolume(a), { once: true });
    return root;
  }
  const fig = el('div', 'mn-media mn-video', root);
  const v = el('video', 'mn-player mn-first-frame', fig);
  v.preload = 'metadata';
  v.muted = true;
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  instantToggle(v);
  v.src = `${src}#t=0.1`;
  v.addEventListener('loadeddata', () => fig.classList.add('loaded'), { once: true });
  v.addEventListener('error', () => { fig.classList.add('loaded'); mediaFail(fig, ''); }, { once: true });
  const play = playButton(fig, 'x', 'Play');
  play.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    play.remove();
    v.classList.remove('mn-first-frame');
    v.muted = false;
    v.controls = true;
    useAppVolume(v);
    v.play().catch(() => {});
    opts.onPlay && opts.onPlay();
  });
  return root;
}

/** Styles of the previews (the canvas lives in a shadow root and gets its own copy). */
export const EMBED_CSS = `
.mn-embed { font-family: var(--font-ui); line-height: 1.4; color: var(--text); box-sizing: border-box; text-align: left; }
.mn-embed *, .mn-embed *::before, .mn-embed *::after { box-sizing: border-box; }
.mn-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mn-link { cursor: pointer; color: var(--link); }
.mn-link:hover { text-decoration: underline; text-underline-offset: 2px; }
.mn-site { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mn-title { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.mn-title.mn-link { color: var(--text-strong, var(--text)); }
.mn-media { position: relative; overflow: hidden; background: #000; min-height: 0; }
.mn-media .mn-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; opacity: 0; transition: opacity .3s ease; }
.mn-media .mn-poster.cover { object-fit: cover; }
.mn-media.loaded .mn-poster { opacity: 1; }
.mn-media.broken .mn-poster { display: none; }
.mn-media.photo { background: var(--bg-code, #111); }
.mn-frame, .mn-player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #000; object-fit: contain; }
.mn-play { position: absolute; left: 50%; top: 50%; width: 68px; height: 48px; margin: -24px 0 0 -34px; border: 0; padding: 0; border-radius: 14px; cursor: pointer;
  background: rgba(0, 0, 0, .65); transition: transform .12s ease, filter .12s ease; z-index: 1; }
.mn-play.yt { background: rgba(255, 0, 0, .92); }
.mn-play.x { width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%; background: #1d9bf0; box-shadow: 0 0 0 4px rgba(255, 255, 255, .9), 0 4px 18px rgba(0, 0, 0, .45); }
.mn-play::after { content: ""; position: absolute; left: 50%; top: 50%; margin: -11px 0 0 -6px; border-style: solid; border-width: 11px 0 11px 19px; border-color: transparent transparent transparent #fff; }
.mn-play:hover { transform: scale(1.08); filter: brightness(1.08); }
.mn-badge { position: absolute; left: 10px; bottom: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(0, 0, 0, .7); color: #fff; font: 700 12px var(--font-ui); letter-spacing: .5px; z-index: 1; }
.mn-media-error { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; padding: 16px; color: #ddd; font-size: 13px; line-height: 1.6; background: #000; }

/* pages */
.mn-page-text { min-width: 0; }
.mn-page-img { margin-top: 8px; border-radius: 8px; background: var(--bg-code, #111); cursor: pointer; }
.mn-page.plain .mn-title { font-weight: 500; }

/* YouTube */
.mn-yt .mn-video { border-radius: 8px; aspect-ratio: 16 / 9; }
.mn-yt-foot { margin-top: 8px; min-width: 0; }
.mn-yt-foot .mn-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* X posts */
.mn-tweet-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mn-avatar { width: 42px; height: 42px; border-radius: 50%; flex: none; object-fit: cover; background: var(--bg-hover, #333); }
.mn-tweet-head.small .mn-avatar { width: 22px; height: 22px; }
.mn-tweet-head.small { gap: 6px; }
.mn-tweet-head.small .mn-tweet-who { display: flex; align-items: baseline; gap: 6px; }
.mn-tweet-who { flex: 1; min-width: 0; }
.mn-tweet-name { font-weight: 700; color: var(--text-strong, var(--text)); display: flex; align-items: center; gap: 4px; min-width: 0; }
.mn-verified { display: inline-block; width: 16px; height: 16px; border-radius: 50%; background: #1d9bf0; position: relative; flex: none; }
.mn-verified::after { content: ""; position: absolute; left: 5.5px; top: 2.5px; width: 3.5px; height: 7.5px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.mn-tweet-handle, .mn-tweet-handle.mn-link { font-size: 13.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mn-x { font-size: 22px; font-weight: 700; line-height: 1; color: var(--text-strong, var(--text)); flex: none; }
.mn-x.mn-link:hover { text-decoration: none; opacity: .75; }
.mn-tweet-text { margin-top: 10px; font-size: 15px; white-space: normal; overflow-wrap: anywhere; color: var(--text); }
.mn-grid { display: grid; gap: 2px; margin-top: 10px; border-radius: 14px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent); background: #000; }
.mn-grid.n1 { grid-template-columns: 1fr; }
.mn-grid.n2 { grid-template-columns: 1fr 1fr; aspect-ratio: 16 / 9; }
.mn-grid.n3 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; aspect-ratio: 16 / 9; }
.mn-grid.n3 > :first-child { grid-row: span 2; }
.mn-grid.n4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; aspect-ratio: 16 / 9; }
.mn-grid.n1 > .mn-media { height: 100%; min-height: 120px; }
.mn-quote { margin-top: 10px; padding: 10px 12px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent); min-width: 0; }
.mn-quote .mn-tweet-text { margin-top: 6px; font-size: 14px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.mn-quote .mn-grid { margin-top: 8px; border-radius: 10px; }
.mn-tweet-foot { display: flex; align-items: center; gap: 14px; margin-top: 10px; font-size: 12.5px; color: var(--text-muted); flex-wrap: wrap; }
.mn-likes { color: #f91880; }
.mn-open { margin-left: auto; }
.mn-tweet-gone { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 18px; color: var(--text-muted); }
.mn-tweet-gone .mn-x { font-size: 30px; }
.mn-gone-text { font-size: 15px; color: var(--text); max-width: 380px; }

/* filling a canvas node */
.mn-embed.fill { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; }
.mn-embed.fill.mn-tweet { padding: 14px 16px 10px; }
.mn-embed.fill.mn-tweet .mn-tweet-text { flex: none; display: -webkit-box; -webkit-line-clamp: 7; -webkit-box-orient: vertical; overflow: hidden; }
.mn-embed.fill.mn-tweet.no-media > .mn-tweet-text { flex: 1 1 auto; -webkit-line-clamp: unset; display: block; overflow: hidden; }
.mn-embed.fill .mn-grid { flex: 3 1 0; min-height: 90px; aspect-ratio: auto; }
.mn-embed.fill .mn-quote { flex: 0 1 auto; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.mn-embed.fill .mn-quote.has-media { flex: 2 1 0; }
.mn-embed.fill .mn-quote .mn-grid { flex: 1 1 0; min-height: 60px; }
.mn-embed.fill .mn-tweet-foot { flex: none; }
.mn-embed.fill.mn-tweet.unavailable { justify-content: center; }
.mn-embed.fill.mn-yt .mn-video, .mn-embed.fill.mn-local .mn-video { flex: 1 1 0; aspect-ratio: auto; border-radius: 0; }
.mn-embed.fill.mn-yt .mn-yt-foot { flex: none; margin: 0; padding: 8px 12px 10px; border-top: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent); }
.mn-embed.fill.mn-page .mn-page-text { order: 2; flex: none; padding: 8px 12px 10px; border-top: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent); }
.mn-embed.fill.mn-page .mn-page-text .mn-title { font-size: 14px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mn-embed.fill.mn-page .mn-page-img { order: 1; flex: 1 1 0; margin: 0; border-radius: 0; }
.mn-embed.fill.mn-page.plain { justify-content: center; align-items: center; text-align: center; padding: 14px; gap: 6px; }
.mn-local .mn-first-frame { pointer-events: none; }
.mn-local.audio { justify-content: center; gap: 12px; padding: 14px 16px; }
.mn-audio-head { display: flex; align-items: center; gap: 10px; font-weight: 650; color: var(--text-strong, var(--text)); min-width: 0; }
.mn-audio { width: 100%; }
`;

let injected = false;
/** Adds the preview styles to the app page once (notes use them outside the canvas). */
export function injectEmbedCss() {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'mn-embed-css';
  s.textContent = EMBED_CSS;
  document.head.appendChild(s);
}
