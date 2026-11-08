// Browse Folders: an index of the workspace's folders (like Discord's "Browse Channels") with a
// description for each one. Descriptions live in the folder info, so they follow renames and go
// away with the folder.

import { useMemo, useState } from 'preact/hooks';
import { activeWs, currentNotes, replaceWorkspace, toast } from '../store.js';
import { openFolderView, folderMenu } from '../actions.js';
import { FolderGlyph } from './FolderGlyph.jsx';
import { Icon } from './icons.jsx';
import { relTime } from '../util.js';
import * as api from '../api.js';

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export default function BrowseFolders() {
  const ws = activeWs.value;
  const notes = currentNotes.value;
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null); // folder path
  const [draft, setDraft] = useState('');

  // Notes and last edit per folder, counting subfolders too.
  const stats = useMemo(() => {
    const m = new Map();
    for (const n of notes) {
      let f = n.folder || '';
      while (f) {
        const s = m.get(f) || { count: 0, latest: 0 };
        s.count++;
        if (n.mtime > s.latest) s.latest = n.mtime;
        m.set(f, s);
        f = parentOf(f);
      }
    }
    return m;
  }, [notes]);

  if (!ws) return null;
  const query = q.trim().toLowerCase();
  const match = (f) => !query || f.path.toLowerCase().includes(query) || (f.description || '').toLowerCase().includes(query);
  const folders = ws.folders;
  const tops = folders.filter((f) => !f.path.includes('/'));
  const hasKids = (p) => folders.some((f) => parentOf(f.path) === p);
  const loose = tops.filter((f) => !hasKids(f.path) && match(f));
  const groups = tops.filter((f) => hasKids(f.path))
    .map((top) => ({ top, rows: folders.filter((f) => (f.path === top.path || f.path.startsWith(top.path + '/')) && match(f)) }))
    .filter((g) => g.rows.length);

  const saveDescription = async (f) => {
    setEditing(null);
    if ((f.description || '') === draft.trim()) return;
    try {
      await api.call('folder.setMeta', { wsId: ws.id, name: f.path, description: draft.trim() });
      replaceWorkspace(await api.call('ws.get', { id: ws.id }));
    } catch (e) { toast('Could not save the description: ' + e.message, 'error'); }
  };

  const row = (f, base) => {
    const s = stats.get(f.path) || { count: 0, latest: 0 };
    const label = base && f.path !== base ? f.path.slice(base.length + 1).split('/').join(' › ') : f.name;
    const depth = base && f.path !== base ? f.path.slice(base.length + 1).split('/').length : 0;
    return (
      <div key={f.path} class="bf-row" style={{ paddingLeft: `${14 + depth * 18}px` }}
        onClick={(e) => { if (!e.target.closest('textarea, button')) openFolderView(f.path); }}
        onContextMenu={(e) => { e.preventDefault(); folderMenu(ws.id, f, e.clientX, e.clientY); }}>
        <FolderGlyph icon={f.icon} size={17} style={{ color: f.color || undefined }} />
        <div class="bf-text">
          <div class="bf-name">{label}</div>
          {editing === f.path ? (
            <textarea class="bf-desc-input" rows={2} value={draft} placeholder="What goes in this folder…"
              ref={(el) => el && !el.dataset.f && (el.dataset.f = '1', el.focus(), el.setSelectionRange(el.value.length, el.value.length))}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveDescription(f); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
              }}
              onBlur={() => saveDescription(f)} />
          ) : (
            <div class={'bf-desc' + (f.description ? '' : ' empty')}>{f.description || 'No description'}</div>
          )}
          <div class="bf-meta">{s.count} note{s.count === 1 ? '' : 's'}{s.latest ? ` · edited ${relTime(s.latest)}` : ''}</div>
        </div>
        <button class="icon-btn bf-edit" title={f.description ? 'Edit description' : 'Add a description'}
          onClick={(e) => { e.stopPropagation(); setDraft(f.description || ''); setEditing(f.path); }}>
          <Icon name="pencil" size={15} />
        </button>
      </div>
    );
  };

  return (
    <div class="browse-view">
      <div class="browse-head">
        <Icon name="list-search" size={22} />
        <h1>Browse Folders</h1>
        <span class="muted">{folders.length} folder{folders.length === 1 ? '' : 's'}</span>
      </div>
      <div class="filter-box browse-search">
        <Icon name="search" size={16} />
        <input placeholder="Search folders and descriptions" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {!folders.length ? <p class="muted">This workspace has no folders yet.</p> : null}
      {loose.length ? (
        <section class="bf-group">
          <h2>Folders</h2>
          <div class="bf-list">{loose.map((f) => row(f, null))}</div>
        </section>
      ) : null}
      {groups.map((g) => (
        <section key={g.top.path} class="bf-group">
          <h2>{g.top.name}</h2>
          <div class="bf-list">{g.rows.map((f) => row(f, g.top.path))}</div>
        </section>
      ))}
      {folders.length && !loose.length && !groups.length ? <p class="muted">No folder matches.</p> : null}
    </div>
  );
}
