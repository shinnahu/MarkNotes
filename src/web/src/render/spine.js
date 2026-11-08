// Spine 4.1 models (.skel + .atlas + textures, as Nikke exports them) playing in notes and canvases, offline.
// Like the nikke.gg viewer: a costume, a pose (Standing / Aim / Cover / Cut-in) and an animation to pick; drag to
// move the model, scroll to zoom, fit, fullscreen; a snapshot (PNG) and a recording (WebM). A model plays as soon
// as it is on screen, and what was picked (costume, pose, animation, zoom) is kept for each embed or card in the
// app state. The Spine player is only brought into the page when a model is shown.

import * as api from '../api.js';
import { fileUrl } from '../links.js';
import { dirname } from '../util.js';
import { persisted, saveState } from '../store.js';
import { openMenu } from '../ui/menu.jsx';
import { icon } from '../editor/domicons.js';

export const SPINE_RX = /\.skel$/i;

const POSES = [['standing', 'Standing'], ['aim', 'Aim'], ['cover', 'Cover'], ['skillcut', 'Cut-in']];
const poseName = (p) => (POSES.find(([k]) => k === p) || [p, p])[1];
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 10;
// Drawn at twice the screen's pixels (sharp textures, smooth edges), at most this many pixels on a side.
const QUALITY = 2;
const MAX_SIDE = 3200;
// A page gets about 16 WebGL contexts: past this many players, the one off screen the longest is let go (it
// starts again when it is shown).
const MAX_LIVE = 6;

let playerModule = null;
const loadPlayer = () => (playerModule ||= import('@esotericsoftware/spine-player'));
const live = new Set();
// The hints go away once used: "drag to move" once a model was moved or zoomed, "double-click" once a canvas
// card was double-clicked.
let hintUsed = false;
let liveUsed = false;

/** Nikke file names: c820_00 (standing), c820_aim_01, c820_cover_02, c820_skillcut_00 → {group, pose, costume}. */
function parseName(stem) {
  const m = /^(.*?)(?:_(aim|cover|skillcut|cutin))?_(\d{2})$/i.exec(stem);
  if (!m) return { group: stem, pose: 'standing', costume: stem };
  const pose = !m[2] ? 'standing' : m[2].toLowerCase() === 'cutin' ? 'skillcut' : m[2].toLowerCase();
  return { group: m[1], pose, costume: m[3] };
}

/** The costumes (and their poses) of the models next to `file`, named from fuentes.json when it has names. */
function costumesOf(models, file) {
  const own = parseName(file.replace(SPINE_RX, '')).group;
  const map = new Map();
  for (const m of models) {
    const p = parseName(m.file.replace(SPINE_RX, ''));
    if (p.group !== own) continue;
    let c = map.get(p.costume);
    if (!c) map.set(p.costume, (c = { key: p.costume, name: null, poses: new Map() }));
    // "Handy Maid - Aim": the costume is "Handy Maid"; "Standing" alone: the default outfit.
    if (m.name && !c.name) {
      const i = m.name.lastIndexOf(' - ');
      if (i > 0) c.name = m.name.slice(0, i);
    }
    if (!c.poses.has(p.pose)) c.poses.set(p.pose, m);
  }
  const list = [...map.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  list.forEach((c, i) => {
    if (c.name) return;
    c.name = !/^\d+$/.test(c.key) ? c.key : i === 0 ? 'Default outfit' : `Costume ${+c.key}`;
  });
  return list;
}

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** The viewer's styles: in the page once, and in a canvas' shadow root (canvas.js adds SPINE_CSS there). */
function ensureCss() {
  if (document.getElementById('spv-css')) return;
  const st = document.createElement('style');
  st.id = 'spv-css';
  st.textContent = SPINE_CSS;
  document.head.appendChild(st);
}

/** What was picked in an embed or card: {c: costume, p: pose, a: {model: animation}, v: {model: {z, x, y}}}. */
function loadPick(key, id) {
  const p = key && id ? persisted.spine?.[key]?.[id] : null;
  return p ? JSON.parse(JSON.stringify(p)) : {};
}

function savePick(key, id, pick) {
  if (!key || !id) return;
  const all = persisted.spine || (persisted.spine = {});
  (all[key] || (all[key] = {}))[id] = pick;
  saveState();
}

/** Lets go of the players off screen the longest when there are too many. */
function makeRoom(except) {
  if (live.size < MAX_LIVE) return;
  const idle = [...live].filter((v) => v !== except && !v.visible()).sort((a, b) => a.seenAt() - b.seenAt());
  while (live.size >= MAX_LIVE && idle.length) idle.shift().release();
}

/**
 * The player sizes its canvas from its layout size; this sizes it from what it covers on screen (a zoomed canvas
 * board too) times QUALITY, so the model stays sharp.
 */
function sharpen(p) {
  const r = p.sceneRenderer;
  if (!r) return;
  r.resize = function () {
    const c = this.canvas;
    const b = c.getBoundingClientRect();
    const k = (window.devicePixelRatio || 1) * QUALITY;
    let w = Math.max(1, Math.round(b.width * k));
    let h = Math.max(1, Math.round(b.height * k));
    const big = Math.max(w, h);
    if (big > MAX_SIDE) {
      w = Math.max(1, Math.round((w * MAX_SIDE) / big));
      h = Math.max(1, Math.round((h * MAX_SIDE) / big));
    }
    // A small change of scale (a board zooming) keeps the canvas: it is not reallocated every frame.
    const sameShape = Math.abs(w / h - c.width / c.height) < 0.01;
    const near = Math.abs(w - c.width) / c.width < 0.08;
    if (!(sameShape && near) && (c.width !== w || c.height !== h)) {
      c.width = w;
      c.height = h;
    }
    this.context.gl.viewport(0, 0, c.width, c.height);
    this.camera.setViewport(c.width, c.height);
    this.camera.update();
  };
}

/**
 * A Spine viewer in `host` for the .skel at `path` (a workspace path). compact: inside a canvas card (its bar
 * shows on hover). height: for notes (px). key / id: where what is picked is kept (the note or canvas, and the
 * embed or card). interactive(): whether dragging and the wheel are the model's now (in a canvas card only once
 * it was double-clicked; always in notes and in fullscreen). Returns {destroy}.
 */
export function mountSpine(host, { path, compact = false, height = 0, key = null, id = null, interactive = null } = {}) {
  ensureCss();
  const dir = dirname(path);
  const file = path.split('/').pop();
  const url = (f) => fileUrl(`${dir}/${f}`);
  const box = el('div', 'spv' + (compact ? ' compact' : ''), host);
  if (height) box.style.height = `${height}px`;
  const bar = el('div', 'spv-bar', box);
  const stage = el('div', 'spv-stage', box);
  const ctrls = el('div', 'spv-ctrls', stage);
  const hint = el('div', 'spv-hint', stage);
  hint.appendChild(icon('move', 14));
  const hintLabel = el('span', '', hint);
  const s = {
    costumes: [], costume: null, pose: 'standing', anims: [], anim: null, character: null,
    player: null, holder: null, token: 0, loading: false, paused: false, looping: false, fit: null, view: { z: 1, x: 0, y: 0 },
    rec: null, recTimer: 0, saveTimer: 0, visible: false, seenAt: 0, disposed: false, pick: loadPick(key, id),
  };
  const handle = { visible: () => s.visible, seenAt: () => s.seenAt, release: () => stopPlayer() };

  const current = () => (s.costume ? s.costume.poses.get(s.pose) || [...s.costume.poses.values()][0] : null);
  const isFull = () => box.getRootNode().fullscreenElement === box;
  const canInteract = () => isFull() || !interactive || !!interactive();

  function renderBar() {
    bar.innerHTML = '';
    const c = s.costume;
    if (!c) return;
    const small = compact && !isFull();
    if (!small) el('span', 'spv-title', bar, s.character || parseName(file.replace(SPINE_RX, '')).group);
    const pick = (cap, value, disabled, run) => {
      const b = el('button', 'spv-pick', bar);
      b.type = 'button';
      b.title = `${cap}: ${value}`;
      el('span', 'spv-cap', b, cap);
      el('b', '', b, value);
      b.appendChild(icon('chevron-down', 14));
      b.disabled = !!disabled;
      b.addEventListener('click', (e) => { e.stopPropagation(); run(b); });
      return b;
    };
    // Below the button, or above it when there is no room (a card's bar is at the bottom).
    const menuFor = (b, items, w) => {
      const r = b.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, items, { minWidth: Math.max(w, r.width), anchorY: r.top });
    };
    pick('Costume', c.name, s.costumes.length < 2, (b) => menuFor(b, s.costumes.map((x) => ({
      label: x.name, hint: `${x.poses.size} pose${x.poses.size === 1 ? '' : 's'}`, checked: x === c ? true : undefined,
      run: () => setCostume(x),
    })), 220));
    const poses = POSES.filter(([k]) => c.poses.has(k));
    if (small) {
      // A card is narrow: the pose is a list too, so the bar stays one row.
      pick('Pose', poseName(s.pose), poses.length < 2, (b) => menuFor(b, poses.map(([k, label]) => ({
        label, checked: k === s.pose ? true : undefined, run: () => setPose(k),
      })), 160));
    } else {
      const tabs = el('div', 'spv-tabs', bar);
      for (const [k, label] of poses) {
        const t = el('button', 'spv-tab' + (k === s.pose ? ' on' : ''), tabs, label);
        t.type = 'button';
        t.addEventListener('click', (e) => { e.stopPropagation(); setPose(k); });
      }
    }
    pick('Animation', s.anim || '…', !s.player || s.anims.length < 2, (b) => menuFor(b, s.anims.map((a) => ({
      label: a, checked: a === s.anim ? true : undefined, run: () => setAnim(a),
    })), 200)).classList.add('spv-anim');
    const tools = el('div', 'spv-tools', bar);
    const shot = el('button', 'spv-icon', tools);
    shot.type = 'button';
    shot.title = 'Snapshot (PNG)';
    shot.appendChild(icon('camera', 16));
    shot.disabled = !s.player;
    shot.addEventListener('click', (e) => { e.stopPropagation(); snapshot(); });
    const rec = el('button', 'spv-icon spv-rec' + (s.rec ? ' on' : ''), tools);
    rec.type = 'button';
    rec.title = s.rec ? 'Stop recording' : 'Record a video (WebM)';
    el('span', 'dot', rec);
    if (s.rec) el('span', 'spv-rectime', rec, '0:00');
    rec.disabled = !s.player;
    rec.addEventListener('click', (e) => { e.stopPropagation(); if (s.rec) stopRecording(true); else startRecording(); });
  }

  // Zoom, fit and fullscreen, at the right of the model.
  const ctrlBtn = (name, tip, run) => {
    const b = el('button', 'spv-cbtn', ctrls);
    b.type = 'button';
    b.title = tip;
    b.appendChild(icon(name, 16));
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  };
  ctrlBtn('plus', 'Zoom in', () => zoomBy(1.25));
  const zoomLabel = el('button', 'spv-zlabel', ctrls, '1.0×');
  zoomLabel.type = 'button';
  zoomLabel.title = 'Actual size';
  zoomLabel.addEventListener('click', (e) => { e.stopPropagation(); zoomAt(null, null, 1); keepViewSoon(); });
  ctrlBtn('minus', 'Zoom out', () => zoomBy(1 / 1.25));
  el('div', 'spv-sep', ctrls);
  ctrlBtn('fit', 'Fit (double-click)', fit);
  const fullBtn = ctrlBtn('fullscreen', 'Fullscreen', toggleFull);
  for (const part of [bar, ctrls]) {
    part.addEventListener('pointerdown', (e) => e.stopPropagation());
    part.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  function hintText() {
    const how = !canInteract();
    if (compact && !how && !isFull()) liveUsed = true;
    const text = isFull() ? 'Drag to move · scroll to zoom · Esc to exit'
      : how ? 'Double-click to move and zoom the model'
        : compact ? 'Drag to move · scroll to zoom · Esc when done' : 'Drag to move · scroll to zoom';
    if (hintLabel.textContent !== text) hintLabel.textContent = text;
    box.classList.toggle('used', how ? liveUsed : hintUsed);
  }

  function used() {
    hintUsed = true;
    hintText();
  }

  const updateZoom = () => { zoomLabel.textContent = `${s.view.z.toFixed(1)}×`; };

  /** Zooms to z keeping the point under (cx, cy) (client pixels; the middle when null) where it is. */
  function zoomAt(cx, cy, z) {
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const p = s.player;
    if (p && p.canvas && s.fit) {
      const c = p.canvas;
      const r = c.getBoundingClientRect();
      const ox = cx == null ? 0 : (cx - r.left - r.width / 2) * (c.width / Math.max(1, r.width));
      const oy = cy == null ? 0 : (cy - r.top - r.height / 2) * (c.height / Math.max(1, r.height));
      const d = s.fit.zoom / s.view.z - s.fit.zoom / z;
      s.view.x += ox * d;
      s.view.y -= oy * d;
    }
    s.view.z = z;
    updateZoom();
  }

  function zoomBy(f) {
    zoomAt(null, null, s.view.z * f);
    keepViewSoon();
  }

  function fit() {
    s.view = { z: 1, x: 0, y: 0 };
    updateZoom();
    keepViewSoon();
  }

  function toggleFull() {
    if (isFull()) { document.exitFullscreen().catch(() => {}); return; }
    if (box.requestFullscreen) box.requestFullscreen().catch((e) => console.error(e));
  }

  box.addEventListener('fullscreenchange', () => {
    const on = isFull();
    box.classList.toggle('full', on);
    fullBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
    fullBtn.replaceChildren(icon(on ? 'fullscreen-exit' : 'fullscreen', 16));
    hintText();
    renderBar();
  });

  // Drag to move, wheel to zoom, double-click to fit (a canvas card only while it has the mouse).
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !s.player || !s.fit || !canInteract()) return;
    e.preventDefault();
    e.stopPropagation();
    const c = s.player.canvas;
    const r = c.getBoundingClientRect();
    const k = (c.width / Math.max(1, r.width)) * (s.fit.zoom / s.view.z);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const v0 = { ...s.view };
    stage.setPointerCapture(e.pointerId);
    box.classList.add('grabbing');
    const move = (ev) => {
      s.view.x = v0.x - (ev.clientX - x0) * k;
      s.view.y = v0.y + (ev.clientY - y0) * k;
      if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) used();
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
      box.classList.remove('grabbing');
      keepViewSoon();
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
  });
  stage.addEventListener('wheel', (e) => {
    if (!s.player || !s.fit || !canInteract()) return;
    e.preventDefault();
    e.stopPropagation();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(e.clientX, e.clientY, s.view.z * Math.exp(-e.deltaY * unit * 0.0015));
    used();
    keepViewSoon();
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (!canInteract()) return;
    e.preventDefault();
    e.stopPropagation();
    fit();
  });
  // The card's mode changes with a double-click or Esc while the pointer is over it.
  stage.addEventListener('pointermove', hintText);
  hintText();

  function showMsg(text, error = false) {
    let m = stage.querySelector('.spv-msg');
    if (!m) m = el('div', 'spv-msg', stage);
    m.textContent = text;
    m.classList.toggle('error', error);
  }

  const clearMsg = () => { const m = stage.querySelector('.spv-msg'); if (m) m.remove(); };

  function stopPlayer() {
    if (s.rec) stopRecording(false);
    s.token++;
    s.loading = false;
    s.fit = null;
    live.delete(handle);
    const p = s.player;
    s.player = null;
    if (p) {
      try {
        const gl = p.context && p.context.gl;
        p.dispose();
        const lose = gl && gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch { /* already gone */ }
    }
    if (s.holder) { s.holder.remove(); s.holder = null; }
  }

  async function start() {
    const m = current();
    if (!m || s.disposed) return;
    stopPlayer();
    const token = s.token;
    s.loading = true;
    const slow = setTimeout(() => { if (s.loading && token === s.token) showMsg('Loading…'); }, 400);
    const fail = (text) => { clearTimeout(slow); s.loading = false; showMsg(text, true); };
    let mod;
    try { mod = await loadPlayer(); } catch (e) { fail(`Could not load the Spine player: ${e.message}`); return; }
    if (token !== s.token || s.disposed) return;
    // Premultiplied alpha as the atlas says (Spine 4 atlases have "pma:true" when they are).
    let pma = false;
    try { pma = /^\s*pma\s*:\s*true/im.test(await (await fetch(url(m.atlas))).text()); } catch { /* keep */ }
    if (token !== s.token || s.disposed) return;
    makeRoom(handle);
    const holder = el('div', 'spv-player');
    stage.insertBefore(holder, stage.firstChild);
    s.holder = holder;
    s.view = { z: 1, x: 0, y: 0, ...((s.pick.v || {})[m.file] || {}) };
    updateZoom();
    const want = (s.pick.a || {})[m.file];
    let p;
    try {
      p = new mod.SpinePlayer(holder, {
        binaryUrl: url(m.file),
        atlasUrl: url(m.atlas),
        premultipliedAlpha: pma,
        alpha: true,
        backgroundColor: '#00000000',
        preserveDrawingBuffer: true,
        showControls: false,
        showLoading: false,
        viewport: { padLeft: '5%', padRight: '5%', padTop: '5%', padBottom: '5%', transitionTime: 0 },
        success: (pl) => {
          if (token !== s.token) return;
          clearTimeout(slow);
          s.loading = false;
          clearMsg();
          s.anims = pl.skeleton.data.animations.map((a) => a.name);
          const first = s.anims.includes(want) ? want
            : s.anims.find((a) => /^idle$/i.test(a)) || s.anims.find((a) => /idle/i.test(a)) || s.anims[0];
          if (first) {
            pl.setAnimation(first, true);
            // One camera for all the model's animations (the one that fits the first): picking another does not jump.
            const cv = pl.currentViewport;
            Object.assign(pl.config.viewport, { x: cv.x, y: cv.y, width: cv.width, height: cv.height });
            s.anim = first;
          }
          // The player starts playing by itself only when it picks the animation; here it was picked for it.
          pl.play();
          renderBar();
        },
        error: (pl, msg) => {
          if (token === s.token) fail(`Could not load this model (Spine 4.1 needed): ${msg}`);
        },
        // The camera the player fitted to the model, moved and zoomed as the user did.
        update: (pl) => {
          const cam = pl.sceneRenderer.camera;
          s.fit = { zoom: cam.zoom };
          cam.zoom /= s.view.z;
          cam.position.x += s.view.x;
          cam.position.y += s.view.y;
        },
      });
    } catch (e) {
      fail(`Could not start the Spine player: ${e.message}`);
      return;
    }
    s.player = p;
    s.paused = false;
    s.looping = true;
    sharpen(p);
    // Whether its drawing loop goes on (it ends one frame after stopRendering()).
    const draw = p.drawFrame.bind(p);
    p.drawFrame = (next = true) => {
      if (next) s.looping = !p.stopRequestAnimationFrame && !p.disposed;
      draw(next);
    };
    live.add(handle);
    if (!s.visible) pause();
    renderBar();
  }

  function pause() {
    const p = s.player;
    if (!p || s.paused) return;
    p.stopRendering();
    s.paused = true;
  }

  function resume() {
    const p = s.player;
    if (!p || !s.paused) return;
    s.paused = false;
    p.stopRequestAnimationFrame = false;
    if (!s.looping) {
      if (p.time) p.time.update();
      p.drawFrame();
    }
  }

  /** Keeps the costume and pose; rememberModel() also keeps the current model's animation and view. */
  function rememberPick() {
    if (!s.costume) return;
    s.pick.c = s.costume.key;
    s.pick.p = s.pose;
    savePick(key, id, s.pick);
  }

  function rememberModel() {
    const m = current();
    if (!m) return;
    if (s.anim) (s.pick.a || (s.pick.a = {}))[m.file] = s.anim;
    const v = s.view;
    const views = s.pick.v || (s.pick.v = {});
    if (Math.abs(v.z - 1) < 0.001 && Math.abs(v.x) < 0.5 && Math.abs(v.y) < 0.5) delete views[m.file];
    else views[m.file] = { z: Math.round(v.z * 1000) / 1000, x: Math.round(v.x), y: Math.round(v.y) };
    rememberPick();
  }

  function keepViewSoon() {
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(() => { s.saveTimer = 0; rememberModel(); }, 400);
  }

  function flushView() {
    if (!s.saveTimer) return;
    clearTimeout(s.saveTimer);
    s.saveTimer = 0;
    rememberModel();
  }

  function setCostume(x) {
    if (x === s.costume) return;
    flushView();
    s.costume = x;
    if (!x.poses.has(s.pose)) s.pose = [...x.poses.keys()][0];
    switchModel();
  }

  function setPose(k) {
    if (k === s.pose) return;
    flushView();
    s.pose = k;
    switchModel();
  }

  function setAnim(a) {
    const p = s.player;
    if (!p || a === s.anim) return;
    p.setAnimation(a, true);
    s.anim = a;
    rememberModel();
    renderBar();
  }

  function switchModel() {
    stopPlayer();
    s.anim = null;
    s.anims = [];
    s.view = { z: 1, x: 0, y: 0 };
    updateZoom();
    rememberPick();
    renderBar();
    if (s.visible) start();
  }

  const label = () => `${s.character || parseName(file.replace(SPINE_RX, '')).group} - ${s.costume ? s.costume.name : ''} - ${poseName(s.pose)}`;

  async function save(name, data) {
    try { await api.call('file.saveAs', { name, data }); } catch (e) { console.error(e); }
  }

  function snapshot() {
    const p = s.player;
    if (!p || !p.canvas) return;
    save(`${label()}.png`, p.canvas.toDataURL('image/png'));
  }

  function startRecording() {
    const p = s.player;
    if (!p || !p.canvas || !window.MediaRecorder) return;
    const stream = p.canvas.captureStream(60);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (!rec._keep || !chunks.length) return;
      save(`${label()}.webm`, await blobToDataUrl(new Blob(chunks, { type: 'video/webm' })));
    };
    rec.start(250);
    s.rec = rec;
    const t0 = Date.now();
    s.recTimer = setInterval(() => {
      const t = bar.querySelector('.spv-rectime');
      const sec = Math.floor((Date.now() - t0) / 1000);
      if (t) t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    }, 500);
    renderBar();
  }

  function stopRecording(keep) {
    const rec = s.rec;
    if (!rec) return;
    s.rec = null;
    clearInterval(s.recTimer);
    rec._keep = keep;
    try { rec.stop(); } catch { /* stopped */ }
    renderBar();
  }

  // Plays while on screen (a little before it scrolls in), stops drawing when off screen.
  const io = new IntersectionObserver((entries) => {
    s.visible = entries[entries.length - 1].isIntersecting;
    s.seenAt = performance.now();
    if (!s.costume || s.disposed) return;
    if (!s.visible) pause();
    else if (!s.player && !s.loading) start();
    else resume();
  }, { rootMargin: '150px' });
  io.observe(box);
  // Taken off the page some other way (a card removed, the note closed): WebGL is given back.
  const watch = setInterval(() => { if (!box.isConnected) destroy(); }, 4000);

  function destroy() {
    if (s.disposed) return;
    flushView();
    s.disposed = true;
    clearInterval(watch);
    io.disconnect();
    stopPlayer();
  }

  api.call('spine.info', { path }).then((info) => {
    if (s.disposed) return;
    s.character = info.character || null;
    s.costumes = costumesOf(info.models || [], file);
    if (!s.costumes.length) {
      showMsg(`No Spine model here: ${file} needs its .atlas (same name) next to it.`, true);
      return;
    }
    const own = parseName(file.replace(SPINE_RX, ''));
    s.costume = (s.pick.c != null && s.costumes.find((c) => c.key === s.pick.c)) || s.costumes.find((c) => c.key === own.costume) || s.costumes[0];
    const pose = s.pick.p || own.pose;
    s.pose = s.costume.poses.has(pose) ? pose : s.costume.poses.has(own.pose) ? own.pose : [...s.costume.poses.keys()][0];
    renderBar();
    hintText();
    if (s.visible) start();
  }).catch((e) => showMsg(`Could not read this model's folder: ${e.message}`, true));

  return { destroy, get player() { return s.player; }, get view() { return { ...s.view }; } };
}

export const SPINE_CSS = `
.spv { position: relative; display: flex; flex-direction: column; height: 560px; max-width: 100%; margin: 6px 0; border: 1px solid var(--border);
  border-radius: var(--radius, 8px); overflow: hidden; color: var(--text); background: transparent; user-select: none; white-space: normal;
  font: 13px/1.3 var(--font-ui); }
.spv.compact { height: 100%; margin: 0; border: 0; border-radius: inherit; }
.spv.full { height: 100%; max-width: none; margin: 0; border: 0; border-radius: 0; background: var(--bg-2); }
.spv-bar { display: flex; align-items: center; gap: 4px; padding: 5px 6px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.spv-bar:empty { display: none; }
.spv-title { padding: 0 8px 0 6px; font-weight: 600; font-size: 13.5px; color: var(--text-strong, var(--text)); white-space: nowrap; }
.spv-pick { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 40%; height: 30px; padding: 0 8px; border: 0; border-radius: 6px;
  background: none; color: var(--text); font: 600 13px var(--font-ui); cursor: pointer; }
.spv-pick:hover:not(:disabled) { background: var(--bg-hover); }
.spv-pick:disabled { cursor: default; opacity: 1; }
.spv-pick:disabled svg { display: none; }
.spv-pick b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.spv-pick svg { flex: none; color: var(--text-muted); }
.spv-cap { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; color: var(--text-muted); }
.spv-tabs { display: flex; gap: 2px; }
.spv-tab { height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: none; color: var(--text-muted); font: 600 13px var(--font-ui); cursor: pointer; }
.spv-tab:hover { color: var(--text); background: var(--bg-hover); }
.spv-tab.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.spv-tools { display: flex; gap: 2px; margin-left: auto; }
.spv-icon { height: 30px; min-width: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 7px; border: 0;
  border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer; font: 600 12px var(--font-ui); }
.spv-icon:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-strong, var(--text)); }
.spv-icon:disabled { opacity: .4; cursor: default; }
.spv-rec .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger, #f23f43); }
.spv-rec.on { color: var(--danger, #f23f43); background: color-mix(in srgb, var(--danger, #f23f43) 12%, transparent); }
.spv-rec.on .dot { border-radius: 2px; animation: spv-pulse 1.2s ease-in-out infinite; }
@keyframes spv-pulse { 50% { opacity: .35; } }
.spv-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: grab; }
.spv.grabbing .spv-stage { cursor: grabbing; }
.spv-player { position: absolute; inset: 0; }
.spv .spine-player-error { display: none !important; }
.spv-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 0 24px; text-align: center; color: var(--text-muted); pointer-events: none; }
.spv-msg.error { color: var(--danger, #f23f43); }
.spv-ctrls { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); z-index: 2; display: flex; flex-direction: column; align-items: center;
  gap: 2px; padding: 4px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); cursor: default;
  opacity: 0; transition: opacity .15s; }
.spv:hover .spv-ctrls, .spv.full .spv-ctrls, .spv-ctrls:focus-within { opacity: 1; }
.spv-cbtn { width: 30px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 7px; background: none; color: var(--text-muted); cursor: pointer; }
.spv-cbtn:hover { background: var(--bg-hover); color: var(--text-strong, var(--text)); }
.spv-zlabel { width: 36px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--text); font: 600 11.5px var(--font-ui); cursor: pointer; }
.spv-zlabel:hover { background: var(--bg-hover); }
.spv-sep { width: 18px; height: 1px; margin: 3px 0; background: var(--border); }
.spv-hint { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 2; display: flex; align-items: center; gap: 8px; padding: 6px 14px;
  border: 1px solid var(--border); border-radius: 999px; background: color-mix(in srgb, var(--bg-0) 88%, transparent); color: var(--text);
  font: 600 12.5px var(--font-ui); white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .2s; }
.spv-hint svg { color: var(--text-muted); }
.spv-stage:hover .spv-hint { opacity: 1; }
.spv.used .spv-hint, .spv.grabbing .spv-hint { opacity: 0 !important; }
.spv.compact:not(.full) .spv-bar { position: absolute; left: 6px; right: 6px; bottom: 6px; z-index: 3; flex-wrap: nowrap; gap: 2px; padding: 3px;
  background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); opacity: 0; transition: opacity .15s; }
.spv.compact:hover .spv-bar, .spv.compact .spv-bar:focus-within, .spv.compact .spv-bar:has(.spv-rec.on) { opacity: 1; }
.spv.compact:not(.full) .spv-cap { display: none; }
.spv.compact:not(.full) .spv-pick { max-width: none; flex: 0 1 auto; gap: 4px; padding: 0 7px; }
.spv.compact:not(.full) .spv-hint { top: 12px; bottom: auto; }
.spv.compact:not(.full) .spv-ctrls { right: 8px; }
.canvas-node:not(.spv-live) .spv.compact:not(.full) .spv-stage { cursor: inherit; }
`;
