import { add, cross, dot, normalize, scale, sub, type V3 } from '../viewport/math';
import type { ConnectorRef } from './model';
import type { EdgeData, PartMesh } from './parts';
import { symEig, type Frame } from './solver';

/**
 * Implicit mate connectors, as in Onshape: where one can go on a face or edge, with the direction it takes there.
 * A flat face has them at its centroid, vertices, edge midpoints and arc centers, with Z along its normal. A round face
 * has them along its axis, at the middle and ends. A straight edge has them at its middle and ends, and a round edge at
 * its center.
 */
export interface Spot { kind: 'face' | 'edge'; ref: string; how: string; frame: Frame }

/** A consistent X for a Z, so a connector's sideways direction doesn't depend on anything but the part. */
function sideways(z: V3): V3 {
  const pick: V3 = Math.abs(z[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  return normalize(sub(pick, scale(z, dot(pick, z))));
}
const frameAt = (o: V3, z: V3, x?: V3): Frame => {
  const unit = normalize(z);
  const side = x ? sub(x, scale(unit, dot(x, unit))) : null;
  return { o, z: unit, x: side && Math.hypot(side[0], side[1], side[2]) > 1e-6 ? normalize(side) : sideways(unit) };
};

function facePoints(part: PartMesh, face: number) {
  const seen = new Set<number>();
  const points: V3[] = [], normals: V3[] = [];
  let area = 0;
  const centroid: V3 = [0, 0, 0];
  const at = (v: number): V3 => [part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]];
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = part.indices[t], b = part.indices[t + 1], c = part.indices[t + 2];
    if (part.faceIds[a] !== face) continue;
    const pa = at(a), pb = at(b), pc = at(c);
    const n = cross(sub(pb, pa), sub(pc, pa));
    const w = Math.hypot(n[0], n[1], n[2]) / 2;
    area += w;
    for (let k = 0; k < 3; k++) centroid[k] += (w * (pa[k] + pb[k] + pc[k])) / 3;
    for (const v of [a, b, c]) {
      if (seen.has(v)) continue;
      seen.add(v);
      points.push(at(v));
      normals.push([part.normals[v * 3], part.normals[v * 3 + 1], part.normals[v * 3 + 2]]);
    }
  }
  return { points, normals, centroid: (area > 0 ? scale(centroid, 1 / area) : centroid) as V3 };
}

/** The direction a round face's normals don't vary along. */
function axisOf(normals: V3[]): V3 {
  const mean: V3 = [0, 0, 0];
  for (const n of normals) for (let k = 0; k < 3; k++) mean[k] += n[k] / normals.length;
  const c = new Float64Array(9);
  for (const n of normals) {
    const d = sub(n, mean);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i * 3 + j] += d[i] * d[j];
  }
  const { values, vectors } = symEig(c, 3);
  let e = 0;
  for (let i = 1; i < 3; i++) if (values[i] < values[e]) e = i;
  const axis: V3 = [vectors[e], vectors[3 + e], vectors[6 + e]];
  // Either way along an axis is as good, so settle on one.
  let big = 0;
  for (let k = 1; k < 3; k++) if (Math.abs(axis[k]) > Math.abs(axis[big]) + 1e-9) big = k;
  return normalize(axis[big] < 0 ? scale(axis, -1) : axis);
}

function adjacentFaces(part: PartMesh, e: EdgeData) {
  const between = (e.select as { between?: string[] } | undefined)?.between;
  if (between) return part.faces.filter((f) => between.includes(f.key));
  const names = e.name.split('|');
  return part.faces.filter((f) => names.includes(f.name));
}

const isBoundary = (part: PartMesh, e: EdgeData, face: number) => adjacentFaces(part, e).includes(part.faces[face]);

function planeOfEdge(part: PartMesh, e: EdgeData): V3 | null {
  return adjacentFaces(part, e).find((f) => f.surface === 'plane')?.normal ?? null;
}

function roundNormal(part: PartMesh, e: EdgeData): V3 {
  const flat = planeOfEdge(part, e);
  if (flat) return flat;
  const center = e.center ?? e.midpoint;
  const n = cross(sub(e.start, center), sub(e.midpoint, center));
  return Math.hypot(n[0], n[1], n[2]) > 1e-9 ? normalize(n) : [0, 0, 1];
}

function uniqueSpots(spots: Spot[]) {
  const seen = new Set<string>();
  return spots.filter((s) => {
    const key = s.frame.o.map((v) => Math.round(v * 1000)).join();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether the arcs around a center make a whole circle, whose seam points aren't anywhere you'd want a connector. */
function isWholeCircle(edges: EdgeData[], e: EdgeData) {
  const c = e.center!, r = (e as { radius?: number }).radius ?? 0;
  const total = edges.filter((x) => x.center && Math.hypot(x.center[0] - c[0], x.center[1] - c[1], x.center[2] - c[2]) < 1e-6).reduce((t, x) => t + x.length, 0);
  return total > 2 * Math.PI * r * 0.97;
}

function flatFaceSpots(part: PartMesh, face: number): Spot[] {
  const f = part.faces[face];
  const z = f.normal;
  const ref = f.key;
  const spots: Spot[] = [{ kind: 'face', ref, how: 'centroid', frame: frameAt(facePoints(part, face).centroid, z) }];
  const around = part.edges.filter((e) => e && isBoundary(part, e, face));
  for (const e of around) {
    if (e.curve === 'line') {
      spots.push({ kind: 'face', ref, how: 'edge-mid', frame: frameAt(e.midpoint, z) });
      spots.push({ kind: 'face', ref, how: 'vertex', frame: frameAt(e.start, z) });
      spots.push({ kind: 'face', ref, how: 'vertex', frame: frameAt(e.end, z) });
    } else if (e.center) {
      spots.push({ kind: 'face', ref, how: 'arc-center', frame: frameAt(e.center, z) });
      if (!isWholeCircle(around, e)) {
        spots.push({ kind: 'face', ref, how: 'vertex', frame: frameAt(e.start, z) });
        spots.push({ kind: 'face', ref, how: 'vertex', frame: frameAt(e.end, z) });
        spots.push({ kind: 'face', ref, how: 'edge-mid', frame: frameAt(e.midpoint, z) });
      }
    } else {
      spots.push({ kind: 'face', ref, how: 'edge-mid', frame: frameAt(e.midpoint, z) });
    }
  }
  return uniqueSpots(spots);
}

function roundFaceSpots(part: PartMesh, face: number): Spot[] {
  const f = part.faces[face];
  const { points, normals, centroid } = facePoints(part, face);
  if (!points.length) return [];
  const radius = (f as { radius?: number }).radius;
  const ref = f.key;
  if (f.surface === 'sphere' && radius) {
    // Normals point straight out from the center, or in if it's a hollow.
    const out = add(points[0], scale(normals[0], -radius)), inward = add(points[0], scale(normals[0], radius));
    const other = points[points.length - 1], otherN = normals[normals.length - 1];
    const first = Math.hypot(...sub(out, add(other, scale(otherN, -radius))));
    const second = Math.hypot(...sub(inward, add(other, scale(otherN, radius))));
    return [{ kind: 'face', ref, how: 'center', frame: frameAt(first <= second ? out : inward, [0, 0, 1]) }];
  }
  if (f.surface === 'cylinder' && radius) {
    const axis = axisOf(normals);
    const spread = (sign: number) => {
      const pts = points.map((p, i) => add(p, scale(normals[i], sign * radius)));
      const mean: V3 = [0, 0, 0];
      for (const p of pts) for (let k = 0; k < 3; k++) mean[k] += p[k] / pts.length;
      let s = 0;
      for (const p of pts) {
        const d = sub(p, mean);
        const off = sub(d, scale(axis, dot(d, axis)));
        s += dot(off, off);
      }
      return { mean, s };
    };
    const inner = spread(1), outer = spread(-1);
    const on = inner.s < outer.s ? inner.mean : outer.mean;
    let lo = Infinity, hi = -Infinity;
    for (const p of points) {
      const t = dot(sub(p, on), axis);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    const at = (t: number) => add(on, scale(axis, t));
    return [
      { kind: 'face', ref, how: 'axis-mid', frame: frameAt(at((lo + hi) / 2), axis) },
      { kind: 'face', ref, how: 'axis-start', frame: frameAt(at(lo), axis) },
      { kind: 'face', ref, how: 'axis-end', frame: frameAt(at(hi), axis) },
    ];
  }
  // Anything else round: where its circular edges are centered, and otherwise its middle.
  const around = part.edges.filter((e) => e?.center && isBoundary(part, e, face));
  if (around.length) {
    const z = f.surface === 'cone' ? axisOf(normals) : roundNormal(part, around[0]);
    return uniqueSpots(around.map((e) => ({ kind: 'face' as const, ref, how: 'arc-center', frame: frameAt(e.center!, z) })));
  }
  const mean: V3 = [0, 0, 0];
  for (const n of normals) for (let k = 0; k < 3; k++) mean[k] += n[k];
  return [{ kind: 'face', ref, how: 'centroid', frame: frameAt(centroid, Math.hypot(...mean) > 1e-6 ? normalize(mean) : f.normal) }];
}

const memo = new WeakMap<PartMesh, Map<string, Spot[]>>();
function remembered(part: PartMesh, key: string, make: () => Spot[]) {
  let m = memo.get(part);
  if (!m) memo.set(part, (m = new Map()));
  let found = m.get(key);
  if (!found) m.set(key, (found = make()));
  return found;
}

export function faceSpots(part: PartMesh, face: number): Spot[] {
  const f = part.faces[face];
  if (!f) return [];
  return remembered(part, `f${face}`, () => (f.surface === 'plane' ? flatFaceSpots(part, face) : roundFaceSpots(part, face)));
}

export function edgeSpots(part: PartMesh, edge: number): Spot[] {
  const e = part.edges[edge];
  if (!e) return [];
  return remembered(part, `e${edge}`, () => {
    const ref = e.name;
    if (e.curve === 'line') {
      const along = e.direction ?? normalize(sub(e.end, e.start));
      const flat = planeOfEdge(part, e);
      const z = flat ?? sideways(along);
      return uniqueSpots([
        { kind: 'edge', ref, how: 'mid', frame: frameAt(e.midpoint, z, along) },
        { kind: 'edge', ref, how: 'end', frame: frameAt(e.start, z, along) },
        { kind: 'edge', ref, how: 'end', frame: frameAt(e.end, z, along) },
      ]);
    }
    if (e.center) {
      const z = roundNormal(part, e);
      const spots: Spot[] = [{ kind: 'edge', ref, how: 'center', frame: frameAt(e.center, z) }];
      if (!isWholeCircle(part.edges.filter(Boolean), e)) {
        spots.push({ kind: 'edge', ref, how: 'mid', frame: frameAt(e.midpoint, z) });
        spots.push({ kind: 'edge', ref, how: 'end', frame: frameAt(e.start, z) });
        spots.push({ kind: 'edge', ref, how: 'end', frame: frameAt(e.end, z) });
      }
      return uniqueSpots(spots);
    }
    return uniqueSpots([
      { kind: 'edge', ref, how: 'mid', frame: frameAt(e.midpoint, sideways(normalize(sub(e.end, e.start)))) },
      { kind: 'edge', ref, how: 'end', frame: frameAt(e.start, sideways(normalize(sub(e.end, e.start)))) },
      { kind: 'edge', ref, how: 'end', frame: frameAt(e.end, sideways(normalize(sub(e.end, e.start)))) },
    ]);
  });
}

/**
 * Finds a connector again after its part has changed: the same inference point on the same face or edge, nearest where
 * it was. Null means the face or edge has gone.
 */
export function findSpot(part: PartMesh, c: ConnectorRef): Frame | null {
  let spots: Spot[] = [];
  if (c.kind === 'face') {
    const i = part.faces.findIndex((f) => f.key === c.ref);
    if (i >= 0) spots = faceSpots(part, i);
  } else {
    const i = part.edges.findIndex((e) => e?.name === c.ref);
    if (i >= 0) spots = edgeSpots(part, i);
  }
  const same = spots.filter((s) => s.how === c.how);
  const list = same.length ? same : spots;
  if (!list.length) return null;
  let best = list[0], bestD = Infinity;
  for (const s of list) {
    const d = Math.hypot(s.frame.o[0] - c.frame.o[0], s.frame.o[1] - c.frame.o[1], s.frame.o[2] - c.frame.o[2]);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best.frame;
}
