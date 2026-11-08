// "Live preview" in the spirit of Obsidian: markdown is shown formatted and its symbols
// are hidden, except on the line/element the caret is on, so the file stays plain text.

import { ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view';
import { Facet, StateEffect } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { resolveAssetUrl, decodeLink } from '../util.js';
import { parseWiki } from './mdext.js';
import { mountSpine, SPINE_RX } from '../render/spine.js';
import { openMenu } from '../ui/menu.jsx';

/** Hooks the app provides: open links, image menus, the note path, [[name]] lookups. */
export const previewHooks = Facet.define({
  combine: (v) => v[0] || {
    noteKey: () => '', openLink: () => {}, openWiki: () => {}, imageMenu: () => {}, linkMode: () => 'ctrl', maxImage: () => 0,
    resolveWiki: () => null, resolveImage: () => null, noteTitle: () => '', livePreview: () => true, bannerMenu: () => {},
  },
});

/** Dispatched when something outside the text changed (e.g. the list of files for [[links]]). */
export const refreshPreview = StateEffect.define();

const hidden = Decoration.replace({});
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

function touches(state, from, to) {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function lineTouched(state, pos) {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Image captions may use a few HTML tags and **markdown**; everything else is shown as text. */
export function captionHtml(src) {
  let s = esc(src || '');
  s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/&lt;(\/?)(strong|b|em|i|u|s|del|mark|small|sub|sup|code)&gt;/gi, '<$1$2>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-md-bullet';
    s.textContent = '•';
    return s;
  }
  ignoreEvent() { return false; }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'cm-md-check' + (this.checked ? ' checked' : '');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const text = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.toggle' });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-md-hr';
    return s;
  }
}

class ImageWidget extends WidgetType {
  /** link: what the note says (markdown destination or wiki target); wiki: true for ![[ ]] embeds. */
  constructor(link, caption, url, width, wiki) {
    super();
    this.link = link;
    this.caption = caption;
    this.url = url;
    this.width = width;
    this.wiki = wiki;
  }
  eq(o) { return o.url === this.url && o.caption === this.caption && o.width === this.width && o.link === this.link; }
  toDOM(view) {
    const hooks = view.state.facet(previewHooks);
    const fig = document.createElement('span');
    fig.className = 'cm-md-image' + (this.caption ? ' with-caption' : '');
    if (this.url === undefined) {
      // Still looking the file up ([[name]] index loading).
      fig.classList.add('pending');
      return fig;
    }
    if (!this.url) {
      fig.classList.add('broken');
      fig.textContent = /^https?:/i.test(decodeLink(this.link)) ? `🌐 Online image (not loaded, MarkNotes is offline): ${this.link}` : `🖼 Image not found: ${decodeLink(this.link)}`;
      return fig;
    }
    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.caption ? this.caption.replace(/<[^>]*>/g, ' ') : '';
    img.draggable = false;
    img.decoding = 'async';
    const max = this.width || hooks.maxImage();
    // A captioned image is one box (image + caption): the box gets the size limit so it hugs the image.
    if (max > 0) (this.caption ? fig : img).style.maxWidth = `min(100%, ${max}px)`;
    img.addEventListener('load', () => fig.classList.add('loaded'));
    img.addEventListener('error', () => {
      fig.classList.add('broken');
      fig.textContent = `🖼 Image not found: ${decodeLink(this.link)}`;
    });
    fig.appendChild(img);
    if (this.caption) {
      const cap = document.createElement('span');
      cap.className = 'cm-md-caption';
      cap.innerHTML = captionHtml(this.caption);
      fig.appendChild(cap);
    }
    fig.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hooks.imageMenu({ x: e.clientX, y: e.clientY, link: this.link, wiki: this.wiki, url: this.url, pos: view.posAtDOM(fig), view });
    });
    fig.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Click selects the image markdown so it can be edited or deleted.
      view.dispatch({ selection: { anchor: view.posAtDOM(fig) } });
      view.focus();
    });
    return fig;
  }
  ignoreEvent(e) { return e.type !== 'keydown'; }
}

/** ![[model.skel]]: a Spine model to play (render/spine.js); ![[model.skel|700]] makes the viewer 700 px high. */
class SpineWidget extends WidgetType {
  constructor(target, path, pending, height, noteKey) {
    super();
    this.target = target;
    this.path = path;
    this.pending = pending;
    this.height = height;
    this.noteKey = noteKey;
  }
  eq(o) { return o.path === this.path && o.target === this.target && o.pending === this.pending && o.height === this.height && o.noteKey === this.noteKey; }
  get estimatedHeight() { return (this.height || 560) + 16; }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'cm-spine';
    if (this.height) box.style.minHeight = `${this.height}px`;
    if (this.pending) { box.classList.add('pending'); return box; }
    if (!this.path) {
      box.classList.add('broken');
      box.textContent = `🎞 Spine model not found: ${this.target}`;
      return box;
    }
    // What is picked in it (costume, pose, animation, zoom) is kept for this note and model name.
    box._spine = mountSpine(box, { path: this.path, height: this.height || 0, key: this.noteKey, id: this.target });
    box.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.spv-bar')) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY, [
        { label: 'Edit embed', icon: 'code', run: () => { view.dispatch({ selection: { anchor: view.posAtDOM(box) } }); view.focus(); } },
      ]);
    });
    return box;
  }
  destroy(dom) { if (dom._spine) dom._spine.destroy(); }
  ignoreEvent() { return true; }
}

class EmbedNoteWidget extends WidgetType {
  constructor(target, label, path) { super(); this.target = target; this.label = label; this.path = path; }
  eq(o) { return o.target === this.target && o.path === this.path && o.label === this.label; }
  toDOM(view) {
    const a = document.createElement('span');
    a.className = 'cm-md-embed' + (this.path ? '' : ' missing');
    a.textContent = '↪ ' + (this.label || this.target);
    a.title = this.path ? 'Click to open' : 'This note does not exist yet';
    a.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      view.state.facet(previewHooks).openWiki(this.target, this.path);
    });
    return a;
  }
  ignoreEvent() { return true; }
}

function headingLevel(name) {
  const m = /^ATXHeading(\d)$/.exec(name) || /^SetextHeading(\d)$/.exec(name);
  return m ? +m[1] : 0;
}

function build(view) {
  const { state } = view;
  const hooks = state.facet(previewHooks);
  const ranges = [];
  const add = (from, to, deco) => { if (from <= to) ranges.push(deco.range(from, to)); };
  const tree = syntaxTree(state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        const name = node.name;
        if (name === 'FencedCode' || name === 'CodeBlock' || name === 'HTMLBlock' || name === 'CommentBlock' || name === 'Frontmatter') return false;

        const level = headingLevel(name);
        if (level) {
          const line = state.doc.lineAt(node.from);
          ranges.push(Decoration.line({ class: `cm-h cm-h${level}` }).range(line.from));
          if (name.startsWith('ATX') && !lineTouched(state, node.from)) {
            const mark = node.node.getChild('HeaderMark');
            if (mark) {
              let end = mark.to;
              if (state.sliceDoc(end, end + 1) === ' ') end++;
              add(mark.from, end, hidden);
              const marks = node.node.getChildren('HeaderMark');
              if (marks.length > 1) {
                const last = marks[marks.length - 1];
                let start = last.from;
                while (start > node.from && state.sliceDoc(start - 1, start) === ' ') start--;
                add(start, last.to, hidden);
              }
            }
          }
          if (name.startsWith('Setext')) {
            const endLine = state.doc.lineAt(node.to);
            if (endLine.number > line.number) ranges.push(Decoration.line({ class: 'cm-setext-underline' }).range(endLine.from));
          }
          return;
        }

        switch (name) {
          case 'StrongEmphasis':
          case 'Emphasis':
          case 'Strikethrough':
          case 'InlineCode': {
            const cls = name === 'StrongEmphasis' ? 'cm-md-strong' : name === 'Emphasis' ? 'cm-md-em' : name === 'Strikethrough' ? 'cm-md-strike' : 'cm-md-code';
            add(node.from, node.to, Decoration.mark({ class: cls }));
            if (!touches(state, node.from, node.to)) {
              const markName = name === 'InlineCode' ? 'CodeMark' : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark';
              for (const m of node.node.getChildren(markName)) add(m.from, m.to, hidden);
            }
            return;
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const urlNode = node.node.getChild('URL');
            if (marks.length >= 2) {
              const textFrom = marks[0].to;
              const textTo = marks[1].from;
              const url = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : '';
              if (textTo > textFrom) add(textFrom, textTo, Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': url, title: url ? `${url}\n${hooks.linkMode() === 'click' ? 'Click' : 'Ctrl+Click'} to open` : '' } }));
              if (!touches(state, node.from, node.to) && url) {
                add(node.from, textFrom, hidden);
                add(textTo, node.to, hidden);
              }
            }
            return false;
          }
          case 'WikiLink': {
            const inner = state.sliceDoc(node.from + 2, node.to - 2);
            const { target, alias, heading } = parseWiki(inner);
            const res = hooks.resolveWiki(target);
            const label = alias || (heading ? `${target} › ${heading}` : target);
            const cls = 'cm-md-wiki' + (res && !res.path ? ' missing' : '');
            const attrs = { 'data-wiki': target, 'data-path': res && res.path ? res.path : '', title: res && res.path ? 'Click to open' : 'Click to create this note' };
            if (touches(state, node.from, node.to)) {
              add(node.from, node.to, Decoration.mark({ class: cls + ' editing', attributes: attrs }));
            } else {
              const bar = inner.indexOf('|');
              const visibleFrom = bar >= 0 ? node.from + 2 + bar + 1 : node.from + 2;
              add(node.from, visibleFrom, hidden);
              add(node.to - 2, node.to, hidden);
              if (bar < 0 && heading) {
                // [[Note#Heading]] reads as "Note › Heading"
                add(visibleFrom, node.to - 2, Decoration.replace({ widget: new WikiLabel(label, cls, attrs) }));
              } else add(visibleFrom, node.to - 2, Decoration.mark({ class: cls, attributes: attrs }));
            }
            return false;
          }
          case 'WikiEmbed': {
            if (touches(state, node.from, node.to)) {
              add(node.from, node.to, Decoration.mark({ class: 'cm-md-image-src' }));
              return false;
            }
            const inner = state.sliceDoc(node.from + 3, node.to - 2);
            const { target, alias } = parseWiki(inner);
            let width = 0;
            let caption = alias;
            const size = /^(\d{2,4})(?:x\d{2,4})?$/.exec(alias.trim());
            if (size) { width = +size[1]; caption = ''; }
            if (SPINE_RX.test(target)) {
              const res = hooks.resolveWiki(target);
              add(node.from, node.to, Decoration.replace({ widget: new SpineWidget(target, res && res.path, !!(res && res.pending), width, hooks.noteKey()) }));
            } else if (IMG_EXT.test(target)) {
              const url = hooks.resolveImage(target, true);
              add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(target, caption, url, width, true) }));
            } else {
              const res = hooks.resolveWiki(target);
              add(node.from, node.to, Decoration.replace({ widget: new EmbedNoteWidget(target, alias, res && res.path) }));
            }
            return false;
          }
          case 'URL':
          case 'Autolink': {
            const raw = state.sliceDoc(node.from, node.to).replace(/^<|>$/g, '');
            add(node.from, node.to, Decoration.mark({ class: 'cm-md-url', attributes: { 'data-href': raw, title: `${raw}\nCtrl+Click to open` } }));
            return false;
          }
          case 'Image': {
            const urlNode = node.node.getChild('URL');
            const marks = node.node.getChildren('LinkMark');
            const link = urlNode ? state.sliceDoc(urlNode.from, urlNode.to) : '';
            const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : '';
            if (!link) return false;
            let width = 0;
            let caption = alt;
            const m = /\|(\d{2,4})$/.exec(alt);
            if (m) { width = +m[1]; caption = alt.slice(0, m.index); }
            if (!touches(state, node.from, node.to)) {
              const url = resolveAssetUrl(hooks.noteKey(), link);
              add(node.from, node.to, Decoration.replace({ widget: new ImageWidget(link, caption, url, width, false) }));
            } else {
              add(node.from, node.to, Decoration.mark({ class: 'cm-md-image-src' }));
            }
            return false;
          }
          case 'Blockquote': {
            for (let pos = node.from; pos <= node.to;) {
              const line = state.doc.lineAt(pos);
              ranges.push(Decoration.line({ class: 'cm-md-quote' }).range(line.from));
              pos = line.to + 1;
            }
            return;
          }
          case 'QuoteMark':
            add(node.from, node.to, Decoration.mark({ class: 'cm-md-quote-mark' }));
            return;
          case 'ListMark': {
            const parent = node.node.parent && node.node.parent.parent;
            const txt = state.sliceDoc(node.from, node.to);
            if (parent && parent.name === 'BulletList' && /^[-*+]$/.test(txt) && !lineTouched(state, node.from)) {
              const after = state.sliceDoc(node.to, node.to + 4);
              if (/^ \[[ xX]\]/.test(after)) add(node.from, node.to + 1, hidden);
              else add(node.from, node.to, Decoration.replace({ widget: new BulletWidget() }));
            } else add(node.from, node.to, Decoration.mark({ class: 'cm-md-listmark' }));
            return;
          }
          case 'TaskMarker': {
            const checked = /x/i.test(state.sliceDoc(node.from, node.to));
            if (!touches(state, node.from, node.to)) add(node.from, node.to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
            if (checked) {
              const line = state.doc.lineAt(node.from);
              ranges.push(Decoration.line({ class: 'cm-md-task-done' }).range(line.from));
            }
            return;
          }
          case 'HorizontalRule': {
            if (!lineTouched(state, node.from)) add(node.from, node.to, Decoration.replace({ widget: new HrWidget() }));
            else add(node.from, node.to, Decoration.mark({ class: 'cm-md-hr-src' }));
            return;
          }
          case 'Table': {
            for (let pos = node.from; pos <= node.to;) {
              const line = state.doc.lineAt(pos);
              ranges.push(Decoration.line({ class: 'cm-md-table' }).range(line.from));
              pos = line.to + 1;
            }
            return false;
          }
          default:
            return;
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

class WikiLabel extends WidgetType {
  constructor(label, cls, attrs) { super(); this.label = label; this.cls = cls; this.attrs = attrs; }
  eq(o) { return o.label === this.label && o.cls === this.cls && o.attrs['data-path'] === this.attrs['data-path']; }
  toDOM() {
    const s = document.createElement('span');
    s.className = this.cls;
    for (const [k, v] of Object.entries(this.attrs)) s.setAttribute(k, v);
    s.textContent = this.label;
    return s;
  }
  ignoreEvent() { return false; }
}

export const livePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.transactions.some((t) => t.reconfigured || t.effects.some((e) => e.is(refreshPreview)))) {
      this.decorations = build(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

/** Plain .txt files only get clickable web addresses. */
const urlRe = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;

export const plainLinks = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const ranges = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.sliceDoc(from, to);
      urlRe.lastIndex = 0;
      let m;
      while ((m = urlRe.exec(text))) {
        ranges.push(Decoration.mark({ class: 'cm-md-url', attributes: { 'data-href': m[0], title: `${m[0]}\nCtrl+Click to open` } }).range(from + m.index, from + m.index + m[0].length));
      }
    }
    return Decoration.set(ranges, true);
  }
}, { decorations: (v) => v.decorations });

/** Ctrl+Click (or a plain click on rendered links, if enabled) opens links; [[links]] open with a click. */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0) return false;
    const hooks = view.state.facet(previewHooks);
    const wiki = e.target.closest && e.target.closest('[data-wiki]');
    if (wiki) {
      const editing = wiki.classList.contains('editing');
      if (editing && !(e.ctrlKey || e.metaKey)) return false;
      e.preventDefault();
      hooks.openWiki(wiki.getAttribute('data-wiki'), wiki.getAttribute('data-path') || null);
      return true;
    }
    const el = e.target.closest && e.target.closest('[data-href]');
    if (!el) return false;
    const href = el.getAttribute('data-href');
    const rendered = el.classList.contains('cm-md-link');
    const plainClick = rendered && hooks.linkMode() === 'click' && !e.shiftKey && !e.altKey;
    if (e.ctrlKey || e.metaKey || plainClick) {
      const pos = view.posAtDOM(el);
      if (rendered && plainClick && touches(view.state, pos, pos + el.textContent.length)) return false;
      e.preventDefault();
      hooks.openLink(href);
      return true;
    }
    return false;
  },
});
