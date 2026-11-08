// Workspace Guide: the workspace's front page (like a Discord "Server Guide"): banner, picture,
// name, and a markdown guide the user writes (what the workspace is for, how it is organised,
// important info). Stored with the workspace info, so opened folders get nothing written into them.

import { useEffect, useRef, useState } from 'preact/hooks';
import { activeWs, currentNotes, toast } from '../store.js';
import { openWiki, openLink, saveImage } from '../docs.js';
import { resolveName } from '../links.js';
import { renderMarkdown } from '../render/markdown.js';
import { Avatar } from './dialogs.jsx';
import { AnimatedImage } from './AnimatedImage.jsx';
import { Icon } from './icons.jsx';
import { fullDate, readFileAsDataUrl } from '../util.js';
import * as api from '../api.js';

const PLACEHOLDER = `# Welcome

Write here what this workspace is for, how it is organised and anything important to remember.

## How it works
- **Folders:** what goes where
- **Naming:** how notes are named

## Important
- …`;

export default function GuideView() {
  const ws = activeWs.value;
  const notes = currentNotes.value;
  const [text, setText] = useState(null); // null while loading
  const [draft, setDraft] = useState(null); // string while editing
  const area = useRef(null);
  const key = ws ? `${ws.dir}/.workspace-guide.md` : '';

  useEffect(() => {
    if (!ws) return;
    let alive = true;
    setText(null);
    setDraft(null);
    api.call('ws.guide', { id: ws.id }).then((t) => alive && setText(t || '')).catch(() => alive && setText(''));
    return () => { alive = false; };
  }, [ws && ws.id]);
  useEffect(() => { if (draft !== null && area.current) area.current.focus(); }, [draft === null]);

  if (!ws) return null;

  const save = async () => {
    try {
      await api.call('ws.setGuide', { id: ws.id, text: draft });
      setText(draft);
      setDraft(null);
      toast('Guide saved', 'success', 1500);
    } catch (e) { toast('Could not save the guide: ' + e.message, 'error'); }
  };
  const insertAtCaret = (snippet) => {
    const el = area.current;
    const v = el.value;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    const next = v.slice(0, a) + snippet + v.slice(b);
    setDraft(next);
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + snippet.length; });
  };
  const onPaste = async (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      try {
        const saved = await saveImage(key, await readFileAsDataUrl(f), f.name && !/^image\.\w+$/i.test(f.name) ? f.name : '');
        insertAtCaret(saved.wiki ? `![[${saved.link}]]\n` : `![](${saved.link})\n`);
      } catch (err) { toast('Could not add the image: ' + err.message, 'error'); }
    }
  };
  const onClick = (e) => {
    const w = e.target.closest('[data-wiki]');
    if (w) {
      e.preventDefault();
      const target = w.getAttribute('data-wiki');
      const r = resolveName(key, target);
      openWiki(target, r.path || null, key);
      return;
    }
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      openLink(a.getAttribute('href'), key);
    }
  };

  const created = ws.created ? Date.parse(ws.created) : 0;
  const color = ws.color || '#5865f2';
  const heroStyle = ws.bannerUrl ? null : { background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 35%, #000))` };

  return (
    <div class="guide-view">
      <div class="guide-inner">
        <div class="guide-hero" style={heroStyle}>
          {ws.bannerUrl ? <AnimatedImage src={ws.bannerUrl} playing={!ws.bannerHover} class="guide-banner" /> : null}
        </div>
        <div class="guide-head">
          <div class="guide-avatar"><Avatar ws={ws} size={96} /></div>
          <h1>{ws.name}</h1>
          <div class="guide-actions">
            {draft !== null ? (
              <>
                <button class="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
                <button class="btn primary" onClick={save}><Icon name="check" size={15} /> Save guide</button>
              </>
            ) : (
              <button class="btn" onClick={() => setDraft(text && text.trim() ? text : PLACEHOLDER)}><Icon name="pencil" size={15} /> Edit guide</button>
            )}
          </div>
        </div>
        <div class="guide-body">
          <div class="guide-main">
            {text === null ? <p class="muted">Loading…</p> : draft !== null ? (
              <>
                <textarea ref={area} class="guide-editor" value={draft} spellcheck={false}
                  onInput={(e) => setDraft(e.currentTarget.value)} onPaste={onPaste}
                  onKeyDown={(e) => {
                    if (e.key === 's' && e.ctrlKey) { e.preventDefault(); e.stopPropagation(); save(); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null); }
                  }} />
                <p class="muted small">Markdown: # headings, **bold**, - lists, [[links to notes]], pasted images. Ctrl+S saves, Esc cancels.</p>
              </>
            ) : text.trim() ? (
              <div class="guide-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text, key) }} />
            ) : (
              <div class="guide-empty">
                <Icon name="signpost" size={28} />
                <p>Write a guide for this workspace: what it is for, how it is organised and the important things to remember.</p>
                <button class="btn primary" onClick={() => setDraft(PLACEHOLDER)}><Icon name="pencil" size={15} /> Write the guide</button>
              </div>
            )}
          </div>
          <aside class="guide-card">
            <div class="guide-card-hero" style={heroStyle}>
              {ws.bannerUrl ? <AnimatedImage src={ws.bannerUrl} playing={false} class="guide-banner" /> : null}
            </div>
            <div class="guide-card-avatar"><Avatar ws={ws} size={52} play={false} /></div>
            <div class="guide-card-name">{ws.name}</div>
            <div class="guide-stats">
              <span><i class="dot" style={{ background: 'var(--success)' }} />{notes.length} note{notes.length === 1 ? '' : 's'}</span>
              <span><i class="dot" />{ws.folders.length} folder{ws.folders.length === 1 ? '' : 's'}</span>
            </div>
            {created ? <div class="muted small">Created {fullDate(created)}</div> : null}
            {ws.linked ? <div class="muted small guide-path" title={ws.root}>{ws.root}</div> : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
