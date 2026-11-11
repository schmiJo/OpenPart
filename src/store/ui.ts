import { createSignal } from 'solid-js';

/** Why the model can't be drawn: no WebGL2 here at all, or the graphics driver went away for now. */
export const [glProblem, setGlProblem] = createSignal<'missing' | 'lost' | null>(null);

export type Mode = 'part' | 'pick-plane' | 'sketch';
export const [mode, setMode] = createSignal<Mode>('part');

export interface Toast { id: number; text: string; kind: 'info' | 'error'; action?: { label: string; run: () => unknown } }
export const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextToast = 1;
export const dismissToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = nextToast++;
  setToasts((t) => [...t.slice(-2), { id, text, kind, action }]);
  setTimeout(() => dismissToast(id), kind === 'error' || action ? 7000 : 3200);
}

/** What the pointer rests on or the last pick, in words, for the status bar. */
export const [hoverText, setHoverText] = createSignal('');
export const [paletteOpen, setPaletteOpen] = createSignal(false);

export interface Selection { faces: number[]; edges: number[] }
export const [selection, setSelection] = createSignal<Selection>({ faces: [], edges: [] });
export const [selectedFeature, setSelectedFeature] = createSignal<number | null>(null);
/** Regions picked in the view. An extrude takes them from one sketch, so a selection stays within one too. */
export const [selectedRegions, setSelectedRegions] = createSignal<{ sketch: number; ids: string[] } | null>(null);
export const [hoverPlane, setHoverPlane] = createSignal<number | null>(null);
/** The selected row of default geometry: the origin, or a plane by its id. */
export const [selectedGeometry, setSelectedGeometry] = createSignal<'origin' | number | null>(null);
export const [selectedPart, setSelectedPart] = createSignal<number | null>(null);
export const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
export const [sketchesHidden, setSketchesHidden] = createSignal(false);

export function clearSelection() {
  setSelection({ faces: [], edges: [] });
  setSelectedRegions(null);
  setSelectedGeometry(null);
  setSelectedFeature(null);
  setSelectedPart(null);
}

const HIDDEN_KEY = 'schmishape.hidden-geometry';
function loadHidden(): Set<'origin' | number> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
/** Which default geometry is hidden. This is how you like your view, so it isn't part of the model. */
export const [geometryHidden, setGeometryHidden] = createSignal(loadHidden());
function saveHidden(next: Set<'origin' | number>) {
  setGeometryHidden(next);
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])); } catch { /* It only costs remembering this for next time. */ }
}
export function toggleGeometry(id: 'origin' | number) {
  const next = new Set(geometryHidden());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  saveHidden(next);
}
/** Hides all the planes, or shows them all if any were hidden. */
export function togglePlanes() {
  const next = new Set(geometryHidden());
  const anyShown = [1, 2, 3].some((p) => !next.has(p));
  for (const p of [1, 2, 3]) {
    if (anyShown) next.add(p);
    else next.delete(p);
  }
  saveHidden(next);
}

const SNAP_KEY = 'schmishape.snapping';
function loadSnapping() {
  try {
    return localStorage.getItem(SNAP_KEY) !== 'off';
  } catch {
    return true;
  }
}
/** Whether drawing snaps to points, angles and alignments. */
export const [snapsOn, setSnapsOn] = createSignal(loadSnapping());
export function toggleSnaps() {
  const next = !snapsOn();
  setSnapsOn(next);
  try { localStorage.setItem(SNAP_KEY, next ? 'on' : 'off'); } catch { /* It only costs remembering this for next time. */ }
}

export const [hiddenParts, setHiddenParts] = createSignal<Set<number>>(new Set());
export function togglePart(i: number) {
  const next = new Set(hiddenParts());
  if (next.has(i)) next.delete(i);
  else next.add(i);
  setHiddenParts(next);
}
