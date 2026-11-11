import { createSignal } from 'solid-js';
import { setDoc, setMesh, storage } from '../store/doc';
import { assemblyHooks, tabById, tabDocumentText, tabs } from '../store/tabs';
import { setHoverText, setSelection, toast } from '../store/ui';
import { bakeParts, ownerOf, type Baked } from './bake';
import { findSpot } from './connectors';
import { emptyAssembly, parseAssembly, type AssemblyData, type ConnectorRef, type InstanceData, type MateData } from './model';
import { knownStudio, loadStudio, type PartMesh } from './parts';
import { dragTo, IDENTITY, mateTypeName, snapFirst, snapSecond, solve, type DragGoal, type MateType, type SolverBody, type SolverMate } from './solver';

const assemblyKey = (tab: string) => `schmishape.assembly.${tab}`;

export const [asm, setAsm] = createSignal<AssemblyData>(emptyAssembly());
export const [selectedInstances, setSelectedInstances] = createSignal<string[]>([]);
export const [selectedMate, setSelectedMate] = createSignal<string | null>(null);
export const [renamingInstance, setRenamingInstance] = createSignal<string | null>(null);
export const [renamingMate, setRenamingMate] = createSignal<string | null>(null);
/** How much the parts can still move, or null before anything's placed. */
export const [asmFreedom, setAsmFreedom] = createSignal(0);
export const [mateFailures, setMateFailures] = createSignal<Map<string, string>>(new Map());
export const [insertOpen, setInsertOpen] = createSignal(false);
export interface InsertRow { tab: string; name: string; parts: { body: string; label: string }[]; error?: string }
export const [insertRows, setInsertRows] = createSignal<InsertRow[] | null>(null);
export const [asmCanUndo, setAsmCanUndo] = createSignal(false);
export const [asmCanRedo, setAsmCanRedo] = createSignal(false);

export interface PickedConnector { instance: string; connector: ConnectorRef }
export interface MateDraft {
  /** The mate being changed, or the id a new one will have. */
  id: string;
  editing: boolean;
  name: string;
  type: MateType;
  first: PickedConnector | null;
  second: PickedConnector | null;
  flip: boolean;
  quarter: number;
  suppressed: boolean;
  /** The whole assembly as it was, for Cancel. */
  before: string;
  error: string | null;
}
export const [mateDraft, setMateDraft] = createSignal<MateDraft | null>(null);

let here = '';
let baked: Baked | null = null;
let bakedIds: string[] = [];
const stacks = new Map<string, { undo: string[]; redo: string[] }>();
const stack = () => {
  if (!stacks.has(here)) stacks.set(here, { undo: [], redo: [] });
  return stacks.get(here)!;
};

export const instanceById = (id: string) => asm().instances.find((i) => i.id === id);
export const partOf = (i: InstanceData): PartMesh | undefined => (tabById(i.tab) ? knownStudio(i.tab)?.parts.find((p) => p.body === i.body) : undefined);
const studioCount = () => tabs().filter((t) => t.kind === 'part-studio').length;

/** As in Onshape's list: "Part 1 <1>". With several Part Studios it says which one, since each has its own Part 1. */
export function instanceName(i: InstanceData) {
  if (i.name) return i.name;
  const label = partOf(i)?.label ?? 'Part';
  const tab = tabById(i.tab);
  return `${tab && studioCount() > 1 ? `${tab.name}: ` : ''}${label} <${i.number}>`;
}

/** Why an instance can't be shown, if it can't. */
export function instanceProblem(i: InstanceData): string | null {
  const tab = tabById(i.tab);
  if (!tab) return 'Its Part Studio was deleted.';
  const studio = knownStudio(i.tab);
  if (studio?.error) return `${tab.name} couldn’t be read. ${studio.error}`;
  if (!partOf(i)) return `This part is gone from ${tab.name}.`;
  return null;
}

const bodyFor = (i: InstanceData, part: PartMesh): SolverBody => ({ id: i.id, pose: i.pose, fixed: i.fixed, center: part.center, size: part.size });

function solverBodies(data: AssemblyData): SolverBody[] {
  const out: SolverBody[] = [];
  for (const i of data.instances) {
    const part = partOf(i);
    if (part) out.push(bodyFor(i, part));
  }
  return out;
}

const toSolverMate = (m: MateData): SolverMate => ({ id: m.id, name: m.name, type: m.type, a: m.a, b: m.b, fa: m.ca.frame, fb: m.cb.frame, flip: m.flip, quarter: m.quarter });

/** Finds each connector again, since its part may have changed, and gathers the mates that can be solved. */
function liveMates(data: AssemblyData, failures: Map<string, string>): SolverMate[] {
  const out: SolverMate[] = [];
  const instance = (id: string) => data.instances.find((i) => i.id === id);
  for (const m of data.mates) {
    if (m.suppressed) continue;
    const a = instance(m.a), b = instance(m.b);
    const pa = a && partOf(a), pb = b && partOf(b);
    if (!pa || !pb) {
      failures.set(m.id, 'One of its parts is gone.');
      continue;
    }
    const fa = findSpot(pa, m.ca), fb = findSpot(pb, m.cb);
    if (!fa || !fb) {
      const gone = !fa ? m.ca : m.cb;
      failures.set(m.id, `The ${gone.kind} its ${!fa ? 'first' : 'second'} connector was on is gone from its part. Edit this mate to pick another.`);
      continue;
    }
    m.ca = { ...m.ca, frame: fa };
    m.cb = { ...m.cb, frame: fb };
    out.push(toSolverMate(m));
  }
  return out;
}

/** The first thing wrong, in the status bar as a failed feature is, in plain words. */
function reportProblems(data: AssemblyData, failures: Map<string, string>) {
  const first = data.mates.find((m) => failures.has(m.id));
  const instance = data.instances.find((i) => instanceProblem(i));
  const text = first ? `${first.name}: ${failures.get(first.id)}` : instance ? `${instanceName(instance)}: ${instanceProblem(instance)}` : null;
  setDoc('failed', text);
}

/** Puts every part where its mates say. */
function resolve(data: AssemblyData, light?: string[]) {
  const failures = new Map<string, string>();
  const mates = liveMates(data, failures);
  const result = solve(solverBodies(data), mates, { light });
  for (const i of data.instances) {
    const pose = result.poses.get(i.id);
    if (pose) i.pose = pose;
  }
  for (const f of result.failed) failures.set(f.mate, f.reason);
  setMateFailures(failures);
  setAsmFreedom(result.dof);
  reportProblems(data, failures);
}

const publish = (data: AssemblyData) => setAsm({ ...data, instances: data.instances.map((i) => ({ ...i })), mates: data.mates.map((m) => ({ ...m })) });
const save = () => { if (here) storage.set(assemblyKey(here), JSON.stringify(asm())); };

/** Everything on show, as one mesh for the viewport. */
export function rebake() {
  const items: { part: PartMesh; pose: InstanceData['pose'] }[] = [];
  bakedIds = [];
  for (const i of asm().instances) {
    const part = partOf(i);
    if (!part || i.hidden) continue;
    items.push({ part, pose: i.pose });
    bakedIds.push(i.id);
  }
  baked = bakeParts(items);
  setMesh(baked.mesh);
  lightSelection();
}

/** What a picked face or edge belongs to. */
export function ownerOfHit(hit: { kind: string; id: number } | null) {
  if (!hit || !baked || (hit.kind !== 'face' && hit.kind !== 'edge')) return null;
  const bases = hit.kind === 'face' ? baked.faceBase : baked.edgeBase;
  const at = ownerOf(bases, hit.id);
  if (at < 0) return null;
  const instance = instanceById(bakedIds[at]);
  const part = instance && partOf(instance);
  return instance && part ? { instance, part, local: hit.id - bases[at] } : null;
}

function lightSelection() {
  const faces: number[] = [];
  if (baked) {
    for (const id of selectedInstances()) {
      const at = bakedIds.indexOf(id);
      if (at >= 0) faces.push(...baked.mesh.parts[at].faces);
    }
  }
  setSelection({ faces, edges: [] });
}

export function selectInstances(ids: string[]) {
  setSelectedInstances(ids);
  setSelectedMate(null);
  lightSelection();
}

function commit(before: string) {
  const s = stack();
  s.undo.push(before);
  if (s.undo.length > 200) s.undo.shift();
  s.redo = [];
  setAsmCanUndo(true);
  setAsmCanRedo(false);
  save();
}

const snapshot = () => JSON.stringify(asm());

/** A change to the assembly with its own undo step. */
function change(edit: (data: AssemblyData) => void, light?: string[]) {
  const before = snapshot();
  const data: AssemblyData = JSON.parse(before);
  edit(data);
  resolve(data, light);
  publish(data);
  rebake();
  commit(before);
}

function showSaved(text: string) {
  const data = parseAssembly(text);
  resolve(data);
  publish(data);
  const ids = new Set(data.instances.map((i) => i.id));
  setSelectedInstances(selectedInstances().filter((id) => ids.has(id)));
  rebake();
  save();
}

export function asmUndo() {
  const s = stack();
  const text = s.undo.pop();
  if (text === undefined || mateDraft()) {
    if (text !== undefined) s.undo.push(text);
    return;
  }
  s.redo.push(snapshot());
  setAsmCanUndo(s.undo.length > 0);
  setAsmCanRedo(true);
  showSaved(text);
}

export function asmRedo() {
  const s = stack();
  const text = s.redo.pop();
  if (text === undefined || mateDraft()) {
    if (text !== undefined) s.redo.push(text);
    return;
  }
  s.undo.push(snapshot());
  setAsmCanUndo(true);
  setAsmCanRedo(s.redo.length > 0);
  showSaved(text);
}

async function loadAll(data: AssemblyData) {
  const wanted = new Set(data.instances.map((i) => i.tab));
  for (const tab of wanted) {
    if (tabById(tab)) await loadStudio(tab, tabDocumentText(tab));
  }
}

/** Coming to an assembly reads any Part Studio that changed, so its instances and connectors follow. */
async function enterAssembly(tab: string) {
  here = tab;
  const data = parseAssembly(storage.get(assemblyKey(tab)));
  setSelectedInstances([]);
  setSelectedMate(null);
  setMateDraft(null);
  setInsertOpen(false);
  await loadAll(data);
  resolve(data);
  publish(data);
  const s = stack();
  setAsmCanUndo(s.undo.length > 0);
  setAsmCanRedo(s.redo.length > 0);
  rebake();
  save();
}

function leaveAssembly() {
  if (mateDraft()) cancelMate();
  save();
  setSelectedInstances([]);
  setSelectedMate(null);
  setInsertOpen(false);
  setHoverText('');
  setDoc('failed', null);
  here = '';
}

assemblyHooks.enter = enterAssembly;
assemblyHooks.leave = leaveAssembly;
assemblyHooks.copy = (from, to) => {
  const text = storage.get(assemblyKey(from));
  if (text) storage.set(assemblyKey(to), text);
};
assemblyHooks.take = (tab) => {
  const text = storage.get(assemblyKey(tab));
  storage.remove(assemblyKey(tab));
  return text;
};
assemblyHooks.put = (tab, text) => {
  if (text) storage.set(assemblyKey(tab), text);
};

// Insert

export async function openInsert() {
  if (mateDraft()) cancelMate();
  setInsertOpen(true);
  setInsertRows(null);
  const rows: InsertRow[] = [];
  for (const t of tabs().filter((x) => x.kind === 'part-studio')) {
    const studio = await loadStudio(t.id, tabDocumentText(t.id));
    rows.push({ tab: t.id, name: t.name, parts: studio.parts.map((p) => ({ body: p.body, label: p.label })), error: studio.error });
  }
  setInsertRows(rows);
}

/**
 * Puts a part in, or all of a Part Studio's. It lands where it is in the Part Studio, and another of the same part lands
 * a little way off so you can see it. As in Onshape, nothing is fixed until you fix it.
 */
export async function insertParts(tab: string, body: string | null) {
  const studio = await loadStudio(tab, tabDocumentText(tab));
  const parts = studio.parts.filter((p) => body === null || p.body === body);
  if (!parts.length) return;
  const added: string[] = [];
  change((data) => {
    for (const part of parts) {
      const same = data.instances.filter((i) => i.tab === tab && i.body === part.body);
      const used = new Set(same.map((i) => i.number));
      let number = 1;
      while (used.has(number)) number++;
      const off = same.length * part.size * 0.5;
      const id = `i${data.next++}`;
      added.push(id);
      data.instances.push({ id, tab, body: part.body, number, name: null, pose: { p: [off, off, 0], q: [...IDENTITY.q] }, fixed: false, hidden: false });
    }
  });
  selectInstances(added);
}

// Instances

export const setFixed = (id: string, fixed: boolean) => change((data) => {
  const i = data.instances.find((x) => x.id === id);
  if (i) i.fixed = fixed;
});
export const setHidden = (id: string, hidden: boolean) => change((data) => {
  const i = data.instances.find((x) => x.id === id);
  if (i) i.hidden = hidden;
});
export const renameInstance = (id: string, name: string) => change((data) => {
  const i = data.instances.find((x) => x.id === id);
  if (i) i.name = name.trim() || null;
});

/** Deletes instances, and the mates they were in, which can't work without them. */
export function deleteInstances(ids: string[]) {
  if (!ids.length) return;
  const gone = asm().mates.filter((m) => ids.includes(m.a) || ids.includes(m.b)).length;
  change((data) => {
    data.instances = data.instances.filter((i) => !ids.includes(i.id));
    data.mates = data.mates.filter((m) => !ids.includes(m.a) && !ids.includes(m.b));
  });
  selectInstances([]);
  if (gone) toast(`Its ${gone === 1 ? 'mate went' : `${gone} mates went`} with it. Ctrl Z brings them back.`);
}

// Dragging

function dragMates(): SolverMate[] {
  const failures = mateFailures();
  const data = asm();
  return data.mates.filter((m) => !m.suppressed && !failures.has(m.id)).map(toSolverMate);
}

export function isDraggable(id: string) {
  const i = instanceById(id);
  return !!i && !i.fixed && !!partOf(i);
}

/** One step of a drag. It moves whatever the mates allow, and it doesn't count as a change until the drag ends. */
export function applyDrag(goal: DragGoal) {
  const data = asm();
  const poses = dragTo(solverBodies(data), dragMates(), goal);
  if (!poses) return false;
  for (const i of data.instances) {
    const pose = poses.get(i.id);
    if (pose) i.pose = pose;
  }
  rebake();
  return true;
}

export const dragSnapshot = snapshot;
export function finishDrag(before: string) {
  if (before === snapshot()) return;
  publish(asm());
  commit(before);
}

// Mates

function firstFreeMateName(data: AssemblyData, type: MateType) {
  const names = new Set(data.mates.map((m) => m.name));
  let n = 1;
  while (names.has(`${mateTypeName(type)} ${n}`)) n++;
  return `${mateTypeName(type)} ${n}`;
}

export function startMate(type: MateType) {
  if (mateDraft()) cancelMate();
  setInsertOpen(false);
  selectInstances([]);
  const before = snapshot();
  const data = asm();
  setMateDraft({ id: `m${data.next}`, editing: false, name: firstFreeMateName(data, type), type, first: null, second: null, flip: false, quarter: 0, suppressed: false, before, error: null });
}

export function editMate(id: string) {
  if (mateDraft()) cancelMate();
  const m = asm().mates.find((x) => x.id === id);
  if (!m) return;
  setInsertOpen(false);
  selectInstances([]);
  setMateDraft({ id, editing: true, name: m.name, type: m.type, first: { instance: m.a, connector: m.ca }, second: { instance: m.b, connector: m.cb }, flip: m.flip, quarter: m.quarter, suppressed: m.suppressed, before: snapshot(), error: null });
  previewDraft();
}

/** Rebuilds the assembly from how it was before the dialog, with the mate as it now stands. */
function previewDraft() {
  const draft = mateDraft();
  if (!draft) return;
  const data = parseAssembly(draft.before);
  // An edited mate keeps its place in the list. A mate's place decides which one is blamed when they can't all hold.
  const place = data.mates.findIndex((m) => m.id === draft.id);
  data.mates = data.mates.filter((m) => m.id !== draft.id);
  let error: string | null = null;
  if (draft.first && draft.second) {
    const mate: MateData = { id: draft.id, name: draft.name, type: draft.type, a: draft.first.instance, b: draft.second.instance, ca: draft.first.connector, cb: draft.second.connector, flip: draft.flip, quarter: draft.quarter, suppressed: draft.suppressed };
    const a = data.instances.find((i) => i.id === mate.a), b = data.instances.find((i) => i.id === mate.b);
    let light: string[] | undefined;
    if (a && b) {
      // The first part picked goes to the second, unless it's the fixed one. With nothing else holding it, it goes right there.
      const mover = !a.fixed ? a : !b.fixed ? b : null;
      if (mover) {
        light = [mover.id];
        const held = data.mates.some((m) => !m.suppressed && (m.a === mover.id || m.b === mover.id));
        if (!held) mover.pose = mover === a ? snapFirst(toSolverMate(mate), b.pose) : snapSecond(toSolverMate(mate), a.pose);
      }
    }
    data.mates.splice(place >= 0 ? place : data.mates.length, 0, mate);
    if (!draft.editing) data.next = Math.max(data.next, Number(draft.id.slice(1)) + 1);
    resolve(data, light);
    error = mateFailures().get(draft.id) ?? null;
  } else {
    resolve(data);
  }
  publish(data);
  rebake();
  setMateDraft({ ...draft, error });
}

export function updateDraft(change: Partial<MateDraft>) {
  const draft = mateDraft();
  if (!draft) return;
  const next = { ...draft, ...change };
  if (change.type && !draft.editing) next.name = firstFreeMateName(parseAssembly(draft.before), change.type);
  setMateDraft(next);
  previewDraft();
}

/** The next connector goes in the first empty place, or replaces the second. It has to be on another part from the first. */
export function pickConnector(picked: PickedConnector) {
  const draft = mateDraft();
  if (!draft) return;
  if (!draft.first) return updateDraft({ first: picked });
  if (picked.instance === draft.first.instance) {
    toast('Pick a connector on a different part.');
    return;
  }
  updateDraft({ second: picked });
}

export function acceptMate() {
  const draft = mateDraft();
  if (!draft || !draft.first || !draft.second || draft.error) return;
  setMateDraft(null);
  commit(draft.before);
  setSelectedMate(draft.id);
}

export function cancelMate() {
  const draft = mateDraft();
  if (!draft) return;
  setMateDraft(null);
  const data = parseAssembly(draft.before);
  resolve(data);
  publish(data);
  rebake();
}

export const setMateSuppressed = (id: string, suppressed: boolean) => change((data) => {
  const m = data.mates.find((x) => x.id === id);
  if (m) m.suppressed = suppressed;
});
export const renameMate = (id: string, name: string) => change((data) => {
  const m = data.mates.find((x) => x.id === id);
  if (m && name.trim()) m.name = name.trim();
});
export function deleteMate(id: string) {
  change((data) => {
    data.mates = data.mates.filter((m) => m.id !== id);
  });
  if (selectedMate() === id) setSelectedMate(null);
}

export { edgeSpots, faceSpots } from './connectors';
