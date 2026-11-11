import { batch, createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { loadRegions, regionCopySource, sketchLines, type SketchRegion } from '../sketch/regions';
import { engine, EngineCrash, type MeshData, type ToolResult } from '../engine/client';
import type { V3 } from '../viewport/math';
import { setSelectedFeature, setSelectedRegions, toast } from './ui';

export interface Step { id: number; name: string; type: string; state: string; error?: string }
export interface SolidInfo {
  volume: number; area: number; bounds_min: V3; bounds_max: V3; faces: number; edges: number;
  valid: boolean; shells?: number; holes_through?: number[]; defects?: string[]; touching_points?: number;
}
export interface Parameter { name: string; value: number | string }
export interface FaceInfo { name: string; key: string; surface: string; area: number; center: V3; normal: V3; radius?: number; axis?: { point: V3; direction: V3 } }
/** A corner, as an extrude's Up to vertex takes it: the faces that meet there. */
export interface VertexRef { faces: string[]; near?: V3; point?: V3 }
export interface EdgeInfo { name: string; select: unknown; length: number; midpoint: V3; start: V3; end: V3; curve: string; radius?: number; body?: string; start_vertex?: VertexRef; end_vertex?: VertexRef }

export class ToolError extends Error {}

const TITLE_KEY = 'schmishape.title';
export const UNTITLED = 'Untitled document';

let warnedFull = false;
export const storage = {
  get(key: string) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
      warnedFull = false;
    } catch {
      // With several tabs a full store could lose more than the last change, so it says so, once.
      if (!warnedFull) toast('This browser’s storage is full, so changes aren’t being kept. Save your Part Studios to files.', 'error');
      warnedFull = true;
    }
  },
  remove(key: string) {
    try { localStorage.removeItem(key); } catch { /* Then there's nothing to remove. */ }
  },
};

const savedTitle = storage.get(TITLE_KEY);

export const [doc, setDoc] = createStore({
  title: !savedTitle || savedTitle === 'Untitled part' ? UNTITLED : savedTitle,
  parameters: [] as Parameter[],
  features: [] as any[],
  steps: [] as Step[],
  failed: null as string | null,
  notes: [] as string[],
  solid: null as SolidInfo | null,
  rollback: null as number | null,
  env: {} as Record<string, number>,
  /** What the app keeps with the document: part names and colors, under `parts`, by the kernel's name for each part. */
  app: {} as Record<string, any>,
  ms: 0,
});

export const [mesh, setMesh] = createSignal<MeshData | null>(null, { equals: false });
/** The closed areas each drawn sketch makes, by feature id. */
export const [sketchRegions, setSketchRegions] = createSignal<Map<number, SketchRegion[]>>(new Map());
export const [canUndo, setCanUndo] = createSignal(false);
export const [canRedo, setCanRedo] = createSignal(false);
export const [busy, setBusy] = createSignal(false);
export const [booted, setBooted] = createSignal(false);

engine.onBusyChange = setBusy;

let lastGood = '';
let undoStack: string[] = [];
let redoStack: string[] = [];
let facesCache: FaceInfo[] | null = null;
let edgesCache: EdgeInfo[] | null = null;
let saveTimer = 0;
/** Where the open document autosaves, which depends on the tab. An assembly has no document to keep. */
let saveKey: string | null = null;
export const setAutosaveKey = (key: string | null) => { saveKey = key; };

export const documentText = () => lastGood;
export const isHidden = (f: { name?: string }) => (f.name ?? '').startsWith('~');
export const isSketchFeature = (f: { type?: string }) => f.type === 'constrained_sketch' || f.type === 'sketch';
/** Older documents turned a revolve's sketch with a hidden copy named like `~axis:4`, before revolve took an axis. */
const frameSource = (f: { name?: string }) => {
  const m = /^~axis:(\d+)$/.exec(f.name ?? '');
  return m ? Number(m[1]) : null;
};
/** A feature as feature_edit takes it: what it does, without what names it. */
const opOf = (f: any) => {
  const { id: _i, name: _n, suppressed: _s, ...op } = f;
  return op;
};

/**
 * Older documents used hidden copies of sketches: one per extrude of some of a sketch's regions, and one turned on its
 * side per revolve. The kernel takes both directly now, so each feature goes back to its own sketch and the copies go.
 * The shapes stay the same, and so do the face names, which come from the extrude or revolve.
 */
async function upgradeHiddenCopies() {
  const features: any[] = JSON.parse((await engine.call('document_show')).text).features ?? [];
  const copies = features.filter((f) => regionCopySource(f) !== null || frameSource(f) !== null);
  if (!copies.length) return false;
  const freed = new Set<number>();
  for (const copy of copies) {
    const users = features.filter((f) => f.sketch === copy.id);
    let ok = true;
    for (const user of users) {
      const regions = regionCopySource(copy);
      const edit = regions !== null
        ? { ...opOf(user), sketch: regions, regions: copy.sketch?.picked_regions ?? [] }
        : { ...opOf(user), sketch: frameSource(copy), axis: { point: [0, 0], direction: [0, 1] }, app: { ...(user.app ?? {}), axis: 'y_axis' } };
      ok = (await engine.call('feature_edit', { id: user.id, feature: edit })).ok && ok;
    }
    if (ok) freed.add(copy.id);
  }
  for (const id of freed) await engine.call('feature_delete', { id });
  return true;
}

const sameNumbers = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-7);

/** Revolves turning around a line of their sketch, whose line has moved since: the kernel keeps the axis as numbers. */
function axesToFollow(features: any[]) {
  const out: { id: number; feature: any }[] = [];
  for (const f of features) {
    const m = f.type === 'revolve' ? /^line:(\d+)$/.exec(f.app?.axis ?? '') : null;
    const line = m ? sketchLines(f.sketch).find((l) => l.id === Number(m[1])) : null;
    if (!line) continue;
    const axis = { point: line.start, direction: [line.end[0] - line.start[0], line.end[1] - line.start[1]] };
    if (f.axis && sameNumbers(f.axis.point, axis.point) && sameNumbers(f.axis.direction, axis.direction)) continue;
    out.push({ id: f.id, feature: { ...opOf(f), axis } });
  }
  return out;
}

let tail: Promise<unknown> = Promise.resolve();
/** Calls that belong together stay together, whatever else the UI asks for meanwhile. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

function readSummary(text: string) {
  const i = text.indexOf('{');
  if (i < 0) return null;
  try {
    const v = JSON.parse(text.slice(i));
    return v && Array.isArray(v.features) ? v : null;
  } catch {
    return null;
  }
}

function rollbackArgs() {
  return doc.rollback !== null ? { upto: doc.rollback } : {};
}

const GONE_REGION = 'A sketch region this used is gone, because its sketch changed. Edit this feature to pick its regions again.';
/** The kernel names a region that's gone by its id, which means nothing on screen. */
function plainRegionErrors(features: any[], summary: any) {
  for (const step of summary?.features ?? []) {
    if (!/picked region \S+ isn't in sketch/.test(step.error ?? '')) continue;
    step.error = GONE_REGION;
    const f = features.find((x) => x.id === step.id);
    if (summary.failed && f) summary.failed = `${f.name}: ${GONE_REGION}`;
  }
}

async function syncFrom(r: ToolResult | null, t0: number, followed = false): Promise<void> {
  const shown = await engine.call('document_show');
  lastGood = shown.text;
  const parsed = JSON.parse(shown.text);
  let rollback = doc.rollback;
  if (rollback !== null && rollback >= parsed.features.length - 1) rollback = null;
  if (rollback !== doc.rollback) setDoc('rollback', rollback);
  let summary = r && rollback === null ? readSummary(r.text) : null;
  if (!summary) summary = readSummary((await engine.call('rebuild', rollbackArgs())).text);
  plainRegionErrors(parsed.features ?? [], summary);
  const env = await engine.env();
  const regions = await loadRegions(parsed.features ?? [], env);
  // A revolve follows the line it turns around. Once is enough: after that its axis is where the line is.
  const follow = followed ? [] : axesToFollow(parsed.features ?? []);
  if (follow.length) {
    for (const f of follow) await engine.call('feature_edit', f);
    return syncFrom(null, t0, true);
  }
  const m = await engine.mesh(rollback);
  facesCache = null;
  edgesCache = null;
  batch(() => {
    setDoc('parameters', reconcile(parsed.parameters ?? []));
    setDoc('app', reconcile(parsed.app && typeof parsed.app === 'object' ? parsed.app : {}));
    setDoc('features', reconcile(parsed.features ?? [], { key: 'id' }));
    setDoc('steps', reconcile(summary?.features ?? [], { key: 'id' }));
    setDoc('failed', summary?.failed ? String(summary.failed).replace(/invalid (input|profile): /i, '') : null);
    setDoc('notes', summary?.notes ?? []);
    setDoc('solid', reconcile(summary?.solid ?? null) as any);
    setDoc('env', reconcile(env));
    setDoc('ms', Math.round(performance.now() - t0));
    setSketchRegions(regions);
    setMesh(m);
  });
  if (m.error) toast(`The solid couldn't be meshed: ${m.error}`, 'error');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { if (saveKey) storage.set(saveKey, lastGood); }, 400);
}

async function restore() {
  await engine.ready;
  if (lastGood) await engine.call('document_open', { text: lastGood });
  else await engine.call('document_new');
  await syncFrom(null, performance.now());
}

// A crash or a stop can come from any call, including the sketch solver, and either one empties the kernel.
engine.onCrash = (message) => {
  void serial(restore).catch((e) => toast(`The model couldn't be restored. ${(e as Error).message}`, 'error'));
  if (message !== 'Stopped') toast(`The kernel crashed, so the model went back to its last good state. ${message}`, 'error');
};

/** The kernel's words, without the category it files them under. */
export function tidyError(text: string) {
  const t = text.replace(/^invalid (input|profile): /i, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Runs a tool that changes the document, then brings the UI up to date. */
export function mutate(tool: string, args: object = {}): Promise<ToolResult> {
  return serial(async () => {
    const t0 = performance.now();
    try {
      const deleting = tool === 'feature_delete' ? doc.features.findIndex((f) => f.id === (args as { id: number }).id) : -1;
      const r = await engine.call(tool, args);
      if (!r.ok) throw new ToolError(tidyError(r.text));
      // Adding at the rollback bar moves the bar past the new feature, and deleting above it keeps it where it was.
      if (tool === 'feature_add' && doc.rollback !== null) setDoc('rollback', doc.rollback + 1);
      if (deleting >= 0 && doc.rollback !== null && deleting <= doc.rollback) setDoc('rollback', Math.max(doc.rollback - 1, 0));
      if (tool === 'document_new' || tool === 'document_open') {
        setSelectedFeature(null);
        setSelectedRegions(null);
      }
      const upgraded = tool === 'document_open' && (await upgradeHiddenCopies());
      await syncFrom(upgraded ? null : r, t0);
      return r;
    } catch (e) {
      if (e instanceof EngineCrash) throw new ToolError(e.message === 'Stopped' ? 'Stopped. The model is back to its last good state.' : 'The kernel crashed on this step, so that change was undone.');
      throw e;
    }
  });
}

export function pushUndo(before: string) {
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  setCanUndo(true);
  setCanRedo(false);
}

/** A change with its own undo step. */
export async function commit(tool: string, args: object = {}) {
  const before = lastGood;
  const r = await mutate(tool, args);
  pushUndo(before);
  return r;
}

async function openText(text: string) {
  await mutate('document_open', { text });
}

export async function undo() {
  const text = undoStack.pop();
  if (text === undefined) return;
  redoStack.push(lastGood);
  setCanUndo(undoStack.length > 0);
  setCanRedo(true);
  await openText(text);
}

export async function redo() {
  const text = redoStack.pop();
  if (text === undefined) return;
  undoStack.push(lastGood);
  setCanUndo(true);
  setCanRedo(redoStack.length > 0);
  await openText(text);
}

/** Writes the autosave now, for when the page is about to go away. */
export function flushAutosave() {
  clearTimeout(saveTimer);
  if (lastGood && saveKey) storage.set(saveKey, lastGood);
}

/** Sets aside whatever is autosaved for this tab, so the next load starts clean even if the saved part is what breaks. */
export function setAsideAutosave() {
  if (!saveKey) return;
  const saved = storage.get(saveKey);
  if (saved) storage.set(`${saveKey}.unopened`, saved);
  storage.remove(saveKey);
}

/** What a tab has to remember about its document while another tab is open. */
export interface DocMemory { text: string | null; rollback: number | null; undo: string[]; redo: string[] }
export const rememberDoc = (): DocMemory => ({ text: lastGood, rollback: doc.rollback, undo: undoStack, redo: redoStack });

/** Replaces the open document with a tab's. If it can't be read this throws, and the kernel keeps what it had. */
export async function showDoc(m: DocMemory) {
  setDoc('rollback', m.rollback);
  await mutate(m.text ? 'document_open' : 'document_new', m.text ? { text: m.text } : {});
  undoStack = m.undo;
  redoStack = m.redo;
  setCanUndo(undoStack.length > 0);
  setCanRedo(redoStack.length > 0);
}

export function setTitle(title: string) {
  setDoc('title', title);
  storage.set(TITLE_KEY, title);
}

async function rollTo(index: number | null) {
  const value = index !== null && index >= doc.features.length - 1 ? null : index;
  if (value === doc.rollback) return;
  const t0 = performance.now();
  setDoc('rollback', value);
  await syncFrom(null, t0);
}

export const setRollback = (index: number | null) => serial(() => rollTo(index));

/** Where the rollback bar is, by feature as well as position, while editing takes it somewhere else for a moment. */
export interface HeldBar { index: number | null; feature: number | null }
export const holdBar = (): HeldBar => ({ index: doc.rollback, feature: doc.rollback === null ? null : doc.features[doc.rollback]?.id ?? null });

/** Puts the bar back on the feature it was on. Hidden sketches coming and going may have moved that feature's position. */
export const returnBar = (held: HeldBar) => serial(() => {
  if (held.index === null) return rollTo(null);
  const at = doc.features.findIndex((f) => f.id === held.feature);
  return rollTo(at >= 0 ? at : held.index);
});

export function stopEngine() {
  engine.stop();
}

export async function faceList(): Promise<FaceInfo[]> {
  if (facesCache) return facesCache;
  return serial(async () => {
    const r = await engine.call('faces_list');
    return (facesCache = r.ok ? JSON.parse(r.text) : []);
  });
}

export async function edgeList(): Promise<EdgeInfo[]> {
  if (edgesCache) return edgesCache;
  return serial(async () => {
    const r = await engine.call('edges_list');
    return (edgesCache = r.ok ? JSON.parse(r.text) : []);
  });
}

/** The model as it stood at one point in the history, to pick from. */
export function snapshotAt(upto: number | null) {
  return serial(async () => {
    await engine.call('rebuild', upto !== null ? { upto } : {});
    const faces = await engine.call('faces_list');
    const edges = await engine.call('edges_list');
    const m = await engine.mesh(upto);
    await engine.call('rebuild', rollbackArgs());
    return {
      faces: (faces.ok ? JSON.parse(faces.text) : []) as FaceInfo[],
      edges: (edges.ok ? JSON.parse(edges.text) : []) as EdgeInfo[],
      mesh: m,
    };
  });
}

export const insertPosition = () => (doc.rollback === null ? doc.features.length : doc.rollback + 1);

/** The first unused number for a feature name, like "Sketch 3". */
export function nextName(prefix: string) {
  let n = 1;
  const names = new Set(doc.features.map((f) => f.name));
  while (names.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

export function numberOr(text: string): number | string {
  const t = text.trim();
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t;
}

export async function boot() {
  await engine.ready;
  const saved = saveKey ? storage.get(saveKey) : null;
  try {
    if (saved) await mutate('document_open', { text: saved });
    else await mutate('document_new');
  } catch (e) {
    // Keep what was saved: a new document's autosave would otherwise overwrite it.
    if (saved) storage.set(`${saveKey}.unopened`, saved);
    toast(`The saved model couldn't be opened, so this is a new one. ${(e as Error).message}`, 'error');
    await mutate('document_new');
  }
  setBooted(true);
}

/** How a part looks in the list and the view: a name of its own, and a color, as `#rrggbb`. */
export interface PartLook { name?: string; color?: string }
export const partLooks = (): Record<string, PartLook> => (doc.app?.parts && typeof doc.app.parts === 'object' ? doc.app.parts : {});

/**
 * Names or colors a part. It's kept in the document's own app data, by the kernel's name for the part, which never
 * changes, so it saves with the file and an AI reading the document sees it too. Empty values go back to the default.
 */
export async function setPartLook(body: string, patch: PartLook) {
  const app = JSON.parse(JSON.stringify(doc.app ?? {}));
  const parts: Record<string, PartLook> = app.parts && typeof app.parts === 'object' ? app.parts : {};
  const look: PartLook = { ...parts[body], ...patch };
  for (const k of Object.keys(look) as (keyof PartLook)[]) if (!look[k]) delete look[k];
  if (Object.keys(look).length) parts[body] = look;
  else delete parts[body];
  if (Object.keys(parts).length) app.parts = parts;
  else delete app.parts;
  await commit('app_set', Object.keys(app).length ? { app } : {});
}

export async function deleteFeature(id: number) {
  const before = lastGood;
  const f = doc.features.find((x) => x.id === id);
  // The kernel would refuse a sketch in use too, but it says so by id.
  const takesFrom = (x: any) => x.sketch === id || (Array.isArray(x.sections) && x.sections.some((s: any) => s === id || s?.sketch === id)) || (Array.isArray(x.regions) && x.regions.some((r: any) => r?.sketch === id));
  const users = doc.features.filter((x) => x.id !== id && takesFrom(x)).map((x) => x.name);
  if (users.length) throw new ToolError(`${f?.name} can't be deleted while ${users.join(', ')} ${users.length === 1 ? 'uses' : 'use'} it.`);
  await mutate('feature_delete', { id });
  pushUndo(before);
}

/** Turns a feature off or on. */
export async function setSuppressed(id: number, suppressed: boolean) {
  const before = lastGood;
  await mutate('feature_suppress', { id, suppressed });
  pushUndo(before);
}
