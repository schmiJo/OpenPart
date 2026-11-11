import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { wholeSketch, type RegionPick } from '../sketch/regions';
import { doc, documentText, holdBar, insertPosition, isHidden, isSketchFeature, mutate, nextName, pushUndo, returnBar, setDoc, setRollback, sketchRegions, snapshotAt, tidyError, ToolError, type EdgeInfo, type FaceInfo, type HeldBar } from '../store/doc';
import type { MeshData } from '../engine/client';
import { selectedFeature, selectedRegions, selection, setSelectedRegions, setSelection, setSelectedFeature, toast } from '../store/ui';
import { view } from '../viewport/instance';
import { defById, defForFeature, PICK_KINDS, regionsChosen, setHasBase, type FeatureDef, type FieldDef, type FieldKind, type Section, type Values } from './defs';

export const [activeDef, setActiveDef] = createSignal<FeatureDef | null>(null);
export const [values, setValues] = createStore<Values>({});
export const [dialogError, setDialogError] = createSignal<string | null>(null);
export const [dialogBusy, setDialogBusy] = createSignal(false);
export const [editingId, setEditingId] = createSignal<number | null>(null);
/** The name at the top of the dialog: the feature's own, or what it will be called. */
export const [dialogName, setDialogName] = createSignal('');
/** Showing the finished model while editing an earlier feature, instead of the model as it stood at that feature. */
export const [showingFinal, setShowingFinal] = createSignal(false);
/** Whether any feature comes after this one, for Final to show. At the end of the history it would change nothing. */
export const [hasLaterFeatures, setHasLaterFeatures] = createSignal(false);
/** The field that clicks in the view go to. One at a time, as in Onshape, where it's the box with the blue edge. */
export const [activePick, setActivePick] = createSignal<string | null>(null);

export interface PickBase { faces: FaceInfo[]; edges: EdgeInfo[]; mesh: MeshData }
export const [pickBase, setPickBase] = createSignal<PickBase | null>(null);
/** The model before the feature in a dialog that takes regions, drawn solid under its see-through preview. */
export const [previewBase, setPreviewBase] = createSignal<MeshData | null>(null);

let featureId: number | null = null;
/** What was selected when the dialog opened, for Cancel to put back. */
let resume: { feature: number | null; regions: { sketch: number; ids: string[] } | null } = { feature: null, regions: null };
/** Where the rollback bar was when the dialog opened. Editing a feature rolls back to it until the dialog closes. */
let heldBar: HeldBar = { index: null, feature: null };
let before = '';
let position = 0;
let working = false;
let again = false;
let settle: Promise<void> = Promise.resolve();
let touched = false;

const shown = (f: FieldDef) => !f.when || f.when(values);
const pickFields = (def: FeatureDef) => def.fields.filter((f) => PICK_KINDS.has(f.kind));
/** Picks from the model before the feature, rather than from sketches. */
const MODEL_KINDS = new Set<FieldKind>(['edges', 'faces', 'face', 'part', 'parts', 'vertex']);
const takesModelPicks = (def: FeatureDef) => def.fields.some((f) => MODEL_KINDS.has(f.kind));

const activeField = () => {
  const def = activeDef();
  const key = activePick();
  return def && key ? def.fields.find((f) => f.key === key && shown(f)) ?? null : null;
};
/** What a click in the view picks just now. */
export const pickKind = () => activeField()?.kind ?? null;
export const pickKey = () => activeField()?.key ?? null;

const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** A field that has just come into view and has nothing in it takes the clicks, as Up to face does once it's chosen. */
let lastShown = new Set<string>();
function followPickFields() {
  const def = activeDef();
  if (!def) return;
  const now = pickFields(def).filter(shown);
  const fresh = now.find((f) => !lastShown.has(f.key) && isEmpty(values[f.key]));
  lastShown = new Set(now.map((f) => f.key));
  if (fresh) setActivePick(fresh.key);
  else if (!activeField()) setActivePick(now[0]?.key ?? null);
}

export const canonical = (v: unknown) => JSON.stringify(v);

const regionField = (def: FeatureDef) => def.fields.find((f) => f.kind === 'regions' || f.kind === 'sections');
/** The open dialog takes sketch regions, picked in the view or by a sketch in the list. */
export const takesRegions = () => {
  const def = activeDef();
  return !!def && !!regionField(def);
};
/** It takes regions and has none yet. */
export const nothingPicked = () => takesRegions() && !regionsChosen(values);
/** Its regions box takes a part's flat faces too. */
export const regionsTakeFaces = () => {
  const def = activeDef();
  return !!def && !!def.fields.find((f) => f.kind === 'regions')?.takesFaces;
};
/** Every region the open dialog has picked, from its regions or a loft's profiles, for the view and the list to light. */
export function regionPicksShown(): RegionPick[] {
  const def = activeDef();
  if (!def) return [];
  if (def.fields.some((f) => f.kind === 'sections')) {
    return ((values.sections ?? []) as Section[]).flatMap((x) => (x.id ? [{ sketch: x.sketch, id: x.id }] : wholeSketch(sketchRegions().get(x.sketch)).map((id) => ({ sketch: x.sketch, id }))));
  }
  return (values.regions ?? []) as RegionPick[];
}
/** What the feature still needs before it can be added, if anything. */
export const dialogMissing = () => activeDef()?.missing?.(values) ?? null;
/** Only what comes before this feature can be used by it. */
export const pickLimit = () => (featureId !== null ? doc.features.findIndex((f) => f.id === featureId) : position);

/** Switches between the finished model and the model as it stood at this feature, with the preview in either. */
export async function toggleFinal() {
  await settle;
  const next = !showingFinal();
  setShowingFinal(next);
  await setRollback(next ? null : featureId !== null ? doc.features.findIndex((f) => f.id === featureId) : position - 1);
}

async function applyOnce() {
  const def = activeDef();
  if (!def) return;
  const json = def.make(JSON.parse(JSON.stringify(values)));
  if (!json) {
    if (featureId !== null && editingId() === null) {
      await mutate('feature_delete', { id: featureId });
      featureId = null;
    }
    setDialogError(null);
    return;
  }
  if (featureId === null) {
    const r = await mutate('feature_add', { feature: json, name: nextName(def.namePrefix), position });
    featureId = Number(/\(id (\d+)\)/.exec(r.text)![1]);
  } else {
    await mutate('feature_edit', { id: featureId, feature: json });
  }
  touched = true;
  const step = doc.steps.find((s) => s.id === featureId);
  setDialogError(step?.state === 'failed' ? tidyError(step.error ?? 'This feature failed.') : null);
}

/** Builds the feature as it stands, for a live preview. Changes made meanwhile collapse into one more run. */
export function applyPreview() {
  if (working) {
    again = true;
    return settle;
  }
  working = true;
  setDialogBusy(true);
  settle = (async () => {
    do {
      again = false;
      try {
        await applyOnce();
      } catch (e) {
        setDialogError((e as Error).message);
      }
    } while (again);
    working = false;
    setDialogBusy(false);
  })();
  return settle;
}

export function setValue(key: string, value: unknown) {
  setValues(key, value as any);
  followPickFields();
  void applyPreview();
}

/** Changes one thing inside a value, such as one step of a sweep's path, so what shows it stays put while it's typed in. */
export function setValueAt(key: string, index: number, field: string, value: unknown) {
  (setValues as any)(key, index, field, value);
  void applyPreview();
}

function close() {
  setActiveDef(null);
  setActivePick(null);
  setEditingId(null);
  setShowingFinal(false);
  setDialogError(null);
  setPickBase(null);
  setPreviewBase(null);
  setValues(reconcile({}));
  view.renderer?.setPickMesh(null);
  if (view.renderer) {
    view.renderer.pickMask = { faces: true, edges: true, planes: true, regions: true };
    view.renderer.regionsOnTop = false;
    view.renderer.invalidate();
  }
  featureId = null;
  lastShown = new Set();
  setSelection({ faces: [], edges: [] });
  setSelectedRegions(null);
}

/** What the view lets a click land on, for the field taking clicks. */
export function applyPickMask() {
  const r = view.renderer;
  if (!r || !activeDef()) return;
  const kind = pickKind();
  const faces = kind === 'faces' || kind === 'face' || kind === 'part' || kind === 'parts';
  const edges = kind === 'edges' || kind === 'vertex';
  // Extrude's box takes a part's flat faces as well as regions, as Onshape's does.
  r.pickMask = { faces: faces || (kind === 'regions' && regionsTakeFaces() && !!pickBase()), edges, planes: false, regions: kind === 'regions' || kind === 'sections' };
  r.regionsOnTop = takesRegions();
  r.invalidate();
}

export async function openDialog(defId: string, editId: number | null = null, preset?: Values) {
  await cancelDialog();
  const def = defById(defId);
  if (!def) return;
  const existing = editId !== null ? doc.features.find((f) => f.id === editId) : null;
  position = existing ? doc.features.findIndex((f) => f.id === editId) : insertPosition();
  if (def.needsBody && position === 0) {
    toast(`${def.title} needs a part to work on.`);
    return;
  }
  resume = { feature: selectedFeature(), regions: selectedRegions() };
  heldBar = holdBar();
  before = documentText();
  touched = false;
  setHasLaterFeatures(doc.features.slice(existing ? position + 1 : position).some((f) => !isHidden(f)));
  featureId = editId;
  setEditingId(editId);
  setDialogName(existing?.name ?? nextName(def.namePrefix));
  setDialogError(null);
  // Anything before this feature that isn't a sketch has made or changed a solid. With none, New is all that makes sense.
  const base = doc.features.slice(0, position).some((f) => !isSketchFeature(f) && !f.suppressed);
  setHasBase(base);
  const initial = { ...(existing ? def.read(existing) : def.defaults()), ...preset };
  if (!base && initial.mode === 'add') initial.mode = 'new_body';
  setValues(reconcile(initial));
  setActiveDef(def);
  lastShown = new Set(pickFields(def).filter(shown).map((f) => f.key));
  // With its regions already there, as when a sketch was selected first, a revolve wants its axis next, as Onshape's does.
  const axis = def.fields.find((f) => f.kind === 'axis');
  setActivePick(axis && !existing && regionsChosen(initial) ? axis.key : pickFields(def).find(shown)?.key ?? null);
  applyPickMask();
  // As in Onshape, editing shows the model as it stood when this feature was made, with everything after it gone.
  if (existing) await setRollback(position);
  if ((regionField(def) || takesModelPicks(def)) && position > 0) {
    const snap = await snapshotAt(position - 1);
    if (activeDef() !== def) return;
    if (regionField(def)) setPreviewBase(snap.mesh);
    if (takesModelPicks(def)) {
      view.renderer?.setPickMesh(snap.mesh);
      setPickBase({ faces: snap.faces, edges: snap.edges, mesh: snap.mesh });
      applyPickMask();
    }
  }
  if (!existing) void applyPreview();
}

/** The body a face of the model before the feature belongs to. */
export const partOfFace = (base: PickBase, face: number) => base.mesh.parts.find((p) => p.faces.includes(face))?.name ?? null;

/** How a face is named for the kernel: by its name if nothing else has it, and otherwise by its own key. */
function faceRef(base: PickBase, i: number) {
  const f = base.faces[i];
  if (!f) return null;
  return base.faces.filter((x) => x.name === f.name).length === 1 ? f.name : f.key;
}

const same = (a: RegionPick, b: RegionPick) => a.sketch === b.sketch && a.id === b.id;
const regionPicks = () => ((values.regions ?? []) as RegionPick[]).map((p) => ({ ...p }));

/** A click on a region adds it, or drops it if it's in. Regions of several sketches can go into one extrude. */
export function toggleRegion(sketch: number, id: string) {
  const list = regionPicks();
  const i = list.findIndex((p) => same(p, { sketch, id }));
  if (i >= 0) list.splice(i, 1);
  else list.push({ sketch, id });
  setValues({ sketch: list[0]?.sketch ?? sketch, regions: list });
  void applyPreview();
}

/** Everything inside a selection box joins the picks. Unlike a click, a box only ever adds. */
export function addRegions(found: { sketch: number; id: string }[]) {
  if (!found.length) return;
  const list = regionPicks();
  for (const r of found) if (!list.some((p) => same(p, r))) list.push({ sketch: r.sketch, id: r.id });
  setValues({ sketch: list[0].sketch, regions: list });
  void applyPreview();
}

const sectionList = () => ((values.sections ?? []) as Section[]).map((x) => ({ ...x }));
const sameSection = (a: Section, b: Section) => a.sketch === b.sketch && (a.id ?? null) === (b.id ?? null);

/** A loft's profile, clicked in the view: added at the end, in the order they're clicked, or dropped if it's in. */
export function toggleSection(section: Section) {
  const list = sectionList();
  // A region that's all its sketch makes is the same profile as the sketch.
  const whole = wholeSketch(sketchRegions().get(section.sketch));
  const matches = (x: Section) => sameSection(x, section) || (x.sketch === section.sketch && (!x.id || !section.id) && whole.length === 1 && whole[0] === (x.id ?? section.id));
  const i = list.findIndex(matches);
  setValue('sections', i >= 0 ? list.filter((_, at) => at !== i) : [...list, section]);
}

export function removeSection(at: number) {
  setValue('sections', sectionList().filter((_, i) => i !== at));
}

/** A sketch chosen in the list brings all of it, or takes it all out again if it's all in. A loft takes it as one profile. */
export function pickWholeSketch(sketch: number) {
  if (activeDef()?.fields.some((f) => f.kind === 'sections')) return toggleSection({ sketch });
  const all = wholeSketch(sketchRegions().get(sketch)).map((id) => ({ sketch, id }));
  const list = regionPicks();
  const allIn = all.length > 0 && all.every((r) => list.some((p) => same(p, r)));
  const next = allIn ? list.filter((p) => p.sketch !== sketch) : [...list, ...all.filter((r) => !list.some((p) => same(p, r)))];
  setValues({ sketch: next[0]?.sketch ?? sketch, regions: next });
  void applyPreview();
}

/** Empties the regions and faces. A sketch with regions stays on show to pick from, and one without has nothing to keep it for. */
export function clearRegions() {
  setValues({ regions: [], faces: [], sketch: sketchRegions().get(values.sketch)?.length ? values.sketch : null });
  void applyPreview();
}

/** Whether a face of the model before this feature is flat, which is what an extrude can take. */
export const flatFace = (base: PickBase, i: number) => base.faces[i]?.surface === 'plane';

/** A click on a flat face adds it to an extrude, or drops it if it's in. */
function toggleFace(base: PickBase, i: number) {
  const ref = flatFace(base, i) ? faceRef(base, i) : null;
  if (!ref) return;
  const list: string[] = [...(values.faces ?? [])];
  setValue('faces', list.includes(ref) ? list.filter((x) => x !== ref) : [...list, ref]);
}

export function removeFace(ref: string) {
  setValue('faces', ((values.faces ?? []) as string[]).filter((x) => x !== ref));
}

export function removeRegions(sketch: number, ids?: string[]) {
  const next = regionPicks().filter((p) => p.sketch !== sketch || (ids && !ids.includes(p.id)));
  setValues({ regions: next, sketch: next[0]?.sketch ?? values.sketch });
  void applyPreview();
}

/** What's already selected, for a dialog that takes regions: regions in the view, or a sketch in the list. */
function regionsFromSelection(): Values | undefined {
  const picked = selectedRegions();
  if (picked) {
    const there = sketchRegions().get(picked.sketch) ?? [];
    const ids = picked.ids.filter((id) => there.some((r) => r.id === id));
    if (ids.length) return { sketch: picked.sketch, regions: ids.map((id) => ({ sketch: picked.sketch, id })) };
  }
  const chosen = doc.features.find((f) => f.id === selectedFeature());
  if (chosen && isSketchFeature(chosen)) return { sketch: chosen.id, regions: wholeSketch(sketchRegions().get(chosen.id)).map((id) => ({ sketch: chosen.id, id })) };
  return undefined;
}

/** Makes a field take the clicks. */
export function activatePick(key: string) {
  setActivePick(key);
  applyPickMask();
}

/** A pick in the viewport, while a dialog takes a selection. For a vertex, `end` says which end of the edge was nearer. */
export function togglePick(hit: { kind: string; id: number }, end: 'start' | 'end' = 'start') {
  const base = pickBase();
  const key = pickKey();
  const kind = pickKind();
  if (!base || !key) return;
  const toggled = <T>(list: T[], item: T) => {
    const c = canonical(item);
    return list.some((x) => canonical(x) === c) ? list.filter((x) => canonical(x) !== c) : [...list, item];
  };
  if (hit.kind === 'face' && kind === 'regions') {
    if (regionsTakeFaces()) toggleFace(base, hit.id);
  } else if (hit.kind === 'edge' && kind === 'edges') {
    const select = base.edges[hit.id]?.select;
    if (select !== undefined) setValue(key, toggled(JSON.parse(JSON.stringify(values[key] ?? [])), select));
  } else if (hit.kind === 'edge' && kind === 'vertex') {
    const e = base.edges[hit.id];
    const vertex = e?.[end === 'start' ? 'start_vertex' : 'end_vertex'];
    if (vertex) setValue(key, { faces: vertex.faces, near: e[end] });
  } else if (hit.kind === 'face' && kind === 'faces') {
    const name = base.faces[hit.id]?.name;
    if (name) setValue(key, toggled([...(values[key] ?? [])], name));
  } else if (hit.kind === 'face' && kind === 'face') {
    const ref = faceRef(base, hit.id);
    if (ref) setValue(key, values[key] === ref ? null : ref);
  } else if (hit.kind === 'face' && (kind === 'part' || kind === 'parts')) {
    const part = partOfFace(base, hit.id);
    if (!part) return;
    if (kind === 'part') setValue(key, values[key] === part ? null : part);
    else setValue(key, toggled([...(values[key] ?? [])], part));
  }
}

/** A revolve's axis, from a line of its sketch clicked in the view. */
export function pickAxisLine(lineId: number) {
  const key = pickKey();
  if (key) setValue(key, `line:${lineId}`);
}

/** Everything inside a selection box joins the picks. Unlike a click, a box only ever adds. */
export function addPicks(found: { faces: number[]; edges: number[] }) {
  const base = pickBase();
  const key = pickKey();
  const kind = pickKind();
  if (!base || !key) return;
  if (kind === 'edges') {
    const list: unknown[] = JSON.parse(JSON.stringify(values[key] ?? []));
    const have = new Set(list.map(canonical));
    for (const i of found.edges) {
      const select = base.edges[i]?.select;
      if (select !== undefined && !have.has(canonical(select))) {
        have.add(canonical(select));
        list.push(select);
      }
    }
    setValue(key, list);
  } else if (kind === 'faces') {
    const names = new Set<string>(values[key] ?? []);
    for (const i of found.faces) if (base.faces[i]) names.add(base.faces[i].name);
    setValue(key, [...names]);
  } else if (kind === 'regions' && regionsTakeFaces()) {
    const refs = new Set<string>(values.faces ?? []);
    for (const i of found.faces) {
      const ref = flatFace(base, i) ? faceRef(base, i) : null;
      if (ref) refs.add(ref);
    }
    if (refs.size !== (values.faces ?? []).length) setValue('faces', [...refs]);
  } else if (kind === 'parts') {
    const names = new Set<string>(values[key] ?? []);
    for (const i of found.faces) {
      const part = partOfFace(base, i);
      if (part) names.add(part);
    }
    setValue(key, [...names]);
  }
}

export async function acceptDialog() {
  const def = activeDef();
  if (!def || dialogMissing()) return;
  await applyPreview();
  await settle;
  if (dialogError()) return;
  const id = featureId;
  const editing = editingId() !== null;
  const held = heldBar;
  if (touched) pushUndo(before);
  close();
  if (id !== null) setSelectedFeature(id);
  // An edit goes back to where the bar was. A new feature went in at the bar, so the bar belongs just after it.
  await returnBar(editing || id === null ? held : { ...held, feature: id });
}

export async function cancelDialog() {
  if (!activeDef()) return;
  await settle;
  const changed = touched;
  const text = before;
  const back = resume;
  const held = heldBar;
  close();
  if (changed) {
    // The document goes back to how it was, so the bar's old position means what it did.
    setDoc('rollback', held.index);
    try {
      await mutate('document_open', { text });
    } catch (e) {
      toast((e as ToolError).message, 'error');
    }
  } else {
    await setRollback(held.index);
  }
  setSelectedFeature(back.feature);
  setSelectedRegions(back.regions);
}

export function editFeature(id: number) {
  const f = doc.features.find((x) => x.id === id);
  const def = f && defForFeature(f);
  if (!def) {
    toast('This feature has no dialog yet. An AI or the file can still change it.');
    return;
  }
  void openDialog(def.id, id);
}

/** Starts a feature with whatever's already selected in the viewport, if it can use it. */
export async function startFeature(defId: string) {
  const def = defById(defId);
  if (!def) return;
  const sel = selection();
  await openDialog(defId, null, regionField(def) ? regionsFromSelection() : undefined);
  const base = pickBase();
  const field = activeField();
  if (!field || !base || !activeDef()) return;
  // A flat face selected first is what the extrude takes, as when you select a face in Onshape and press Extrude.
  if (field.kind === 'regions' && sel.faces.length) {
    const refs = [...new Set(sel.faces.filter((i) => flatFace(base, i)).map((i) => faceRef(base, i)).filter((x): x is string => !!x))];
    if (refs.length) setValue('faces', refs);
  }
  if (field.kind === 'edges' && sel.edges.length) setValue(field.key, sel.edges.map((i) => base.edges[i]?.select).filter(Boolean));
  if (field.kind === 'faces' && sel.faces.length) setValue(field.key, [...new Set(sel.faces.map((i) => base.faces[i]?.name).filter(Boolean))]);
  if (field.kind === 'parts' && sel.faces.length) setValue(field.key, [...new Set(sel.faces.map((i) => partOfFace(base, i)).filter(Boolean))]);
}
