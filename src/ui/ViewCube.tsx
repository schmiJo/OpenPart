import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { command, setView, setViewDirection } from '../commands';
import { mesh } from '../store/doc';
import { VIEWS } from '../viewport/camera';
import { FONT } from '../viewport/font';
import { view } from '../viewport/instance';
import { dot, normalize, quatAxis, quatMul, quatNormalize, type V3 } from '../viewport/math';
import { closeOnEscape } from './ContextMenu';
import { Icon } from './icons';

const SIZE = 136;
const C = SIZE / 2;
const S = 22;
/** How far the flat of a face reaches before the chamfer starts. */
const A = 0.84;
const AXIS_LEN = 2.15;

interface Poly { id: string; normal: V3; pts: V3[]; face?: string; tip: string }

const FACE_NAMES: Record<string, string> = { '0,1': 'right', '0,-1': 'left', '1,1': 'back', '1,-1': 'front', '2,1': 'top', '2,-1': 'bottom' };
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** A block with its edges and corners chamfered: 6 faces, 12 edges and 8 corners, each its own click target. */
function buildPolys(): Poly[] {
  const out: Poly[] = [];
  const at = (i: number, vi: number, j: number, vj: number, k: number, vk: number): V3 => {
    const p: V3 = [0, 0, 0];
    p[i] = vi; p[j] = vj; p[k] = vk;
    return p;
  };
  for (const i of [0, 1, 2]) {
    const j = (i + 1) % 3, k = (i + 2) % 3;
    for (const s of [1, -1]) {
      const name = FACE_NAMES[`${i},${s}`];
      const n: V3 = [0, 0, 0];
      n[i] = s;
      out.push({ id: name, face: name, normal: n, tip: `${cap(name)} view`, pts: [at(i, s, j, -A, k, -A), at(i, s, j, A, k, -A), at(i, s, j, A, k, A), at(i, s, j, -A, k, A)] });
    }
  }
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]]) {
    for (const si of [1, -1]) {
      for (const sj of [1, -1]) {
        const n: V3 = [0, 0, 0];
        n[i] = si; n[j] = sj;
        out.push({
          id: `edge ${i}${si} ${j}${sj}`,
          normal: normalize(n),
          tip: `${cap(FACE_NAMES[`${i},${si}`])} and ${FACE_NAMES[`${j},${sj}`]} corner view`,
          pts: [at(i, si, j, sj * A, k, -A), at(i, si, j, sj * A, k, A), at(i, si * A, j, sj, k, A), at(i, si * A, j, sj, k, -A)],
        });
      }
    }
  }
  for (const x of [1, -1]) {
    for (const y of [1, -1]) {
      for (const z of [1, -1]) {
        out.push({
          id: `corner ${x} ${y} ${z}`,
          normal: normalize([x, y, z]),
          tip: 'Isometric view from this corner',
          pts: [[x, y * A, z * A], [x * A, y, z * A], [x * A, y * A, z]],
        });
      }
    }
  }
  return out;
}

const POLYS = buildPolys();

interface Arrow { id: string; x: number; y: number; angle: number; axis: V3; sign: number; tip: string }
const R = 63;
const STEP_TIP = 'Hold Shift for 90°.';
const ARROWS: Arrow[] = [
  { id: 'arrow-up', x: C, y: C - R, angle: -Math.PI / 2, axis: [1, 0, 0], sign: -1, tip: `Rotate up 15°. ${STEP_TIP}` },
  { id: 'arrow-down', x: C, y: C + R, angle: Math.PI / 2, axis: [1, 0, 0], sign: 1, tip: `Rotate down 15°. ${STEP_TIP}` },
  { id: 'arrow-left', x: C - R, y: C, angle: Math.PI, axis: [0, 1, 0], sign: -1, tip: `Rotate left 15°. ${STEP_TIP}` },
  { id: 'arrow-right', x: C + R, y: C, angle: 0, axis: [0, 1, 0], sign: 1, tip: `Rotate right 15°. ${STEP_TIP}` },
];
const ARC_R = 52;
const ROLLS = [
  { id: 'roll-left', from: -Math.PI / 2 - 0.34, to: -Math.PI / 2 - 1.02, sign: 1, tip: `Roll left 15°. ${STEP_TIP}` },
  { id: 'roll-right', from: -Math.PI / 2 + 0.34, to: -Math.PI / 2 + 1.02, sign: -1, tip: `Roll right 15°. ${STEP_TIP}` },
];
const AXES: { label: string; dir: V3; color: string }[] = [
  { label: 'X', dir: [1, 0, 0], color: '#D64B3A' },
  { label: 'Y', dir: [0, 1, 0], color: '#2B9A4C' },
  { label: 'Z', dir: [0, 0, 1], color: '#3566D6' },
];
const VIEW_ITEMS = ['view.iso', 'view.top', 'view.front', 'view.right', 'view.back', 'view.left', 'view.bottom', 'fit'];

function inPolygon(x: number, y: number, pts: [number, number][]) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign !== 0 && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
  }
  return true;
}

export function ViewCube(props: { onEnter?: () => void }) {
  let canvas!: HTMLCanvasElement;
  let menuButton!: HTMLButtonElement;
  let hover: string | null = null;
  let drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null);
  closeOnEscape(() => !!menuAt(), () => setMenuAt(null));

  const basis = () => {
    const cam = view.renderer!.camera;
    return { r: cam.right(), u: cam.up(), b: cam.back() };
  };

  const visible = () => {
    const { b } = basis();
    return POLYS.filter((p) => dot(p.normal, b) > 0.015);
  };

  const hit = (x: number, y: number): { id: string; tip: string } | null => {
    const { r, u } = basis();
    const flat = (p: V3): [number, number] => [C + S * dot(p, r), C - S * dot(p, u)];
    const shown = visible();
    // Corners and edges are thin on screen, so they get targets wider than they look, ahead of the faces.
    for (const p of shown) {
      if (p.pts.length !== 3) continue;
      const pts = p.pts.map(flat);
      if (Math.hypot(x - (pts[0][0] + pts[1][0] + pts[2][0]) / 3, y - (pts[0][1] + pts[1][1] + pts[2][1]) / 3) < 5.5) return p;
    }
    for (const p of shown) {
      if (p.face || p.pts.length !== 4) continue;
      const pts = p.pts.map(flat);
      const ax = (pts[0][0] + pts[3][0]) / 2, ay = (pts[0][1] + pts[3][1]) / 2, bx = (pts[1][0] + pts[2][0]) / 2, by = (pts[1][1] + pts[2][1]) / 2;
      const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
      const t = l > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
      if (Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) < 3.5) return p;
    }
    for (const p of shown) if (p.face && inPolygon(x, y, p.pts.map(flat))) return p;
    for (const a of ARROWS) if (Math.hypot(x - a.x, y - a.y) < 8) return a;
    const dist = Math.hypot(x - C, y - C), angle = Math.atan2(y - C, x - C);
    if (Math.abs(dist - ARC_R) < 6) {
      for (const roll of ROLLS) {
        const lo = Math.min(roll.from, roll.to), hi = Math.max(roll.from, roll.to);
        if (angle >= lo - 0.1 && angle <= hi + 0.1) return roll;
      }
    }
    return null;
  };

  const draw = () => {
    if (!view.renderer) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const d = view.renderer.dpr;
    if (canvas.width !== SIZE * d) {
      canvas.width = SIZE * d;
      canvas.height = SIZE * d;
    }
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    const { r, u, b } = basis();
    const flat = (p: V3): [number, number] => [C + S * dot(p, r), C - S * dot(p, u)];
    const light = normalize([0.35, 0.6, 0.72]);

    const drawAxis = (a: (typeof AXES)[number]) => {
      const color = a.color;
      const [ax, ay] = flat([0, 0, 0]);
      const [bx, by] = flat([a.dir[0] * AXIS_LEN, a.dir[1] * AXIS_LEN, a.dir[2] * AXIS_LEN]);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 4) return;
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      ctx.beginPath();
      ctx.moveTo(bx + dx * 4, by + dy * 4);
      ctx.lineTo(bx - dy * 2, by + dx * 2);
      ctx.lineTo(bx + dy * 2, by - dx * 2);
      ctx.closePath();
      ctx.fill();
      ctx.font = `500 10px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.label, bx + dx * 9.5, by + dy * 9.5);
    };
    // All three come out from behind the block, so the faces and their names stay clear.
    for (const a of AXES) drawAxis(a);

    for (const p of visible()) {
      const on = hover === p.id;
      const facing = Math.max(0, dot(p.normal, r) * light[0] + dot(p.normal, u) * light[1] + dot(p.normal, b) * light[2]);
      const tone = 0.93 + 0.07 * facing;
      const bevel = p.face ? 1 : 0.965;
      if (on) ctx.fillStyle = 'rgba(255,190,80,.55)';
      else ctx.fillStyle = `rgba(${Math.round(250 * tone * bevel)},${Math.round(251 * tone * bevel)},${Math.round(252 * tone * bevel)},.88)`;
      ctx.strokeStyle = 'rgba(120,132,144,.42)';
      ctx.lineWidth = 0.75;
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      p.pts.forEach((q, i) => {
        const [x, y] = flat(q);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Each face's name lies in the face, reading the way that view reads.
    for (const p of visible()) {
      if (!p.face) continue;
      const v = VIEWS[p.face];
      const tilt = dot(p.normal, b);
      if (tilt < 0.12) continue;
      const fontPx = 40;
      ctx.font = `400 ${fontPx}px ${FONT}`;
      const width = ctx.measureText(cap(p.face)).width;
      const k = Math.min((A * 1.7) / width, 0.46 / fontPx);
      const ex: [number, number] = [dot(v.right, r) * S * k, -dot(v.right, u) * S * k];
      const ey: [number, number] = [-dot(v.up, r) * S * k, dot(v.up, u) * S * k];
      const [cx, cy] = flat(p.normal);
      ctx.setTransform(d * ex[0], d * ex[1], d * ey[0], d * ey[1], d * cx, d * cy);
      ctx.fillStyle = hover === p.id ? '#15181B' : '#59636C';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(cap(p.face), 0, 0);
    }
    ctx.setTransform(d, 0, 0, d, 0, 0);

    const quiet = 'rgba(120,134,148,.62)';
    const lit = '#B86E00';
    ctx.lineWidth = 1.1;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    for (const a of ARROWS) {
      ctx.strokeStyle = hover === a.id ? lit : quiet;
      const c = Math.cos(a.angle), s = Math.sin(a.angle);
      ctx.beginPath();
      ctx.moveTo(a.x - s * 4 - c * 2, a.y + c * 4 - s * 2);
      ctx.lineTo(a.x + c * 2, a.y + s * 2);
      ctx.lineTo(a.x + s * 4 - c * 2, a.y - c * 4 - s * 2);
      ctx.stroke();
    }
    for (const roll of ROLLS) {
      ctx.strokeStyle = hover === roll.id ? lit : quiet;
      ctx.beginPath();
      ctx.arc(C, C, ARC_R, roll.from, roll.to, roll.to < roll.from);
      ctx.stroke();
      const tx = C + Math.cos(roll.to) * ARC_R, ty = C + Math.sin(roll.to) * ARC_R;
      const dir = roll.to < roll.from ? -1 : 1;
      const hx = -Math.sin(roll.to) * dir, hy = Math.cos(roll.to) * dir;
      const nx = Math.cos(roll.to), ny = Math.sin(roll.to);
      ctx.beginPath();
      ctx.moveTo(tx - hx * 4 + nx * 3.5, ty - hy * 4 + ny * 3.5);
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - hx * 4 - nx * 3.5, ty - hy * 4 - ny * 3.5);
      ctx.stroke();
    }
  };

  const spin = (axis: V3, sign: number, big: boolean) => {
    const cam = view.renderer!.camera;
    const angle = (sign * (big ? 90 : 15) * Math.PI) / 180;
    cam.animateTo({ rot: quatNormalize(quatMul(cam.goalRot(), quatAxis(axis, angle))) }, big ? 320 : 180);
    view.renderer!.invalidate();
  };

  const activate = (id: string, shift: boolean) => {
    const poly = POLYS.find((p) => p.id === id);
    if (poly) {
      if (poly.face) setView(poly.face);
      else setViewDirection(poly.normal);
      return;
    }
    const arrow = ARROWS.find((a) => a.id === id);
    if (arrow) return spin(arrow.axis, arrow.sign, shift);
    const roll = ROLLS.find((x) => x.id === id);
    if (roll) spin([0, 0, 1], roll.sign, shift);
  };

  const rel = (e: PointerEvent) => {
    const b = canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top] as [number, number];
  };

  const setHover = (h: { id: string; tip: string } | null) => {
    const id = h?.id ?? null;
    if (id === hover) return;
    hover = id;
    canvas.title = h?.tip ?? '';
    canvas.style.cursor = h ? 'pointer' : '';
    draw();
  };

  onMount(() => {
    view.redrawCube = draw;
    onCleanup(() => {
      view.redrawCube = () => {};
    });
    draw();
    void document.fonts?.ready.then(draw);
  });
  return (
    <div class="cube-wrap" onPointerDown={(e) => e.stopPropagation()} onPointerMove={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
      <canvas
        ref={canvas}
        class="cube-canvas"
        data-testid="view-cube"
        role="img"
        aria-label="View cube. The views are also listed in the menu beside it."
        onPointerEnter={() => props.onEnter?.()}
        onPointerDown={(e) => {
          e.preventDefault();
          canvas.setPointerCapture(e.pointerId);
          const [x, y] = rel(e);
          drag = { x, y, px: x, py: y, moved: false };
        }}
        onPointerMove={(e) => {
          const [x, y] = rel(e);
          if (!drag) return setHover(hit(x, y));
          if (Math.hypot(x - drag.x, y - drag.y) > 3) drag.moved = true;
          if (drag.moved && view.renderer) {
            const m = mesh();
            const center: V3 = m && m.indices.length ? [(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2, (m.min[2] + m.max[2]) / 2] : [0, 0, 0];
            view.renderer.camera.orbit(x - drag.px, y - drag.py, center);
            view.renderer.invalidate();
          }
          drag.px = x;
          drag.py = y;
        }}
        onPointerUp={(e) => {
          const d = drag;
          drag = null;
          if (d && !d.moved && e.button === 0) {
            const [x, y] = rel(e);
            const h = hit(x, y);
            if (h) activate(h.id, e.shiftKey);
          }
        }}
        onPointerLeave={() => setHover(null)}
      />
      <button
        ref={menuButton}
        class="view-menu-button"
        aria-haspopup="menu"
        aria-expanded={!!menuAt()}
        aria-label="Views"
        data-tip="Views"
        data-testid="view-menu"
        onClick={() => {
          const b = menuButton.getBoundingClientRect();
          setMenuAt(menuAt() ? null : { x: b.right - 190, y: b.bottom + 4 });
        }}
      >
        <Icon name="iso" size={15} />
        <Icon name="caret" size={10} />
      </button>
      <Show when={menuAt()}>
        {(at) => (
          <>
            <div class="menu-scrim" onPointerDown={() => setMenuAt(null)} />
            <div class="menu" role="menu" style={{ left: `${at().x}px`, top: `${at().y}px` }}>
              <For each={VIEW_ITEMS.map(command)}>
                {(c) => (
                  <button role="menuitem" onClick={() => { setMenuAt(null); void c.run(); }} data-command={c.id}>
                    {c.title}
                    <Show when={c.keys}><kbd>{c.keys}</kbd></Show>
                  </button>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
