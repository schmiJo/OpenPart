/**
 * Where an assembly's parts go. Plain math, with no DOM or engine, so it can be tested on its own.
 *
 * Each free part has six unknowns: a move of its center and a small rotation about it. Each mate gives equations
 * between two connector frames. A solve takes the smallest move that meets them, with rotation costing about what it
 * costs to move the part's surface as far. A drag asks for more in order: first the mates, then the grabbed point
 * reaching the pointer, then as little turning of the grabbed part as possible. So a free part just translates, and a
 * part on a revolute swings.
 */
import { add, cross, dot, quatAxis, quatFromBasis, quatMul, quatNormalize, quatRotate, scale, sub, type Quat, type V3 } from '../viewport/math';

export interface Pose { p: V3; q: Quat }
/** A connector in its part's own coordinates. */
export interface Frame { o: V3; x: V3; z: V3 }
export type MateType = 'fastened' | 'revolute' | 'slider' | 'planar' | 'cylindrical' | 'pin-slot' | 'ball' | 'parallel';

export interface SolverBody {
  id: string;
  pose: Pose;
  fixed: boolean;
  /** Where the part turns about when it's moved, in its own coordinates, and roughly how big it is. */
  center?: V3;
  size?: number;
}
export interface SolverMate {
  id: string;
  name: string;
  type: MateType;
  /** The instances and their connectors. */
  a: string;
  b: string;
  fa: Frame;
  fb: Frame;
  /** Flips the second connector's Z, and turns it by quarter turns. */
  flip?: boolean;
  quarter?: number;
}
export interface MateFailure { mate: string; reason: string }
export interface SolveResult { poses: Map<string, Pose>; failed: MateFailure[]; dof: number; residual: number }

export const IDENTITY: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
export const MATE_DOF: Record<MateType, number> = { fastened: 0, revolute: 1, slider: 1, planar: 3, cylindrical: 2, 'pin-slot': 2, ball: 3, parallel: 4 };
const TOL = 1e-7;
const NAMES: Record<MateType, string> = { fastened: 'Fastened', revolute: 'Revolute', slider: 'Slider', planar: 'Planar', cylindrical: 'Cylindrical', 'pin-slot': 'Pin slot', ball: 'Ball', parallel: 'Parallel' };
export const mateTypeName = (t: MateType) => NAMES[t];

interface WorldFrame { o: V3; x: V3; y: V3; z: V3 }

export const apply = (pose: Pose, v: V3): V3 => add(pose.p, quatRotate(pose.q, v));

/** A connector as the mate reads it, with its flip and quarter turns. */
export function adjustedFrame(f: Frame, flip = false, quarter = 0): Frame {
  let x = f.x, z = f.z, y = cross(z, x);
  if (flip) {
    z = scale(z, -1);
    y = scale(y, -1);
  }
  const k = ((quarter % 4) + 4) % 4;
  for (let i = 0; i < k; i++) [x, y] = [y, scale(x, -1)];
  return { o: f.o, x, z };
}

function worldFrame(pose: Pose, f: Frame): WorldFrame {
  const z = quatRotate(pose.q, f.z), x = quatRotate(pose.q, f.x);
  return { o: apply(pose, f.o), x, y: cross(z, x), z };
}

/** Where a part's pose has to be for its connector to sit exactly on a frame given in world coordinates. */
export function snapPose(moving: Frame, onto: { o: V3; x: V3; z: V3 }): Pose {
  const toWorld = quatFromBasis(onto.x, cross(onto.z, onto.x), onto.z);
  const toLocal = quatFromBasis(moving.x, cross(moving.z, moving.x), moving.z);
  const q = quatNormalize(quatMul(toWorld, [-toLocal[0], -toLocal[1], -toLocal[2], toLocal[3]]));
  return { p: sub(onto.o, quatRotate(q, moving.o)), q };
}

/** Where the first connector of a mate should go so the two coincide: the pose for part `a`. */
export function snapFirst(m: SolverMate, poseB: Pose): Pose {
  const b = adjustedFrame(m.fb, m.flip, m.quarter);
  return snapPose(m.fa, { o: apply(poseB, b.o), x: quatRotate(poseB.q, b.x), z: quatRotate(poseB.q, b.z) });
}

/** The same, for moving the second part onto the first. */
export function snapSecond(m: SolverMate, poseA: Pose): Pose {
  const b = adjustedFrame(m.fb, m.flip, m.quarter);
  return snapPose(b, { o: apply(poseA, m.fa.o), x: quatRotate(poseA.q, m.fa.x), z: quatRotate(poseA.q, m.fa.z) });
}

// Cyclic Jacobi, which is short, accurate and fine at the sizes one group of mated parts reaches.
export function symEig(input: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
  const a = input.slice();
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0, diag = 0;
    for (let i = 0; i < n; i++) {
      diag += a[i * n + i] * a[i * n + i];
      for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
    }
    if (off <= 1e-26 * (diag + 1e-300)) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  return { values, vectors: v };
}

/** One equation: its error, and how it changes with each variable. */
interface Row { value: number; coef: Map<number, number> }

interface System {
  vars: string[];
  index: Map<string, number>;
  bodies: Map<string, SolverBody>;
  poses: Map<string, Pose>;
  /** Unknowns are scaled: a move as it is, a turn by the part's size, each by its weight. */
  moveScale: number[];
  turnScale: number[];
  angular: number;
}

function makeSystem(bodies: Map<string, SolverBody>, poses: Map<string, Pose>, vars: string[], light?: Set<string>): System {
  const index = new Map(vars.map((v, i) => [v, i]));
  let angular = 1;
  const moveScale: number[] = [], turnScale: number[] = [];
  for (const id of vars) {
    const b = bodies.get(id)!;
    const size = Math.max(b.size ?? 1, 1e-3);
    angular = Math.max(angular, size);
    // Something light takes the movement, and everything else stays as still as it can.
    const weight = light && light.size ? (light.has(id) ? 1 : 0.02) : 1;
    moveScale.push(weight);
    turnScale.push(weight / size);
  }
  return { vars, index, bodies, poses, moveScale, turnScale, angular };
}

const centerOf = (sys: System, id: string): V3 => apply(sys.poses.get(id)!, sys.bodies.get(id)!.center ?? [0, 0, 0]);

function addCoef(row: Row, sys: System, id: string, move: V3 | null, turn: V3 | null) {
  const i = sys.index.get(id);
  if (i === undefined) return;
  const base = i * 6;
  if (move) for (let k = 0; k < 3; k++) if (move[k]) row.coef.set(base + k, (row.coef.get(base + k) ?? 0) + move[k] * sys.moveScale[i]);
  if (turn) for (let k = 0; k < 3; k++) if (turn[k]) row.coef.set(base + 3 + k, (row.coef.get(base + 3 + k) ?? 0) + turn[k] * sys.turnScale[i]);
}

const AXES: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function mateRows(sys: System, m: SolverMate): Row[] {
  const fa = sys.poses.get(m.a)!, fb = sys.poses.get(m.b)!;
  const A = worldFrame(fa, m.fa);
  const B = worldFrame(fb, adjustedFrame(m.fb, m.flip, m.quarter));
  const ca = centerOf(sys, m.a), cb = centerOf(sys, m.b);
  const ra = sub(A.o, ca), rb = sub(B.o, cb);
  const d = sub(B.o, A.o);
  const rows: Row[] = [];
  /** How far apart the connectors are along a direction fixed in the world. */
  const along = (u: V3) => {
    const row: Row = { value: dot(d, u), coef: new Map() };
    addCoef(row, sys, m.b, u, cross(rb, u));
    addCoef(row, sys, m.a, scale(u, -1), scale(cross(ra, u), -1));
    rows.push(row);
  };
  /** The same along a direction that turns with the first connector. */
  const alongA = (u: V3) => {
    const row: Row = { value: dot(d, u), coef: new Map() };
    addCoef(row, sys, m.b, u, cross(rb, u));
    addCoef(row, sys, m.a, scale(u, -1), add(scale(cross(ra, u), -1), cross(u, d)));
    rows.push(row);
  };
  /** Two axes pointing the same way. Scaled, so that being a turn out counts like being a distance out. */
  const aligned = (ua: V3, ub: V3) => {
    const S = sys.angular;
    for (const e of AXES) {
      const row: Row = { value: S * dot(sub(ub, ua), e), coef: new Map() };
      addCoef(row, sys, m.b, null, scale(cross(ub, e), S));
      addCoef(row, sys, m.a, null, scale(cross(ua, e), -S));
      rows.push(row);
    }
  };
  switch (m.type) {
    case 'fastened':
      AXES.forEach(along);
      aligned(A.z, B.z);
      aligned(A.x, B.x);
      break;
    case 'revolute':
      AXES.forEach(along);
      aligned(A.z, B.z);
      break;
    case 'slider':
      alongA(A.x);
      alongA(A.y);
      aligned(A.z, B.z);
      aligned(A.x, B.x);
      break;
    case 'cylindrical':
      alongA(A.x);
      alongA(A.y);
      aligned(A.z, B.z);
      break;
    case 'planar':
      alongA(A.z);
      aligned(A.z, B.z);
      break;
    case 'pin-slot':
      alongA(A.y);
      alongA(A.z);
      aligned(A.z, B.z);
      break;
    case 'ball':
      AXES.forEach(along);
      break;
    case 'parallel':
      aligned(A.z, B.z);
      break;
  }
  return rows;
}

const allRows = (sys: System, mates: SolverMate[]) => mates.flatMap((m) => mateRows(sys, m));
const worst = (rows: Row[]) => rows.reduce((w, r) => Math.max(w, Math.abs(r.value)), 0);

/** The solution of `rows · x = rhs` with the smallest norm, the rank, and what's left free. */
function leastNorm(rows: { coef: Map<number, number> }[], rhs: number[], basis: Float64Array[] | null, n: number) {
  const k = basis ? basis.length : n;
  const product = (r: { coef: Map<number, number> }, column: number) => {
    if (!basis) return r.coef.get(column) ?? 0;
    let total = 0;
    for (const [i, v] of r.coef) total += v * basis[column][i];
    return total;
  };
  const m = rows.length;
  const A = new Float64Array(m * k);
  for (let i = 0; i < m; i++) for (let j = 0; j < k; j++) A[i * k + j] = product(rows[i], j);
  const AtA = new Float64Array(k * k);
  for (let i = 0; i < m; i++) {
    for (let a = 0; a < k; a++) {
      const v = A[i * k + a];
      if (!v) continue;
      for (let b = 0; b < k; b++) AtA[a * k + b] += v * A[i * k + b];
    }
  }
  const { values, vectors } = symEig(AtA, k);
  const largest = values.reduce((w, v) => Math.max(w, v), 0);
  const cut = Math.max(largest * 1e-10, 1e-13);
  const Atb = new Float64Array(k);
  for (let i = 0; i < m; i++) for (let a = 0; a < k; a++) Atb[a] += A[i * k + a] * rhs[i];
  const y = new Float64Array(k);
  let rank = 0;
  const free: Float64Array[] = [];
  for (let e = 0; e < k; e++) {
    if (values[e] > cut) {
      rank++;
      let c = 0;
      for (let a = 0; a < k; a++) c += vectors[a * k + e] * Atb[a];
      c /= values[e];
      for (let a = 0; a < k; a++) y[a] += c * vectors[a * k + e];
    } else {
      const u = new Float64Array(n);
      if (basis) for (let j = 0; j < k; j++) { const w = vectors[j * k + e]; if (w) for (let i = 0; i < n; i++) u[i] += w * basis[j][i]; }
      else for (let i = 0; i < n; i++) u[i] = vectors[i * k + e];
      free.push(u);
    }
  }
  const x = new Float64Array(n);
  if (basis) for (let j = 0; j < k; j++) { if (y[j]) for (let i = 0; i < n; i++) x[i] += y[j] * basis[j][i]; }
  else x.set(y);
  return { x, rank, free };
}

/** Moves the parts by a step, keeping turns small enough for the equations to stay close to true. */
function applyStep(sys: System, step: Float64Array, factor = 1): Map<string, Pose> {
  const out = new Map(sys.poses);
  sys.vars.forEach((id, i) => {
    const b = i * 6;
    const body = sys.bodies.get(id)!;
    const move: V3 = [step[b] * sys.moveScale[i] * factor, step[b + 1] * sys.moveScale[i] * factor, step[b + 2] * sys.moveScale[i] * factor];
    const turn: V3 = [step[b + 3] * sys.turnScale[i] * factor, step[b + 4] * sys.turnScale[i] * factor, step[b + 5] * sys.turnScale[i] * factor];
    const pose = sys.poses.get(id)!;
    const local = body.center ?? [0, 0, 0];
    const center = add(apply(pose, local), move);
    const angle = Math.hypot(turn[0], turn[1], turn[2]);
    const q = angle > 1e-14 ? quatNormalize(quatMul(quatAxis(scale(turn, 1 / angle), angle), pose.q)) : pose.q;
    out.set(id, { p: sub(center, quatRotate(q, local)), q });
  });
  return out;
}

function largestTurn(sys: System, step: Float64Array) {
  let most = 0;
  sys.vars.forEach((_, i) => {
    const b = i * 6;
    most = Math.max(most, Math.hypot(step[b + 3], step[b + 4], step[b + 5]) * sys.turnScale[i]);
  });
  return most;
}

/** Gauss-Newton with the smallest step each time. It's true when the mates end up met. */
function settle(sys: System, mates: SolverMate[], iterations = 80): boolean {
  // Exactly opposite axes are a dead spot for the equations, so a part sitting there gets a nudge out of it.
  for (const m of mates) {
    if (m.type === 'ball') continue;
    const A = worldFrame(sys.poses.get(m.a)!, m.fa);
    const B = worldFrame(sys.poses.get(m.b)!, adjustedFrame(m.fb, m.flip, m.quarter));
    if (dot(A.z, B.z) < -0.9999) {
      const id = sys.index.has(m.b) ? m.b : m.a;
      if (!sys.index.has(id)) continue;
      const pose = sys.poses.get(id)!;
      sys.poses.set(id, { p: pose.p, q: quatNormalize(quatMul(quatAxis(B.x, 0.05), pose.q)) });
    }
  }
  const n = sys.vars.length * 6;
  for (let it = 0; it < iterations; it++) {
    const rows = allRows(sys, mates);
    const error = worst(rows);
    if (error < TOL) return true;
    if (!n) return false;
    const { x } = leastNorm(rows, rows.map((r) => -r.value), null, n);
    const most = largestTurn(sys, x);
    let factor = most > 0.5 ? 0.5 / most : 1;
    const before = sys.poses;
    let improved = false;
    for (let halve = 0; halve < 10; halve++) {
      sys.poses = applyStep({ ...sys, poses: before }, x, factor);
      const after = worst(allRows(sys, mates));
      if (after < error * (1 - 1e-4 * factor) || after < TOL) {
        improved = true;
        break;
      }
      factor /= 2;
    }
    if (!improved) {
      sys.poses = before;
      return worst(allRows(sys, mates)) < TOL;
    }
  }
  return worst(allRows(sys, mates)) < TOL * 10;
}

/** Groups of free parts tied together by mates. A fixed part doesn't tie anything to anything. */
function groupsOf(bodies: Map<string, SolverBody>, mates: SolverMate[]) {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const m of mates) {
    if (bodies.get(m.a)?.fixed || bodies.get(m.b)?.fixed) continue;
    parent.set(find(m.a), find(m.b));
  }
  const groups = new Map<string, { vars: Set<string>; mates: SolverMate[] }>();
  const group = (key: string) => {
    if (!groups.has(key)) groups.set(key, { vars: new Set(), mates: [] });
    return groups.get(key)!;
  };
  for (const m of mates) {
    const free = [m.a, m.b].filter((id) => !bodies.get(id)?.fixed);
    const key = free.length ? find(free[0]) : `fixed:${m.id}`;
    const g = group(key);
    g.mates.push(m);
    free.forEach((id) => g.vars.add(id));
  }
  return [...groups.values()];
}

function reasonFor(m: SolverMate, bodies: Map<string, SolverBody>, others: SolverMate[]) {
  if (m.a === m.b) return 'Both of its connectors are on the same part.';
  if (bodies.get(m.a)?.fixed && bodies.get(m.b)?.fixed) return 'Both of its parts are fixed, so neither can move to meet it. Unfix one of them.';
  const names = others.filter((o) => o.a === m.a || o.b === m.a || o.a === m.b || o.b === m.b).map((o) => o.name);
  return names.length
    ? `This can’t hold at the same time as ${names.join(', ')}. Suppress or change one of them.`
    : 'Its connectors can’t be brought together where they are. Try flipping it, or pick other connectors.';
}

/** How much the parts can still move, given the mates. */
export function freedom(bodyList: SolverBody[], mates: SolverMate[]) {
  const bodies = new Map(bodyList.map((b) => [b.id, b]));
  const poses = new Map(bodyList.map((b) => [b.id, b.pose]));
  let dof = bodyList.filter((b) => !b.fixed).length * 6;
  for (const g of groupsOf(bodies, mates)) {
    if (!g.vars.size) continue;
    const sys = makeSystem(bodies, poses, [...g.vars]);
    const rows = allRows(sys, g.mates);
    dof -= leastNorm(rows, rows.map(() => 0), null, sys.vars.length * 6).rank;
  }
  return dof;
}

/**
 * Meets every mate it can with as little movement as it can. Mates that can't be met all go by turns from the first, so
 * the earlier ones hold and each one that can't is named with why. `light` parts are the ones to move first.
 */
export function solve(bodyList: SolverBody[], mateList: SolverMate[], options: { light?: string[] } = {}): SolveResult {
  const bodies = new Map(bodyList.map((b) => [b.id, b]));
  const poses = new Map(bodyList.map((b) => [b.id, b.pose]));
  const failed: MateFailure[] = [];
  const usable: SolverMate[] = [];
  for (const m of mateList) {
    if (m.a === m.b || !bodies.has(m.a) || !bodies.has(m.b)) failed.push({ mate: m.id, reason: reasonFor(m, bodies, []) });
    else usable.push(m);
  }
  const light = new Set(options.light ?? []);
  const kept: SolverMate[] = [];
  let residual = 0;
  for (const g of groupsOf(bodies, usable)) {
    const start = new Map(poses);
    const sys = makeSystem(bodies, start, [...g.vars], light);
    if (settle(sys, g.mates)) {
      for (const id of g.vars) poses.set(id, sys.poses.get(id)!);
      kept.push(...g.mates);
      continue;
    }
    // Not all together, so one by one.
    const good: SolverMate[] = [];
    let current = new Map(poses);
    for (const m of g.mates) {
      const trial = [...good, m];
      const vars = [...new Set(trial.flatMap((x) => [x.a, x.b]))].filter((id) => !bodies.get(id)?.fixed);
      const t = makeSystem(bodies, new Map(current), vars, light);
      if (settle(t, trial)) {
        good.push(m);
        current = t.poses;
      } else {
        failed.push({ mate: m.id, reason: reasonFor(m, bodies, good) });
      }
    }
    for (const id of g.vars) poses.set(id, current.get(id) ?? poses.get(id)!);
    kept.push(...good);
  }
  const finalSys = makeSystem(bodies, poses, []);
  residual = worst(allRows(finalSys, kept));
  const settled = bodyList.map((b) => ({ ...b, pose: poses.get(b.id)! }));
  return { poses, failed, dof: freedom(settled, kept), residual };
}

/** Something a drag is trying to do to one part. */
export type DragGoal =
  | { kind: 'point'; body: string; local: V3; target: V3 }
  | { kind: 'pose'; body: string; pose: Pose };

function goalRows(sys: System, goal: DragGoal): { rows: Row[]; turns: Row[] } {
  const rows: Row[] = [];
  const turns: Row[] = [];
  const pose = sys.poses.get(goal.body)!;
  const c = centerOf(sys, goal.body);
  for (let k = 0; k < 3; k++) {
    const t: Row = { value: 0, coef: new Map() };
    addCoef(t, sys, goal.body, null, AXES[k]);
    turns.push(t);
  }
  if (goal.kind === 'point') {
    const at = apply(pose, goal.local);
    const r = sub(at, c);
    AXES.forEach((e, k) => {
      const row: Row = { value: goal.target[k] - at[k], coef: new Map() };
      addCoef(row, sys, goal.body, e, cross(r, e));
      rows.push(row);
    });
  } else {
    const want = apply(goal.pose, sys.bodies.get(goal.body)!.center ?? [0, 0, 0]);
    AXES.forEach((e, k) => {
      const row: Row = { value: want[k] - c[k], coef: new Map() };
      addCoef(row, sys, goal.body, e, null);
      rows.push(row);
    });
    const q = quatMul(goal.pose.q, [-pose.q[0], -pose.q[1], -pose.q[2], pose.q[3]]);
    const v: V3 = q[3] < 0 ? [-q[0], -q[1], -q[2]] : [q[0], q[1], q[2]];
    const s = Math.hypot(v[0], v[1], v[2]);
    const angle = 2 * Math.atan2(s, Math.abs(q[3]));
    const size = Math.max(sys.bodies.get(goal.body)!.size ?? 1, 1e-3);
    AXES.forEach((e, k) => {
      const row: Row = { value: (s > 1e-12 ? (v[k] / s) * angle : 0) * size, coef: new Map() };
      addCoef(row, sys, goal.body, null, scale(e, size));
      rows.push(row);
    });
  }
  return { rows, turns };
}

function goalError(sys: System, goal: DragGoal) {
  const pose = sys.poses.get(goal.body)!;
  if (goal.kind === 'point') {
    const at = apply(pose, goal.local);
    return Math.hypot(at[0] - goal.target[0], at[1] - goal.target[1], at[2] - goal.target[2]);
  }
  const body = sys.bodies.get(goal.body)!;
  const c = centerOf(sys, goal.body), want = apply(goal.pose, body.center ?? [0, 0, 0]);
  const d = Math.abs(pose.q[0] * goal.pose.q[0] + pose.q[1] * goal.pose.q[1] + pose.q[2] * goal.pose.q[2] + pose.q[3] * goal.pose.q[3]);
  return Math.hypot(c[0] - want[0], c[1] - want[1], c[2] - want[2]) + 2 * Math.acos(Math.min(1, d)) * (body.size ?? 1);
}

/**
 * Moves a part toward a goal only as its mates allow. Parts it's mated to come along if they're free. It gives back the
 * new poses, or null if it can't move at all, such as when it's fixed.
 */
export function dragTo(bodyList: SolverBody[], mates: SolverMate[], goal: DragGoal, iterations = 12): Map<string, Pose> | null {
  const bodies = new Map(bodyList.map((b) => [b.id, b]));
  if (!bodies.has(goal.body) || bodies.get(goal.body)!.fixed) return null;
  const group = groupsOf(bodies, mates).find((g) => g.vars.has(goal.body));
  const vars = group ? [...group.vars] : [goal.body];
  const active = group ? group.mates : [];
  const start = new Map(bodyList.map((b) => [b.id, b.pose]));
  const sys = makeSystem(bodies, new Map(start), vars);
  const n = vars.length * 6;
  for (let it = 0; it < iterations; it++) {
    const rows = allRows(sys, active);
    const first = leastNorm(rows, rows.map((r) => -r.value), null, n);
    const step = first.x;
    const g = goalRows(sys, goal);
    const dot2 = (r: { coef: Map<number, number> }, x: Float64Array) => { let t = 0; for (const [i, v] of r.coef) t += v * x[i]; return t; };
    const second = leastNorm(g.rows, g.rows.map((r) => r.value - dot2(r, step)), first.free, n);
    for (let i = 0; i < n; i++) step[i] += second.x[i];
    if (second.free.length) {
      const third = leastNorm(g.turns, g.turns.map((r) => -dot2(r, step)), second.free, n);
      for (let i = 0; i < n; i++) step[i] += third.x[i];
    }
    const most = largestTurn(sys, step);
    if (Math.sqrt(step.reduce((t, v) => t + v * v, 0)) < 1e-9) break;
    // Far from where it can reach, the straight-line step overshoots, and the part would shake. So it has to get closer.
    const away = goalError(sys, goal);
    let factor = most > 0.3 ? 0.3 / most : 1;
    let moved = false;
    for (let halve = 0; halve < 12 && !moved; halve++) {
      const trial = applyStep(sys, step, factor);
      if (goalError({ ...sys, poses: trial }, goal) < away - 1e-12) {
        sys.poses = trial;
        moved = true;
      }
      factor /= 2;
    }
    if (!moved) break;
  }
  if (active.length) {
    settle(sys, active, 12);
    if (worst(allRows(sys, active)) > TOL * 100) return null;
  }
  return sys.poses;
}

/** The world position and axes of each of a mate's connectors, to draw it or measure it. */
export function mateFrames(m: SolverMate, poses: Map<string, Pose>) {
  return { a: worldFrame(poses.get(m.a)!, m.fa), b: worldFrame(poses.get(m.b)!, adjustedFrame(m.fb, m.flip, m.quarter)) };
}

