// HTML blocks shown rendered in canvas card editors (Obsidian canvases often start a card with
// <div class="title">…</div> styled by the vault's CSS snippets). The raw HTML comes back while
// the caret is inside the block, like the rest of live preview.

import { StateField } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

class HtmlWidget extends WidgetType {
  constructor(html, from, render) {
    super();
    this.html = html;
    this.from = from;
    this.render = render;
  }

  eq(o) { return o.html === this.html && o.from === this.from; }

  toDOM(view) {
    const d = document.createElement('div');
    d.className = 'cm-html-block markdown-rendered';
    d.innerHTML = this.render(this.html);
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return d;
  }

  ignoreEvent() { return true; }
}

/** render(html) → sanitized HTML (the canvas passes its markdown renderer). */
export function htmlBlocks(render) {
  const build = (state) => {
    const ranges = [];
    syntaxTree(state).iterate({
      enter(node) {
        if (node.name !== 'HTMLBlock') return undefined;
        const from = state.doc.lineAt(node.from).from;
        const endAt = node.to > node.from && state.doc.lineAt(node.to).from === node.to ? node.to - 1 : node.to;
        const to = state.doc.lineAt(endAt).to;
        const touched = state.selection.ranges.some((r) => r.from <= to && r.to >= from);
        if (!touched && to > from) ranges.push(Decoration.replace({ widget: new HtmlWidget(state.sliceDoc(from, to), from, render), block: true }).range(from, to));
        return false;
      },
    });
    return Decoration.set(ranges, true);
  };
  return StateField.define({
    create: build,
    update(deco, tr) {
      return tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? build(tr.state) : deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
