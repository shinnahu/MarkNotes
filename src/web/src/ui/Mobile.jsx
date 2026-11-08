// The phone layout (Android app): the note fills the screen; the workspaces and folders slide in from the left like
// Discord's server and channel lists; menus open as sheets from the bottom; Back closes what is on top.
import { signal, effect } from '@preact/signals';
import { mainView, activeTab, activeWs, activeWsId, activeKey, ui, findNote } from '../store.js';
import { renameNote } from '../actions.js';
import { Icon } from './icons.jsx';
import { Avatar } from './dialogs.jsx';
import { modalStack } from './dialogs.jsx';
import { menuState, closeMenu } from './menu.jsx';
import { settingsOpen } from './Settings.jsx';
import { quickOpen } from './QuickSwitcher.jsx';

export const mobile = signal(false);
/** The drawer with the workspaces and the folders/notes list. */
export const drawer = signal(false);

export const isMobile = () => mobile.value;

export function openDrawer() { drawer.value = true; }

export function closeDrawer() { drawer.value = false; }

/** Turns the phone layout on (from main.jsx when the host is the Android app). */
export function installMobile() {
  mobile.value = true;
  document.documentElement.classList.add('mobile');
  // Never the PC's collapsed columns on a phone: the drawer shows both.
  ui.value = { ...ui.value, sidebarCollapsed: false, railCollapsed: false };

  // Opening a note or a page from the drawer shows it (switching workspace keeps the drawer open, like Discord).
  let prevWs = activeWsId.peek();
  let prevKey = activeKey.peek();
  let prevView = mainView.peek();
  effect(() => {
    const ws = activeWsId.value;
    const key = activeKey.value;
    const view = mainView.value;
    if (drawer.peek() && ws === prevWs && (key !== prevKey || view !== prevView)) closeDrawer();
    prevWs = ws;
    prevKey = key;
    prevView = view;
  });
  document.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.sidebar .note-row, .sidebar [data-shows]');
    if (row && drawer.peek()) setTimeout(closeDrawer, 0);
  });

  // Swipe from the left edge opens the drawer; swipe left on it closes it.
  let sx = 0, sy = 0, tracking = false, fromEdge = false;
  window.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    fromEdge = !drawer.peek() && sx < 24;
    tracking = fromEdge || drawer.peek();
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dy) > Math.abs(dx) * 1.2 && Math.abs(dy) > 12) { tracking = false; return; }
    if (fromEdge && dx > 48) { tracking = false; openDrawer(); }
    else if (!fromEdge && drawer.peek() && dx < -64 && Math.abs(dx) > Math.abs(dy) * 1.5) { tracking = false; closeDrawer(); }
  }, { passive: true });

  // Android's Back: the app asks the page first; false = nothing left to close (the app goes to the background).
  window.__mnBack = () => {
    if (menuState.peek()) { closeMenu(); return true; }
    const stack = modalStack.peek();
    if (stack.length) {
      const top = stack[stack.length - 1];
      if (top.dismissable) top.close(undefined);
      return true;
    }
    if (settingsOpen.peek()) {
      settingsOpen.value = settingsOpen.peek() === 'menu' ? null : 'menu';
      return true;
    }
    if (quickOpen.peek()) { quickOpen.value = false; return true; }
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('.cm-search')) { ae.blur(); return true; }
    if (drawer.peek()) {
      const somethingBehind = mainView.peek().kind !== 'editor' || !!activeKey.peek();
      if (somethingBehind) { closeDrawer(); return true; }
      return false;
    }
    openDrawer();
    return true;
  };
}

const VIEW_TITLES = { all: 'All notes', recent: 'Recent', search: 'Search', guide: 'Workspace Guide', browse: 'Browse Folders' };

/** The top bar on the phone: ☰ (drawer), what is shown, and the note's ⋯ menu. */
export function MobileBar({ onMore }) {
  const v = mainView.value;
  const tab = activeTab.value;
  const ws = activeWs.value;
  let title = ws ? ws.name : 'MarkNotes';
  let note = null;
  if (v.kind === 'editor' && tab && !tab.missing) {
    title = tab.title;
    note = findNote(tab.key);
  } else if (v.kind === 'folder') title = v.folder ? v.folder.split('/').pop() : (ws ? ws.name : 'Notes');
  else if (VIEW_TITLES[v.kind]) title = VIEW_TITLES[v.kind];
  return (
    <div class="mobile-bar">
      <button class="mb-btn" aria-label="Workspaces and folders" onClick={openDrawer}><Icon name="menu" size={22} /></button>
      {ws ? <span class="mb-ws"><Avatar ws={ws} size={24} play={false} /></span> : null}
      <button class="mb-title" onClick={() => { if (note) renameNote(note); }}>{title}</button>
      {v.kind === 'editor' && tab ? <button class="mb-btn" aria-label="More" onClick={(e) => onMore && onMore(e)}><Icon name="more" size={20} /></button> : null}
    </div>
  );
}
