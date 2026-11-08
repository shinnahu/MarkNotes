// Fenced code blocks shown as their own little "window" (like ChatGPT): own scrollbar,
// copy button, word-wrap toggle, minimise-to-pill and a "back to top" button.
// When the caret goes inside the block, the raw text is shown for editing.

import { StateField, StateEffect, Facet } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { loadParser, renderHighlighted, languageLabel } from './highlight.js';
import { hash } from '../util.js';
import { icon } from './domicons.js';
import { blockBox, onBlockBox } from './blockbox.js';

/** Per-note storage for minimised / no-wrap blocks, provided by the app. */
export const codeBlockStore = Facet.define({
  combine: (v) => v[0] || { get: () => null, set: () => {}, key: () => '', defaults: () => ({ wrap: true, maxHeight: 420, lineNumbers: false }), toast: () => {} },
});

export const refreshCodeBlocks = StateEffect.define();

function touches(state, from, to) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function blockId(info, code) {
  return hash(info + '\u0000' + code);
}

class CodeCard extends WidgetType {
  constructor(info, code, collapsed, wrap) {
    super();
    this.info = info;
    this.code = code;
    this.collapsed = collapsed;
    this.wrap = wrap;
  }

  eq(o) {
    return o.info === this.info && o.code === this.code && o.collapsed === this.collapsed;
  }

  get estimatedHeight() {
    if (this.collapsed) return 40;
    const lines = this.code.split('\n').length;
    return Math.min(42 + lines * 21 + 16, 520);
  }

  ignoreEvent(e) {
    return !onBlockBox(e);
  }

  toDOM(view) {
    const store = view.state.facet(codeBlockStore);
    const id = blockId(this.info, this.code);
    const lines = this.code.split('\n');
    const label = languageLabel(this.info);
    const root = document.createElement('div');
    root.className = 'cc' + (this.collapsed ? ' cc-collapsed' : '');
    root.setAttribute('data-cc', id);

    const placeCaret = (lineIdx, col) => {
      const pos = view.posAtDOM(root);
      const start = view.state.doc.lineAt(pos);
      const target = Math.min(start.number + 1 + lineIdx, view.state.doc.lines);
      const line = view.state.doc.line(target);
      view.dispatch({ selection: { anchor: Math.min(line.from + col, line.to) }, scrollIntoView: false });
      view.focus();
    };

    if (this.collapsed) {
      const pill = document.createElement('button');
      pill.className = 'cc-pill';
      pill.title = 'Expand code block';
      const first = (lines.find((l) => l.trim()) || '').trim();
      pill.append(icon('chevron-right', 14), icon('code', 14));
      const lab = document.createElement('span');
      lab.className = 'cc-pill-lang';
      lab.textContent = label;
      const meta = document.createElement('span');
      meta.className = 'cc-pill-meta';
      meta.textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
      const prev = document.createElement('span');
      prev.className = 'cc-pill-preview';
      prev.textContent = first.slice(0, 80);
      pill.append(lab, meta, prev);
      pill.addEventListener('mousedown', (e) => e.preventDefault());
      pill.addEventListener('click', () => {
        store.set(store.key(view.state), id, { c: 0 });
        view.dispatch({ effects: refreshCodeBlocks.of(null) });
      });
      root.appendChild(pill);
      return blockBox(root);
    }

    let wrap = this.wrap;
    root.classList.toggle('cc-nowrap', !wrap);

    // Header
    const head = document.createElement('div');
    head.className = 'cc-head';
    const lang = document.createElement('span');
    lang.className = 'cc-lang';
    lang.append(icon('code', 14), document.createTextNode(' ' + label));
    const count = document.createElement('span');
    count.className = 'cc-count';
    count.textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
    const actions = document.createElement('div');
    actions.className = 'cc-actions';
    const mkBtn = (name, title, onClick, text) => {
      const b = document.createElement('button');
      b.className = 'cc-btn';
      b.title = title;
      b.append(icon(name, 15));
      if (text) {
        const s = document.createElement('span');
        s.textContent = text;
        b.append(s);
      }
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
      return b;
    };
    const wrapBtn = mkBtn('wrap', 'Word wrap (on/off)', () => {
      wrap = !wrap;
      root.classList.toggle('cc-nowrap', !wrap);
      wrapBtn.classList.toggle('on', wrap);
      store.set(store.key(view.state), id, { w: wrap ? 1 : 0 });
    });
    wrapBtn.classList.toggle('on', wrap);
    const editBtn = mkBtn('pencil', 'Edit code', () => placeCaret(0, 0));
    const copyBtn = mkBtn('copy', 'Copy code', async (b) => {
      try {
        await navigator.clipboard.writeText(this.code);
        b.classList.add('done');
        b.querySelector('span').textContent = 'Copied!';
        setTimeout(() => { b.classList.remove('done'); b.querySelector('span').textContent = 'Copy'; }, 1400);
      } catch {
        store.toast('Could not copy to the clipboard');
      }
    }, 'Copy');
    const minBtn = mkBtn('minus', 'Minimise to a pill', () => {
      store.set(store.key(view.state), id, { c: 1 });
      view.dispatch({ effects: refreshCodeBlocks.of(null) });
    });
    actions.append(wrapBtn, editBtn, copyBtn, minBtn);
    head.append(lang, count, actions);

    // Body
    const body = document.createElement('div');
    body.className = 'cc-body';
    const pre = document.createElement('pre');
    pre.className = 'cc-pre';
    const codeEl = document.createElement('code');
    pre.appendChild(codeEl);
    body.appendChild(pre);
    renderHighlighted(codeEl, this.code, null);
    loadParser(this.info).then((parser) => {
      if (parser && root.isConnected) renderHighlighted(codeEl, this.code, parser);
      else if (parser) requestAnimationFrame(() => renderHighlighted(codeEl, this.code, parser));
    });

    // Click (without dragging a selection) puts the caret at that spot for editing.
    let down = null;
    body.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY };
    });
    body.addEventListener('mouseup', (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4;
      down = null;
      const sel = window.getSelection();
      if (moved || (sel && !sel.isCollapsed && root.contains(sel.anchorNode))) return; // user is selecting text to copy
      if (e.detail > 1) return;
      const lineEl = e.target.closest && e.target.closest('.cc-line');
      if (!lineEl) return;
      const idx = [...codeEl.children].indexOf(lineEl);
      let col = 0;
      const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      if (caret && lineEl.contains(caret.startContainer)) {
        const r = document.createRange();
        r.setStart(lineEl, 0);
        r.setEnd(caret.startContainer, caret.startOffset);
        col = r.toString().replace(/​/g, '').length;
      }
      placeCaret(Math.max(0, idx), col);
    });

    // Back-to-top button (appears after scrolling down inside the block).
    const top = document.createElement('button');
    top.className = 'cc-top';
    top.title = 'Back to the top of this code';
    top.append(icon('arrow-up', 16));
    top.addEventListener('mousedown', (e) => e.preventDefault());
    top.addEventListener('click', (e) => {
      e.stopPropagation();
      body.scrollTo({ top: 0, behavior: 'smooth' });
    });
    body.addEventListener('scroll', () => root.classList.toggle('cc-scrolled', body.scrollTop > 60), { passive: true });

    root.append(head, body, top);
    return blockBox(root);
  }

  destroy() {}
}

/** Small "done" chip shown on the opening fence while editing raw code. */
class DoneChip extends WidgetType {
  eq() { return true; }
  toDOM(view) {
    const b = document.createElement('button');
    b.className = 'cc-done';
    b.textContent = 'Done';
    b.title = 'Show as a code window again';
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(b);
      const tree = syntaxTree(view.state);
      let node = tree.resolveInner(pos, 1);
      while (node && node.name !== 'FencedCode') node = node.parent;
      const end = node ? view.state.doc.lineAt(node.to) : view.state.doc.lineAt(pos);
      const after = Math.min(end.to + 1, view.state.doc.length);
      if (end.to >= view.state.doc.length) view.dispatch({ changes: { from: end.to, insert: '\n' }, selection: { anchor: end.to + 1 } });
      else view.dispatch({ selection: { anchor: after } });
      view.focus();
    });
    return b;
  }
  ignoreEvent() { return true; }
}

const lineDeco = {
  begin: Decoration.line({ class: 'cm-cb cm-cb-begin' }),
  mid: Decoration.line({ class: 'cm-cb' }),
  end: Decoration.line({ class: 'cm-cb cm-cb-end' }),
  single: Decoration.line({ class: 'cm-cb cm-cb-begin cm-cb-end' }),
};

function build(state) {
  const store = state.facet(codeBlockStore);
  const key = store.key(state);
  const defaults = store.defaults();
  const ranges = [];
  if (state.doc.length > 3_000_000) return Decoration.none;
  const tree = syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return node.name === 'Document' || node.name === 'Blockquote' || node.name === 'ListItem' || node.name === 'BulletList' || node.name === 'OrderedList';
      const startLine = state.doc.lineAt(node.from);
      const endLine = state.doc.lineAt(node.to);
      const marks = node.node.getChildren('CodeMark');
      const closed = marks.length >= 2 && endLine.number > startLine.number;
      const infoNode = node.node.getChild('CodeInfo');
      const info = infoNode ? state.sliceDoc(infoNode.from, infoNode.to) : '';
      const textNode = node.node.getChild('CodeText');
      const code = textNode ? state.sliceDoc(textNode.from, textNode.to) : '';
      const editing = !closed || touches(state, startLine.from, endLine.to);
      if (!editing) {
        const saved = store.get(key, blockId(info, code)) || {};
        const collapsed = saved.c === 1;
        const wrap = saved.w === undefined ? defaults.wrap : saved.w === 1;
        ranges.push(Decoration.replace({ widget: new CodeCard(info, code, collapsed, wrap), block: true }).range(startLine.from, endLine.to));
      } else {
        for (let n = startLine.number; n <= endLine.number; n++) {
          const l = state.doc.line(n);
          const d = startLine.number === endLine.number ? lineDeco.single
            : n === startLine.number ? lineDeco.begin : n === endLine.number && closed ? lineDeco.end : lineDeco.mid;
          ranges.push(d.range(l.from));
        }
        if (closed) ranges.push(Decoration.widget({ widget: new DoneChip(), side: 1 }).range(startLine.to));
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

export const codeBlocks = StateField.define({
  create(state) {
    ensureSyntaxTree(state, Math.min(state.doc.length, 400_000), 80);
    return build(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshCodeBlocks)) ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** True when the cursor is inside a fenced block (raw editing). */
export function inFencedCode(state, pos) {
  let node = syntaxTree(state).resolveInner(pos, -1);
  for (; node; node = node.parent) if (node.name === 'FencedCode') return true;
  return false;
}
