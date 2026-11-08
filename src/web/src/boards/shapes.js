// Diagram shapes for canvases (like Miro's): a text card with `mnShape` set is drawn as that shape with its text
// inside. Obsidian ignores the key and shows the same card as a plain text card, so nothing is lost there.
// Outlines are computed for the card's real size, so strokes and corners never stretch.

const SVGNS = 'http://www.w3.org/2000/svg';
const f = (v) => +v.toFixed(1);

/** id, name, default size, text inset (CSS padding inside the card), group. */
export const SHAPES = [
  { id: 'rect', name: 'Rectangle', w: 200, h: 120, pad: '10px 14px', group: 'basic', key: 'R' },
  { id: 'rounded', name: 'Rounded rectangle', w: 200, h: 120, pad: '10px 16px', group: 'basic' },
  { id: 'oval', name: 'Oval', w: 160, h: 120, pad: '16% 18%', group: 'basic', key: 'O' },
  { id: 'triangle', name: 'Triangle', w: 160, h: 140, pad: '42% 24% 8%', group: 'basic' },
  { id: 'rhombus', name: 'Rhombus', w: 170, h: 140, pad: '24% 26%', group: 'basic' },
  { id: 'bubble', name: 'Speech bubble', w: 200, h: 140, pad: '10px 16px 28%', group: 'basic' },
  { id: 'parallelogram', name: 'Parallelogram', w: 200, h: 110, pad: '10px 22%', group: 'basic' },
  { id: 'star', name: 'Star', w: 160, h: 150, pad: '34% 30% 26%', group: 'basic' },
  { id: 'arrow-right', name: 'Block arrow', w: 200, h: 110, pad: '10% 34% 10% 10px', group: 'basic' },
  { id: 'arrow-left', name: 'Left arrow', w: 200, h: 110, pad: '10% 10px 10% 34%', group: 'basic' },
  { id: 'arrow-both', name: 'Double arrow', w: 220, h: 110, pad: '10% 26%', group: 'basic' },
  { id: 'pentagon', name: 'Pentagon', w: 160, h: 150, pad: '30% 18% 10%', group: 'basic' },
  { id: 'hexagon', name: 'Hexagon', w: 190, h: 130, pad: '10px 24%', group: 'basic' },
  { id: 'octagon', name: 'Octagon', w: 160, h: 160, pad: '18%', group: 'basic' },
  { id: 'trapezoid', name: 'Trapezoid', w: 200, h: 120, pad: '10px 22%', group: 'basic' },
  { id: 'cloud', name: 'Cloud', w: 200, h: 140, pad: '22% 20%', group: 'basic' },
  { id: 'cross', name: 'Cross', w: 150, h: 150, pad: '34%', group: 'basic' },
  { id: 'cylinder', name: 'Cylinder', w: 130, h: 160, pad: '30% 12px 12%', group: 'basic' },
  { id: 'chevron', name: 'Chevron', w: 200, h: 110, pad: '10px 30%', group: 'basic' },
  { id: 'tag', name: 'Tag', w: 200, h: 110, pad: '10px 28% 10px 14px', group: 'basic' },
  { id: 'terminator', name: 'Start / end', w: 200, h: 90, pad: '10px 22%', group: 'flowchart' },
  { id: 'document', name: 'Document', w: 200, h: 130, pad: '10px 14px 20%', group: 'flowchart' },
  { id: 'predefined', name: 'Predefined process', w: 210, h: 120, pad: '10px 15%', group: 'flowchart' },
  { id: 'manual', name: 'Manual input', w: 200, h: 120, pad: '28% 14px 10px', group: 'flowchart' },
  { id: 'delay', name: 'Delay', w: 190, h: 120, pad: '10px 26% 10px 14px', group: 'flowchart' },
  { id: 'database', name: 'Database', w: 140, h: 150, pad: '30% 12px 12%', group: 'flowchart' },
];

export const SHAPE = new Map(SHAPES.map((s) => [s.id, s]));
export const isShape = (n) => !!(n && n.type === 'text' && SHAPE.has(n.mnShape));

/** The outline of shape `id` in a w × h box (SVG path, a little inside so the stroke is not cut). */
export function shapePath(id, w, h) {
  const s = 1.5;
  const W = w - s;
  const H = h - s;
  const cx = w / 2;
  const cy = h / 2;
  const P = (pts) => 'M' + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z';
  const roundRect = (r) => {
    r = Math.min(r, (W - s) / 2, (H - s) / 2);
    return `M${f(s + r)} ${f(s)}H${f(W - r)}A${f(r)} ${f(r)} 0 0 1 ${f(W)} ${f(s + r)}V${f(H - r)}A${f(r)} ${f(r)} 0 0 1 ${f(W - r)} ${f(H)}H${f(s + r)}A${f(r)} ${f(r)} 0 0 1 ${f(s)} ${f(H - r)}V${f(s + r)}A${f(r)} ${f(r)} 0 0 1 ${f(s + r)} ${f(s)}Z`;
  };
  switch (id) {
    case 'rect': return P([[s, s], [W, s], [W, H], [s, H]]);
    case 'rounded': return roundRect(Math.min(18, Math.min(w, h) * 0.18));
    case 'terminator': return roundRect(h / 2);
    case 'oval': {
      const rx = cx - s;
      const ry = cy - s;
      return `M${f(s)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(W)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(s)} ${f(cy)}Z`;
    }
    case 'triangle': return P([[cx, s], [W, H], [s, H]]);
    case 'rhombus': return P([[cx, s], [W, cy], [cx, H], [s, cy]]);
    case 'parallelogram': { const k = Math.min(w * 0.22, h * 0.7); return P([[s + k, s], [W, s], [W - k, H], [s, H]]); }
    case 'trapezoid': { const k = Math.min(w * 0.2, h * 0.7); return P([[s + k, s], [W - k, s], [W, H], [s, H]]); }
    case 'hexagon': { const k = Math.min(w * 0.22, h * 0.5); return P([[s + k, s], [W - k, s], [W, cy], [W - k, H], [s + k, H], [s, cy]]); }
    case 'octagon': {
      const kx = w * 0.29;
      const ky = h * 0.29;
      return P([[s + kx, s], [W - kx, s], [W, s + ky], [W, H - ky], [W - kx, H], [s + kx, H], [s, H - ky], [s, s + ky]]);
    }
    case 'pentagon': return P([[cx, s], [W, h * 0.38], [w * 0.81, H], [w * 0.19, H], [s, h * 0.38]]);
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.42 : 1;
        pts.push([cx + Math.cos(a) * (cx - s) * r, h * 0.54 + Math.sin(a) * (h * 0.54 - s) * r]);
      }
      return P(pts);
    }
    case 'arrow-right': {
      const head = Math.min(w * 0.42, h);
      return P([[s, h * 0.3], [W - head, h * 0.3], [W - head, s], [W, cy], [W - head, H], [W - head, h * 0.7], [s, h * 0.7]]);
    }
    case 'arrow-left': {
      const head = Math.min(w * 0.42, h);
      return P([[W, h * 0.3], [s + head, h * 0.3], [s + head, s], [s, cy], [s + head, H], [s + head, h * 0.7], [W, h * 0.7]]);
    }
    case 'arrow-both': {
      const head = Math.min(w * 0.3, h);
      return P([[s, cy], [s + head, s], [s + head, h * 0.3], [W - head, h * 0.3], [W - head, s], [W, cy], [W - head, H], [W - head, h * 0.7], [s + head, h * 0.7], [s + head, H]]);
    }
    case 'chevron': { const k = Math.min(w * 0.3, h * 0.5); return P([[s, s], [W - k, s], [W, cy], [W - k, H], [s, H], [s + k, cy]]); }
    case 'tag': { const k = Math.min(w * 0.28, h * 0.5); return P([[s, s], [W - k, s], [W, cy], [W - k, H], [s, H]]); }
    case 'cross': {
      const tx = w * 0.32;
      const ty = h * 0.32;
      return P([[tx, s], [w - tx, s], [w - tx, ty], [W, ty], [W, h - ty], [w - tx, h - ty], [w - tx, H], [tx, H], [tx, h - ty], [s, h - ty], [s, ty], [tx, ty]]);
    }
    case 'bubble': {
      const b = h * 0.76;
      const r = Math.min(16, Math.min(w, b) * 0.2);
      return `M${f(s + r)} ${f(s)}H${f(W - r)}A${f(r)} ${f(r)} 0 0 1 ${f(W)} ${f(s + r)}V${f(b - r)}A${f(r)} ${f(r)} 0 0 1 ${f(W - r)} ${f(b)}H${f(w * 0.38)}L${f(w * 0.17)} ${f(H)}L${f(w * 0.22)} ${f(b)}H${f(s + r)}A${f(r)} ${f(r)} 0 0 1 ${f(s)} ${f(b - r)}V${f(s + r)}A${f(r)} ${f(r)} 0 0 1 ${f(s + r)} ${f(s)}Z`;
    }
    case 'cloud': {
      // bumps drawn in a 100 × 100 box, then sized to the card
      const X = (v) => f(s + (v / 100) * (W - s));
      const Y = (v) => f(s + (v / 100) * (H - s));
      return `M${X(24)} ${Y(92)}C${X(6)} ${Y(92)} ${X(-1)} ${Y(72)} ${X(9)} ${Y(60)}C${X(-2)} ${Y(46)} ${X(8)} ${Y(26)} ${X(25)} ${Y(30)}`
        + `C${X(28)} ${Y(8)} ${X(52)} ${Y(2)} ${X(60)} ${Y(18)}C${X(70)} ${Y(4)} ${X(94)} ${Y(12)} ${X(90)} ${Y(34)}`
        + `C${X(103)} ${Y(42)} ${X(102)} ${Y(66)} ${X(88)} ${Y(72)}C${X(92)} ${Y(90)} ${X(72)} ${Y(98)} ${X(62)} ${Y(88)}C${X(52)} ${Y(100)} ${X(30)} ${Y(100)} ${X(24)} ${Y(92)}Z`;
    }
    case 'cylinder':
    case 'database': {
      const ry = Math.min(h * 0.13, 20);
      const rx = cx - s;
      return `M${f(s)} ${f(s + ry)}V${f(H - ry)}A${f(rx)} ${f(ry)} 0 0 0 ${f(W)} ${f(H - ry)}V${f(s + ry)}`
        + `M${f(s)} ${f(s + ry)}A${f(rx)} ${f(ry)} 0 1 0 ${f(W)} ${f(s + ry)}A${f(rx)} ${f(ry)} 0 1 0 ${f(s)} ${f(s + ry)}Z`;
    }
    case 'document': {
      const b = h * 0.82;
      return `M${f(s)} ${f(s)}H${f(W)}V${f(b)}C${f(w * 0.75)} ${f(h * 0.68)} ${f(w * 0.55)} ${f(h * 1.04)} ${f(w * 0.3)} ${f(h * 0.9)}C${f(w * 0.18)} ${f(h * 0.84)} ${f(w * 0.08)} ${f(h * 0.82)} ${f(s)} ${f(b)}Z`;
    }
    case 'predefined': {
      const k = Math.min(w * 0.1, 16);
      return `${P([[s, s], [W, s], [W, H], [s, H]])}M${f(s + k)} ${f(s)}V${f(H)}M${f(W - k)} ${f(s)}V${f(H)}`;
    }
    case 'manual': return P([[s, h * 0.26], [W, s], [W, H], [s, H]]);
    case 'delay': {
      const r = Math.min(cy - s, w * 0.45);
      return `M${f(s)} ${f(s)}H${f(W - r)}A${f(r)} ${f(cy - s)} 0 0 1 ${f(W - r)} ${f(H)}H${f(s)}Z`;
    }
    default: return P([[s, s], [W, s], [W, H], [s, H]]);
  }
}

/** The shape as an SVG drawing a card: `cls` on the <svg>. */
export function shapeSvg(id, w, h, cls = 'cv-shape') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', `0 0 ${f(w)} ${f(h)}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', shapePath(id, w, h));
  svg.appendChild(p);
  return svg;
}

/** A small outline of the shape for pickers and buttons. */
export function shapeIcon(id, size = 20) {
  const def = SHAPE.get(id) || SHAPES[0];
  const ratio = def.w / def.h;
  const w = ratio >= 1 ? 22 : 22 * ratio;
  const h = ratio >= 1 ? 22 / ratio : 22;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `${f((w - 24) / 2)} ${f((h - 24) / 2)} 24 24`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'ic');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', shapePath(id, w, h));
  svg.appendChild(p);
  return svg;
}
