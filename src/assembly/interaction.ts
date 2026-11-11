import { setHoverText, toast } from '../store/ui';
import { view } from '../viewport/instance';
import { add, cross, dot, normalize, quatAxis, quatMul, quatNormalize, quatRotate, scale, sub, type V3 } from '../viewport/math';
import type { MenuItem } from '../ui/ContextMenu';
import { edgeSpots, faceSpots, type Spot } from './connectors';
import type { InstanceData } from './model';
import {
  acceptMate, applyDrag, asm, cancelMate, deleteInstances, deleteMate, dragSnapshot, finishDrag, instanceById, instanceName, isDraggable, mateDraft, mateFailures, ownerOfHit,
  partOf, pickConnector, selectedInstances, selectedMate, selectInstances, setFixed, setHidden, setInsertOpen, insertOpen, setRenamingInstance,
} from './store';
import { adjustedFrame, apply, type DragGoal, type Frame } from './solver';

const ARROW = 62, ARC = 40, GRAB = 7;
const AXIS_COLOR = ['#D64B3A', '#2B9A4C', '#3566D6'];
const LIT = '#D97E00';
const INK = '#1C2227';
const FAILED = '#B5321A';

const cam = () => view.renderer!.camera;
const invalidate = () => view.renderer?.invalidate();

type Handle = { kind: 'move' | 'turn'; axis: number };
let hovered: Handle | null = null;

/** The manipulator, on a single selected part that can move. */
function triad() {
  const ids = selectedInstances();
  if (ids.length !== 1 || mateDraft()) return null;
  const inst = instanceById(ids[0]);
  if (!inst || inst.hidden || inst.fixed) return null;
  const part = partOf(inst);
  if (!part) return null;
  const axes: V3[] = [quatRotate(inst.pose.q, [1, 0, 0]), quatRotate(inst.pose.q, [0, 1, 0]), quatRotate(inst.pose.q, [0, 0, 1])];
  return { inst, part, center: apply(inst.pose, part.center), axes };
}

function distToSegment(px: number, py: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l)) : 0;
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}

function arcPoints(t: NonNullable<ReturnType<typeof triad>>, axis: number) {
  const k = cam().worldPerPixel * ARC;
  const u = t.axes[(axis + 1) % 3], v = t.axes[(axis + 2) % 3];
  const out: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 2);
    out.push(cam().project(add(t.center, add(scale(u, k * Math.cos(a)), scale(v, k * Math.sin(a))))));
  }
  return out;
}

function handleAt(x: number, y: number): Handle | null {
  const t = triad();
  if (!t) return null;
  const c = cam().project(t.center);
  const k = cam().worldPerPixel * ARROW;
  let best: Handle | null = null, bestD = GRAB;
  for (let axis = 0; axis < 3; axis++) {
    const d = distToSegment(x, y, c, cam().project(add(t.center, scale(t.axes[axis], k))));
    if (d < bestD) {
      bestD = d;
      best = { kind: 'move', axis };
    }
    const arc = arcPoints(t, axis);
    for (let i = 0; i + 1 < arc.length; i++) {
      const e = distToSegment(x, y, arc[i], arc[i + 1]);
      if (e < bestD) {
        bestD = e;
        best = { kind: 'turn', axis };
      }
    }
  }
  return best;
}

// Dragging

type Drag =
  | { kind: 'free'; id: string; local: V3; world: V3; x: number; y: number; moved: boolean; before: string; shift: boolean; warned: boolean }
  | { kind: 'move'; id: string; axis: V3; center: V3; localCenter: V3; x: number; y: number; moved: boolean; before: string }
  | { kind: 'turn'; id: string; axis: V3; center: V3; start: number; q: InstanceData['pose']['q']; p: V3; localCenter: V3; moved: boolean; before: string };

let drag: Drag | null = null;
let pending: DragGoal | null = null;
let queued = false;

function flush() {
  queued = false;
  if (!pending) return;
  const goal = pending;
  pending = null;
  applyDrag(goal);
}

function queue(goal: DragGoal) {
  pending = goal;
  if (queued) return;
  queued = true;
  requestAnimationFrame(flush);
}

/** A left press in an assembly. A manipulator's handle or a part takes it, and empty space leaves it to the selection box. */
export function asmDown(renderer: { pick(x: number, y: number): { kind: string; id: number } | null }, x: number, y: number, shift: boolean) {
  if (mateDraft()) return false;
  const handle = handleAt(x, y);
  const t = triad();
  if (handle && t) {
    const axis = t.axes[handle.axis];
    if (handle.kind === 'move') drag = { kind: 'move', id: t.inst.id, axis, center: t.center, localCenter: t.part.center, x, y, moved: false, before: dragSnapshot() };
    else {
      const c = cam().project(t.center);
      drag = { kind: 'turn', id: t.inst.id, axis, center: t.center, start: Math.atan2(y - c[1], x - c[0]), q: t.inst.pose.q, p: t.inst.pose.p, localCenter: t.part.center, moved: false, before: dragSnapshot() };
    }
    return true;
  }
  const owner = ownerOfHit(renderer.pick(x, y));
  if (!owner) return false;
  const center = apply(owner.instance.pose, owner.part.center);
  const world = cam().onPlane(x, y, center, cam().back()) ?? center;
  const q = owner.instance.pose.q;
  const local = quatRotate([-q[0], -q[1], -q[2], q[3]], sub(world, owner.instance.pose.p));
  drag = { kind: 'free', id: owner.instance.id, local, world, x, y, moved: false, before: dragSnapshot(), shift, warned: false };
  return true;
}

export function asmMove(x: number, y: number) {
  if (!drag) return;
  if (drag.kind === 'free') {
    if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < 4) return;
    drag.moved = true;
    if (!isDraggable(drag.id)) {
      const i = instanceById(drag.id);
      if (i && !drag.warned && i.fixed) toast(`${instanceName(i)} is fixed. Right-click it to unfix it.`);
      drag.warned = true;
      return;
    }
    const target = cam().onPlane(x, y, drag.world, cam().back());
    if (target) queue({ kind: 'point', body: drag.id, local: drag.local, target });
    return;
  }
  if (drag.kind === 'move') {
    const c = cam().project(drag.center);
    const k = cam().worldPerPixel * ARROW;
    const tip = cam().project(add(drag.center, scale(drag.axis, k)));
    const s: [number, number] = [tip[0] - c[0], tip[1] - c[1]];
    const l = s[0] * s[0] + s[1] * s[1];
    if (l < 4) return;
    drag.moved = true;
    const along = (((x - drag.x) * s[0] + (y - drag.y) * s[1]) / l) * k;
    queue({ kind: 'point', body: drag.id, local: drag.localCenter, target: add(drag.center, scale(drag.axis, along)) });
    return;
  }
  const c = cam().project(drag.center);
  const a = Math.atan2(y - c[1], x - c[0]);
  // The screen's Y runs down, so a turn that looks clockwise is positive here, and negative about an axis facing you.
  const facing = dot(drag.axis, cam().back()) >= 0 ? 1 : -1;
  const angle = -(a - drag.start) * facing;
  drag.moved = true;
  const q = quatNormalize(quatMul(quatAxis(normalize(drag.axis), angle), drag.q));
  queue({ kind: 'pose', body: drag.id, pose: { q, p: sub(drag.center, quatRotate(q, drag.localCenter)) } });
}

/** The end of a press that an assembly took. Without any movement, it's a click. */
export function asmUp(x: number, y: number, shift: boolean, hit: { kind: string; id: number } | null) {
  if (!drag) return;
  const d = drag;
  drag = null;
  flush();
  if (d.moved) finishDrag(d.before);
  else if (d.kind === 'free') asmClick(hit, x, y, shift);
}

// Picking

let spots: { instance: string; list: Spot[]; label: string } | null = null;
let nearest: Spot | null = null;
let shiftHeld = false;
export const noteAsmShift = (held: boolean) => { shiftHeld = held; };

const spotScreen = (instance: string, s: Spot) => {
  const i = instanceById(instance);
  return i ? cam().project(apply(i.pose, s.frame.o)) : ([0, 0] as [number, number]);
};

function closest(x: number, y: number) {
  if (!spots) return null;
  let best: Spot | null = null, bestD = Infinity;
  for (const s of spots.list) {
    const [sx, sy] = spotScreen(spots.instance, s);
    const d = Math.hypot(sx - x, sy - y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** What the pointer's over, with no button down. With a mate open it offers connectors. Shift keeps it on the same face or edge. */
export function asmHover(hit: { kind: string; id: number } | null, x: number, y: number) {
  const owner = ownerOfHit(hit);
  if (mateDraft()) {
    if (!shiftHeld || !spots) {
      spots = owner ? { instance: owner.instance.id, list: hit!.kind === 'face' ? faceSpots(owner.part, owner.local) : edgeSpots(owner.part, owner.local), label: instanceName(owner.instance) } : null;
    }
    const next = closest(x, y);
    if (next !== nearest || spots) {
      nearest = next;
      invalidate();
    }
    setHoverText(spots ? `${spots.label}  ${spots.list.length ? 'Click to use this connector. Hold Shift to stay on this face or edge.' : ''}` : '');
    return;
  }
  spots = null;
  nearest = null;
  const handle = handleAt(x, y);
  if (handle?.kind !== hovered?.kind || handle?.axis !== hovered?.axis) {
    hovered = handle;
    invalidate();
  }
  if (handle) setHoverText(handle.kind === 'move' ? 'Drag to move along this axis' : 'Drag to turn about this axis');
  else setHoverText(owner ? `${instanceName(owner.instance)}${owner.instance.fixed ? '  Fixed' : ''}` : '');
}

export function asmClick(hit: { kind: string; id: number } | null, x: number, y: number, shift: boolean) {
  const owner = ownerOfHit(hit);
  if (mateDraft()) {
    if (!owner) return;
    if (!spots || spots.instance !== owner.instance.id) spots = { instance: owner.instance.id, list: hit!.kind === 'face' ? faceSpots(owner.part, owner.local) : edgeSpots(owner.part, owner.local), label: instanceName(owner.instance) };
    const s = closest(x, y);
    if (!s) return;
    pickConnector({ instance: spots.instance, connector: { kind: s.kind, ref: s.ref, how: s.how, frame: s.frame } });
    invalidate();
    return;
  }
  if (!owner) {
    if (!shift) selectInstances([]);
    return;
  }
  const id = owner.instance.id;
  const cur = selectedInstances();
  if (shift) selectInstances(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  else selectInstances([id]);
}

/** Selects whichever parts are all inside a dragged box. */
export function asmBox(found: { faces: number[]; edges: number[] } | null, adding: boolean) {
  if (mateDraft() || !found) return;
  const counts = new Map<string, { n: number; total: number }>();
  for (const f of found.faces) {
    const o = ownerOfHit({ kind: 'face', id: f });
    if (!o) continue;
    const c = counts.get(o.instance.id) ?? { n: 0, total: o.part.faces.length };
    c.n++;
    counts.set(o.instance.id, c);
  }
  const whole = [...counts].filter(([, c]) => c.n >= c.total).map(([id]) => id);
  selectInstances(adding ? [...new Set([...selectedInstances(), ...whole])] : whole);
}

export function asmMenu(hit: { kind: string; id: number } | null, fit: MenuItem, iso: MenuItem): (MenuItem | null)[] {
  if (mateDraft()) return [fit];
  const owner = ownerOfHit(hit);
  if (!owner) return [fit, iso];
  const i = owner.instance;
  if (!selectedInstances().includes(i.id)) selectInstances([i.id]);
  return [
    { label: i.fixed ? 'Unfix' : 'Fix', run: () => setFixed(i.id, !i.fixed) },
    { label: 'Hide', run: () => setHidden(i.id, true) },
    { label: 'Rename', run: () => setRenamingInstance(i.id) },
    null,
    fit,
    null,
    { label: 'Delete', keys: 'Delete', danger: true, run: () => deleteInstances([i.id]) },
  ];
}

/** Keys an assembly answers for itself. True if it did. */
export function asmKey(key: string) {
  if (key === 'escape') {
    if (mateDraft()) cancelMate();
    else if (insertOpen()) setInsertOpen(false);
    else selectInstances([]);
    return true;
  }
  if (key === 'enter' && mateDraft()) {
    acceptMate();
    return true;
  }
  if ((key === 'delete' || key === 'backspace') && selectedInstances().length) {
    deleteInstances(selectedInstances());
    return true;
  }
  const mate = selectedMate();
  if ((key === 'delete' || key === 'backspace') && mate) {
    deleteMate(mate);
    return true;
  }
  return false;
}

export function asmHint() {
  const draft = mateDraft();
  if (draft) {
    if (!draft.first) return 'Hover a face or edge and click a connector for the part that moves. Right drag rotates.';
    if (!draft.second) return 'Click a connector on the part it goes to. Hold Shift to stay on one face or edge.';
    return 'Flip or turn it if it’s the wrong way round, then press Enter. Right drag rotates.';
  }
  if (!asm().instances.length) return 'Press I to insert a part from a Part Studio. Right drag rotates, middle drag pans.';
  return 'Click a part to select it, drag to move it. Right drag rotates, middle drag pans. M starts a mate.';
}

// Drawing

function drawFrame(ctx: CanvasRenderingContext2D, o: V3, f: Frame, pose: InstanceData['pose'], lit: boolean, big = 16) {
  const k = cam().worldPerPixel * big;
  const c = cam().project(o);
  const x = quatRotate(pose.q, f.x), z = quatRotate(pose.q, f.z), y = cross(z, x);
  [x, y, z].forEach((axis, n) => {
    const tip = cam().project(add(o, scale(axis, k)));
    ctx.strokeStyle = AXIS_COLOR[n];
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(c[0], c[1]);
    ctx.lineTo(tip[0], tip[1]);
    ctx.stroke();
  });
  ctx.fillStyle = lit ? LIT : '#fff';
  ctx.strokeStyle = lit ? LIT : INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c[0], c[1], 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawConnectors(ctx: CanvasRenderingContext2D) {
  const draft = mateDraft();
  if (!draft) return;
  if (spots) {
    const i = instanceById(spots.instance);
    if (i) {
      for (const s of spots.list) {
        if (s === nearest) continue;
        const [x, y] = cam().project(apply(i.pose, s.frame.o));
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (nearest) drawFrame(ctx, apply(i.pose, nearest.frame.o), nearest.frame, i.pose, true);
    }
  }
  for (const picked of [draft.first, draft.second]) {
    if (!picked) continue;
    const i = instanceById(picked.instance);
    if (i) drawFrame(ctx, apply(i.pose, picked.connector.frame.o), picked === draft.second ? adjustedFrame(picked.connector.frame, draft.flip, draft.quarter) : picked.connector.frame, i.pose, true, 22);
  }
}

/** A mate's mark in the view, where its connectors meet: red if it failed and grey if it's suppressed, as in Onshape. */
function drawMates(ctx: CanvasRenderingContext2D) {
  const failures = mateFailures();
  const chosen = selectedMate();
  const editing = mateDraft()?.id;
  for (const m of asm().mates) {
    if (m.id === editing) continue;
    const a = instanceById(m.a), b = instanceById(m.b);
    if (!a || !b || a.hidden || b.hidden) continue;
    const [x, y] = cam().project(apply(a.pose, m.ca.frame.o));
    const color = m.id === chosen ? LIT : failures.has(m.id) ? FAILED : m.suppressed ? '#A5ACB2' : INK;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawTriad(ctx: CanvasRenderingContext2D) {
  const t = triad();
  if (!t) return;
  const active = drag && drag.kind !== 'free' && drag.id === t.inst.id ? drag : null;
  const c = cam().project(t.center);
  const k = cam().worldPerPixel * ARROW;
  const isOn = (kind: Handle['kind'], axis: number) => (hovered?.kind === kind && hovered.axis === axis) || (active?.kind === kind && Math.abs(dot(active.axis, t.axes[axis])) > 0.999);
  for (let axis = 0; axis < 3; axis++) {
    ctx.strokeStyle = isOn('turn', axis) ? LIT : AXIS_COLOR[axis];
    ctx.lineWidth = isOn('turn', axis) ? 2.25 : 1.25;
    ctx.beginPath();
    arcPoints(t, axis).forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  }
  for (let axis = 0; axis < 3; axis++) {
    const tip = cam().project(add(t.center, scale(t.axes[axis], k)));
    const on = isOn('move', axis);
    const color = on ? LIT : AXIS_COLOR[axis];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = on ? 2.25 : 1.5;
    ctx.beginPath();
    ctx.moveTo(c[0], c[1]);
    ctx.lineTo(tip[0], tip[1]);
    ctx.stroke();
    const dx = tip[0] - c[0], dy = tip[1] - c[1], l = Math.hypot(dx, dy);
    if (l > 8) {
      const ux = dx / l, uy = dy / l;
      ctx.beginPath();
      ctx.moveTo(tip[0] + ux * 7, tip[1] + uy * 7);
      ctx.lineTo(tip[0] - uy * 3.5, tip[1] + ux * 3.5);
      ctx.lineTo(tip[0] + uy * 3.5, tip[1] - ux * 3.5);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c[0], c[1], 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawAssemblyOverlay(ctx: CanvasRenderingContext2D) {
  drawMates(ctx);
  drawTriad(ctx);
  drawConnectors(ctx);
}

