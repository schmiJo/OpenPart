import { createSignal } from 'solid-js';
import { sameRegions, sketchLines, wholeSketch, type RegionPick } from '../sketch/regions';
import { doc, isHidden, numberOr, sketchRegions } from '../store/doc';

export type FieldKind =
  | 'expr' | 'segment' | 'tabs' | 'check' | 'group' | 'select' | 'sketch' | 'sketches' | 'steps'
  | 'edges' | 'faces' | 'face' | 'part' | 'parts' | 'vertex' | 'regions' | 'axis';
/** Fields filled by clicking in the view. One at a time takes the clicks, as in Onshape. */
export const PICK_KINDS = new Set<FieldKind>(['edges', 'faces', 'face', 'part', 'parts', 'vertex', 'regions', 'axis']);
export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  unit?: string;
  options?: { value: string; label: string; disabled?: (v: Values) => boolean }[];
  hint?: string;
  /** Only shown when this says so. */
  when?: (v: Values) => boolean;
  /** Greyed out when this says so. */
  disabled?: (v: Values) => boolean;
  /** Positive numbers only, when dragged. */
  scrub?: number;
  /** For an expr or a select: the value a flip button beside it turns on and off, and when that button is off limits. */
  flip?: { key: string; label: string; disabled?: (v: Values) => boolean };
  /** For a group: what's inside it. */
  fields?: FieldDef[];
  /** For a group: it has a checkbox, setting its key, that turns its contents on. */
  checkable?: boolean;
  /** Takes the dialog's whole width, with its label only for screen readers, as Onshape's Result row does. */
  bare?: boolean;
}
export type Values = Record<string, any>;

export interface FeatureDef {
  id: string;
  title: string;
  icon: string;
  namePrefix: string;
  fields: FieldDef[];
  defaults(): Values;
  /** The feature's JSON, or null if it isn't complete yet. */
  make(v: Values): any | null;
  read(f: any): Values;
  /** What's still needed before it can be added, if anything. */
  missing?(v: Values): string | null;
  /** Needs a solid before it, to pick from or to act on. */
  needsBody?: boolean;
}

/** Whether there's a solid before this feature for it to act on. Set when the dialog opens, so nothing moves as the preview makes one. */
export const [hasBase, setHasBase] = createSignal(true);
const needsBase = () => !hasBase();

const surface = (v: Values) => v.body === 'surface';
const MODE: FieldDef = {
  key: 'mode',
  label: 'Result',
  kind: 'segment',
  bare: true,
  when: (v) => !surface(v),
  options: [
    { value: 'new_body', label: 'New' },
    { value: 'add', label: 'Add', disabled: needsBase },
    { value: 'remove', label: 'Remove', disabled: needsBase },
    { value: 'intersect', label: 'Intersect', disabled: needsBase },
  ],
};
/** Onshape's Solid and Surface. A surface is a sheet of its own, with no inside, so it has no Result. */
const CREATION: FieldDef = {
  key: 'body',
  label: 'Creation type',
  kind: 'tabs',
  options: [{ value: 'solid', label: 'Solid' }, { value: 'surface', label: 'Surface' }],
};
const modeOf = (v: Values) => (surface(v) ? 'surface' : v.mode);
const readMode = (f: any): Values => (f.mode === 'surface' ? { body: 'surface', mode: 'new_body' } : { body: 'solid', mode: f.mode ?? 'add' });

const num = numberOr;
const str = (v: unknown) => String(v ?? '');
const POSITION: FieldDef[] = [
  { key: 'x', label: 'X', kind: 'expr', unit: 'mm', scrub: 1 },
  { key: 'y', label: 'Y', kind: 'expr', unit: 'mm', scrub: 1 },
  { key: 'z', label: 'Z', kind: 'expr', unit: 'mm', scrub: 1 },
];

function solidDef(shape: string, title: string, dims: FieldDef[], defaults: Values): FeatureDef {
  return {
    id: shape,
    title,
    icon: shape,
    namePrefix: title,
    fields: [MODE, ...dims, ...POSITION],
    defaults: () => ({ ...defaults, x: '0', y: '0', z: '0', mode: 'add' }),
    make(v) {
      const out: any = { type: 'solid', shape, mode: v.mode };
      for (const d of dims) out[d.key] = num(v[d.key]);
      const at = [num(v.x), num(v.y), num(v.z)];
      if (at.some((c) => c !== 0)) out.at = { origin: at };
      return out;
    },
    read(f) {
      const v: Values = { mode: f.mode ?? 'add', x: str(f.at?.origin?.[0] ?? 0), y: str(f.at?.origin?.[1] ?? 0), z: str(f.at?.origin?.[2] ?? 0) };
      for (const d of dims) v[d.key] = str(f[d.key]);
      return v;
    },
  };
}

const dim = (key: string, label: string): FieldDef => ({ key, label, kind: 'expr', unit: 'mm', scrub: 0.5 });
const angle = (key: string, label: string): FieldDef => ({ key, label, kind: 'expr', unit: '°', scrub: 1 });

export const lastSketchId = () => {
  for (let i = doc.features.length - 1; i >= 0; i--) {
    const f = doc.features[i];
    if ((f.type === 'constrained_sketch' || f.type === 'sketch') && !isHidden(f) && !f.suppressed) return f.id as number;
  }
  return null;
};

type AxisName = 'x' | 'y' | 'z';
const AXES: Record<AxisName, [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const axisName = (v?: number[]): AxisName => (!v ? 'z' : Math.abs(v[0]) > 0.5 ? 'x' : Math.abs(v[1]) > 0.5 ? 'y' : 'z');
const AXIS_FIELD = (key: string, label: string): FieldDef => ({ key, label, kind: 'segment', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }] });
const point = (v: Values, keys: [string, string, string]) => keys.map((k) => num(v[k]));
const isOrigin = (p: unknown[]) => p.every((c) => c === 0);

const picks = (v: Values) => (v.regions ?? []) as RegionPick[];
/** Whether something is picked. A sketch with no regions on record stays chosen, for the kernel to say why it can't build. */
export const regionsChosen = (v: Values) => picks(v).length > 0 || (v.sketch !== null && v.sketch !== undefined && !sketchRegions().get(Number(v.sketch))?.length);

/**
 * The sketch and regions an extrude takes. All of one sketch is just that sketch, so it keeps up as regions come and go.
 * Anything else lists them: plainly for the first sketch, and with their sketch for the others.
 */
function regionsJson(v: Values): { sketch: number; regions?: unknown[] } {
  const list = picks(v);
  if (!list.length) return { sketch: Number(v.sketch) };
  const first = list[0].sketch;
  if (list.every((p) => p.sketch === first) && sameRegions(list.map((p) => p.id), wholeSketch(sketchRegions().get(first)))) return { sketch: first };
  return { sketch: first, regions: list.map((p) => (p.sketch === first ? p.id : { sketch: p.sketch, region: p.id })) };
}

/** What an extrude takes, as the dialog picks it. Regions that have gone from their sketch are left for picking again. */
function readRegions(f: any): { sketch: number; regions: RegionPick[] } {
  const there = (p: RegionPick) => (sketchRegions().get(p.sketch) ?? []).some((r) => r.id === p.id);
  if (Array.isArray(f.regions) && f.regions.length) {
    const list = f.regions.map((r: any): RegionPick => (typeof r === 'string' ? { sketch: f.sketch, id: r } : { sketch: r.sketch, id: r.region }));
    return { sketch: f.sketch ?? list[0].sketch, regions: list.filter(there) };
  }
  return { sketch: f.sketch, regions: wholeSketch(sketchRegions().get(f.sketch)).map((id) => ({ sketch: f.sketch, id })) };
}

type Amount = number | string;
const neg = (v: Amount): Amount => (typeof v === 'number' ? (v === 0 ? 0 : -v) : `-(${v})`);
const half = (v: Amount): Amount => (typeof v === 'number' ? v / 2 : `(${v}) / 2`);
const plus = (a: Amount, b: Amount): Amount => {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (b === 0) return a;
  if (a === 0) return b;
  return `(${a}) + (${b})`;
};
const minus = (a: Amount, b: Amount): Amount => (a === 0 ? neg(b) : b === 0 ? a : typeof a === 'number' && typeof b === 'number' ? a - b : `(${a}) - (${b})`);

/**
 * Where a blind extrude's options put it along the sketch's normal, as a start and a length: the depth runs from the
 * starting offset, the flip reverses it, the second end reaches back the other way, and symmetric centres the depth on
 * the start. This is how flipped extrudes have always been written, so their end faces keep their names.
 */
function extent(v: Values): { start: Amount; length: Amount } {
  const depth = num(v.length);
  const offset = v.offsetOn ? num(v.offset) : 0;
  if (v.symmetric) return { start: minus(offset, half(depth)), length: depth };
  const second = v.secondOn ? num(v.second) : 0;
  const length = plus(depth, second);
  return { start: v.flip ? neg(plus(offset, depth)) : minus(offset, second), length };
}

/** Two amounts as the kernel might hand them back, which can tidy up brackets and fold constants. */
const bare = (v: unknown) => String(v ?? '').replace(/[\s()]/g, '');

const EXTRUDE_OPTIONS = { flip: false, symmetric: false, offsetOn: false, offset: '5', secondOn: false, second: '10', end: 'blind', endFace: null, endPart: null, endVertex: null, keepOpposite: false };
const END_TYPES = [
  { value: 'blind', label: 'Blind' },
  { value: 'up_to_next', label: 'Up to next' },
  { value: 'up_to_face', label: 'Up to face' },
  { value: 'up_to_part', label: 'Up to part' },
  { value: 'up_to_vertex', label: 'Up to vertex' },
  { value: 'through_all', label: 'Through all' },
];
const endType = (v: Values) => (surface(v) ? 'blind' : v.end ?? 'blind');
const blind = (v: Values) => endType(v) === 'blind';

/** Where an extrude stops when it isn't blind, or null while what it stops at isn't picked yet. */
function endJson(v: Values): unknown | null {
  switch (endType(v)) {
    case 'up_to_face': return v.endFace ? { type: 'up_to_face', face: v.endFace } : null;
    case 'up_to_part': return v.endPart ? { type: 'up_to_part', part: v.endPart } : null;
    case 'up_to_vertex': return v.endVertex ? { type: 'up_to_vertex', vertex: v.endVertex } : null;
    default: return endType(v);
  }
}

/**
 * What the dialog showed for an extrude. Its own record is used only if it still describes the feature, since a file or
 * an AI can change a feature without knowing about it. Otherwise this works it out, and anything it can't name becomes
 * a starting offset, so opening a feature never changes its shape.
 */
function readExtent(f: any): Values {
  const base = { ...EXTRUDE_OPTIONS, length: str(f.length) };
  const start = f.start ?? 0;
  const end = typeof f.end === 'string' ? f.end : f.end?.type ?? 'blind';
  if (end !== 'blind' || f.opposite) {
    const ends = { end, endFace: f.end?.face ?? null, endPart: f.end?.part ?? null, endVertex: f.end?.vertex ?? null };
    return { ...base, ...ends, flip: !!f.opposite, keepOpposite: end === 'blind', offsetOn: start !== 0, offset: start !== 0 ? str(start) : base.offset };
  }
  const said = f.app?.dialog;
  if (said) {
    const v = { ...base, ...said };
    const e = extent(v);
    if (bare(e.start) === bare(start) && bare(e.length) === bare(f.length)) return v;
  }
  if (start === 0) return base;
  if (typeof start === 'number' && typeof f.length === 'number') {
    if (Math.abs(start + f.length) < 1e-9) return { ...base, flip: true };
    if (Math.abs(start * 2 + f.length) < 1e-9) return { ...base, symmetric: true };
  } else {
    const s = bare(start), l = bare(f.length);
    if (s === `-${l}`) return { ...base, flip: true };
    if (s === `-${l}/2`) return { ...base, symmetric: true };
  }
  return { ...base, offsetOn: true, offset: str(start) };
}

const edgeList = (edges: any): any[] => (edges && typeof edges === 'object' && Array.isArray(edges.any) ? edges.any : edges ? [edges] : []);
const edgeField = (edges: any[]) => (edges.length === 1 ? edges[0] : { any: edges });

/** A revolve's axis: the sketch's own axes, the old way round its normal, or one of its lines, which it then follows. */
export const AXIS_CHOICES = { y: 'y_axis', x: 'x_axis', normal: 'normal' } as const;
export function axisJson(sketchId: number, choice: string, custom?: unknown): unknown | null | undefined {
  if (choice === 'y_axis') return { point: [0, 0], direction: [0, 1] };
  if (choice === 'x_axis') return { point: [0, 0], direction: [1, 0] };
  if (choice === 'normal') return undefined;
  if (choice === 'custom') return custom ?? null;
  const m = /^line:(\d+)$/.exec(choice);
  const line = m ? sketchLines(sketchId).find((l) => l.id === Number(m[1])) : null;
  if (!line) return null;
  return { point: line.start, direction: [line.end[0] - line.start[0], line.end[1] - line.start[1]] };
}

/** Whether two axes are one line, which needs the same direction either way and a point of one on the other. */
function sameAxis(a: any, b: any) {
  if (!a || !b) return false;
  const [ax, ay] = a.direction, [bx, by] = b.direction;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return false;
  if (Math.abs(ax * by - ay * bx) / (la * lb) > 1e-9) return false;
  const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1];
  return Math.abs(dx * ay - dy * ax) / la < 1e-6;
}

function readAxis(f: any): { axis: string; customAxis?: unknown } {
  if (!f.axis) return { axis: 'normal' };
  const said = f.app?.axis;
  if (typeof said === 'string' && /^line:\d+$/.test(said) && axisJson(f.sketch, said) !== null) return { axis: said };
  for (const choice of ['y_axis', 'x_axis']) if (sameAxis(f.axis, axisJson(f.sketch, choice))) return { axis: choice };
  const line = sketchLines(f.sketch).find((l) => sameAxis(f.axis, axisJson(f.sketch, `line:${l.id}`)));
  return line ? { axis: `line:${line.id}` } : { axis: 'custom', customAxis: f.axis };
}

/** One step of a sweep's path, as the dialog edits it. */
export interface PathStep { kind: 'line' | 'bend'; length: string; radius: string; degrees: string; toward: string }
export const newStep = (kind: PathStep['kind']): PathStep => ({ kind, length: '30', radius: '20', degrees: '90', toward: '0' });
const stepJson = (s: PathStep) => (s.kind === 'line' ? { line: num(s.length) } : { arc_radius: num(s.radius), degrees: num(s.degrees), toward_degrees: num(s.toward) });
const readStep = (s: any): PathStep => ('line' in s ? { ...newStep('line'), length: str(s.line) } : { ...newStep('bend'), radius: str(s.arc_radius), degrees: str(s.degrees), toward: str(s.toward_degrees ?? 0) });

const readOther = (f: any, ...keys: string[]) => {
  const out = { ...(f.app ?? {}) };
  for (const k of keys) delete out[k];
  return out;
};

const PLANE_OPTIONS = [{ value: 'z', label: 'Top' }, { value: 'y', label: 'Front' }, { value: 'x', label: 'Right' }];

export const DEFS: FeatureDef[] = [
  solidDef('box', 'Box', [dim('dx', 'Width'), dim('dy', 'Depth'), dim('dz', 'Height')], { dx: '40', dy: '30', dz: '20' }),
  solidDef('cylinder', 'Cylinder', [dim('radius', 'Radius'), dim('height', 'Height')], { radius: '15', height: '30' }),
  solidDef('cone', 'Cone', [dim('r0', 'Base radius'), dim('r1', 'Top radius'), dim('height', 'Height')], { r0: '15', r1: '5', height: '30' }),
  solidDef('sphere', 'Sphere', [dim('radius', 'Radius')], { radius: '15' }),
  solidDef('torus', 'Torus', [dim('major', 'Ring radius'), dim('minor', 'Tube radius')], { major: '20', minor: '5' }),
  {
    id: 'extrude',
    title: 'Extrude',
    icon: 'extrude',
    namePrefix: 'Extrude',
    fields: [
      CREATION,
      MODE,
      { key: 'regions', label: 'Sketch regions to extrude', kind: 'regions' },
      {
        key: 'end',
        label: 'End type',
        kind: 'select',
        options: END_TYPES.map((o) => ({ ...o, disabled: o.value === 'blind' ? undefined : surface })),
        flip: { key: 'flip', label: 'Flip direction', disabled: (v) => blind(v) && !!v.symmetric },
      },
      { key: 'endFace', label: 'Up to face', kind: 'face', when: (v) => endType(v) === 'up_to_face' },
      { key: 'endPart', label: 'Up to part', kind: 'part', when: (v) => endType(v) === 'up_to_part' },
      { key: 'endVertex', label: 'Up to vertex', kind: 'vertex', when: (v) => endType(v) === 'up_to_vertex' },
      { ...dim('length', 'Depth'), when: blind },
      { key: 'symmetric', label: 'Symmetric', kind: 'check', when: blind },
      { key: 'offsetOn', label: 'Starting offset', kind: 'group', checkable: true, fields: [{ ...dim('offset', 'Offset'), scrub: 0.5 }] },
      { key: 'secondOn', label: 'Second end position', kind: 'group', checkable: true, when: blind, disabled: (v) => !!v.symmetric, fields: [dim('second', 'Depth')] },
    ],
    defaults: () => ({ sketch: null, regions: [], length: '20', mode: 'add', body: 'solid', ...EXTRUDE_OPTIONS }),
    missing(v) {
      if (!regionsChosen(v)) return 'Click regions in the view';
      if (endJson(v) === null) return `Click ${endType(v) === 'up_to_vertex' ? 'near the end of an edge' : 'a face'} to stop at`;
      return null;
    },
    make(v) {
      if (this.missing!(v)) return null;
      const out: any = { type: 'extrude', ...regionsJson(v), mode: modeOf(v) };
      const offset = v.offsetOn ? num(v.offset) : 0;
      if (!blind(v)) Object.assign(out, { start: offset, length: num(v.length), end: endJson(v), opposite: !!v.flip });
      // A feature from a file or an AI can be flipped the kernel's way, which names its end faces the other way round.
      else if (v.keepOpposite && v.flip && !v.symmetric && !v.secondOn) Object.assign(out, { start: offset, length: num(v.length), opposite: true });
      else Object.assign(out, extent(v));
      const dialog = { length: v.length, flip: !!v.flip, symmetric: !!v.symmetric, offsetOn: !!v.offsetOn, offset: v.offset, secondOn: !!v.secondOn, second: v.second };
      out.app = { ...v.otherApp, dialog };
      return out;
    },
    read(f) {
      return { ...readRegions(f), ...readMode(f), otherApp: readOther(f, 'dialog'), ...readExtent(f) };
    },
  },
  {
    id: 'revolve',
    title: 'Revolve',
    icon: 'revolve',
    namePrefix: 'Revolve',
    fields: [
      CREATION,
      MODE,
      { key: 'sketch', label: 'Sketch', kind: 'sketch' },
      { key: 'axis', label: 'Revolve axis', kind: 'axis', hint: 'Click a line of the sketch, or choose one.' },
      angle('degrees', 'Angle'),
    ],
    defaults: () => ({ sketch: lastSketchId(), axis: AXIS_CHOICES.y, degrees: '360', mode: 'add', body: 'solid' }),
    missing: (v) => (v.sketch === null || v.sketch === undefined ? 'Choose a sketch' : axisJson(Number(v.sketch), v.axis, v.customAxis) === null ? 'Choose an axis' : null),
    make(v) {
      if (this.missing!(v)) return null;
      const axis = axisJson(Number(v.sketch), v.axis, v.customAxis);
      return { type: 'revolve', sketch: Number(v.sketch), degrees: num(v.degrees), mode: modeOf(v), ...(axis ? { axis } : {}), app: { ...v.otherApp, axis: v.axis } };
    },
    read: (f) => ({ sketch: f.sketch, degrees: str(f.degrees ?? 360), ...readMode(f), ...readAxis(f), otherApp: readOther(f, 'axis') }),
  },
  {
    id: 'sweep',
    title: 'Sweep',
    icon: 'sweep',
    namePrefix: 'Sweep',
    fields: [
      CREATION,
      MODE,
      { key: 'sketch', label: 'Profile', kind: 'sketch' },
      { key: 'path', label: 'Path', kind: 'steps', hint: 'The path starts at the sketch, heading straight out of it, and each step carries on from the last.' },
    ],
    defaults: () => ({ sketch: lastSketchId(), path: [newStep('line'), newStep('bend')], mode: 'add', body: 'solid' }),
    missing: (v) => (v.sketch === null || v.sketch === undefined ? 'Choose a sketch' : !v.path?.length ? 'Add a step to the path' : null),
    make(v) {
      if (this.missing!(v)) return null;
      return { type: 'sweep', sketch: Number(v.sketch), path: (v.path as PathStep[]).map(stepJson), mode: modeOf(v) };
    },
    read: (f) => ({ sketch: f.sketch, path: (f.path ?? []).map(readStep), ...readMode(f) }),
  },
  {
    id: 'helix',
    title: 'Helix',
    icon: 'helix',
    namePrefix: 'Helix',
    fields: [
      CREATION,
      MODE,
      { key: 'sketch', label: 'Profile', kind: 'sketch', hint: 'Sweeps the sketch around the axis, like a spring or a thread.' },
      AXIS_FIELD('axis', 'Axis'),
      dim('pitch', 'Pitch'),
      { key: 'turns', label: 'Turns', kind: 'expr', scrub: 0.25 },
      { key: 'left', label: 'Left-handed', kind: 'check' },
      { key: 'moved', label: 'Axis position', kind: 'group', fields: [dim('px', 'X'), dim('py', 'Y'), dim('pz', 'Z')] },
    ],
    defaults: () => ({ sketch: lastSketchId(), axis: 'z', pitch: '10', turns: '4', left: false, px: '0', py: '0', pz: '0', mode: 'add', body: 'solid' }),
    missing: (v) => (v.sketch === null || v.sketch === undefined ? 'Choose a sketch' : null),
    make(v) {
      if (this.missing!(v)) return null;
      const at = point(v, ['px', 'py', 'pz']);
      return { type: 'helix', sketch: Number(v.sketch), pitch: num(v.pitch), turns: num(v.turns), axis: AXES[v.axis as AxisName], ...(isOrigin(at) ? {} : { point: at }), left_handed: !!v.left, mode: modeOf(v) };
    },
    read: (f) => ({
      sketch: f.sketch, axis: axisName(f.axis), pitch: str(f.pitch), turns: str(f.turns), left: !!f.left_handed,
      px: str(f.point?.[0] ?? 0), py: str(f.point?.[1] ?? 0), pz: str(f.point?.[2] ?? 0), ...readMode(f),
    }),
  },
  {
    id: 'fillet',
    title: 'Fillet',
    icon: 'fillet',
    namePrefix: 'Fillet',
    needsBody: true,
    fields: [
      { key: 'edges', label: 'Edges to fillet', kind: 'edges' },
      { ...dim('radius', 'Radius'), when: (v) => !v.variable },
      { key: 'variable', label: 'Variable radius', kind: 'group', checkable: true, fields: [dim('r0', 'Radius at start'), dim('r1', 'Radius at end')] },
    ],
    defaults: () => ({ edges: [], radius: '3', variable: false, r0: '2', r1: '5' }),
    missing: (v) => (v.edges.length ? null : 'Click edges in the view'),
    make(v) {
      if (!v.edges.length) return null;
      if (!v.variable) return { type: 'fillet', edges: edgeField(v.edges), radius: num(v.radius) };
      return { type: 'fillet_radii', sets: [{ edges: edgeField(v.edges), along: [{ at: 0, radius: num(v.r0) }, { at: 1, radius: num(v.r1) }] }] };
    },
    read(f) {
      if (f.type !== 'fillet_radii') return { edges: edgeList(f.edges), radius: str(f.radius), variable: false, r0: '2', r1: '5' };
      const set = f.sets[0];
      const along = set.along ?? [{ radius: set.radius }, { radius: set.radius }];
      return { edges: edgeList(set.edges), radius: str(along[0].radius), variable: !!set.along, r0: str(along[0].radius), r1: str(along[along.length - 1].radius) };
    },
  },
  {
    id: 'chamfer',
    title: 'Chamfer',
    icon: 'chamfer',
    namePrefix: 'Chamfer',
    needsBody: true,
    fields: [
      { key: 'edges', label: 'Edges to chamfer', kind: 'edges' },
      dim('distance', 'Distance'),
    ],
    defaults: () => ({ edges: [], distance: '2' }),
    missing: (v) => (v.edges.length ? null : 'Click edges in the view'),
    make: (v) => (v.edges.length ? { type: 'chamfer', edges: edgeField(v.edges), distance: num(v.distance) } : null),
    read: (f) => ({ edges: edgeList(f.edges), distance: str(f.distance) }),
  },
  {
    id: 'shell',
    title: 'Shell',
    icon: 'shell',
    namePrefix: 'Shell',
    needsBody: true,
    fields: [
      { key: 'open', label: 'Faces to open', kind: 'faces' },
      dim('thickness', 'Wall'),
    ],
    defaults: () => ({ open: [], thickness: '2' }),
    make: (v) => ({ type: 'shell', open: v.open, thickness: num(v.thickness) }),
    read: (f) => ({ open: f.open ?? [], thickness: str(f.thickness) }),
  },
  {
    id: 'loft',
    title: 'Loft',
    icon: 'loft',
    namePrefix: 'Loft',
    fields: [
      CREATION,
      MODE,
      { key: 'sections', label: 'Sketches', kind: 'sketches', hint: 'Tick them in the order the loft passes through. Each holds one outline.' },
    ],
    defaults: () => ({ sections: [], mode: 'add', body: 'solid' }),
    missing: (v) => (v.sections.length >= 2 ? null : 'Tick two sketches or more'),
    make: (v) => (v.sections.length >= 2 ? { type: 'loft', sections: v.sections, mode: modeOf(v) } : null),
    read: (f) => ({ sections: f.sections ?? [], ...readMode(f) }),
  },
  {
    id: 'draft',
    title: 'Draft',
    icon: 'draft',
    namePrefix: 'Draft',
    needsBody: true,
    fields: [
      { key: 'faces', label: 'Faces to draft', kind: 'faces' },
      { key: 'degrees', label: 'Angle', kind: 'expr', unit: '°', scrub: 0.5 },
      AXIS_FIELD('pull', 'Pull'),
    ],
    defaults: () => ({ faces: [], degrees: '3', pull: 'z' }),
    missing: (v) => (v.faces.length ? null : 'Click faces in the view'),
    make: (v) => (v.faces.length ? { type: 'draft', faces: v.faces, degrees: num(v.degrees), pull: AXES[v.pull as AxisName] } : null),
    read: (f) => ({ faces: f.faces ?? [], degrees: str(f.degrees), pull: axisName(f.pull) }),
  },
  {
    id: 'offset',
    title: 'Offset',
    icon: 'offset',
    namePrefix: 'Offset',
    fields: [{ key: 'distance', label: 'Distance', kind: 'expr', unit: 'mm', scrub: 0.1, hint: 'Every face moves out, or in if negative.' }],
    defaults: () => ({ distance: '1' }),
    make: (v) => ({ type: 'offset', distance: num(v.distance) }),
    read: (f) => ({ distance: str(f.distance) }),
  },
  {
    id: 'thicken',
    title: 'Thicken',
    icon: 'thicken',
    namePrefix: 'Thicken',
    needsBody: true,
    fields: [MODE, { key: 'faces', label: 'Faces to thicken', kind: 'faces' }, dim('thickness', 'Thickness')],
    defaults: () => ({ faces: [], thickness: '2', mode: 'add' }),
    missing: (v) => (v.faces.length ? null : 'Click faces in the view'),
    make: (v) => (v.faces.length ? { type: 'thicken', faces: v.faces, thickness: num(v.thickness), mode: v.mode } : null),
    read: (f) => ({ faces: f.faces ?? [], thickness: str(f.thickness), mode: f.mode ?? 'add' }),
  },
  {
    id: 'delete-face',
    title: 'Delete face',
    icon: 'delete-face',
    namePrefix: 'Delete face',
    needsBody: true,
    fields: [{ key: 'faces', label: 'Faces to delete', kind: 'faces', hint: 'The faces around them grow to close the gap.' }],
    defaults: () => ({ faces: [] }),
    missing: (v) => (v.faces.length ? null : 'Click faces in the view'),
    make: (v) => (v.faces.length ? { type: 'delete_face', faces: v.faces } : null),
    read: (f) => ({ faces: f.faces ?? [] }),
  },
  {
    id: 'mirror',
    title: 'Mirror',
    icon: 'mirror',
    namePrefix: 'Mirror',
    fields: [{ key: 'plane', label: 'Across', kind: 'segment', options: PLANE_OPTIONS }],
    defaults: () => ({ plane: 'x' }),
    make: (v) => ({ type: 'mirror', normal: AXES[v.plane as AxisName] }),
    read: (f) => ({ plane: axisName(f.normal) }),
  },
  {
    id: 'pattern-linear',
    title: 'Linear pattern',
    icon: 'pattern-linear',
    namePrefix: 'Pattern',
    fields: [AXIS_FIELD('direction', 'Direction'), { key: 'count', label: 'Count', kind: 'expr', scrub: 1 }, dim('spacing', 'Spacing')],
    defaults: () => ({ direction: 'x', count: '3', spacing: '40' }),
    make: (v) => ({ type: 'pattern', direction: AXES[v.direction as AxisName], count: num(v.count), spacing: num(v.spacing) }),
    read: (f) => ({ direction: axisName(f.direction), count: str(f.count), spacing: str(f.spacing) }),
  },
  {
    id: 'pattern-circular',
    title: 'Circular pattern',
    icon: 'pattern-circular',
    namePrefix: 'Pattern',
    fields: [AXIS_FIELD('axis', 'Around'), { key: 'count', label: 'Count', kind: 'expr', scrub: 1 }, { key: 'degrees', label: 'Angle', kind: 'expr', unit: '°', scrub: 5 }],
    defaults: () => ({ axis: 'z', count: '4', degrees: '360' }),
    make: (v) => ({ type: 'pattern', axis: AXES[v.axis as AxisName], count: num(v.count), degrees: num(v.degrees) }),
    read: (f) => ({ axis: axisName(f.axis), count: str(f.count), degrees: str(f.degrees ?? 360) }),
  },
  {
    id: 'transform',
    title: 'Transform',
    icon: 'transform',
    namePrefix: 'Transform',
    needsBody: true,
    fields: [
      { key: 'bodies', label: 'Parts to transform', kind: 'parts' },
      {
        key: 'motion',
        label: 'Type',
        kind: 'select',
        options: [
          { value: 'translate', label: 'Translate by XYZ' },
          { value: 'rotate', label: 'Rotate' },
          { value: 'frames', label: 'From one place to another', disabled: () => true },
        ],
      },
      { ...dim('dx', 'X'), when: (v) => v.motion === 'translate' },
      { ...dim('dy', 'Y'), when: (v) => v.motion === 'translate' },
      { ...dim('dz', 'Z'), when: (v) => v.motion === 'translate' },
      { ...AXIS_FIELD('axis', 'Axis'), when: (v) => v.motion === 'rotate' },
      { ...angle('degrees', 'Angle'), when: (v) => v.motion === 'rotate' },
      { key: 'moved', label: 'Axis position', kind: 'group', when: (v) => v.motion === 'rotate', fields: [dim('px', 'X'), dim('py', 'Y'), dim('pz', 'Z')] },
      { key: 'copy', label: 'Copy part', kind: 'check' },
    ],
    defaults: () => ({ bodies: [], motion: 'translate', dx: '0', dy: '0', dz: '20', axis: 'z', degrees: '90', px: '0', py: '0', pz: '0', copy: false }),
    missing: (v) => (v.bodies.length ? null : 'Click parts in the view'),
    make(v) {
      if (!v.bodies.length) return null;
      const motion = v.motion === 'frames' ? v.frames
        : v.motion === 'rotate' ? { type: 'rotate', point: point(v, ['px', 'py', 'pz']), axis: AXES[v.axis as AxisName], degrees: num(v.degrees) }
        : { type: 'translate', by: point(v, ['dx', 'dy', 'dz']) };
      return { type: 'transform', bodies: v.bodies, motion, copy: !!v.copy };
    },
    read(f) {
      const m = f.motion ?? {};
      const v: Values = { bodies: f.bodies ?? [], motion: m.type ?? 'translate', copy: !!f.copy, dx: '0', dy: '0', dz: '0', axis: 'z', degrees: '90', px: '0', py: '0', pz: '0' };
      if (m.type === 'translate') Object.assign(v, { dx: str(m.by[0]), dy: str(m.by[1]), dz: str(m.by[2]) });
      if (m.type === 'rotate') Object.assign(v, { axis: axisName(m.axis), degrees: str(m.degrees), px: str(m.point?.[0] ?? 0), py: str(m.point?.[1] ?? 0), pz: str(m.point?.[2] ?? 0) });
      if (m.type === 'frames') v.frames = m;
      return v;
    },
  },
  {
    id: 'boolean',
    title: 'Boolean',
    icon: 'boolean',
    namePrefix: 'Boolean',
    needsBody: true,
    fields: [
      { key: 'operation', label: 'Operation', kind: 'tabs', options: [{ value: 'union', label: 'Union' }, { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' }] },
      { key: 'tools', label: 'Tools', kind: 'parts' },
      { key: 'targets', label: 'Targets', kind: 'parts', when: (v) => v.operation === 'subtract' },
      { key: 'keep', label: 'Keep tools', kind: 'check' },
    ],
    defaults: () => ({ operation: 'union', tools: [], targets: [], keep: false }),
    missing(v) {
      if (v.operation !== 'subtract') return v.tools.length >= 2 ? null : 'Click two parts or more';
      return !v.tools.length ? 'Click the parts to cut with' : !v.targets.length ? 'Click the parts to cut' : null;
    },
    make(v) {
      if (this.missing!(v)) return null;
      const keep = !!v.keep;
      if (v.operation === 'subtract') return { type: 'boolean', operation: 'subtract', bodies: v.targets, tools: v.tools, keep_tools: keep };
      return { type: 'boolean', operation: v.operation, bodies: v.tools.slice(0, 1), tools: v.tools.slice(1), keep_tools: keep };
    },
    read(f) {
      const subtract = f.operation === 'subtract';
      return { operation: f.operation, tools: subtract ? f.tools ?? [] : [...(f.bodies ?? []), ...(f.tools ?? [])], targets: subtract ? f.bodies ?? [] : [], keep: !!f.keep_tools };
    },
  },
  {
    id: 'delete-bodies',
    title: 'Delete part',
    icon: 'delete-part',
    namePrefix: 'Delete part',
    needsBody: true,
    fields: [{ key: 'bodies', label: 'Parts to delete', kind: 'parts' }],
    defaults: () => ({ bodies: [] }),
    missing: (v) => (v.bodies.length ? null : 'Click parts in the view'),
    make: (v) => (v.bodies.length ? { type: 'delete_bodies', bodies: v.bodies } : null),
    read: (f) => ({ bodies: f.bodies ?? [] }),
  },
  {
    id: 'fill',
    title: 'Fill',
    icon: 'fill',
    namePrefix: 'Fill',
    fields: [{ key: 'sketch', label: 'Sketch', kind: 'sketch', hint: 'A flat surface in each closed area of the sketch.' }],
    defaults: () => ({ sketch: lastSketchId() }),
    missing: (v) => (v.sketch === null || v.sketch === undefined ? 'Choose a sketch' : null),
    make: (v) => (v.sketch === null || v.sketch === undefined ? null : { type: 'fill', sketch: Number(v.sketch) }),
    read: (f) => ({ sketch: f.sketch }),
  },
  {
    id: 'copy-faces',
    title: 'Copy faces',
    icon: 'copy-faces',
    namePrefix: 'Copy faces',
    needsBody: true,
    fields: [{ key: 'faces', label: 'Faces to copy', kind: 'faces', hint: 'They become a surface of their own. The part stays as it is.' }],
    defaults: () => ({ faces: [] }),
    missing: (v) => (v.faces.length ? null : 'Click faces in the view'),
    make: (v) => (v.faces.length ? { type: 'copy_faces', faces: v.faces } : null),
    read: (f) => ({ faces: f.faces ?? [] }),
  },
  {
    id: 'sew',
    title: 'Sew',
    icon: 'sew',
    namePrefix: 'Sew',
    needsBody: true,
    fields: [
      { key: 'bodies', label: 'Surfaces to sew', kind: 'parts', hint: 'None picked means every surface. If nothing is left open, they become a solid.' },
      { key: 'tolOn', label: 'Tolerance', kind: 'group', checkable: true, fields: [{ ...dim('tolerance', 'Gap'), scrub: 0.001 }] },
    ],
    defaults: () => ({ bodies: [], tolOn: false, tolerance: '0.01' }),
    make: (v) => ({ type: 'sew', ...(v.bodies.length ? { bodies: v.bodies } : {}), ...(v.tolOn ? { tolerance: num(v.tolerance) } : {}) }),
    read: (f) => ({ bodies: f.bodies ?? [], tolOn: f.tolerance !== undefined, tolerance: str(f.tolerance ?? '0.01') }),
  },
  {
    id: 'trim',
    title: 'Trim surface',
    icon: 'trim-surface',
    namePrefix: 'Trim',
    needsBody: true,
    fields: [
      { key: 'bodies', label: 'Surfaces to trim', kind: 'parts', hint: 'None picked means every surface.' },
      { key: 'by', label: 'Trim with', kind: 'select', options: [{ value: 'part', label: 'A part' }, { value: 'plane', label: 'A plane' }, { value: 'sketch', label: 'A sketch' }] },
      { key: 'tool', label: 'Part', kind: 'part', when: (v) => v.by === 'part' },
      { key: 'plane', label: 'Plane', kind: 'segment', options: PLANE_OPTIONS, when: (v) => v.by === 'plane' },
      { ...dim('at', 'Offset'), when: (v) => v.by === 'plane' },
      { key: 'sketch', label: 'Sketch', kind: 'sketch', when: (v) => v.by === 'sketch', hint: 'Cuts straight through along the sketch’s normal.' },
      { key: 'keep', label: 'Keep', kind: 'segment', options: [{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }, { value: 'both', label: 'Both' }] },
    ],
    defaults: () => ({ bodies: [], by: 'plane', tool: null, plane: 'z', at: '0', sketch: lastSketchId(), keep: 'outside' }),
    missing: (v) => (v.by === 'part' && !v.tool ? 'Click the part to trim with' : v.by === 'sketch' && (v.sketch === null || v.sketch === undefined) ? 'Choose a sketch' : null),
    make(v) {
      if (this.missing!(v)) return null;
      const out: any = { type: 'trim', keep: v.keep, ...(v.bodies.length ? { bodies: v.bodies } : {}) };
      if (v.by === 'part') out.tool = v.tool;
      else if (v.by === 'sketch') out.sketch = Number(v.sketch);
      else {
        const n = AXES[v.plane as AxisName];
        const at = num(v.at);
        out.point = n.map((c) => (c === 0 ? 0 : typeof at === 'number' ? at : at));
        out.normal = n;
      }
      return out;
    },
    read(f) {
      const by = f.tool ? 'part' : f.sketch !== undefined ? 'sketch' : 'plane';
      const plane = axisName(f.normal);
      const at = f.point ? f.point[{ x: 0, y: 1, z: 2 }[plane]] : 0;
      return { bodies: f.bodies ?? [], by, tool: f.tool ?? null, plane, at: str(at), sketch: f.sketch ?? lastSketchId(), keep: f.keep ?? 'outside' };
    },
  },
];

export const defById = (id: string) => DEFS.find((d) => d.id === id);

/** The dialog for a feature in the history, if it has one. */
export function defForFeature(f: any): FeatureDef | undefined {
  if (f.type === 'solid') return defById(f.shape);
  if (f.type === 'pattern') return defById(f.direction ? 'pattern-linear' : 'pattern-circular');
  if (f.type === 'delete_face') return defById('delete-face');
  if (f.type === 'delete_bodies') return defById('delete-bodies');
  if (f.type === 'copy_faces') return defById('copy-faces');
  // Only what the Fillet dialog writes: one set of edges, at one radius or going from one to another.
  if (f.type === 'fillet_radii') return f.sets?.length === 1 && (!f.sets[0].along || f.sets[0].along.length === 2) ? defById('fillet') : undefined;
  if (f.type === 'transform' && f.motion?.type === 'frames') return undefined;
  if (f.type === 'revolve' && readAxis(f).axis === 'custom') return defById('revolve');
  return defById(f.type);
}
