import { useRef, useState } from 'preact/hooks';
import { workspaces, activeWsId, tabsByWs, ui, saveState } from '../store.js';
import { switchWorkspace } from '../docs.js';
import { createWorkspace, workspaceMenu, moveWorkspace, moveNote } from '../actions.js';
import { Avatar, gifPlays } from './dialogs.jsx';
import { Icon } from './icons.jsx';
import { tipProps } from './Toasts.jsx';
import { openQuickSwitcher } from './QuickSwitcher.jsx';
import { findNote } from '../store.js';

export function toggleRail() {
  ui.value = { ...ui.value, railCollapsed: !ui.value.railCollapsed };
  saveState();
}

/** While the workspace column is hidden: moving the pointer to the left edge shows a button to bring it back. */
export function RailReveal() {
  const [show, setShow] = useState(false);
  const timer = useRef(0);
  const open = () => { clearTimeout(timer.current); setShow(true); };
  const close = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setShow(false), 500); };
  return (
    <>
      <div class="rail-hot" onMouseEnter={open} onMouseLeave={close} />
      <button class={'rail-reveal' + (show ? ' show' : '')} onMouseEnter={open} onMouseLeave={close}
        onClick={() => { setShow(false); toggleRail(); }} {...tipProps('Show workspaces (Ctrl+Shift+\\)')}>
        <Icon name="chevron-right" size={16} />
      </button>
    </>
  );
}

export function Rail() {
  const list = workspaces.value;
  const active = activeWsId.value;
  const [dropAt, setDropAt] = useState(null);
  const [hoverId, setHoverId] = useState(null);

  return (
    <nav class="rail" aria-label="Workspaces">
      <button class="rail-item home" {...tipProps('Find any note (Ctrl+K)')} onClick={() => openQuickSwitcher()}>
        <span class="rail-search"><Icon name="search" size={24} /></span>
      </button>
      <div class="rail-sep" />
      <div class="rail-list"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-mn-ws')) e.preventDefault(); }}>
        {list.map((w, i) => {
          const dirty = (tabsByWs.value[w.id] || []).some((t) => t.dirty);
          return (
            <div key={w.id} class={'rail-item' + (w.id === active ? ' active' : '') + (dropAt === i ? ' drop-before' : '')}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData('application/x-mn-ws', w.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => {
                const t = e.dataTransfer.types;
                if (t.includes('application/x-mn-ws') || t.includes('application/x-mn-note')) {
                  e.preventDefault();
                  setDropAt(t.includes('application/x-mn-ws') ? i : null);
                  e.currentTarget.classList.toggle('drop-target', t.includes('application/x-mn-note'));
                }
              }}
              onDragLeave={(e) => { setDropAt(null); e.currentTarget.classList.remove('drop-target'); }}
              onDrop={(e) => {
                e.preventDefault();
                e.currentTarget.classList.remove('drop-target');
                setDropAt(null);
                const wsId = e.dataTransfer.getData('application/x-mn-ws');
                const notePath = e.dataTransfer.getData('application/x-mn-note');
                if (wsId) moveWorkspace(wsId, i);
                else if (notePath) {
                  const n = findNote(notePath);
                  if (n && n.wsId !== w.id) moveNote(n, null, w.id);
                }
              }}
              onMouseEnter={(e) => { setHoverId(w.id); tipProps(w.name).onMouseEnter(e); }}
              onMouseLeave={(e) => { setHoverId((h) => (h === w.id ? null : h)); tipProps(w.name).onMouseLeave(e); }}
              onMouseDown={(e) => tipProps(w.name).onMouseDown(e)}
              onClick={() => switchWorkspace(w.id)}
              onContextMenu={(e) => { e.preventDefault(); workspaceMenu(w, e.clientX, e.clientY); }}>
              <span class="rail-pill" />
              <Avatar ws={w} size={48} play={gifPlays(w.id === active, hoverId === w.id)} />
              {dirty ? <span class="rail-badge" title="Saving changes" /> : null}
            </div>
          );
        })}
        <button class="rail-item add" onClick={createWorkspace} {...tipProps('Create, open or import a workspace')}>
          <span class="ws-avatar add-avatar"><Icon name="plus" size={24} /></span>
        </button>
      </div>
    </nav>
  );
}
