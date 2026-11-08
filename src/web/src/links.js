// Resolves [[Note]] / ![[image.png]] the way Obsidian does: an exact path first, otherwise by
// file name anywhere in the workspace, preferring the match closest to the current note.
// The list of non-note files is fetched lazily per workspace, never at startup.

import * as api from './api.js';
import { notesByWs, wsForPath } from './store.js';
import { dirname, joinPath, isAbs, FILES_HOST } from './util.js';

const files = new Map(); // wsId -> { list: string[] | null, loading: Promise | null, at: number }
const nameIndex = new Map(); // wsId -> { notesRef, filesRef, map }
const listeners = new Set();
const changed = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } } };

/** Calls fn whenever a workspace's file list arrives or changes; returns an unsubscribe function. */
export function onLinksChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadFiles(wsId, force = false) {
  let f = files.get(wsId);
  if (f && (f.loading || (!force && Date.now() - f.at < 20000))) return f.loading || Promise.resolve(f.list);
  if (!f) {
    f = { list: null, loading: null, at: 0 };
    files.set(wsId, f);
  }
  f.loading = api.call('ws.files', { id: wsId }).then((list) => {
    f.list = list || [];
    f.at = Date.now();
    f.loading = null;
    changed();
    return f.list;
  }).catch(() => {
    f.loading = null;
    f.list = f.list || [];
    f.at = Date.now();
    return f.list;
  });
  return f.loading;
}

export function invalidateFiles(wsId) {
  const f = files.get(wsId);
  if (f) f.at = 0;
}

function indexFor(ws) {
  const notes = notesByWs.peek()[ws.id] || [];
  const f = files.get(ws.id);
  const fl = f ? f.list : null;
  const cached = nameIndex.get(ws.id);
  if (cached && cached.notesRef === notes && cached.filesRef === fl) return cached.map;
  const map = new Map();
  const add = (name, path) => {
    const k = name.toLowerCase();
    let a = map.get(k);
    if (!a) map.set(k, (a = []));
    a.push(path);
  };
  for (const n of notes) {
    const base = n.path.slice(n.path.lastIndexOf('/') + 1);
    add(base, n.path);
    if (/\.md$/i.test(base)) add(base.slice(0, -3), n.path);
  }
  if (fl) for (const rel of fl) add(rel.slice(rel.lastIndexOf('/') + 1), `${ws.dir}/${rel}`);
  nameIndex.set(ws.id, { notesRef: notes, filesRef: fl, map });
  return map;
}

function common(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Returns {path} (null when nothing matches) or {pending:true} while the workspace's file
 * list is still loading.
 */
export function resolveName(fromKey, target) {
  target = (target || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!target) return { path: null };
  const ws = wsForPath(fromKey);
  if (!ws) {
    if (isAbs(fromKey)) return { path: joinPath(dirname(fromKey), target), guess: true };
    return { path: null };
  }
  const f = files.get(ws.id);
  if (!f || !f.list) loadFiles(ws.id);
  const map = indexFor(ws);
  const base = target.slice(target.lastIndexOf('/') + 1);
  let cands = map.get(base.toLowerCase()) || [];
  if (!cands.length && !/\.[a-z0-9]{1,5}$/i.test(base)) cands = map.get(`${base}.md`.toLowerCase()) || [];
  if (target.includes('/')) {
    const t = target.toLowerCase();
    const filtered = cands.filter((p) => p.toLowerCase().endsWith('/' + t) || p.toLowerCase().endsWith('/' + t + '.md'));
    if (filtered.length) cands = filtered;
  }
  if (!cands.length) {
    const pending = !f || !f.list || !notesByWs.peek()[ws.id];
    return pending ? { pending: true } : { path: null };
  }
  if (cands.length === 1) return { path: cands[0] };
  const from = (dirname(fromKey) + '/').toLowerCase();
  const best = cands.slice().sort((a, b) =>
    common(b.toLowerCase(), from) - common(a.toLowerCase(), from) ||
    a.split('/').length - b.split('/').length ||
    a.length - b.length)[0];
  return { path: best };
}

/** URL the WebView can load for a note/workspace path (relative "Ws/…", "@id/…" or absolute). */
export function fileUrl(path) {
  const enc = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  return `${FILES_HOST}/${isAbs(path) ? 'a' : 'r'}/${enc}`;
}

/** Strips "![[a.jpg|x]]", "[[a.jpg]]", "[t](a.jpg)", quotes → "a.jpg"; null for web URLs. */
export function cleanTarget(raw) {
  let s = String(raw || '').trim().replace(/^["']|["']$/g, '').trim();
  let wiki = false;
  if (s.startsWith('!')) s = s.slice(1);
  if (s.startsWith('[[') && s.endsWith(']]')) {
    s = s.slice(2, -2);
    wiki = true;
  } else {
    const md = /^\[[^\]]*\]\((.+)\)$/.exec(s);
    if (md) s = md[1].replace(/^<|>$/g, '');
  }
  s = s.split('|')[0].split('#')[0].trim();
  if (!s || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  return { target: s, wiki };
}
