import { dist2, type Con, type V2 } from './geometry';
import type { SketchSession } from './session';

export const fmt = (v: number) => String(Number(v.toFixed(3)));

/** Dimensions whose stored sign only records which way round the geometry is. You only ever see the size. */
export const SIGNED = new Set(['angle', 'horizontal_distance', 'vertical_distance']);

/** A dimension's expression without the minus that records its direction. */
export const bareExpression = (v: string) => /^-\((.*)\)$/.exec(v)?.[1] ?? v;

/** What goes in the box when editing: always the size. */
export function dimValueText(c: { value?: number | string }) {
  return typeof c.value === 'number' ? fmt(Math.abs(c.value)) : bareExpression(String(c.value ?? ''));
}

export function dimLabelText(c: { type?: string; value?: number | string }) {
  const prefix = c.type === 'diameter' ? 'Ø' : c.type === 'radius' ? 'R' : '';
  return prefix + dimValueText(c) + (c.type === 'angle' ? '°' : '');
}

/**
 * Where a dimension's label goes is how you like your drawing, not part of the model, and a .coreshape reader refuses
 * fields it doesn't know. So it's kept in this browser, by feature and constraint.
 */
const PLACES_KEY = 'schmishape.dimension-places';
type PlaceBook = Record<string, Record<string, V2>>;
/** Feature numbers repeat from one Part Studio to the next, so each tab has its own book. */
let scope = '';
export const setPlacesScope = (tab: string) => { scope = tab; };
const bookKey = (tab: string) => `${PLACES_KEY}.${tab}`;
export function readPlaces(tab: string): string | null {
  try {
    return localStorage.getItem(bookKey(tab));
  } catch {
    return null;
  }
}
export function restorePlaces(tab: string, text: string | null) {
  try {
    if (text === null) localStorage.removeItem(bookKey(tab));
    else localStorage.setItem(bookKey(tab), text);
  } catch {
    /* It only costs remembering where the labels were. */
  }
}
export const copyPlaces = (from: string, to: string) => restorePlaces(to, readPlaces(from));
export const dropPlaces = (tab: string) => restorePlaces(tab, null);
/** Labels from before there were tabs belong to the tab that takes over that document. */
export function keepPlacesOf(tab: string) {
  try {
    const old = localStorage.getItem(PLACES_KEY);
    if (old === null) return;
    localStorage.setItem(bookKey(tab), old);
    localStorage.removeItem(PLACES_KEY);
  } catch {
    /* It only costs remembering where the labels were. */
  }
}
function readBook(): PlaceBook {
  try {
    return JSON.parse(readPlaces(scope) ?? '{}');
  } catch {
    return {};
  }
}
function writeBook(book: PlaceBook) {
  restorePlaces(scope, JSON.stringify(book));
}
export function loadPlaces(feature: number | null) {
  const saved = feature === null ? {} : readBook()[feature] ?? {};
  return new Map<number, V2>(Object.entries(saved).map(([k, v]) => [Number(k), v]));
}
export function savePlaces(feature: number, places: Map<number, V2>) {
  const book = readBook();
  book[feature] = Object.fromEntries([...places].map(([k, v]) => [String(k), v]));
  writeBook(book);
}

export interface DimLayout {
  /** Thin lines: extension lines, the dimension line and leaders. */
  lines: [V2, V2][];
  /** Arrow tips: `at` is the tip, and it points away from `from`. */
  heads: { at: V2; from: V2 }[];
  /** Polylines, for an angle's arc. */
  curves: V2[][];
  label: V2;
}

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const unit = (a: V2): V2 => {
  const n = Math.hypot(a[0], a[1]);
  return n > 1e-12 ? [a[0] / n, a[1] / n] : [1, 0];
};

function lineOf(s: SketchSession, k: string): [V2, V2] | null {
  if (k === 'x_axis') return [[-1, 0], [1, 0]];
  if (k === 'y_axis') return [[0, -1], [0, 1]];
  const e = s.entity(Number(k));
  return e?.type === 'line' && !k.includes('.') ? [e.start!, e.end!] : null;
}
function roundOf(s: SketchSession, k: string) {
  if (k.includes('.')) return null;
  const e = s.entity(Number(k));
  return e && (e.type === 'circle' || e.type === 'arc') ? e : null;
}
function footOn(p: V2, [a, b]: [V2, V2]): V2 {
  const u = sub(b, a);
  return add(a, mul(u, dot(sub(p, a), u) / dot(u, u)));
}

/** The two points a straight dimension measures between. */
function spanOf(s: SketchSession, c: Omit<Con, 'id'>): [V2, V2] | null {
  if (!c.a) return null;
  if (!c.b) {
    const l = lineOf(s, c.a);
    return l;
  }
  const pa = s.pointAt(c.a), pb = s.pointAt(c.b);
  if (pa && pb) return [pa, pb];
  const la = lineOf(s, c.a), lb = lineOf(s, c.b);
  if (pa && lb) return [pa, footOn(pa, lb)];
  if (pb && la) return [pb, footOn(pb, la)];
  if (la && lb) {
    const mid = mul(add(la[0], la[1]), 0.5);
    return [mid, footOn(mid, lb)];
  }
  const ra = roundOf(s, c.a), rb = roundOf(s, c.b);
  const rim = (center: V2, r: number, toward: V2): V2 => add(center, mul(unit(sub(toward, center)), r));
  if (pa && rb) return [pa, rim(rb.center!, rb.radius!, pa)];
  if (pb && ra) return [pb, rim(ra.center!, ra.radius!, pb)];
  if (ra && rb) return [rim(ra.center!, ra.radius!, rb.center!), rim(rb.center!, rb.radius!, ra.center!)];
  if (ra && lb) {
    const f = footOn(ra.center!, lb);
    return [rim(ra.center!, ra.radius!, f), f];
  }
  if (rb && la) {
    const f = footOn(rb.center!, la);
    return [rim(rb.center!, rb.radius!, f), f];
  }
  return null;
}

/** Where a label goes until you say otherwise: pulled out from the geometry, away from the middle of the sketch. */
export function defaultPlace(s: SketchSession, c: Omit<Con, 'id'>): V2 | null {
  const px = s.camera.worldPerPixel;
  if (c.type === 'diameter' || c.type === 'radius') {
    const e = s.entity(Number(c.of));
    if (!e?.center) return null;
    let angle = Math.PI / 4;
    if (e.type === 'arc') {
      const a0 = Math.atan2(e.start![1] - e.center[1], e.start![0] - e.center[0]);
      let a1 = Math.atan2(e.end![1] - e.center[1], e.end![0] - e.center[0]);
      if (a1 < a0) a1 += Math.PI * 2;
      angle = (a0 + a1) / 2;
    }
    return add(e.center, mul([Math.cos(angle), Math.sin(angle)], e.radius! + 26 * px));
  }
  if (c.type === 'angle') {
    const a = angleParts(s, c);
    if (!a) return null;
    const mid = a.from + a.sweep / 2;
    return add(a.vertex, mul([Math.cos(mid), Math.sin(mid)], 42 * px));
  }
  const span = spanOf(s, c);
  if (!span) return null;
  const mid = mul(add(span[0], span[1]), 0.5);
  const n: V2 = c.type === 'horizontal_distance' ? [0, 1] : c.type === 'vertical_distance' ? [1, 0] : (() => { const u = unit(sub(span[1], span[0])); return [-u[1], u[0]] as V2; })();
  const pts = s.data.entities.flatMap((e) => (e.start ? [e.start, e.end!] : e.center ? [e.center] : e.at ? [e.at] : []));
  const center = pts.length ? mul(pts.reduce((t, p) => add(t, p), [0, 0] as V2), 1 / pts.length) : mid;
  const out = dot(sub(mid, center), n) < 0 ? -1 : 1;
  return add(mid, mul(n, out * 34 * px));
}

function angleParts(s: SketchSession, c: Omit<Con, 'id'>) {
  const la = c.a ? lineOf(s, c.a) : null, lb = c.b ? lineOf(s, c.b) : null;
  if (!la || !lb) return null;
  const ua = sub(la[1], la[0]), ub = sub(lb[1], lb[0]);
  const det = ua[0] * ub[1] - ua[1] * ub[0];
  const vertex: V2 = Math.abs(det) < 1e-9 ? la[1] : add(la[0], mul(ua, ((lb[0][0] - la[0][0]) * ub[1] - (lb[0][1] - la[0][1]) * ub[0]) / det));
  const far = ([p, q]: [V2, V2]) => (dist2(p, vertex) > dist2(q, vertex) ? p : q);
  const a = far(la), b = far(lb);
  const from = Math.atan2(a[1] - vertex[1], a[0] - vertex[0]);
  let sweep = Math.atan2(b[1] - vertex[1], b[0] - vertex[0]) - from;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep <= -Math.PI) sweep += Math.PI * 2;
  return { vertex, from, sweep };
}

/** A dimension drawn in the sketch's own plane, with its label at `place`, so it holds from any view. */
export function layoutDimension(s: SketchSession, c: Omit<Con, 'id'>, place: V2): DimLayout | null {
  if (c.type === 'diameter' || c.type === 'radius') {
    const e = s.entity(Number(c.of));
    if (!e?.center) return null;
    const r = e.radius!;
    const dir = unit(sub(place, e.center));
    const rim = add(e.center, mul(dir, r));
    if (c.type === 'radius') {
      const end = dist2(place, e.center) > r ? place : rim;
      return { lines: [[e.center, end]], heads: [{ at: rim, from: e.center }], curves: [], label: place };
    }
    const opposite = add(e.center, mul(dir, -r));
    const end = dist2(place, e.center) > r ? place : rim;
    return { lines: [[opposite, end]], heads: [{ at: rim, from: e.center }, { at: opposite, from: e.center }], curves: [], label: place };
  }
  if (c.type === 'angle') {
    const a = angleParts(s, c);
    if (!a) return null;
    const r = Math.max(dist2(place, a.vertex), s.camera.worldPerPixel * 12);
    const at = (t: number): V2 => add(a.vertex, mul([Math.cos(t), Math.sin(t)], r));
    const steps = Math.max(4, Math.ceil(Math.abs(a.sweep) / 0.08));
    const curve: V2[] = [];
    for (let i = 0; i <= steps; i++) curve.push(at(a.from + (a.sweep * i) / steps));
    const nudge = Math.sign(a.sweep || 1) * 0.04;
    return {
      lines: [[a.vertex, curve[0]], [a.vertex, curve[curve.length - 1]]],
      heads: [{ at: curve[0], from: at(a.from + nudge) }, { at: curve[curve.length - 1], from: at(a.from + a.sweep - nudge) }],
      curves: [curve],
      label: place,
    };
  }
  const span = spanOf(s, c);
  if (!span) return null;
  const [p, q] = span;
  // The line runs along what's measured: sideways, upright or along the two points.
  const u: V2 = c.type === 'horizontal_distance' ? [1, 0] : c.type === 'vertical_distance' ? [0, 1] : unit(sub(q, p));
  const n: V2 = [-u[1], u[0]];
  const h = dot(sub(place, p), n);
  const lift = (v: V2) => add(add(p, mul(u, dot(sub(v, p), u))), mul(n, h));
  const a = lift(p), b = lift(q);
  const lines: [V2, V2][] = [[p, a], [q, b], [a, b]];
  const label = lift(place);
  // A label pulled past the ends takes the line out to it.
  const along = dot(sub(label, a), u), length = dot(sub(b, a), u);
  if (along < Math.min(0, length)) lines.push([length < 0 ? b : a, label]);
  else if (along > Math.max(0, length)) lines.push([length < 0 ? a : b, label]);
  return { lines, heads: dist2(a, b) > 1e-9 ? [{ at: a, from: b }, { at: b, from: a }] : [], curves: [], label };
}
