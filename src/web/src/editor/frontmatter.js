// Front matter as a compact "properties" pill, and the cover banner (Simple Banner style:
// `banner: "![[image.jpg]]"` + `datetime: 2021-05-23`) that fades into the page.

import { StateField } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { previewHooks, refreshPreview } from './livepreview.js';
import { readFrontmatter } from './mdext.js';
import { icon } from './domicons.js';
import { blockBox, onBlockBox } from './blockbox.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** "2021-05-23" → "May 23rd 2021" (the Simple Banner default format). */
export function formatBannerDate(raw) {
  if (!raw) return '';
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(raw).trim());
  if (!m) return String(raw);
  const d = `${MONTHS[+m[2] - 1] || m[2]} ${ordinal(+m[3])} ${m[1]}`;
  return m[4] ? `${d} ${m[4].padStart(2, '0')}:${m[5]}` : d;
}

export function bannerOf(data) {
  return data.banner || data.cover || data.image || data['cover-image'] || data.cover_image || null;
}

class BannerWidget extends WidgetType {
  constructor(url, title, date, y) {
    super();
    this.url = url;
    this.title = title;
    this.date = date;
    this.y = y;
  }
  eq(o) { return o.url === this.url && o.title === this.title && o.date === this.date && o.y === this.y; }
  get estimatedHeight() { return 260; }
  toDOM(view) {
    const hooks = view.state.facet(previewHooks);
    const wrap = document.createElement('div');
    wrap.className = 'cm-banner';
    const frame = document.createElement('div');
    frame.className = 'cm-banner-frame';
    if (this.url) {
      const img = document.createElement('img');
      img.className = 'cm-banner-img';
      img.decoding = 'async';
      img.draggable = false;
      img.src = this.url;
      img.style.objectPosition = `50% ${this.y}%`;
      img.addEventListener('load', () => wrap.classList.add('loaded'));
      img.addEventListener('error', () => wrap.classList.add('missing'));
      frame.appendChild(img);
    } else wrap.classList.add(this.url === undefined ? 'pending' : 'missing'); // undefined: still looking the file up
    if (this.date) {
      const d = document.createElement('div');
      d.className = 'cm-banner-date';
      d.textContent = this.date;
      frame.appendChild(d);
    }
    wrap.appendChild(frame);
    const t = document.createElement('div');
    t.className = 'cm-banner-title';
    t.textContent = this.title;
    wrap.appendChild(t);
    wrap.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hooks.bannerMenu({ x: e.clientX, y: e.clientY });
    });
    wrap.addEventListener('mousedown', (e) => e.preventDefault());
    return blockBox(wrap);
  }
  ignoreEvent(e) { return !onBlockBox(e); }
}

class PropsWidget extends WidgetType {
  constructor(keys, to) { super(); this.keys = keys; this.to = to; }
  eq(o) { return o.keys.join('|') === this.keys.join('|'); }
  toDOM(view) {
    const b = document.createElement('div');
    b.className = 'cm-props';
    const chip = document.createElement('button');
    chip.className = 'cm-props-chip';
    chip.title = 'Note properties (front matter) · click to edit';
    chip.append(icon('settings', 13), document.createTextNode(` ${this.keys.length} propert${this.keys.length === 1 ? 'y' : 'ies'}`));
    const list = document.createElement('span');
    list.className = 'cm-props-keys';
    list.textContent = this.keys.slice(0, 6).join(' · ') + (this.keys.length > 6 ? ' …' : '');
    chip.appendChild(list);
    chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // Put the caret on the first property line to edit the raw YAML.
      const line = view.state.doc.line(Math.min(2, view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.to } });
      view.focus();
    });
    b.appendChild(chip);
    return b;
  }
  ignoreEvent() { return true; }
}

const fmLine = Decoration.line({ class: 'cm-fm-line' });

function build(state) {
  const hooks = state.facet(previewHooks);
  if (!hooks.livePreview()) return Decoration.none;
  const head = state.sliceDoc(0, Math.min(state.doc.length, 24000));
  const fm = readFrontmatter(head);
  if (!fm) return Decoration.none;
  const ranges = [];
  const banner = bannerOf(fm.data);
  if (banner) {
    const y = parseFloat(fm.data.banner_y ?? fm.data['banner-y'] ?? fm.data.banner_position ?? '');
    const pos = isNaN(y) ? 50 : y <= 1 ? Math.round(y * 100) : Math.max(0, Math.min(100, y));
    ranges.push(Decoration.widget({
      widget: new BannerWidget(hooks.resolveImage(banner, false), hooks.noteTitle(), formatBannerDate(fm.data.datetime || fm.data.date), pos),
      block: true,
      side: -1,
    }).range(0));
  }
  const endLine = state.doc.lineAt(Math.max(0, fm.to - 1));
  const editing = state.selection.ranges.some((r) => r.from <= endLine.to && r.to >= 0);
  if (!editing) {
    ranges.push(Decoration.replace({ widget: new PropsWidget(Object.keys(fm.data), fm.to), block: true }).range(0, endLine.to));
  } else {
    for (let n = 1; n <= endLine.number; n++) ranges.push(fmLine.range(state.doc.line(n).from));
  }
  return Decoration.set(ranges, true);
}

export const frontmatterField = StateField.define({
  create: build,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured || tr.effects.some((e) => e.is(refreshPreview))) {
      // Only rebuild when the change can matter (the top of the note or the caret near it).
      if (!tr.docChanged && tr.selection && !tr.reconfigured && !tr.effects.length) {
        const fm = readFrontmatter(tr.state.sliceDoc(0, Math.min(tr.state.doc.length, 24000)));
        if (!fm) return deco;
      }
      return build(tr.state);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Position right after the front matter (where the caret should start). */
export function bodyStart(text) {
  const fm = readFrontmatter(text);
  return fm ? fm.to : 0;
}
