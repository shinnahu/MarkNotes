// Smart paste: images are saved next to the notes; code becomes a code window.
// The code wrapping is a separate undo step, so one Ctrl+Z turns it back into plain text.

import { EditorView } from '@codemirror/view';
import { Facet } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { detectCode, clipboardLanguage } from './detect.js';
import { inFencedCode } from './codeblocks.js';
import { insertBlock } from './commands.js';
import { spreadsheetRows, rowsToMarkdown } from './tables.js';
import { htmlTablesToMarkdown, rtfTablesToMarkdown } from './tablepaste.js';
import { hasTable, markdownToHtml } from './tablemd.js';

export const pasteHooks = Facet.define({
  combine: (v) => v[0] || {
    isMarkdown: () => true,
    autoCode: () => true,
    saveImage: async () => null,
    toast: () => {},
    dropFiles: async () => false,
    plainNext: { value: false },
  },
});

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export async function insertImageFiles(view, files) {
  const hooks = view.state.facet(pasteHooks);
  const links = [];
  for (const f of files) {
    try {
      const data = await readAsDataUrl(f);
      const name = f.name && !/^image\.\w+$/i.test(f.name) ? f.name : '';
      const saved = await hooks.saveImage(data, name);
      // Obsidian vaults get Obsidian-style embeds; everything else standard markdown.
      if (saved) links.push(saved.wiki ? `![[${saved.link}]]` : `![](${saved.link})`);
    } catch (e) {
      hooks.toast('Could not save the image: ' + e.message, 'error');
    }
  }
  if (links.length) insertBlock(view, links.join('\n'));
}

function pasteAsCode(view, text, lang) {
  text = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const { state } = view;
  const r = state.selection.main;
  // Step 1: the plain paste (its own undo step).
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: text },
    selection: { anchor: r.from + text.length },
    userEvent: 'input.paste',
    scrollIntoView: true,
  });
  // Step 2: turn it into a fenced block.
  const s2 = view.state;
  const from = r.from;
  const to = r.from + text.length;
  const line = s2.doc.lineAt(from);
  const endLine = s2.doc.lineAt(to);
  const pre = from > line.from ? '\n' : '';
  const restOfLine = s2.sliceDoc(to, endLine.to);
  const post = restOfLine.length ? '\n' : to >= s2.doc.length ? '\n' : '';
  const fence = text.includes('```') ? '~~~~' : '```';
  const open = pre + fence + (lang || '') + '\n';
  const close = '\n' + fence + post;
  const endPos = to + open.length + close.length;
  // Leave the caret below the block so it shows as a code window right away.
  const anchor = post === '' ? Math.min(endPos + 1, s2.doc.length + open.length + close.length) : endPos;
  view.dispatch({
    changes: [{ from, insert: open }, { from: to, insert: close }],
    selection: { anchor },
    annotations: isolateHistory.of('before'),
    userEvent: 'input.paste.code',
    scrollIntoView: true,
  });
}

/**
 * A table pasted from Excel / Google Sheets, Word or WordPad becomes markdown (one Ctrl+Z gives back the plain
 * text): md is that markdown.
 */
function pasteAsTable(view, text, md0) {
  const plain = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const r = view.state.selection.main;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: plain },
    selection: { anchor: r.from + plain.length },
    userEvent: 'input.paste',
    scrollIntoView: true,
  });
  const s = view.state;
  const from = r.from;
  const to = r.from + plain.length;
  const first = s.doc.lineAt(from);
  const last = s.doc.lineAt(to);
  // A table needs its own lines with blank lines around it.
  const pre = from > first.from ? '\n\n' : first.number > 1 && s.doc.line(first.number - 1).text.trim() ? '\n' : '';
  const restOfLine = s.sliceDoc(to, last.to);
  const post = restOfLine.trim() ? '\n\n' : last.number < s.doc.lines && s.doc.line(last.number + 1).text.trim() ? '\n' : '';
  const md = pre + md0 + post;
  view.dispatch({
    changes: { from, to, insert: md },
    selection: { anchor: from + md.length - post.length },
    annotations: isolateHistory.of('before'),
    userEvent: 'input.paste.table',
    scrollIntoView: true,
  });
}

/** Paste from the right-click menu (no clipboard event available there). */
export async function pasteFromClipboard(view, { plain = false } = {}) {
  const hooks = view.state.facet(pasteHooks);
  try {
    if (!plain && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type && !it.types.includes('text/plain')) {
          const blob = await it.getType(type);
          if (hooks.isMarkdown()) insertImageFiles(view, [new File([blob], 'image.png', { type })]);
          return;
        }
      }
    }
    const text = (await navigator.clipboard.readText()).replace(/\r\n?/g, '\n');
    if (!text) return;
    if (!plain && hooks.isMarkdown() && !inFencedCode(view.state, view.state.selection.main.from)) {
      const rows = spreadsheetRows(text, '');
      let md = rows ? rowsToMarkdown(rows) : null;
      if (!md && navigator.clipboard.read) {
        // The right-click Paste: a Word / web page table comes as HTML.
        for (const it of await navigator.clipboard.read()) {
          if (it.types.includes('text/html')) md = htmlTablesToMarkdown(await (await it.getType('text/html')).text());
          if (md) break;
        }
      }
      if (md) {
        pasteAsTable(view, text, md);
        hooks.toast('Pasted as a table · Ctrl+Z keeps it as plain text', 'info', 3500);
        return;
      }
    }
    if (!plain && hooks.isMarkdown() && hooks.autoCode() && !inFencedCode(view.state, view.state.selection.main.from)) {
      const d = detectCode(text);
      if (d) {
        pasteAsCode(view, text, d.lang);
        hooks.toast('Pasted as a code block · Ctrl+Z keeps it as plain text', 'info', 3500);
        return;
      }
    }
    view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste', scrollIntoView: true });
  } catch (e) {
    hooks.toast('Could not read the clipboard: ' + e.message, 'error');
  }
}

export const smartPaste = EditorView.domEventHandlers({
  copy(event, view) {
    // Copied text with a table: other apps (Word, Excel, Google Sheets) get it as a real table too; plain-text
    // apps still get the markdown.
    const dt = event.clipboardData;
    const ranges = view.state.selection.ranges.filter((r) => !r.empty);
    if (!dt || !ranges.length) return false;
    const text = ranges.map((r) => view.state.sliceDoc(r.from, r.to)).join('\n');
    if (!hasTable(text)) return false;
    dt.setData('text/plain', text);
    dt.setData('text/html', markdownToHtml(text));
    event.preventDefault();
    return true;
  },

  paste(event, view) {
    const hooks = view.state.facet(pasteHooks);
    const dt = event.clipboardData;
    if (!dt) return false;
    const plain = hooks.plainNext.value;
    hooks.plainNext.value = false;

    const images = [...dt.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    const text = dt.getData('text/plain');
    if (images.length && !text) {
      event.preventDefault();
      if (!hooks.isMarkdown()) {
        hooks.toast('Images can only be pasted into .md notes', 'warning');
        return true;
      }
      insertImageFiles(view, images);
      return true;
    }
    if (!text || plain) {
      if (plain && text) {
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(text.replace(/\r\n?/g, '\n')), { userEvent: 'input.paste' });
        return true;
      }
      return false;
    }
    if (!hooks.isMarkdown()) return false;
    if (inFencedCode(view.state, view.state.selection.main.from)) return false;
    const html = dt.getData('text/html');
    const rows = spreadsheetRows(text, html);
    // Excel / Sheets: tab-separated text. Word, Outlook, web pages: an HTML table. WordPad: an RTF table.
    const md = rows ? rowsToMarkdown(rows) : htmlTablesToMarkdown(html) || rtfTablesToMarkdown(dt.getData('text/rtf'));
    if (md) {
      event.preventDefault();
      pasteAsTable(view, text, md);
      hooks.toast('Pasted as a table · Ctrl+Z keeps it as plain text', 'info', 3500);
      return true;
    }
    if (!hooks.autoCode()) return false;

    const hint = clipboardLanguage(dt);
    let lang = null;
    if (hint && hint.plain) return false;
    if (hint && hint.sure) {
      if (!text.includes('\n') && text.length < 120) return false; // single short line: keep inline
      lang = hint.lang || '';
    } else {
      const d = detectCode(text);
      if (!d) return false;
      lang = d.lang;
    }
    event.preventDefault();
    pasteAsCode(view, text, lang);
    hooks.toast('Pasted as a code block · Ctrl+Z keeps it as plain text', 'info', 3500);
    return true;
  },

  drop(event, view) {
    const hooks = view.state.facet(pasteHooks);
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return false;
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    event.preventDefault();
    if (images.length && hooks.isMarkdown()) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) view.dispatch({ selection: { anchor: pos } });
      insertImageFiles(view, images);
    }
    if (others.length) hooks.dropFiles(others);
    return true;
  },
});
