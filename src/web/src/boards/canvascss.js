// Styles of the canvas board. They live in the board's shadow root (with the vault's CSS
// snippets after them), so class names can match Obsidian's (.canvas-node, .canvas-node-content…).
// App theme variables (--bg-1, --accent…) are inherited through the shadow boundary.

export const CANVAS_CSS = `
:host { --cv-bg: var(--bg-2); --cv-dot: color-mix(in srgb, var(--text-muted) 32%, transparent); --cv-node-bg: var(--bg-1);
  --cv-node-border: color-mix(in srgb, var(--text-muted) 30%, transparent); --cv-edge: color-mix(in srgb, var(--text-muted) 85%, transparent);
  --cv-sel: var(--accent); }
.canvas-wrapper { position: absolute; inset: 0; overflow: hidden; background: var(--cv-bg); outline: none; cursor: default; touch-action: none;
  user-select: none; -webkit-user-select: none; font-family: var(--font-ui); color: var(--text); }
.canvas-wrapper.panning, .canvas-wrapper.space { cursor: grab; }
.canvas-wrapper.panning { cursor: grabbing; }
.canvas-background { position: absolute; inset: 0; pointer-events: none; background-image: radial-gradient(circle, var(--cv-dot) 1px, transparent 1.4px); }
.canvas { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; will-change: transform; }
.canvas.animate { transition: transform .25s ease; }
.cv-groups, .cv-nodes, .cv-edge-labels { position: absolute; left: 0; top: 0; }
.cv-groups { z-index: 0; }
.cv-edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; z-index: 1; }
.cv-nodes { z-index: 2; }
.cv-edge-labels { z-index: 3; }
.cv-guides { position: absolute; left: 0; top: 0; z-index: 4; pointer-events: none; }
.cv-guide { position: absolute; display: none; --cv-guide: var(--cv-sel); }
.cv-guide.v { width: 0; border-left: calc(1px * var(--iz, 1)) dashed var(--cv-guide); transform: translateX(-50%); }
.cv-guide.h { height: 0; border-top: calc(1px * var(--iz, 1)) dashed var(--cv-guide); transform: translateY(-50%); }
.cv-edge .line { fill: none; stroke: var(--edge-color); stroke-width: var(--edge-w, 3px); stroke-linecap: round; }
.cv-edge .head { fill: var(--edge-color); stroke: var(--edge-color); stroke-width: 1; stroke-linejoin: round; }
.cv-edge .hit { fill: none; stroke: transparent; stroke-width: 16; pointer-events: stroke; cursor: pointer; }
.cv-edge.selected .line { stroke-width: calc(var(--edge-w, 3px) + 1px); filter: drop-shadow(0 0 3px var(--cv-sel)); }
.cv-temp { fill: none; stroke: var(--cv-sel); stroke-width: 3; stroke-dasharray: 8 6; }
.cv-edge-label { position: absolute; transform: translate(-50%, -50%); background: var(--cv-bg); color: var(--text); font-size: 14px; padding: 2px 8px;
  border-radius: 6px; white-space: nowrap; cursor: pointer; border: 1px solid var(--cv-node-border); }

.canvas-node { position: absolute; box-sizing: border-box; }
.canvas-node-container { position: absolute; inset: 0; box-sizing: border-box; border-radius: 10px; background: var(--cv-node-bg);
  border: 2px solid var(--cv-node-border); overflow: hidden; }
.canvas-node[data-color] .canvas-node-container { border-color: var(--node-color); background: color-mix(in srgb, var(--node-color) 10%, var(--cv-node-bg)); }
.canvas-node-container > .canvas-node-content { position: absolute; inset: 0; overflow: hidden; padding: 12px 18px; box-sizing: border-box; font-size: 16px; line-height: 1.5;
  overflow-wrap: anywhere; color: var(--text); }
.canvas-node.is-text.selected > .canvas-node-container > .canvas-node-content, .canvas-node.selected .cv-file-body { overflow: auto; user-select: text; -webkit-user-select: text; }
.canvas-node.is-image > .canvas-node-container > .canvas-node-content, .canvas-node.is-file > .canvas-node-container > .canvas-node-content { padding: 0; }
.canvas-node.is-image .canvas-node-container { background: var(--cv-node-bg); }
.canvas-node.is-image[data-color] .canvas-node-container { border-color: var(--node-color); background: color-mix(in srgb, var(--node-color) 10%, var(--cv-node-bg)); }
/* Spine models stand on the board: no card around them until hovered; double-clicked (moving the model), an accent border. */
.canvas-node.is-spine > .canvas-node-container, .canvas-node.is-spine[data-color] > .canvas-node-container { background: transparent; border-color: transparent; }
.canvas-node.is-spine:hover > .canvas-node-container { border-color: var(--cv-node-border); }
.canvas-node.is-spine[data-color]:hover > .canvas-node-container { border-color: var(--node-color); }
.canvas-node.is-spine.spv-live > .canvas-node-container { border-color: var(--accent); }
.canvas-node.is-group .canvas-node-container { background: color-mix(in srgb, var(--node-color, var(--text-muted)) 6%, transparent); border-style: solid; }
.canvas-node.is-group[data-color] .canvas-node-container { background: color-mix(in srgb, var(--node-color) 10%, transparent); }
.canvas-group-label { position: absolute; left: 0; bottom: calc(100% + 6px); font-size: 22px; font-weight: 600; white-space: nowrap; color: var(--text-strong, var(--text));
  background: color-mix(in srgb, var(--node-color, var(--bg-1)) 25%, var(--bg-1)); padding: 2px 12px; border-radius: 8px; cursor: default; }
.canvas-wrapper.far .canvas-group-label { font-size: 44px; }

/* Selection like Miro: a thin line exactly on the card, round handles on its corners, and the four connection
   dots outside its sides once one card is selected (they pop in). --iz is 1 / zoom: handles keep their size on screen. */
.cv-ring { position: absolute; inset: 0; outline: calc(1.5px * var(--iz, 1)) solid var(--cv-sel); outline-offset: 0; pointer-events: none; display: none; }
.canvas-node.selected > .cv-ring { display: block; }
.canvas-wrapper.multi .canvas-node.selected > .cv-ring { outline-width: calc(1px * var(--iz, 1)); }
.canvas-node.connect-target > .cv-ring { display: block; outline-style: dashed; outline-width: calc(2px * var(--iz, 1)); }
.cv-resize { position: absolute; display: none; z-index: 3; box-sizing: border-box; }
.canvas-node:hover > .cv-resize, .canvas-node.selected > .cv-resize { display: block; }
.canvas-wrapper.dragging .canvas-node:not(.selected) > .cv-resize, .canvas-wrapper.multi .canvas-node > .cv-resize { display: none; }
.cv-resize.n, .cv-resize.s { left: calc(8px * var(--iz, 1)); right: calc(8px * var(--iz, 1)); height: calc(10px * var(--iz, 1)); cursor: ns-resize; }
.cv-resize.e, .cv-resize.w { top: calc(8px * var(--iz, 1)); bottom: calc(8px * var(--iz, 1)); width: calc(10px * var(--iz, 1)); cursor: ew-resize; }
.cv-resize.n { top: calc(-5px * var(--iz, 1)); }
.cv-resize.s { bottom: calc(-5px * var(--iz, 1)); }
.cv-resize.e { right: calc(-5px * var(--iz, 1)); }
.cv-resize.w { left: calc(-5px * var(--iz, 1)); }
.cv-resize.nw, .cv-resize.ne, .cv-resize.sw, .cv-resize.se, .cv-gb { width: calc(11px * var(--iz, 1)); height: calc(11px * var(--iz, 1)); border-radius: 50%;
  background: #fff; border: calc(1.5px * var(--iz, 1)) solid var(--cv-sel); box-sizing: border-box; }
.cv-resize.nw, .cv-gb.nw { left: calc(-5.5px * var(--iz, 1)); top: calc(-5.5px * var(--iz, 1)); cursor: nwse-resize; }
.cv-resize.se, .cv-gb.se { right: calc(-5.5px * var(--iz, 1)); bottom: calc(-5.5px * var(--iz, 1)); cursor: nwse-resize; }
.cv-resize.ne, .cv-gb.ne { right: calc(-5.5px * var(--iz, 1)); top: calc(-5.5px * var(--iz, 1)); cursor: nesw-resize; }
.cv-resize.sw, .cv-gb.sw { left: calc(-5.5px * var(--iz, 1)); bottom: calc(-5.5px * var(--iz, 1)); cursor: nesw-resize; }
.canvas-node:not(.selected) > .cv-resize { background: transparent; border-color: transparent; }
.cv-port { position: absolute; width: calc(12px * var(--iz, 1)); height: calc(12px * var(--iz, 1)); border-radius: 50%; background: var(--cv-sel);
  border: calc(2px * var(--iz, 1)) solid #fff; cursor: crosshair; display: none; z-index: 4; box-sizing: border-box;
  box-shadow: 0 calc(1px * var(--iz, 1)) calc(3px * var(--iz, 1)) rgba(0, 0, 0, .35); transition: transform .1s ease; }
.canvas-wrapper:not(.multi) .canvas-node.selected > .cv-port { display: block; animation: cv-pop .2s cubic-bezier(.2, .9, .3, 1.3) both; }
@keyframes cv-pop { from { scale: 0; opacity: 0; } to { scale: 1; opacity: 1; } }
.cv-port.top { left: calc(50% - 6px * var(--iz, 1)); top: calc(-26px * var(--iz, 1)); }
.cv-port.bottom { left: calc(50% - 6px * var(--iz, 1)); bottom: calc(-26px * var(--iz, 1)); }
.cv-port.left { top: calc(50% - 6px * var(--iz, 1)); left: calc(-26px * var(--iz, 1)); }
.cv-port.right { top: calc(50% - 6px * var(--iz, 1)); right: calc(-26px * var(--iz, 1)); }
.cv-port:hover { transform: scale(1.3); }
.canvas-node.editing > .cv-port, .canvas-node.editing > .cv-resize { display: none !important; }
.canvas-wrapper.read-only .cv-port, .canvas-wrapper.read-only .cv-resize, .canvas-wrapper.dragging .cv-port { display: none !important; }
/* Several cards selected: one box around them all, its corners resize them together (like Miro). */
.cv-groupbox { position: absolute; display: none; pointer-events: none; outline: calc(1.5px * var(--iz, 1)) solid var(--cv-sel); z-index: 5; }
.cv-groupbox.show { display: block; }
.cv-gb { position: absolute; pointer-events: auto; }
.canvas-wrapper.read-only .cv-gb { display: none; }
.canvas-wrapper.dragging .cv-groupbox { outline-style: dashed; }

.cv-img { width: 100%; height: 100%; object-fit: contain; display: block; opacity: 0; transition: opacity .3s ease; pointer-events: none; }
.cv-img.loaded { opacity: 1; }
.cv-missing-file { box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 8px; height: 100%; padding: 12px; overflow: hidden; color: var(--text-muted); font-size: 13px; text-align: center; }
.cv-missing { color: var(--text-muted); font-style: italic; }
.cv-loading { position: absolute; inset: 0; background: color-mix(in srgb, var(--text-muted) 8%, transparent); }
.cv-file-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px; font-weight: 650; font-size: 16px; color: var(--text-strong, var(--text));
  border-bottom: 1px solid var(--cv-node-border); }
.cv-file-head span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-file-body { position: absolute; top: 44px; left: 0; right: 0; bottom: 0; overflow: hidden; padding: 8px 16px 12px; font-size: 14.5px; }
.cv-muted { color: var(--text-muted); }
.cv-link { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 100%; text-align: center; padding: 12px; box-sizing: border-box; }
.cv-link a { color: var(--link); font-weight: 600; cursor: pointer; word-break: break-all; }
.cv-link .cv-muted { font-size: 12px; }
.canvas-node.is-link > .canvas-node-container > .canvas-node-content,
.canvas-node.is-video > .canvas-node-container > .canvas-node-content,
.canvas-node.is-audio > .canvas-node-container > .canvas-node-content { padding: 0; }
.canvas-node.is-video .canvas-node-container { background: #000; }
/* Web players (YouTube) take the pointer once their card is selected (like Obsidian): before that, a click selects. */
.canvas-node:not(.selected) .mn-frame { pointer-events: none; }
.canvas-wrapper.dragging .mn-frame { pointer-events: none; }

/* Editing a text card: the notes' live-preview editor, with the look of the card itself. */
.cv-editor { position: absolute; inset: 0; box-sizing: border-box; }
.cv-cm .cm-editor { height: 100%; outline: none; background: transparent; color: var(--text); font-size: 16px; }
.cv-cm .cm-editor.cm-focused { outline: none; }
/* (adopted CodeMirror styles come later in the cascade: these selectors are one class stronger) */
.cv-cm .cm-editor .cm-scroller { font-family: var(--font-ui); line-height: 1.5; overflow: auto; }
.cv-cm .cm-editor .cm-content { padding: 12px 18px; caret-color: var(--caret, var(--text)); user-select: text; -webkit-user-select: text; }
.cv-cm .cm-editor .cm-line { padding: 0; }
.cv-cm .cm-editor .cm-cursor { border-left: 2px solid var(--caret, var(--text)); }
.cv-cm .cm-focused .cm-selectionBackground, .cv-cm .cm-selectionBackground, .cv-cm .cm-content ::selection { background: var(--selection) !important; }
.cv-cm .cm-editor .cm-placeholder { color: var(--text-muted); font-style: italic; }
.cv-cm .cm-html-block { cursor: text; padding: 2px 0; }
.canvas-node.editing > .canvas-node-container { box-shadow: 0 0 0 2px var(--cv-sel); }
.cv-measure { position: absolute; left: -100000px; top: 0; visibility: hidden; pointer-events: none; }

/* The bar over the selection: remove, colour, zoom to selection. */
.cv-selbar { position: absolute; left: 0; top: 0; display: none; align-items: center; gap: 2px; padding: 3px; z-index: 6;
  background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
.cv-selbar.show { display: flex; }
.cv-sbtn { width: 32px; height: 30px; display: grid; place-items: center; border: 0; background: none; color: var(--text-muted); border-radius: 7px; cursor: pointer; padding: 0; }
.cv-sbtn:hover { background: var(--bg-hover); color: var(--text-strong, var(--text)); }
.cv-sbtn.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
/* Shapes: a text card drawn as a shape, its text centred inside. */
.canvas-node.is-shape > .canvas-node-container, .canvas-node.is-shape[data-color] > .canvas-node-container { background: transparent; border: 0; border-radius: 0; overflow: visible; }
.cv-shape { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.cv-shape path { fill: var(--cv-node-bg); stroke: color-mix(in srgb, var(--text) 72%, transparent); stroke-width: 2; stroke-linejoin: round; }
.canvas-node.is-shape[data-color] .cv-shape path { fill: color-mix(in srgb, var(--node-color) 22%, var(--cv-node-bg)); stroke: var(--node-color); }
.canvas-node.is-shape > .canvas-node-container > .canvas-node-content { display: flex; flex-direction: column; justify-content: center; text-align: center; padding: var(--shape-pad, 10px 14px); }
.canvas-node.is-shape .cv-editor { position: relative; inset: auto; height: auto; max-height: 100%; display: flex; flex-direction: column; }
.canvas-node.is-shape .cv-cm .cm-editor { height: auto; max-height: 100%; }
.canvas-node.is-shape .cv-cm .cm-editor .cm-content { padding: 0; }
.canvas-node.is-shape .cv-cm .cm-editor .cm-line { text-align: center; }
.canvas-node.is-shape.editing > .canvas-node-container { box-shadow: none; }
/* Floating panels: shapes, line style, quick create (Miro). */
.cv-pop { position: absolute; left: 0; top: 0; z-index: 9; padding: 8px; background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow); animation: cv-drop .12s ease-out; }
.cv-pop-title { font: 700 10.5px var(--font-ui); color: var(--text-muted); text-transform: uppercase; letter-spacing: .5px; margin: 6px 4px 4px; }
.cv-pop-title:first-child { margin-top: 0; }
.cv-pop-grid { display: grid; grid-template-columns: repeat(6, 34px); gap: 2px; }
.cv-pop-grid.three { grid-template-columns: repeat(3, 38px); justify-content: center; }
.cv-pop-row { display: flex; gap: 2px; margin-top: 6px; justify-content: space-between; }
.cv-pop-btn { width: 34px; height: 32px; display: grid; place-items: center; border: 0; background: none; color: var(--text); border-radius: 8px; cursor: pointer; padding: 0; }
.cv-pop-grid.three .cv-pop-btn { width: 38px; height: 36px; }
.cv-pop-row .cv-pop-btn { flex: 1; }
.cv-pop-btn:hover { background: var(--bg-hover); color: var(--text-strong, var(--text)); }
.cv-pop-btn.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.cv-pop-wide { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-width: 150px; height: 36px; padding: 0 10px; margin-bottom: 6px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); color: var(--text); font: 13px var(--font-ui); cursor: pointer; }
.cv-pop-wide:hover { border-color: var(--accent); }
.cv-pop-key { color: var(--text-muted); }
.cv-pop-link { display: block; width: 100%; margin-top: 6px; padding: 8px 6px 2px; border: 0; border-top: 1px solid var(--border); background: none; color: var(--text-muted);
  font: 13px var(--font-ui); cursor: pointer; text-align: center; }
.cv-pop-link:hover { color: var(--text); }
.cv-linestyle { width: 196px; }
.cv-steps { position: relative; height: 24px; margin: 2px 8px 4px; cursor: pointer; touch-action: none; }
.cv-steps-track, .cv-steps-fill { position: absolute; left: 0; top: 11px; height: 2px; border-radius: 1px; background: var(--border); }
.cv-steps-track { right: 0; }
.cv-steps-fill { background: var(--text); }
.cv-steps-dot { position: absolute; top: 9px; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; background: var(--border); }
.cv-steps-dot.on { background: var(--text); }
.cv-steps-knob { position: absolute; top: 3px; width: 18px; height: 18px; margin-left: -9px; border-radius: 50%; background: var(--text); box-shadow: 0 1px 3px rgba(0, 0, 0, .4); }
/* Align / distribute popover under the bar (Miro). */
.cv-alignpop { position: absolute; left: 0; top: 0; z-index: 8; display: flex; flex-direction: column; gap: 2px; padding: 6px;
  background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); animation: cv-drop .12s ease-out; }
@keyframes cv-drop { from { opacity: 0; margin-top: -4px; } to { opacity: 1; margin-top: 0; } }
.cv-alignrow { display: flex; align-items: center; gap: 2px; }
.cv-alignsep { width: 1px; height: 22px; background: var(--border); margin: 0 5px; }
.cv-abtn { width: 34px; height: 32px; display: grid; place-items: center; border: 0; background: none; color: var(--text); border-radius: 8px; cursor: pointer; padding: 0; }
.cv-abtn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-strong, var(--text)); }
.cv-abtn:disabled { opacity: .3; cursor: default; }
.cv-tip { position: absolute; left: 0; top: 0; pointer-events: none; background: #111; color: #fff; font: 600 12px var(--font-ui); padding: 5px 9px; border-radius: 6px;
  white-space: nowrap; opacity: 0; transition: opacity .1s ease; z-index: 2; }
.cv-tip.show { opacity: 1; }
.cv-tip::after { content: ""; position: absolute; left: 50%; bottom: -4px; margin-left: -4px; border: 4px solid transparent; border-top-color: #111; border-bottom: 0; }
.cv-sbtn.wide { width: auto; min-width: 34px; padding: 0 8px; }
.cv-sbtn.typed { width: auto; min-width: 38px; padding: 0 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; }
.cv-sbtn-text { font: 600 12px var(--font-ui); }
.cv-sbtn-caption { font: 600 9px var(--font-ui); line-height: 1; }
.cv-swatch-dot { width: 16px; height: 16px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .25); }
.cv-selbar .cv-tsep { height: 20px; margin: 0 3px; }
/* The selected arrow's handles: ends, bend points, and fainter "add a bend" points between them. */
.cv-edge-ui { position: absolute; left: 0; top: 0; z-index: 6; pointer-events: none; }
.cv-eh { position: absolute; width: calc(12px * var(--iz, 1)); height: calc(12px * var(--iz, 1)); margin: calc(-6px * var(--iz, 1)) 0 0 calc(-6px * var(--iz, 1));
  border-radius: 50%; background: #fff; border: calc(1.5px * var(--iz, 1)) solid var(--cv-sel); box-sizing: border-box; pointer-events: auto; cursor: move;
  box-shadow: 0 calc(1px * var(--iz, 1)) calc(3px * var(--iz, 1)) rgba(0, 0, 0, .3); animation: cv-pop .16s ease-out both; }
.cv-eh.end { cursor: crosshair; }
.cv-eh.mid { width: calc(9px * var(--iz, 1)); height: calc(9px * var(--iz, 1)); margin: calc(-4.5px * var(--iz, 1)) 0 0 calc(-4.5px * var(--iz, 1)); opacity: .6; cursor: copy; }
.cv-eh.mid:hover { opacity: 1; }
.canvas-wrapper.dragging .cv-eh { animation: none; }
.canvas-wrapper.read-only .cv-edge-ui { display: none; }
.canvas-wrapper.tool-arrow, .canvas-wrapper.tool-arrow .canvas-node, .canvas-wrapper.tool-arrow .canvas-node * { cursor: crosshair !important; }
.canvas-wrapper.read-only .cv-selbar .cv-tadd { display: none; }

/* rendered markdown */
.markdown-rendered > :first-child { margin-top: 0; }
.markdown-rendered > :last-child { margin-bottom: 0; }
.markdown-rendered p { margin: 0 0 .6em; }
.markdown-rendered h1, .markdown-rendered h2, .markdown-rendered h3, .markdown-rendered h4 { margin: .4em 0 .4em; line-height: 1.25; color: var(--text-strong, var(--text)); }
.markdown-rendered h1 { font-size: 1.7em; } .markdown-rendered h2 { font-size: 1.4em; } .markdown-rendered h3 { font-size: 1.2em; }
.markdown-rendered ul, .markdown-rendered ol { margin: 0 0 .6em; padding-left: 1.4em; }
.markdown-rendered li { margin: .1em 0; }
.markdown-rendered img { max-width: 100%; border-radius: 6px; display: block; margin: .3em 0; }
.markdown-rendered a { color: var(--link); text-decoration: none; cursor: pointer; }
.markdown-rendered a:hover { text-decoration: underline; }
.markdown-rendered code { font-family: var(--font-mono); font-size: .88em; background: var(--bg-code); padding: .1em .35em; border-radius: 4px; }
.markdown-rendered pre { background: var(--bg-code); padding: 10px 12px; border-radius: 8px; overflow: auto; }
.markdown-rendered pre code { background: none; padding: 0; }
.markdown-rendered blockquote { margin: 0 0 .6em; padding-left: 12px; border-left: 3px solid var(--cv-node-border); color: var(--text-muted); }
.markdown-rendered hr { border: 0; border-top: 1px solid var(--cv-node-border); margin: .8em 0; }
.markdown-rendered table { border-collapse: collapse; margin: 0 0 .6em; }
.markdown-rendered th, .markdown-rendered td { border: 1px solid var(--cv-node-border); padding: 3px 8px; }
.markdown-rendered mark { background: color-mix(in srgb, var(--warning) 45%, transparent); color: inherit; border-radius: 3px; padding: 0 2px; }

.cv-ghost { position: absolute; z-index: 6; pointer-events: none; }
.cv-ghost .cv-shape path { fill: color-mix(in srgb, var(--cv-sel) 10%, transparent); stroke: var(--cv-sel); stroke-width: 1.5; }
.cv-marquee { position: absolute; display: none; border: 1px solid var(--cv-sel); background: color-mix(in srgb, var(--cv-sel) 14%, transparent); pointer-events: none; border-radius: 3px; }
.cv-msg { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); text-align: center; color: var(--text-muted); pointer-events: none; max-width: 520px;
  font-size: 14px; line-height: 1.7; }
.cv-msg b { font-size: 18px; color: var(--text); }
.cv-msg.error { color: var(--danger); pointer-events: auto; }
.cv-msg:empty { display: none; }

.cv-tbtn.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.canvas-wrapper.read-only .cv-tadd { display: none; }
.cv-toolbar { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 2px; padding: 4px;
  background: var(--bg-1); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); z-index: 5; }
.cv-tbtn { height: 34px; min-width: 34px; display: grid; place-items: center; border: 0; background: none; color: var(--text-muted); border-radius: 8px; cursor: pointer;
  font: 600 12px var(--font-ui); padding: 0 6px; }
.cv-tbtn:hover { background: var(--bg-hover); color: var(--text-strong, var(--text)); }
.cv-zoom { min-width: 54px; font-variant-numeric: tabular-nums; }
.cv-tsep { width: 1px; height: 22px; background: var(--border); margin: 0 4px; }
`;
