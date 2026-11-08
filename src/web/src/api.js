// Bridge to the native host. Requests: {id, cmd, args} → {id, ok, result|error}. Events from the host: {event, data}.
// Windows: WebView2's chrome.webview. Android: the app's MarkNotesAndroid object (postMessage with JSON text); the app
// answers through window.__mnHost(message).

const wv = window.chrome && window.chrome.webview;
const droid = !wv && window.MarkNotesAndroid ? window.MarkNotesAndroid : null;
const pending = new Map();
const listeners = new Map();
const callHooks = new Set();
let seq = 0;

export const hasHost = !!(wv || droid);

function receive(m) {
  if (!m || typeof m !== 'object') return;
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || 'Unknown error'));
  } else if (m.event) {
    const set = listeners.get(m.event);
    if (set) for (const fn of [...set]) {
      try { fn(m.data); } catch (err) { console.error(err); }
    }
  }
}

if (wv) wv.addEventListener('message', (e) => receive(e.data));
if (droid) window.__mnHost = receive;

export function call(cmd, args) {
  if (!wv && !droid) return Promise.reject(new Error('MarkNotes host not available'));
  for (const fn of callHooks) {
    try { fn(cmd, args); } catch (err) { console.error(err); }
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    const msg = { id, cmd, args: args ?? {} };
    if (wv) wv.postMessage(msg);
    else droid.postMessage(JSON.stringify(msg));
  });
}

/** Called with (cmd, args) before every command is sent (the phone schedules a sync after edits). */
export function onCall(fn) {
  callHooks.add(fn);
  return () => callHooks.delete(fn);
}

/** Sends File objects (from drag & drop) so the host can read their real paths. */
export function dropFiles(files) {
  if (!wv || !wv.postMessageWithAdditionalObjects) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    wv.postMessageWithAdditionalObjects({ id, cmd: 'drop.files', args: {} }, files);
  });
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
