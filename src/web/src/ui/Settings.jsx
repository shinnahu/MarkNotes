import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import * as api from '../api.js';
import { settings, setSetting, updateSettings, hostInfo, toast, activeWs, flushSettings, redoKeyLabel } from '../store.js';
import { BUILTIN_THEMES, THEME_VARS, THEME_STYLE_VARS, fullVars, exportTheme, sanitizeTheme, applyTheme } from '../themes.js';
import { exportWorkspace, exportEverything, importPack } from '../actions.js';
import { asrModels, refreshAsrStatus, downloads, LANGUAGES, Toggle, Seg, transcribeFile, recorderButtonMode } from './Recorder.jsx';
import { Icon, Logo } from './icons.jsx';
import { Swatches, confirm, openModal, Dialog } from './dialogs.jsx';
import { fmtBytes } from '../util.js';
import { applyAppearance } from '../appearance.js';
import { PcPhoneSection, PhoneSyncSection, isPhone } from './PhoneSync.jsx';
import { TrashSection } from './Trash.jsx';

export const settingsOpen = signal(null);

export function openSettings(section = 'appearance') {
  settingsOpen.value = section;
}

const PC_SECTIONS = [
  ['appearance', 'Appearance', 'palette'],
  ['editor', 'Editor', 'pencil'],
  ['files', 'Saving & files', 'save'],
  ['transcription', 'Transcription', 'mic'],
  ['phone', 'Phone', 'smartphone'],
  ['share', 'Import & export', 'box'],
  ['shortcuts', 'Shortcuts', 'keyboard'],
  ['about', 'About', 'info'],
];

// The phone has no transcription, file types, packs or PDF printing (yet): those pages stay on the PC.
const PHONE_SECTIONS = [
  ['sync', 'Sync with PC', 'refresh'],
  ['appearance', 'Appearance', 'palette'],
  ['editor', 'Editor', 'pencil'],
  ['files', 'Saving & files', 'save'],
  ['trash', 'Trash', 'trash'],
  ['about', 'About', 'info'],
];

const sections = () => (isPhone() ? PHONE_SECTIONS : PC_SECTIONS);

function Row({ label, hint, children }) {
  return (
    <div class="set-row">
      <div class="set-text">
        <div class="set-label">{label}</div>
        {hint ? <div class="set-hint">{hint}</div> : null}
      </div>
      <div class="set-control">{children}</div>
    </div>
  );
}

function Switch({ path }) {
  const v = path.split('.').reduce((o, k) => (o ? o[k] : undefined), settings.value);
  return <button role="switch" aria-checked={!!v} class={'switch' + (v ? ' on' : '')} onClick={() => setSetting(path, !v)}><span /></button>;
}

function Range({ path, min, max, step = 1, fmt = (x) => x }) {
  const v = path.split('.').reduce((o, k) => (o ? o[k] : undefined), settings.value);
  return (
    <div class="range">
      <input type="range" min={min} max={max} step={step} value={v} onInput={(e) => setSetting(path, Number(e.currentTarget.value))} />
      <span class="range-val">{fmt(v)}</span>
    </div>
  );
}

function Select({ path, options }) {
  const v = path.split('.').reduce((o, k) => (o ? o[k] : undefined), settings.value);
  return (
    <select class="select" value={String(v)} onChange={(e) => {
      const raw = e.currentTarget.value;
      const num = Number(raw);
      setSetting(path, raw !== '' && !isNaN(num) && typeof v === 'number' ? num : raw);
    }}>
      {options.map(([val, label]) => <option key={val} value={String(val)}>{label}</option>)}
    </select>
  );
}

// ───────────────────────────── appearance ─────────────────────────────

function ThemeCard({ theme, selected, onPick, onEdit, onExport, onDelete }) {
  const v = fullVars(theme);
  return (
    <div class={'theme-card' + (selected ? ' on' : '')} onClick={onPick}>
      <div class="theme-preview" style={{ background: v['bg-2'] }}>
        <div class="tp-rail" style={{ background: v['bg-0'] }}>
          <span style={{ background: v.accent }} /><span style={{ background: v['bg-2'] }} /><span style={{ background: v['bg-2'] }} />
        </div>
        <div class="tp-side" style={{ background: v['bg-1'] }}>
          <i style={{ background: v['text-muted'] }} /><i style={{ background: v['bg-active'] }} /><i style={{ background: v['text-muted'] }} />
        </div>
        <div class="tp-main">
          <i style={{ background: v['text-strong'], width: '50%' }} />
          <i style={{ background: v.text }} />
          <i style={{ background: v.text, width: '70%' }} />
          <b style={{ background: v['bg-code'], borderColor: v.border }}><em style={{ background: v['syn-keyword'] }} /><em style={{ background: v['syn-string'] }} /></b>
        </div>
      </div>
      <div class="theme-name">
        <span>{theme.name}</span>
        {selected ? <Icon name="check" size={14} /> : null}
      </div>
      {theme.custom ? (
        <div class="theme-actions" onClick={(e) => e.stopPropagation()}>
          <button class="icon-btn" title="Edit" onClick={onEdit}><Icon name="pencil" size={14} /></button>
          <button class="icon-btn" title="Export (.mntheme)" onClick={onExport}><Icon name="upload" size={14} /></button>
          <button class="icon-btn danger" title="Delete" onClick={onDelete}><Icon name="trash" size={14} /></button>
        </div>
      ) : null}
    </div>
  );
}

export function allThemes() {
  return [...BUILTIN_THEMES, ...(settings.value.customThemes || [])];
}

export function currentTheme() {
  return allThemes().find((t) => t.id === settings.value.theme) || BUILTIN_THEMES[0];
}

async function importThemes() {
  const files = await api.call('theme.import');
  if (!files || !files.length) return;
  const custom = [...(settings.value.customThemes || [])];
  let last = null;
  for (const raw of files) {
    try {
      const t = sanitizeTheme(raw);
      custom.push(t);
      last = t;
    } catch (e) { toast('Not a valid theme file: ' + e.message, 'error'); }
  }
  if (last) {
    updateSettings({ customThemes: custom, theme: last.id });
    toast(`Theme “${last.name}” imported`, 'success');
  }
}

async function exportOneTheme(t) {
  const path = await api.call('theme.export', { name: t.name, json: exportTheme(t) });
  if (path) toast(`Theme saved to ${path}`, 'success', 5000);
}

function ThemeEditor({ base, close }) {
  const [t, setT] = useState(() => ({
    id: base.custom ? base.id : 'custom-' + Math.random().toString(36).slice(2, 9),
    name: base.custom ? base.name : `${base.name} (my version)`,
    author: base.author && base.custom ? base.author : '',
    base: base.base,
    vars: { ...fullVars(base) },
    css: base.css || '',
    custom: true,
  }));
  useEffect(() => { applyTheme(t); }, [t]);
  const setVar = (k, v) => setT({ ...t, vars: { ...t.vars, [k]: v } });
  const toHex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : /^#[0-9a-f]{3}$/i.test(v || '') ? '#' + v.slice(1).split('').map((c) => c + c).join('') : '#000000');
  const save = () => {
    const custom = [...(settings.value.customThemes || [])];
    const i = custom.findIndex((c) => c.id === t.id);
    const clean = { ...t, vars: { ...t.vars } };
    if (i >= 0) custom[i] = clean; else custom.push(clean);
    updateSettings({ customThemes: custom, theme: t.id });
    close(true);
  };
  const cancel = () => { applyAppearance(); close(false); };
  return (
    <Dialog title="Theme editor" sub="Changes preview live. Share it with Export: anyone with MarkNotes can import the .mntheme file." onClose={cancel} width={720}
      footer={<>
        <button class="btn ghost" onClick={() => exportOneTheme(t)}><Icon name="upload" size={15} /> Export…</button>
        <span class="grow" />
        <button class="btn ghost" onClick={cancel}>Cancel</button>
        <button class="btn primary" onClick={save}>Save theme</button>
      </>}>
      <div class="theme-editor">
        <div class="te-top">
          <label class="field"><span class="field-label">Name</span><input class="input" value={t.name} onInput={(e) => setT({ ...t, name: e.currentTarget.value })} /></label>
          <label class="field"><span class="field-label">Author</span><input class="input" value={t.author} onInput={(e) => setT({ ...t, author: e.currentTarget.value })} /></label>
          <label class="field"><span class="field-label">Base</span>
            <select class="select" value={t.base} onChange={(e) => setT({ ...t, base: e.currentTarget.value })}><option value="dark">Dark</option><option value="light">Light</option></select>
          </label>
        </div>
        <div class="te-grid">
          {THEME_VARS.map(([k, label]) => (
            <label key={k} class="te-var">
              <input type="color" value={toHex(t.vars[k])} onInput={(e) => setVar(k, e.currentTarget.value)} />
              <span class="te-label">{label}</span>
              <input class="input tiny" value={t.vars[k] || ''} onChange={(e) => setVar(k, e.currentTarget.value)} />
            </label>
          ))}
        </div>
        <div class="te-style">
          {THEME_STYLE_VARS.map(([k, label, def]) => (
            <label key={k} class="field"><span class="field-label">{label}</span>
              <input class="input" placeholder={def} value={t.vars[k] || ''} onChange={(e) => setVar(k, e.currentTarget.value)} />
            </label>
          ))}
        </div>
        <label class="field">
          <span class="field-label">Custom CSS (advanced — restyle anything)</span>
          <textarea class="input code" rows={6} spellcheck={false} value={t.css} onChange={(e) => setT({ ...t, css: e.currentTarget.value })} placeholder={'.cm-h1 { letter-spacing: .05em; }'} />
        </label>
      </div>
    </Dialog>
  );
}

export function editTheme(base) {
  return openModal((close) => <ThemeEditor base={base} close={close} />, { dismissable: false });
}

function Appearance() {
  const s = settings.value;
  const themes = allThemes();
  return (
    <>
      <h2>Appearance</h2>
      <div class="set-group">
        <div class="set-group-title">Theme</div>
        <div class="theme-grid">
          {themes.map((t) => (
            <ThemeCard key={t.id} theme={t} selected={s.theme === t.id}
              onPick={() => setSetting('theme', t.id)}
              onEdit={() => editTheme(t)}
              onExport={() => exportOneTheme(t)}
              onDelete={async () => {
                if (await confirm({ title: 'Delete theme?', body: `“${t.name}” will be removed.`, ok: 'Delete', danger: true })) {
                  updateSettings({ customThemes: s.customThemes.filter((c) => c.id !== t.id), theme: s.theme === t.id ? 'discord-dark' : s.theme });
                }
              }} />
          ))}
        </div>
        <div class="btn-row">
          <button class="btn" onClick={() => editTheme(currentTheme())}><Icon name="palette" size={15} /> Create a theme from this one…</button>
          <button class="btn ghost" onClick={importThemes}><Icon name="download" size={15} /> Import theme…</button>
          <button class="btn ghost" onClick={() => exportOneTheme(currentTheme())}><Icon name="upload" size={15} /> Export current theme…</button>
        </div>
      </div>
      <div class="set-group">
        <div class="set-group-title">Accent colour</div>
        <Swatches value={s.accent || null} onPick={(c) => setSetting('accent', c || '')} />
        <p class="set-hint">Overrides the theme's accent. Clear it to use the theme colour.</p>
      </div>
      <div class="set-group">
        <div class="set-group-title">Workspaces</div>
        <Row label="Animated workspace pictures (GIF)" hint="Pictures always play while the pointer is over them. Banner GIFs have their own option in each workspace's settings.">
          <Select path="gifAvatars" options={[['active', 'Play only the current workspace'], ['all', 'Play all'], ['hover', 'Play only on hover']]} />
        </Row>
        <Row label="Card view layout (cards, covers, list)" hint="Remember the layout you pick for each workspace, or use the same one everywhere.">
          <Select path="gridLayoutScope" options={[['workspace', 'Per workspace'], ['all', 'Same in all workspaces']]} />
        </Row>
      </div>
      <div class="set-group">
        <div class="set-group-title">Note text</div>
        <Row label="Text size"><Range path="editorFontSize" min={11} max={28} fmt={(v) => `${v}px`} /></Row>
        <Row label="Line spacing"><Range path="editorLineHeight" min={1.2} max={2.2} step={0.05} fmt={(v) => v.toFixed(2)} /></Row>
        <Row label="Font">
          <Select path="editorFont" options={[
            ['', 'Theme default'], ['"Segoe UI Variable Text", "Segoe UI", sans-serif', 'Segoe UI'],
            ['"Cascadia Code", "Cascadia Mono", Consolas, monospace', 'Cascadia Code (mono)'], ['Consolas, monospace', 'Consolas (mono)'],
            ['Georgia, serif', 'Georgia (serif)'], ['"Bahnschrift", "Segoe UI", sans-serif', 'Bahnschrift'], ['Verdana, sans-serif', 'Verdana'],
          ]} />
        </Row>
        <Row label="Readable line width" hint="Keeps long lines comfortable to read on wide screens."><Switch path="readableWidth" /></Row>
        {s.readableWidth ? <Row label="Maximum width"><Range path="editorMaxWidth" min={600} max={1800} step={20} fmt={(v) => `${v}px`} /></Row> : null}
        <Row label="Zoom" hint="Ctrl + / Ctrl − / Ctrl 0, or Ctrl + mouse wheel over a note."><Range path="zoom" min={60} max={220} step={10} fmt={(v) => `${v}%`} /></Row>
        <Row label="Status bar"><Switch path="showStatusBar" /></Row>
        <Row label="Animate panels" hint="The workspaces column and the sidebar slide when you show or hide them."><Switch path="uiAnimations" /></Row>
      </div>
    </>
  );
}

// ───────────────────────────── editor ─────────────────────────────

function EditorSection() {
  const s = settings.value;
  return (
    <>
      <h2>Editor</h2>
      <div class="set-group">
        <Row label="Word wrap" hint="Long lines continue on the next line instead of scrolling sideways."><Switch path="wordWrap" /></Row>
        <Row label="Line numbers"><Switch path="lineNumbers" /></Row>
        <Row label="Live preview" hint="Hide markdown symbols (#, **, links…) except on the line you are editing. Files stay plain text."><Switch path="livePreview" /></Row>
        <Row label="Spell check"><Switch path="spellcheck" /></Row>
        <Row label="Open links with">
          <Select path="linkClick" options={[['ctrl', 'Ctrl + Click'], ['click', 'Click (markdown links)']]} />
        </Row>
        <Row label="Links look like normal text" hint="No link colour and no underline. [[Note]] links still open with a click."><Switch path="plainLinks" /></Row>
        <Row label="Link previews" hint="A web link alone on its line (and canvas link cards) shows its title and picture: pages, YouTube videos, X posts. Downloaded once per link and kept on this PC; besides playing web videos, this is the only thing MarkNotes fetches from the internet."><Switch path="linkPreviews" /></Row>
        <Row label="Play web videos inside MarkNotes" hint="YouTube videos and X videos play right in the note or canvas (YouTube in its privacy mode). Off: Play opens them in your browser, and MarkNotes stays fully offline."><Switch path="webEmbeds" /></Row>
        <Row label="Video volume" hint="How loud videos play in MarkNotes (X, YouTube, video and audio files). 50% sounds about half as loud as 100%. Windows also keeps a volume for MarkNotes in its volume mixer."><Range path="videoVolume" min={5} max={100} step={5} fmt={(v) => `${v}%`} /></Row>
        <Row label="Maximum image width"><Range path="maxImageWidth" min={200} max={2000} step={50} fmt={(v) => `${v}px`} /></Row>
        <Row label="Image caption padding" hint="Space above and below the text of image captions (![[image.png|caption]])."><Range path="captionPadding" min={0} max={32} step={1} fmt={(v) => `${v}px`} /></Row>
      </div>
      <div class="set-group">
        <div class="set-group-title">Code</div>
        <Row label="Code windows" hint="Show fenced code as its own scrollable window with copy, wrap, minimise and back-to-top buttons."><Switch path="codeWindows" /></Row>
        <Row label="Pasted code becomes a code window" hint="Detects code (and the language) when you paste. Ctrl+Z right after pasting keeps it as plain text; Ctrl+Shift+V always pastes plain text."><Switch path="autoCodeBlocks" /></Row>
        <Row label="Wrap long code lines by default"><Switch path="codeWrapDefault" /></Row>
        <Row label="Code window height" hint="Taller code scrolls inside its window.">
          <Select path="codeMaxHeight" options={[[240, 'Small (240px)'], [420, 'Medium (420px)'], [640, 'Large (640px)'], [900, 'Extra large (900px)'], [0, 'No limit']]} />
        </Row>
        <Row label="Line numbers in code windows"><Switch path="codeLineNumbers" /></Row>
      </div>
      <div class="set-group">
        <div class="set-group-title">Canvas</div>
        <Row label="Smooth navigation" hint="Like Miro: the board keeps sliding a little after you drag it and let go, and zooming with the mouse wheel glides."><Switch path="canvasMomentum" /></Row>
        {s.canvasMomentum !== false ? (
          <Row label="Momentum" hint="How far the board keeps sliding after you let go."><Range path="canvasMomentumAmount" min={0} max={100} step={5} fmt={(v) => (v < 25 ? 'Low' : v < 70 ? 'Medium' : 'High')} /></Row>
        ) : null}
      </div>
    </>
  );
}

// ───────────────────────────── files ─────────────────────────────

function FilesSection() {
  const s = settings.value;
  const info = hostInfo.value;
  const [assoc, setAssoc] = useState(null);
  const loadAssoc = () => api.call('app.fileAssoc').then(setAssoc).catch(() => {});
  useEffect(() => { if (!isPhone()) loadAssoc(); }, []);
  const changeRoot = async () => {
    const path = await api.call('app.pickFolder', { title: 'Choose the folder where MarkNotes keeps your notes', initial: info.notesRoot });
    if (!path || path === info.notesRoot) return;
    const ok = await confirm({ title: 'Use this folder for notes?', body: `${path}\n\nMarkNotes will show the workspaces inside that folder. Your current notes stay where they are (${info.notesRoot}); you can move the folders yourself in Explorer.`, ok: 'Use folder' });
    if (!ok) return;
    setSetting('notesRoot', path);
    await flushSettings();
    await api.call('app.setNotesRoot', { path });
    location.reload();
  };
  return (
    <>
      <h2>Saving & files</h2>
      <div class="set-group">
        <Row label="Save automatically" hint="Notes are written only when you change them — opening, switching or closing tabs never rewrites a note."><Switch path="autosave" /></Row>
        {s.autosave ? (
          <>
            <Row label="Save after you stop typing for">
              <Select path="autosaveDelay" options={[[400, '0.4 seconds'], [800, '0.8 seconds'], [1500, '1.5 seconds'], [3000, '3 seconds']]} />
            </Row>
            {isPhone() ? null : <Row label="Also autosave files opened from outside your notes" hint="E.g. a .txt you double-clicked in Explorer. Turn off to save those with Ctrl+S only."><Switch path="autosaveExternal" /></Row>}
          </>
        ) : null}
        <Row label="New notes are"><Select path="defaultExt" options={[['md', 'Markdown (.md)'], ['txt', 'Plain text (.txt)']]} /></Row>
        <Row label="Format .txt files as markdown" hint="Off: .txt files are plain text (only links are clickable)."><Switch path="txtAsMarkdown" /></Row>
        <Row label="Ask before deleting notes" hint={isPhone() ? 'Deleted notes go to the Trash (Settings › Trash), where they stay until you delete them for good.' : 'Deleted notes always go to the Recycle Bin.'}><Switch path="confirmDelete" /></Row>
        <Row label="Sort notes in the sidebar by">
          <Select path="sidebarSort" options={[['modified', 'Last edited'], ['name', 'Name'], ['created', 'Newest first'], ['oldest', 'Oldest first']]} />
        </Row>
      </div>
      <div class="set-group">
        <div class="set-group-title">Notes folder</div>
        <div class="path-box"><Icon name="folder" size={16} /><span title={info.notesRoot}>{info.notesRoot}</span></div>
        {isPhone() ? null : <div class="btn-row">
          <button class="btn" onClick={() => api.call('app.revealRoot')}><Icon name="folder" size={15} /> Open in Explorer</button>
          <button class="btn ghost" onClick={changeRoot}>Change folder…</button>
        </div>}
        <p class="set-hint">Each workspace is a folder inside it; each folder holds .md/.txt files you can also open with any other program. Pasted images live in the workspace's “.assets” folder.</p>
      </div>
      {isPhone() ? null : <div class="set-group">
        <div class="set-group-title">Open .txt and .md files with MarkNotes</div>
        {assoc ? (
          <div class="assoc">
            <div class="assoc-row"><span class="chip">.md</span>{assoc.mdIsDefault ? <span class="ok-text"><Icon name="check" size={14} /> MarkNotes is the default</span> : <span class="muted">Currently: {assoc.md || 'not set'}</span>}
              {!assoc.mdIsDefault ? <button class="btn small" onClick={() => api.call('app.chooseDefault', { ext: '.md' }).then(setAssoc)}>Make default…</button> : null}</div>
            <div class="assoc-row"><span class="chip">.txt</span>{assoc.txtIsDefault ? <span class="ok-text"><Icon name="check" size={14} /> MarkNotes is the default</span> : <span class="muted">Currently: {assoc.txt || 'not set'}</span>}
              {!assoc.txtIsDefault ? <button class="btn small" onClick={() => api.call('app.chooseDefault', { ext: '.txt' }).then(setAssoc)}>Make default…</button> : null}</div>
          </div>
        ) : null}
        <p class="set-hint">Windows asks you to confirm the default app yourself (pick MarkNotes and tick “Always”). MarkNotes is always available in right-click › Open with.</p>
        <div class="btn-row">
          <button class="btn ghost" onClick={() => api.call('app.registerFileTypes').then(setAssoc)}>Repair registration</button>
          <button class="btn ghost" onClick={() => api.call('app.defaultAppsSettings')}>Windows default apps…</button>
          <button class="btn ghost" onClick={loadAssoc}><Icon name="refresh" size={14} /> Refresh</button>
        </div>
      </div>}
    </>
  );
}

// ───────────────────────────── transcription ─────────────────────────────

function TranscriptionSection() {
  const a = settings.value.asr;
  const st = asrModels.value;
  const dl = downloads.value;
  useEffect(() => { refreshAsrStatus(); }, []);
  const source = a.mic && a.desktop ? 'both' : a.mic ? 'mic' : 'desktop';
  return (
    <>
      <h2>Transcription</h2>
      <div class="set-group">
        <Row label="Button in the sidebar" hint="Start and stop transcribing from the bottom of the sidebar. Ctrl+Shift+R works even when the button is hidden.">
          <select class="select" value={recorderButtonMode()} onChange={(e) => setSetting('recorderButton', e.currentTarget.value)}>
            <option value="small">Small (microphone icon)</option>
            <option value="large">Large “Transcribe” button</option>
            <option value="hidden">Hidden</option>
          </select>
        </Row>
      </div>
      <p class="set-intro">
        Write down what is said while you talk or listen to a call — <b>completely offline</b>. Audio never leaves your PC:
        it is turned into text by <b>whisper.cpp</b> running on your graphics card (Vulkan) or processor. Only the speech model is
        downloaded once (from huggingface.co); after that no internet is needed.
      </p>
      <div class="set-group">
        <div class="set-group-title">Speech model</div>
        {!st ? <p class="muted">Loading…</p> : (
          <div class="models">
            {st.models.map((m) => {
              const d = dl[m.id];
              return (
                <div key={m.id} class={'model' + (a.model === m.id ? ' on' : '')}>
                  <button class={'radio' + (a.model === m.id ? ' on' : '')} disabled={!m.installed} title={m.installed ? 'Use this model' : 'Download it first'} onClick={() => setSetting('asr.model', m.id)} />
                  <div class="model-text">
                    <div class="model-name">{m.label} <span class="muted small">{m.sizeMb >= 1000 ? (m.sizeMb / 1000).toFixed(1) + ' GB' : m.sizeMb + ' MB'}</span>
                      {m.id === 'large-v3-turbo-q5_0' ? <span class="chip accent tiny">Recommended</span> : null}</div>
                    <div class="set-hint">{m.hint}</div>
                    {d ? (
                      <div class="progress"><div style={{ width: `${d.total ? Math.round((d.received / d.total) * 100) : 0}%` }} /><span>{fmtBytes(d.received)} / {fmtBytes(d.total)}</span></div>
                    ) : null}
                  </div>
                  <div class="model-actions">
                    {m.installed ? (
                      <>
                        <span class="ok-text"><Icon name="check" size={14} /> Installed</span>
                        <button class="icon-btn danger" title="Delete model" onClick={async () => {
                          if (await confirm({ title: 'Delete model?', body: `${m.label} (${m.sizeMb} MB) will be removed. You can download it again later.`, ok: 'Delete', danger: true })) {
                            await api.call('asr.deleteModel', { id: m.id });
                            refreshAsrStatus();
                          }
                        }}><Icon name="trash" size={14} /></button>
                      </>
                    ) : d ? (
                      <button class="btn small ghost" onClick={() => api.call('asr.cancelDownload', { id: m.id })}>Cancel</button>
                    ) : (
                      <>
                        <button class="btn small" onClick={() => { api.call('asr.download', { id: m.id }); downloads.value = { ...downloads.value, [m.id]: { received: 0, total: m.sizeMb * 1048576 } }; }}>
                          <Icon name="download" size={14} /> Download
                        </button>
                        <button class="icon-btn" title="I already have this file (.bin)" onClick={async () => { if (await api.call('asr.importModel', { id: m.id })) refreshAsrStatus(); }}>
                          <Icon name="folder" size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div class="set-group">
        <div class="set-group-title">Recording</div>
        <Row label="Listen to" hint="Desktop audio = everything your PC plays (a call, a video, a game).">
          <Seg value={source} onChange={(v) => setSetting('asr', { ...a, mic: v !== 'desktop', desktop: v !== 'mic' })}
            options={[['both', 'Mic + Desktop'], ['mic', 'Mic only'], ['desktop', 'Desktop only']]} />
        </Row>
        <Row label="Language" hint="Auto picks Spanish or English for each phrase. If you speak Spanish with only some English words (ok, mail, dashboard), Español works best: it keeps those words and never switches language.">
          <Select path="asr.language" options={LANGUAGES} />
        </Row>
        <Row label="Microphone">
          <Select path="asr.micDevice" options={[['', 'Windows default'], ...((st && st.devices.mic) || []).map((d) => [d.id, d.name])]} />
        </Row>
        <Row label="Desktop audio from">
          <Select path="asr.desktopDevice" options={[['', 'Windows default output'], ...((st && st.devices.desktop) || []).map((d) => [d.id, d.name])]} />
        </Row>
        <Row label="Use the GPU" hint="Uses Vulkan (any NVIDIA/AMD/Intel card). Work comes in short bursts after each phrase, so the load stays low. Switching takes effect after restarting MarkNotes."><Switch path="asr.gpu" /></Row>
        <Row label="Label who is speaking" hint="“Me” for your microphone, “Desktop” for the other side of the call."><Switch path="asr.labels" /></Row>
        <Row label="Add timestamps"><Switch path="asr.timestamps" /></Row>
        <Row label="Write into"><Seg value={a.target} onChange={(v) => setSetting('asr.target', v)} options={[['current', 'Current note'], ['new', 'A new note']]} /></Row>
        <label class="field">
          <span class="field-label">Vocabulary hint (optional)</span>
          <textarea class="input" rows={2} value={a.prompt} placeholder="Names and words it gets wrong, separated by commas: ClickUp, Rapipago, dashboard, tenant…" onChange={(e) => setSetting('asr.prompt', e.currentTarget.value)} />
        </label>
        <p class="set-hint">Tip: wear headphones when recording both sources, so the microphone does not pick up the call twice.</p>
        <div class="btn-row"><button class="btn" onClick={() => { settingsOpen.value = null; transcribeFile(); }}><Icon name="file" size={15} /> Transcribe an audio/video file…</button></div>
      </div>
    </>
  );
}

// ───────────────────────────── share ─────────────────────────────

function ShareSection() {
  const ws = activeWs.value;
  const pdf = settings.value.pdf || {};
  return (
    <>
      <h2>Import & export</h2>
      <div class="set-group">
        <div class="set-group-title">Share a workspace</div>
        <p class="set-hint">Packs every folder, note and image of a workspace (plus its picture, and optionally your theme) into one <b>.mnpack</b> file. Whoever imports it sees it exactly like you.</p>
        <div class="btn-row">
          <button class="btn primary" disabled={!ws} onClick={() => exportWorkspace(ws)}><Icon name="upload" size={15} /> Export “{ws ? ws.name : '—'}”…</button>
          <button class="btn" onClick={() => importPack()}><Icon name="download" size={15} /> Import .mnpack…</button>
        </div>
      </div>
      <div class="set-group">
        <div class="set-group-title">Backup everything</div>
        <p class="set-hint">All workspaces, your preferences and custom themes in one file. Import it on another PC to get the same setup.</p>
        <div class="btn-row"><button class="btn" onClick={exportEverything}><Icon name="save" size={15} /> Export full backup…</button></div>
      </div>
      <div class="set-group">
        <div class="set-group-title">PDF</div>
        <p class="set-hint">Save a note as PDF from its <b>⋯</b> menu or by right-clicking it in the sidebar. It is made on this PC, on white paper, without internet.</p>
        <Row label="Page size"><Select path="pdf.paper" options={[['a4', 'A4'], ['letter', 'Letter'], ['legal', 'Legal']]} /></Row>
        <Row label="Orientation" hint="Landscape gives wide tables more room.">
          <Seg value={pdf.landscape ? 'landscape' : 'portrait'} onChange={(v) => setSetting('pdf.landscape', v === 'landscape')}
            options={[['portrait', 'Portrait'], ['landscape', 'Landscape']]} />
        </Row>
        <Row label="Margins"><Select path="pdf.margins" options={[['narrow', 'Narrow (12 mm)'], ['normal', 'Normal (18 mm)'], ['wide', 'Wide (25 mm)']]} /></Row>
        <Row label="Text size"><Select path="pdf.size" options={[['small', 'Small (10 pt)'], ['medium', 'Medium (11 pt)'], ['large', 'Large (12 pt)']]} /></Row>
        <Row label="Page numbers" hint="“1 / 3” at the bottom of each page."><Switch path="pdf.pageNumbers" /></Row>
      </div>
      <div class="set-group">
        <div class="set-group-title">Themes</div>
        <div class="btn-row">
          <button class="btn" onClick={() => exportOneTheme(currentTheme())}><Icon name="upload" size={15} /> Export current theme…</button>
          <button class="btn ghost" onClick={importThemes}><Icon name="download" size={15} /> Import theme…</button>
        </div>
      </div>
    </>
  );
}

const shortcuts = () => [
  ['Ctrl+N', 'New note'], ['Ctrl+K / Ctrl+P', 'Find a note by name'], ['Ctrl+Shift+F', 'Search in all notes'],
  ['Ctrl+F / Ctrl+H', 'Find / replace in the note'], ['Ctrl+S', 'Save now'], ['Ctrl+O', 'Open a file'],
  ['Ctrl+W', 'Close tab'], ['Ctrl+Shift+W', 'Close all tabs'], ['Ctrl+Shift+T', 'Reopen closed tab'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'], ['Alt+↑ / Alt+↓', 'Previous / next workspace'],
  [`Ctrl+Z / ${redoKeyLabel()}`, 'Undo / redo'], ['Ctrl+B / Ctrl+I', 'Bold / italic'], ['Ctrl+1 / 2 / 3', 'Heading'],
  ['Ctrl+Shift+C', 'Code block'], ['Ctrl+Shift+K', 'Link'], ['Ctrl+Shift+V', 'Paste as plain text'],
  ['F2', 'Rename note'], ['F5', 'Insert date & time'], ['Ctrl+\\', 'Toggle sidebar'], ['Ctrl+,', 'Settings'],
  ['Ctrl + / − / 0', 'Zoom text'], ['Ctrl+Shift+R', 'Start / stop transcription'],
];

function Shortcuts() {
  return (
    <>
      <h2>Shortcuts</h2>
      <div class="set-group">
        <Row label="Redo with" hint="Undo is always Ctrl+Z. The other key does nothing.">
          <Seg value={settings.value.redoKey === 'ctrl+y' ? 'ctrl+y' : 'ctrl+shift+z'} onChange={(v) => setSetting('redoKey', v)}
            options={[['ctrl+shift+z', 'Ctrl+Shift+Z'], ['ctrl+y', 'Ctrl+Y']]} />
        </Row>
      </div>
      <div class="set-group shortcuts">
        {shortcuts().map(([k, d]) => <div key={k} class="shortcut"><span>{d}</span><kbd>{k}</kbd></div>)}
      </div>
    </>
  );
}

function About() {
  const info = hostInfo.value;
  if (isPhone()) {
    return (
      <>
        <h2>About</h2>
        <div class="about">
          <Logo size={72} />
          <div>
            <div class="about-name">MarkNotes for Android {info.version}</div>
            <div class="muted">Your MarkNotes workspaces on the phone, synced with MarkNotes on your PC over your Wi-Fi.</div>
          </div>
        </div>
        <div class="set-group">
          <Row label="Notes folder" hint="In the app's storage on the phone (Android/data/com.marknotes.app on a PC over USB)."><span class="mono small">{info.notesRoot}</span></Row>
        </div>
        <p class="set-hint">Built with Android's WebView, CodeMirror 6 and Preact. Everything stays on this phone; the only connections are to MarkNotes on your PC over the Wi-Fi (and, if you play them, YouTube or X videos in notes).</p>
      </>
    );
  }
  return (
    <>
      <h2>About</h2>
      <div class="about">
        <Logo size={72} />
        <div>
          <div class="about-name">MarkNotes {info.version}</div>
          <div class="muted">A fast, offline notepad with workspaces, code windows and transcription.</div>
        </div>
      </div>
      <div class="set-group">
        <Row label="Notes folder"><span class="mono small">{info.notesRoot}</span></Row>
        <Row label="Settings folder"><button class="btn small ghost" onClick={() => api.call('app.revealConfig')}>Open</button></Row>
      </div>
      <p class="set-hint">Built with WebView2 (Edge), CodeMirror 6, Preact, whisper.cpp (via Whisper.net) and NAudio. Everything runs locally; the app blocks all network access except the optional speech-model download.</p>
    </>
  );
}

export function SettingsModal() {
  const section = settingsOpen.value;
  useEffect(() => {
    if (!section) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-layer')) { e.preventDefault(); settingsOpen.value = null; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!section]);
  if (!section) return null;
  const Body = {
    appearance: Appearance, editor: EditorSection, files: FilesSection, transcription: TranscriptionSection, share: ShareSection,
    shortcuts: Shortcuts, about: About, phone: PcPhoneSection, sync: PhoneSyncSection, trash: TrashSection,
  }[section] || (isPhone() ? PhoneSyncSection : Appearance);
  return (
    <div class={'settings' + (isPhone() && section === 'menu' ? ' at-menu' : '')}>
      <nav class="settings-nav">
        <div class="settings-nav-inner">
          <div class="settings-nav-title">SETTINGS{isPhone() ? (
            <button class="settings-nav-close" aria-label="Close" onClick={() => { settingsOpen.value = null; }}><Icon name="x" size={20} /></button>
          ) : null}</div>
          {sections().map(([id, label, icon]) => (
            <button key={id} class={'settings-nav-item' + (section === id ? ' on' : '')} onClick={() => { settingsOpen.value = id; }}>
              <Icon name={icon} size={16} /> {label}
            </button>
          ))}
        </div>
      </nav>
      <section class="settings-body">
        <div class="settings-content">
          {isPhone() ? <button class="settings-back" onClick={() => { settingsOpen.value = 'menu'; }}><Icon name="chevron-left" size={18} /> Settings</button> : null}
          <Body />
        </div>
        <div class="settings-close">
          <button class="close-circle" onClick={() => { settingsOpen.value = null; }} title="Close (Esc)"><Icon name="x" size={18} /></button>
          <span>ESC</span>
        </div>
      </section>
    </div>
  );
}
