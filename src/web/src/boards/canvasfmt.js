// The JSON Canvas format (.canvas files of Obsidian): parsing and writing it the way Obsidian
// does, so files edited in either app stay byte-identical when nothing changed.

export function parseCanvas(text) {
  const t = (text || '').trim();
  if (!t) return { data: { nodes: [], edges: [] } };
  try {
    const data = JSON.parse(t);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a canvas file');
    if (!Array.isArray(data.nodes)) data.nodes = [];
    if (!Array.isArray(data.edges)) data.edges = [];
    data.nodes = data.nodes.filter((n) => n && typeof n === 'object' && n.id != null);
    data.edges = data.edges.filter((e) => e && typeof e === 'object' && e.id != null);
    // MarkNotes' arrows with a loose end (Obsidian ignores this list).
    if (data.mnEdges !== undefined) {
      if (Array.isArray(data.mnEdges)) data.mnEdges = data.mnEdges.filter((e) => e && typeof e === 'object' && e.id != null);
      if (!Array.isArray(data.mnEdges) || !data.mnEdges.length) delete data.mnEdges;
    }
    for (const n of data.nodes) {
      n.x = +n.x || 0; n.y = +n.y || 0;
      n.width = Math.max(1, +n.width || 250); n.height = Math.max(1, +n.height || 60);
    }
    return { data };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

/** Same layout Obsidian writes: one node/edge per line, tab indentation, no final newline. */
export function stringifyCanvas(data) {
  const clean = (k, v) => (k.startsWith('_') ? undefined : v);
  const keys = Object.keys(data).filter((k) => !k.startsWith('_'));
  const out = ['{'];
  keys.forEach((k, i) => {
    const v = data[k];
    const comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(v)) {
      if (!v.length) out.push(`\t${JSON.stringify(k)}:[]${comma}`);
      else {
        out.push(`\t${JSON.stringify(k)}:[`);
        v.forEach((item, j) => out.push(`\t\t${JSON.stringify(item, clean)}${j < v.length - 1 ? ',' : ''}`));
        out.push(`\t]${comma}`);
      }
    } else out.push(`\t${JSON.stringify(k)}:${JSON.stringify(v, clean)}${comma}`);
  });
  out.push('}');
  return out.join('\n');
}
