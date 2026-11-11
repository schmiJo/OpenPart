import { batch, createSignal } from 'solid-js';
import { doc, documentText, holdBar, insertPosition, isHidden, mutate, nextName, pushUndo, returnBar, setRollback, sketchRegions, ToolError, type HeldBar } from '../store/doc';
import { clearSelection, selectedFeature, setHoverPlane, setMode, setSelectedFeature, sketchesHidden, toast } from '../store/ui';
import { view } from '../viewport/instance';
import { loadPlaces, savePlaces } from './dimension';
import { emptySketch, planeFromPlacement, placementOf, PLANES, type Plane, type SketchData } from './geometry';
import { wholeSketch } from './regions';
import { SketchSession } from './session';

export const [session, setSession] = createSignal<SketchSession | null>(null);

export function startSketch(plane: Plane) {
  const r = view.renderer;
  if (!r) return;
  const name = nextName('Sketch');
  const s = new SketchSession(null, plane, name, emptySketch(), r.camera, view.redraw, loadPlaces(null));
  enter(s);
}

/** Entering a sketch only swaps the toolbar. The camera and the model stay exactly as they were. */
function enter(s: SketchSession) {
  batch(() => {
    clearSelection();
    setHoverPlane(null);
    setSession(s);
    setMode('sketch');
  });
  view.renderer?.invalidate();
}

function quatFor(plane: Plane) {
  return view.renderer!.camera.rotFromBasis(plane.x, plane.y, plane.z);
}

/** Turns the view to look straight at a plane. */
export function normalTo(plane: Plane) {
  view.renderer?.camera.animateTo({ rot: quatFor(plane) }, 320);
  view.renderer?.invalidate();
}

export function looksAtSketch() {
  const s = session();
  if (s) view.renderer?.camera.animateTo({ rot: quatFor(s.plane) }, 320);
}

/** Where the rollback bar was before opening a sketch to edit, while the model is rolled back to that sketch. */
let heldBar: HeldBar | null = null;

/** Opens a sketch feature, with the model as it stood at that sketch. The camera stays where it was, as Onshape's does. */
export function editSketch(id: number) {
  const f = doc.features.find((x) => x.id === id);
  if (!f || !view.renderer) return;
  if (f.type !== 'constrained_sketch') {
    toast('This sketch was written as regions rather than drawn, so it can only be changed as data.');
    return;
  }
  const plane = planeFromPlacement(f.plane, doc.env);
  const data: SketchData = JSON.parse(JSON.stringify(f.sketch));
  heldBar = holdBar();
  enter(new SketchSession(id, plane, f.name, data, view.renderer.camera, view.redraw, loadPlaces(id)));
  void setRollback(doc.features.findIndex((x) => x.id === id));
}

function leave() {
  batch(() => {
    setSession(null);
    setMode('part');
  });
  view.renderer?.invalidate();
  const held = heldBar;
  heldBar = null;
  return held ? returnBar(held) : Promise.resolve();
}

export async function finishSketch() {
  const s = session();
  if (!s) return;
  s.editing[1](null);
  const data = await s.settled();
  const before = documentText();
  const feature = { type: 'constrained_sketch', plane: placementOf(s.plane), sketch: data };
  try {
    if (s.featureId === null) {
      if (!data.entities.length) return leave();
      const r = await mutate('feature_add', { feature, name: s.name, position: insertPosition() });
      const id = Number(/\(id (\d+)\)/.exec(r.text)?.[1]);
      if (id) {
        setSelectedFeature(id);
        savePlaces(id, s.places);
      }
    } else if (s.canUndo[0]()) {
      await mutate('feature_edit', { id: s.featureId, feature });
    }
    if (s.featureId !== null) {
      savePlaces(s.featureId, s.places);
      setSelectedFeature(s.featureId);
    }
    if (s.featureId === null || s.canUndo[0]()) pushUndo(before);
    await leave();
    if (s.featureId === null && !s.regions.length) toast('This sketch has no closed area yet, so it can’t be extruded.');
  } catch (e) {
    toast((e as ToolError).message, 'error');
  }
}

export function cancelSketch() {
  return leave();
}

/**
 * Which sketches show in the part view: any not yet used, and whichever is selected or picked from. Extruding some of a
 * sketch's regions doesn't use it up, so the rest stay there to pick until each has been used.
 */
export function visibleSketches(alsoShow: (number | null | undefined)[] = []) {
  if (sketchesHidden()) return [];
  const last = doc.rollback ?? doc.features.length - 1;
  const used = new Set<number>();
  const picked = new Map<number, Set<string>>();
  const pick = (sketch: number, id: string) => {
    if (!picked.has(sketch)) picked.set(sketch, new Set());
    picked.get(sketch)!.add(id);
  };
  doc.features.forEach((f, i) => {
    if (i > last) return;
    if (Array.isArray(f.sections)) f.sections.forEach((x: number) => used.add(x));
    if (Array.isArray(f.regions) && f.regions.length) {
      for (const r of f.regions) {
        if (typeof r === 'string') pick(f.sketch, r);
        else if (r && typeof r.sketch === 'number') pick(r.sketch, r.region);
      }
    } else if (typeof f.sketch === 'number') used.add(f.sketch);
  });
  for (const [id, ids] of picked) {
    if (wholeSketch(sketchRegions().get(id)).every((r) => ids.has(r))) used.add(id);
  }
  const chosen = selectedFeature();
  const also = new Set(alsoShow.filter((x): x is number => typeof x === 'number'));
  return doc.features.filter((f, i) => f.type === 'constrained_sketch' && !isHidden(f) && !f.suppressed && i <= last && (!used.has(f.id) || f.id === chosen || also.has(f.id)));
}

export { PLANES };
