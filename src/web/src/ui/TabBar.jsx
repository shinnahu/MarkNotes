import { useEffect, useRef, useState } from 'preact/hooks';
import { currentTabs, activeKey, activeWsId, mainView, ui } from '../store.js';
import { activateTab, closeTab, closeAllTabs, newNote, moveTab, reopenClosedTab, closeUntouchedTabs } from '../docs.js';
import { tabMenu, renameNote } from '../actions.js';
import { findNote } from '../store.js';
import { Icon } from './icons.jsx';
import { openMenu } from './menu.jsx';
import { tipProps } from './Toasts.jsx';
import { toggleSidebar, recordingInto } from './Sidebar.jsx';
import { toggleRail } from './Rail.jsx';

export function TabBar() {
  const tabs = currentTabs.value;
  const active = activeKey.value;
  const editorShown = mainView.value.kind === 'editor';
  const scroller = useRef(null);
  const [dropIdx, setDropIdx] = useState(null);

  useEffect(() => {
    const el = scroller.current && scroller.current.querySelector('.tab.active');
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const onWheel = (e) => {
    if (!scroller.current) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      scroller.current.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  };

  const listMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.right, r.bottom + 4, [
      { title: `${tabs.length} open tab${tabs.length === 1 ? '' : 's'}` },
      ...tabs.slice(0, 60).map((t) => ({ label: t.title + (t.dirty ? ' •' : ''), icon: t.key === active ? 'check' : t.external ? 'external' : 'file-text', run: () => activateTab(t.key) })),
      tabs.length > 60 ? { label: `…and ${tabs.length - 60} more (use Ctrl+K to find them)`, disabled: true } : null,
      { sep: true },
      { label: 'Reopen closed tab', icon: 'undo', hint: 'Ctrl+Shift+T', run: reopenClosedTab },
      { label: 'Close untouched tabs', icon: 'x', run: () => closeUntouchedTabs() },
      { label: 'Close all tabs', icon: 'close-all', hint: 'Ctrl+Shift+W', danger: true, run: () => closeAllTabs() },
    ], { anchorRight: true, minWidth: 260 });
  };

  return (
    <div class="tabbar">
      <button class={'tb-btn' + (ui.value.railCollapsed ? ' on' : '')} onClick={toggleRail}
        {...tipProps(ui.value.railCollapsed ? 'Show workspaces (Ctrl+Shift+\\)' : 'Hide workspaces (Ctrl+Shift+\\)', 'below')}>
        <Icon name="rail" size={18} />
      </button>
      <button class={'tb-btn' + (ui.value.sidebarCollapsed ? ' on' : '')} onClick={toggleSidebar} {...tipProps('Toggle sidebar (Ctrl+\\)', 'below')}>
        <Icon name="sidebar" size={18} />
      </button>
      <div class="tabs-scroll" ref={scroller} onWheel={onWheel}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-mn-tab')) e.preventDefault(); }}
        onDrop={(e) => {
          const key = e.dataTransfer.getData('application/x-mn-tab');
          if (key && dropIdx === null) moveTab(activeWsId.value, key, tabs.length);
          setDropIdx(null);
        }}>
        {tabs.map((t, i) => (
          <div key={t.key}
            class={'tab' + (t.key === active && editorShown ? ' active' : '') + (t.key === active && !editorShown ? ' semi' : '') + (t.missing ? ' missing' : '') + (dropIdx === i ? ' drop-before' : '')}
            draggable
            title={`${t.title}${t.external ? '\n' + t.key : ''}${t.dirty ? '\nUnsaved changes' : ''}\nMiddle-click to close`}
            onDragStart={(e) => { e.dataTransfer.setData('application/x-mn-tab', t.key); const n = findNote(t.key); if (n) e.dataTransfer.setData('application/x-mn-note', t.key); }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-mn-tab')) { e.preventDefault(); setDropIdx(i); } }}
            onDragLeave={() => setDropIdx(null)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const key = e.dataTransfer.getData('application/x-mn-tab');
              if (key) moveTab(activeWsId.value, key, i);
              setDropIdx(null);
            }}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.key); } }}
            onClick={() => activateTab(t.key)}
            onDblClick={() => { const n = findNote(t.key); if (n) renameNote(n); }}
            onContextMenu={(e) => { e.preventDefault(); tabMenu(t, e.clientX, e.clientY); }}>
            {t.color ? <span class="tab-color" style={{ background: t.color }} /> : null}
            {recordingInto(t.key) ? <span class="rec-dot" title="Transcribing into this note" />
              : <Icon name={t.external ? 'external' : t.ext === 'txt' ? 'file' : 'file-text'} size={14} class="tab-icon" />}
            <span class="tab-title">{t.title}</span>
            {t.dirty ? <span class="tab-dirty" title="Unsaved changes" /> : null}
            <button class="tab-close" title="Close (Ctrl+W)" onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
        <button class="tab-new" onClick={() => newNote()} {...tipProps('New note (Ctrl+N)', 'below')}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      {tabs.length ? (
        <div class="tab-tools">
          <button class="tb-btn count" onClick={listMenu} {...tipProps('Open tabs', 'below')}>
            <span>{tabs.length}</span><Icon name="chevron-down" size={14} />
          </button>
          <button class="tb-btn close-all" onClick={() => closeAllTabs()} {...tipProps('Close all tabs (Ctrl+Shift+W) — only edited notes are saved', 'below')}>
            <Icon name="close-all" size={18} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
