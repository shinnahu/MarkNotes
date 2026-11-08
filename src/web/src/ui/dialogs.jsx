import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.jsx';
import { uid, initials, makeAvatar, makeBanner } from '../util.js';
import { workspaces, settings } from '../store.js';
import { AnimatedImage, isAnimated } from './AnimatedImage.jsx';
import { FolderGlyph, FOLDER_ICONS, isLineIcon } from './FolderGlyph.jsx';

export const modalStack = signal([]);

/** Shows a modal; resolves with the value passed to close(). */
export function openModal(render, { dismissable = true, wide = false } = {}) {
  return new Promise((resolve) => {
    const id = uid();
    const close = (value) => {
      modalStack.value = modalStack.value.filter((m) => m.id !== id);
      resolve(value);
    };
    modalStack.value = [...modalStack.value, { id, render, close, dismissable, wide }];
  });
}

export function ModalHost() {
  const stack = modalStack.value;
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const top = modalStack.peek()[modalStack.peek().length - 1];
      if (top && top.dismissable) {
        e.preventDefault();
        e.stopPropagation();
        top.close(undefined);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <>
      {stack.map((m) => (
        <div class={'modal-layer' + (m.wide ? ' wide' : '')} key={m.id}
          onMouseDown={(e) => { if (e.target === e.currentTarget && m.dismissable) m.close(undefined); }}>
          {m.render(m.close)}
        </div>
      ))}
    </>
  );
}

export function Dialog({ title, sub, children, footer, width = 460, onClose, class: cls = '' }) {
  return (
    <div class={'dialog ' + cls} style={{ width: `min(${width}px, calc(100vw - 32px))` }} role="dialog" aria-modal="true">
      <div class="dialog-head">
        <h2>{title}</h2>
        {sub ? <p class="dialog-sub">{sub}</p> : null}
        {onClose ? (
          <button class="icon-btn dialog-x" title="Close (Esc)" onClick={() => onClose()}>
            <Icon name="x" size={20} />
          </button>
        ) : null}
      </div>
      <div class="dialog-body">{children}</div>
      {footer ? <div class="dialog-foot">{footer}</div> : null}
    </div>
  );
}

function PromptDialog({ title, label, value = '', placeholder = '', ok = 'OK', selectAll = true, sub, close, hint }) {
  const [v, setV] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => { if (v.trim()) close(v.trim()); };
  return (
    <Dialog title={title} sub={sub} onClose={() => close(null)}
      footer={<>
        <button class="btn ghost" onClick={() => close(null)}>Cancel</button>
        <button class="btn primary" disabled={!v.trim()} onClick={submit}>{ok}</button>
      </>}>
      <label class="field">
        {label ? <span class="field-label">{label}</span> : null}
        <input ref={ref} class="input" value={v} placeholder={placeholder}
          onInput={(e) => setV(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
        {hint ? <span class="field-hint">{hint}</span> : null}
      </label>
    </Dialog>
  );
}

export function prompt(opts) {
  return openModal((close) => <PromptDialog {...opts} close={close} />).then((v) => v ?? null);
}

export function confirm({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return openModal((close) => (
    <Dialog title={title} onClose={() => close(false)}
      footer={<>
        <button class="btn ghost" onClick={() => close(false)}>{cancel}</button>
        <button class={'btn ' + (danger ? 'danger' : 'primary')} ref={(el) => el && setTimeout(() => el.focus(), 0)} onClick={() => close(true)}>{ok}</button>
      </>}>
      <p class="dialog-text">{body}</p>
    </Dialog>
  )).then((v) => !!v);
}

export function askChoice({ title, body, choices }) {
  return openModal((close) => (
    <Dialog title={title} onClose={() => close(null)}
      footer={<>
        {choices.slice().reverse().map((c) => (
          <button key={c.id} class={'btn ' + (c.primary ? 'primary' : c.danger ? 'danger' : 'ghost')}
            ref={(el) => c.primary && el && setTimeout(() => el.focus(), 0)} onClick={() => close(c.id)}>{c.label}</button>
        ))}
      </>}>
      <p class="dialog-text">{body}</p>
    </Dialog>
  )).then((v) => v ?? null);
}

export const SWATCHES = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22', '#00a8fc', '#607d8b', '#f1c40f', '#2ecc71'];

export function Swatches({ value, onPick, allowNone = true }) {
  return (
    <div class="swatches">
      {allowNone ? (
        <button class={'swatch none' + (!value ? ' on' : '')} title="No colour" onClick={() => onPick(null)}>
          <Icon name="x" size={12} />
        </button>
      ) : null}
      {SWATCHES.map((c) => (
        <button key={c} class={'swatch' + (value === c ? ' on' : '')} style={{ background: c }} title={c} onClick={() => onPick(c)} />
      ))}
      <label class="swatch custom" title="Custom colour">
        <input type="color" value={value || '#5865f2'} onInput={(e) => onPick(e.currentTarget.value)} />
        <Icon name="palette" size={12} />
      </label>
    </div>
  );
}

/** Should a workspace's animated picture move? (Settings › Appearance › Animated workspace pictures) */
export function gifPlays(isActive, hovered) {
  const m = settings.value.gifAvatars || 'active';
  return m === 'all' || !!hovered || (m === 'active' && !!isActive);
}

export function Avatar({ ws, size = 48, name, color, icon, play = true }) {
  const n = ws ? ws.name : name;
  const c = ws ? ws.color : color;
  const url = ws ? ws.iconUrl : icon;
  return (
    <div class="ws-avatar" style={{ width: size, height: size, background: url ? 'transparent' : (c || 'var(--bg-2)'), fontSize: Math.max(11, size * 0.32) }}>
      {url ? <AnimatedImage src={url} playing={play} /> : <span>{initials(n)}</span>}
    </div>
  );
}

function WorkspaceDialog({ ws, close }) {
  const [name, setName] = useState(ws ? ws.name : '');
  const [color, setColor] = useState(ws ? ws.color : SWATCHES[Math.floor(Math.random() * SWATCHES.length)]);
  const [icon, setIcon] = useState(ws ? ws.iconUrl : null);
  const [iconData, setIconData] = useState(undefined);
  const [banner, setBanner] = useState(ws ? ws.bannerUrl : null);
  const [bannerData, setBannerData] = useState(undefined); // undefined: unchanged, null: remove, string: new image
  const [bannerHover, setBannerHover] = useState(ws ? !!ws.bannerHover : false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const bannerRef = useRef(null);
  const nameRef = useRef(null);
  useEffect(() => { nameRef.current && nameRef.current.focus(); }, []);

  const pick = async (e) => {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const data = await makeAvatar(f, 256);
      setIcon(data);
      setIconData(data);
    } finally { setBusy(false); }
  };
  const pickBanner = async (e) => {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const data = await makeBanner(f);
      setBanner(data);
      setBannerData(data);
    } finally { setBusy(false); }
  };
  const bannerIsGif = banner && (/^data:image\/(gif|webp)/.test(banner) || isAnimated(banner));
  const submit = () => {
    if (!name.trim()) return;
    close({
      name: name.trim(), color, icon: iconData === null ? undefined : iconData, removeIcon: iconData === null,
      banner: bannerData, bannerHover,
    });
  };
  return (
    <Dialog title={ws ? 'Edit workspace' : 'Create a workspace'}
      sub={ws ? null : 'Give it a name and a picture. Workspaces keep their own folders and tabs, like Discord servers.'}
      onClose={() => close(null)} width={460}
      footer={<>
        <button class="btn ghost" onClick={() => close(null)}>Cancel</button>
        <button class="btn primary" disabled={!name.trim() || busy} onClick={submit}>{ws ? 'Save' : 'Create'}</button>
      </>}>
      <div class="ws-dialog">
        <button class={'avatar-upload' + (icon ? ' has' : '')} onClick={() => fileRef.current.click()} title="Upload a picture">
          {icon ? <img src={icon} alt="" /> : (
            <span class="avatar-upload-empty" style={{ background: color || 'var(--bg-3)' }}>
              {name.trim() ? initials(name) : <><Icon name="upload" size={22} /><small>UPLOAD</small></>}
            </span>
          )}
          <span class="avatar-plus"><Icon name="plus" size={14} /></span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
        {icon ? <button class="btn link small" onClick={() => { setIcon(null); setIconData(null); }}>Remove picture</button> : <span class="muted small">PNG, JPG, GIF or WebP</span>}
        <label class="field">
          <span class="field-label">Workspace name</span>
          <input ref={nameRef} class="input" value={name} maxLength={60} placeholder="e.g. Company name, Personal, Videogame project"
            onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
        <div class="field">
          <span class="field-label">Colour (used when there is no picture)</span>
          <Swatches value={color} onPick={setColor} allowNone={false} />
        </div>
        <div class="field">
          <span class="field-label">Banner (shown at the top of the sidebar, image or GIF)</span>
          <button class={'banner-upload' + (banner ? ' has' : '')} onClick={() => bannerRef.current.click()} title="Upload a banner">
            {banner ? <AnimatedImage src={banner} playing class="banner-upload-img" /> : <span class="banner-upload-empty"><Icon name="image" size={20} /> Upload a banner</span>}
          </button>
          <input ref={bannerRef} type="file" accept="image/*" hidden onChange={pickBanner} />
          {banner ? (
            <div class="banner-tools">
              {bannerIsGif ? (
                <div class="seg">
                  <button class={!bannerHover ? 'on' : ''} onClick={() => setBannerHover(false)}>Play automatically</button>
                  <button class={bannerHover ? 'on' : ''} onClick={() => setBannerHover(true)}>Only on hover</button>
                </div>
              ) : <span />}
              <button class="btn link small" onClick={() => { setBanner(null); setBannerData(null); }}>Remove banner</button>
            </div>
          ) : null}
        </div>
        {ws || document.documentElement.classList.contains('mobile') ? null : (
          <div class="ws-dialog-alt">
            <button class="btn link small ws-link-existing" onClick={() => close({ link: true })}>
              <Icon name="folder" size={14} /> Or open an existing folder…
            </button>
            <button class="btn link small ws-link-existing" onClick={() => close({ import: true })}>
              <Icon name="download" size={14} /> Import a .mnpack file…
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function workspaceDialog(ws = null) {
  return openModal((close) => <WorkspaceDialog ws={ws} close={close} />);
}

const EMOJIS = ['📁', '📥', '📌', '⭐', '💼', '🏢', '📊', '📈', '🧮', '💰', '🧾', '📞', '👥', '🗂️', '📝', '💡', '🎮', '🕹️', '👾', '🎨', '🎵', '🎬', '📷', '🧪', '🛠️', '⚙️', '🐞', '🚀', '🔒', '🔑', '🌐', '💬', '📚', '🎓', '🏠', '❤️', '🔥', '✅', '⏰', '📅'];

function FolderDialog({ folder, parent, close }) {
  const [name, setName] = useState(folder ? folder.name : '');
  const [icon, setIcon] = useState(folder ? folder.icon : null);
  const [color, setColor] = useState(folder ? folder.color : null);
  const [iconTab, setIconTab] = useState(folder && folder.icon && !isLineIcon(folder.icon) ? 'emoji' : 'icons');
  const ref = useRef(null);
  useEffect(() => { ref.current && (ref.current.focus(), ref.current.select()); }, []);
  const submit = () => name.trim() && close({ name: name.trim(), icon, color });
  const where = folder ? (folder.path && folder.path.includes('/') ? folder.path.slice(0, folder.path.lastIndexOf('/')) : '') : parent;
  return (
    <Dialog title={folder ? 'Edit folder' : parent ? 'Create subfolder' : 'Create folder'} onClose={() => close(null)}
      sub={where ? `Inside ${where.split('/').join(' › ')}` : folder ? null : 'Folders group notes about one topic, like channels in a Discord server.'}
      footer={<>
        <button class="btn ghost" onClick={() => close(null)}>Cancel</button>
        <button class="btn primary" disabled={!name.trim()} onClick={submit}>{folder ? 'Save' : 'Create folder'}</button>
      </>}>
      <label class="field">
        <span class="field-label">Folder name</span>
        <div class="input-with-icon">
          <span class="input-icon"><FolderGlyph icon={icon} size={16} style={{ color: color || undefined }} /></span>
          <input ref={ref} class="input" value={name} maxLength={60} placeholder="e.g. Formulas, Accounts data, Arrears management"
            onInput={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </div>
      </label>
      <div class="field">
        <span class="field-label">Icon</span>
        <div class="seg icon-tabs">
          <button class={iconTab === 'icons' ? 'on' : ''} onClick={() => setIconTab('icons')}>Icons</button>
          <button class={iconTab === 'emoji' ? 'on' : ''} onClick={() => setIconTab('emoji')}>Emoji</button>
        </div>
        {iconTab === 'icons' ? (
          <div class="emoji-grid icon-grid">
            {FOLDER_ICONS.map((n) => {
              const value = n === 'folder' ? null : `icon:${n}`;
              return (
                <button key={n} class={'emoji' + ((icon || null) === value ? ' on' : '')} onClick={() => setIcon(value)} title={n === 'folder' ? 'Default folder' : n}>
                  <Icon name={n} size={18} />
                </button>
              );
            })}
          </div>
        ) : (
          <div class="emoji-grid">
            {EMOJIS.map((e) => <button key={e} class={'emoji' + (icon === e ? ' on' : '')} onClick={() => setIcon(e)}>{e}</button>)}
          </div>
        )}
      </div>
      <div class="field">
        <span class="field-label">Colour</span>
        <Swatches value={color} onPick={setColor} />
      </div>
    </Dialog>
  );
}

export function folderDialog(folder = null, parent = '') {
  return openModal((close) => <FolderDialog folder={folder} parent={parent} close={close} />);
}

function MoveDialog({ title, currentWs, currentFolder, initialWs, close }) {
  const [wsId, setWs] = useState(initialWs || currentWs);
  const [filter, setFilter] = useState('');
  const list = workspaces.value;
  const ws = list.find((w) => w.id === wsId) || list[0];
  const q = filter.trim().toLowerCase();
  const folders = ws ? ws.folders.filter((f) => !q || f.path.toLowerCase().includes(q)) : [];
  const rootCur = ws && ws.id === currentWs && currentFolder === '';
  return (
    <Dialog title={title} onClose={() => close(null)} width={560}>
      <div class="move-dialog">
        <div class="move-ws">
          {list.map((w) => (
            <button key={w.id} class={'move-ws-item' + (w.id === wsId ? ' on' : '')} onClick={() => { setWs(w.id); setFilter(''); }} title={w.name}>
              <Avatar ws={w} size={36} />
              <span>{w.name}</span>
            </button>
          ))}
        </div>
        <div class="move-folders">
          {ws && ws.folders.length > 10 ? (
            <input class="input move-filter" placeholder="Find a folder…" value={filter}
              ref={(el) => el && !el.dataset.f && (el.dataset.f = '1', setTimeout(() => el.focus(), 0))}
              onInput={(e) => setFilter(e.currentTarget.value)} />
          ) : null}
          {ws && !q ? (
            <button class={'move-folder' + (rootCur ? ' current' : '')} disabled={rootCur} onClick={() => close({ wsId: ws.id, folder: '' })}>
              <Icon name="layers" size={16} /> {ws.name} <span class="muted small">(no folder)</span>
              {rootCur ? <span class="muted small"> (current)</span> : null}
            </button>
          ) : null}
          {folders.map((f) => {
            const cur = ws.id === currentWs && f.path === currentFolder;
            const depth = q ? 0 : f.path.split('/').length - 1;
            return (
              <button key={f.path} class={'move-folder' + (cur ? ' current' : '')} disabled={cur} style={{ paddingLeft: `${10 + depth * 18}px` }}
                onClick={() => close({ wsId: ws.id, folder: f.path })}>
                <FolderGlyph icon={f.icon} style={{ color: f.color || undefined }} />
                <span class="move-folder-name">{q ? f.path.split('/').join(' › ') : f.name}</span>
                {cur ? <span class="muted small"> (current)</span> : null}
              </button>
            );
          })}
          {ws && q && !folders.length ? <p class="muted">No folder matches.</p> : null}
          {ws ? (
            <button class="move-folder new" onClick={async () => {
              const r = await folderDialog();
              if (r) close({ wsId: ws.id, folder: r.name, create: r });
            }}>
              <Icon name="folder-plus" size={16} /> New folder…
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

export function moveDialog({ title = 'Move to…', wsId, folder, initialWs = null }) {
  return openModal((close) => <MoveDialog title={title} currentWs={wsId} currentFolder={folder} initialWs={initialWs} close={close} />);
}
