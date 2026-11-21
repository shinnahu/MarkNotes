// Where live preview shows markdown as text instead of its formatted look: only where the text is being edited.
//  • A note that was just opened looks formatted everywhere, although its caret sits on the first line: the
//    markdown of a line shows once a click, the arrow keys or typing put the caret there.
//  • A selection shows the markdown of what it touches only while it stays inside that line (or block). One that
//    runs past it (dragging over a post card or several paragraphs, Ctrl+A, to copy them) leaves it as it looks.

import { StateField, Annotation } from '@codemirror/state';

/** Marks programmatic changes that must not count as the user's edits (the text reloaded from disk). */
export const Reload = Annotation.define();

/** False while the note was just shown: nothing has moved its caret or changed its text yet. */
export const caretPlaced = StateField.define({
  create: () => false,
  update: (placed, tr) => placed || (!tr.annotation(Reload) && (tr.docChanged || !!tr.selection)),
});

/**
 * Whether the element at [from, to] shows its markdown: the caret is in it (or right next to it), or a selection
 * within its line(s) touches it. Editors without caretPlaced (canvas cards) count the caret as placed.
 */
export function revealed(state, from, to) {
  if (state.field(caretPlaced, false) === false) return false;
  const lo = state.doc.lineAt(from).from;
  const hi = state.doc.lineAt(to).to;
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from && r.from >= lo && r.to <= hi) return true;
  return false;
}
