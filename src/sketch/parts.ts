import type { MeshData } from '../engine/client';
import type { EdgeInfo, VertexRef } from '../store/doc';
import type { V3 } from '../viewport/math';

/**
 * The corners and edges of the parts a sketch is drawn against, to pick while sketching, as Onshape lets you pick them
 * to make a sketch point coincident with a corner or put it on an edge. While sketching, the view shows the model as it
 * stood before the sketch, so these are numbered as the view's own edges are.
 */
export interface PartCorner { p: V3; vertex: VertexRef }
export interface PartEdge { select: unknown; curve: string; length: number; pts: V3[]; start: V3; end: V3; closed: boolean }
export interface PartGeometry { corners: PartCorner[]; edges: PartEdge[]; cornerAt: Map<string, number> }

/** A part's corner is `pv3`, and its edge `pe12`. Neither has a dot or starts with c, so nothing takes them for a sketch's own. */
export const isPartRef = (ref: string) => /^p[ve]\d+$/.test(ref);
export const isPartCorner = (ref: string) => /^pv\d+$/.test(ref);
export const isPartEdge = (ref: string) => /^pe\d+$/.test(ref);
export const partIndex = (ref: string) => Number(ref.slice(2));

const keyOf = (p: V3) => p.map((c) => c.toFixed(5)).join();
const same = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-7;

export function partGeometry(edges: EdgeInfo[], mesh: MeshData | null): PartGeometry | null {
  if (!mesh || !edges.length) return null;
  const pts = new Map<number, V3[]>();
  const s = mesh.segments;
  for (let k = 0; k < mesh.segmentIds.length; k++) {
    const id = mesh.segmentIds[k];
    const list = pts.get(id) ?? [];
    const a: V3 = [s[k * 6], s[k * 6 + 1], s[k * 6 + 2]], b: V3 = [s[k * 6 + 3], s[k * 6 + 4], s[k * 6 + 5]];
    if (!list.length) list.push(a);
    list.push(b);
    pts.set(id, list);
  }
  const out: PartEdge[] = edges.map((e, i) => ({ select: e.select, curve: e.curve, length: e.length, pts: pts.get(i) ?? [], start: e.start, end: e.end, closed: same(e.start, e.end) }));
  // A corner is where edges end. A whole circle's seam isn't one, so a closed edge alone doesn't make one.
  const corners: PartCorner[] = [];
  const cornerAt = new Map<string, number>();
  edges.forEach((e, i) => {
    if (out[i].closed || !out[i].pts.length) return;
    for (const [v, p] of [[e.start_vertex, e.start], [e.end_vertex, e.end]] as const) {
      if (!v || cornerAt.has(keyOf(p))) continue;
      cornerAt.set(keyOf(p), corners.length);
      corners.push({ p, vertex: { faces: v.faces, near: p } });
    }
  });
  return { corners, edges: out, cornerAt };
}

/** The corner at one end of an edge, if that end is one. */
export const cornerOf = (g: PartGeometry, p: V3) => g.cornerAt.get(keyOf(p)) ?? null;
