import { createSignal } from 'solid-js';
import { engine } from '../engine/client';
import { doc, numberOr } from '../store/doc';
import { snapsOn, toast } from '../store/ui';
import type { Camera } from '../viewport/camera';
import { bareExpression, defaultPlace, dimValueText, fmt, layoutDimension, SIGNED } from './dimension';
import { arcPoints, ccw, circleThrough, crossings, angleOf, closestOnEntity, dist2, pointsOf, polyline, toLocal, toWorld, type Con, type Ent, type Plane, type SketchData, type V2 } from './geometry';

export type Tool = 'select' | 'line' | 'rect' | 'rect-center' | 'circle' | 'circle-3pt' | 'arc' | 'arc-center' | 'arc-tangent' | 'spline' | 'point' | 'trim' | 'sketch-fillet' | 'dimension';

export interface Snap {
  p: V2;
  /** Lands on this point. */
  ref?: string;
  /** Lands on this curve. */
  edge?: string;
  /** Lands on the middle of this line. */
  mid?: string;
  h?: boolean;
  v?: boolean;
  /** At right angles to this line. */
  perp?: string;
  /** In line with this line. */
  para?: string;
  /** Tangent to this curve. */
  tangent?: string;
  /** Lined up with this point, one above the other or side by side. */
  alignX?: string;
  alignY?: string;
  /** A right angle to mark, at this corner, and the line it's against. */
  corner?: { at: V2; along: V2 };
}
export interface Analysis { dof: number; free: string[]; redundant: { constraint: number; partial: boolean; with: number[] }[] }

type Draft =
  | { kind: 'line'; start: V2; snap: Snap; chain?: string; pressed: [number, number] | null }
  | { kind: 'rect'; a: V2; snap: Snap; pressed: [number, number] | null }
  | { kind: 'circle'; c: V2; snap: Snap; pressed: [number, number] | null }
  | { kind: 'rect-center'; c: V2; snap: Snap; pressed: [number, number] | null }
  | { kind: 'arc'; a: V2; snap: Snap; b?: V2; bSnap?: Snap }
  | { kind: 'arc-center'; c: V2; snap: Snap; s?: V2; sSnap?: Snap }
  | { kind: 'spline'; pts: V2[]; snaps: Snap[] }
  | { kind: 'circle-3pt'; pts: V2[]; snaps: Snap[] }
  | { kind: 'arc-tangent'; start: V2; ref: string; off: Ent; tangent: V2 }
  | { kind: 'dim'; first: string; second?: string; pressed: [number, number] | null }
  | { kind: 'dimdrag'; id: number; press: [number, number]; moved: boolean; editOnClick: boolean }
  | { kind: 'drag'; grab: string | { edge: number }; last: V2; moved: boolean }
  | { kind: 'box'; a: [number, number]; b: [number, number] };

export interface LabelRect { key: string; x: number; y: number; w: number; h: number }

const POINT_HIT = 9;
const EDGE_HIT = 7;

export const isConstraintKey = (s: string) => s.startsWith('c');
export const conIdOf = (s: string) => Number(s.slice(1));
export const isPointRef = (s: string) => s === 'origin' || s.includes('.');
export { fmt };

export class SketchSession {
  data: SketchData;
  regions: any[] = [];
  draft: Draft | null = null;
  snap: Snap | null = null;
  cursor: V2 = [0, 0];
  hover: string | null = null;
  labels: LabelRect[] = [];

  readonly tool = createSignal<Tool>('line');
  readonly selection = createSignal<string[]>([]);
  readonly analysis = createSignal<Analysis>({ dof: 0, free: [], redundant: [] });
  readonly editing = createSignal<{ id: number; x: number; y: number; text: string; fresh: boolean } | null>(null);
  readonly canUndo = createSignal(false);
  readonly canRedo = createSignal(false);

  private history: string[] = [];
  private future: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private nextEntity = 1;
  private nextConstraint = 1;
  /** Where each dimension's label sits, in sketch coordinates. */
  places: Map<number, V2>;
  private lastLabelClick = { key: '', at: 0 };
  /** The piece a click would trim, while hovering. */
  trimming: V2[] | null = null;
  /** Shift is held, so snapping stands aside for now. */
  private free = false;
  /** New geometry comes out as construction lines. */
  readonly constructing = createSignal(false);
  private dragBusy = false;
  private dragNext: V2 | null = null;

  constructor(
    public readonly featureId: number | null,
    public readonly plane: Plane,
    public readonly name: string,
    initial: SketchData,
    public readonly camera: Camera,
    private invalidate: () => void,
    places: Map<number, V2> = new Map(),
  ) {
    this.places = places;
    this.data = initial;
    this.nextEntity = Math.max(0, ...initial.entities.map((e) => e.id), (initial.next_entity ?? 1) - 1) + 1;
    this.nextConstraint = Math.max(0, ...initial.constraints.map((c) => c.id), (initial.next_constraint ?? 1) - 1) + 1;
    if (featureId !== null) this.tool[1]('select');
    this.enqueue(async () => {
      await this.solve();
      await this.refreshRegions();
      this.invalidate();
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Waits for everything queued, then gives the sketch as it stands. */
  settled() {
    return this.enqueue(async () => this.data);
  }

  entity = (id: number) => this.data.entities.find((e) => e.id === id);
  screen = (p: V2) => this.camera.project(toWorld(this.plane, p));
  local(sx: number, sy: number): V2 {
    const w = this.camera.onPlane(sx, sy, this.plane.origin, this.plane.z);
    return w ? toLocal(this.plane, w) : this.cursor;
  }

  pointAt(ref: string): V2 | null {
    if (ref === 'origin') return [0, 0];
    const [id, part] = ref.split('.');
    const e = this.entity(Number(id));
    if (!e) return null;
    if (e.type === 'point' && !part) return e.at!;
    if (e.type === 'spline' && part) {
      const pts: V2[] = e.points ?? [];
      if (part === 'start') return pts[0] ?? null;
      if (part === 'end') return pts[pts.length - 1] ?? null;
      const m = /^p(\d+)$/.exec(part);
      return m ? pts[Number(m[1])] ?? null : null;
    }
    return (part && (e as any)[part]) || null;
  }

  private async solve(): Promise<{ ok: boolean; message?: string }> {
    const r = await engine.call('sketch_solve', { sketch: this.data, parameters: { ...doc.env } });
    if (!r.ok) {
      let message = r.text;
      try { message = JSON.parse(r.text).message; } catch { /* It wasn't structured, so say it as it came. */ }
      return { ok: false, message };
    }
    const v = JSON.parse(r.text);
    this.data = v.sketch;
    this.analysis[1](v.analysis);
    return { ok: true };
  }

  private async refreshRegions() {
    const r = await engine.call('sketch_arrangement', { sketch: this.data });
    this.regions = r.ok ? JSON.parse(r.text).regions : [];
  }

  private remember(before: string) {
    this.history.push(before);
    this.future = [];
    this.canUndo[1](true);
    this.canRedo[1](false);
  }

  private stampIds() {
    this.data.next_entity = this.nextEntity;
    this.data.next_constraint = this.nextConstraint;
  }

  /** A change the solver has to accept, or it's taken back with the reason. */
  change(edit: (d: SketchData) => void, opts: { refuseRedundant?: string } = {}): Promise<boolean> {
    return this.enqueue(async () => {
      const before = JSON.stringify(this.data);
      const redundantBefore = this.analysis[0]().redundant.length;
      const analysisBefore = this.analysis[0]();
      edit(this.data);
      this.stampIds();
      const res = await this.solve();
      const refuse = !res.ok ? res.message! : opts.refuseRedundant && this.analysis[0]().redundant.length > redundantBefore ? opts.refuseRedundant : null;
      if (refuse) {
        this.data = JSON.parse(before);
        this.analysis[1](analysisBefore);
        toast(refuse, res.ok ? 'info' : 'error');
        this.invalidate();
        return false;
      }
      this.remember(before);
      await this.refreshRegions();
      this.invalidate();
      return true;
    });
  }

  /** An edit with what was inferred along with it. Inferences are hints: each goes in only if it fits. */
  private editWithHints(edit: (d: SketchData) => void, soft: Omit<Con, 'id'>[]) {
    const softCons = soft.map((c) => ({ ...c, id: this.nextConstraint++ }) as Con);
    return this.enqueue(async () => {
      const before = JSON.stringify(this.data);
      edit(this.data);
      this.stampIds();
      const res = await this.solve();
      if (!res.ok) {
        this.data = JSON.parse(before);
        toast(res.message!, 'error');
        this.invalidate();
        return false;
      }
      for (const c of softCons) {
        const known = this.analysis[0]().redundant.length;
        const kept = JSON.stringify(this.data);
        this.data.constraints.push(c);
        const r = await this.solve();
        if (!r.ok || this.analysis[0]().redundant.length > known) {
          this.data = JSON.parse(kept);
          await this.solve();
        }
      }
      this.remember(before);
      await this.refreshRegions();
      this.invalidate();
      return true;
    });
  }

  private addDrawn(ents: Ent[], hard: Omit<Con, 'id'>[], soft: Omit<Con, 'id'>[]) {
    const hardCons = hard.map((c) => ({ ...c, id: this.nextConstraint++ }) as Con);
    return this.editWithHints((d) => {
      d.entities.push(...ents);
      d.constraints.push(...hardCons);
    }, soft);
  }

  undo() {
    return this.enqueue(async () => {
      const prev = this.history.pop();
      if (prev === undefined) return;
      this.future.push(JSON.stringify(this.data));
      this.data = JSON.parse(prev);
      this.canUndo[1](this.history.length > 0);
      this.canRedo[1](true);
      await this.solve();
      await this.refreshRegions();
      this.selection[1]([]);
      this.invalidate();
    });
  }

  redo() {
    return this.enqueue(async () => {
      const next = this.future.pop();
      if (next === undefined) return;
      this.history.push(JSON.stringify(this.data));
      this.data = JSON.parse(next);
      this.canUndo[1](true);
      this.canRedo[1](this.future.length > 0);
      await this.solve();
      await this.refreshRegions();
      this.invalidate();
    });
  }

  private step() {
    return 10 ** Math.ceil(Math.log10(this.camera.worldPerPixel * 3));
  }

  /**
   * Where the pointer lands, and what that implies. It pulls gently, within a few pixels, and only says so with an
   * icon. Lands on things first, then on the angles a line can make from where it started, then lines up with points.
   */
  private makeSnap(sx: number, sy: number, from?: V2, ignore?: string): Snap {
    const raw = this.local(sx, sy);
    if (this.free || !snapsOn()) return { p: raw };
    const px = this.camera.worldPerPixel;
    const away = (p: V2) => {
      const s = this.screen(p);
      return Math.hypot(s[0] - sx, s[1] - sy);
    };
    const skip = (e: Ent) => ignore?.split('.')[0] === String(e.id);

    let best: Snap | null = null;
    let bestD = POINT_HIT;
    const consider = (ref: string, p: V2) => {
      if (ref === ignore) return;
      const d = away(p);
      if (d < bestD) { bestD = d; best = { p, ref }; }
    };
    consider('origin', [0, 0]);
    for (const e of this.data.entities) for (const { ref, p } of pointsOf(e)) consider(ref, p);
    if (best) return best;

    // Middles of lines.
    bestD = POINT_HIT - 1;
    for (const e of this.data.entities) {
      if (e.type !== 'line' || skip(e)) continue;
      const m: V2 = [(e.start![0] + e.end![0]) / 2, (e.start![1] + e.end![1]) / 2];
      const d = away(m);
      if (d < bestD) { bestD = d; best = { p: m, mid: String(e.id) }; }
    }
    if (best) return best;

    if (from) {
      // The point on a curve where a line from here would just touch it.
      bestD = 9;
      for (const e of this.data.entities) {
        if ((e.type !== 'circle' && e.type !== 'arc') || skip(e)) continue;
        const c = e.center!, r = e.radius!;
        const d = dist2(from, c);
        if (d <= r + 1e-9) continue;
        const base = angleOf(c, from), off = Math.acos(r / d);
        for (const a of [base + off, base - off]) {
          const t: V2 = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
          const near = closestOnEntity(e, t);
          if (!near || dist2(near, t) > 1e-6) continue;
          const dd = away(t);
          if (dd < bestD) { bestD = dd; best = { p: t, edge: String(e.id), tangent: String(e.id) }; }
        }
      }
      if (best) return best;
    }

    let edgeD = EDGE_HIT;
    for (const e of this.data.entities) {
      if (skip(e)) continue;
      const c = closestOnEntity(e, raw);
      if (!c) continue;
      const d = away(c);
      if (d < edgeD) { edgeD = d; best = { p: c, edge: String(e.id) }; }
    }
    if (best) {
      const hit: Snap = best;
      // Coming off a line at a right angle to this one is what's usually meant, near its foot.
      const line = from && hit.edge ? this.entity(Number(hit.edge)) : undefined;
      if (from && line?.type === 'line') {
        const u: V2 = [line.end![0] - line.start![0], line.end![1] - line.start![1]];
        const t = ((from[0] - line.start![0]) * u[0] + (from[1] - line.start![1]) * u[1]) / (u[0] * u[0] + u[1] * u[1]);
        const foot: V2 = [line.start![0] + u[0] * t, line.start![1] + u[1] * t];
        if (t >= 0 && t <= 1 && away(foot) < 9 && dist2(foot, from) > px * 8) return { p: foot, edge: hit.edge, perp: hit.edge, corner: { at: foot, along: u } };
      }
      return hit;
    }

    const step = this.step();
    const round = (v: number) => Math.round(v / step) * step;
    if (from) {
      const lateral = (dir: V2) => {
        const t = (raw[0] - from[0]) * dir[0] + (raw[1] - from[1]) * dir[1];
        return { t, d: away([from[0] + dir[0] * t, from[1] + dir[1] * t]) };
      };
      const MAGNET = 8;
      const links = this.connectedAt(from, ignore);
      const axes: { dir: V2; tag: Partial<Snap> }[] = [{ dir: [1, 0], tag: { h: true } }, { dir: [0, 1], tag: { v: true } }];
      const relative: { dir: V2; tag: Partial<Snap> }[] = [];
      for (const e of links) {
        if (e.type === 'line') {
          const a = dist2(e.start!, from) < dist2(e.end!, from) ? e.end! : e.start!;
          const len = dist2(a, from) || 1;
          const u: V2 = [(from[0] - a[0]) / len, (from[1] - a[1]) / len];
          relative.push({ dir: [-u[1], u[0]], tag: { perp: String(e.id), corner: { at: from, along: u } } });
          relative.push({ dir: u, tag: { para: String(e.id) } });
        } else if (e.type === 'arc') {
          const a = angleOf(e.center!, from);
          relative.push({ dir: [-Math.sin(a), Math.cos(a)], tag: { tangent: String(e.id) } });
        }
      }
      let pick: { dir: V2; tag: Partial<Snap>; t: number } | null = null;
      let pickD = MAGNET;
      for (const c of [...axes, ...relative]) {
        const { t, d } = lateral(c.dir);
        if (Math.abs(t) < px * 14) continue;
        // A true right angle reads as one even when it also happens to be horizontal or vertical.
        if (d < pickD - 1e-3 || (pick && d <= pickD + 1e-3 && !pick.tag.h && !pick.tag.v && (c.tag.h || c.tag.v))) {
          pickD = d;
          pick = { ...c, t };
        }
      }
      if (pick) {
        const t = round(pick.t) || pick.t;
        const out: Snap = { p: [from[0] + pick.dir[0] * t, from[1] + pick.dir[1] * t], ...pick.tag };
        if ((out.h || out.v) && !out.corner) {
          for (const r of relative) {
            if (r.tag.corner && Math.abs(r.dir[0] * pick.dir[1] - r.dir[1] * pick.dir[0]) < 1e-6) out.corner = r.tag.corner;
          }
        }
        return out;
      }
    }

    // Lining up with other points, and with the origin, which is the same as landing on an axis.
    const snap: Snap = { p: [round(raw[0]), round(raw[1])] };
    const align = 6 * px;
    let dx = align, dy = align;
    const others: { ref: string; p: V2 }[] = [{ ref: 'origin', p: [0, 0] }];
    for (const e of this.data.entities) if (!skip(e)) others.push(...pointsOf(e));
    for (const o of others) {
      if (o.ref === ignore) continue;
      if (Math.abs(raw[0] - o.p[0]) < dx) { dx = Math.abs(raw[0] - o.p[0]); snap.p[0] = o.p[0]; snap.alignX = o.ref; }
      if (Math.abs(raw[1] - o.p[1]) < dy) { dy = Math.abs(raw[1] - o.p[1]); snap.p[1] = o.p[1]; snap.alignY = o.ref; }
    }
    return snap;
  }

  /** Lines and arcs that end at a point. */
  private connectedAt(p: V2, ignore?: string): Ent[] {
    const tol = this.camera.worldPerPixel * 1.5;
    return this.data.entities.filter((e) => {
      if (ignore?.split('.')[0] === String(e.id) || (e.type !== 'line' && e.type !== 'arc')) return false;
      return dist2(e.start!, p) < tol || dist2(e.end!, p) < tol;
    });
  }

  /** What's under the pointer: a dimension or glyph, then a point, then an edge. */
  hit(sx: number, sy: number): string | null {
    for (const l of this.labels) if (sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h) return l.key;
    let best: string | null = null;
    let bestD = POINT_HIT;
    const consider = (ref: string, p: V2) => {
      const s = this.screen(p);
      const d = Math.hypot(s[0] - sx, s[1] - sy);
      if (d < bestD) { bestD = d; best = ref; }
    };
    for (const e of this.data.entities) for (const { ref, p } of pointsOf(e)) consider(ref, p);
    consider('origin', [0, 0]);
    if (best) return best;
    let edgeD = EDGE_HIT;
    const raw = this.local(sx, sy);
    for (const e of this.data.entities) {
      if (e.type === 'point') continue;
      const c = closestOnEntity(e, raw);
      if (!c) continue;
      const s = this.screen(c);
      const d = Math.hypot(s[0] - sx, s[1] - sy);
      if (d < edgeD) { edgeD = d; best = String(e.id); }
    }
    if (best) return best;
    const k = this.camera.worldPerPixel * 5;
    if (Math.abs(raw[0]) < k) return 'y_axis';
    if (Math.abs(raw[1]) < k) return 'x_axis';
    return null;
  }

  private snapCons(ref: string, snap: Snap): Omit<Con, 'id'>[] {
    const out: Omit<Con, 'id'>[] = [];
    if (snap.ref) out.push({ type: 'coincident', a: ref, b: snap.ref });
    else if (snap.mid) out.push({ type: 'midpoint', point: ref, line: snap.mid });
    else if (snap.edge) out.push({ type: 'coincident', a: ref, b: snap.edge });
    if (snap.alignX) out.push({ type: 'vertical', a: ref, b: snap.alignX });
    if (snap.alignY) out.push({ type: 'horizontal', a: ref, b: snap.alignY });
    return out;
  }

  private newEnt(e: Omit<Ent, 'id'>): Ent {
    const made = { ...e, id: this.nextEntity++ } as unknown as Ent;
    if (this.constructing[0]() && e.type !== 'point') made.construction = true;
    return made;
  }

  private commitLine(end: Snap) {
    const d = this.draft;
    if (d?.kind !== 'line') return;
    if (dist2(d.start, end.p) < this.camera.worldPerPixel * 3) return;
    const e = this.newEnt({ type: 'line', start: [...d.start] as V2, end: [...end.p] as V2 });
    const hard = d.chain ? [{ type: 'coincident', a: `${e.id}.start`, b: d.chain }] : this.snapCons(`${e.id}.start`, d.snap);
    const soft = this.snapCons(`${e.id}.end`, end);
    if (end.h) soft.push({ type: 'horizontal', a: `${e.id}` });
    if (end.v) soft.push({ type: 'vertical', a: `${e.id}` });
    if (end.perp) soft.push({ type: 'perpendicular', a: `${e.id}`, b: end.perp });
    if (end.para) soft.push({ type: 'parallel', a: `${e.id}`, b: end.para });
    if (end.tangent) soft.push({ type: 'tangent', a: `${e.id}`, b: end.tangent });
    void this.addDrawn([e], hard, soft);
    // Landing on an existing point finishes the chain, as it usually closes a loop.
    this.draft = end.ref && end.ref !== 'origin' ? null : { kind: 'line', start: end.p, snap: { p: end.p }, chain: `${e.id}.end`, pressed: null };
  }

  private commitRect(b: Snap) {
    const d = this.draft;
    if (d?.kind !== 'rect') return;
    const x0 = Math.min(d.a[0], b.p[0]), x1 = Math.max(d.a[0], b.p[0]);
    const y0 = Math.min(d.a[1], b.p[1]), y1 = Math.max(d.a[1], b.p[1]);
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return;
    const corners: V2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const ents = corners.map((c, i) => this.newEnt({ type: 'line', start: c, end: corners[(i + 1) % 4] }));
    const hard: Omit<Con, 'id'>[] = ents.map((e, i) => ({ type: 'coincident', a: `${e.id}.end`, b: `${ents[(i + 1) % 4].id}.start` }));
    ents.forEach((e, i) => hard.push({ type: i % 2 ? 'vertical' : 'horizontal', a: `${e.id}` }));
    const which = (p: V2) => corners.findIndex((c) => c[0] === p[0] && c[1] === p[1]);
    const soft: Omit<Con, 'id'>[] = [];
    const ia = which(d.a), ib = which(b.p);
    if (ia >= 0) soft.push(...this.snapCons(`${ents[ia].id}.start`, d.snap));
    if (ib >= 0) soft.push(...this.snapCons(`${ents[ib].id}.start`, b));
    void this.addDrawn(ents, hard, soft);
    this.draft = null;
  }

  private commitCircle(b: Snap) {
    const d = this.draft;
    if (d?.kind !== 'circle') return;
    const r = dist2(d.c, b.p);
    if (r < 1e-6) return;
    const e = this.newEnt({ type: 'circle', center: [...d.c] as V2, radius: r });
    void this.addDrawn([e], [], this.snapCons(`${e.id}.center`, d.snap));
    this.draft = null;
  }

  private commitRectCenter(b: Snap) {
    const d = this.draft;
    if (d?.kind !== 'rect-center') return;
    const w = Math.abs(b.p[0] - d.c[0]), h = Math.abs(b.p[1] - d.c[1]);
    if (w < 1e-6 || h < 1e-6) return;
    const [cx, cy] = d.c;
    const corners: V2[] = [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]];
    const ents = corners.map((c, i) => this.newEnt({ type: 'line', start: c, end: corners[(i + 1) % 4] }));
    const center = { ...this.newEnt({ type: 'point', at: [cx, cy] as V2 }), construction: true };
    const across = { ...this.newEnt({ type: 'line', start: corners[0], end: corners[2] }), construction: true };
    const down = { ...this.newEnt({ type: 'line', start: corners[1], end: corners[3] }), construction: true };
    const hard: Omit<Con, 'id'>[] = ents.map((e, i) => ({ type: 'coincident', a: `${e.id}.end`, b: `${ents[(i + 1) % 4].id}.start` }));
    ents.forEach((e, i) => hard.push({ type: i % 2 ? 'vertical' : 'horizontal', a: `${e.id}` }));
    hard.push(
      { type: 'coincident', a: `${across.id}.start`, b: `${ents[0].id}.start` },
      { type: 'coincident', a: `${across.id}.end`, b: `${ents[2].id}.start` },
      { type: 'coincident', a: `${down.id}.start`, b: `${ents[1].id}.start` },
      { type: 'coincident', a: `${down.id}.end`, b: `${ents[3].id}.start` },
      { type: 'midpoint', point: `${center.id}`, line: `${across.id}` },
    );
    void this.addDrawn([...ents, across, down, center], hard, this.snapCons(`${center.id}`, d.snap));
    this.draft = null;
  }

  /** The arc a 3-point draft would make, running counter-clockwise from its start, as arcs do. */
  arcThrough(a: V2, b: V2, on: V2) {
    const circle = circleThrough(a, b, on);
    if (!circle) return null;
    const { center, radius } = circle;
    const forward = ccw(angleOf(center, a), angleOf(center, on)) <= ccw(angleOf(center, a), angleOf(center, b));
    return { center, radius, start: forward ? a : b, end: forward ? b : a, forward };
  }

  private commitArc(on: V2) {
    const d = this.draft;
    if (d?.kind !== 'arc' || !d.b) return;
    const arc = this.arcThrough(d.a, d.b, on);
    if (!arc) return;
    const e = this.newEnt({ type: 'arc', center: arc.center, radius: arc.radius, start: [...arc.start] as V2, end: [...arc.end] as V2 });
    const soft = [...this.snapCons(`${e.id}.${arc.forward ? 'start' : 'end'}`, d.snap), ...this.snapCons(`${e.id}.${arc.forward ? 'end' : 'start'}`, d.bSnap!)];
    void this.addDrawn([e], [], soft);
    this.draft = null;
  }

  private commitArcCenter(endSnap: Snap) {
    const d = this.draft;
    if (d?.kind !== 'arc-center' || !d.s) return;
    const r = dist2(d.c, d.s);
    const a = angleOf(d.c, endSnap.p);
    const end: V2 = [d.c[0] + r * Math.cos(a), d.c[1] + r * Math.sin(a)];
    if (dist2(end, d.s) < 1e-6) return;
    const e = this.newEnt({ type: 'arc', center: [...d.c] as V2, radius: r, start: [...d.s] as V2, end });
    const soft = [...this.snapCons(`${e.id}.center`, d.snap), ...this.snapCons(`${e.id}.start`, d.sSnap!), ...this.snapCons(`${e.id}.end`, endSnap)];
    void this.addDrawn([e], [], soft);
    this.draft = null;
  }

  private commitCircle3(last: Snap) {
    const d = this.draft;
    if (d?.kind !== 'circle-3pt' || d.pts.length !== 2) return;
    const circle = circleThrough(d.pts[0], d.pts[1], last.p);
    if (!circle) return;
    const e = this.newEnt({ type: 'circle', center: circle.center, radius: circle.radius });
    const on = (s: Snap): Omit<Con, 'id'>[] => (s.ref ? [{ type: 'coincident', a: s.ref, b: `${e.id}` }] : []);
    void this.addDrawn([e], [], [...on(d.snaps[0]), ...on(d.snaps[1]), ...on(last)]);
    this.draft = null;
  }

  /** The arc leaving a point along a direction and arriving at another point, or null if they're in line. */
  tangentArc(start: V2, along: V2, end: V2) {
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const n: V2 = [-along[1], along[0]];
    const side = dx * n[0] + dy * n[1];
    if (Math.abs(side) < 1e-9) return null;
    const rho = (dx * dx + dy * dy) / (2 * side);
    const center: V2 = [start[0] + n[0] * rho, start[1] + n[1] * rho];
    return { center, radius: Math.abs(rho), start: rho > 0 ? start : end, end: rho > 0 ? end : start, forward: rho > 0 };
  }

  private beginTangentArc(s: Snap) {
    const off = this.connectedAt(s.p)[0];
    if (!off) return toast('Start a tangent arc from the end of a line or an arc.');
    const isStart = dist2(off.start!, s.p) < dist2(off.end!, s.p);
    let tangent: V2;
    if (off.type === 'line') {
      const a = isStart ? off.end! : off.start!;
      const n = dist2(a, s.p) || 1;
      tangent = [(s.p[0] - a[0]) / n, (s.p[1] - a[1]) / n];
    } else {
      // An arc runs counter-clockwise, so leaving from its end carries on that way, and from its start goes back.
      const a = angleOf(off.center!, s.p);
      tangent = isStart ? [Math.sin(a), -Math.cos(a)] : [-Math.sin(a), Math.cos(a)];
    }
    this.draft = { kind: 'arc-tangent', start: s.p, ref: `${off.id}.${isStart ? 'start' : 'end'}`, off, tangent };
  }

  private commitTangentArc(end: Snap) {
    const d = this.draft;
    if (d?.kind !== 'arc-tangent') return;
    const arc = this.tangentArc(d.start, d.tangent, end.p);
    if (!arc) return;
    const e = this.newEnt({ type: 'arc', center: arc.center, radius: arc.radius, start: [...arc.start] as V2, end: [...arc.end] as V2 });
    const near = arc.forward ? 'start' : 'end', far = arc.forward ? 'end' : 'start';
    const hard: Omit<Con, 'id'>[] = [{ type: 'coincident', a: `${e.id}.${near}`, b: d.ref }];
    const soft: Omit<Con, 'id'>[] = [{ type: 'tangent', a: `${e.id}`, b: `${d.off.id}` }, ...this.snapCons(`${e.id}.${far}`, end)];
    void this.addDrawn([e], hard, soft);
    this.draft = null;
  }

  private commitSpline() {
    const d = this.draft;
    this.draft = null;
    if (d?.kind !== 'spline' || d.pts.length < 2) return;
    const e = this.newEnt({ type: 'spline', through: d.pts.map((p) => [...p] as V2) });
    const soft = [...this.snapCons(`${e.id}.start`, d.snaps[0]), ...this.snapCons(`${e.id}.end`, d.snaps[d.snaps.length - 1])];
    void this.addDrawn([e], [], soft);
  }

  /** Enter finishes whatever takes open-ended clicks. */
  enterKey() {
    if (this.draft?.kind === 'spline') this.commitSpline();
    this.invalidate();
  }

  /** The piece of a curve that trimming here would take away: between its neighbouring crossings, or all of it. */
  trimPiece(sx: number, sy: number) {
    const raw = this.local(sx, sy);
    let target: Ent | null = null;
    let bestD = EDGE_HIT + 2;
    for (const e of this.data.entities) {
      if (e.type === 'point') continue;
      const c = closestOnEntity(e, raw);
      if (!c) continue;
      const q = this.screen(c);
      const d = Math.hypot(q[0] - sx, q[1] - sy);
      if (d < bestD) { bestD = d; target = e; }
    }
    if (!target) return null;
    const e: Ent = target;
    const cuts: { p: V2; by: string }[] = [];
    for (const o of this.data.entities) {
      if (o.id === e.id || o.type === 'point') continue;
      for (const p of crossings(e, o)) cuts.push({ p, by: String(o.id) });
    }
    const c = closestOnEntity(e, raw)!;
    if (e.type === 'line') {
      const u: V2 = [e.end![0] - e.start![0], e.end![1] - e.start![1]];
      const len = Math.hypot(u[0], u[1]) || 1;
      const param = (p: V2) => ((p[0] - e.start![0]) * u[0] + (p[1] - e.start![1]) * u[1]) / (len * len);
      const ts = cuts.map((k) => ({ ...k, t: param(k.p) })).filter((k) => k.t > 1e-6 && k.t < 1 - 1e-6).sort((a, b) => a.t - b.t);
      const at = param(c);
      const before = [...ts].reverse().find((k) => k.t < at), after = ts.find((k) => k.t > at);
      const from = before?.p ?? e.start!, to = after?.p ?? e.end!;
      return { e, before, after, polyline: [from, to] as V2[] };
    }
    if (e.type === 'circle' || e.type === 'arc') {
      const center = e.center!;
      const base = e.type === 'arc' ? angleOf(center, e.start!) : 0;
      const whole = e.type === 'arc' ? ccw(base, angleOf(center, e.end!)) : Math.PI * 2;
      const param = (p: V2) => ccw(base, angleOf(center, p));
      const ts = cuts.map((k) => ({ ...k, t: param(k.p) })).filter((k) => (e.type === 'circle' ? true : k.t > 1e-6 && k.t < whole - 1e-6)).sort((a, b) => a.t - b.t);
      const at = param(c);
      const before = [...ts].reverse().find((k) => k.t < at), after = ts.find((k) => k.t > at);
      if (e.type === 'circle') {
        if (ts.length < 2) return { e, before: undefined, after: undefined, polyline: arcPoints(center, e.radius!, 0, Math.PI * 2), keep: ts.length === 1 };
        const lo = before ?? ts[ts.length - 1], hi = after ?? ts[0];
        return { e, before: lo, after: hi, polyline: arcPoints(center, e.radius!, angleOf(center, lo.p), angleOf(center, hi.p)) };
      }
      const a0 = before ? angleOf(center, before.p) : base, a1 = after ? angleOf(center, after.p) : angleOf(center, e.end!);
      return { e, before, after, polyline: arcPoints(center, e.radius!, a0, a1) };
    }
    return { e, before: undefined, after: undefined, polyline: polyline(e) };
  }

  private trimAt(sx: number, sy: number) {
    const piece = this.trimPiece(sx, sy);
    if (!piece) return;
    const { e, before, after } = piece;
    const id = String(e.id);
    const uses = (c: Con, ref: string) => [c.a, c.b, c.of, c.about, c.point, c.line, c.what].includes(ref);
    const touches = (c: Con, prefix: string) => [c.a, c.b, c.of, c.about, c.point, c.line, c.what].some((r) => typeof r === 'string' && (r === prefix || r.startsWith(`${prefix}.`)));
    if (e.type === 'spline') {
      if (before || after) return toast('Splines can only be trimmed away whole for now.');
    }
    if (!before && !after) {
      if ((piece as { keep?: boolean }).keep) return toast('A circle needs crossing in two places to trim it.');
      void this.change((d) => {
        d.entities = d.entities.filter((x) => x.id !== e.id);
        d.constraints = d.constraints.filter((c) => !touches(c, id));
      });
      return;
    }
    const soft: Omit<Con, 'id'>[] = [];
    if (e.type === 'circle') {
      soft.push({ type: 'coincident', a: `${id}.start`, b: after!.by }, { type: 'coincident', a: `${id}.end`, b: before!.by });
      void this.editWithHints((d) => {
        const x = d.entities.find((v) => v.id === e.id)!;
        x.type = 'arc';
        x.start = [...after!.p] as V2;
        x.end = [...before!.p] as V2;
      }, soft);
      return;
    }
    if (before && after) {
      // A piece out of the middle leaves two: this one up to the cut, and a new one carrying on after it.
      const twin = { ...JSON.parse(JSON.stringify(e)), id: this.nextEntity++ } as Ent;
      twin.start = [...after.p] as V2;
      soft.push({ type: 'coincident', a: `${id}.end`, b: before.by }, { type: 'coincident', a: `${twin.id}.start`, b: after.by });
      if (e.type === 'line') soft.push({ type: 'coincident', a: `${twin.id}.start`, b: id }, { type: 'coincident', a: `${twin.id}.end`, b: id });
      else soft.push({ type: 'concentric', a: `${twin.id}`, b: id }, { type: 'equal', a: `${twin.id}`, b: id });
      void this.editWithHints((d) => {
        const x = d.entities.find((v) => v.id === e.id)!;
        x.end = [...before.p] as V2;
        d.entities.push(twin);
        const lengths = (c: Con) => c.type === 'distance' && c.a === id && !c.b;
        d.constraints = d.constraints.filter((c) => !lengths(c));
        for (const c of d.constraints) {
          for (const key of ['a', 'b', 'of', 'about', 'point', 'line', 'what']) if (c[key] === `${id}.end`) c[key] = `${twin.id}.end`;
        }
      }, soft);
      return;
    }
    const cut = (before ?? after)!;
    const end = before ? 'end' : 'start';
    soft.push({ type: 'coincident', a: `${id}.${end}`, b: cut.by });
    void this.editWithHints((d) => {
      const x = d.entities.find((v) => v.id === e.id)!;
      x[end] = [...cut.p] as V2;
      d.constraints = d.constraints.filter((c) => !uses(c, `${id}.${end}`) && !(c.type === 'distance' && c.a === id && !c.b));
    }, soft);
  }

  /**
   * Rounds the corner where two lines meet. The sharp corner stays on as a construction point, so everything that
   * measured to it still does, and the sketch doesn't move.
   */
  private filletCorner(sx: number, sy: number) {
    const h = this.hit(sx, sy);
    if (!h || !isPointRef(h) || h === 'origin') return toast('Click the corner where two lines meet.');
    const at = this.pointAt(h)!;
    const tol = this.camera.worldPerPixel;
    const lines = this.data.entities.filter((e) => e.type === 'line' && !e.construction && (dist2(e.start!, at) < tol || dist2(e.end!, at) < tol));
    if (lines.length !== 2) return toast('Click the corner where two lines meet.');
    const [l1, l2] = lines;
    const endOf = (l: Ent) => (dist2(l.start!, at) < tol ? 'start' : 'end');
    const e1 = endOf(l1), e2 = endOf(l2);
    const far = (l: Ent, end: string): V2 => (end === 'start' ? l.end! : l.start!);
    const u1: V2 = (() => { const f = far(l1, e1), n = dist2(f, at); return [(f[0] - at[0]) / n, (f[1] - at[1]) / n]; })();
    const u2: V2 = (() => { const f = far(l2, e2), n = dist2(f, at); return [(f[0] - at[0]) / n, (f[1] - at[1]) / n]; })();
    const cos = u1[0] * u2[0] + u1[1] * u2[1];
    const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
    if (half < 0.02 || half > Math.PI / 2 - 0.02) return toast('These two lines run straight on, so there is no corner to round.');
    const room = Math.min(dist2(far(l1, e1), at), dist2(far(l2, e2), at)) * 0.3;
    const step = this.step();
    const r = Math.max(step, Math.round((room * Math.tan(half)) / step) * step);
    const reach = r / Math.tan(half);
    const p1: V2 = [at[0] + u1[0] * reach, at[1] + u1[1] * reach], p2: V2 = [at[0] + u2[0] * reach, at[1] + u2[1] * reach];
    const b = (() => { const v: V2 = [u1[0] + u2[0], u1[1] + u2[1]]; const n = Math.hypot(v[0], v[1]); return [v[0] / n, v[1] / n] as V2; })();
    const center: V2 = [at[0] + b[0] * (r / Math.sin(half)), at[1] + b[1] * (r / Math.sin(half))];
    const turn = u1[0] * u2[1] - u1[1] * u2[0];
    const [start, end, startRef, endRef] = turn > 0 ? [p2, p1, `${l2.id}.${e2}`, `${l1.id}.${e1}`] : [p1, p2, `${l1.id}.${e1}`, `${l2.id}.${e2}`];
    const arc = this.newEnt({ type: 'arc', center, radius: r, start, end });
    const corner = { ...this.newEnt({ type: 'point', at: [...at] as V2 }), construction: true };
    const ref1 = `${l1.id}.${e1}`, ref2 = `${l2.id}.${e2}`;
    const radius = { id: this.nextConstraint++, type: 'radius', of: `${arc.id}`, value: r } as Con;
    const added: Con[] = [
      { type: 'coincident', a: `${corner.id}`, b: `${l1.id}` },
      { type: 'coincident', a: `${corner.id}`, b: `${l2.id}` },
      { type: 'coincident', a: `${arc.id}.start`, b: startRef },
      { type: 'coincident', a: `${arc.id}.end`, b: endRef },
      { type: 'tangent', a: `${arc.id}`, b: `${l1.id}` },
      { type: 'tangent', a: `${arc.id}`, b: `${l2.id}` },
    ].map((c) => ({ ...c, id: this.nextConstraint++ }) as Con);
    this.draft = null;
    void this.change((d) => {
      const x1 = d.entities.find((v) => v.id === l1.id)!, x2 = d.entities.find((v) => v.id === l2.id)!;
      x1[e1] = [...p1] as V2;
      x2[e2] = [...p2] as V2;
      d.entities.push(arc, corner);
      const kept: Con[] = [];
      for (const c of d.constraints) {
        // The two ends no longer meet. What held the corner now holds the point that stands in for it.
        if (c.type === 'coincident' && [c.a, c.b].includes(ref1) && [c.a, c.b].includes(ref2)) continue;
        for (const key of ['a', 'b', 'of', 'about', 'point', 'line', 'what']) if (c[key] === ref1 || c[key] === ref2) c[key] = `${corner.id}`;
        if (c.type === 'distance' && !c.b && (c.a === String(l1.id) || c.a === String(l2.id))) {
          const line = c.a === String(l1.id) ? l1 : l2;
          const end2 = line === l1 ? e1 : e2;
          c.b = `${corner.id}`;
          c.a = `${line.id}.${end2 === 'start' ? 'end' : 'start'}`;
        }
        kept.push(c);
      }
      d.constraints = [...kept, ...added, radius];
    }).then((ok) => {
      if (ok) this.openEditor(radius.id, true);
    });
  }

  pointerDown(sx: number, sy: number, shift: boolean) {
    const tool = this.tool[0]();
    this.free = shift && tool !== 'select';
    switch (tool) {
      case 'select': {
        const h = this.hit(sx, sy);
        if (!h) {
          if (!shift) this.selection[1]([]);
          this.draft = { kind: 'box', a: [sx, sy], b: [sx, sy] };
          break;
        }
        this.toggleSelect(h, shift);
        if (isConstraintKey(h) && this.data.constraints.find((c) => c.id === conIdOf(h))?.value !== undefined) {
          // Twice quickly edits it. Otherwise it can be dragged somewhere better.
          const now = performance.now();
          const twice = this.lastLabelClick.key === h && now - this.lastLabelClick.at < 400;
          this.lastLabelClick = { key: h, at: now };
          if (twice) this.openEditor(conIdOf(h));
          else this.draft = { kind: 'dimdrag', id: conIdOf(h), press: [sx, sy], moved: false, editOnClick: false };
          break;
        }
        if (!isConstraintKey(h) && h !== 'origin' && h !== 'x_axis' && h !== 'y_axis') {
          const grab = isPointRef(h) || this.entity(Number(h))?.type === 'point' ? h : { edge: Number(h) };
          this.draft = { kind: 'drag', grab, last: this.local(sx, sy), moved: false };
        }
        break;
      }
      case 'line': {
        const d = this.draft;
        if (d?.kind === 'line') this.commitLine(this.makeSnap(sx, sy, d.start));
        else {
          const s = this.makeSnap(sx, sy);
          this.draft = { kind: 'line', start: s.p, snap: s, pressed: [sx, sy] };
        }
        break;
      }
      case 'rect': {
        const d = this.draft;
        if (d?.kind === 'rect') this.commitRect(this.makeSnap(sx, sy));
        else {
          const s = this.makeSnap(sx, sy);
          this.draft = { kind: 'rect', a: s.p, snap: s, pressed: [sx, sy] };
        }
        break;
      }
      case 'circle': {
        const d = this.draft;
        if (d?.kind === 'circle') this.commitCircle(this.makeSnap(sx, sy));
        else {
          const s = this.makeSnap(sx, sy);
          this.draft = { kind: 'circle', c: s.p, snap: s, pressed: [sx, sy] };
        }
        break;
      }
      case 'rect-center': {
        const d = this.draft;
        if (d?.kind === 'rect-center') this.commitRectCenter(this.makeSnap(sx, sy));
        else {
          const s = this.makeSnap(sx, sy);
          this.draft = { kind: 'rect-center', c: s.p, snap: s, pressed: [sx, sy] };
        }
        break;
      }
      case 'circle-3pt': {
        const d = this.draft;
        const s = this.makeSnap(sx, sy);
        if (d?.kind !== 'circle-3pt') this.draft = { kind: 'circle-3pt', pts: [s.p], snaps: [s] };
        else if (d.pts.length < 2) { d.pts.push(s.p); d.snaps.push(s); }
        else this.commitCircle3(s);
        break;
      }
      case 'arc-tangent': {
        const d = this.draft;
        const s = this.makeSnap(sx, sy);
        if (d?.kind === 'arc-tangent') this.commitTangentArc(s);
        else this.beginTangentArc(s);
        break;
      }
      case 'arc': {
        const d = this.draft;
        const s = this.makeSnap(sx, sy);
        if (d?.kind !== 'arc') this.draft = { kind: 'arc', a: s.p, snap: s };
        else if (!d.b) { d.b = s.p; d.bSnap = s; }
        else this.commitArc(s.p);
        break;
      }
      case 'arc-center': {
        const d = this.draft;
        const s = this.makeSnap(sx, sy);
        if (d?.kind !== 'arc-center') this.draft = { kind: 'arc-center', c: s.p, snap: s };
        else if (!d.s) { d.s = s.p; d.sSnap = s; }
        else this.commitArcCenter(s);
        break;
      }
      case 'spline': {
        const d = this.draft;
        const s = this.makeSnap(sx, sy, undefined);
        if (d?.kind !== 'spline') this.draft = { kind: 'spline', pts: [s.p], snaps: [s] };
        else {
          // Clicking the same spot twice finishes, as does landing back on a point.
          const last = this.screen(d.pts[d.pts.length - 1]);
          if (Math.hypot(last[0] - sx, last[1] - sy) < 4) this.commitSpline();
          else {
            d.pts.push(s.p);
            d.snaps.push(s);
            if (s.ref) this.commitSpline();
          }
        }
        break;
      }
      case 'trim':
        this.trimAt(sx, sy);
        break;
      case 'sketch-fillet':
        this.filletCorner(sx, sy);
        break;
      case 'point': {
        const s = this.makeSnap(sx, sy);
        const e = this.newEnt({ type: 'point', at: [...s.p] as V2 });
        void this.addDrawn([e], [], this.snapCons(`${e.id}`, s));
        break;
      }
      case 'dimension':
        this.dimensionClick(sx, sy);
        break;
    }
    this.invalidate();
  }

  pointerMove(sx: number, sy: number, shift = false) {
    this.cursor = this.local(sx, sy);
    this.free = shift && this.tool[0]() !== 'select';
    const d = this.draft;
    const tool = this.tool[0]();
    if (d?.kind === 'drag') {
      if (!d.moved) this.remember(JSON.stringify(this.data));
      d.moved = true;
      this.dragTo(this.cursor);
    } else if (d?.kind === 'dimdrag') {
      if (Math.hypot(sx - d.press[0], sy - d.press[1]) > 3) d.moved = true;
      if (d.moved) this.places.set(d.id, [...this.cursor] as V2);
    } else if (d?.kind === 'box') {
      d.b = [sx, sy];
    } else if (tool === 'select' || tool === 'dimension' || tool === 'sketch-fillet') {
      this.hover = this.hit(sx, sy);
    } else if (tool === 'trim') {
      this.trimming = this.trimPiece(sx, sy)?.polyline ?? null;
    } else {
      const from = d?.kind === 'line' ? d.start : undefined;
      this.snap = this.makeSnap(sx, sy, from);
      this.hover = null;
    }
    this.invalidate();
  }

  pointerUp(sx: number, sy: number) {
    const d = this.draft;
    if (!d) return;
    if (d.kind === 'drag') {
      this.endDrag();
      this.draft = null;
    } else if (d.kind === 'dimdrag') {
      this.draft = null;
      if (!d.moved && d.editOnClick) this.openEditor(d.id);
    } else if (d.kind === 'dim') {
      // Press, pull and release places it in one go.
      const pressed = d.pressed;
      d.pressed = null;
      if (pressed && Math.hypot(sx - pressed[0], sy - pressed[1]) > 5) this.placeDimension();
    } else if (d.kind === 'box') {
      this.boxSelect(d.a, d.b);
      this.draft = null;
    } else if ('pressed' in d && d.pressed) {
      // Press, drag, release draws in one go. A plain click leaves the tool waiting for the next click.
      const moved = Math.hypot(sx - d.pressed[0], sy - d.pressed[1]) > 5;
      d.pressed = null;
      if (moved) {
        if (d.kind === 'line') this.commitLine(this.makeSnap(sx, sy, d.start));
        if (d.kind === 'rect') this.commitRect(this.makeSnap(sx, sy));
        if (d.kind === 'circle') this.commitCircle(this.makeSnap(sx, sy));
        if (d.kind === 'rect-center') this.commitRectCenter(this.makeSnap(sx, sy));
      }
    }
    this.invalidate();
  }

  private dragTo(to: V2) {
    const d = this.draft;
    if (d?.kind !== 'drag') return;
    if (this.dragBusy) {
      this.dragNext = to;
      return;
    }
    this.dragBusy = true;
    const grab = typeof d.grab === 'string' ? d.grab : { edge: d.grab.edge, at: d.last };
    void engine.call('sketch_drag', { sketch: this.data, grab, to, parameters: { ...doc.env } }).then((r) => {
      this.dragBusy = false;
      if (r.ok) {
        this.data = JSON.parse(r.text).sketch;
        d.last = to;
        this.invalidate();
      }
      const next = this.dragNext;
      this.dragNext = null;
      if (next && this.draft === d) this.dragTo(next);
    });
  }

  private endDrag() {
    this.dragNext = null;
    void this.enqueue(async () => {
      await this.solve();
      await this.refreshRegions();
      this.invalidate();
    });
  }

  private toggleSelect(key: string, add: boolean) {
    const [get, set] = this.selection;
    if (add) set(get().includes(key) ? get().filter((k) => k !== key) : [...get(), key]);
    else if (!get().includes(key)) set([key]);
  }

  private boxSelect(a: [number, number], b: [number, number]) {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    if (x1 - x0 < 4 && y1 - y0 < 4) return;
    const inside = (p: V2) => {
      const s = this.screen(p);
      return s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1;
    };
    const picked = this.data.entities.filter((e) => polyline(e).length ? polyline(e).every(inside) : pointsOf(e).every((q) => inside(q.p))).map((e) => String(e.id));
    this.selection[1]([...new Set([...this.selection[0](), ...picked])]);
  }

  setTool(t: Tool) {
    this.draft = null;
    this.snap = null;
    this.trimming = null;
    this.hover = null;
    this.tool[1](t);
    this.invalidate();
  }

  /** One step back: the drawing in progress, then the tool, then the selection. False when there's nothing left to step back from. */
  escape(): boolean {
    this.snap = null;
    this.invalidate();
    if (this.editing[0]()) {
      this.editing[1](null);
      return true;
    }
    if (this.draft) {
      if (this.draft.kind === 'spline') this.commitSpline();
      else this.draft = null;
      return true;
    }
    if (this.selection[0]().length) {
      this.selection[1]([]);
      return true;
    }
    // A sketch with nothing in it has nothing to come back to, so the first Esc can leave.
    if (this.tool[0]() !== 'select' && this.data.entities.length) {
      this.setTool('select');
      return true;
    }
    return false;
  }

  deleteSelection() {
    const keys = this.selection[0]();
    if (!keys.length) return;
    const cons = new Set(keys.filter(isConstraintKey).map(conIdOf));
    const ents = new Set(keys.filter((k) => !isConstraintKey(k) && !k.includes('.') && /^\d+$/.test(k)).map(Number));
    // Selecting one end of a line or a circle's center means the whole thing, when deleting.
    for (const k of keys) if (k.includes('.')) ents.add(Number(k.split('.')[0]));
    if (!cons.size && !ents.size) return;
    const uses = (c: Con) =>
      [c.a, c.b, c.of, c.about, c.point, c.line, c.what].some((r) => typeof r === 'string' && ents.has(Number(r.split('.')[0])));
    void this.change((d) => {
      d.entities = d.entities.filter((e) => !ents.has(e.id));
      d.constraints = d.constraints.filter((c) => !cons.has(c.id) && !uses(c));
    });
    this.selection[1]([]);
  }

  /** Turns what's selected into construction geometry or back, or with nothing selected, whether new lines come out that way. */
  toggleConstruction() {
    const ids = this.selection[0]().filter((k) => /^\d+$/.test(k)).map(Number);
    if (!ids.length) {
      this.constructing[1](!this.constructing[0]());
      return;
    }
    void this.change((d) => {
      for (const e of d.entities) {
        if (ids.includes(e.id)) {
          if (e.construction) delete e.construction;
          else e.construction = true;
        }
      }
    });
  }

  /** What the selection is made of, so the toolbar can offer only constraints that apply. */
  picks() {
    const keys = this.selection[0]().filter((k) => !isConstraintKey(k));
    const points = keys.filter((k) => isPointRef(k) || this.entity(Number(k))?.type === 'point');
    const edges = keys.filter((k) => !points.includes(k));
    const lines = edges.filter((k) => k === 'x_axis' || k === 'y_axis' || this.entity(Number(k))?.type === 'line');
    const curves = edges.filter((k) => ['circle', 'arc'].includes(this.entity(Number(k))?.type ?? ''));
    return { points, lines, curves, edges, count: keys.length };
  }

  /** Each constraint this selection allows, as the constraints it would add. */
  constraintsFor(type: string): Omit<Con, 'id'>[] | null {
    const { points, lines, curves, edges, count } = this.picks();
    const onlyLines = lines.length === count;
    const realLines = lines.filter((l) => /^\d+$/.test(l));
    switch (type) {
      case 'horizontal':
      case 'vertical':
        if (realLines.length === count && count >= 1) return realLines.map((a) => ({ type, a }));
        if (points.length === 2 && count === 2) return [{ type, a: points[0], b: points[1] }];
        return null;
      case 'coincident':
        if (points.length >= 2 && points.length === count) return points.slice(1).map((b) => ({ type, a: points[0], b }));
        if (points.length === 1 && edges.length === 1 && count === 2) return [{ type, a: points[0], b: edges[0] }];
        return null;
      case 'parallel':
        return onlyLines && count >= 2 ? lines.slice(1).map((b) => ({ type, a: lines[0], b })) : null;
      case 'perpendicular':
        return onlyLines && count === 2 ? [{ type, a: lines[0], b: lines[1] }] : null;
      case 'equal':
        if (realLines.length === count && count >= 2) return realLines.slice(1).map((b) => ({ type, a: realLines[0], b }));
        if (curves.length === count && count >= 2) return curves.slice(1).map((b) => ({ type, a: curves[0], b }));
        return null;
      case 'tangent':
        if (count === 2 && realLines.length === 1 && curves.length === 1) return [{ type, a: realLines[0], b: curves[0] }];
        if (count === 2 && curves.length === 2) return [{ type, a: curves[0], b: curves[1] }];
        return null;
      case 'concentric':
        return count === 2 && curves.length === 2 ? [{ type, a: curves[0], b: curves[1] }] : null;
      case 'midpoint':
        return count === 2 && points.length === 1 && realLines.length === 1 ? [{ type, point: points[0], line: realLines[0] }] : null;
      case 'symmetric':
        return count === 3 && points.length === 2 && lines.length === 1 ? [{ type, a: points[0], b: points[1], about: lines[0] }] : null;
      case 'fix': {
        if (count !== 1) return null;
        const k = this.selection[0]().find((s) => !isConstraintKey(s))!;
        if (k === 'origin' || k === 'x_axis' || k === 'y_axis') return null;
        const p = this.pointAt(k);
        if (p) return [{ type, what: k, at: [...p] }];
        const e = this.entity(Number(k));
        if (e?.type === 'line') return [{ type, what: k, at: [...e.start!, ...e.end!] }];
        if (e?.type === 'circle') return [{ type, what: k, at: [...e.center!, e.radius!] }];
        if (e?.type === 'arc') return [{ type, what: k, at: [...e.center!, e.radius!, ...e.start!, ...e.end!] }];
        return null;
      }
    }
    return null;
  }

  addConstraint(type: string) {
    const list = this.constraintsFor(type);
    if (!list) return;
    const made = list.map((c) => ({ ...c, id: this.nextConstraint++ }) as Con);
    void this.change((d) => d.constraints.push(...made), { refuseRedundant: 'That is already held by other constraints.' }).then((ok) => {
      if (ok) this.selection[1]([]);
    });
  }

  /** The dimension for what's picked, measured from the geometry as it stands. */
  measureFor(a: string, b: string | null, cursor?: V2): Omit<Con, 'id'> | null {
    const isPoint = (k: string) => isPointRef(k) || this.entity(Number(k))?.type === 'point';
    const lineOf = (k: string): [V2, V2] | null => {
      if (k === 'x_axis') return [[-1, 0], [1, 0]];
      if (k === 'y_axis') return [[0, -1], [0, 1]];
      const e = this.entity(Number(k));
      return e?.type === 'line' ? [e.start!, e.end!] : null;
    };
    if (!b) {
      const e = a.includes('.') ? undefined : this.entity(Number(a));
      if (!e) return null;
      if (e.type === 'line') {
        // A slanted line can be measured along itself, or across or up, depending which way the dimension is pulled.
        const slanted = Math.abs(e.end![0] - e.start![0]) > 1e-6 && Math.abs(e.end![1] - e.start![1]) > 1e-6;
        const across = slanted && cursor ? this.measureFor(`${a}.start`, `${a}.end`, cursor) : null;
        if (across && across.type !== 'distance') return across;
        return { type: 'distance', a, value: dist2(e.start!, e.end!) };
      }
      if (e.type === 'circle') return { type: 'diameter', of: a, value: e.radius! * 2 };
      if (e.type === 'arc') return { type: 'radius', of: a, value: e.radius! };
      return null;
    }
    if (isPoint(a) && isPoint(b)) {
      const pa = this.pointAt(a)!, pb = this.pointAt(b)!;
      const dx = Math.abs(pb[0] - pa[0]), dy = Math.abs(pb[1] - pa[1]);
      // Past the box the two points span, the dimension is the one you're pulling it out along.
      let kind: 'distance' | 'horizontal_distance' | 'vertical_distance' = 'distance';
      if (dy < 1e-9) kind = 'horizontal_distance';
      else if (dx < 1e-9) kind = 'vertical_distance';
      else if (cursor) {
        const x0 = Math.min(pa[0], pb[0]), x1 = Math.max(pa[0], pb[0]), y0 = Math.min(pa[1], pb[1]), y1 = Math.max(pa[1], pb[1]);
        if (cursor[1] > y1 || cursor[1] < y0) if (cursor[0] >= x0 && cursor[0] <= x1) kind = 'horizontal_distance';
        if (cursor[0] > x1 || cursor[0] < x0) if (cursor[1] >= y0 && cursor[1] <= y1) kind = 'vertical_distance';
      }
      if (kind === 'horizontal_distance') {
        const [l, r] = pa[0] <= pb[0] ? [a, b] : [b, a];
        return { type: kind, a: l, b: r, value: dx };
      }
      if (kind === 'vertical_distance') {
        const [l, r] = pa[1] <= pb[1] ? [a, b] : [b, a];
        return { type: kind, a: l, b: r, value: dy };
      }
      return { type: kind, a, b, value: dist2(pa, pb) };
    }
    const la = lineOf(a), lb = lineOf(b);
    if (la && lb) {
      const ua: V2 = [la[1][0] - la[0][0], la[1][1] - la[0][1]];
      const ub: V2 = [lb[1][0] - lb[0][0], lb[1][1] - lb[0][1]];
      const cross = ua[0] * ub[1] - ua[1] * ub[0];
      const dotv = ua[0] * ub[0] + ua[1] * ub[1];
      const parallel = Math.abs(cross) < 1e-6 * Math.hypot(...ua) * Math.hypot(...ub);
      if (!parallel) return { type: 'angle', a, b, value: (Math.atan2(cross, dotv) * 180) / Math.PI };
      const mid: V2 = [(la[0][0] + la[1][0]) / 2, (la[0][1] + la[1][1]) / 2];
      const n = Math.hypot(...ub);
      return { type: 'distance', a, b, value: Math.abs((mid[0] - lb[0][0]) * ub[1] - (mid[1] - lb[0][1]) * ub[0]) / n };
    }
    const pointKey = isPoint(a) ? a : isPoint(b) ? b : null;
    const other = pointKey === a ? b : a;
    if (pointKey && lineOf(other)) {
      const [p, q] = lineOf(other)!;
      const u: V2 = [q[0] - p[0], q[1] - p[1]];
      const v = this.pointAt(pointKey)!;
      return { type: 'distance', a: pointKey, b: other, value: Math.abs((v[0] - p[0]) * u[1] - (v[1] - p[1]) * u[0]) / Math.hypot(...u) };
    }
    const circ = (k: string) => {
      const e = this.entity(Number(k));
      return e && (e.type === 'circle' || e.type === 'arc') ? e : null;
    };
    if (pointKey && circ(other)) {
      const e = circ(other)!;
      return { type: 'distance', a: pointKey, b: other, value: Math.abs(dist2(this.pointAt(pointKey)!, e.center!) - e.radius!) };
    }
    if (circ(a) && circ(b)) {
      const ea = circ(a)!, eb = circ(b)!;
      return { type: 'distance', a, b, value: Math.abs(dist2(ea.center!, eb.center!) - ea.radius! - eb.radius!) };
    }
    if ((circ(a) && lineOf(b)) || (circ(b) && lineOf(a))) {
      const c = circ(a) ?? circ(b)!;
      const [p, q] = lineOf(circ(a) ? b : a)!;
      const u: V2 = [q[0] - p[0], q[1] - p[1]];
      const d = Math.abs((c.center![0] - p[0]) * u[1] - (c.center![1] - p[1]) * u[0]) / Math.hypot(...u);
      return { type: 'distance', a, b, value: Math.abs(d - c.radius!) };
    }
    return null;
  }

  private dimensionClick(sx: number, sy: number) {
    const h = this.hit(sx, sy);
    const d = this.draft;
    if (d?.kind === 'dim') {
      // A second thing to measure against, or a place to put it.
      if (!d.second && h && !isConstraintKey(h) && h !== d.first && this.measureFor(d.first, h, this.cursor)) {
        d.second = h;
        this.selection[1]([d.first, h]);
      } else this.placeDimension();
      return;
    }
    if (!h) return;
    if (isConstraintKey(h)) {
      this.draft = { kind: 'dimdrag', id: conIdOf(h), press: [sx, sy], moved: false, editOnClick: true };
      return;
    }
    this.cursor = this.local(sx, sy);
    this.draft = { kind: 'dim', first: h, pressed: [sx, sy] };
    this.selection[1]([h]);
  }

  /** What the dimension tool would make right now, for the preview. */
  dimensionPreview(): Omit<Con, 'id'> | null {
    const d = this.draft;
    if (d?.kind !== 'dim') return null;
    const near = !d.second && this.hover && this.hover !== d.first && !isConstraintKey(this.hover) ? this.hover : null;
    return this.measureFor(d.first, d.second ?? near, this.cursor) ?? this.measureFor(d.first, d.second ?? null, this.cursor);
  }

  private placeDimension() {
    const d = this.draft;
    if (d?.kind !== 'dim') return;
    const m = this.measureFor(d.first, d.second ?? null, this.cursor);
    if (!m) {
      toast('Click a second thing to measure this against.');
      return;
    }
    this.draft = null;
    this.selection[1]([]);
    const id = this.nextConstraint++;
    this.places.set(id, [...this.cursor] as V2);
    const made = { ...m, id } as Con;
    void this.change((data) => data.constraints.push(made), { refuseRedundant: 'That dimension is already set by other constraints.' }).then((ok) => {
      if (ok) this.openEditor(id, true);
      else this.places.delete(id);
    });
  }

  /** Where a dimension's label is, placed or by default. */
  placeOf(c: Con): V2 | null {
    return this.places.get(c.id) ?? defaultPlace(this, c);
  }

  openEditor(id: number, fresh = false) {
    const c = this.data.constraints.find((x) => x.id === id);
    if (!c || c.value === undefined) return;
    const place = this.placeOf(c);
    const layout = place ? layoutDimension(this, c, place) : null;
    const at = layout ? this.screen(layout.label) : ([this.camera.width / 2, this.camera.height / 2] as [number, number]);
    this.editing[1]({ id, x: at[0], y: at[1], text: dimValueText(c), fresh });
    this.invalidate();
  }

  setDimension(id: number, text: string) {
    this.editing[1](null);
    const typed = numberOr(text);
    if (typed === '') return;
    void this.change((d) => {
      const c = d.constraints.find((x) => x.id === id);
      if (!c) return;
      // Only the size means anything to you. The direction the geometry already has stays as it is, so 90 on
      // something at -90 keeps it there, and so does typing -90.
      const sign = SIGNED.has(c.type) && (typeof c.value === 'number' ? c.value < 0 : String(c.value).startsWith('-')) ? -1 : 1;
      if (typeof typed === 'number') c.value = Math.abs(typed) * sign;
      else {
        const size = bareExpression(typed.replace(/^-\s*(?=[\w(])/, ''));
        c.value = sign < 0 ? `-(${size})` : size;
      }
    });
  }
}
