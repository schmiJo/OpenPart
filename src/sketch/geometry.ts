import { add, cross, dot, normalize, scale, sub, type V3 } from '../viewport/math';

export type V2 = [number, number];
export interface Plane { origin: V3; x: V3; y: V3; z: V3 }

export interface Ent {
  id: number;
  type: string;
  start?: V2;
  end?: V2;
  center?: V2;
  radius?: number;
  at?: V2;
  construction?: boolean;
  [k: string]: any;
}
export interface Con {
  id: number;
  type: string;
  a?: string;
  b?: string;
  of?: string;
  value?: number | string;
  about?: string;
  point?: string;
  line?: string;
  what?: string;
  at?: number[];
  reference?: boolean;
  [k: string]: any;
}
export interface SketchData {
  format: string;
  version: number;
  entities: Ent[];
  constraints: Con[];
  [k: string]: any;
}

export const emptySketch = (): SketchData => ({ format: 'coreshape-sketch', version: 1, entities: [], constraints: [] });

export const PLANES: { id: number; name: string; plane: Plane }[] = [
  { id: 1, name: 'Top', plane: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } },
  { id: 2, name: 'Front', plane: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] } },
  { id: 3, name: 'Right', plane: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] } },
];

export const toWorld = (pl: Plane, p: V2): V3 => add(add(pl.origin, scale(pl.x, p[0])), scale(pl.y, p[1]));
export function toLocal(pl: Plane, w: V3): V2 {
  const d = sub(w, pl.origin);
  return [dot(d, pl.x), dot(d, pl.y)];
}

/** The placement a file stores, turned back into a full frame. */
export function planeFromPlacement(p?: { origin?: any[]; z?: any[]; x?: any[] }, env: Record<string, number> = {}): Plane {
  const num = (v: unknown) => (typeof v === 'number' ? v : env[String(v)] ?? (Number(v) || 0));
  const vec = (v: any[] | undefined, d: V3): V3 => (v ? [num(v[0]), num(v[1]), num(v[2])] : d);
  const z = normalize(vec(p?.z, [0, 0, 1]));
  let x = vec(p?.x, Math.abs(z[0]) > 0.999 ? [0, 1, 0] : [1, 0, 0]);
  x = normalize(sub(x, scale(z, dot(x, z))));
  return { origin: vec(p?.origin, [0, 0, 0]), x, y: cross(z, x), z };
}

export const placementOf = (pl: Plane) => ({ origin: pl.origin, z: pl.z, x: pl.x });

/** A frame for sketching on a planar face, keeping "up" up where it can. */
export function planeOnFace(center: V3, normal: V3): Plane {
  const z = normalize(normal);
  const origin = scale(z, dot(center, z));
  if (Math.abs(z[2]) > 0.9) {
    const x: V3 = [1, 0, 0];
    return { origin, x, y: cross(z, x), z };
  }
  const y0: V3 = normalize(sub([0, 0, 1], scale(z, z[2])));
  const x = normalize(cross(y0, z));
  return { origin, x, y: cross(z, x), z };
}

export const dist2 = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Samples the counter-clockwise arc from `a0` to `a1`. */
export function arcPoints(c: V2, r: number, a0: number, a1: number, stepDeg = 4): V2[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(2, Math.ceil(sweep / ((stepDeg * Math.PI) / 180)));
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
}

export const angleOf = (c: V2, p: V2) => Math.atan2(p[1] - c[1], p[0] - c[0]);

/** An entity as a polyline in sketch coordinates. */
/**
 * A projected entity as what it projects to: a part's corner or edge, seen along the sketch's normal, which the kernel
 * works out and keeps in `geometry`. It's construction unless it says otherwise, and fixed: nothing in the sketch moves it.
 */
export function drawn(e: Ent): Ent {
  if (e.type !== 'projected') return e;
  return { ...(e.geometry ?? { type: 'none' }), id: e.id, construction: e.construction !== false, projected: true, from: e.from };
}
export const isProjected = (e: Ent | undefined) => e?.type === 'projected' || !!e?.projected;

export function polyline(e: Ent): V2[] {
  e = drawn(e);
  switch (e.type) {
    case 'line':
      return [e.start!, e.end!];
    case 'circle':
      return arcPoints(e.center!, e.radius!, 0, Math.PI * 2);
    case 'arc':
      return arcPoints(e.center!, e.radius!, angleOf(e.center!, e.start!), angleOf(e.center!, e.end!));
    case 'ellipse': {
      const c = e.center!, m: V2 = e.major;
      const dx = m[0] - c[0], dy = m[1] - c[1];
      const k = (e.minor as number) / Math.hypot(dx, dy);
      const out: V2[] = [];
      for (let i = 0; i <= 72; i++) {
        const t = (i / 72) * Math.PI * 2;
        out.push([c[0] + dx * Math.cos(t) - dy * k * Math.sin(t), c[1] + dy * Math.cos(t) + dx * k * Math.sin(t)]);
      }
      return out;
    }
    case 'spline':
      return splinePoints(e.points ?? e.through ?? [], e.degree, e.knots, e.weights);
    default:
      return [];
  }
}

/** Samples a rational B-spline. Knots default to evenly spaced and clamped, as the file format says. */
export function splinePoints(points: V2[], degree = 3, knots?: number[], weights?: number[], t0?: number, t1?: number, perSpan = 14): V2[] {
  const n = points.length;
  if (n < 2) return [...points];
  const p = Math.min(degree, n - 1);
  const k = knots ?? (() => {
    const out: number[] = [];
    for (let i = 0; i <= n + p; i++) out.push(i <= p ? 0 : i >= n ? n - p : i - p);
    return out;
  })();
  const w = weights ?? points.map(() => 1);
  const lo = t0 ?? k[p], hi = t1 ?? k[n];
  const spans = Math.max(1, new Set(k.filter((x) => x > lo && x < hi)).size + 1);
  const steps = spans * perSpan;
  const out: V2[] = [];
  for (let s = 0; s <= steps; s++) {
    const t = lo + ((hi - lo) * s) / steps;
    let span = p;
    while (span < n - 1 && t >= k[span + 1]) span++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const q = points[span - p + j], m = w[span - p + j];
      d.push([q[0] * m, q[1] * m, m]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = span - p + j;
        const den = k[i + p - r + 1] - k[i];
        const a = den > 0 ? (t - k[i]) / den : 0;
        d[j] = [d[j - 1][0] * (1 - a) + d[j][0] * a, d[j - 1][1] * (1 - a) + d[j][1] * a, d[j - 1][2] * (1 - a) + d[j][2] * a];
      }
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

/** A piece of a region's loop, as the kernel gives it, in the direction the loop runs. */
export function segPoints(seg: any): V2[] {
  if (seg.type === 'line') return [seg.a, seg.b];
  if (seg.type === 'spline') {
    if (seg.t0 <= seg.t1) return splinePoints(seg.points, seg.degree, seg.knots, seg.weights, seg.t0, seg.t1);
    return splinePoints(seg.points, seg.degree, seg.knots, seg.weights, seg.t1, seg.t0).reverse();
  }
  if (seg.type === 'arc' || seg.type === 'ellipse') {
    const n = Math.max(2, Math.ceil(Math.abs(seg.a1 - seg.a0) / 0.09));
    const out: V2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = seg.a0 + ((seg.a1 - seg.a0) * i) / n;
      if (seg.type === 'arc') out.push([seg.center[0] + seg.radius * Math.cos(t), seg.center[1] + seg.radius * Math.sin(t)]);
      else {
        const u = seg.major * Math.cos(t), v = seg.minor * Math.sin(t);
        out.push([seg.center[0] + seg.x[0] * u - seg.x[1] * v, seg.center[1] + seg.x[1] * u + seg.x[0] * v]);
      }
    }
    return out;
  }
  return [];
}

/** The circle through three points, or null if they're in a line. */
export function circleThrough(a: V2, b: V2, c: V2): { center: V2; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sa = a[0] * a[0] + a[1] * a[1], sb = b[0] * b[0] + b[1] * b[1], sc = c[0] * c[0] + c[1] * c[1];
  const center: V2 = [(sa * (b[1] - c[1]) + sb * (c[1] - a[1]) + sc * (a[1] - b[1])) / d, (sa * (c[0] - b[0]) + sb * (a[0] - c[0]) + sc * (b[0] - a[0])) / d];
  return { center, radius: dist2(center, a) };
}

const TAU = Math.PI * 2;
export const ccw = (from: number, to: number) => ((to - from) % TAU + TAU) % TAU;

/** Whether an angle lies on an arc that runs counter-clockwise from `a0` to `a1`. */
function onArc(e: Ent, p: V2, tol = 1e-7) {
  if (e.type !== 'arc') return true;
  const a0 = angleOf(e.center!, e.start!), a1 = angleOf(e.center!, e.end!), a = angleOf(e.center!, p);
  return ccw(a0, a) <= ccw(a0, a1) + tol;
}

/** Where two curves cross, with each counted only within its own ends. Splines count as their sampled shape. */
export function crossings(a: Ent, b: Ent): V2[] {
  a = drawn(a);
  b = drawn(b);
  const isRound = (e: Ent) => e.type === 'circle' || e.type === 'arc';
  const segs = (e: Ent): [V2, V2][] => {
    const pts = polyline(e);
    return pts.slice(1).map((q, i) => [pts[i], q]);
  };
  if (isRound(a) && isRound(b)) {
    const c0 = a.center!, c1 = b.center!, r0 = a.radius!, r1 = b.radius!;
    const d = dist2(c0, c1);
    if (d < 1e-9 || d > r0 + r1 + 1e-9 || d < Math.abs(r0 - r1) - 1e-9) return [];
    const x = (d * d + r0 * r0 - r1 * r1) / (2 * d);
    const h = Math.sqrt(Math.max(0, r0 * r0 - x * x));
    const u: V2 = [(c1[0] - c0[0]) / d, (c1[1] - c0[1]) / d];
    const base: V2 = [c0[0] + u[0] * x, c0[1] + u[1] * x];
    const pts: V2[] = h < 1e-9 ? [base] : [[base[0] - u[1] * h, base[1] + u[0] * h], [base[0] + u[1] * h, base[1] - u[0] * h]];
    return pts.filter((p) => onArc(a, p) && onArc(b, p));
  }
  if (isRound(a) || isRound(b)) {
    const round = isRound(a) ? a : b, other = isRound(a) ? b : a;
    const out: V2[] = [];
    const c = round.center!, r = round.radius!;
    for (const [p, q] of segs(other)) {
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const fx = p[0] - c[0], fy = p[1] - c[1];
      const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
      const disc = B * B - 4 * A * C;
      if (A < 1e-18 || disc < 0) continue;
      for (const t of disc < 1e-18 ? [-B / (2 * A)] : [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        const pt: V2 = [p[0] + dx * t, p[1] + dy * t];
        if (onArc(round, pt)) out.push(pt);
      }
    }
    return out;
  }
  const out: V2[] = [];
  for (const [p, q] of segs(a)) {
    for (const [r, s] of segs(b)) {
      const ux = q[0] - p[0], uy = q[1] - p[1], vx = s[0] - r[0], vy = s[1] - r[1];
      const det = ux * vy - uy * vx;
      if (Math.abs(det) < 1e-12) continue;
      const t = ((r[0] - p[0]) * vy - (r[1] - p[1]) * vx) / det;
      const w = ((r[0] - p[0]) * uy - (r[1] - p[1]) * ux) / det;
      if (t >= -1e-9 && t <= 1 + 1e-9 && w >= -1e-9 && w <= 1 + 1e-9) out.push([p[0] + ux * t, p[1] + uy * t]);
    }
  }
  return out;
}

/** The points of an entity with their references. */
export function pointsOf(e: Ent): { ref: string; p: V2 }[] {
  e = drawn(e);
  switch (e.type) {
    case 'line':
      return [{ ref: `${e.id}.start`, p: e.start! }, { ref: `${e.id}.end`, p: e.end! }];
    case 'circle':
      return [{ ref: `${e.id}.center`, p: e.center! }];
    case 'arc':
      return [{ ref: `${e.id}.center`, p: e.center! }, { ref: `${e.id}.start`, p: e.start! }, { ref: `${e.id}.end`, p: e.end! }];
    case 'point':
      return [{ ref: `${e.id}`, p: e.at! }];
    case 'spline': {
      const pts: V2[] = e.points ?? [];
      return pts.map((p, i) => ({ ref: i === 0 ? `${e.id}.start` : i === pts.length - 1 ? `${e.id}.end` : `${e.id}.p${i}`, p }));
    }
    default:
      return [];
  }
}

export function closestOnSegment(p: V2, a: V2, b: V2): V2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return [a[0] + dx * t, a[1] + dy * t];
}

export function closestOnEntity(e: Ent, p: V2): V2 | null {
  e = drawn(e);
  if (e.type === 'line') return closestOnSegment(p, e.start!, e.end!);
  if (e.type === 'circle' || e.type === 'arc') {
    const c = e.center!, r = e.radius!;
    const a = angleOf(c, p);
    if (e.type === 'arc') {
      const a0 = angleOf(c, e.start!), a1 = angleOf(c, e.end!);
      const norm = (x: number) => ((x % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (norm(a - a0) > norm(a1 - a0)) return dist2(p, e.start!) < dist2(p, e.end!) ? e.start! : e.end!;
    }
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
  }
  if (e.type === 'spline') {
    const pts = polyline(e);
    let best: V2 | null = null;
    let bestD = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const q = closestOnSegment(p, pts[i], pts[i + 1]);
      const d = dist2(p, q);
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  }
  return null;
}
