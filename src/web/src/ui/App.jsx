import { useEffect, useRef } from 'preact/hooks';
import { ui, saveState, boot } from '../store.js';
import { Rail, RailReveal } from './Rail.jsx';
import { Sidebar } from './Sidebar.jsx';
import { Main } from './Main.jsx';
import { SettingsModal } from './Settings.jsx';
import { ModalHost } from './dialogs.jsx';
import { QuickSwitcher } from './QuickSwitcher.jsx';
import { MenuHost } from './menu.jsx';
import { Toasts, Tooltip } from './Toasts.jsx';
import { clamp } from '../util.js';
import { mobile, drawer, closeDrawer } from './Mobile.jsx';

function startResize(e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = ui.value.sidebarWidth;
  document.body.classList.add('resizing');
  const move = (ev) => {
    ui.value = { ...ui.value, sidebarWidth: clamp(startW + ev.clientX - startX, 190, 480) };
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
    saveState();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

export function App() {
  const u = ui.value;
  const b = boot.value;
  const appRef = useRef(null);
  // Hidden panels stay mounted (so they can slide in and out) but cannot be reached with Tab or the mouse.
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    // On the phone both live in the drawer: out of reach while it is closed.
    const m = mobile.value;
    el.querySelector(':scope > .rail')?.toggleAttribute('inert', m ? !drawer.value : !!u.railCollapsed);
    el.querySelector(':scope > .sidebar')?.toggleAttribute('inert', m ? !drawer.value : !!u.sidebarCollapsed);
  });
  if (b.error) {
    return (
      <div class="boot-error">
        <h2>MarkNotes could not start</h2>
        <pre>{b.error}</pre>
      </div>
    );
  }
  return (
    <div ref={appRef} class={'app' + (mobile.value ? (drawer.value ? ' drawer-open' : '')
      : (u.sidebarCollapsed ? ' sb-collapsed' : '') + (u.railCollapsed ? ' rail-collapsed' : ''))} style={{ '--sidebar-w': `${u.sidebarWidth}px` }}>
      <Rail />
      {u.railCollapsed && !mobile.value ? <RailReveal /> : null}
      <Sidebar />
      {mobile.value ? <div class="drawer-scrim" onClick={closeDrawer} /> : null}
      <div class="resizer" onMouseDown={startResize} onDblClick={() => { ui.value = { ...ui.value, sidebarWidth: 248 }; saveState(); }} />
      <Main />
      <SettingsModal />
      <ModalHost />
      <QuickSwitcher />
      <MenuHost />
      <Toasts />
      <Tooltip />
    </div>
  );
}
