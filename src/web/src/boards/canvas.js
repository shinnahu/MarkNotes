// Canvas board: the JSON Canvas format (.canvas files of Obsidian), as a light, Miro-like infinite
// board with text cards, images, notes, web links, groups and arrows.
//
// Plain DOM inside a shadow root: the vault's CSS snippets (e.g. the .title / .subtitle classes
// people use in Obsidian canvases) apply to the board without leaking into the app. The .canvas
// text stays the source of truth: every change is written back to the document, so autosave,
// undo/redo (Ctrl+Z) and "Edit as text" keep working.

import { getDocText, setDocText, watchDoc, openWiki, openLink, openNote, saveImage } from '../docs.js';
import * as ed from '../editor/editor.js';
import { resolveName, fileUrl, onLinksChanged, invalidateFiles, loadFiles } from '../links.js';
import { wsForPath, findNote, persisted, saveState, toast, settings, updateSettings, notesByWs, loadNotes, workspaces, mainView, upsertNote, redoKeyLabel } from '../store.js';
import { openMenu } from '../ui/menu.jsx';
import { prompt } from '../ui/dialogs.jsx';
import { pickFrom } from '../ui/Picker.jsx';
import { icon } from '../editor/domicons.js';
import { isAbs, joinPath, dirname, readFileAsDataUrl } from '../util.js';
import * as api from '../api.js';
import { CANVAS_CSS } from './canvascss.js';
import { renderMarkdown } from '../render/markdown.js';
import { getPreview, refreshLinkPreview, syncPreviews, linkPreviewsOn } from '../previews.js';
import { renderEmbed, renderLocalMedia, EMBED_CSS, youTubeId, isTweetUrl, hostOf } from '../render/embeds.js';
import { mountSpine, SPINE_CSS, SPINE_RX } from '../render/spine.js';
import { parseCanvas, stringifyCanvas } from './canvasfmt.js';
import { editorMenuItems } from '../editor/editmenu.js';
import { spreadsheetRows, rowsToMarkdown } from '../editor/tablemd.js';
import { SHAPES, SHAPE, isShape, shapeSvg, shapeIcon } from './shapes.js';
import { renameNote, moveNote } from '../actions.js';
import { revealInSidebar } from '../ui/Sidebar.jsx';

export { parseCanvas, stringifyCanvas };

// Obsidian's six preset colours ("1"…"6"); any other value is a CSS colour.
export const PRESETS = ['#fb464c', '#e9973f', '#e0de71', '#44cf6e', '#53dfdd', '#a882ff'];
const colorOf = (c) => (!c ? null : /^[1-6]$/.test(String(c)) ? PRESETS[+c - 1] : c);
const presetOf = (hex) => {
  const i = PRESETS.findIndex((p) => p.toLowerCase() === String(hex || '').toLowerCase());
  return i >= 0 ? String(i + 1) : hex;
};
const IMG_RX = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const NOTE_RX = /\.(md|markdown|txt)$/i;
const VIDEO_RX = /\.(mp4|m4v|webm|mov|ogv)$/i;
const AUDIO_RX = /\.(mp3|m4a|wav|ogg|flac)$/i;
const MEDIA_RX = __SPINE__ ? /\.(png|jpe?g|gif|webp|bmp|svg|avif|mp4|m4v|webm|mov|ogv|mp3|m4a|wav|ogg|flac|pdf|skel)$/i
  : /\.(png|jpe?g|gif|webp|bmp|svg|avif|mp4|m4v|webm|mov|ogv|mp3|m4a|wav|ogg|flac|pdf)$/i;
const URL_RX = /^(?:https?:\/\/|www\.)[^\s<>"]+$/i;
const MIN_Z = 0.05;
const MAX_Z = 3;
const MIN_W = 60;
const MIN_H = 40;
const GRID = 20; // Obsidian's snap grid
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** The line style panel's thickness steps. */
const LINE_WIDTHS = [1, 2, 3, 4, 6, 8, 12, 16];
/** New arrows keep the thickness picked last in the line style panel (like Miro); 3 is the default. */
const lastLineWidth = () => { const w = Number(settings.peek().canvasLineWidth); return LINE_WIDTHS.includes(w) && w !== 3 ? { mnWidth: w } : {}; };
/** A shape card's outline, drawn for its size (data-size tells place() when to draw it again). */
const outlineOf = (n) => { const s = shapeSvg(n.mnShape, n.width, n.height); s.dataset.size = `${n.width}x${n.height}`; return s; };
const kindOfFile = (file) => (IMG_RX.test(file) ? 'image' : NOTE_RX.test(file) ? 'note' : VIDEO_RX.test(file) ? 'video' : AUDIO_RX.test(file) ? 'audio' : SPINE_RX.test(file) ? 'spine' : 'file');

/** Size of a new web link card, by what the link is. */
function linkSize(url) {
  if (youTubeId(url)) return { width: 560, height: 380 };
  if (isTweetUrl(url)) return { width: 520, height: 640 };
  return { width: 400, height: 320 };
}

/** Snap state and read-only canvases are remembered (not stored in the .canvas file, like Obsidian). */
// (canvasSnaps: 2.4.0 saved grid-on defaults under canvasSnap; the defaults are now grid off, objects on.)
const snapPrefs = () => persisted.canvasSnaps || (persisted.canvasSnaps = { grid: false, objects: true });

// Nodes copied from a canvas, so "Paste" from the menu (which can only read plain text) still pastes them.
let lastCopy = null;

// ───────────────────────────── geometry ─────────────────────────────

const DIR = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

function anchor(n, side) {
  switch (side) {
    case 'top': return [n.x + n.width / 2, n.y];
    case 'bottom': return [n.x + n.width / 2, n.y + n.height];
    case 'left': return [n.x, n.y + n.height / 2];
    default: return [n.x + n.width, n.y + n.height / 2];
  }
}

function autoSides(a, b) {
  const dx = (b.x + b.width / 2) - (a.x + a.width / 2);
  const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function nearestSide(n, p) {
  const d = {
    top: Math.abs(p.y - n.y), bottom: Math.abs(p.y - (n.y + n.height)),
    left: Math.abs(p.x - n.x), right: Math.abs(p.x - (n.x + n.width)),
  };
  return Object.keys(d).sort((a, b) => d[a] - d[b])[0];
}

function curve(p1, s1, p2, s2) {
  const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const k = clamp(len / 2.5, 30, 240);
  const c1 = [p1[0] + DIR[s1][0] * k, p1[1] + DIR[s1][1] * k];
  const c2 = s2 ? [p2[0] + DIR[s2][0] * k, p2[1] + DIR[s2][1] * k] : p2;
  return { d: `M${p1[0]},${p1[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`, mid: [(p1[0] + 3 * c1[0] + 3 * c2[0] + p2[0]) / 8, (p1[1] + 3 * c1[1] + 3 * c2[1] + p2[1]) / 8] };
}

/** Arrow head with its tip at p, its base back along t (the direction the line comes from). */
function arrowHeadAt(p, t, size = 12) {
  const [dx, dy] = t;
  const bx = p[0] + dx * size;
  const by = p[1] + dy * size;
  const px = -dy * size * 0.5;
  const py = dx * size * 0.5;
  return `${p[0]},${p[1]} ${bx + px},${by + py} ${bx - px},${by - py}`;
}

// ── arrows ──
// Obsidian's edges join two cards (data.edges). Arrows with a loose end (Miro-style) go to data.mnEdges, which
// Obsidian ignores: they keep fromX/fromY or toX/toY instead of a card. Any arrow may have mnPath
// ('curve' | 'straight' | 'elbow') and mnPoints (the points it bends through).

const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** The side of card n that faces point p. */
function sideToward(n, p) {
  const dx = p[0] - (n.x + n.width / 2);
  const dy = p[1] - (n.y + n.height / 2);
  if (Math.abs(dx) / Math.max(1, n.width) > Math.abs(dy) / Math.max(1, n.height)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

/** Ends of an arrow: points p1/p2, the directions t1/t2 leaving them along the line, sides s1/s2 when on a card. */
function edgeEnds(e, by) {
  const a = e.fromNode ? by.get(e.fromNode) : null;
  const b = e.toNode ? by.get(e.toNode) : null;
  if ((e.fromNode && !a) || (e.toNode && !b)) return null;
  const pts = (Array.isArray(e.mnPoints) ? e.mnPoints : []).filter((p) => p && isFinite(p.x) && isFinite(p.y)).map((p) => [+p.x, +p.y]);
  let p1 = a ? null : [+e.fromX || 0, +e.fromY || 0];
  let p2 = b ? null : [+e.toX || 0, +e.toY || 0];
  let s1 = null;
  let s2 = null;
  if (a && b) {
    const [as, bs] = autoSides(a, b);
    s1 = DIR[e.fromSide] ? e.fromSide : as;
    s2 = DIR[e.toSide] ? e.toSide : bs;
  } else if (a) s1 = DIR[e.fromSide] ? e.fromSide : sideToward(a, pts[0] || p2);
  else if (b) s2 = DIR[e.toSide] ? e.toSide : sideToward(b, pts[pts.length - 1] || p1);
  if (a) p1 = anchor(a, s1);
  if (b) p2 = anchor(b, s2);
  const next1 = pts[0] || p2;
  const prev2 = pts[pts.length - 1] || p1;
  const t1 = s1 ? DIR[s1] : unit(next1[0] - p1[0], next1[1] - p1[1]);
  const t2 = s2 ? DIR[s2] : unit(prev2[0] - p2[0], prev2[1] - p2[1]);
  return { p1, t1, s1, p2, t2, s2, pts };
}

/** Right-angled route: out of each end along its direction, then across (via sets the middle line). */
function elbowPoints(a, ta, b, tb, via) {
  const ha = Math.abs(ta[0]) > Math.abs(ta[1]);
  const hb = Math.abs(tb[0]) > Math.abs(tb[1]);
  const a1 = [a[0] + ta[0] * 24, a[1] + ta[1] * 24];
  const b1 = [b[0] + tb[0] * 24, b[1] + tb[1] * 24];
  let mid;
  if (ha && hb) { const mx = via ? via[0] : (a1[0] + b1[0]) / 2; mid = [[mx, a1[1]], [mx, b1[1]]]; }
  else if (!ha && !hb) { const my = via ? via[1] : (a1[1] + b1[1]) / 2; mid = [[a1[0], my], [b1[0], my]]; }
  else if (ha) mid = [[b1[0], a1[1]]];
  else mid = [[a1[0], b1[1]]];
  return [a, a1, ...mid, b1, b];
}

/** The SVG path of an arrow and its pieces as cubic segments {a, c1, c2, b} (straight pieces too). */
function edgePath(g, kind, trimFrom, trimTo, trim = 10) {
  const q1 = trimFrom ? [g.p1[0] + g.t1[0] * trim, g.p1[1] + g.t1[1] * trim] : g.p1;
  const q2 = trimTo ? [g.p2[0] + g.t2[0] * trim, g.p2[1] + g.t2[1] * trim] : g.p2;
  const segs = [];
  const line = (pts) => { for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], c1: pts[i], c2: pts[i + 1], b: pts[i + 1], straight: true }); };
  if (kind === 'straight') line([q1, ...g.pts, q2]);
  else if (kind === 'elbow') line(elbowPoints(q1, g.t1, q2, g.t2, g.pts[0]));
  else if (!g.pts.length) {
    const len = dist(q1, q2);
    const k = clamp(len / 2.5, 30, 240);
    const k1 = g.s1 ? k : len / 3;
    const k2 = g.s2 ? k : len / 3;
    segs.push({ a: q1, c1: [q1[0] + g.t1[0] * k1, q1[1] + g.t1[1] * k1], c2: [q2[0] + g.t2[0] * k2, q2[1] + g.t2[1] * k2], b: q2 });
  } else {
    // A smooth line through the bend points (Catmull-Rom); ends leave their cards straight out.
    const all = [q1, ...g.pts, q2];
    const n = all.length;
    const tan = all.map((p, i) => {
      if (i === 0) { const l = dist(p, all[1]); return [g.t1[0] * l, g.t1[1] * l]; }
      if (i === n - 1) { const l = dist(all[n - 2], p); return [-g.t2[0] * l, -g.t2[1] * l]; }
      return [(all[i + 1][0] - all[i - 1][0]) / 2, (all[i + 1][1] - all[i - 1][1]) / 2];
    });
    for (let i = 0; i < n - 1; i++) {
      segs.push({ a: all[i], c1: [all[i][0] + tan[i][0] / 3, all[i][1] + tan[i][1] / 3], c2: [all[i + 1][0] - tan[i + 1][0] / 3, all[i + 1][1] - tan[i + 1][1] / 3], b: all[i + 1] });
    }
  }
  const f = (p) => `${+p[0].toFixed(2)},${+p[1].toFixed(2)}`;
  const d = `M${f(q1)}` + segs.map((s) => (s.straight ? ` L${f(s.b)}` : ` C${f(s.c1)} ${f(s.c2)} ${f(s.b)}`)).join('');
  return { d, segs };
}

/** Point of a cubic segment at t. */
function bez(s, t) {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [w[0] * s.a[0] + w[1] * s.c1[0] + w[2] * s.c2[0] + w[3] * s.b[0], w[0] * s.a[1] + w[1] * s.c1[1] + w[2] * s.c2[1] + w[3] * s.b[1]];
}

/** Obsidian's defaults are left out of the file: from-end "none", to-end "arrow". */
function tidyEnds(e) {
  if (e.fromEnd === 'none') delete e.fromEnd;
  if (e.toEnd === 'arrow') delete e.toEnd;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function div(cls, parent) {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

const snippetCache = new Map(); // wsId -> Promise<string>

function vaultSnippets(ws) {
  if (!ws || !ws.linked) return Promise.resolve('');
  if (!snippetCache.has(ws.id)) {
    snippetCache.set(ws.id, (async () => {
      try {
        const a = await api.call('note.read', { path: `${ws.dir}/.obsidian/appearance.json` });
        const names = (JSON.parse(a.text).enabledCssSnippets || []).slice(0, 30);
        const parts = [];
        for (const n of names) {
          try { parts.push((await api.call('note.read', { path: `${ws.dir}/.obsidian/snippets/${n}.css` })).text); } catch { /* missing snippet */ }
        }
        return parts.join('\n');
      } catch { return ''; }
    })());
  }
  return snippetCache.get(ws.id);
}

// The live-preview look of notes (app.css .cm-* rules) for card editors inside the canvas shadow root.
let editorSheet = null;
function adoptEditorCss(root) {
  if (!editorSheet) {
    const out = [];
    const collect = (rules, into) => {
      for (const r of rules) {
        if (r.type === CSSRule.STYLE_RULE) { if (/cm-/.test(r.selectorText)) into.push(r.cssText); }
        else if (r.type === CSSRule.MEDIA_RULE) {
          const inner = [];
          collect(r.cssRules, inner);
          if (inner.length) into.push(`@media ${r.conditionText} { ${inner.join(' ')} }`);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch { rules = null; }
      if (rules) collect(rules, out);
    }
    editorSheet = new CSSStyleSheet();
    try { editorSheet.replaceSync(out.join(' ')); } catch { /* keep what parsed */ }
  }
  if (!root.adoptedStyleSheets.includes(editorSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, editorSheet];
}

function imageSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = url;
  });
}

// ───────────────────────────── the board ─────────────────────────────

export class CanvasBoard {
  constructor(host, key) {
    this.host = host;
    this.key = key;
    this.ws = wsForPath(key);
    this.data = null;
    this.error = null;
    this.sel = new Set();
    this.selEdge = null;
    this.nodeEls = new Map();
    this.noteText = new Map();
    this.fileMap = new Map(); // canvas "file" value → where it really is (UI path), null when not found
    this.view = (persisted.canvasView && persisted.canvasView[key]) ? { ...persisted.canvasView[key] } : null;
    this.drag = null;
    this.editingId = null;
    this.spaceDown = false;
    this.edgeFrame = 0;
    this.glideFrame = 0;
    this.zoomAnim = null;
    this.pointer = null; // last pointer position over the board (screen), for pasting where the mouse is
    this.retries = new Map(); // url → times a preview that could not be fetched was asked again
    this.readOnly = !!(persisted.canvasReadOnly && persisted.canvasReadOnly[key]);
    // For tests driving the app (CDP): the board behind the element.
    Object.defineProperty(host, '__board', { value: this, configurable: true });
    this.build();
    this.load(getDocText(key));
    this.offDoc = watchDoc(key, () => this.load(getDocText(key)));
    this.offLinks = onLinksChanged(() => this.refreshContent());
    this.onBoardEvent = (e) => { if (e.detail && e.detail.key === this.key) this.boardAction(e.detail.action); };
    window.addEventListener('mn-canvas', this.onBoardEvent);
    vaultSnippets(this.ws).then((css) => { if (this.snippets) this.snippets.textContent = css; });
  }

  destroy() {
    this.stopEditing(true);
    this.stopGlide();
    this.offDoc && this.offDoc();
    this.offLinks && this.offLinks();
    window.removeEventListener('mn-canvas', this.onBoardEvent);
    for (const t of this.retries.values()) clearTimeout(t.timer);
    this.ro && this.ro.disconnect();
    this.saveView();
    this.dropSpines([...this.nodeEls.values()]);
    this.root.innerHTML = '';
    this.snippets = null;
    delete this.host.__board;
  }

  /** Commands from outside the board (the note header's buttons). */
  boardAction(action) {
    if (action === 'reloadPreviews') this.reloadPreviews();
    else if (action === 'toggleReadOnly') this.setReadOnly(!this.readOnly);
  }

  setReadOnly(on) {
    this.readOnly = on;
    const all = persisted.canvasReadOnly || (persisted.canvasReadOnly = {});
    if (on) all[this.key] = true;
    else delete all[this.key];
    saveState();
    if (on) this.stopEditing(true);
    this.wrap.classList.toggle('read-only', on);
    if (this.lockBtn) this.lockBtn.classList.toggle('on', on);
    toast(on ? 'Read-only: the canvas can be viewed and played, not changed' : 'The canvas can be edited again', 'info', 1800);
  }

  /** Read-only canvases say so instead of changing. */
  locked() {
    if (!this.readOnly) return false;
    toast('This canvas is read-only (right-click the board to turn it off)', 'info', 1800);
    return true;
  }

  // ── setup ──
  build() {
    const root = this.root = this.host.shadowRoot || this.host.attachShadow({ mode: 'open' });
    root.innerHTML = '';
    const base = document.createElement('style');
    base.textContent = CANVAS_CSS + EMBED_CSS + SPINE_CSS;
    root.appendChild(base);
    this.snippets = document.createElement('style');
    root.appendChild(this.snippets);

    const w = this.wrap = div('canvas-wrapper' + (this.readOnly ? ' read-only' : ''), root);
    w.tabIndex = -1;
    this.bg = div('canvas-background', w);
    this.layer = div('canvas', w);
    this.groupsLayer = div('cv-groups', this.layer);
    this.svg = svg('svg', { class: 'cv-edges', width: '1', height: '1' });
    this.layer.appendChild(this.svg);
    this.nodesLayer = div('cv-nodes', this.layer);
    this.labelsLayer = div('cv-edge-labels', this.layer);
    const guides = div('cv-guides', this.layer);
    this.guideV = div('cv-guide v', guides);
    this.guideH = div('cv-guide h', guides);
    // The box around several selected cards, with corner handles that resize them together.
    this.groupBox = div('cv-groupbox', this.layer);
    for (const d of ['nw', 'ne', 'sw', 'se']) div(`cv-gb ${d}`, this.groupBox).dataset.dir = d;
    // Handles of the selected arrow (ends, bend points, "add a bend" points).
    this.edgeUI = div('cv-edge-ui', this.layer);
    this.marquee = div('cv-marquee', w);
    this.msg = div('cv-msg', w);
    this.buildToolbar();
    this.buildSelBar();
    this.buildEdgeBar();

    w.addEventListener('pointerdown', (e) => this.onDown(e));
    w.addEventListener('pointermove', (e) => this.onMove(e));
    w.addEventListener('pointerup', (e) => this.onUp(e));
    w.addEventListener('pointercancel', (e) => this.onUp(e));
    w.addEventListener('pointerleave', () => { this.pointer = null; });
    w.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    w.addEventListener('dblclick', (e) => this.onDbl(e));
    w.addEventListener('click', (e) => this.onClick(e));
    w.addEventListener('contextmenu', (e) => this.onContext(e));
    w.addEventListener('keydown', (e) => this.onKey(e));
    w.addEventListener('keyup', (e) => { if (e.key === ' ') { this.spaceDown = false; w.classList.remove('space'); } });
    w.addEventListener('copy', (e) => this.onCopy(e));
    w.addEventListener('cut', (e) => { if (this.onCopy(e) && !this.readOnly) this.deleteSelection(); });
    w.addEventListener('paste', (e) => this.onPaste(e));
    w.addEventListener('dragover', (e) => this.onDragOver(e));
    w.addEventListener('drop', (e) => this.onDrop(e));

    this.ro = new ResizeObserver(() => {
      if (!this.view && this.data && w.clientWidth) { this.fit(false); }
      this.applyView();
    });
    this.ro.observe(w);
    requestAnimationFrame(() => w.focus({ preventScroll: true }));
  }

  buildToolbar() {
    const t = div('cv-toolbar', this.wrap);
    const btn = (name, title, run, cls = '') => {
      const b = document.createElement('button');
      b.className = 'cv-tbtn' + (cls ? ' ' + cls : '');
      b.title = title;
      b.appendChild(icon(name, 17));
      b.addEventListener('click', (e) => { e.stopPropagation(); run(e); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('dblclick', (e) => e.stopPropagation());
      t.appendChild(b);
      return b;
    };
    btn('type', 'Add a card (or double-click the board)', () => this.addCard(this.centerPoint(), true), 'cv-tadd');
    btn('file-text', 'Add a note from this workspace', () => this.addNoteFromVault(this.centerPoint()), 'cv-tadd');
    btn('image', 'Add media (pictures, videos, audio)', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.top, [
        { label: 'From this workspace…', icon: 'folder', run: () => this.addMediaFromVault(this.centerPoint()) },
        { label: 'From this computer…', icon: 'upload', run: () => this.pickFiles(this.centerPoint()) },
      ], { anchorY: r.top });
    }, 'cv-tadd');
    btn('globe', 'Add a web page or video (or paste its link)', () => this.addWebPage(this.centerPoint()), 'cv-tadd');
    this.arrowBtn = btn('arrow-right', 'Draw an arrow: from a card or anywhere, to a card or anywhere (Esc to cancel)', () => this.setTool(this.tool === 'arrow' ? null : 'arrow'), 'cv-tadd');
    this.shapesBtn = btn('shapes', 'Shapes and lines (R rectangle, O oval, L line)', (e) => this.openShapesPicker(e.currentTarget), 'cv-tadd');
    btn('folder', 'Add a group', () => this.addGroup(this.centerPoint(), true), 'cv-tadd');
    div('cv-tsep cv-tadd', t);
    btn('zoom-out', 'Zoom out (Ctrl + scroll)', () => this.zoomBy(1 / 1.25));
    this.zoomLabel = document.createElement('button');
    this.zoomLabel.className = 'cv-tbtn cv-zoom';
    this.zoomLabel.title = 'Reset zoom to 100%';
    this.zoomLabel.addEventListener('click', (e) => { e.stopPropagation(); this.zoomTo(1); });
    this.zoomLabel.addEventListener('pointerdown', (e) => e.stopPropagation());
    t.appendChild(this.zoomLabel);
    btn('zoom-in', 'Zoom in (Ctrl + scroll)', () => this.zoomBy(1.25));
    btn('fit', 'Zoom to fit (Shift+1)', () => this.fit(true));
    div('cv-tsep', t);
    this.lockBtn = btn('lock', 'Read-only: view and play, no changes', () => this.setReadOnly(!this.readOnly));
    this.lockBtn.classList.toggle('on', this.readOnly);
  }

  /** The floating bar above the selection (like Obsidian): remove, colour, zoom to selection. */
  buildSelBar() {
    const bar = this.selBar = div('cv-selbar', this.wrap);
    const btn = (name, title, run, cls = '') => {
      const b = document.createElement('button');
      b.className = 'cv-sbtn' + (cls ? ' ' + cls : '');
      b.title = title;
      b.appendChild(icon(name, 16));
      b.addEventListener('click', (e) => { e.stopPropagation(); run(e); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('dblclick', (e) => e.stopPropagation());
      bar.appendChild(b);
      return b;
    };
    btn('trash', 'Remove (Del)', () => this.deleteSelection(), 'cv-tadd');
    btn('palette', 'Set colour', (e) => this.openColorMenu(e.currentTarget), 'cv-tadd');
    btn('scan-search', 'Zoom to selection (Shift+2)', () => this.zoomToSelection());
    this.shapeBtn = btn('shapes', 'Change shape', (e) => { const n = this.byId([...this.sel][0]); if (n) this.openChangeShape(n, this.anchorPoint(e.currentTarget)); }, 'cv-tadd');
    // Several cards: Align comes last, after a divider (the bar of one card stays as in Obsidian).
    this.alignSep = div('cv-tsep cv-tadd', bar);
    this.alignBtn = btn('align-left', 'Align', (e) => (this.alignPop ? this.closeAlignPop() : this.openAlignPop(e.currentTarget)), 'cv-tadd');
  }

  /**
   * Miro's align popover for several selected cards: left / centres / right, top / middles / bottom, and
   * (from 3 cards) distribute them evenly across or down.
   */
  openAlignPop(anchor) {
    this.closeAlignPop();
    const targets = [...this.sel].map((id) => this.byId(id)).filter(Boolean);
    if (targets.length < 2) return;
    const pop = this.alignPop = div('cv-alignpop', this.wrap);
    const rows = [
      [['align-left', 'Align left', 'left'], ['align-hcenter', 'Align horizontally', 'hcenter'], ['align-right', 'Align right', 'right'], null, ['distribute-h', 'Distribute horizontally', 'dist-x']],
      [['align-top', 'Align top', 'top'], ['align-vcenter', 'Align vertically', 'vcenter'], ['align-bottom', 'Align bottom', 'bottom'], null, ['distribute-v', 'Distribute vertically', 'dist-y']],
    ];
    for (const row of rows) {
      const r = div('cv-alignrow', pop);
      for (const item of row) {
        if (!item) { div('cv-alignsep', r); continue; }
        const [ic, label, how] = item;
        const b = document.createElement('button');
        b.className = 'cv-abtn';
        b.dataset.tip = label;
        b.setAttribute('aria-label', label);
        b.disabled = how.startsWith('dist') && targets.length < 3;
        b.appendChild(icon(ic, 18));
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const now = [...this.sel].map((id) => this.byId(id)).filter(Boolean);
          if (how.startsWith('dist')) this.distribute(now, how === 'dist-x' ? 'x' : 'y');
          else this.align(now, how);
        });
        r.appendChild(b);
      }
    }
    // Names show right away above the icons, like Miro's.
    const tip = div('cv-tip', pop);
    pop.addEventListener('pointerover', (e) => {
      const b = e.target.closest('.cv-abtn');
      if (!b) { tip.classList.remove('show'); return; }
      tip.textContent = b.dataset.tip;
      tip.style.left = `${Math.round(b.offsetLeft + b.offsetWidth / 2 - tip.offsetWidth / 2)}px`;
      tip.style.top = `${Math.round(b.offsetTop - tip.offsetHeight - 8)}px`;
      tip.classList.add('show');
    });
    pop.addEventListener('pointerleave', () => tip.classList.remove('show'));
    const ar = anchor.getBoundingClientRect();
    const wr = this.wrap.getBoundingClientRect();
    const left = clamp(ar.left - wr.left + ar.width / 2 - pop.offsetWidth / 2, 8, this.wrap.clientWidth - pop.offsetWidth - 8);
    pop.style.transform = `translate(${Math.round(left)}px, ${Math.round(ar.bottom - wr.top + 8)}px)`;
    anchor.classList.add('on');
    this.alignPopClose = (e) => {
      const path = e.composedPath();
      if (path.includes(pop) || path.includes(anchor)) return;
      this.closeAlignPop();
    };
    window.addEventListener('pointerdown', this.alignPopClose, true);
  }

  closeAlignPop() {
    if (!this.alignPop) return;
    this.alignPop.remove();
    this.alignPop = null;
    if (this.alignBtn) this.alignBtn.classList.remove('on');
    window.removeEventListener('pointerdown', this.alignPopClose, true);
  }

  /** Even gaps between the cards across (x) or down (y); the first and last stay where they are. */
  distribute(targets, axis) {
    if (this.locked() || targets.length < 3) return;
    const pos = axis === 'x' ? 'x' : 'y';
    const size = axis === 'x' ? 'width' : 'height';
    const sorted = targets.slice().sort((a, b) => (a[pos] + a[size] / 2) - (b[pos] + b[size] / 2));
    const start = Math.min(...sorted.map((n) => n[pos]));
    const end = Math.max(...sorted.map((n) => n[pos] + n[size]));
    const gap = (end - start - sorted.reduce((s, n) => s + n[size], 0)) / (sorted.length - 1);
    let at = start;
    for (const n of sorted) {
      n[pos] = Math.round(at);
      at += n[size] + gap;
      const el = this.nodeEls.get(n.id);
      if (el) this.place(el, n);
    }
    this.renderEdges();
    this.updateGroupBox();
    this.updateSelBar();
    this.commit();
  }

  openColorMenu(anchor) {
    const targets = [...this.sel].map((id) => this.byId(id)).filter(Boolean);
    if (!targets.length) return;
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 6, [
      { swatches: true, colors: PRESETS, value: colorOf(targets[0].color), onPick: (c) => this.setColor(targets, c) },
    ], { minWidth: 0 });
  }

  setColor(targets, c) {
    if (this.locked()) return;
    for (const t of targets) {
      if (c) t.color = presetOf(c); else delete t.color;
      this.renderNode(t);
    }
    this.commit();
  }

  /** Places the floating bar above the selected cards (below them when there is no room above). */
  updateSelBar() {
    const bar = this.selBar;
    if (!bar) return;
    const nodes = this.data && this.view ? [...this.sel].map((id) => this.byId(id)).filter(Boolean) : [];
    this.closeAlignPop();
    if (this.alignBtn) this.alignBtn.style.display = this.alignSep.style.display = nodes.length > 1 ? '' : 'none';
    if (this.shapeBtn) this.shapeBtn.style.display = nodes.length === 1 && isShape(nodes[0]) ? '' : 'none';
    if (!nodes.length || this.editingId || (this.drag && this.drag.moved)) { bar.classList.remove('show'); return; }
    const { x, y, z } = this.view;
    const x0 = Math.min(...nodes.map((n) => n.x)) * z + x;
    const x1 = Math.max(...nodes.map((n) => n.x + n.width)) * z + x;
    const y0 = Math.min(...nodes.map((n) => n.y)) * z + y;
    const y1 = Math.max(...nodes.map((n) => n.y + n.height)) * z + y;
    const W = this.wrap.clientWidth;
    const H = this.wrap.clientHeight;
    if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) { bar.classList.remove('show'); return; }
    bar.classList.add('show');
    const bw = bar.offsetWidth || 120;
    const bh = bar.offsetHeight || 38;
    let top = y0 - bh - 14;
    if (top < 8) top = y1 + 14 < H - bh - 70 ? y1 + 14 : 8;
    const left = clamp((x0 + x1) / 2 - bw / 2, 8, W - bw - 8);
    bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Fits the view to the selected cards (Obsidian's "Zoom to selection", Shift+2). */
  zoomToSelection() {
    const nodes = [...this.sel].map((id) => this.byId(id)).filter(Boolean);
    if (!nodes.length) return;
    this.fitRect(Math.min(...nodes.map((n) => n.x)), Math.min(...nodes.map((n) => n.y)),
      Math.max(...nodes.map((n) => n.x + n.width)), Math.max(...nodes.map((n) => n.y + n.height)), true, 1.5);
  }

  // ── floating panels (shapes, line style, quick create) ──
  /**
   * One small panel on the board at a time, closed by a press outside it, by Escape or when the view moves.
   * at: {x, y} in board pixels (the panel opens below it), optional top (opens above when there is no room
   * below), above (prefer above), anchor (a button whose presses do not close it).
   */
  openPop(at, build, cls = '') {
    this.closePop();
    this.closeAlignPop();
    const pop = div('cv-pop' + (cls ? ' ' + cls : ''), this.wrap);
    build(pop);
    const tip = div('cv-tip', pop);
    pop.addEventListener('pointerover', (e) => {
      const b = e.target.closest('[data-tip]');
      if (!b || !pop.contains(b)) { tip.classList.remove('show'); return; }
      tip.textContent = b.dataset.tip;
      const br = b.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      tip.style.left = `${Math.round(br.left - pr.left + br.width / 2 - tip.offsetWidth / 2)}px`;
      tip.style.top = `${Math.round(br.top - pr.top - tip.offsetHeight - 8)}px`;
      tip.classList.add('show');
    });
    pop.addEventListener('pointerleave', () => tip.classList.remove('show'));
    // Presses inside the panel are its own (they must not select or pan the board under it).
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop.addEventListener('dblclick', (e) => e.stopPropagation());
    pop.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    pop.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    const W = this.wrap.clientWidth;
    const H = this.wrap.clientHeight;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const top = at.top ?? at.y;
    let x = at.x - pw / 2;
    let y = at.above ? top - ph - 8 : at.y + 8;
    if (at.side === 'right' || at.side === 'left') {
      // Beside the point, or on its other side when there is no room.
      x = at.side === 'right' ? at.x + 12 : at.x - pw - 12;
      if (at.side === 'right' && x + pw > W - 8) x = at.x - pw - 12;
      if (at.side === 'left' && x < 8) x = at.x + 12;
      y = at.y - ph / 2;
    } else {
      if (!at.above && y + ph > H - 8) y = top - ph - 8;
      if (at.above && y < 8) y = at.y + 8;
    }
    pop.style.transform = `translate(${Math.round(clamp(x, 8, Math.max(8, W - pw - 8)))}px, ${Math.round(clamp(y, 8, Math.max(8, H - ph - 8)))}px)`;
    if (at.anchor) at.anchor.classList.add('on');
    pop._anchor = at.anchor || null;
    this.pop = pop;
    this.popClose = (e) => {
      const path = e.composedPath();
      if (path.includes(pop) || (at.anchor && path.includes(at.anchor))) return;
      this.closePop();
    };
    window.addEventListener('pointerdown', this.popClose, true);
    return pop;
  }

  closePop() {
    const pop = this.pop;
    if (!pop) return;
    this.pop = null;
    window.removeEventListener('pointerdown', this.popClose, true);
    if (pop._anchor) pop._anchor.classList.remove('on');
    pop.remove();
  }

  /** Where a panel opens for a button: centred under it (or above it). */
  anchorPoint(anchor) {
    const r = anchor.getBoundingClientRect();
    const wr = this.wrap.getBoundingClientRect();
    return { x: r.left - wr.left + r.width / 2, y: r.bottom - wr.top, top: r.top - wr.top, anchor };
  }

  popBtn(parent, content, tip, run) {
    const b = document.createElement('button');
    b.className = 'cv-pop-btn';
    b.type = 'button';
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
    b.appendChild(content);
    b.addEventListener('click', (e) => { e.stopPropagation(); run(e); });
    parent.appendChild(b);
    return b;
  }

  /** The shapes (and, for the toolbar, lines) to pick from, like Miro's shapes panel. */
  shapeGrid(parent, onPick, { lines = false, current = null } = {}) {
    if (lines) {
      div('cv-pop-title', parent).textContent = 'Lines';
      const row = div('cv-pop-grid', parent);
      this.popBtn(row, icon('line', 18), 'Line (L)', () => onPick({ line: { toEnd: 'none' } }));
      this.popBtn(row, icon('arrow-right', 18), 'Arrow', () => onPick({ line: {} }));
      this.popBtn(row, icon('elbow', 18), 'Elbow arrow', () => onPick({ line: { mnPath: 'elbow' } }));
    }
    for (const [group, title] of [['basic', 'Basic shapes'], ['flowchart', 'Flowchart']]) {
      div('cv-pop-title', parent).textContent = title;
      const grid = div('cv-pop-grid', parent);
      for (const s of SHAPES.filter((x) => x.group === group)) {
        const b = this.popBtn(grid, shapeIcon(s.id, 20), s.name + (s.key ? ` (${s.key})` : ''), () => onPick({ shape: s.id }));
        if (current === s.id) b.classList.add('on');
      }
    }
  }

  /** Toolbar: pick a shape (then click or drag on the board to place it) or a line to draw. */
  openShapesPicker(anchor) {
    if (this.locked()) return;
    if (this.pop && this.pop.classList.contains('cv-shapes')) { this.closePop(); return; }
    this.openPop({ ...this.anchorPoint(anchor), above: true }, (pop) => this.shapeGrid(pop, (pick) => {
      this.closePop();
      if (pick.line) this.setTool('arrow', pick.line);
      else this.setTool('shape', pick.shape);
    }, { lines: true }), 'cv-shapes');
  }

  /** Another shape for a card (a text card becomes a shape; "No shape" turns a shape back into a card). */
  openChangeShape(n, at) {
    if (this.locked()) return;
    this.openPop(at, (pop) => {
      this.shapeGrid(pop, (pick) => {
        this.closePop();
        if (!pick.shape) return;
        n.mnShape = pick.shape;
        this.renderNode(n);
        this.updateSelBar();
        this.commit();
      }, { current: isShape(n) ? n.mnShape : null });
      if (isShape(n)) {
        const b = document.createElement('button');
        b.className = 'cv-pop-link';
        b.textContent = 'No shape (plain card)';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closePop();
          delete n.mnShape;
          this.renderNode(n);
          this.updateSelBar();
          this.commit();
        });
        pop.appendChild(b);
      }
    }, 'cv-shapes');
  }

  /** A new shape on the board, selected and ready for its text. */
  createShape(id, x, y, w, h) {
    if (this.locked()) return null;
    const n = this.addNode({ type: 'text', text: '', mnShape: id, x: Math.round(x), y: Math.round(y), width: Math.max(MIN_W, Math.round(w)), height: Math.max(MIN_H, Math.round(h)) });
    this.setSelection([n.id]);
    this.startEditing(n.id);
    return n;
  }

  /** Miro's line style panel: thickness in steps, the line's type, and solid / dashed / dotted. */
  openLineStyle(anchor) {
    const e = this.findEdge(this.selEdge);
    if (!e || this.locked()) return;
    if (this.pop && this.pop.classList.contains('cv-linestyle')) { this.closePop(); return; }
    const WIDTHS = LINE_WIDTHS;
    let refresh = () => {};
    const apply = (fn) => {
      fn(e);
      if (Number(e.mnWidth) === 3) delete e.mnWidth;
      this.renderEdges();
      this.commit();
      refresh();
    };
    this.openPop(this.anchorPoint(anchor), (pop) => {
      const steps = div('cv-steps', pop);
      steps.dataset.tip = 'Thickness';
      div('cv-steps-track', steps);
      const fill = div('cv-steps-fill', steps);
      const dots = WIDTHS.map((_, i) => { const d = div('cv-steps-dot', steps); d.style.left = `${(i / (WIDTHS.length - 1)) * 100}%`; return d; });
      const knob = div('cv-steps-knob', steps);
      const pick = (ev) => {
        const r = steps.getBoundingClientRect();
        const i = Math.round(clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1) * (WIDTHS.length - 1));
        if (settings.peek().canvasLineWidth !== WIDTHS[i]) updateSettings({ canvasLineWidth: WIDTHS[i] });
        if ((Number(e.mnWidth) || 3) !== WIDTHS[i]) apply((x) => { x.mnWidth = WIDTHS[i]; });
      };
      steps.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        try { steps.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
        pick(ev);
        const move = (m) => pick(m);
        const up = () => { steps.removeEventListener('pointermove', move); steps.removeEventListener('pointerup', up); };
        steps.addEventListener('pointermove', move);
        steps.addEventListener('pointerup', up);
      });
      const types = div('cv-pop-row', pop);
      const typeBtns = [['straight', 'line', 'Straight'], ['elbow', 'elbow', 'Elbow'], ['curve', 'curve', 'Curved']].map(([k, ic, tip]) => {
        const b = this.popBtn(types, icon(ic, 18), tip, () => apply((x) => {
          if (k === 'curve') delete x.mnPath; else x.mnPath = k;
          if (k === 'elbow' && x.mnPoints && x.mnPoints.length > 1) x.mnPoints = x.mnPoints.slice(0, 1);
        }));
        b.dataset.k = k;
        return b;
      });
      const dashes = div('cv-pop-row', pop);
      const dashBtns = [['solid', 'dash-solid', 'Solid'], ['dashed', 'dash-dashed', 'Dashed'], ['dotted', 'dash-dotted', 'Dotted']].map(([k, ic, tip]) => {
        const b = this.popBtn(dashes, icon(ic, 18), tip, () => apply((x) => { if (k === 'solid') delete x.mnDash; else x.mnDash = k; }));
        b.dataset.k = k;
        return b;
      });
      refresh = () => {
        let i = 0;
        WIDTHS.forEach((w, j) => { if (Math.abs(w - (Number(e.mnWidth) || 3)) < Math.abs(WIDTHS[i] - (Number(e.mnWidth) || 3))) i = j; });
        const pct = (i / (WIDTHS.length - 1)) * 100;
        knob.style.left = `${pct}%`;
        fill.style.width = `${pct}%`;
        dots.forEach((d, j) => d.classList.toggle('on', j <= i));
        typeBtns.forEach((b) => b.classList.toggle('on', b.dataset.k === (e.mnPath || 'curve')));
        dashBtns.forEach((b) => b.classList.toggle('on', b.dataset.k === (e.mnDash || 'solid')));
      };
      refresh();
    }, 'cv-linestyle');
  }

  /**
   * Miro's picker at the loose end of a new arrow drawn from a card: the same kind of card, a text card or a
   * shape, created there and joined to the arrow. A press elsewhere leaves the arrow loose.
   */
  openQuickCreate(edge, src) {
    const geo = this.edgeGeo && this.edgeGeo.get(edge.id);
    if (!geo || this.readOnly) return;
    this.selectEdge(null);
    this.setSelection([]);
    const { x, y, z } = this.view;
    const ex = geo.g.p2[0] * z + x;
    const ey = geo.g.p2[1] * z + y;
    // Where the new card would go: on the side the arrow goes on to (t2 points back along it).
    const t = geo.g.t2;
    const at = Math.abs(t[0]) >= Math.abs(t[1]) ? { x: ex, y: ey, side: t[0] < 0 ? 'right' : 'left' }
      : t[1] < 0 ? { x: ex, y: ey + 4 } : { x: ex, y: ey, top: ey - 4, above: true };
    const same = src && src.type === 'text' ? { mnShape: isShape(src) ? src.mnShape : null, width: src.width, height: src.height, color: src.color } : null;
    const specFor = (id) => { const d = SHAPE.get(id); return { mnShape: id, width: d.w, height: d.h }; };
    const make = (spec) => { this.closePop(); this.createAtEnd(edge, spec); };
    const build = (pop, more) => {
      if (same && !more) {
        const b = document.createElement('button');
        b.className = 'cv-pop-wide';
        b.innerHTML = '<span>Add the same object</span><span class="cv-pop-key">↵</span>';
        b.addEventListener('click', (ev) => { ev.stopPropagation(); make(same); });
        pop.appendChild(b);
      }
      if (more) {
        this.shapeGrid(pop, (pick) => make(specFor(pick.shape)));
        return;
      }
      const grid = div('cv-pop-grid three', pop);
      this.popBtn(grid, icon('type', 18), 'Text card', () => make({ width: 260, height: 120 }));
      for (const id of ['rect', 'rounded', 'oval', 'rhombus', 'parallelogram', 'triangle', 'hexagon', 'cylinder']) {
        this.popBtn(grid, shapeIcon(id, 20), SHAPE.get(id).name, () => make(specFor(id)));
      }
      const moreBtn = document.createElement('button');
      moreBtn.className = 'cv-pop-link';
      moreBtn.textContent = 'More shapes';
      moreBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openPop(at, (p2) => build(p2, true), 'cv-quick');
        if (same && this.pop) this.pop._enter = () => make(same);
      });
      pop.appendChild(moreBtn);
    };
    this.openPop(at, (pop) => build(pop, false), 'cv-quick');
    if (same && this.pop) this.pop._enter = () => make(same);
  }

  /** A new card at the loose end of `edge`, its side facing where the arrow comes from, joined to the arrow. */
  createAtEnd(edge, spec) {
    const geo = this.edgeGeo && this.edgeGeo.get(edge.id);
    if (!geo || this.locked()) return;
    const [px, py] = geo.g.p2;
    const t = geo.g.t2;
    const side = Math.abs(t[0]) >= Math.abs(t[1]) ? (t[0] < 0 ? 'left' : 'right') : (t[1] < 0 ? 'top' : 'bottom');
    const w = spec.width || 200;
    const h = spec.height || 120;
    const pos = { left: [px, py - h / 2], right: [px - w, py - h / 2], top: [px - w / 2, py], bottom: [px - w / 2, py - h] }[side];
    const node = { type: 'text', text: '', x: Math.round(pos[0]), y: Math.round(pos[1]), width: w, height: h };
    if (spec.mnShape) node.mnShape = spec.mnShape;
    if (spec.color) node.color = spec.color;
    const n = this.addNode(node, { commit: false });
    edge.toNode = n.id;
    edge.toSide = side;
    delete edge.toX;
    delete edge.toY;
    this.fileEdge(edge);
    this.renderEdges();
    this.setSelection([n.id]);
    this.commit();
    this.startEditing(n.id);
  }

  // ── adding things ──
  addCard(p, centered = false) {
    if (this.locked()) return null;
    const n = this.addNode({ type: 'text', text: '', x: Math.round(p.x - (centered ? 130 : 0)), y: Math.round(p.y - (centered ? 60 : 0)), width: 260, height: 120 }, { commit: false, fresh: true });
    this.setSelection([n.id]);
    this.startEditing(n.id);
    return n;
  }

  addGroup(p, centered = false) {
    if (this.locked()) return;
    const n = this.addNode({ type: 'group', label: 'Group', x: Math.round(p.x - (centered ? 300 : 0)), y: Math.round(p.y - (centered ? 200 : 0)), width: 600, height: 400 });
    this.renderAll();
    this.setSelection([n.id]);
  }

  /** Web link cards (pages, YouTube videos, X posts), placed side by side around p. */
  addLinks(urls, p) {
    if (this.locked() || !urls.length) return [];
    let x = p.x;
    const added = [];
    const total = urls.reduce((s, u) => s + linkSize(u).width + 40, -40);
    x -= total / 2;
    for (const raw of urls) {
      const url = /^www\./i.test(raw) ? 'https://' + raw : raw;
      const { width, height } = linkSize(url);
      const n = this.addNode({ type: 'link', url, x: Math.round(x), y: Math.round(p.y - height / 2), width, height }, { commit: false });
      n._fit = true; // sized to its preview once that arrives
      added.push(n);
      x += width + 40;
    }
    this.setSelection(added.map((n) => n.id));
    this.renderEdges();
    this.commit();
    return added;
  }

  async addWebPage(p) {
    if (this.locked()) return;
    const v = await prompt({ title: 'Add a web page', label: 'Address', placeholder: 'https://…', ok: 'Add',
      hint: 'YouTube videos and X posts play right on the canvas.' });
    if (!v) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v.replace(/^\/+/, '');
    this.addLinks([url], p);
  }

  async addNoteFromVault(p) {
    if (this.locked()) return;
    const ws = this.ws;
    const lists = ws ? [ws] : workspaces.peek();
    for (const w of lists) if (!notesByWs.peek()[w.id]) { try { await loadNotes(w.id, false); } catch { /* ignore */ } }
    const notes = lists.flatMap((w) => notesByWs.peek()[w.id] || []).filter((n) => n.path !== this.key);
    const pick = await pickFrom({
      title: 'Add a note', placeholder: 'Find a note…', empty: 'This workspace has no notes yet.',
      items: notes.slice().sort((a, b) => b.mtime - a.mtime).map((n) => ({ key: n.path, label: n.title, sub: n.folder || '', icon: /\.canvas$/i.test(n.path) ? 'canvas' : 'file-text', path: n.path })),
    });
    if (!pick) return;
    this.addFileNodes([pick.path], p);
  }

  async addMediaFromVault(p) {
    if (this.locked()) return;
    if (!this.ws) { this.pickFiles(p); return; }
    const files = (await loadFiles(this.ws.id, true)) || [];
    const media = files.filter((f) => MEDIA_RX.test(f) && !/(^|\/)\.(obsidian|trash)\//i.test(f));
    const pick = await pickFrom({
      title: 'Add media', placeholder: __SPINE__ ? 'Find a picture, video, audio file or Spine model…' : 'Find a picture, video or audio file…', empty: 'No pictures, videos or audio files in this workspace yet.',
      items: media.map((f) => {
        const k = kindOfFile(f);
        return { key: f, label: f.split('/').pop(), sub: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', icon: k === 'image' ? 'image' : k === 'video' ? 'film' : k === 'audio' ? 'music' : k === 'spine' ? 'play' : 'file', path: `${this.ws.dir}/${f}` };
      }),
    });
    if (!pick) return;
    this.addFileNodes([pick.path], p);
  }

  /** Cards for files of the workspace (UI paths): notes, pictures, videos, audio, other files. */
  async addFileNodes(paths, p) {
    if (this.locked() || !paths.length) return [];
    const added = [];
    let off = 0;
    const storedAll = await this.storePaths(paths);
    for (const [i, path] of paths.entries()) {
      const stored = storedAll[i];
      this.fileMap.set(stored, path);
      const k = kindOfFile(path);
      let w = 400;
      let h = 400;
      if (k === 'image') {
        const dims = await imageSize(fileUrl(path) + '?w=1024');
        w = Math.min(400, dims.w || 400);
        h = dims.w ? Math.max(MIN_H, Math.round(w * dims.h / dims.w)) : 300;
      } else if (k === 'video') { w = 640; h = 360; }
      else if (k === 'spine') { w = 420; h = 600; }
      else if (k === 'audio') { w = 400; h = 130; }
      else if (k === 'file') { h = /\.canvas$/i.test(path) ? 120 : 120; }
      else if (/\.canvas$/i.test(path)) h = 120;
      const n = this.addNode({ type: 'file', file: stored, x: Math.round(p.x - w / 2 + off), y: Math.round(p.y - h / 2 + off), width: w, height: h }, { commit: false });
      if (k === 'video') n._fit = true;
      added.push(n);
      off += 30;
    }
    this.setSelection(added.map((n) => n.id));
    this.renderEdges();
    this.commit();
    return added;
  }

  /** Files from the computer (file picker, drop or paste): copied next to the canvas unless they are already in the workspace. */
  pickFiles(at) {
    if (this.locked()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = __SPINE__ ? 'image/*,video/*,audio/*,.pdf,.skel' : 'image/*,video/*,audio/*,.pdf';
    input.multiple = true;
    input.onchange = () => {
      const files = [...(input.files || [])];
      if (files.length) this.addFiles(files, at || this.centerPoint());
    };
    input.click();
  }

  async addFiles(files, at) {
    if (this.locked() || !files.length) return;
    let paths = [];
    try { paths = await api.dropFiles(files); } catch { paths = []; }
    if (paths && paths.length) {
      try {
        const res = await api.call('asset.import', { notePath: this.key, paths });
        if (this.ws) invalidateFiles(this.ws.id);
        await this.addFileNodes(res.map((r) => r.path), at);
      } catch (err) { toast('Could not add the files: ' + err.message, 'error'); }
      return;
    }
    // Pictures without a file behind them (screenshots, copied images) are saved like pasted images.
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length) await this.addImages(images, at);
    else toast('These files could not be added', 'warning');
  }

  // ── data ──
  load(text) {
    if (this.editingId) {
      // The file changed under the card being edited (undo, another program): the file wins.
      const v = this.cardView;
      this.cardView = null;
      this.editingId = null;
      if (v) v.destroy();
    }
    const r = parseCanvas(text);
    const first = !this.loadedOnce;
    this.loadedOnce = true;
    this.data = r.data;
    this.error = r.error || null;
    for (const id of [...this.sel]) if (!this.byId(id)) this.sel.delete(id);
    if (this.selEdge && !this.findEdge(this.selEdge)) this.selEdge = null;
    // Later loads (undo, the file changed on disk) keep the cards that did not change, so videos keep playing.
    this.renderAll(first);
    if (!this.view && this.wrap.clientWidth) this.fit(false);
    this.applyView();
    this.resolveFiles();
    this.syncLinks();
  }

  byId(id) {
    return this.data ? this.data.nodes.find((n) => n.id === id) : null;
  }

  commit() {
    if (!this.data) return;
    this.syncLinks();
    const ok = setDocText(this.key, stringifyCanvas(this.data));
    if (ok === false && getDocText(this.key) !== stringifyCanvas(this.data)) toast('This canvas is read-only: changes are not saved', 'warning');
  }

  addNode(n, { commit = true, fresh = false } = {}) {
    const node = { id: newId(), ...n };
    if (fresh) node._new = true;
    if (node.type === 'group') this.data.nodes.unshift(node);
    else this.data.nodes.push(node);
    this.renderNode(node);
    // On top of the cards already there (a new group goes behind everything: renderAll() renumbers).
    const el = this.nodeEls.get(node.id);
    if (el) el.style.zIndex = String(this.data.nodes.indexOf(node) + 1);
    if (commit) this.commit();
    return node;
  }

  /** Spine models of cards going away give their WebGL back at once. */
  dropSpines(els) {
    for (const el of els) {
      if (el._spine) { el._spine.destroy(); el._spine = null; }
      if (el.dataset.id === this.spineLiveId) this.spineLiveId = null;
    }
  }

  /** The Spine card whose model takes the mouse (drag moves it, the wheel zooms it), or none (id null). */
  setSpineLive(id) {
    this.spineLiveId = id || null;
    for (const [nid, el] of this.nodeEls) el.classList.toggle('spv-live', nid === this.spineLiveId);
  }

  // ── rendering ──
  renderAll(full = false) {
    if (full) {
      this.dropSpines([...this.nodeEls.values()]);
      this.nodeEls.clear();
      this.groupsLayer.innerHTML = '';
      this.nodesLayer.innerHTML = '';
    }
    this.msg.textContent = '';
    this.msg.className = 'cv-msg';
    if (!this.data) {
      this.msg.className = 'cv-msg error';
      this.msg.textContent = `This canvas file could not be read (${this.error}). Use “Edit as text” in the ⋯ menu to fix it.`;
      this.renderEdges();
      return;
    }
    const alive = new Set(this.data.nodes.map((n) => n.id));
    for (const [id, el] of this.nodeEls) if (!alive.has(id)) { this.dropSpines([el]); el.remove(); this.nodeEls.delete(id); }
    // Groups stay behind everything else; other nodes keep the file order (later = on top). The order is
    // a z-index, not the DOM order: moving an element would restart a playing YouTube video.
    this.data.nodes.forEach((n, i) => {
      this.renderNode(n);
      const el = this.nodeEls.get(n.id);
      const layer = n.type === 'group' ? this.groupsLayer : this.nodesLayer;
      if (el.parentNode !== layer) layer.appendChild(el);
      el.style.zIndex = String(i + 1);
    });
    if (!this.data.nodes.length) {
      this.msg.className = 'cv-msg hint';
      this.msg.innerHTML = document.documentElement.classList.contains('mobile')
        ? '<b>Empty canvas</b><br>Double-tap to add a card · drag with one finger to move around · pinch to zoom'
        : '<b>Empty canvas</b><br>Double-click to add a card · paste links, pictures and text · drop notes, images and videos · Ctrl + scroll to zoom · drag with the right or middle button to move around';
    }
    this.renderEdges();
    this.updateGroupBox();
  }

  /** [[links]] / ![[images]] may resolve differently now: redraw text cards and note cards. */
  refreshContent() {
    if (!this.data) return;
    for (const n of this.data.nodes) {
      const el = this.nodeEls.get(n.id);
      if (el && (n.type === 'text' || (n.type === 'file' && NOTE_RX.test(String(n.file || ''))))) el._sig = null;
    }
    this.renderAll();
  }

  resolveFile(file) {
    if (!file) return null;
    if (this.fileMap.has(file)) return this.fileMap.get(file);
    if (isAbs(file)) return file;
    if (this.ws) return `${this.ws.dir}/${file}`;
    return joinPath(dirname(this.key), file);
  }

  /**
   * Asks the host where the files of the canvas are: Obsidian writes paths relative to the vault root,
   * which can be a folder above the one opened here, and files may have moved (found by name then).
   */
  async resolveFiles() {
    if (!this.data) return;
    const want = [...new Set(this.data.nodes.filter((n) => n.type === 'file' && n.file && !this.fileMap.has(String(n.file))).map((n) => String(n.file)))];
    if (!want.length) return;
    let res = null;
    try { res = await api.call('note.resolveFiles', { path: this.key, files: want }); } catch { /* keep the direct guess */ }
    if (!res || !this.data) return;
    for (const f of want) this.fileMap.set(f, Object.prototype.hasOwnProperty.call(res, f) ? res[f] : null);
    this.renderAll();
  }

  /** Workspace path ("@id/a/b.png", "Ws/a/b.png" or absolute) → what a canvas stores (a guess, see storePaths). */
  storePath(path) {
    if (this.ws && path.toLowerCase().startsWith(this.ws.dir.toLowerCase() + '/')) return path.slice(this.ws.dir.length + 1);
    const d = dirname(this.key) + '/';
    if (path.toLowerCase().startsWith(d.toLowerCase())) return path.slice(d.length);
    return path;
  }

  /** What the canvas stores for these files: paths from the Obsidian vault root, like Obsidian writes them. */
  async storePaths(paths) {
    try {
      const r = await api.call('canvas.paths', { path: this.key, paths });
      if (Array.isArray(r) && r.length === paths.length) return r;
    } catch { /* older host: guess */ }
    return paths.map((p) => this.storePath(p));
  }

  renderNode(n) {
    let el = this.nodeEls.get(n.id);
    if (!el) {
      el = div('canvas-node');
      el.dataset.id = n.id;
      const box = div('canvas-node-container', el);
      div('canvas-node-content', box);
      div('cv-ring', el);
      for (const d of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) div(`cv-resize ${d}`, el).dataset.dir = d;
      for (const s of ['top', 'right', 'bottom', 'left']) {
        const p = div(`cv-port ${s}`, el);
        p.dataset.side = s;
        p.title = 'Drag to connect';
      }
      this.nodeEls.set(n.id, el);
      (n.type === 'group' ? this.groupsLayer : this.nodesLayer).appendChild(el);
    }
    const file = n.type === 'file' ? String(n.file || '') : '';
    const kind = n.type === 'file' ? kindOfFile(file) : n.type;
    const shape = isShape(n) ? n.mnShape : null;
    el.className = `canvas-node is-${n.type}${kind !== n.type ? ' is-' + kind : ''}${shape ? ' is-shape' : ''}${this.sel.has(n.id) ? ' selected' : ''}${this.editingId === n.id ? ' editing' : ''}${this.spineLiveId === n.id ? ' spv-live' : ''}`;
    this.place(el, n);
    const c = colorOf(n.color);
    if (c) el.style.setProperty('--node-color', c);
    else el.style.removeProperty('--node-color');
    el.toggleAttribute('data-color', !!c);
    if (this.editingId === n.id) return;
    const where = n.type === 'file' ? (this.fileMap.has(file) ? String(this.fileMap.get(file)) : '?') : '';
    const sig = `${n.type}|${n.text}|${n.file}|${n.url}|${n.label}|${kind === 'image' ? this.thumbWidth(n) : ''}|${where}|${shape ? `${shape}@${n.width}x${n.height}` : ''}`;
    if (el._sig === sig) return;
    el._sig = sig;
    const content = el.querySelector(':scope > .canvas-node-container > .canvas-node-content');
    content.className = 'canvas-node-content';
    // A Spine model drawn here before gives its WebGL back first.
    if (el._spine) { el._spine.destroy(); el._spine = null; }
    content.innerHTML = '';
    const old = el.querySelector(':scope > .canvas-group-label');
    if (old) old.remove();
    const oldShape = el.querySelector(':scope > .canvas-node-container > .cv-shape');
    if (oldShape) oldShape.remove();
    content.style.removeProperty('--shape-pad');

    if (n.type === 'text') {
      content.classList.add('markdown-rendered');
      content.innerHTML = renderMarkdown(n.text, this.key);
      if (shape) {
        // The shape's outline under its text, drawn for the card's size (drawn again after a resize).
        content.parentNode.insertBefore(outlineOf(n), content);
        content.style.setProperty('--shape-pad', SHAPE.get(shape).pad);
      }
    } else if (n.type === 'group') {
      const label = document.createElement('div');
      label.className = 'canvas-group-label';
      label.textContent = n.label || '';
      el.insertBefore(label, el.firstChild);
    } else if (kind === 'image') {
      const path = this.resolveFile(file);
      if (path === null) {
        content.appendChild(this.missing(file));
      } else if (where === '?') {
        // The host is still locating the file (see resolveFiles): no guessing, no 404s.
        div('cv-loading', content);
      } else {
        const img = document.createElement('img');
        img.className = 'cv-img';
        img.draggable = false;
        img.decoding = 'async';
        img.addEventListener('load', () => img.classList.add('loaded'));
        img.addEventListener('error', () => {
          // Before the host has located the file this is only a guess: wait for resolveFiles().
          if (!this.fileMap.has(file)) return;
          content.innerHTML = '';
          content.appendChild(this.missing(file));
        });
        img.src = `${fileUrl(path)}?w=${this.thumbWidth(n)}`;
        content.appendChild(img);
      }
    } else if (kind === 'note') {
      const path = this.resolveFile(file);
      const note = findNote(path);
      const head = div('cv-file-head', content);
      head.appendChild(icon('file-text', 15));
      const t = document.createElement('span');
      t.textContent = note ? note.title : file.split('/').pop().replace(/\.(md|markdown|txt)$/i, '');
      head.appendChild(t);
      const body = div('cv-file-body markdown-rendered', content);
      this.fillNote(path, body);
    } else if (kind === 'video' || kind === 'audio') {
      const path = this.resolveFile(file);
      if (path === null) content.appendChild(this.missing(file));
      else if (where === '?') div('cv-loading', content);
      else {
        const media = renderLocalMedia(content, fileUrl(path), kind, file.split('/').pop(), { onPlay: () => this.setSelection([n.id]) });
        if (kind === 'video' && n._fit) {
          // A video just added: make its card the shape of the video.
          const v = media.querySelector('video');
          v && v.addEventListener('loadedmetadata', () => {
            delete n._fit;
            if (!v.videoWidth || !v.videoHeight || !this.byId(n.id)) return;
            n.height = Math.max(MIN_H, Math.round(n.width * v.videoHeight / v.videoWidth));
            this.place(el, n);
            this.renderEdges();
            this.commit();
          }, { once: true });
        }
      }
    } else if (kind === 'spine') {
      // A Spine model (.skel with its .atlas): plays in the card, its bar shows on hover.
      const path = this.resolveFile(file);
      if (path === null) content.appendChild(this.missing(file));
      else if (where === '?') div('cv-loading', content);
      // Dragging and the wheel move the board until the card is double-clicked (then they move the model).
      else el._spine = mountSpine(content, { path, compact: true, key: this.key, id: n.id, interactive: () => el.classList.contains('spv-live') });
    } else if (n.type === 'file') {
      const head = div('cv-file-head', content);
      head.appendChild(icon(/\.canvas$/i.test(file) ? 'canvas' : 'file', 15));
      const t = document.createElement('span');
      t.textContent = file.split('/').pop();
      head.appendChild(t);
      const hint = div('cv-file-body cv-muted', content);
      hint.textContent = 'Double-click to open';
    } else if (n.type === 'link') {
      const url = String(n.url || '');
      if (!linkPreviewsOn()) {
        renderEmbed(content, null, url, this.embedOpts(n));
        return;
      }
      const box = div('cv-link', content);
      box.appendChild(icon('globe', 28));
      const u = document.createElement('a');
      u.dataset.href = url;
      u.textContent = url.replace(/^https?:\/\//, '');
      box.appendChild(u);
      const hint = div('cv-muted', box);
      hint.textContent = `Loading the preview of ${hostOf(url)}…`;
      this.fillLinkPreview(el, content, n);
    }
  }

  embedOpts(n) {
    return {
      fill: true,
      openLink: (u) => openLink(u, this.key),
      onPlay: () => { if (!this.sel.has(n.id)) this.setSelection([n.id]); },
    };
  }

  /** Shows the link's card (post, video, page) once its preview is known; a preview that failed is asked again later. */
  fillLinkPreview(el, content, n) {
    const url = String(n.url || '');
    if (!url) return;
    const sig = el._sig;
    getPreview(url, this.key).then((info) => {
      if (el._sig !== sig || !el.isConnected) return;
      renderEmbed(content, info, url, this.embedOpts(n));
      if (info && n._fit) this.fitLinkNode(n, info);
      // Not reachable right now (offline, busy site): try again in a while, a few times.
      if ((!info || (info.failed && info.transient)) && linkPreviewsOn()) {
        const r = this.retries.get(url) || { count: 0, timer: 0 };
        if (r.count < 3 && !r.timer) {
          r.count++;
          r.timer = setTimeout(() => {
            r.timer = 0;
            const e2 = this.nodeEls.get(n.id);
            if (e2 && e2.isConnected && this.byId(n.id)) { e2._sig = null; this.renderNode(n); }
          }, 95_000);
          this.retries.set(url, r);
        }
      }
    });
  }

  /** A link card that was just added takes the height its content needs (post text, video shape). */
  fitLinkNode(n, info) {
    delete n._fit;
    if (!this.byId(n.id)) return;
    let h = n.height;
    const inner = n.width - 32;
    if (info.kind === 'tweet') {
      if (info.failed) h = 220;
      else {
        const m = (info.media || [])[0];
        const ratio = m && m.ratio > 0 ? Math.max(0.56, Math.min(2.4, m.ratio)) : 16 / 9;
        const lines = info.text ? info.text.split('\n').reduce((s, l) => s + Math.max(1, Math.ceil(l.length / 58)), 0) : 0;
        h = 14 + 44 + (lines ? 10 + Math.min(7, lines) * 21 : 0) + (m ? 10 + inner / ratio : 0) + (info.quote ? 120 : 0) + 42;
      }
    } else if (info.kind === 'youtube') h = Math.round(n.width * 9 / 16) + 66;
    else if (!info.image) h = 120;
    n.height = Math.round(clamp(h, 120, 1100));
    const el = this.nodeEls.get(n.id);
    if (el) this.place(el, n);
    this.renderEdges();
    this.commit();
  }

  /** Downloads the previews of all web links again (the "Reload link previews" button). */
  async reloadPreviews() {
    if (!this.data) return;
    const links = this.data.nodes.filter((n) => n.type === 'link' && n.url);
    if (!links.length) { toast('This canvas has no web links', 'info', 1600); return; }
    toast(`Reloading ${links.length} link preview${links.length === 1 ? '' : 's'}…`, 'info', 1600);
    this.retries.clear();
    await Promise.all(links.map((n) => this.reloadPreview(n)));
  }

  reloadPreview(n) {
    const el = this.nodeEls.get(n.id);
    if (el) {
      const content = el.querySelector(':scope > .canvas-node-container > .canvas-node-content');
      content && content.querySelector('.mn-embed')?.classList.add('reloading');
    }
    return refreshLinkPreview(n.url, this.key).then(() => {
      const e2 = this.nodeEls.get(n.id);
      if (e2 && this.byId(n.id)) { e2._sig = null; this.renderNode(n); }
    });
  }

  syncLinks() {
    if (this.data) syncPreviews(this.key, this.data.nodes.filter((n) => n.type === 'link' && n.url).map((n) => String(n.url)));
  }

  missing(file) {
    const m = div('cv-missing-file');
    m.appendChild(icon('alert', 18));
    const s = document.createElement('span');
    s.textContent = `Not found: ${file}`;
    m.appendChild(s);
    return m;
  }

  thumbWidth(n) {
    return n.width <= 220 ? 512 : n.width <= 560 ? 1024 : 2048;
  }

  async fillNote(path, body) {
    if (!path) {
      body.textContent = 'This note was not found.';
      body.classList.add('cv-muted');
      return;
    }
    let text = this.noteText.get(path);
    if (text === undefined) {
      try {
        text = (await api.call('note.read', { path })).text;
      } catch { text = null; }
      this.noteText.set(path, text);
    }
    if (text == null) {
      body.textContent = 'This note does not exist (yet).';
      body.classList.add('cv-muted');
      return;
    }
    const noFm = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    body.innerHTML = renderMarkdown(noFm.slice(0, 6000), path);
  }

  place(el, n) {
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.style.width = `${n.width}px`;
    el.style.height = `${n.height}px`;
    if (n.mnShape) {
      // Drawn again while it is resized (stretching it would thin and thicken its line).
      const s = el.querySelector(':scope > .canvas-node-container > .cv-shape');
      if (s && s.dataset.size !== `${n.width}x${n.height}`) s.replaceWith(outlineOf(n));
    }
  }

  renderEdges() {
    const s = this.svg;
    while (s.firstChild) s.removeChild(s.firstChild);
    this.labelsLayer.innerHTML = '';
    this.edgeGeo = new Map();
    if (!this.data) { this.renderEdgeUI(); return; }
    const by = new Map(this.data.nodes.map((n) => [n.id, n]));
    for (const e of this.allEdges()) {
      const g = edgeEnds(e, by);
      if (!g) continue;
      const toArrow = (e.toEnd || 'arrow') === 'arrow';
      const fromArrow = e.fromEnd === 'arrow';
      // The line stops short of the arrow heads so it does not poke through them.
      const width = clamp(Number(e.mnWidth) || 3, 1, 24);
      const head = Math.max(12, width * 3.2);
      const path = edgePath(g, e.mnPath || 'curve', fromArrow, toArrow, head * 0.8);
      const col = colorOf(e.color) || 'var(--cv-edge)';
      const grp = svg('g', { class: 'cv-edge' + (this.selEdge === e.id ? ' selected' : '') });
      grp.style.setProperty('--edge-color', col);
      grp.style.setProperty('--edge-w', `${width}px`);
      const line = svg('path', { d: path.d, class: 'line' });
      const gap = Math.round(width * 22) / 10;
      if (e.mnDash === 'dashed') line.setAttribute('stroke-dasharray', `${width * 3} ${gap}`);
      else if (e.mnDash === 'dotted') line.setAttribute('stroke-dasharray', `0.1 ${gap}`);
      grp.appendChild(line);
      if (toArrow) grp.appendChild(svg('polygon', { points: arrowHeadAt(g.p2, g.t2, head), class: 'head' }));
      if (fromArrow) grp.appendChild(svg('polygon', { points: arrowHeadAt(g.p1, g.t1, head), class: 'head' }));
      const hit = svg('path', { d: path.d, class: 'hit' });
      hit.style.strokeWidth = `${Math.max(16, width + 12)}px`;
      hit.dataset.id = e.id;
      grp.appendChild(hit);
      s.appendChild(grp);
      const geo = { g, path, hit };
      this.edgeGeo.set(e.id, geo);
      if (e.label) {
        let mid;
        try {
          const len = hit.getTotalLength();
          const pt = hit.getPointAtLength(len / 2);
          mid = [pt.x, pt.y];
        } catch { mid = bez(path.segs[Math.floor(path.segs.length / 2)], 0.5); }
        const l = div('cv-edge-label', this.labelsLayer);
        l.textContent = e.label;
        l.style.left = `${mid[0]}px`;
        l.style.top = `${mid[1]}px`;
        l.dataset.id = e.id;
      }
    }
    if (this.drag && (this.drag.kind === 'connect' || this.drag.kind === 'draw') && this.drag.temp) s.appendChild(this.drag.temp);
    this.renderEdgeUI();
  }

  // ── arrows: data ──
  allEdges() {
    return this.data ? [...this.data.edges, ...(this.data.mnEdges || [])] : [];
  }

  findEdge(id) {
    return id ? this.allEdges().find((x) => x.id === id) || null : null;
  }

  /** Joined to cards at both ends → Obsidian's edges; a loose end → MarkNotes' own list. */
  fileEdge(e) {
    const d = this.data;
    const both = !!(e.fromNode && e.toNode);
    if (both) { delete e.fromX; delete e.fromY; delete e.toX; delete e.toY; }
    if (!e.fromNode) delete e.fromSide;
    if (!e.toNode) delete e.toSide;
    tidyEnds(e);
    if (e.mnPoints && !e.mnPoints.length) delete e.mnPoints;
    if (both ? d.edges.includes(e) : (d.mnEdges || []).includes(e)) return;
    d.edges = d.edges.filter((x) => x !== e);
    if (d.mnEdges) d.mnEdges = d.mnEdges.filter((x) => x !== e);
    if (both) d.edges.push(e);
    else (d.mnEdges || (d.mnEdges = [])).push(e);
    if (d.mnEdges && !d.mnEdges.length) delete d.mnEdges;
  }

  removeEdges(ids) {
    const d = this.data;
    d.edges = d.edges.filter((x) => !ids.has(x.id));
    if (d.mnEdges) {
      d.mnEdges = d.mnEdges.filter((x) => !ids.has(x.id));
      if (!d.mnEdges.length) delete d.mnEdges;
    }
  }

  /** A loose copy of an arrow (where it is drawn now), moved by dx/dy: what Copy, Duplicate and Paste use. */
  looseCopy(e, dx = 0, dy = 0) {
    const geo = this.edgeGeo && this.edgeGeo.get(e.id);
    if (!geo) return null;
    const { g } = geo;
    const c = { id: newId(), fromX: Math.round(g.p1[0] + dx), fromY: Math.round(g.p1[1] + dy), toX: Math.round(g.p2[0] + dx), toY: Math.round(g.p2[1] + dy) };
    for (const k of ['fromEnd', 'toEnd', 'color', 'label', 'mnPath', 'mnWidth', 'mnDash']) if (e[k] !== undefined) c[k] = e[k];
    if (g.pts.length) c.mnPoints = g.pts.map((p) => ({ x: Math.round(p[0] + dx), y: Math.round(p[1] + dy) }));
    return c;
  }

  reverseEdge(e) {
    const fe = e.fromEnd || 'none';
    const te = e.toEnd || 'arrow';
    const swap = (a, b) => { const t = e[a]; if (e[b] !== undefined) e[a] = e[b]; else delete e[a]; if (t !== undefined) e[b] = t; else delete e[b]; };
    swap('fromNode', 'toNode');
    swap('fromSide', 'toSide');
    swap('fromX', 'toX');
    swap('fromY', 'toY');
    e.fromEnd = te;
    e.toEnd = fe;
    tidyEnds(e);
    if (e.mnPoints) e.mnPoints.reverse();
  }

  duplicateEdge(e) {
    const c = this.looseCopy(e, 40, 40);
    if (!c) return;
    this.fileEdge(c);
    this.selectEdge(c.id);
    this.renderEdges();
    this.commit();
  }

  setEdgeType(e, kind) {
    if (kind === 'curve') delete e.mnPath;
    else e.mnPath = kind;
    if (kind === 'elbow' && e.mnPoints && e.mnPoints.length > 1) e.mnPoints = e.mnPoints.slice(0, 1);
    this.renderEdges();
    this.commit();
  }

  // ── arrows: handles and bar ──
  /** Handles of the selected arrow: its two ends, its bend points, and "add a bend" points between them. */
  renderEdgeUI() {
    const ui = this.edgeUI;
    if (!ui) return;
    ui.innerHTML = '';
    const e = this.findEdge(this.selEdge);
    const geo = e && this.edgeGeo ? this.edgeGeo.get(e.id) : null;
    this.updateEdgeBar();
    if (!geo || this.readOnly) return;
    const add = (cls, p, data) => {
      const h = div('cv-eh ' + cls, ui);
      h.style.left = `${p[0]}px`;
      h.style.top = `${p[1]}px`;
      Object.assign(h.dataset, data);
      return h;
    };
    if ((e.mnPath || 'curve') !== 'elbow') {
      geo.path.segs.forEach((sg, i) => add('mid', bez(sg, 0.5), { i: String(i) }).title = 'Drag to bend');
      geo.g.pts.forEach((p, i) => add('pt', p, { i: String(i) }).title = 'Drag to move · double-click to remove');
    }
    add('end', geo.g.p1, { end: 'from' }).title = 'Drag to connect to a card, or leave it loose';
    add('end', geo.g.p2, { end: 'to' }).title = 'Drag to connect to a card, or leave it loose';
  }

  /** Miro's bar for a selected arrow: start and end caps, reverse, line type, colour, text, duplicate, delete. */
  buildEdgeBar() {
    const bar = this.edgeBar = div('cv-selbar cv-edgebar', this.wrap);
    const btn = (title, run, cls = '') => {
      const b = document.createElement('button');
      b.className = 'cv-sbtn' + (cls ? ' ' + cls : '');
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); run(e); });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('dblclick', (e) => e.stopPropagation());
      bar.appendChild(b);
      return b;
    };
    const edge = () => this.findEdge(this.selEdge);
    const change = (fn) => { const e = edge(); if (!e || this.locked()) return; fn(e); tidyEnds(e); this.renderEdges(); this.commit(); };
    this.ebStart = btn('Start of the line', () => change((e) => { e.fromEnd = e.fromEnd === 'arrow' ? 'none' : 'arrow'; }), 'wide');
    btn('Reverse direction', () => change((e) => this.reverseEdge(e))).appendChild(icon('swap', 16));
    this.ebEnd = btn('End of the line', () => change((e) => { e.toEnd = (e.toEnd || 'arrow') === 'arrow' ? 'none' : 'arrow'; }), 'wide');
    div('cv-tsep', bar);
    this.ebType = btn('Line style: thickness, type, dashes', (ev) => this.openLineStyle(ev.currentTarget), 'typed');
    this.ebColor = btn('Colour', (ev) => {
      const e = edge();
      if (!e || this.locked()) return;
      const r = ev.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.bottom + 6, [{ swatches: true, colors: PRESETS, value: colorOf(e.color), onPick: (c) => change((x) => { if (c) x.color = presetOf(c); else delete x.color; }) }], { minWidth: 0 });
    });
    this.ebColor.appendChild(div('cv-swatch-dot'));
    div('cv-tsep', bar);
    btn('Add text', () => { const e = edge(); if (e && !this.locked()) this.editEdgeLabel(e.id); }).appendChild(icon('type-plus', 16));
    btn('Duplicate', () => { const e = edge(); if (e && !this.locked()) this.duplicateEdge(e); }).appendChild(icon('copy', 16));
    btn('Delete (Del)', () => { if (!this.locked()) this.deleteSelection(); }).appendChild(icon('trash', 16));
  }

  updateEdgeBar() {
    const bar = this.edgeBar;
    if (!bar) return;
    const e = this.findEdge(this.selEdge);
    const geo = e && this.edgeGeo ? this.edgeGeo.get(e.id) : null;
    if (!geo || this.editingId || (this.drag && this.drag.moved) || this.readOnly) { bar.classList.remove('show'); return; }
    const cap = (b, on, iconName) => {
      b.innerHTML = '';
      if (on) b.appendChild(icon(iconName, 16));
      else { const t = document.createElement('span'); t.className = 'cv-sbtn-text'; t.textContent = 'None'; b.appendChild(t); }
    };
    cap(this.ebStart, e.fromEnd === 'arrow', 'arrow-left');
    cap(this.ebEnd, (e.toEnd || 'arrow') === 'arrow', 'arrow-right');
    const kind = e.mnPath || 'curve';
    this.ebType.innerHTML = '';
    this.ebType.appendChild(icon(kind === 'curve' ? 'curve' : kind === 'straight' ? 'line' : 'elbow', 16));
    const cap2 = document.createElement('span');
    cap2.className = 'cv-sbtn-caption';
    cap2.textContent = 'Type';
    this.ebType.appendChild(cap2);
    this.ebColor.firstChild.style.background = colorOf(e.color) || 'var(--cv-edge)';
    let box;
    try { box = geo.hit.getBBox(); } catch { box = null; }
    if (!box) { bar.classList.remove('show'); return; }
    const { x, y, z } = this.view;
    const x0 = box.x * z + x;
    const x1 = (box.x + box.width) * z + x;
    const y0 = box.y * z + y;
    const y1 = (box.y + box.height) * z + y;
    const W = this.wrap.clientWidth;
    const H = this.wrap.clientHeight;
    if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) { bar.classList.remove('show'); return; }
    bar.classList.add('show');
    const bw = bar.offsetWidth || 300;
    const bh = bar.offsetHeight || 38;
    let top = y0 - bh - 18;
    if (top < 8) top = y1 + 18 < H - bh - 70 ? y1 + 18 : 8;
    const left = clamp((x0 + x1) / 2 - bw / 2, 8, W - bw - 8);
    bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** The box around several selected cards (its corners resize them all, like Miro). */
  updateGroupBox() {
    const box = this.groupBox;
    if (!box || !this.wrap) return;
    const nodes = this.data ? [...this.sel].map((id) => this.byId(id)).filter(Boolean) : [];
    const multi = nodes.length > 1;
    this.wrap.classList.toggle('multi', multi);
    if (!multi || this.editingId) { box.classList.remove('show'); return; }
    const x0 = Math.min(...nodes.map((n) => n.x));
    const y0 = Math.min(...nodes.map((n) => n.y));
    const x1 = Math.max(...nodes.map((n) => n.x + n.width));
    const y1 = Math.max(...nodes.map((n) => n.y + n.height));
    Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    box.classList.add('show');
  }

  selectionBox() {
    const nodes = [...this.sel].map((id) => this.byId(id)).filter(Boolean);
    if (!nodes.length) return null;
    return {
      x0: Math.min(...nodes.map((n) => n.x)), y0: Math.min(...nodes.map((n) => n.y)),
      x1: Math.max(...nodes.map((n) => n.x + n.width)), y1: Math.max(...nodes.map((n) => n.y + n.height)),
    };
  }

  scheduleEdges() {
    if (this.edgeFrame) return;
    this.edgeFrame = requestAnimationFrame(() => { this.edgeFrame = 0; this.renderEdges(); });
  }

  // ── view ──
  applyView() {
    if (!this.view) return;
    const { x, y, z } = this.view;
    this.layer.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    let s = 24 * z;
    while (s < 12) s *= 4;
    this.bg.style.backgroundSize = `${s}px ${s}px`;
    this.bg.style.backgroundPosition = `${x}px ${y}px`;
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(z * 100)}%`;
    this.wrap.classList.toggle('far', z < 0.35);
    if (this.lastIz !== z) {
      this.lastIz = z;
      this.wrap.style.setProperty('--iz', (1 / z).toFixed(4));
    }
    this.updateSelBar();
    this.updateEdgeBar();
    if (this.pop) this.closePop();
  }

  // ── smooth navigation (momentum after a drag, eased zoom), like Miro ──
  momentumOn() {
    return settings.peek().canvasMomentum !== false;
  }

  stopGlide() {
    if (this.glideFrame) cancelAnimationFrame(this.glideFrame);
    this.glideFrame = 0;
    this.zoomAnim = null;
  }

  /** Keeps the board moving after a quick drag, slowing down. vx/vy in px per ms. */
  glide(vx, vy) {
    this.stopGlide();
    const amount = clamp(Number(settings.peek().canvasMomentumAmount ?? 50), 0, 100);
    const decay = 0.85 + 0.13 * (amount / 100); // per 1/60 s
    let last = performance.now();
    const step = (t) => {
      const dt = Math.min(40, t - last);
      last = t;
      this.view.x += vx * dt;
      this.view.y += vy * dt;
      const k = Math.pow(decay, dt / 16.67);
      vx *= k;
      vy *= k;
      this.applyView();
      if (Math.hypot(vx, vy) > 0.015) this.glideFrame = requestAnimationFrame(step);
      else { this.glideFrame = 0; this.saveViewSoon(); }
    };
    this.glideFrame = requestAnimationFrame(step);
  }

  /** Eased zoom towards z around the point (cx, cy) of the board; scrolling again retargets it. */
  smoothZoom(cx, cy, z) {
    z = clamp(z, MIN_Z, MAX_Z);
    if (!this.momentumOn()) { this.zoomAt(cx, cy, z); return; }
    if (this.glideFrame && !this.zoomAnim) this.stopGlide();
    const px = (cx - this.view.x) / this.view.z;
    const py = (cy - this.view.y) / this.view.z;
    this.zoomAnim = { cx, cy, px, py, z };
    if (this.glideFrame) return;
    const step = () => {
      const a = this.zoomAnim;
      if (!a) { this.glideFrame = 0; return; }
      const cur = this.view.z;
      const next = Math.abs(a.z - cur) / a.z < 0.002 ? a.z : cur * Math.pow(a.z / cur, 0.3);
      this.view.z = next;
      this.view.x = a.cx - a.px * next;
      this.view.y = a.cy - a.py * next;
      this.applyView();
      if (next === a.z) { this.zoomAnim = null; this.glideFrame = 0; this.saveViewSoon(); return; }
      this.glideFrame = requestAnimationFrame(step);
    };
    this.glideFrame = requestAnimationFrame(step);
  }

  saveView() {
    if (!this.view) return;
    const all = persisted.canvasView || (persisted.canvasView = {});
    delete all[this.key];
    all[this.key] = { x: Math.round(this.view.x), y: Math.round(this.view.y), z: +this.view.z.toFixed(3) };
    const keys = Object.keys(all);
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete all[k];
    saveState();
  }

  fit(animate) {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (!w || !h) return;
    this.stopGlide();
    const nodes = this.data ? this.data.nodes : [];
    if (!nodes.length) {
      this.view = { x: w / 2, y: h / 2, z: 1 };
      this.applyView();
      this.saveView();
      return;
    }
    this.fitRect(Math.min(...nodes.map((n) => n.x)), Math.min(...nodes.map((n) => n.y)),
      Math.max(...nodes.map((n) => n.x + n.width)), Math.max(...nodes.map((n) => n.y + n.height)), animate, 1);
  }

  /** Shows the rectangle (canvas units) whole, centred, zoomed in at most to maxZ. */
  fitRect(x0, y0, x1, y1, animate, maxZ = 1) {
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (!w || !h) return;
    this.stopGlide();
    const pad = 60;
    const z = clamp(Math.min((w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2 - 50) / Math.max(1, y1 - y0)), MIN_Z, maxZ);
    this.view = { z, x: (w - (x1 - x0) * z) / 2 - x0 * z, y: (h - 50 - (y1 - y0) * z) / 2 - y0 * z };
    if (animate) {
      this.layer.classList.add('animate');
      clearTimeout(this.animTimer);
      this.animTimer = setTimeout(() => this.layer.classList.remove('animate'), 260);
    }
    this.applyView();
    this.saveView();
  }

  zoomAt(cx, cy, z) {
    z = clamp(z, MIN_Z, MAX_Z);
    const k = z / this.view.z;
    this.view.x = cx - (cx - this.view.x) * k;
    this.view.y = cy - (cy - this.view.y) * k;
    this.view.z = z;
    this.applyView();
    this.saveViewSoon();
  }

  zoomBy(f) {
    const base = this.zoomAnim ? this.zoomAnim.z : this.view.z;
    this.smoothZoom(this.wrap.clientWidth / 2, this.wrap.clientHeight / 2, base * f);
  }

  zoomTo(z) {
    this.smoothZoom(this.wrap.clientWidth / 2, this.wrap.clientHeight / 2, z);
  }

  saveViewSoon() {
    clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => this.saveView(), 600);
  }

  toCanvas(e) {
    const r = this.wrap.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.x) / this.view.z, y: (e.clientY - r.top - this.view.y) / this.view.z };
  }

  centerPoint() {
    return { x: (this.wrap.clientWidth / 2 - this.view.x) / this.view.z, y: (this.wrap.clientHeight / 2 - this.view.y) / this.view.z };
  }

  // ── selection ──
  setSelection(ids) {
    const prev = this.sel;
    this.sel = new Set(ids);
    for (const id of new Set([...prev, ...this.sel])) {
      const el = this.nodeEls.get(id);
      if (el) el.classList.toggle('selected', this.sel.has(id));
    }
    if (this.sel.size && this.selEdge) this.selectEdge(null);
    this.updateGroupBox();
    this.updateSelBar();
  }

  selectEdge(id) {
    this.selEdge = id || null;
    if (id && this.sel.size) this.setSelection([]);
    for (const g of this.svg.querySelectorAll('.cv-edge')) g.classList.toggle('selected', g.querySelector('.hit')?.dataset.id === this.selEdge);
    this.renderEdgeUI();
  }

  deleteSelection() {
    if (!this.data) return;
    if (this.selEdge) {
      this.removeEdges(new Set([this.selEdge]));
      this.selEdge = null;
      this.renderEdges();
      this.commit();
      return;
    }
    if (!this.sel.size) return;
    const ids = this.sel;
    this.data.nodes = this.data.nodes.filter((n) => !ids.has(n.id));
    // Arrows of removed cards go with them (Obsidian does the same).
    const gone = new Set(this.allEdges().filter((e) => ids.has(e.fromNode) || ids.has(e.toNode)).map((e) => e.id));
    this.removeEdges(gone);
    this.sel = new Set();
    this.renderAll();
    this.updateGroupBox();
    this.updateSelBar();
    this.commit();
  }

  // ── editing text cards ──
  /**
   * Edits a text card in place with the notes' live-preview editor (formatted while typing, like Obsidian).
   * at: the screen point that was double-clicked (the caret goes there), else the end of the text.
   */
  startEditing(id, at = null) {
    const n = this.byId(id);
    const el = this.nodeEls.get(id);
    if (!n || !el || n.type !== 'text' || this.readOnly) return;
    if (this.editingId && this.editingId !== id) this.stopEditing(true);
    if (this.editingId === id) return;
    this.editingId = id;
    el.classList.add('editing');
    this.updateSelBar();
    const content = el.querySelector(':scope > .canvas-node-container > .canvas-node-content');
    content.className = 'canvas-node-content';
    content.innerHTML = '';
    const box = div('cv-editor cv-cm', content);
    adoptEditorCss(this.root);
    const view = ed.createCardEditor({
      parent: box,
      root: this.root,
      doc: n.text || '',
      key: this.key,
      renderHtml: (html) => renderMarkdown(html, this.key),
      onDone: () => { this.stopEditing(true); this.wrap.focus({ preventScroll: true }); },
      onMenu: (e, v) => openMenu(e.clientX, e.clientY, editorMenuItems(v, {
        search: (q) => { mainView.value = { kind: 'search', q }; },
      }), { minWidth: 230 }),
    });
    this.cardView = view;
    // Leaving the card (clicking elsewhere, another window) ends editing; its menu and dialogs do not.
    view.dom.addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      setTimeout(() => {
        if (this.cardView !== view || view.hasFocus) return;
        // A table cell edited in place inside the card is still the card's editor.
        const inside = this.root.activeElement || document.activeElement;
        if (inside && view.dom.contains(inside)) return;
        if (to && to.closest && to.closest('.menu, .modal-layer')) return;
        if (!document.hasFocus()) return;
        this.stopEditing(true);
      }, 0);
    });
    requestAnimationFrame(() => {
      if (this.cardView !== view) return;
      view.focus();
      const pos = at ? view.posAtCoords({ x: at.x, y: at.y }) : null;
      view.dispatch({ selection: { anchor: pos ?? view.state.doc.length }, scrollIntoView: true });
    });
  }

  stopEditing(save) {
    const id = this.editingId;
    if (!id) return;
    this.editingId = null;
    const view = this.cardView;
    this.cardView = null;
    const n = this.byId(id);
    const el = this.nodeEls.get(id);
    const text = view ? view.state.doc.toString() : (n && n.text) || '';
    if (view) view.destroy();
    if (!n || !el) return;
    el.classList.remove('editing');
    this.updateSelBar();
    if (n._new && !text.trim()) {
      // A card that was added and left empty just goes away.
      this.data.nodes = this.data.nodes.filter((x) => x.id !== id);
      el.remove();
      this.nodeEls.delete(id);
      this.sel.delete(id);
      this.renderEdges();
      return;
    }
    const changed = save && text !== (n.text || '');
    if (save) n.text = text;
    const fresh = !!n._new;
    delete n._new;
    el._sig = null;
    this.renderNode(n);
    if (changed || fresh) this.commit();
  }

  // ── pointer ──
  onDown(e) {
    if (e.target.closest('.cv-editor, .cv-toolbar, .cv-selbar')) return;
    // Touch (the phone): a second finger turns whatever the first one started into a pinch that zooms and moves.
    if (e.pointerType === 'touch') {
      if (!this.touches) this.touches = new Map();
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.touches.size >= 2 && this.view) {
        if (this.drag) {
          this.wrap.classList.remove('panning', 'dragging');
          this.showGuides(null, null);
          this.drag = null;
        }
        const [a, b] = [...this.touches.values()];
        const r = this.wrap.getBoundingClientRect();
        this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z: this.view.z, cx: (a[0] + b[0]) / 2 - r.left, cy: (a[1] + b[1]) / 2 - r.top, x: this.view.x, y: this.view.y };
        e.preventDefault();
        return;
      }
    }
    // A Spine card's own buttons (costume, pose, animation, snapshot, record, zoom).
    if (e.button === 0 && e.target.closest('.spv-bar, .spv-ctrls')) return;
    // A click anywhere else gives back the mouse a Spine card had.
    if (this.spineLiveId && !e.target.closest('.canvas-node.spv-live')) this.setSpineLive(null);
    this.stopGlide();
    if (this.editingId) this.stopEditing(true);
    if (!this.view) return;
    const nodeEl = e.target.closest('.canvas-node');
    // The controls of a playing video (bottom bar) and audio players belong to the player.
    const media = e.target.closest('video[controls], audio');
    if (media && nodeEl && e.button === 0) {
      const r = media.getBoundingClientRect();
      if (media.tagName === 'AUDIO' || e.clientY > r.bottom - 56) return;
    }
    this.wrap.focus({ preventScroll: true });
    const base = { sx: e.clientX, sy: e.clientY, pointer: e.pointerId, moved: false, samples: [[performance.now(), e.clientX, e.clientY]] };
    // The view moves with the middle or right button (a right click that does not move opens the menu),
    // or Space + left button.
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      if (e.button === 1) e.preventDefault();
      this.drag = { ...base, kind: 'pan', vx: this.view.x, vy: this.view.y, right: e.button === 2 };
      return;
    }
    if (e.button !== 0 || !this.data) return;
    const port = e.target.closest('.cv-port');
    const resize = e.target.closest('.cv-resize');
    const hit = e.target.closest('.hit');
    const label = e.target.closest('.cv-edge-label');
    const handle = e.target.closest('.cv-eh');
    const corner = e.target.closest('.cv-gb');
    const p = this.toCanvas(e);
    // Touch on the empty board moves it (a tap without moving clears the selection); cards still move with a finger.
    if (e.pointerType === 'touch' && !nodeEl && !port && !resize && !hit && !label && !handle && !corner && this.tool !== 'shape' && this.tool !== 'arrow') {
      e.preventDefault();
      this.drag = { ...base, kind: 'pan', vx: this.view.x, vy: this.view.y, tapClears: true };
      return;
    }
    const marquee = () => {
      e.preventDefault();
      const r = this.wrap.getBoundingClientRect();
      this.drag = { ...base, kind: 'marquee', ox: e.clientX - r.left, oy: e.clientY - r.top, keep: e.shiftKey ? new Set(this.sel) : new Set(), clear: !e.shiftKey };
    };
    if (this.readOnly) {
      // Read-only: clicks select (to copy), dragging on the board draws a selection box; nothing moves.
      if (hit || label) { this.selectEdge((hit || label).dataset.id); return; }
      if (nodeEl) { this.clickSelect(nodeEl.dataset.id, e.shiftKey); return; }
      if (this.selEdge) this.selectEdge(null);
      marquee();
      return;
    }
    if (this.tool === 'shape') {
      // Placing a shape: a click puts it there at its usual size, a drag draws it at that size.
      e.preventDefault();
      const r = this.wrap.getBoundingClientRect();
      this.drag = { ...base, kind: 'shape-draw', shape: this.toolShape, ox: e.clientX - r.left, oy: e.clientY - r.top, p0: p };
      return;
    }
    if (this.tool === 'arrow') {
      // Drawing an arrow: from a card (its nearest side) or from any point, to a card or to any point.
      e.preventDefault();
      const n = nodeEl ? this.byId(nodeEl.dataset.id) : null;
      const from = n ? { node: n.id, side: nearestSide(n, p) } : { x: p.x, y: p.y };
      this.drag = { ...base, kind: 'draw', from, temp: svg('path', { class: 'cv-temp' }), style: this.toolStyle };
      return;
    }
    if (handle && this.selEdge) {
      e.preventDefault();
      const id = this.selEdge;
      if (handle.classList.contains('end')) this.drag = { ...base, kind: 'edge-end', id, end: handle.dataset.end };
      else if (handle.classList.contains('pt')) this.drag = { ...base, kind: 'edge-pt', id, i: +handle.dataset.i };
      else this.drag = { ...base, kind: 'edge-add', id, i: +handle.dataset.i };
      return;
    }
    if (corner && this.sel.size > 1) {
      e.preventDefault();
      const items = [...this.sel].map((id) => this.byId(id)).filter(Boolean).map((n) => [n, n.x, n.y, n.width, n.height]);
      this.drag = { ...base, kind: 'gresize', dir: corner.dataset.dir, box: this.selectionBox(), items };
      return;
    }
    if (port && nodeEl) {
      e.preventDefault();
      this.drag = { ...base, kind: 'connect', from: nodeEl.dataset.id, side: port.dataset.side, temp: svg('path', { class: 'cv-temp' }) };
      return;
    }
    if (resize && nodeEl) {
      e.preventDefault();
      const n = this.byId(nodeEl.dataset.id);
      this.setSelection([n.id]);
      this.drag = { ...base, kind: 'resize', id: n.id, dir: resize.dataset.dir || 'se', x: n.x, y: n.y, w: n.width, h: n.height, targets: this.snapTargets(new Set([n.id])) };
      return;
    }
    if (hit || label) {
      const id = (hit || label).dataset.id;
      this.selectEdge(id);
      // A loose arrow (no card at either end) moves when dragged by its line, like in Miro.
      const x = this.findEdge(id);
      if (x && !x.fromNode && !x.toNode) this.drag = { ...base, kind: 'edge-move', id, orig: JSON.parse(JSON.stringify(x)) };
      return;
    }
    if (nodeEl) {
      if (!this.clickSelect(nodeEl.dataset.id, e.shiftKey)) return;
      this.startMove(base);
      return;
    }
    // Inside the box of several selected cards: dragging moves them all (like Miro).
    const sb = this.sel.size > 1 ? this.selectionBox() : null;
    if (sb && p.x >= sb.x0 && p.x <= sb.x1 && p.y >= sb.y0 && p.y <= sb.y1 && !e.shiftKey) {
      this.startMove(base);
      return;
    }
    if (this.selEdge) this.selectEdge(null);
    // Dragging on the empty board draws a selection box (Shift adds to the selection); a click clears it.
    marquee();
  }

  /** A click on a card: Shift adds or removes it, otherwise it becomes the selection (unless already in it). */
  clickSelect(id, shift) {
    if (shift) {
      const next = new Set(this.sel);
      if (next.has(id)) next.delete(id); else next.add(id);
      this.setSelection([...next]);
    } else if (!this.sel.has(id)) this.setSelection([id]);
    return this.sel.has(id);
  }

  /** Starts moving the selected cards (with what their groups hold, and the bends of arrows between them). */
  startMove(base) {
    const ids = new Set(this.sel);
    for (const gid of this.sel) {
      const g = this.byId(gid);
      if (g && g.type === 'group') for (const n of this.inside(g)) ids.add(n.id);
    }
    const items = [...ids].map((i) => { const n = this.byId(i); return n && [n, n.x, n.y]; }).filter(Boolean);
    // What snaps: the selected cards (not what a moved group carries along).
    const lead = items.filter(([n]) => this.sel.has(n.id)).map(([n]) => n);
    const box = {
      x: Math.min(...lead.map((n) => n.x)), y: Math.min(...lead.map((n) => n.y)),
      x1: Math.max(...lead.map((n) => n.x + n.width)), y1: Math.max(...lead.map((n) => n.y + n.height)),
    };
    const bends = this.allEdges().filter((x) => x.fromNode && x.toNode && ids.has(x.fromNode) && ids.has(x.toNode) && Array.isArray(x.mnPoints) && x.mnPoints.length)
      .map((x) => [x, x.mnPoints.map((q) => ({ ...q }))]);
    this.drag = { ...base, kind: 'move', items, box, bends, targets: this.snapTargets(ids) };
  }

  /** 'arrow' (opt: the line's style, e.g. {toEnd: 'none'} for a plain line) or 'shape' (opt: its id). */
  setTool(t, opt = null) {
    this.tool = t;
    this.toolShape = t === 'shape' ? opt : null;
    this.toolStyle = t === 'arrow' ? opt : null;
    this.wrap.classList.toggle('tool-arrow', !!t);
    if (this.arrowBtn) this.arrowBtn.classList.toggle('on', t === 'arrow');
    if (this.shapesBtn) this.shapesBtn.classList.toggle('on', t === 'shape');
  }

  onMove(e) {
    this.pointer = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'touch' && this.touches && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pinch && this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const r = this.wrap.getBoundingClientRect();
        const pz = this.pinch;
        const z = clamp(pz.z * (Math.hypot(a[0] - b[0], a[1] - b[1]) || 1) / pz.d, MIN_Z, MAX_Z);
        // The board point that was under the fingers stays under them.
        const wx = (pz.cx - pz.x) / pz.z, wy = (pz.cy - pz.y) / pz.z;
        const cx = (a[0] + b[0]) / 2 - r.left, cy = (a[1] + b[1]) / 2 - r.top;
        this.view.z = z;
        this.view.x = cx - wx * z;
        this.view.y = cy - wy * z;
        this.applyView();
        this.saveViewSoon();
        e.preventDefault();
        return;
      }
    }
    const d = this.drag;
    if (!d) return;
    if (e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.samples) {
      d.samples.push([performance.now(), e.clientX, e.clientY]);
      if (d.samples.length > 8) d.samples.shift();
    }
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      try { this.wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (d.kind === 'pan') this.wrap.classList.add('panning');
      this.wrap.classList.add('dragging');
      this.updateSelBar();
      this.updateEdgeBar();
    }
    const z = this.view.z;
    switch (d.kind) {
      case 'pan':
        this.view.x = d.vx + dx;
        this.view.y = d.vy + dy;
        this.applyView();
        break;
      case 'move': {
        // Snap the selection's box to the other cards' edges/centres, else to the grid (Alt: no snapping).
        let ox = dx / z;
        let oy = dy / z;
        const b = d.box;
        const w = b.x1 - b.x;
        const h = b.y1 - b.y;
        let gx = null;
        let gy = null;
        if (!e.altKey) {
          const thr = 7 / z;
          const prefs = snapPrefs();
          const sx = prefs.objects ? this.snapTo([b.x + ox, b.x + ox + w / 2, b.x + ox + w], d.targets.x, thr) : null;
          const sy = prefs.objects ? this.snapTo([b.y + oy, b.y + oy + h / 2, b.y + oy + h], d.targets.y, thr) : null;
          if (sx) { ox += sx.diff; gx = sx.at; } else if (prefs.grid) ox = Math.round((b.x + ox) / GRID) * GRID - b.x;
          if (sy) { oy += sy.diff; gy = sy.at; } else if (prefs.grid) oy = Math.round((b.y + oy) / GRID) * GRID - b.y;
        }
        ox = Math.round(ox);
        oy = Math.round(oy);
        this.showGuides(gx, gy, gx == null ? null : this.span(d.targets.x, gx, b.y + oy, b.y + oy + h),
          gy == null ? null : this.span(d.targets.y, gy, b.x + ox, b.x + ox + w));
        for (const [n, x0, y0] of d.items) {
          n.x = x0 + ox;
          n.y = y0 + oy;
          const el = this.nodeEls.get(n.id);
          if (el) this.place(el, n);
        }
        for (const [x, orig] of d.bends || []) x.mnPoints = orig.map((q) => ({ x: Math.round(q.x + ox), y: Math.round(q.y + oy) }));
        this.updateGroupBox();
        this.scheduleEdges();
        break;
      }
      case 'resize': {
        const n = this.byId(d.id);
        if (!n) break;
        this.resizeTo(n, d, dx / z, dy / z, e);
        const el = this.nodeEls.get(n.id);
        if (el) this.place(el, n);
        this.scheduleEdges();
        break;
      }
      case 'gresize': {
        // The opposite corner stays; every card scales by the same factor (like Miro).
        const b = d.box;
        const p = this.toCanvas(e);
        const ax = d.dir.includes('w') ? b.x1 : b.x0;
        const ay = d.dir.includes('n') ? b.y1 : b.y0;
        const s = Math.max(0.05, Math.abs(p.x - ax) / Math.max(1, b.x1 - b.x0), Math.abs(p.y - ay) / Math.max(1, b.y1 - b.y0));
        for (const [n, x, y, w, h] of d.items) {
          n.x = Math.round(ax + (x - ax) * s);
          n.y = Math.round(ay + (y - ay) * s);
          n.width = Math.max(MIN_W, Math.round(w * s));
          n.height = Math.max(MIN_H, Math.round(h * s));
          const el = this.nodeEls.get(n.id);
          if (el) this.place(el, n);
        }
        this.updateGroupBox();
        this.scheduleEdges();
        break;
      }
      case 'marquee': {
        const r = this.wrap.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const box = { x: Math.min(x, d.ox), y: Math.min(y, d.oy), w: Math.abs(x - d.ox), h: Math.abs(y - d.oy) };
        Object.assign(this.marquee.style, { display: 'block', left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
        const c0 = { x: (box.x - this.view.x) / z, y: (box.y - this.view.y) / z };
        const c1 = { x: (box.x + box.w - this.view.x) / z, y: (box.y + box.h - this.view.y) / z };
        const ids = new Set(d.keep);
        for (const n of this.data.nodes) {
          if (n.x < c1.x && n.x + n.width > c0.x && n.y < c1.y && n.y + n.height > c0.y) ids.add(n.id);
        }
        this.setSelection([...ids]);
        break;
      }
      case 'shape-draw': {
        // The shape itself grows under the pointer (Shift: as wide as it is high).
        const r = this.wrap.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        let w = Math.max(1, Math.abs(x - d.ox));
        let h = Math.max(1, Math.abs(y - d.oy));
        if (e.shiftKey) w = h = Math.max(w, h);
        d.rect = { x: x < d.ox ? d.ox - w : d.ox, y: y < d.oy ? d.oy - h : d.oy, w, h };
        if (!d.ghost) d.ghost = div('cv-ghost', this.wrap);
        Object.assign(d.ghost.style, { left: `${d.rect.x}px`, top: `${d.rect.y}px`, width: `${w}px`, height: `${h}px` });
        d.ghost.replaceChildren(shapeSvg(d.shape, w, h));
        break;
      }
      case 'connect': {
        const a = this.byId(d.from);
        const p = this.toCanvas(e);
        const p1 = anchor(a, d.side);
        d.temp.setAttribute('d', curve(p1, d.side, [p.x, p.y], null).d);
        if (!d.temp.parentNode) this.svg.appendChild(d.temp);
        this.markTarget(d, e, d.from);
        break;
      }
      case 'draw': {
        const p = this.toCanvas(e);
        const a = d.from.node ? this.byId(d.from.node) : null;
        const p1 = a ? anchor(a, d.from.side) : [d.from.x, d.from.y];
        d.temp.setAttribute('d', a ? curve(p1, d.from.side, [p.x, p.y], null).d : `M${p1[0]},${p1[1]} L${p.x},${p.y}`);
        if (!d.temp.parentNode) this.svg.appendChild(d.temp);
        this.markTarget(d, e, d.from.node);
        break;
      }
      case 'edge-end': {
        // The end follows the pointer; dropped on a card it connects to it, elsewhere it stays loose.
        const x = this.findEdge(d.id);
        if (!x) break;
        const p = this.toCanvas(e);
        delete x[`${d.end}Node`];
        delete x[`${d.end}Side`];
        x[`${d.end}X`] = Math.round(p.x);
        x[`${d.end}Y`] = Math.round(p.y);
        this.markTarget(d, e, null);
        this.renderEdges();
        break;
      }
      case 'edge-add':
      case 'edge-pt': {
        const x = this.findEdge(d.id);
        if (!x) break;
        const p = this.toCanvas(e);
        const pt = { x: Math.round(p.x), y: Math.round(p.y) };
        if (d.kind === 'edge-add') {
          // Dragging an "add a bend" point puts a new bend there.
          x.mnPoints = Array.isArray(x.mnPoints) ? x.mnPoints : [];
          x.mnPoints.splice(d.i, 0, pt);
          d.kind = 'edge-pt';
        } else if (x.mnPoints && x.mnPoints[d.i]) x.mnPoints[d.i] = pt;
        this.renderEdges();
        break;
      }
      case 'edge-move': {
        const x = this.findEdge(d.id);
        if (!x) break;
        const o = d.orig;
        const mx = dx / z;
        const my = dy / z;
        x.fromX = Math.round(o.fromX + mx);
        x.fromY = Math.round(o.fromY + my);
        x.toX = Math.round(o.toX + mx);
        x.toY = Math.round(o.toY + my);
        if (Array.isArray(o.mnPoints)) x.mnPoints = o.mnPoints.map((q) => ({ x: Math.round(q.x + mx), y: Math.round(q.y + my) }));
        this.renderEdges();
        break;
      }
      default:
    }
  }

  /** Highlights the card an arrow would connect to (not `except`). */
  markTarget(d, e, except) {
    const over = this.nodeAt(e);
    const ok = over && over.dataset.id !== except ? over : null;
    if (d.over && d.over !== ok) d.over.classList.remove('connect-target');
    if (ok) ok.classList.add('connect-target');
    d.over = ok;
  }

  nodeAt(e) {
    const hit = this.root.elementsFromPoint ? this.root.elementsFromPoint(e.clientX, e.clientY) : [];
    for (const el of hit) {
      const n = el.closest && el.closest('.canvas-node');
      if (n) return n;
    }
    return null;
  }

  /** Resizing from any side or corner; Shift keeps the shape. Moving edges snap like moving cards. */
  resizeTo(n, d, ddx, ddy, e) {
    const dir = d.dir;
    let x0 = d.x;
    let y0 = d.y;
    let x1 = d.x + d.w;
    let y1 = d.y + d.h;
    if (dir.includes('e')) x1 += ddx;
    if (dir.includes('w')) x0 += ddx;
    if (dir.includes('s')) y1 += ddy;
    if (dir.includes('n')) y0 += ddy;
    let gx = null;
    let gy = null;
    if (!e.altKey) {
      const z = this.view.z;
      const prefs = snapPrefs();
      const thr = 7 / z;
      const snapEdge = (v, targets) => {
        const s = prefs.objects ? this.snapTo([v], targets, thr) : null;
        if (s) return [v + s.diff, s.at];
        return [prefs.grid ? Math.round(v / GRID) * GRID : v, null];
      };
      if (dir.includes('e')) [x1, gx] = snapEdge(x1, d.targets.x);
      if (dir.includes('w')) [x0, gx] = snapEdge(x0, d.targets.x);
      if (dir.includes('s')) [y1, gy] = snapEdge(y1, d.targets.y);
      if (dir.includes('n')) [y0, gy] = snapEdge(y0, d.targets.y);
    }
    if (x1 - x0 < MIN_W) { if (dir.includes('w')) x0 = x1 - MIN_W; else x1 = x0 + MIN_W; }
    if (y1 - y0 < MIN_H) { if (dir.includes('n')) y0 = y1 - MIN_H; else y1 = y0 + MIN_H; }
    if (e.shiftKey && dir.length === 2 && d.w > 0 && d.h > 0) {
      // Keep the proportions, following the larger change.
      const ratio = d.w / d.h;
      const w = x1 - x0;
      const h = y1 - y0;
      if (Math.abs(w - d.w) / d.w > Math.abs(h - d.h) / d.h) {
        const nh = w / ratio;
        if (dir.includes('n')) y0 = y1 - nh; else y1 = y0 + nh;
      } else {
        const nw = h * ratio;
        if (dir.includes('w')) x0 = x1 - nw; else x1 = x0 + nw;
      }
      gx = null;
      gy = null;
    }
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    this.showGuides(gx, gy, gx == null ? null : this.span(d.targets.x, gx, y0, y1), gy == null ? null : this.span(d.targets.y, gy, x0, x1));
    n.x = x0;
    n.y = y0;
    n.width = x1 - x0;
    n.height = y1 - y0;
  }

  /**
   * Edges and centres of the cards that are not moving (to snap to). Each target keeps the card's extent across
   * it (a..b), so the guide line can run between the aligned cards.
   */
  snapTargets(moving) {
    const x = [];
    const y = [];
    if (this.data) {
      for (const n of this.data.nodes) {
        if (moving.has(n.id)) continue;
        const a = n.y;
        const b = n.y + n.height;
        for (const v of [n.x, n.x + n.width / 2, n.x + n.width]) x.push({ v, a, b });
        const c = n.x;
        const f = n.x + n.width;
        for (const v of [n.y, n.y + n.height / 2, n.y + n.height]) y.push({ v, a: c, b: f });
      }
    }
    return { x, y };
  }

  /** The closest target within thr of any candidate: {diff, at}. */
  snapTo(cands, targets, thr) {
    let best = null;
    for (const c of cands) {
      for (const t of targets) {
        const diff = t.v - c;
        if (Math.abs(diff) <= thr && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, at: t.v };
      }
    }
    return best;
  }

  /** From the moving card (a..b) to every card aligned at `at`: where the guide line runs. */
  span(targets, at, a, b) {
    let lo = a;
    let hi = b;
    for (const t of targets) {
      if (Math.abs(t.v - at) < 0.5) {
        lo = Math.min(lo, t.a);
        hi = Math.max(hi, t.b);
      }
    }
    return [lo, hi];
  }

  /** Miro-like alignment lines: thin, dashed, exactly on the aligned edges, between the aligned cards. */
  showGuides(gx, gy, vSpan = null, hSpan = null) {
    const ext = 10 / this.view.z;
    if (gx == null || !vSpan) this.guideV.style.display = 'none';
    else Object.assign(this.guideV.style, { display: 'block', left: `${gx}px`, top: `${vSpan[0] - ext}px`, height: `${vSpan[1] - vSpan[0] + 2 * ext}px` });
    if (gy == null || !hSpan) this.guideH.style.display = 'none';
    else Object.assign(this.guideH.style, { display: 'block', top: `${gy}px`, left: `${hSpan[0] - ext}px`, width: `${hSpan[1] - hSpan[0] + 2 * ext}px` });
  }

  onUp(e) {
    if (e.pointerType === 'touch' && this.touches) {
      this.touches.delete(e.pointerId);
      if (this.pinch) {
        if (this.touches.size < 2) this.pinch = null;
        return;
      }
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    if (d.kind === 'pan' && d.tapClears && !d.moved) {
      this.drag = null;
      this.wrap.classList.remove('panning', 'dragging');
      if (this.selEdge) this.selectEdge(null);
      this.setSelection([]);
      return;
    }
    this.drag = null;
    try { this.wrap.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.wrap.classList.remove('panning', 'dragging');
    this.showGuides(null, null);
    this.updateSelBar();
    if (d.right && d.moved) {
      // A right-button drag moved the view: no menu when the button comes up.
      this.suppressMenu = true;
      setTimeout(() => { this.suppressMenu = false; }, 400);
    }
    switch (d.kind) {
      case 'pan':
        if (!d.moved && d.clear) this.setSelection([]);
        else if (d.moved) {
          // Let go while moving: the board keeps sliding and slows down (Settings › Canvas).
          const now = performance.now();
          const recent = (d.samples || []).filter((s) => now - s[0] < 90);
          if (this.momentumOn() && recent.length >= 2) {
            const a = recent[0];
            const b = recent[recent.length - 1];
            const dt = Math.max(8, b[0] - a[0]);
            const vx = (b[1] - a[1]) / dt;
            const vy = (b[2] - a[2]) / dt;
            if (Math.hypot(vx, vy) > 0.25) { this.glide(vx, vy); break; }
          }
          this.saveView();
        }
        break;
      case 'move':
      case 'resize':
      case 'gresize':
        if (d.moved) {
          // The image of a card that got bigger is loaded at a better size (renderNode knows when).
          if (d.kind === 'resize') { const n = this.byId(d.id); if (n) this.renderNode(n); }
          if (d.kind === 'gresize') for (const [n] of d.items) this.renderNode(n);
          this.renderEdges();
          this.commit();
        }
        this.updateGroupBox();
        this.updateSelBar();
        break;
      case 'marquee':
        this.marquee.style.display = 'none';
        if (!d.moved && d.clear) this.setSelection([]);
        break;
      case 'connect': {
        if (d.over) d.over.classList.remove('connect-target');
        if (d.temp.parentNode) d.temp.remove();
        if (!d.moved) break;
        const p = this.toCanvas(e);
        const edge = { id: newId(), fromNode: d.from, fromSide: d.side, ...lastLineWidth() };
        if (d.over) {
          const b = this.byId(d.over.dataset.id);
          edge.toNode = b.id;
          edge.toSide = nearestSide(b, p);
        } else {
          // Dropped on the empty board: the arrow ends there, loose (like Miro), and offers a card to add there.
          edge.toX = Math.round(p.x);
          edge.toY = Math.round(p.y);
        }
        this.fileEdge(edge);
        this.renderEdges();
        this.selectEdge(edge.id);
        this.commit();
        if (!d.over) this.openQuickCreate(edge, this.byId(d.from));
        break;
      }
      case 'shape-draw': {
        if (d.ghost) d.ghost.remove();
        this.setTool(null);
        const def = SHAPE.get(d.shape) || SHAPES[0];
        const r = d.rect;
        const v = this.view;
        if (d.moved && r && r.w > 12 && r.h > 12) this.createShape(def.id, (r.x - v.x) / v.z, (r.y - v.y) / v.z, r.w / v.z, r.h / v.z);
        else this.createShape(def.id, d.p0.x - def.w / 2, d.p0.y - def.h / 2, def.w, def.h);
        break;
      }
      case 'draw': {
        if (d.over) d.over.classList.remove('connect-target');
        if (d.temp.parentNode) d.temp.remove();
        this.setTool(null);
        if (!d.moved) break;
        const p = this.toCanvas(e);
        const edge = { id: newId(), ...lastLineWidth(), ...(d.style || {}) };
        if (d.from.node) { edge.fromNode = d.from.node; edge.fromSide = d.from.side; }
        else { edge.fromX = Math.round(d.from.x); edge.fromY = Math.round(d.from.y); }
        if (d.over) {
          const b = this.byId(d.over.dataset.id);
          edge.toNode = b.id;
          edge.toSide = nearestSide(b, p);
        } else { edge.toX = Math.round(p.x); edge.toY = Math.round(p.y); }
        this.fileEdge(edge);
        this.renderEdges();
        this.selectEdge(edge.id);
        this.commit();
        if (!d.over && d.from.node) this.openQuickCreate(edge, this.byId(d.from.node));
        break;
      }
      case 'edge-end': {
        if (d.over) d.over.classList.remove('connect-target');
        const x = this.findEdge(d.id);
        if (!x || !d.moved) break;
        if (d.over) {
          const b = this.byId(d.over.dataset.id);
          const p = this.toCanvas(e);
          x[`${d.end}Node`] = b.id;
          x[`${d.end}Side`] = nearestSide(b, p);
          delete x[`${d.end}X`];
          delete x[`${d.end}Y`];
        }
        this.fileEdge(x);
        this.renderEdges();
        this.commit();
        break;
      }
      case 'edge-pt':
      case 'edge-add':
      case 'edge-move':
        if (d.moved) {
          this.renderEdges();
          this.commit();
        }
        break;
      default:
    }
    this.updateEdgeBar();
  }

  onWheel(e) {
    if (!this.view || e.target.closest('.cv-editor, .cv-toolbar')) return;
    const selNode = e.target.closest('.canvas-node.selected');
    const scroller = selNode && (e.target.closest('.cv-file-body') || selNode.querySelector(':scope > .canvas-node-container > .canvas-node-content'));
    if (scroller && !e.ctrlKey && scroller.scrollHeight > scroller.clientHeight + 1) {
      const atTop = scroller.scrollTop <= 0 && e.deltaY < 0;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atEnd) { e.stopPropagation(); return; }
    }
    e.preventDefault();
    e.stopPropagation();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.wrap.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      const r = this.wrap.getBoundingClientRect();
      // A touchpad pinch sends many small steps: those follow the fingers directly.
      const base = this.zoomAnim ? this.zoomAnim.z : this.view.z;
      const z = base * Math.exp(-e.deltaY * unit * 0.0018);
      if (Math.abs(e.deltaY * unit) < 40 && !this.zoomAnim) this.zoomAt(e.clientX - r.left, e.clientY - r.top, z);
      else this.smoothZoom(e.clientX - r.left, e.clientY - r.top, z);
      return;
    }
    this.stopGlide();
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
    const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
    this.view.x -= dx;
    this.view.y -= dy;
    this.applyView();
    this.saveViewSoon();
  }

  onDbl(e) {
    if (!this.data || e.target.closest('.cv-toolbar, .cv-editor, video, audio, .mn-play, [data-href], .cv-selbar')) return;
    // Double-clicking a bend point of the selected arrow removes it.
    const bendPt = e.target.closest('.cv-eh.pt');
    if (bendPt) {
      const x = this.findEdge(this.selEdge);
      if (x && x.mnPoints && !this.readOnly) {
        x.mnPoints.splice(+bendPt.dataset.i, 1);
        if (!x.mnPoints.length) delete x.mnPoints;
        this.renderEdges();
        this.commit();
      }
      return;
    }
    if (e.target.closest('.cv-eh')) return;
    const nodeEl = e.target.closest('.canvas-node');
    const label = e.target.closest('.cv-edge-label, .hit');
    if (label) { if (!this.readOnly) this.editEdgeLabel(label.dataset.id); return; }
    if (nodeEl) {
      const n = this.byId(nodeEl.dataset.id);
      if (!n) return;
      if (e.target.closest('.canvas-group-label') || n.type === 'group') { if (!this.readOnly) this.editGroupLabel(n); return; }
      // Videos play where they are; other links and files open.
      const play = nodeEl.querySelector('.mn-play');
      if (play && (n.type === 'link' || kindOfFile(String(n.file || '')) === 'video')) { play.click(); return; }
      if (n.type === 'text') { if (!this.readOnly) this.startEditing(n.id, { x: e.clientX, y: e.clientY }); }
      else if (kindOfFile(String(n.file || '')) === 'spine') this.setSpineLive(n.id);
      else if (n.type === 'file') this.openFileNode(n);
      else if (n.type === 'link') openLink(n.url, this.key);
      return;
    }
    if (this.readOnly) return;
    const p = this.toCanvas(e);
    this.addCard({ x: p.x - 130, y: p.y - 30 });
  }

  onClick(e) {
    const w = e.target.closest('[data-wiki]');
    if (w) {
      e.preventDefault();
      const target = w.getAttribute('data-wiki');
      const r = resolveName(this.key, target);
      openWiki(target, r.path || null, this.key);
      return;
    }
    const a = e.target.closest('a[href], [data-href]');
    if (a) {
      e.preventDefault();
      openLink(a.getAttribute('data-href') || a.getAttribute('href'), this.key);
    }
  }

  openFileNode(n) {
    const path = this.resolveFile(n.file);
    if (!path) return;
    if (/\.(md|markdown|txt|canvas)$/i.test(path)) openNote(path);
    else api.call('asset.open', { notePath: this.key, link: n.file, wiki: true }).catch((err) => toast(err.message, 'error'));
  }

  async editLink(n) {
    const v = await prompt({ title: 'Edit link', label: 'Address', value: n.url || '', ok: 'Save' });
    if (!v || v === n.url) return;
    n.url = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v;
    n._fit = true;
    this.renderNode(n);
    this.commit();
  }

  async editGroupLabel(n) {
    const v = await prompt({ title: 'Group name', label: 'Name', value: n.label || '', ok: 'Save' });
    if (v === null || v === n.label) return;
    n.label = v;
    this.nodeEls.get(n.id)._sig = null;
    this.renderNode(n);
    this.commit();
  }

  async editEdgeLabel(id) {
    const e = this.findEdge(id);
    if (!e) return;
    const v = await prompt({ title: 'Arrow label', label: 'Label', value: e.label || '', ok: 'Save' });
    if (v === null || v === e.label) return;
    e.label = v.trim();
    this.renderEdges();
    this.commit();
  }

  // ── menus ──
  onContext(e) {
    e.preventDefault();
    e.stopPropagation();
    if (this.suppressMenu) { this.suppressMenu = false; return; }
    if (!this.data || e.target.closest('.cv-editor, .cv-toolbar')) return;
    const nodeEl = e.target.closest('.canvas-node');
    const edgeEl = e.target.closest('.hit, .cv-edge-label');
    const p = this.toCanvas(e);
    if (edgeEl) {
      const edge = this.findEdge(edgeEl.dataset.id);
      if (!edge) return;
      this.selectEdge(edge.id);
      const ro = this.readOnly;
      const cur = edge.mnPath || 'curve';
      const change = (fn) => () => { fn(edge); tidyEnds(edge); this.renderEdges(); this.commit(); };
      openMenu(e.clientX, e.clientY, [
        !ro && { label: edge.label ? 'Edit text…' : 'Add text…', icon: 'type-plus', run: () => this.editEdgeLabel(edge.id) },
        !ro && edge.label && { label: 'Remove text', run: change((x) => { delete x.label; }) },
        !ro && { label: 'Arrow at the end', checked: (edge.toEnd || 'arrow') === 'arrow', run: change((x) => { x.toEnd = (x.toEnd || 'arrow') === 'arrow' ? 'none' : 'arrow'; }) },
        !ro && { label: 'Arrow at the start', checked: edge.fromEnd === 'arrow', run: change((x) => { x.fromEnd = x.fromEnd === 'arrow' ? 'none' : 'arrow'; }) },
        !ro && { label: 'Reverse direction', icon: 'swap', run: change((x) => this.reverseEdge(x)) },
        !ro && {
          label: 'Line type', icon: cur === 'curve' ? 'curve' : cur === 'straight' ? 'line' : 'elbow', submenu: [
            { label: 'Curved', icon: 'curve', checked: cur === 'curve' ? true : undefined, run: () => this.setEdgeType(edge, 'curve') },
            { label: 'Straight', icon: 'line', checked: cur === 'straight' ? true : undefined, run: () => this.setEdgeType(edge, 'straight') },
            { label: 'Elbow', icon: 'elbow', checked: cur === 'elbow' ? true : undefined, run: () => this.setEdgeType(edge, 'elbow') },
          ],
        },
        !ro && edge.mnPoints && edge.mnPoints.length && { label: 'Remove bends', run: change((x) => { delete x.mnPoints; }) },
        !ro && { swatches: true, colors: PRESETS, value: colorOf(edge.color), onPick: (c) => change((x) => { if (c) x.color = presetOf(c); else delete x.color; })() },
        !ro && { sep: true },
        !ro && { label: 'Duplicate', icon: 'copy', run: () => this.duplicateEdge(edge) },
        !ro && { label: 'Cut', icon: 'move', hint: 'Ctrl+X', run: () => this.copySelection(true) },
        { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', run: () => this.copySelection(false) },
        !ro && { sep: true },
        !ro && { label: 'Delete arrow', icon: 'trash', hint: 'Del', danger: true, run: () => this.deleteSelection() },
      ], { minWidth: 220 });
      return;
    }
    if (nodeEl) {
      const n = this.byId(nodeEl.dataset.id);
      if (!n) return;
      if (!this.sel.has(n.id)) this.setSelection([n.id]);
      openMenu(e.clientX, e.clientY, this.sel.size > 1 ? this.selectionMenu(p) : this.nodeMenu(n, p), { minWidth: 230 });
      return;
    }
    // The board, like Obsidian's canvas menu.
    const ro = this.readOnly;
    const snap = snapPrefs();
    openMenu(e.clientX, e.clientY, [
      !ro && { label: 'Add card', icon: 'type', run: () => this.addCard(p) },
      !ro && { label: 'Add note from workspace', icon: 'file-text', run: () => this.addNoteFromVault(p) },
      !ro && { label: 'Add media from workspace', icon: 'image', run: () => this.addMediaFromVault(p) },
      !ro && { label: 'Add media from this computer…', icon: 'upload', run: () => this.pickFiles(p) },
      !ro && { label: 'Add web page', icon: 'globe', run: () => this.addWebPage(p) },
      !ro && { label: 'Create group', icon: 'folder', run: () => this.addGroup(p) },
      !ro && { label: 'Draw an arrow', icon: 'arrow-right', run: () => this.setTool('arrow') },
      !ro && { sep: true },
      !ro && { label: 'Undo', icon: 'undo', hint: 'Ctrl+Z', run: () => ed.editorUndo() },
      !ro && { label: 'Redo', icon: 'redo', hint: redoKeyLabel(), run: () => ed.editorRedo() },
      !ro && { label: 'Paste', icon: 'clipboard', hint: 'Ctrl+V', run: () => this.pasteFromHost(p) },
      !ro && { sep: true },
      { label: 'Snap to grid', checked: snap.grid, run: () => { snap.grid = !snap.grid; saveState(); } },
      { label: 'Snap to objects', checked: snap.objects, run: () => { snap.objects = !snap.objects; saveState(); } },
      { label: 'Read-only', checked: ro, run: () => this.setReadOnly(!ro) },
      { sep: true },
      { label: 'Reload link previews', icon: 'refresh', run: () => this.reloadPreviews() },
      { label: 'Zoom to fit', icon: 'fit', hint: 'Shift+1', run: () => this.fit(true) },
      { label: 'Zoom to 100%', run: () => this.zoomTo(1) },
      { label: 'Select all', hint: 'Ctrl+A', run: () => this.setSelection(this.data.nodes.map((n) => n.id)) },
    ]);
  }

  // ── menus of cards (Obsidian's, per kind of card) ──
  /** Shared ending: colour, order, group, clipboard, remove. */
  menuTail(targets, p) {
    const ro = this.readOnly;
    return [
      !ro && { swatches: true, colors: PRESETS, value: colorOf(targets[0].color), onPick: (c) => this.setColor(targets, c) },
      !ro && { sep: true },
      !ro && { label: 'Bring to front', icon: 'bring-front', run: () => this.reorder(targets, true) },
      !ro && { label: 'Send to back', icon: 'send-back', run: () => this.reorder(targets, false) },
      !ro && { label: 'Create group', icon: 'folder', run: () => this.groupAround(targets) },
      !ro && { label: 'Duplicate', icon: 'copy', hint: 'Ctrl+D', run: () => this.duplicate(targets) },
      { sep: true },
      !ro && { label: 'Cut', icon: 'move', hint: 'Ctrl+X', run: () => this.copySelection(true) },
      { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', run: () => this.copySelection(false) },
      !ro && { label: 'Paste', icon: 'clipboard', hint: 'Ctrl+V', run: () => this.pasteFromHost(p) },
      !ro && { sep: true },
      !ro && { label: targets.length > 1 ? `Remove ${targets.length} cards` : 'Remove', icon: 'trash', hint: 'Del', danger: true, run: () => this.deleteSelection() },
    ];
  }

  /** Several cards selected: what applies to all of them (Obsidian: delete, zoom, group, clipboard). */
  selectionMenu(p) {
    const targets = [...this.sel].map((id) => this.byId(id)).filter(Boolean);
    const links = targets.filter((t) => t.type === 'link' && t.url);
    return [
      { label: 'Zoom to selection', icon: 'scan-search', hint: 'Shift+2', run: () => this.zoomToSelection() },
      links.length > 0 && { label: `Reload ${links.length} preview${links.length === 1 ? '' : 's'}`, icon: 'refresh', run: () => { for (const l of links) this.reloadPreview(l); } },
      ...this.menuTail(targets, p),
    ];
  }

  /** One card: its own commands first (like Obsidian's menus for text, files, links and groups). */
  nodeMenu(n, p) {
    const ro = this.readOnly;
    const file = n.type === 'file' ? String(n.file || '') : '';
    const path = n.type === 'file' ? this.resolveFile(file) : null;
    const note = path && /\.(md|markdown|txt|canvas)$/i.test(path) ? findNote(path) : null;
    const isNote = n.type === 'file' && /\.(md|markdown|txt|canvas)$/i.test(file);
    const own = [];
    own.push({ label: 'Zoom to selection', icon: 'scan-search', hint: 'Shift+2', run: () => this.zoomToSelection() });
    if (n.type === 'text') {
      if (!ro) own.push({ label: 'Edit', icon: 'pencil', hint: 'Enter', run: () => this.startEditing(n.id) });
      if (!ro) own.push({ label: 'Convert to file…', icon: 'file-plus', run: () => this.convertToFile(n) });
      if (!ro) own.push({ label: isShape(n) ? 'Change shape…' : 'Shape…', icon: 'shapes', run: () => this.openChangeShape(n, { x: p.x * this.view.z + this.view.x, y: p.y * this.view.z + this.view.y }) });
    } else if (n.type === 'file') {
      if (isNote) own.push({ label: 'Open note', icon: 'file-text', run: () => this.openFileNode(n) });
      if (!ro) own.push({ label: 'Swap file…', icon: 'refresh', run: () => this.swapFile(n) });
      own.push({ sep: true });
      if (note && !ro) own.push({ label: 'Rename…', icon: 'pencil', run: () => renameNote(note) });
      if (note && !ro) own.push({ label: 'Move file to…', icon: 'move', run: () => moveNote(note) });
      if (!isNote && path) own.push({ label: 'Open in default app', icon: 'external', run: () => this.openFileNode(n) });
      if (path) own.push({ label: 'Show in system explorer', icon: 'folder-open', run: () => api.call('app.reveal', { path }) });
      if (path) own.push({ label: 'Reveal file in navigation', icon: 'sidebar', run: () => this.revealInNavigation(path) });
    } else if (n.type === 'link') {
      own.push({ label: 'Open in browser', icon: 'external', run: () => openLink(n.url, this.key) });
      own.push({ label: 'Copy link', icon: 'link', run: () => navigator.clipboard.writeText(n.url).then(() => toast('Link copied', 'success', 1200)) });
      if (!ro) own.push({ label: 'Edit link…', icon: 'pencil', run: () => this.editLink(n) });
      own.push({ label: 'Reload preview', icon: 'refresh', run: () => this.reloadPreview(n) });
    } else if (n.type === 'group') {
      if (!ro) own.push({ label: 'Rename group…', icon: 'pencil', run: () => this.editGroupLabel(n) });
      own.push({ label: 'Select what is inside', icon: 'scan-search', run: () => this.setSelection([n.id, ...this.inside(n).map((x) => x.id)]) });
    }
    return [...own, ...this.menuTail([n], p)];
  }

  /** Cards fully inside a group. */
  inside(g) {
    return this.data.nodes.filter((n) => n.id !== g.id && n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height);
  }

  align(targets, how) {
    if (this.locked() || targets.length < 2) return;
    const x0 = Math.min(...targets.map((n) => n.x));
    const x1 = Math.max(...targets.map((n) => n.x + n.width));
    const y0 = Math.min(...targets.map((n) => n.y));
    const y1 = Math.max(...targets.map((n) => n.y + n.height));
    for (const n of targets) {
      if (how === 'left') n.x = x0;
      else if (how === 'right') n.x = x1 - n.width;
      else if (how === 'hcenter') n.x = Math.round((x0 + x1) / 2 - n.width / 2);
      else if (how === 'top') n.y = y0;
      else if (how === 'bottom') n.y = y1 - n.height;
      else if (how === 'vcenter') n.y = Math.round((y0 + y1) / 2 - n.height / 2);
      const el = this.nodeEls.get(n.id);
      if (el) this.place(el, n);
    }
    this.renderEdges();
    this.updateGroupBox();
    this.updateSelBar();
    this.commit();
  }

  /** Obsidian's "Convert to file": the card's text becomes a note next to the canvas, shown as a note card. */
  async convertToFile(n) {
    if (this.locked()) return;
    const first = (n.text || '').split('\n').map((l) => l.replace(/<[^>]+>/g, '').replace(/^[#>\-*\s\d.[\]]+/, '').trim()).find(Boolean) || 'Untitled';
    const name = await prompt({ title: 'Convert to file', label: 'Note name', value: first.slice(0, 60), ok: 'Create' });
    if (!name) return;
    if (!this.ws) { toast('Open the canvas from a workspace to turn cards into notes', 'info'); return; }
    try {
      const here = findNote(this.key);
      const res = await api.call('note.create', { wsId: this.ws.id, folder: here ? here.folder || '' : '', title: name, text: n.text || '', autoTitle: false });
      upsertNote(res);
      const stored = (await this.storePaths([res.path]))[0];
      this.fileMap.set(stored, res.path);
      n.type = 'file';
      n.file = stored;
      delete n.text;
      delete n.mnShape;
      this.nodeEls.get(n.id)._sig = null;
      this.renderNode(n);
      this.commit();
      if (this.ws) invalidateFiles(this.ws.id);
    } catch (err) {
      toast('Could not create the note: ' + err.message, 'error');
    }
  }

  /** Obsidian's "Swap file": the card shows another file of the workspace (same kind first). */
  async swapFile(n) {
    if (this.locked() || !this.ws) return;
    const kind = kindOfFile(String(n.file || ''));
    let items;
    if (kind === 'note' || /\.canvas$/i.test(String(n.file || ''))) {
      if (!notesByWs.peek()[this.ws.id]) { try { await loadNotes(this.ws.id, false); } catch { /* ignore */ } }
      items = (notesByWs.peek()[this.ws.id] || []).filter((x) => x.path !== this.key)
        .map((x) => ({ key: x.path, label: x.title, sub: x.folder || '', icon: /\.canvas$/i.test(x.path) ? 'canvas' : 'file-text', path: x.path }));
    } else {
      const files = (await loadFiles(this.ws.id, true)) || [];
      items = files.filter((f) => MEDIA_RX.test(f)).map((f) => ({ key: f, label: f.split('/').pop(), sub: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '', icon: kindOfFile(f) === 'image' ? 'image' : kindOfFile(f) === 'video' ? 'film' : 'file', path: `${this.ws.dir}/${f}` }));
    }
    const pick = await pickFrom({ title: 'Swap file', placeholder: 'Find a file…', items });
    if (!pick) return;
    const stored = (await this.storePaths([pick.path]))[0];
    this.fileMap.set(stored, pick.path);
    n.file = stored;
    this.nodeEls.get(n.id)._sig = null;
    this.renderNode(n);
    this.commit();
  }

  /** Shows where a file is in the sidebar (its folder opens and the note is highlighted). */
  revealInNavigation(path) {
    if (findNote(path)) { revealInSidebar(path); return; }
    const ws = wsForPath(path);
    if (!ws) return;
    const rel = path.slice(ws.dir.length + 1);
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    mainView.value = { kind: 'folder', folder };
  }

  reorder(targets, front) {
    const ids = new Set(targets.map((t) => t.id));
    const rest = this.data.nodes.filter((n) => !ids.has(n.id));
    this.data.nodes = front ? [...rest, ...targets] : [...targets, ...rest];
    this.renderAll();
    this.commit();
  }

  groupAround(targets) {
    const pad = 40;
    const x0 = Math.min(...targets.map((n) => n.x)) - pad;
    const y0 = Math.min(...targets.map((n) => n.y)) - pad;
    const x1 = Math.max(...targets.map((n) => n.x + n.width)) + pad;
    const y1 = Math.max(...targets.map((n) => n.y + n.height)) + pad;
    const g = this.addNode({ type: 'group', label: 'Group', x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    this.renderAll();
    this.setSelection([g.id]);
  }

  duplicate(targets) {
    const map = new Map();
    const copies = targets.map((t) => {
      const c = { ...JSON.parse(JSON.stringify(t)), id: newId(), x: t.x + 40, y: t.y + 40 };
      map.set(t.id, c.id);
      return c;
    });
    for (const e of this.data.edges.slice()) {
      if (map.has(e.fromNode) && map.has(e.toNode)) this.data.edges.push({ ...e, id: newId(), fromNode: map.get(e.fromNode), toNode: map.get(e.toNode) });
    }
    this.data.nodes.push(...copies);
    this.renderAll();
    this.setSelection(copies.map((c) => c.id));
    this.commit();
  }

  // ── keyboard & clipboard ──
  onKey(e) {
    // Keys typed in a card editor, or for a focused video/audio player (space, arrows), are theirs.
    if (e.target.closest && e.target.closest('.cv-editor, video, audio, iframe, input, textarea')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === ' ' && !ctrl) { stop(); this.spaceDown = true; this.wrap.classList.add('space'); return; }
    if (!this.data) return;
    if (this.pop && k === 'Escape') { stop(); this.closePop(); return; }
    if (this.pop && k === 'Enter' && this.pop._enter) { stop(); this.pop._enter(); return; }
    if (k === 'Escape') {
      if (this.spineLiveId) { stop(); this.setSpineLive(null); return; }
      if (this.tool) { stop(); this.setTool(null); return; }
      if (this.sel.size || this.selEdge) { stop(); this.setSelection([]); this.selectEdge(null); }
      return;
    }
    if (ctrl && k === 'a') { stop(); this.setSelection(this.data.nodes.map((n) => n.id)); return; }
    if (ctrl && (k === '=' || k === '+')) { stop(); this.zoomBy(1.25); return; }
    if (ctrl && (k === '-' || k === '_')) { stop(); this.zoomBy(1 / 1.25); return; }
    if (ctrl && k === '0') { stop(); this.zoomTo(1); return; }
    if (e.shiftKey && (k === '!' || e.code === 'Digit1')) { stop(); this.fit(true); return; }
    if (e.shiftKey && !ctrl && (k === '@' || k === '"' || e.code === 'Digit2')) { stop(); this.zoomToSelection(); return; }
    // The clipboard: copied cards, text, pictures and files (from Explorer) work like in Obsidian.
    if (ctrl && !e.shiftKey && !e.altKey && (k === 'c' || k === 'Insert')) { stop(); this.copySelection(false); return; }
    if (ctrl && !e.altKey && k === 'x') { stop(); if (!this.locked()) this.copySelection(true); return; }
    if (ctrl && !e.altKey && k === 'v') { stop(); if (!this.locked()) this.pasteFromHost(this.pastePoint(), e.shiftKey); return; }
    if (this.readOnly) {
      if ((k === 'Delete' || k === 'Backspace' || (ctrl && (k === 'z' || k === 'y' || k === 'd'))) && !e.repeat) { stop(); this.locked(); }
      return;
    }
    // Miro's keys: R rectangle, O oval, L line (then click or drag on the board).
    if (!ctrl && !e.altKey && !e.shiftKey && (k === 'r' || k === 'o' || k === 'l')) {
      stop();
      if (k === 'l') this.setTool(this.tool === 'arrow' ? null : 'arrow', { toEnd: 'none' });
      else this.setTool('shape', k === 'r' ? 'rect' : 'oval');
      return;
    }
    if ((k === 'Delete' || k === 'Backspace') && !ctrl) { stop(); this.deleteSelection(); return; }
    if (k === 'Enter' && this.sel.size === 1) {
      const n = this.byId([...this.sel][0]);
      if (n && n.type === 'text') { stop(); this.startEditing(n.id); }
      return;
    }
    if (ctrl && (k === 'z' || k === 'y')) { stop(); if (k === 'y' || e.shiftKey) ed.editorRedo(); else ed.editorUndo(); return; }
    if (ctrl && k === 'd' && this.sel.size) { stop(); this.duplicate([...this.sel].map((id) => this.byId(id)).filter(Boolean)); return; }
    if (!ctrl && k.startsWith('Arrow') && this.sel.size) {
      stop();
      const step = e.shiftKey ? 20 : 2;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
      for (const id of this.sel) {
        const n = this.byId(id);
        if (!n) continue;
        n.x += dx;
        n.y += dy;
        this.place(this.nodeEls.get(id), n);
      }
      this.renderEdges();
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = setTimeout(() => this.commit(), 400);
    }
  }

  onCopy(e) {
    if (this.editingId || !this.data || !this.sel.size) return false;
    const nodes = this.data.nodes.filter((n) => this.sel.has(n.id));
    const edges = this.data.edges.filter((x) => this.sel.has(x.fromNode) && this.sel.has(x.toNode));
    const json = JSON.stringify({ nodes, edges });
    const text = nodes.map((n) => n.text || n.file || n.url || n.label || '').filter(Boolean).join('\n\n');
    e.preventDefault();
    e.clipboardData.setData('application/x-mn-canvas', json);
    e.clipboardData.setData('text/plain', text);
    lastCopy = { json, text };
    return true;
  }

  /** Where pasted things go: under the mouse when it is over the board, else the middle of the view. */
  pastePoint() {
    if (this.pointer) {
      const r = this.wrap.getBoundingClientRect();
      if (this.pointer.x >= r.left && this.pointer.x <= r.right && this.pointer.y >= r.top && this.pointer.y <= r.bottom) return this.toCanvas({ clientX: this.pointer.x, clientY: this.pointer.y });
    }
    return this.centerPoint();
  }

  onPaste(e) {
    if (this.editingId || !this.data) return;
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    if (this.locked()) return;
    const files = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    this.pasteData({ json: dt.getData('application/x-mn-canvas'), files, text: dt.getData('text/plain') }, this.pastePoint());
  }

  /** "Paste" in the board's menu: the clipboard as the system has it (pictures and text). */
  async pasteFromClipboard(at) {
    if (this.locked()) return;
    let text = '';
    const files = [];
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        for (const type of it.types) {
          if (type.startsWith('image/') && !files.length) {
            const blob = await it.getType(type);
            files.push(new File([blob], `image.${type.split('/')[1] || 'png'}`, { type }));
          } else if (type === 'text/plain' && !text) {
            text = await (await it.getType(type)).text();
          }
        }
      }
    } catch {
      try { text = await navigator.clipboard.readText(); } catch { /* nothing readable */ }
    }
    if (lastCopy && text && text === lastCopy.text) { this.pasteData({ json: lastCopy.json }, at); return; }
    if (!files.length && !text.trim()) { toast('The clipboard is empty', 'info', 1500); return; }
    this.pasteData({ files, text }, at);
  }

  /** Like Obsidian: copied cards come back as cards, links become web cards, pictures and files become media, text a card. */
  async pasteData({ json, files = [], text = '' }, at) {
    if (json) {
      try {
        const parsed = JSON.parse(json);
        const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
        const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
        const loose = Array.isArray(parsed.mnEdges) ? parsed.mnEdges : [];
        // Where the pasted things start: the top-left of the cards and of the loose arrow ends.
        const xs = nodes.map((n) => n.x);
        const ys = nodes.map((n) => n.y);
        for (const x of loose) for (const k of ['from', 'to']) if (!x[`${k}Node`] && isFinite(x[`${k}X`])) { xs.push(+x[`${k}X`]); ys.push(+x[`${k}Y`]); }
        if (!xs.length) throw new Error('nothing to paste');
        const dx = Math.round(at.x - Math.min(...xs));
        const dy = Math.round(at.y - Math.min(...ys));
        const map = new Map();
        const copies = nodes.map((n) => {
          const id = newId();
          map.set(n.id, id);
          return { ...n, id, x: Math.round(n.x + dx), y: Math.round(n.y + dy) };
        });
        const moveBends = (x) => { if (Array.isArray(x.mnPoints)) x.mnPoints = x.mnPoints.map((q) => ({ x: Math.round(q.x + dx), y: Math.round(q.y + dy) })); };
        const added = [];
        for (const x of edges) {
          if (!map.has(x.fromNode) || !map.has(x.toNode)) continue;
          const c = { ...x, id: newId(), fromNode: map.get(x.fromNode), toNode: map.get(x.toNode) };
          moveBends(c);
          this.data.edges.push(c);
          added.push(c);
        }
        for (const x of loose) {
          const c = { ...x, id: newId() };
          let ok = true;
          for (const k of ['from', 'to']) {
            if (c[`${k}Node`]) {
              if (map.has(c[`${k}Node`])) c[`${k}Node`] = map.get(c[`${k}Node`]);
              else ok = false;
            } else {
              c[`${k}X`] = Math.round((+c[`${k}X`] || 0) + dx);
              c[`${k}Y`] = Math.round((+c[`${k}Y`] || 0) + dy);
            }
          }
          if (!ok) continue;
          moveBends(c);
          this.fileEdge(c);
          added.push(c);
        }
        if (!copies.length && !added.length) throw new Error('nothing to paste');
        this.data.nodes.push(...copies);
        this.renderAll();
        if (copies.length) this.setSelection(copies.map((n) => n.id));
        else this.selectEdge(added[0].id);
        this.commit();
        this.resolveFiles();
        return;
      } catch { /* not our cards: paste the text */ }
    }
    if (files.length) { await this.addFiles(files, at); return; }
    const t = text.trim();
    if (!t) return;
    const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const md = /^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/;
    const urls = lines.map((l) => (URL_RX.test(l) ? l : (md.exec(l) || [])[1])).filter(Boolean);
    if (urls.length && urls.length === lines.length && urls.length <= 12) { this.addLinks(urls, at); return; }
    // Cells copied from Excel / Google Sheets become a table, like when pasting them in a note.
    const rows = spreadsheetRows(text.replace(/\n$/, ''), '');
    if (rows) text = rowsToMarkdown(rows);
    // Like Obsidian: the text gets its own card, as tall as the text needs.
    const width = clamp(Math.round(this.textWidth(text)), 250, 520);
    const height = this.measureText(text, width);
    const n = this.addNode({ type: 'text', text, x: Math.round(at.x - width / 2), y: Math.round(at.y - Math.min(height, 400) / 2), width, height });
    this.setSelection([n.id]);
  }

  /** A comfortable card width for a text: wider for long lines, like Obsidian's pasted cards. */
  textWidth(text) {
    const longest = Math.max(...text.split('\n').map((l) => l.length));
    return longest * 8.2 + 40;
  }

  /** The height a text card needs to show `text` at `width` (rendered offscreen with the board's styles). */
  measureText(text, width) {
    const probe = div('canvas-node is-text cv-measure', this.nodesLayer);
    probe.style.width = `${width}px`;
    const box = div('canvas-node-container', probe);
    const content = div('canvas-node-content markdown-rendered', box);
    content.innerHTML = renderMarkdown(text, this.key);
    box.style.position = 'relative';
    content.style.position = 'relative';
    const h = content.scrollHeight;
    probe.remove();
    return clamp(Math.ceil(h + 8), 60, 900);
  }

  /** Ctrl+C / Ctrl+X: the selected cards go to the system clipboard (with their text, and their files for other apps). */
  async copySelection(cut) {
    if (this.editingId || !this.data) return false;
    let json;
    let text;
    let files = [];
    if (!this.sel.size && this.selEdge) {
      // An arrow alone: copied loose, where it is drawn (pasting it gives an arrow joined to nothing, like Miro).
      const e0 = this.findEdge(this.selEdge);
      const c = e0 && this.looseCopy(e0);
      if (!c) return false;
      json = JSON.stringify({ nodes: [], edges: [], mnEdges: [c] });
      text = e0.label || '';
    } else {
      if (!this.sel.size) return false;
      const nodes = this.data.nodes.filter((n) => this.sel.has(n.id));
      const edges = this.data.edges.filter((x) => this.sel.has(x.fromNode) && this.sel.has(x.toNode));
      // Arrows from the copied cards that end loose come along too.
      const loose = (this.data.mnEdges || []).filter((x) => (x.fromNode || x.toNode) && (!x.fromNode || this.sel.has(x.fromNode)) && (!x.toNode || this.sel.has(x.toNode)));
      json = JSON.stringify({ nodes, edges, mnEdges: loose });
      text = nodes.map((n) => n.text || n.url || n.label || (n.file ? String(n.file).split('/').pop() : '') || '').filter(Boolean).join('\n\n');
      files = nodes.filter((n) => n.type === 'file').map((n) => this.resolveFile(n.file)).filter(Boolean);
    }
    lastCopy = { json, text };
    try {
      await api.call('clipboard.writeCanvas', { json, text, files });
    } catch {
      try { await navigator.clipboard.writeText(text); } catch { /* nothing more to try */ }
    }
    if (cut && !this.readOnly) this.deleteSelection();
    return true;
  }

  /** Ctrl+V: whatever the system clipboard holds (copied cards, files from Explorer, a picture, text or links). */
  async pasteFromHost(at, plain = false) {
    if (this.locked() || !this.data) return;
    let clip = null;
    try { clip = await api.call('clipboard.read'); } catch { clip = null; }
    if (!clip) { this.pasteFromClipboard(at); return; }
    if (clip.canvas && !plain) { this.pasteData({ json: clip.canvas }, at); return; }
    if (clip.files && clip.files.length && !plain) {
      try {
        const res = await api.call('asset.import', { notePath: this.key, paths: clip.files });
        if (this.ws) invalidateFiles(this.ws.id);
        await this.addFileNodes(res.map((r) => r.path), at);
      } catch (err) { toast('Could not paste the files: ' + err.message, 'error'); }
      return;
    }
    if (clip.image && !plain && !(clip.text && clip.text.trim())) {
      try {
        const r = await api.call('clipboard.saveImage', { notePath: this.key });
        if (r && r.path) {
          if (this.ws) invalidateFiles(this.ws.id);
          await this.addFileNodes([r.path], at);
        }
      } catch (err) { toast('Could not paste the picture: ' + err.message, 'error'); }
      return;
    }
    if (clip.text && clip.text.trim()) { this.pasteData({ text: clip.text.replace(/\r\n?/g, '\n') }, at); return; }
    toast('The clipboard is empty', 'info', 1500);
  }

  onDragOver(e) {
    const t = e.dataTransfer && e.dataTransfer.types;
    if (!t || !this.data) return;
    if (t.includes('Files') || t.includes('application/x-mn-note') || t.includes('text/uri-list')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = this.readOnly ? 'none' : 'copy';
    }
  }

  async onDrop(e) {
    if (!this.data || !e.dataTransfer) return;
    const path = e.dataTransfer.getData('application/x-mn-note');
    const files = [...e.dataTransfer.files];
    const uri = !files.length && !path ? (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#')) : [];
    if (!path && !files.length && !uri.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (this.locked()) return;
    const p = this.toCanvas(e);
    if (path) {
      this.addFileNodes([path], p);
      return;
    }
    if (uri.length) { this.addLinks(uri.filter((u) => /^https?:\/\//i.test(u)), p); return; }
    await this.addFiles(files, p);
  }

  async addImages(files, at) {
    const added = [];
    let off = 0;
    for (const f of files) {
      try {
        const data = await readFileAsDataUrl(f);
        const r = await saveImage(this.key, data, f.name && !/^image\.\w+$/i.test(f.name) ? f.name : '');
        const dims = await imageSize(r.url);
        const w = Math.min(400, dims.w || 400);
        const h = dims.w ? Math.max(MIN_H, Math.round(w * dims.h / dims.w)) : 300;
        const stored = r.path ? (await this.storePaths([r.path]))[0] : r.link;
        if (r.path) this.fileMap.set(stored, r.path);
        added.push(this.addNode({ type: 'file', file: stored, x: Math.round(at.x - w / 2 + off), y: Math.round(at.y - h / 2 + off), width: w, height: h }, { commit: false }));
        off += 30;
      } catch (err) {
        toast('Could not add the image: ' + err.message, 'error');
      }
    }
    if (!added.length) return;
    if (this.ws) invalidateFiles(this.ws.id);
    this.setSelection(added.map((n) => n.id));
    this.renderEdges();
    this.commit();
  }
}
