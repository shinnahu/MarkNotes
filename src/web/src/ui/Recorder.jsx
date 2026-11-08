import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as api from '../api.js';
import { recorder, settings, setSetting, toast, activeKey, activeTab, findNote, activeWsId, hostInfo } from '../store.js';
import { docs, applyToDoc, newNote, openNote, saveDoc } from '../docs.js';
import * as ed from '../editor/editor.js';
import { Icon } from './icons.jsx';
import { openSettings } from './Settings.jsx';
import { tipProps } from './Toasts.jsx';
import { stem } from '../util.js';
import { isPhone, PhonePanel } from './PhoneSync.jsx';

export const LANGUAGES = [
  ['auto', 'Auto: Spanish or English'],
  ['es', 'Español'],
  ['en', 'English'],
  ['pt', 'Português'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
];

export const asrModels = signal(null); // {models, devices, running, backend}
export const downloads = signal({}); // id -> {received,total,error}

/** Sidebar button: 'small' | 'large' | 'hidden'. By default small when speech is installed with a model, else hidden. */
export function recorderButtonMode() {
  const v = settings.value.recorderButton;
  if (v === 'small' || v === 'large' || v === 'hidden') return v;
  const sp = hostInfo.value.speech;
  return sp && sp.engine && sp.models > 0 ? 'small' : 'hidden';
}

export async function refreshAsrStatus() {
  try {
    const s = await api.call('asr.status');
    asrModels.value = s;
    // Keep the chosen model valid: fall back to one that is actually installed.
    const want = settings.value.asr.model;
    const installed = s.models.filter((m) => m.installed);
    if (installed.length && !installed.some((m) => m.id === want) && !(want in downloads.value)) setSetting('asr.model', installed[installed.length - 1].id);
    return s;
  } catch (e) {
    return null;
  }
}

api.on('asr.download', (d) => {
  const next = { ...downloads.value };
  if (d.done) {
    delete next[d.id];
    if (d.error && d.error !== 'cancelled') toast('Model download failed: ' + d.error, 'error', 8000);
    else if (!d.error) {
      setSetting('asr.model', d.id);
      const sp = hostInfo.value.speech || {};
      hostInfo.value = { ...hostInfo.value, speech: { ...sp, models: (sp.models || 0) + 1 } };
      toast('Speech model ready. Transcription now works fully offline.', 'success', 6000);
    }
    refreshAsrStatus();
  } else next[d.id] = { received: d.received, total: d.total };
  downloads.value = next;
});

api.on('asr.level', (d) => {
  if (recorder.value.state === 'idle') return;
  recorder.value = { ...recorder.value, levels: d.levels || {}, pending: d.pending || 0 };
});

api.on('asr.state', (d) => {
  if (d.state === 'running') recorder.value = { ...recorder.value, state: 'running', backend: d.backend, sources: d.sources, started: recorder.value.started || Date.now() };
  else if (d.state === 'loading') recorder.value = { ...recorder.value, state: 'loading' };
  else if (d.state === 'finishing') recorder.value = { ...recorder.value, state: 'finishing', pending: d.pending || 0 };
  else if (d.state === 'stopped') recorder.value = { state: 'idle', levels: {}, pending: 0, target: null };
  else if (d.state === 'warning') toast('Transcription: ' + d.message, 'warning', 6000);
});

api.on('asr.segment', (seg) => appendSegment(seg));

/** Progress of "Transcribe an audio file…" ({stage, done, total, name}). */
export const fileJob = signal(null);
api.on('asr.file', (d) => {
  if (d.stage === 'done') return;
  fileJob.value = { ...(fileJob.value || {}), ...d };
});

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** Turns a voice memo / meeting recording / video into text, offline. */
export async function transcribeFile() {
  if (fileJob.value) { toast('A file is already being transcribed', 'warning'); return; }
  if (recorder.value.state !== 'idle') { toast('Stop the live transcription first', 'warning'); return; }
  const a = settings.value.asr;
  const status = await refreshAsrStatus();
  let model = status && status.models.find((m) => m.id === a.model && m.installed);
  if (!model && status) model = status.models.find((m) => m.installed);
  if (!model) {
    toast('Download a speech model first (one time). After that it works offline.', 'warning', 6000);
    openSettings('transcription');
    return;
  }
  fileJob.value = { stage: 'picking' };
  let r;
  try {
    r = await api.call('asr.transcribeFile', { modelId: model.id, language: a.language, useGpu: a.gpu, prompt: a.prompt || null });
  } catch (e) {
    fileJob.value = null;
    toast('Transcription failed: ' + e.message, 'error', 8000);
    return;
  }
  fileJob.value = null;
  if (!r) return;
  const lines = r.segments.map((x) => (a.timestamps ? `\`${mmss(x.start)}\` ` : '') + x.text);
  const header = `## 🎧 ${r.name}`;
  let key = activeKey.value;
  const tab = activeTab.value;
  if (a.target === 'new' || !key || !tab || tab.missing) {
    const body = header + '\n\n' + lines.join('\n') + '\n';
    const dto = await newNote({ title: `Transcript - ${r.name.replace(/\.[^.]+$/, '')}`, text: body });
    key = dto && dto.path;
  } else {
    await appendText(key, '\n' + header + '\n\n' + lines.join('\n'));
  }
  const speed = r.seconds && r.elapsedMs ? ` (${(r.seconds / (r.elapsedMs / 1000)).toFixed(1)}× real time)` : '';
  toast(`Transcribed ${mmss(r.seconds)} of audio${speed}${r.backend ? ' · ' + r.backend : ''}`, 'success', 7000);
}

function two(n) { return String(n).padStart(2, '0'); }

function formatSegment(seg) {
  const a = settings.value.asr;
  const d = new Date(seg.at || Date.now());
  let line = '';
  if (a.timestamps) line += `\`${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}\` `;
  // Labels only matter when both sources are on (who said what).
  const both = (recorder.value.sources || []).length > 1;
  if (a.labels && both) line += seg.source === 'mic' ? '**Me:** ' : '**Desktop:** ';
  return line + seg.text;
}

async function appendText(key, text) {
  const d = docs.get(key);
  if (d && d.loaded) {
    const view = ed.getView();
    const visible = view && view.state.facet(ed.docRef).key === key;
    const atBottom = visible && view.scrollDOM.scrollHeight - view.scrollDOM.scrollTop - view.scrollDOM.clientHeight < 120;
    const st = d.state;
    const len = st.doc.length;
    const last = len ? st.sliceDoc(len - 1, len) : '\n';
    const insert = (len && last !== '\n' ? '\n' : '') + text + '\n';
    applyToDoc(key, { changes: { from: len, insert }, userEvent: 'input.transcript' });
    if (atBottom) requestAnimationFrame(() => { view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight; });
  } else {
    try { await api.call('note.append', { path: key, text: '\n' + text + '\n' }); } catch (e) { toast('Could not write the transcript: ' + e.message, 'error'); }
  }
}

function appendSegment(seg) {
  const key = recorder.value.target;
  if (!key) return;
  appendText(key, formatSegment(seg));
}

export async function startRecording() {
  if (recorder.value.state !== 'idle') return;
  const a = settings.value.asr;
  if (!a.mic && !a.desktop) {
    toast('Choose a source first: microphone, desktop audio or both', 'warning');
    return;
  }
  const status = await refreshAsrStatus();
  if (!status) { toast('Speech engine not available', 'error'); return; }
  let model = status.models.find((m) => m.id === a.model && m.installed);
  if (!model) {
    model = status.models.find((m) => m.installed);
    if (model) setSetting('asr.model', model.id);
  }
  if (!model) {
    toast('Download a speech model first (one time). After that it works offline.', 'warning', 6000);
    openSettings('transcription');
    return;
  }

  // Where the text goes.
  let key = activeKey.value;
  const tab = activeTab.value;
  const now = new Date();
  const stamp = `${now.toLocaleDateString()} ${two(now.getHours())}:${two(now.getMinutes())}`;
  const md = tab && (tab.ext === 'md' || tab.ext === 'markdown');
  if (a.target === 'new' || !key || !tab || tab.missing) {
    if (!activeWsId.value) { toast('Create a workspace first', 'warning'); return; }
    const dto = await newNote({ title: `Transcript ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`, text: `# 🎙️ Transcript · ${stamp}\n\n` });
    if (!dto) return;
    key = dto.path;
  } else {
    await appendText(key, `\n${md ? '### ' : ''}🎙️ Transcript · ${stamp}`);
  }
  recorder.value = { state: 'loading', levels: {}, pending: 0, target: key, started: 0, backend: null, sources: [] };
  try {
    const r = await api.call('asr.start', {
      modelId: model.id, language: a.language, useGpu: a.gpu, mic: a.mic, desktop: a.desktop,
      micDevice: a.micDevice || null, desktopDevice: a.desktopDevice || null, prompt: a.prompt || null,
    });
    recorder.value = { ...recorder.value, state: 'running', backend: r.backend, started: Date.now() };
    toast(`Transcribing ${a.mic && a.desktop ? 'mic + desktop audio' : a.mic ? 'microphone' : 'desktop audio'} into “${stem(key)}”`, 'success');
  } catch (e) {
    recorder.value = { state: 'idle', levels: {}, pending: 0, target: null };
    toast('Could not start: ' + e.message, 'error', 8000);
  }
}

export async function stopRecording() {
  const st = recorder.value.state;
  if (st !== 'running' && st !== 'loading') return;
  const key = recorder.value.target;
  recorder.value = { ...recorder.value, state: 'finishing' };
  try { await api.call('asr.stop'); } catch (e) { toast(e.message, 'error'); }
  recorder.value = { state: 'idle', levels: {}, pending: 0, target: null };
  if (key) saveDoc(key);
}

export function toggleRecording() {
  if (recorder.value.state === 'idle') startRecording();
  else stopRecording();
}

function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${two(s % 60)}`;
}

function Meter({ value, label, icon }) {
  return (
    <div class="meter" title={label}>
      <Icon name={icon} size={13} />
      <div class="meter-bar"><div style={{ width: `${Math.round((value || 0) * 100)}%` }} /></div>
    </div>
  );
}

const optsOpen = signal(false);

function Seg({ value, options, onChange }) {
  return (
    <div class="seg full">
      {options.map(([v, l]) => <button key={v} class={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label class="toggle-row">
      <span><span class="toggle-label">{label}</span>{hint ? <span class="toggle-hint">{hint}</span> : null}</span>
      <button role="switch" aria-checked={checked} class={'switch' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}><span /></button>
    </label>
  );
}

export { Toggle, Seg };

function RecorderOptions() {
  const a = settings.value.asr;
  const st = asrModels.value;
  const ref = useRef(null);
  const busy = recorder.value.state !== 'idle';
  useEffect(() => {
    refreshAsrStatus();
    const close = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.rec-opts')) optsOpen.value = false; };
    const key = (e) => { if (e.key === 'Escape') optsOpen.value = false; };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); };
  }, []);
  const source = a.mic && a.desktop ? 'both' : a.mic ? 'mic' : 'desktop';
  const installed = st ? st.models.filter((m) => m.installed) : [];
  return (
    <div class="rec-popover" ref={ref}>
      <div class="pop-title">Transcription <span class="muted small">· 100% offline</span></div>
      {busy ? <p class="small warn-text">Changes apply the next time you start.</p> : null}
      <div class="pop-label">Listen to</div>
      <Seg value={source} onChange={(v) => setSetting('asr', { ...a, mic: v !== 'desktop', desktop: v !== 'mic' })}
        options={[['both', 'Mic + Desktop'], ['mic', 'Mic only'], ['desktop', 'Desktop only']]} />
      <div class="pop-label">Language</div>
      <select class="select full" value={a.language} onChange={(e) => setSetting('asr.language', e.currentTarget.value)}>
        {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <div class="pop-label">Speech model</div>
      {installed.length ? (
        <select class="select full" value={a.model} onChange={(e) => setSetting('asr.model', e.currentTarget.value)}>
          {installed.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.sizeMb} MB)</option>)}
        </select>
      ) : <button class="btn small full" onClick={() => { optsOpen.value = false; openSettings('transcription'); }}>Download a model…</button>}
      <div class="pop-label">Write into</div>
      <Seg value={a.target} onChange={(v) => setSetting('asr.target', v)} options={[['current', 'Current note'], ['new', 'New note']]} />
      <Toggle label="Use GPU" hint="Vulkan, light load" checked={a.gpu} onChange={(v) => setSetting('asr.gpu', v)} />
      <Toggle label="Speaker labels" hint="Me / Desktop" checked={a.labels} onChange={(v) => setSetting('asr.labels', v)} />
      <Toggle label="Timestamps" checked={a.timestamps} onChange={(v) => setSetting('asr.timestamps', v)} />
      <button class="btn small full" onClick={() => { optsOpen.value = false; transcribeFile(); }}><Icon name="file" size={14} /> Transcribe an audio/video file…</button>
      <button class="btn link small" onClick={() => { optsOpen.value = false; openSettings('transcription'); }}>Devices, models & more…</button>
    </div>
  );
}

export function RecorderPanel() {
  // The phone has no transcription: its panel shows the sync with the PC instead.
  if (isPhone()) return <PhonePanel openSettings={() => openSettings('menu')} />;
  return <PcRecorderPanel />;
}

function PcRecorderPanel() {
  const rec = recorder.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (rec.state !== 'running') return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [rec.state]);
  const active = rec.state !== 'idle';
  const target = rec.target ? (findNote(rec.target)?.title || stem(rec.target)) : '';
  const job = fileJob.value;
  const mode = recorderButtonMode();
  return (
    <div class="user-panel">
      {optsOpen.value ? <RecorderOptions /> : null}
      {job && job.stage !== 'picking' ? (
        <div class="rec-banner loading">
          <div class="rec-line"><span class="spinner" /> <span class="rec-state">{job.stage === 'decoding' ? 'Reading audio…' : job.stage === 'loading' ? 'Loading model…' : 'Transcribing file…'}</span>
            {job.total && job.done !== undefined ? <span class="rec-time">{Math.round((job.done / job.total) * 100)}%</span> : null}</div>
          {job.name ? <div class="rec-target">{job.name}</div> : null}
          {job.total && job.done !== undefined ? <div class="meter"><div class="meter-bar"><div style={{ width: `${Math.round((job.done / job.total) * 100)}%`, background: 'var(--accent)' }} /></div></div> : null}
        </div>
      ) : null}
      {active ? (
        <div class={'rec-banner ' + rec.state}>
          <div class="rec-line">
            <span class="rec-dot" />
            <span class="rec-state">{rec.state === 'loading' ? 'Loading model…' : rec.state === 'finishing' ? `Finishing${rec.pending ? ` (${rec.pending})` : '…'}` : 'Recording'}</span>
            {rec.state === 'running' && rec.started ? <span class="rec-time">{elapsed(Date.now() - rec.started)}</span> : null}
            {rec.backend ? <span class="chip tiny">{/vulkan|cuda/i.test(rec.backend) ? 'GPU' : 'CPU'}</span> : null}
          </div>
          {target ? <button class="rec-target" onClick={() => openNote(rec.target)} title="Open the transcript">→ {target}</button> : null}
          {rec.state === 'running' ? (
            <div class="meters">
              {rec.levels.mic !== undefined ? <Meter value={rec.levels.mic} label="Microphone" icon="mic" /> : null}
              {rec.levels.desktop !== undefined ? <Meter value={rec.levels.desktop} label="Desktop audio" icon="speaker" /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div class="user-row">
        {mode !== 'hidden' ? (
          <div class={'split-btn' + (mode === 'small' ? ' small' : '') + (active ? ' recording' : '')}>
            <button class="rec-btn" onClick={toggleRecording} disabled={rec.state === 'finishing' || rec.state === 'loading'}
              {...tipProps(active ? 'Stop transcribing (Ctrl+Shift+R)' : 'Start transcribing: mic / desktop audio (Ctrl+Shift+R)', 'right')}>
              <Icon name={active ? 'square' : 'mic'} size={16} />
              {mode === 'large' ? <span>{active ? 'Stop' : 'Transcribe'}</span>
                : active && rec.state === 'running' && rec.started ? <span class="rec-mini-time">{elapsed(Date.now() - rec.started)}</span> : null}
            </button>
            <button class="rec-opts" onClick={() => { optsOpen.value = !optsOpen.value; }} {...tipProps('Recording options', 'right')}>
              <Icon name="chevron-up" size={14} />
            </button>
          </div>
        ) : null}
        <span class="user-row-fill" />
        <button class="icon-btn" onClick={() => openSettings()} {...tipProps('Settings (Ctrl+,)', 'right')}>
          <Icon name="settings" size={18} />
        </button>
      </div>
    </div>
  );
}
