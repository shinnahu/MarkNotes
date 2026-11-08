// Kanban board for notes in the Obsidian Kanban format (see boards/kanbanmd.js).
// The note's text stays the single source of truth: every change is written back to the
// document (so autosave, undo/redo and "Edit as text" just work), and edits made elsewhere
// (undo, the text view, another program) re-render the board.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseBoard, serializeBoard, cloneBoard, cardHtml, cardTags, tagHtml, archiveItems, cardPlain } from '../boards/kanbanmd.js';
import { getDocText, setDocText, watchDoc, openWiki, openLink, resolveImage, openNote } from '../docs.js';
import * as ed from '../editor/editor.js';
import { resolveName, onLinksChanged } from '../links.js';
import { wsForPath, findNote, upsertNote, toast } from '../store.js';
import { openMenu } from './menu.jsx';
import { confirm } from './dialogs.jsx';
import { Icon } from './icons.jsx';
import * as api from '../api.js';

const DEFAULTS = { 'show-checkboxes': true, 'move-tags': false, 'lane-width': 272, 'new-note-folder': '' };
const globalCfg = new Map(); // wsId -> plugin settings of an Obsidian vault (data.json)

async function loadGlobalCfg(ws) {
  if (!ws || !ws.linked) return null;
  if (globalCfg.has(ws.id)) return globalCfg.get(ws.id);
  let cfg = null;
  try {
    const r = await api.call('note.read', { path: `${ws.dir}/.obsidian/plugins/obsidian-kanban/data.json` });
    cfg = JSON.parse(r.text);
  } catch { cfg = null; }
  globalCfg.set(ws.id, cfg);
  return cfg;
}

const isChecked = (it) => it.check !== null && it.check !== ' ';

export default function KanbanView({ docKey }) {
  const [board, setBoard] = useState(() => parseBoard(getDocText(docKey) || ''));
  const [global, setGlobal] = useState(null);
  const [editing, setEditing] = useState(null); // {lane, index} | {lane, index:-1} for a new card
  const [renaming, setRenaming] = useState(-1);
  const [addingLane, setAddingLane] = useState(false);
  const [drop, setDrop] = useState(null); // {lane, index} | {laneAt}
  const [, bump] = useState(0);
  const drag = useRef(null);
  const root = useRef(null);
  const ws = wsForPath(docKey);

  useEffect(() => {
    setBoard(parseBoard(getDocText(docKey) || ''));
    const off1 = watchDoc(docKey, () => setBoard(parseBoard(getDocText(docKey) || '')));
    const off2 = onLinksChanged(() => bump((x) => x + 1));
    root.current && root.current.focus({ preventScroll: true });
    return () => { off1(); off2(); };
  }, [docKey]);
  useEffect(() => { loadGlobalCfg(ws).then(setGlobal); }, [ws && ws.id]);

  const cfg = useMemo(() => {
    const c = { ...DEFAULTS, ...(global || {}), ...(board.settings || {}) };
    const colors = new Map();
    for (const t of [...((global && global['tag-colors']) || []), ...((board.settings && board.settings['tag-colors']) || [])]) {
      if (t && t.tagKey) colors.set(t.tagKey.toLowerCase(), t);
    }
    c.colors = colors;
    return c;
  }, [global, board.settings]);

  const opts = {
    hideTags: !!cfg['move-tags'],
    tagStyle: (tag) => {
      const t = cfg.colors.get(tag.toLowerCase());
      return t ? `color:${t.color || 'inherit'};background:${t.backgroundColor || 'transparent'}` : '';
    },
    image: (target) => resolveImage(docKey, target, true),
  };

  /** Applies a change: fn mutates a copy of the latest board. */
  const latest = useRef(board);
  latest.current = board;
  const change = (fn) => {
    const next = cloneBoard(latest.current);
    if (fn(next) === false) return;
    latest.current = next;
    setBoard(next);
    setDocText(docKey, serializeBoard(next));
  };

  const setCheckForLane = (lane, it) => {
    if (it.check === null) return;
    if (lane.complete) it.check = it.check === ' ' ? 'x' : it.check;
    else if (isChecked(it)) it.check = ' ';
  };

  const moveCard = (from, to) => change((b) => {
    const src = b.lanes[from.lane];
    const [it] = src.items.splice(from.index, 1);
    if (!it) return false;
    let index = to.index;
    if (from.lane === to.lane && from.index < index) index--;
    const dst = b.lanes[to.lane];
    if (from.lane !== to.lane) setCheckForLane(dst, it);
    dst.items.splice(Math.max(0, Math.min(index, dst.items.length)), 0, it);
  });

  const moveLane = (from, to) => change((b) => {
    const [l] = b.lanes.splice(from, 1);
    let at = to;
    if (from < to) at--;
    b.lanes.splice(at, 0, l);
    const col = b.settings && b.settings['list-collapse'];
    if (Array.isArray(col)) {
      const [c] = col.splice(from, 1);
      col.splice(at, 0, c ?? false);
    }
  });

  const collapsed = (i) => !!(board.settings && Array.isArray(board.settings['list-collapse']) && board.settings['list-collapse'][i]);
  const toggleCollapse = (i) => change((b) => {
    b.settings = b.settings || { 'kanban-plugin': 'board' };
    const col = Array.isArray(b.settings['list-collapse']) ? b.settings['list-collapse'] : [];
    while (col.length < b.lanes.length) col.push(false);
    col[i] = !col[i];
    b.settings['list-collapse'] = col;
  });

  const onLinkClick = (e) => {
    const w = e.target.closest('[data-wiki]');
    if (w) {
      e.preventDefault();
      e.stopPropagation();
      const target = w.getAttribute('data-wiki');
      const r = resolveName(docKey, target);
      if (r.path) openWiki(target, r.path, docKey);
      else createLinkedNote(target, false);
      return true;
    }
    const a = e.target.closest('[data-href]');
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      openLink(a.getAttribute('data-href'), docKey);
      return true;
    }
    return false;
  };

  /** Creates the note a card links to (in the plugin's "new note folder" when set). */
  const createLinkedNote = async (title, replaceIn) => {
    if (!ws) return;
    const folder = cfg['new-note-folder'] || (findNote(docKey) || {}).folder || '';
    try {
      const dto = await api.call('note.create', { wsId: ws.id, folder, title, ext: 'md', text: '', autoTitle: false });
      upsertNote(dto);
      if (replaceIn) {
        change((b) => {
          const it = b.lanes[replaceIn.lane].items[replaceIn.index];
          const tags = cardTags(it.text);
          it.text = `${tags.join(' ')} [[${dto.title}]]`.trim();
        });
        toast(`Note “${dto.title}” created`, 'success', 4000, { label: 'Open', run: () => openNote(dto.path) });
      } else openNote(dto.path);
    } catch (e) { toast('Could not create the note: ' + e.message, 'error'); }
  };

  const cardMenu = (e, li, ii) => {
    e.preventDefault();
    const it = board.lanes[li].items[ii];
    const wiki = /\[\[([^\]|#]+)/.exec(it.text);
    openMenu(e.clientX, e.clientY, [
      { label: 'Edit card', icon: 'pencil', run: () => setEditing({ lane: li, index: ii }) },
      wiki && { label: 'Open linked note', icon: 'file-text', run: () => { const r = resolveName(docKey, wiki[1].trim()); if (r.path) openWiki(wiki[1].trim(), r.path, docKey); else createLinkedNote(wiki[1].trim(), false); } },
      !wiki && { label: 'New note from card', icon: 'file-plus', run: () => createLinkedNote(cardPlain(it.text.replace(/#[^\s#]+/g, '')) || 'Card', { lane: li, index: ii }) },
      { sep: true },
      ...board.lanes.map((l, i) => i !== li && { label: `Move to “${l.title}”`, icon: 'arrow-right', run: () => moveCard({ lane: li, index: ii }, { lane: i, index: board.lanes[i].items.length }) }),
      { label: 'Duplicate', icon: 'copy', run: () => change((b) => { b.lanes[li].items.splice(ii + 1, 0, { ...b.lanes[li].items[ii] }); }) },
      { label: 'Archive card', icon: 'download', run: () => change((b) => { const [x] = b.lanes[li].items.splice(ii, 1); archiveItems(b, [x]); }) },
      { sep: true },
      { label: 'Delete card', icon: 'trash', danger: true, run: () => change((b) => { b.lanes[li].items.splice(ii, 1); }) },
    ]);
  };

  const laneMenu = (e, li) => {
    const r = e.currentTarget.getBoundingClientRect();
    const lane = board.lanes[li];
    const done = lane.items.filter(isChecked);
    openMenu(r.right, r.bottom + 4, [
      { label: 'Add a card', icon: 'plus', run: () => setEditing({ lane: li, index: -1 }) },
      { label: 'Rename list', icon: 'pencil', run: () => setRenaming(li) },
      { label: collapsed(li) ? 'Expand list' : 'Collapse list', icon: 'chevron-right', run: () => toggleCollapse(li) },
      { label: 'Mark cards in this list as complete', checked: lane.complete, run: () => change((b) => { b.lanes[li].complete = !b.lanes[li].complete; }) },
      done.length && { label: `Archive completed cards (${done.length})`, icon: 'download', run: () => change((b) => { const l = b.lanes[li]; archiveItems(b, l.items.filter(isChecked)); l.items = l.items.filter((x) => !isChecked(x)); }) },
      { sep: true },
      {
        label: 'Delete list', icon: 'trash', danger: true, run: async () => {
          if (lane.items.length && !(await confirm({ title: `Delete “${lane.title}”?`, body: `Its ${lane.items.length} card${lane.items.length === 1 ? '' : 's'} will be removed from the board (Ctrl+Z brings them back).`, ok: 'Delete list', danger: true }))) return;
          change((b) => {
            b.lanes.splice(li, 1);
            if (b.settings && Array.isArray(b.settings['list-collapse'])) b.settings['list-collapse'].splice(li, 1);
          });
        },
      },
    ], { anchorRight: true, minWidth: 240 });
  };

  // ── drag & drop ──
  const cardIndexAt = (container, y) => {
    const cards = [...container.querySelectorAll(':scope > .kb-card')];
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return cards.length;
  };
  const laneIndexAt = (x) => {
    const lanes = [...root.current.querySelectorAll('.kb-lane')];
    for (let i = 0; i < lanes.length; i++) {
      const r = lanes[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return lanes.length;
  };
  const onItemsOver = (e, li) => {
    const t = e.dataTransfer.types;
    if (drag.current && drag.current.type === 'lane') return;
    if (!(drag.current && drag.current.type === 'card') && !t.includes('application/x-mn-note')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = drag.current ? 'move' : 'copy';
    const index = cardIndexAt(e.currentTarget, e.clientY);
    if (!drop || drop.lane !== li || drop.index !== index) setDrop({ lane: li, index });
  };
  const onItemsDrop = (e, li) => {
    e.preventDefault();
    e.stopPropagation();
    const index = cardIndexAt(e.currentTarget, e.clientY);
    setDrop(null);
    const d = drag.current;
    drag.current = null;
    if (d && d.type === 'card') { moveCard(d.from, { lane: li, index }); return; }
    const path = e.dataTransfer.getData('application/x-mn-note');
    if (path) {
      const n = findNote(path);
      const name = n ? n.title : path.split('/').pop().replace(/\.md$/i, '');
      change((b) => {
        const it = { check: ' ', text: `[[${name}]]` };
        setCheckForLane(b.lanes[li], it);
        b.lanes[li].items.splice(index, 0, it);
      });
    }
  };
  const onBoardOver = (e) => {
    if (!drag.current || drag.current.type !== 'lane') return;
    e.preventDefault();
    const at = laneIndexAt(e.clientX);
    if (!drop || drop.laneAt !== at) setDrop({ laneAt: at });
  };
  const onBoardDrop = (e) => {
    const d = drag.current;
    if (!d || d.type !== 'lane') return;
    e.preventDefault();
    const at = laneIndexAt(e.clientX);
    setDrop(null);
    drag.current = null;
    if (at !== d.from && at !== d.from + 1) moveLane(d.from, at);
  };
  const endDrag = () => { drag.current = null; setDrop(null); };

  const onKeyDown = (e) => {
    if (e.target.closest('textarea, input')) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && (k === 'z' || k === 'y')) {
      e.preventDefault();
      e.stopPropagation();
      if (k === 'y' || e.shiftKey) ed.editorRedo(); else ed.editorUndo();
    }
  };

  const laneWidth = Math.max(200, Math.min(600, +cfg['lane-width'] || 272));

  return (
    <div class="kb-board" ref={root} tabIndex={-1} onKeyDown={onKeyDown} style={{ '--kb-lane-w': `${laneWidth}px` }}
      onDragOver={onBoardOver} onDrop={onBoardDrop}
      onClick={(e) => { onLinkClick(e); }}>
      {board.lanes.map((lane, li) => {
        const isCol = collapsed(li);
        const laneDrop = drop && drop.laneAt === li;
        return (
          <section key={li + ':' + lane.rawTitle} class={'kb-lane' + (isCol ? ' collapsed' : '') + (laneDrop ? ' drop-before' : '') + (lane.complete ? ' complete' : '')}>
            <header class="kb-lane-head" draggable={renaming !== li}
              onDragStart={(e) => { drag.current = { type: 'lane', from: li }; e.dataTransfer.setData('application/x-mn-lane', String(li)); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={endDrag}
              onDblClick={() => setRenaming(li)}>
              <button class="kb-icon-btn" title={isCol ? 'Expand list' : 'Collapse list'} onClick={() => toggleCollapse(li)}>
                <Icon name="chevron-right" size={14} class={isCol ? '' : 'rot90'} />
              </button>
              {renaming === li ? (
                <input class="kb-lane-input" value={lane.title} ref={(el) => el && !el.dataset.f && (el.dataset.f = '1', el.focus(), el.select())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { e.currentTarget.dataset.cancel = '1'; e.currentTarget.blur(); }
                  }}
                  onBlur={(e) => {
                    const v = e.currentTarget.value.trim();
                    setRenaming(-1);
                    if (!e.currentTarget.dataset.cancel && v && v !== lane.title) change((b) => { b.lanes[li].rawTitle = v; b.lanes[li].title = v; });
                  }} />
              ) : (
                <h3 class="kb-lane-title" title={lane.title}>{lane.title}</h3>
              )}
              <span class="kb-count">{lane.items.length}</span>
              {lane.complete ? <Icon name="check" size={14} class="kb-complete-ic" title="Cards moved here are marked complete" /> : null}
              <button class="kb-icon-btn" title="List actions" onClick={(e) => laneMenu(e, li)}><Icon name="more" size={16} /></button>
            </header>
            {isCol ? null : (
              <>
                <div class="kb-items" onDragOver={(e) => onItemsOver(e, li)} onDrop={(e) => onItemsDrop(e, li)}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrop(null); }}>
                  {lane.items.map((it, ii) => {
                    const ph = drop && drop.lane === li && drop.index === ii ? <div key={'ph' + ii} class="kb-drop-ph" /> : null;
                    if (editing && editing.lane === li && editing.index === ii) {
                      return [ph, <CardEditor key={ii} value={it.text}
                        onDone={(v) => {
                          setEditing(null);
                          if (v === null || v === it.text) return;
                          change((b) => { if (v.trim()) b.lanes[li].items[ii].text = v; else b.lanes[li].items.splice(ii, 1); });
                        }} />];
                    }
                    const checked = isChecked(it);
                    const tags = cfg['move-tags'] ? cardTags(it.text) : [];
                    return [ph, (
                      <div key={ii} class={'kb-card' + (checked ? ' done' : '')} draggable
                        onDragStart={(e) => { drag.current = { type: 'card', from: { lane: li, index: ii } }; e.dataTransfer.setData('application/x-mn-card', '1'); e.dataTransfer.setData('text/plain', it.text); e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); }}
                        onDragEnd={endDrag}
                        onDblClick={(e) => { if (!e.target.closest('a, button')) setEditing({ lane: li, index: ii }); }}
                        onContextMenu={(e) => cardMenu(e, li, ii)}>
                        {cfg['show-checkboxes'] && it.check !== null ? (
                          <button class={'kb-check' + (checked ? ' on' : '')} title={checked ? 'Mark as not done' : 'Mark as done'}
                            onClick={(e) => { e.stopPropagation(); change((b) => { b.lanes[li].items[ii].check = checked ? ' ' : 'x'; }); }} />
                        ) : null}
                        <div class="kb-card-main">
                          <div class="kb-card-body" dangerouslySetInnerHTML={{ __html: cardHtml(it.text, opts) || '&nbsp;' }} />
                          {tags.length ? <div class="kb-tags" dangerouslySetInnerHTML={{ __html: tags.map((t) => tagHtml(t, opts)).join('') }} /> : null}
                        </div>
                        <button class="kb-card-more" title="Card actions" onClick={(e) => { e.stopPropagation(); cardMenu(e, li, ii); }}><Icon name="more" size={14} /></button>
                      </div>
                    )];
                  })}
                  {drop && drop.lane === li && drop.index >= lane.items.length ? <div class="kb-drop-ph" /> : null}
                  {!lane.items.length && !(editing && editing.lane === li) ? <div class="kb-empty">Drop cards here</div> : null}
                </div>
                {editing && editing.lane === li && editing.index === -1 ? (
                  <CardEditor value="" adding onDone={(v, keepOpen) => {
                    if (v && v.trim()) {
                      change((b) => {
                        const it = { check: ' ', text: v.trim() };
                        setCheckForLane(b.lanes[li], it);
                        b.lanes[li].items.push(it);
                      });
                    }
                    setEditing(keepOpen && v && v.trim() ? { lane: li, index: -1, n: Date.now() } : null);
                  }} key={'add' + (editing.n || 0)} />
                ) : (
                  <button class="kb-add" onClick={() => setEditing({ lane: li, index: -1 })}><Icon name="plus" size={15} /> Add a card</button>
                )}
              </>
            )}
          </section>
        );
      })}
      {drop && drop.laneAt === board.lanes.length ? <div class="kb-lane-ph" /> : null}
      <div class="kb-new-lane">
        {addingLane ? (
          <input class="kb-lane-input" placeholder="List name…" ref={(el) => el && !el.dataset.f && (el.dataset.f = '1', el.focus())}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAddingLane(false);
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim();
                if (v) change((b) => { b.lanes.push({ title: v, rawTitle: v, complete: false, items: [], extra: [] }); });
                e.currentTarget.value = '';
              }
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v) change((b) => { b.lanes.push({ title: v, rawTitle: v, complete: false, items: [], extra: [] }); });
              setAddingLane(false);
            }} />
        ) : (
          <button class="kb-add lane" onClick={() => setAddingLane(true)}><Icon name="plus" size={15} /> Add a list</button>
        )}
      </div>
    </div>
  );
}

function CardEditor({ value, onDone, adding }) {
  const ref = useRef(null);
  const done = useRef(false);
  const fit = (el) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`; };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    fit(el);
  }, []);
  const finish = (v, keepOpen = false) => {
    if (done.current) return;
    done.current = true;
    onDone(v, keepOpen);
  };
  return (
    <div class="kb-card editing">
      <textarea ref={ref} class="kb-editor" defaultValue={value} rows={1}
        placeholder={adding ? 'Card text… ([[links]], #tags) · Enter to add' : ''}
        onInput={(e) => fit(e.currentTarget)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); finish(adding ? null : null); }
          else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(e.currentTarget.value, adding); }
        }}
        onBlur={(e) => finish(e.currentTarget.value)} />
    </div>
  );
}
