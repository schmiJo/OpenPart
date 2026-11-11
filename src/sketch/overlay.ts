import { angleOf, arcPoints, circleThrough, dist2, pointsOf, polyline, segPoints, splinePoints, type Con, type Ent, type V2 } from './geometry';
import { FONT } from '../viewport/font';
import { dimLabelText, layoutDimension, type DimLayout } from './dimension';
import { fmt, type SketchSession, type Snap } from './session';

const INK = '#15181B';
const LOOSE = '#2E6BB0';
const MARKER = '#D97E00';
const MARKER_SOFT = '#F0A63C';
const GLYPH_BG = 'rgba(255,255,255,0.94)';
const GLYPH_LINE = 'rgba(120,132,144,0.6)';

function path(ctx: CanvasRenderingContext2D, s: SketchSession, pts: V2[]) {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const q = s.screen(p);
    if (i) ctx.lineTo(q[0], q[1]);
    else ctx.moveTo(q[0], q[1]);
  });
}

function drawRegions(ctx: CanvasRenderingContext2D, s: SketchSession) {
  ctx.fillStyle = 'rgba(40,70,110,0.07)';
  for (const r of s.regions) {
    ctx.beginPath();
    for (const loop of [r.outer, ...r.holes]) {
      let first = true;
      for (const seg of loop) {
        for (const p of segPoints(seg)) {
          const q = s.screen(p);
          if (first) { ctx.moveTo(q[0], q[1]); first = false; }
          else ctx.lineTo(q[0], q[1]);
        }
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}

const entityFree = (e: Ent, free: Set<string>) => pointsOf(e).some((q) => free.has(q.ref)) || free.has(`${e.id}.radius`);

function strokeEntity(ctx: CanvasRenderingContext2D, s: SketchSession, e: Ent, free: Set<string>, selected: Set<string>) {
  const key = String(e.id);
  const pts = polyline(e);
  if (!pts.length) return;
  const on = selected.has(key), over = s.hover === key;
  ctx.strokeStyle = on ? MARKER : over ? MARKER_SOFT : entityFree(e, free) ? LOOSE : INK;
  ctx.lineWidth = on || over ? 1.75 : 1.25;
  ctx.setLineDash(e.construction ? DOTTED : []);
  path(ctx, s, pts);
  ctx.stroke();
  ctx.setLineDash([]);
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawOrigin(ctx: CanvasRenderingContext2D, s: SketchSession, selected: Set<string>) {
  const [x, y] = s.screen([0, 0]);
  const on = selected.has('origin') || s.hover === 'origin';
  ctx.strokeStyle = on ? MARKER : INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  dot(ctx, x, y, 1.2, on ? MARKER : INK);
}

function glyphPath(ctx: CanvasRenderingContext2D, type: string, x: number, y: number) {
  ctx.beginPath();
  const r = 3.8;
  switch (type) {
    case 'horizontal': ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); break;
    case 'vertical': ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); break;
    case 'parallel': ctx.moveTo(x - 3, y + r); ctx.lineTo(x, y - r); ctx.moveTo(x + 0.5, y + r); ctx.lineTo(x + 3.5, y - r); break;
    case 'perpendicular': ctx.moveTo(x - r, y + r); ctx.lineTo(x + r, y + r); ctx.moveTo(x, y + r); ctx.lineTo(x, y - r); break;
    case 'equal': ctx.moveTo(x - r, y - 2); ctx.lineTo(x + r, y - 2); ctx.moveTo(x - r, y + 2); ctx.lineTo(x + r, y + 2); break;
    case 'tangent': ctx.arc(x, y - 1, 3, 0, Math.PI * 2); ctx.moveTo(x - r, y + 3.5); ctx.lineTo(x + r, y + 3.5); break;
    case 'concentric': ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.moveTo(x + 2, y); ctx.arc(x, y, 2, 0, Math.PI * 2); break;
    case 'midpoint': ctx.moveTo(x - r, y + 3); ctx.lineTo(x, y - 4); ctx.lineTo(x + r, y + 3); ctx.closePath(); break;
    case 'symmetric': ctx.moveTo(x - r, y - 3); ctx.lineTo(x - 1, y); ctx.lineTo(x - r, y + 3); ctx.moveTo(x + r, y - 3); ctx.lineTo(x + 1, y); ctx.lineTo(x + r, y + 3); break;
    case 'fix': ctx.moveTo(x - r, y + 3.5); ctx.lineTo(x + r, y + 3.5); ctx.moveTo(x, y + 3.5); ctx.lineTo(x, y - 2); ctx.moveTo(x + 2, y - 3.5); ctx.arc(x, y - 3.5, 2, 0, Math.PI * 2); break;
    case 'coincident': ctx.arc(x, y, 2.6, 0, Math.PI * 2); break;
    default: ctx.arc(x, y, 3, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function drawGlyphs(ctx: CanvasRenderingContext2D, s: SketchSession, selected: Set<string>) {
  const stack = new Map<number, number>();
  const place = (key: string, c: Con, x: number, y: number) => {
    const on = selected.has(key) || s.hover === key;
    const w = 15, h = 15;
    ctx.fillStyle = GLYPH_BG;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 2);
    ctx.fill();
    ctx.strokeStyle = GLYPH_LINE;
    ctx.lineWidth = 0.75;
    ctx.stroke();
    ctx.strokeStyle = on ? MARKER : INK;
    ctx.lineWidth = 1;
    glyphPath(ctx, c.type, x, y);
    s.labels.push({ key, x: x - w / 2, y: y - h / 2, w, h });
  };
  const anchor = (ref: string | undefined): { x: number; y: number; ent?: number } | null => {
    if (!ref) return null;
    const p = s.pointAt(ref);
    if (p) {
      const q = s.screen(p);
      return { x: q[0], y: q[1] };
    }
    const e = s.entity(Number(ref));
    if (!e) return null;
    const pts = polyline(e);
    const mid = pts[Math.floor(pts.length / 2)];
    const a = e.type === 'line' ? ([(e.start![0] + e.end![0]) / 2, (e.start![1] + e.end![1]) / 2] as V2) : mid;
    const q = s.screen(a);
    return { x: q[0], y: q[1], ent: e.id };
  };
  const normalOffset = (e: Ent | undefined): [number, number] => {
    if (e?.type !== 'line') return [12, -12];
    const a = s.screen(e.start!), b = s.screen(e.end!);
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    return [(-dy / l) * 14, (dx / l) * 14];
  };
  for (const c of s.data.constraints) {
    if (c.value !== undefined || c.type === 'coincident') continue;
    const key = `c${c.id}`;
    const refs = c.type === 'midpoint' ? [c.line] : c.type === 'fix' ? [c.what] : c.type === 'symmetric' ? [c.about] : c.type === 'tangent' ? [c.a] : [c.a, c.b];
    for (const ref of refs) {
      const at = anchor(ref);
      if (!at) continue;
      const count = at.ent ? stack.get(at.ent) ?? 0 : 0;
      if (at.ent) stack.set(at.ent, count + 1);
      const [ox, oy] = normalOffset(at.ent ? s.entity(at.ent) : undefined);
      const along = count * 17;
      const n = Math.hypot(ox, oy) || 1;
      place(key, c, at.x + ox + (-oy / n) * along, at.y + oy + (ox / n) * along);
    }
  }
}

function drawLayout(ctx: CanvasRenderingContext2D, s: SketchSession, l: DimLayout, color: string) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [a, b] of l.lines) {
    const p = s.screen(a), q = s.screen(b);
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(q[0], q[1]);
  }
  for (const curve of l.curves) {
    curve.forEach((v, i) => {
      const q = s.screen(v);
      if (i) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
    });
  }
  ctx.stroke();
  for (const h of l.heads) {
    const a = s.screen(h.at), b = s.screen(h.from);
    const t = Math.atan2(a[1] - b[1], a[0] - b[0]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(a[0] - Math.cos(t - 0.3) * 7, a[1] - Math.sin(t - 0.3) * 7);
    ctx.lineTo(a[0] - Math.cos(t + 0.3) * 7, a[1] - Math.sin(t + 0.3) * 7);
    ctx.closePath();
    ctx.fill();
  }
}

function drawLabel(ctx: CanvasRenderingContext2D, s: SketchSession, at: V2, text: string, color: string, key?: string) {
  const [x, y] = s.screen(at);
  ctx.font = `500 11px ${FONT}`;
  const w = ctx.measureText(text).width + 8;
  const h = 15;
  ctx.fillStyle = GLYPH_BG;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, 2);
  ctx.fill();
  ctx.strokeStyle = GLYPH_LINE;
  ctx.lineWidth = 0.75;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  if (key) s.labels.push({ key, x: x - w / 2, y: y - h / 2, w, h });
}

function drawDimension(ctx: CanvasRenderingContext2D, s: SketchSession, c: Con) {
  const place = s.placeOf(c);
  const layout = place ? layoutDimension(s, c, place) : null;
  if (!layout) return;
  const key = `c${c.id}`;
  const on = s.selection[0]().includes(key) || s.hover === key;
  drawLayout(ctx, s, layout, on ? MARKER : 'rgba(31,36,40,0.62)');
  // While its box is open, the box is the label.
  if (s.editing[0]()?.id !== c.id) drawLabel(ctx, s, layout.label, dimLabelText(c), on ? MARKER : INK, key);
}

function readout(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.font = `500 11px ${FONT}`;
  const w = ctx.measureText(text).width + 7;
  ctx.fillStyle = GLYPH_BG;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 7.5, w, 15, 2);
  ctx.fill();
  ctx.strokeStyle = GLYPH_LINE;
  ctx.lineWidth = 0.75;
  ctx.stroke();
  ctx.fillStyle = '#8A5300';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}

function catmullRom(p: V2[]): V2[] {
  const out: V2[] = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[Math.max(0, i - 1)], b = p[i], c = p[i + 1], d = p[Math.min(p.length - 1, i + 2)];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12, t2 = t * t, t3 = t2 * t;
      const f = (j: 0 | 1) => 0.5 * (2 * b[j] + (c[j] - a[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t2 + (3 * b[j] - a[j] - 3 * c[j] + d[j]) * t3);
      out.push([f(0), f(1)]);
    }
  }
  return out;
}

const DOTTED = [4, 3];

function drawDraft(ctx: CanvasRenderingContext2D, s: SketchSession) {
  drawDraftShape(ctx, s);
  ctx.setLineDash([]);
}

function drawDraftShape(ctx: CanvasRenderingContext2D, s: SketchSession) {
  const d = s.draft;
  if (!d) return;
  const end = s.snap?.p ?? s.cursor;
  ctx.strokeStyle = MARKER;
  ctx.lineWidth = 1.25;
  if (s.constructing[0]() && d.kind !== 'dim' && d.kind !== 'box') ctx.setLineDash(DOTTED);
  if (d.kind === 'line') {
    path(ctx, s, [d.start, end]);
    ctx.stroke();
    const a = s.screen(d.start), b = s.screen(end);
    readout(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 15, fmt(dist2(d.start, end)));
  } else if (d.kind === 'rect') {
    const c: V2[] = [d.a, [end[0], d.a[1]], end, [d.a[0], end[1]], d.a];
    path(ctx, s, c);
    ctx.stroke();
    const a = s.screen(c[0]), b = s.screen(c[1]), e = s.screen(c[2]);
    readout(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14, fmt(Math.abs(end[0] - d.a[0])));
    readout(ctx, (b[0] + e[0]) / 2 + 26, (b[1] + e[1]) / 2, fmt(Math.abs(end[1] - d.a[1])));
  } else if (d.kind === 'rect-center') {
    const w = Math.abs(end[0] - d.c[0]), h = Math.abs(end[1] - d.c[1]);
    const c: V2[] = [[d.c[0] - w, d.c[1] - h], [d.c[0] + w, d.c[1] - h], [d.c[0] + w, d.c[1] + h], [d.c[0] - w, d.c[1] + h], [d.c[0] - w, d.c[1] - h]];
    path(ctx, s, c);
    ctx.stroke();
    const a = s.screen(c[0]), b = s.screen(c[1]), e = s.screen(c[2]);
    readout(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 14, fmt(w * 2));
    readout(ctx, (b[0] + e[0]) / 2 + 26, (b[1] + e[1]) / 2, fmt(h * 2));
  } else if (d.kind === 'spline') {
    const pts = [...d.pts, end];
    const curve = pts.length > 2 ? catmullRom(pts) : pts;
    path(ctx, s, curve);
    ctx.stroke();
    for (const p of d.pts) {
      const [x, y] = s.screen(p);
      dot(ctx, x, y, 2.4, MARKER);
    }
  } else if (d.kind === 'circle') {
    const r = dist2(d.c, end);
    path(ctx, s, arcPoints(d.c, r, 0, Math.PI * 2));
    ctx.stroke();
    const a = s.screen(end);
    readout(ctx, a[0] + 26, a[1] - 14, `Ø${fmt(r * 2)}`);
  } else if (d.kind === 'circle-3pt') {
    const circle = d.pts.length === 2 ? circleThrough(d.pts[0], d.pts[1], end) : null;
    if (circle) {
      path(ctx, s, arcPoints(circle.center, circle.radius, 0, Math.PI * 2));
      ctx.stroke();
      const a = s.screen(end);
      readout(ctx, a[0] + 26, a[1] - 14, `Ø${fmt(circle.radius * 2)}`);
    } else {
      path(ctx, s, [...d.pts, end]);
      ctx.stroke();
    }
    for (const p of d.pts) {
      const [x, y] = s.screen(p);
      dot(ctx, x, y, 2.4, MARKER);
    }
  } else if (d.kind === 'arc-tangent') {
    const arc = s.tangentArc(d.start, d.tangent, end);
    if (arc) {
      path(ctx, s, arcPoints(arc.center, arc.radius, angleOf(arc.center, arc.start), angleOf(arc.center, arc.end)));
      ctx.stroke();
      const a = s.screen(end);
      readout(ctx, a[0] + 26, a[1] - 14, `R${fmt(arc.radius)}`);
    }
  } else if (d.kind === 'arc') {
    if (!d.b) {
      path(ctx, s, [d.a, end]);
      ctx.stroke();
    } else {
      const arc = s.arcThrough(d.a, d.b, end);
      if (arc) {
        path(ctx, s, arcPoints(arc.center, arc.radius, angleOf(arc.center, arc.start), angleOf(arc.center, arc.end)));
        ctx.stroke();
        const a = s.screen(end);
        readout(ctx, a[0] + 26, a[1] - 14, `R${fmt(arc.radius)}`);
      }
    }
  } else if (d.kind === 'arc-center') {
    if (!d.s) {
      path(ctx, s, [d.c, end]);
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      const a = s.screen(end);
      readout(ctx, a[0] + 26, a[1] - 14, `R${fmt(dist2(d.c, end))}`);
    } else {
      path(ctx, s, arcPoints(d.c, dist2(d.c, d.s), angleOf(d.c, d.s), angleOf(d.c, end)));
      ctx.stroke();
    }
  } else if (d.kind === 'dim') {
    // The real dimension, with its current value, following the cursor until it's placed.
    const m = s.dimensionPreview();
    const layout = m ? layoutDimension(s, m, s.cursor) : null;
    if (m && layout) {
      drawLayout(ctx, s, layout, MARKER);
      drawLabel(ctx, s, layout.label, dimLabelText(m), MARKER);
    }
  } else if (d.kind === 'box') {
    const x = Math.min(d.a[0], d.b[0]), y = Math.min(d.a[1], d.b[1]);
    ctx.fillStyle = 'rgba(255,182,30,0.12)';
    ctx.fillRect(x, y, Math.abs(d.b[0] - d.a[0]), Math.abs(d.b[1] - d.a[1]));
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.b[0] - d.a[0]), Math.abs(d.b[1] - d.a[1]));
  }
}

/** The little constraint icons by the cursor, saying what the snap would make true. */
function snapTags(n: Snap): string[] {
  const tags: string[] = [];
  if (n.corner || n.perp) tags.push('perpendicular');
  if (n.h) tags.push('horizontal');
  if (n.v) tags.push('vertical');
  if (n.para) tags.push('parallel');
  if (n.tangent) tags.push('tangent');
  if (n.mid) tags.push('midpoint');
  if (n.ref || (n.edge && !n.tangent && !n.perp)) tags.push('coincident');
  if (n.alignX) tags.push('vertical');
  if (n.alignY) tags.push('horizontal');
  return tags;
}

function drawSnap(ctx: CanvasRenderingContext2D, s: SketchSession) {
  const n = s.snap;
  if (!n) return;
  const [x, y] = s.screen(n.p);
  ctx.strokeStyle = MARKER;
  ctx.fillStyle = MARKER;
  ctx.lineWidth = 1.25;
  if (n.ref) {
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.stroke();
  } else if (n.mid) {
    ctx.beginPath();
    ctx.moveTo(x - 5, y + 4); ctx.lineTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.closePath();
    ctx.stroke();
  } else if (n.edge) {
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4);
    ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4);
    ctx.stroke();
  } else {
    dot(ctx, x, y, 2, MARKER);
  }
  // Dashed guides back to whatever this lines up with.
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  for (const ref of [n.alignX, n.alignY]) {
    const p = ref ? s.pointAt(ref) : null;
    if (!p) continue;
    const q = s.screen(p);
    ctx.beginPath();
    ctx.moveTo(q[0], q[1]);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // The right angle itself, marked in the corner it makes, in the sketch's own plane.
  if (n.corner) {
    const c = n.corner.at;
    const len = Math.hypot(n.corner.along[0], n.corner.along[1]) || 1;
    const u: V2 = [n.corner.along[0] / len, n.corner.along[1] / len];
    const here: V2 = [n.p[0] - c[0], n.p[1] - c[1]];
    const hl = Math.hypot(here[0], here[1]) || 1;
    const w: V2 = [here[0] / hl, here[1] / hl];
    const k = s.camera.worldPerPixel * 9;
    const back: V2 = [c[0] - u[0] * k, c[1] - u[1] * k];
    const a = s.screen(back), b = s.screen([back[0] + w[0] * k, back[1] + w[1] * k]), d = s.screen([c[0] + w[0] * k, c[1] + w[1] * k]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(d[0], d[1]);
    ctx.stroke();
  }
  const tags = [...new Set(snapTags(n))];
  tags.forEach((t, i) => {
    const gx = x + 17 + i * 18, gy = y + 17;
    ctx.fillStyle = GLYPH_BG;
    ctx.beginPath();
    ctx.roundRect(gx - 8, gy - 8, 16, 16, 2);
    ctx.fill();
    ctx.strokeStyle = MARKER;
    ctx.lineWidth = 1;
    ctx.stroke();
    glyphPath(ctx, t, gx, gy);
  });
}

function drawTrim(ctx: CanvasRenderingContext2D, s: SketchSession) {
  if (!s.trimming) return;
  ctx.strokeStyle = MARKER;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  path(ctx, s, s.trimming);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawSketch(ctx: CanvasRenderingContext2D, s: SketchSession) {
  s.labels = [];
  const selected = new Set(s.selection[0]());
  const free = new Set(s.analysis[0]().free);
  drawRegions(ctx, s);
  drawOrigin(ctx, s, selected);
  for (const e of s.data.entities) strokeEntity(ctx, s, e, free, selected);
  // Selecting a point shows its coincident constraints, so they can be picked and removed.
  for (const c of s.data.constraints) {
    if (c.type !== 'coincident') continue;
    const showing = [c.a, c.b].some((r) => r && selected.has(r)) || selected.has(`c${c.id}`);
    if (!showing) continue;
    const at = s.pointAt(c.a!) ?? s.pointAt(c.b!);
    if (!at) continue;
    const [x, y] = s.screen(at);
    ctx.fillStyle = GLYPH_BG;
    ctx.beginPath();
    ctx.roundRect(x + 8, y - 21, 15, 15, 2);
    ctx.fill();
    ctx.strokeStyle = selected.has(`c${c.id}`) || s.hover === `c${c.id}` ? MARKER : INK;
    ctx.lineWidth = 1.2;
    glyphPath(ctx, 'coincident', x + 15.5, y - 13.5);
    s.labels.push({ key: `c${c.id}`, x: x + 8, y: y - 21, w: 15, h: 15 });
  }
  for (const e of s.data.entities) {
    for (const { ref, p } of pointsOf(e)) {
      if (/\.p\d+$/.test(ref) && !selected.has(String(e.id)) && !selected.has(ref) && s.hover !== String(e.id) && s.hover !== ref) continue;
      const [x, y] = s.screen(p);
      const on = selected.has(ref), over = s.hover === ref;
      const isCenter = ref.endsWith('.center');
      dot(ctx, x, y, on || over ? 3.2 : isCenter ? 1.6 : 2.1, on ? MARKER : over ? MARKER_SOFT : free.has(ref) ? LOOSE : INK);
    }
  }
  drawGlyphs(ctx, s, selected);
  // Last, so a value is never hidden behind an icon.
  for (const c of s.data.constraints) if (c.value !== undefined) drawDimension(ctx, s, c);
  drawDraft(ctx, s);
  drawTrim(ctx, s);
  drawSnap(ctx, s);
}
