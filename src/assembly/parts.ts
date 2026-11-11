import { Engine, type MeshData } from '../engine/client';
import type { EdgeInfo, FaceInfo } from '../store/doc';
import type { V3 } from '../viewport/math';

/** One part out of a Part Studio: its own mesh, in the studio's coordinates, with face and edge numbers of its own. */
export interface PartMesh {
  /** The kernel's name for it, which stays with it as the studio changes. */
  body: string;
  /** "Part 1", as the Part Studio's Parts list calls it. */
  label: string;
  positions: Float32Array;
  normals: Float32Array;
  faceIds: Uint32Array;
  indices: Uint32Array;
  segments: Float32Array;
  segmentIds: Uint32Array;
  faces: FaceData[];
  edges: EdgeData[];
  min: V3;
  max: V3;
  center: V3;
  size: number;
}
export type FaceData = FaceInfo & { body?: string };
export type EdgeData = EdgeInfo & { body?: string; center?: V3; direction?: V3 };

export interface StudioParts { text: string | null; parts: PartMesh[]; error?: string }

/** Takes the parts out of a whole studio's mesh. Pure, so it doesn't care which kernel made it. */
export function splitParts(m: MeshData, faces: FaceData[], edges: EdgeData[]): PartMesh[] {
  const out: PartMesh[] = [];
  m.parts.forEach((part, partIndex) => {
    const faceLocal = new Map(part.faces.map((f, i) => [f, i]));
    const edgeLocal = new Map(part.edges.map((e, i) => [e, i]));
    const vertexLocal = new Map<number, number>();
    const positions: number[] = [], normals: number[] = [], faceIds: number[] = [], indices: number[] = [];
    for (let t = 0; t < m.indices.length; t++) {
      const v = m.indices[t];
      const face = faceLocal.get(m.faceIds[v]);
      if (face === undefined) continue;
      let local = vertexLocal.get(v);
      if (local === undefined) {
        local = faceIds.length;
        vertexLocal.set(v, local);
        faceIds.push(face);
        positions.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
        normals.push(m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]);
      }
      indices.push(local);
    }
    const segments: number[] = [], segmentIds: number[] = [];
    for (let s = 0; s < m.segmentIds.length; s++) {
      const e = edgeLocal.get(m.segmentIds[s]);
      if (e === undefined) continue;
      segmentIds.push(e);
      for (let k = 0; k < 6; k++) segments.push(m.segments[s * 6 + k]);
    }
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
    }
    if (!indices.length) return;
    const partFaces = part.faces.map((f) => faces[f]);
    out.push({
      body: partFaces.find((f) => f?.body)?.body ?? `part${partIndex}`,
      label: `Part ${partIndex + 1}`,
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      faceIds: new Uint32Array(faceIds),
      indices: new Uint32Array(indices),
      segments: new Float32Array(segments),
      segmentIds: new Uint32Array(segmentIds),
      faces: partFaces,
      edges: part.edges.map((e) => edges[e]),
      min,
      max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      size: Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1e-3),
    });
  });
  return out;
}

// A kernel of its own: the main one holds whichever document is open, and reading a part mustn't disturb that.
let reader: Engine | null = null;
let tail: Promise<unknown> = Promise.resolve();
const cache = new Map<string, StudioParts>();

/** A Part Studio's parts. Reading is slow compared with drawing, so a studio is only read again if its document changed. */
export function loadStudio(tab: string, text: string | null): Promise<StudioParts> {
  const known = cache.get(tab);
  if (known && known.text === text) return Promise.resolve(known);
  const run = tail.then(async (): Promise<StudioParts> => {
    const again = cache.get(tab);
    if (again && again.text === text) return again;
    if (!text) {
      const none = { text, parts: [] };
      cache.set(tab, none);
      return none;
    }
    reader ??= new Engine();
    let found: StudioParts;
    try {
      const opened = await reader.call('document_open', { text });
      if (!opened.ok) throw new Error(opened.text);
      await reader.call('rebuild');
      const faces = await reader.call('faces_list');
      const edges = await reader.call('edges_list');
      const mesh = await reader.mesh(null);
      found = { text, parts: splitParts(mesh, faces.ok ? JSON.parse(faces.text) : [], edges.ok ? JSON.parse(edges.text) : []) };
    } catch (e) {
      found = { text, parts: [], error: (e as Error).message };
    }
    cache.set(tab, found);
    return found;
  });
  tail = run.catch(() => {});
  return run;
}

export const knownStudio = (tab: string) => cache.get(tab);
