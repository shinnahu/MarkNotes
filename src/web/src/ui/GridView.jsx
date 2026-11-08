import { useEffect, useRef, useState } from 'preact/hooks';
import { mainView, activeWs, currentNotes, settings, setSetting, persisted, saveState } from '../store.js';
import { openNote, newNote, newKanban, newCanvas } from '../docs.js';
import { noteMenu, togglePin, editFolder, createFolder, folderMenu, openFolderView } from '../actions.js';
import { sortNotes, KIND_ICON } from './Sidebar.jsx';
import { Icon } from './icons.jsx';
import { FolderGlyph } from './FolderGlyph.jsx';
import { relTime, fullDate, hash } from '../util.js';
import { tipProps } from './Toasts.jsx';
import { formatBannerDate } from '../editor/frontmatter.js';

/** Note text → a light preview (code shown in monospace, Obsidian syntax reduced to plain text). */
function Preview({ text, kind }) {
  if (kind === 'canvas') return <div class="card-preview empty"><Icon name="canvas" size={14} /> Canvas</div>;
  if (!text) return <div class="card-preview empty">Empty note</div>;
  const out = [];
  let inCode = false;
  let lines = 0;
  for (const raw of text.replace(/\r/g, '').replace(/%%[\s\S]*?(%%|$)/g, '').split('\n')) {
    if (lines >= 9) break;
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (!line.trim() && !inCode) continue;
    if (inCode) out.push(<div key={out.length} class="pv-code">{line || ' '}</div>);
    else {
      // Images are dropped (the card shows the cover); the preview may end inside an embed.
      let t = line
        .replace(/!\[\[[^\]]*(\]\]|$)/g, '').replace(/!\[[^\]]*\]\([^)]*(\)|$)/g, '')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
        .replace(/[*_~`]+/g, '').replace(/==/g, '');
      if (!t.trim()) continue;
      const h = /^\s*(#{1,6})\s+/.exec(t);
      if (h) t = t.slice(h[0].length);
      t = t.replace(/^\s*[-*+]\s+\[[ ]\]\s*/, '☐ ').replace(/^\s*[-*+]\s+\[[xX]\]\s*/, '☑ ').replace(/^\s*[-*+]\s+/, '• ').replace(/^>\s?/, '│ ');
      out.push(<div key={out.length} class={h ? 'pv-h' : 'pv-line'}>{t}</div>);
    }
    lines++;
  }
  return <div class="card-preview">{out}</div>;
}

/** Cover image that fades in once loaded (thumbnails come from the host, cached on disk). */
function CoverImg({ src, class: cls }) {
  const [state, setState] = useState('loading');
  useEffect(() => setState('loading'), [src]);
  if (state === 'error') return null;
  return (
    <img class={(cls || '') + ' fade-img' + (state === 'loaded' ? ' loaded' : '')} src={src} alt="" loading="lazy" decoding="async" draggable={false}
      onLoad={() => setState('loaded')} onError={() => setState('error')} />
  );
}

const PAGE = 120;

/** Renders lists in pages as the user scrolls, so folders with thousands of notes open instantly. */
function useIncremental(resetKey) {
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef(null);
  useEffect(() => setLimit(PAGE), [resetKey]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE * 2);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  });
  return [limit, sentinel];
}

/** Where the chosen layout is remembered: per workspace (default) or one for all workspaces. */
export function layoutKey(wsId) {
  return settings.value.gridLayoutScope === 'all' ? '*' : wsId;
}

export function setGridLayout(wsId, layout) {
  persisted.gridLayouts = { ...(persisted.gridLayouts || {}), [layoutKey(wsId)]: layout };
  saveState();
}

function placeholderStyle(n) {
  const h = n.color ? null : parseInt(hash(n.title), 36) % 360;
  return n.color
    ? { background: `linear-gradient(135deg, ${n.color}, color-mix(in srgb, ${n.color} 45%, #000))` }
    : { background: `linear-gradient(135deg, hsl(${h} 45% 38%), hsl(${(h + 40) % 360} 50% 22%))` };
}

export function GridView() {
  const v = mainView.value;
  const ws = activeWs.value;
  const all = currentNotes.value;
  const [filter, setFilter] = useState('');
  const lk = ws ? layoutKey(ws.id) : '';
  const [limit, sentinel] = useIncremental(`${lk}|${v.kind}|${v.folder || ''}|${filter}`);
  if (!ws) return null;

  let title, icon, notes, folder = null, crumbs = null, subfolders = [];
  if (v.kind === 'folder') {
    const path = v.folder || '';
    folder = ws.folders.find((f) => f.path === path) || { path, name: path.split('/').pop() || ws.name };
    title = path ? folder.name : ws.name;
    icon = folder.icon || null;
    notes = all.filter((n) => (n.folder || '') === path);
    const parts = path ? path.split('/') : [];
    crumbs = parts.slice(0, -1).map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
    const depth = parts.length;
    subfolders = ws.folders.filter((f) => {
      const segs = f.path.split('/');
      return segs.length === depth + 1 && (!path || f.path.toLowerCase().startsWith(path.toLowerCase() + '/'));
    });
  } else if (v.kind === 'recent') {
    title = 'Recent';
    const recentKeys = persisted.recent || [];
    const byPath = new Map(all.map((n) => [n.path, n]));
    const opened = recentKeys.map((k) => byPath.get(k)).filter(Boolean);
    const latest = all.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    const seen = new Set();
    notes = [...opened, ...latest].filter((n) => (seen.has(n.path) ? false : seen.add(n.path))).slice(0, 48);
  } else {
    title = 'All notes';
    notes = all;
  }
  const q = filter.trim().toLowerCase();
  if (q) notes = notes.filter((n) => n.title.toLowerCase().includes(q) || (n.preview || '').toLowerCase().includes(q));
  const sorted = v.kind === 'recent' ? notes : sortNotes(notes, settings.value.gridSort);

  // Layout: what the user picked for this workspace (or for all, see Settings), else covers when most notes have one.
  const layouts = persisted.gridLayouts || {};
  let layout = layouts[lk];
  if (!layout) {
    const withCover = notes.filter((n) => n.cover).length;
    layout = notes.length >= 3 && withCover / notes.length >= 0.6 ? 'covers' : 'grid';
  }
  const setLay = (l) => {
    setGridLayout(ws.id, l);
    mainView.value = { ...v };
  };
  const shown = sorted.slice(0, limit);
  const more = sorted.length > shown.length;
  const inFolder = v.kind === 'folder' ? v.folder || '' : null;

  const cardProps = (n) => ({
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.setData('application/x-mn-note', n.path); e.dataTransfer.effectAllowed = 'move'; },
    onClick: () => openNote(n.path),
    onContextMenu: (e) => { e.preventDefault(); noteMenu(n, e.clientX, e.clientY); },
  });
  const folderChip = (n) => (v.kind !== 'folder' && n.folder ? <span class="chip" title={n.folder}>{n.folder.split('/').pop()}</span> : null);

  return (
    <div class="grid-view">
      <div class="grid-head">
        <div class="grid-title">
          {v.kind === 'folder'
            ? <FolderGlyph icon={icon} open size={22} class="folder-glyph big" style={{ color: folder.color || undefined }} />
            : <Icon name={v.kind === 'recent' ? 'clock' : 'grid'} size={22} />}
          <div class="grid-title-text">
            {crumbs && (crumbs.length || v.folder) ? (
              <div class="grid-crumbs">
                <button onClick={() => openFolderView('')}>{ws.name}</button>
                {crumbs.map((c) => [<Icon key={'s' + c.path} name="chevron-right" size={12} />, <button key={c.path} onClick={() => openFolderView(c.path)}>{c.name}</button>])}
              </div>
            ) : null}
            <h1>{title}</h1>
          </div>
          <span class="muted">{sorted.length} note{sorted.length === 1 ? '' : 's'}</span>
          {v.kind === 'folder' && v.folder ? (
            <button class="icon-btn" onClick={() => editFolder(ws.id, folder)} {...tipProps('Edit folder', 'below')}><Icon name="pencil" size={16} /></button>
          ) : null}
        </div>
        <div class="grid-tools">
          <div class="filter-box">
            <Icon name="search" size={15} />
            <input placeholder="Filter…" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
          </div>
          {v.kind !== 'recent' ? (
            <select class="select" value={settings.value.gridSort} onChange={(e) => setSetting('gridSort', e.currentTarget.value)}>
              <option value="modified">Last edited</option>
              <option value="created">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name</option>
            </select>
          ) : null}
          <div class="seg">
            <button class={layout === 'grid' ? 'on' : ''} onClick={() => setLay('grid')} {...tipProps('Cards', 'below')}><Icon name="grid" size={16} /></button>
            <button class={layout === 'covers' ? 'on' : ''} onClick={() => setLay('covers')} {...tipProps('Covers (cover image + title)', 'below')}><Icon name="gallery" size={16} /></button>
            <button class={layout === 'wide' ? 'on' : ''} onClick={() => setLay('wide')} {...tipProps('Wide covers (one per row)', 'below')}><Icon name="banners" size={16} /></button>
            <button class={layout === 'list' ? 'on' : ''} onClick={() => setLay('list')} {...tipProps('List', 'below')}><Icon name="list" size={16} /></button>
          </div>
          <button class="btn primary" onClick={() => newNote({ folder: inFolder })}>
            <Icon name="plus" size={16} /> New note
          </button>
        </div>
      </div>

      {subfolders.length ? (
        <div class="subfolders">
          {subfolders.map((f) => (
            <button key={f.path} class="subfolder" onClick={() => openFolderView(f.path)}
              onContextMenu={(e) => { e.preventDefault(); folderMenu(ws.id, f, e.clientX, e.clientY); }}>
              <FolderGlyph icon={f.icon} size={16} style={{ color: f.color || undefined }} />
              <span class="subfolder-name">{f.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      {sorted.length === 0 ? (
        <div class="grid-empty">
          <p class="muted">{q ? 'No notes match the filter.' : 'Nothing here yet.'}</p>
          {!q ? (
            <div class="empty-actions">
              <button class="btn" onClick={() => newNote({ folder: inFolder })}><Icon name="file-plus" size={15} /> Note</button>
              <button class="btn" onClick={() => newKanban({ folder: inFolder })}><Icon name="kanban" size={15} /> Kanban board</button>
              <button class="btn" onClick={() => newCanvas({ folder: inFolder })}><Icon name="canvas" size={15} /> Canvas</button>
              {v.kind === 'all' && ws.folders.length === 0 ? <button class="btn" onClick={() => createFolder(ws.id)}><Icon name="folder-plus" size={15} /> Folder</button> : null}
            </div>
          ) : null}
        </div>
      ) : layout === 'covers' || layout === 'wide' ? (
        <div class={layout === 'wide' ? 'cover-list' : 'cover-grid'}>
          {shown.map((n) => (
            <div key={n.path} class={'cover-tile' + (n.cover ? '' : ' no-cover')} {...cardProps(n)} title={n.title}>
              {n.cover ? <CoverImg src={n.cover} class="cover-img" /> : <div class="cover-ph" style={placeholderStyle(n)}><Icon name={KIND_ICON[n.kind] || 'file-text'} size={28} /></div>}
              {n.date ? <span class="cover-date">{formatBannerDate(n.date)}</span> : null}
              {n.pinned ? <span class="cover-pin"><Icon name="pin" size={13} /></span> : null}
              <div class="cover-title"><span>{n.title}</span></div>
            </div>
          ))}
        </div>
      ) : layout === 'grid' ? (
        <div class="cards">
          {shown.map((n) => (
            <div key={n.path} class={'card' + (n.cover ? ' has-cover' : '')} style={n.color ? { '--card-color': n.color } : null} {...cardProps(n)}>
              {n.color ? <div class="card-bar" /> : null}
              {n.cover ? <div class="card-cover"><CoverImg src={n.cover} /></div> : null}
              <div class="card-title">
                {KIND_ICON[n.kind] ? <Icon name={KIND_ICON[n.kind]} size={15} class="card-kind" /> : null}
                <span>{n.title}</span>
                <button class={'card-pin' + (n.pinned ? ' on' : '')} title={n.pinned ? 'Unpin' : 'Pin to top'}
                  onClick={(e) => { e.stopPropagation(); togglePin(n); }}>
                  <Icon name="pin" size={14} />
                </button>
              </div>
              <Preview text={n.preview} kind={n.kind} />
              <div class="card-foot">
                {folderChip(n)}
                <span class="muted" title={`Edited ${fullDate(n.mtime)}\nCreated ${fullDate(n.ctime)}`}>{n.date ? formatBannerDate(n.date) : relTime(n.mtime)}</span>
                {n.ext === 'txt' ? <span class="chip ext">TXT</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div class="list-rows">
          {shown.map((n) => (
            <div key={n.path} class="list-row" {...cardProps(n)}>
              {KIND_ICON[n.kind] ? <Icon name={KIND_ICON[n.kind]} size={14} /> : <span class="note-dot" style={{ background: n.color || 'transparent', borderColor: n.color || undefined }} />}
              {n.pinned ? <Icon name="pin" size={13} /> : null}
              <span class="list-title">{n.title}</span>
              <span class="list-snippet">{(n.preview || '').replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a).replace(/[#*_>`~=-]+/g, ' ').replace(/\s+/g, ' ').slice(0, 140)}</span>
              {folderChip(n)}
              <span class="muted list-date">{relTime(n.mtime)}</span>
            </div>
          ))}
        </div>
      )}
      {more ? <div ref={sentinel} class="grid-more muted">Loading more… ({sorted.length - shown.length} left)</div> : null}
    </div>
  );
}
