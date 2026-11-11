import type { MeshData } from '../engine/client';
import type { V3 } from '../viewport/math';
import type { PartMesh } from './parts';
import type { Pose } from './solver';

export interface Baked {
  mesh: MeshData;
  /** Where each instance's faces and edges start in the merged numbering. */
  faceBase: number[];
  edgeBase: number[];
}

/**
 * All the instances as one mesh, in world coordinates, which needs nothing new from the renderer. Picking and
 * highlighting number faces and edges across the whole, so each instance is given a range of numbers.
 */
export function bakeParts(items: { part: PartMesh; pose: Pose }[]): Baked {
  let vertices = 0, indices = 0, segments = 0, faces = 0, edges = 0;
  for (const { part } of items) {
    vertices += part.faceIds.length;
    indices += part.indices.length;
    segments += part.segmentIds.length;
    faces += part.faces.length;
    edges += part.edges.length;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const faceIds = new Uint32Array(vertices);
  const outIndices = new Uint32Array(indices);
  const outSegments = new Float32Array(segments * 6);
  const segmentIds = new Uint32Array(segments);
  const parts: MeshData['parts'] = [];
  const faceBase: number[] = [], edgeBase: number[] = [];
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  let v = 0, i = 0, s = 0, f = 0, e = 0;
  for (const { part, pose } of items) {
    const [x, y, z, w] = pose.q;
    // The rotation as a matrix, which is what a lot of points want.
    const m00 = 1 - 2 * (y * y + z * z), m01 = 2 * (x * y - z * w), m02 = 2 * (x * z + y * w);
    const m10 = 2 * (x * y + z * w), m11 = 1 - 2 * (x * x + z * z), m12 = 2 * (y * z - x * w);
    const m20 = 2 * (x * z - y * w), m21 = 2 * (y * z + x * w), m22 = 1 - 2 * (x * x + y * y);
    const [tx, ty, tz] = pose.p;
    const count = part.faceIds.length;
    for (let k = 0; k < count; k++) {
      const a = part.positions[k * 3], b = part.positions[k * 3 + 1], c = part.positions[k * 3 + 2];
      const px = m00 * a + m01 * b + m02 * c + tx, py = m10 * a + m11 * b + m12 * c + ty, pz = m20 * a + m21 * b + m22 * c + tz;
      positions[(v + k) * 3] = px;
      positions[(v + k) * 3 + 1] = py;
      positions[(v + k) * 3 + 2] = pz;
      if (px < min[0]) min[0] = px;
      if (py < min[1]) min[1] = py;
      if (pz < min[2]) min[2] = pz;
      if (px > max[0]) max[0] = px;
      if (py > max[1]) max[1] = py;
      if (pz > max[2]) max[2] = pz;
      const na = part.normals[k * 3], nb = part.normals[k * 3 + 1], nc = part.normals[k * 3 + 2];
      normals[(v + k) * 3] = m00 * na + m01 * nb + m02 * nc;
      normals[(v + k) * 3 + 1] = m10 * na + m11 * nb + m12 * nc;
      normals[(v + k) * 3 + 2] = m20 * na + m21 * nb + m22 * nc;
      faceIds[v + k] = part.faceIds[k] + f;
    }
    for (let k = 0; k < part.indices.length; k++) outIndices[i + k] = part.indices[k] + v;
    const segCount = part.segmentIds.length;
    for (let k = 0; k < segCount; k++) {
      for (let end = 0; end < 2; end++) {
        const o = k * 6 + end * 3;
        const a = part.segments[o], b = part.segments[o + 1], c = part.segments[o + 2];
        const q = (s + k) * 6 + end * 3;
        outSegments[q] = m00 * a + m01 * b + m02 * c + tx;
        outSegments[q + 1] = m10 * a + m11 * b + m12 * c + ty;
        outSegments[q + 2] = m20 * a + m21 * b + m22 * c + tz;
      }
      segmentIds[s + k] = part.segmentIds[k] + e;
    }
    faceBase.push(f);
    edgeBase.push(e);
    parts.push({ name: `instance ${parts.length}`, sheet: false, faces: part.faces.map((_, n) => f + n), edges: part.edges.map((_, n) => e + n) });
    v += count;
    i += part.indices.length;
    s += segCount;
    f += part.faces.length;
    e += part.edges.length;
  }
  return {
    mesh: { positions, normals, faceIds, indices: outIndices, segments: outSegments, segmentIds, faces, edges, parts, min, max },
    faceBase,
    edgeBase,
  };
}

/** Which item a merged number belongs to. */
export function ownerOf(bases: number[], id: number) {
  let lo = 0, hi = bases.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bases[mid] <= id) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
