import earcut from 'earcut';
import { engine } from '../engine/client';
import { segPoints, type V2 } from './geometry';

/** A closed area a sketch's curves make, ready to draw and to pick. */
export interface SketchRegion {
  /** The kernel's name for it, which survives solving, dragging and dimension changes. */
  id: string;
  /** How many outlines surround it. Odd is a hole until someone picks it. */
  depth: number;
  area: number;
  /** The outline first, then any holes. */
  loops: V2[][];
  points: V2[];
  triangles: number[];
}

function loopPoints(segs: any[]): V2[] {
  const out: V2[] = [];
  const same = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  for (const seg of segs) {
    for (const p of segPoints(seg)) {
      if (!out.length || !same(out[out.length - 1], p)) out.push(p);
    }
  }
  if (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  return out;
}

function readRegion(r: any): SketchRegion {
  const loops = [r.outer, ...r.holes].map(loopPoints);
  const points = loops.flat();
  const holes: number[] = [];
  let at = 0;
  for (const loop of loops.slice(0, -1)) {
    at += loop.length;
    holes.push(at);
  }
  return { id: r.id, depth: r.depth, area: r.area, loops, points, triangles: earcut(points.flat(), holes) };
}

/** A straight line of a solved sketch, which a revolve can turn around. */
export interface SketchLine { id: number; start: V2; end: V2; construction: boolean }

/** One region of one sketch, as a dialog picks it. */
export interface RegionPick { sketch: number; id: string }

interface Solved { regions: SketchRegion[]; lines: SketchLine[] }
let known = new Map<string, Solved>();
let linesBySketch = new Map<number, SketchLine[]>();

/** A sketch's straight lines, where its constraints put them. */
export const sketchLines = (sketchId: number) => linesBySketch.get(sketchId) ?? [];

const readLines = (sketch: any): SketchLine[] =>
  (sketch?.entities ?? [])
    .filter((e: any) => e.type === 'line' && Array.isArray(e.start) && Array.isArray(e.end))
    .map((e: any) => ({ id: e.id, start: e.start, end: e.end, construction: !!e.construction }));

/** Every drawn sketch's regions, at its solved position. Only a sketch that changed goes back to the kernel. */
export async function loadRegions(features: any[], env: Record<string, number>) {
  const next = new Map<string, Solved>();
  const out = new Map<number, SketchRegion[]>();
  const lines = new Map<number, SketchLine[]>();
  for (const f of features) {
    if (f.type !== 'constrained_sketch' || (f.name ?? '').startsWith('~')) continue;
    const key = JSON.stringify([f.sketch, env]);
    let got = known.get(key);
    if (!got) {
      const solved = await engine.call('sketch_solve', { sketch: f.sketch, parameters: env });
      const sketch = solved.ok ? JSON.parse(solved.text).sketch : f.sketch;
      const r = await engine.call('sketch_arrangement', { sketch });
      got = { regions: r.ok ? (JSON.parse(r.text).regions as any[]).map(readRegion) : [], lines: readLines(sketch) };
    }
    next.set(key, got);
    out.set(f.id, got.regions);
    lines.set(f.id, got.lines);
  }
  linesBySketch = lines;
  known = next;
  return out;
}

/** What a sketch makes when nothing is picked, which is what the kernel builds from it: a loop in a loop is a hole. */
export const wholeSketch = (regions: SketchRegion[] | undefined) => (regions ?? []).filter((r) => r.depth % 2 === 0).map((r) => r.id);

export const sameRegions = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Older documents kept an extrude's choice of regions in a hidden copy of its sketch, named like `~regions:4 1`, from
 * before the kernel's extrude could take regions itself. Opening one turns those back into plain extrudes.
 */
export const regionCopySource = (f: { name?: string }) => {
  const m = /^~regions:(\d+) \d+$/.exec(f.name ?? '');
  return m ? Number(m[1]) : null;
};
