// A web link alone on its line shows as a preview card, like a Discord embed: pages with their title
// and picture, YouTube videos and X posts that play right in the note (render/embeds.js). The raw URL
// comes back while the caret is on the line.

import { StateField } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { previewHooks, refreshPreview } from './livepreview.js';
import { getPreview, refreshLinkPreview, syncPreviews, linkPreviewsOn } from '../previews.js';
import { renderEmbed, injectEmbedCss, isTweetUrl, youTubeId, hostOf } from '../render/embeds.js';
import { openMenu } from '../ui/menu.jsx';
import { blockBox, onBlockBox } from './blockbox.js';

injectEmbedCss();

const SKIP = new Set(['FencedCode', 'CodeBlock', 'Table', 'Frontmatter', 'HTMLBlock', 'Blockquote', 'BulletList', 'OrderedList', 'CommentBlock']);
const ALONE = /^<?(https?:\/\/[^\s<>]+?)>?$|^\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)$/;


class LinkCard extends WidgetType {
  constructor(url) { super(); this.url = url; }
  eq(o) { return o.url === this.url; }
  get estimatedHeight() { return isTweetUrl(this.url) ? 560 : youTubeId(this.url) ? 400 : 96; }
  toDOM(view) {
    const hooks = view.state.facet(previewHooks);
    const doc = hooks.noteKey();
    const url = this.url;
    const card = document.createElement('div');
    const kind = isTweetUrl(url) ? 'tweet' : youTubeId(url) ? 'yt' : 'page';
    card.className = `cm-linkcard loading ${kind}`;
    const site = document.createElement('div');
    site.className = 'mn-site';
    site.textContent = hostOf(url);
    const title = document.createElement('div');
    title.className = 'mn-title';
    title.textContent = url;
    card.append(site, title);

    getPreview(url, doc).then((info) => {
      card.classList.remove('loading');
      renderEmbed(card, info, url, { openLink: (u) => hooks.openLink(u), onResize: () => view.requestMeasure() });
      if (!info || info.failed) card.classList.add('plain');
      view.requestMeasure();
    });

    // Pages open with a click; videos play in place (their own buttons), links inside open the browser.
    card.addEventListener('click', (e) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      if (e.target.closest('.mn-play, video, audio, iframe, .mn-media.video, .mn-grid')) return;
      if (kind === 'page' || card.classList.contains('plain')) hooks.openLink(url);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY, [
        { label: 'Open in browser', icon: 'external', run: () => hooks.openLink(url) },
        { label: 'Edit link', icon: 'pencil', run: () => { const pos = view.posAtDOM(card); view.dispatch({ selection: { anchor: view.state.doc.lineAt(pos).to } }); view.focus(); } },
        { label: 'Copy link', icon: 'copy', run: () => navigator.clipboard.writeText(url) },
        { label: 'Reload preview', icon: 'refresh', run: () => refreshLinkPreview(url, doc).then(() => view.dispatch({ effects: refreshPreview.of(null) })) },
      ]);
    });
    return blockBox(card);
  }
  ignoreEvent(e) { return !onBlockBox(e); }
}

function build(state) {
  const hooks = state.facet(previewHooks);
  if (!hooks.livePreview() || !linkPreviewsOn()) return Decoration.none;
  const ranges = [];
  const urls = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (SKIP.has(node.name)) return false;
      if (node.name !== 'Paragraph') return undefined;
      const line = state.doc.lineAt(node.from);
      if (node.to > line.to) return false; // only single-line paragraphs
      const m = ALONE.exec(state.sliceDoc(node.from, node.to).trim());
      if (!m) return false;
      const url = m[1] || m[2];
      urls.push(url);
      const editing = state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
      if (!editing) ranges.push(Decoration.replace({ widget: new LinkCard(url), block: true }).range(line.from, line.to));
      return false;
    },
  });
  // Only a fully parsed note can say which links it no longer uses.
  if (syntaxTreeAvailable(state, state.doc.length)) syncPreviews(hooks.noteKey(), urls);
  return Decoration.set(ranges, true);
}

export const linkCardField = StateField.define({
  create: build,
  update(deco, tr) {
    // Also when the parser catches up after an edit: only then the note's links are known for sure.
    if (tr.docChanged || tr.selection || tr.reconfigured || tr.effects.some((e) => e.is(refreshPreview)) ||
        syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
