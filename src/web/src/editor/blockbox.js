// Block widgets (link cards, code windows, tables, the cover) are drawn inside a box that holds their margins.
// CodeMirror measures a block widget with getBoundingClientRect, which leaves margins out: a card with
// `margin: 6px 0` takes 12 px more than the editor counts, so every click and arrow key below it lands
// lower (a whole line lower after two cards). The box (display: flow-root) keeps the margins inside it,
// so what the editor measures is the room the widget takes.

/** The DOM to give CodeMirror for a block widget drawn as `el`. */
export function blockBox(el) {
  const box = document.createElement('div');
  box.className = 'cm-block-box';
  box.appendChild(el);
  return box;
}

/** Events on the box itself (the widget's margins, beside a narrow card) go to the editor, as they did before the box. */
export const onBlockBox = (e) => e.target instanceof Element && e.target.classList.contains('cm-block-box');
