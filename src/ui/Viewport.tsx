import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { fitView, setView } from '../commands';
import { activeDef, addPicks, addRegions, applyPickMask, canonical, pickAxisLine, pickBase, pickKey, pickKind, pickLimit, previewBase, showingFinal, startFeature, takesRegions, togglePick, toggleRegion, values } from '../features/dialog';
import { axisJson } from '../features/defs';
import { edgeWord, faceWord, fmtNum } from '../features/words';
import { cancelSketch, editSketch, finishSketch, looksAtSketch, normalTo, session, startSketch, visibleSketches } from '../sketch/controller';
import { PLANES, planeFromPlacement, planeOnFace, polyline, toWorld, type Plane, type V2 } from '../sketch/geometry';
import { drawSketch } from '../sketch/overlay';
import { sketchLines, type RegionPick, type SketchRegion } from '../sketch/regions';
import type { MeshData } from '../engine/client';
import { doc, edgeList, faceList, flushAutosave, mesh, sketchRegions, type EdgeInfo, type FaceInfo } from '../store/doc';
import { asmBox, asmClick, asmDown, asmHover, asmMenu, asmMove, asmUp, drawAssemblyOverlay, noteAsmShift } from '../assembly/interaction';
import { inAssembly } from '../store/tabs';
import { clearSelection, geometryHidden, glProblem, hiddenParts, hoverPlane, mode, selectedFeature, selectedGeometry, selectedRegions, selection, setGlProblem, setHiddenParts, setHoverPlane, setHoverText, setMode, setSelectedFeature, setSelectedGeometry, setSelectedPart, setSelectedRegions, setSelection, sketchesHidden, toggleGeometry, togglePlanes } from '../store/ui';
import { FONT } from '../viewport/font';
import { view } from '../viewport/instance';
import { Renderer, type PickHit } from '../viewport/renderer';
import { add, dot, normalize, scale, type V3 } from '../viewport/math';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ViewCube } from './ViewCube';


function describeFace(f?: FaceInfo) {
  return f ? `${faceWord(f.surface)}  ${f.name}  ${fmtNum(f.area)} mm²` : '';
}
function describeEdge(e?: EdgeInfo) {
  return e ? `${edgeWord(e.curve)}  ${e.name}  ${fmtNum(e.length)} mm` : '';
}

/** A closed area of a sketch on show, where it is in the view's list of them. */
interface ShownRegion { sketch: number; sketchName: string; plane: Plane; region: SketchRegion }
function describeRegion(r?: ShownRegion) {
  return r ? `Sketch region  ${r.sketchName}  ${fmtNum(r.region.area)} mm²` : '';
}

/**
 * A plane's name, lying in the plane at its corner, so it turns and scales with it. The view is orthographic, so
 * the plane maps to the screen by one affine transform. Seen from behind or upside down it flips to stay readable.
 */
function drawPlaneLabel(ctx: CanvasRenderingContext2D, renderer: Renderer, name: string, plane: Plane, half: number) {
  const cam = renderer.camera;
  const r = cam.right(), u = cam.up();
  const pxPerMm = cam.height / (cam.halfH * 2);
  const heightMm = half * 0.06;
  if (heightMm * pxPerMm < 6) return;
  const flat = (v: V3): [number, number] => [dot(v, r) * pxPerMm, -dot(v, u) * pxPerMm];
  const fontPx = 40;
  const k = heightMm / fontPx;
  const neg = (v: V3): V3 => scale(v, -1);
  let across = plane.x;
  let down = neg(plane.y);
  const a0 = flat(across), d0 = flat(down);
  if (a0[0] * d0[1] - a0[1] * d0[0] < 0) down = plane.y;
  if (flat(across)[0] < 0) {
    across = neg(across);
    down = neg(down);
  }
  const pad = half * 0.04;
  const corner = add(add(plane.origin, scale(across, -(half - pad))), scale(down, -(half - pad)));
  const [sx, sy] = cam.project(corner);
  const ex = flat(across), ey = flat(down);
  // Painted on top of everything, so it only shows where it isn't lying across the part.
  const middle = (at: number) => [sx + (ex[0] * k * fontPx * at) + (ey[0] * k * fontPx) / 2, sy + (ex[1] * k * fontPx * at) + (ey[1] * k * fontPx) / 2];
  for (const at of [0, 1, 2]) {
    const [px, py] = middle(at);
    if (renderer.overModel(px, py)) return;
  }
  const d = renderer.dpr;
  ctx.setTransform(d * ex[0] * k, d * ex[1] * k, d * ey[0] * k, d * ey[1] * k, d * sx, d * sy);
  ctx.font = `400 ${fontPx}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#4A71A6';
  ctx.fillText(name, 0, 0);
}

/** The faces and edges entirely inside a screen rectangle. */
function withinBox(m: MeshData | null, renderer: Renderer, b: { x: number; y: number; w: number; h: number }) {
  if (!m || !m.indices.length) return null;
  const cam = renderer.camera;
  const r = cam.right(), u = cam.up(), t = cam.target;
  const k = cam.height / (cam.halfH * 2);
  const inside = (x: number, y: number, z: number) => {
    const dx = x - t[0], dy = y - t[1], dz = z - t[2];
    const sx = cam.width / 2 + (dx * r[0] + dy * r[1] + dz * r[2]) * k;
    const sy = cam.height / 2 - (dx * u[0] + dy * u[1] + dz * u[2]) * k;
    return sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h;
  };
  const faceOut = new Uint8Array(m.faces);
  for (let v = 0; v < m.faceIds.length; v++) {
    if (!inside(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2])) faceOut[m.faceIds[v]] = 1;
  }
  const edgeOut = new Uint8Array(m.edges);
  const edgeSeen = new Uint8Array(m.edges);
  for (let i = 0; i < m.segmentIds.length; i++) {
    const e = m.segmentIds[i], o = i * 6;
    edgeSeen[e] = 1;
    if (!inside(m.segments[o], m.segments[o + 1], m.segments[o + 2]) || !inside(m.segments[o + 3], m.segments[o + 4], m.segments[o + 5])) edgeOut[e] = 1;
  }
  const faces: number[] = [], edges: number[] = [];
  faceOut.forEach((out, i) => { if (!out) faces.push(i); });
  edgeOut.forEach((out, i) => { if (!out && edgeSeen[i]) edges.push(i); });
  return { faces, edges };
}

/** The first point on the model under a pixel, with the surface's normal there. The view is orthographic, so every ray runs the same way. */
function surfaceHit(m: MeshData | null, renderer: Renderer, x: number, y: number): { point: V3; normal: V3 } | null {
  if (!m || !m.indices.length) return null;
  const cam = renderer.camera;
  const o = cam.unproject(x, y), d = scale(cam.back(), -1);
  const p = m.positions, idx = m.indices, nor = m.normals;
  const hidden = new Set(hiddenPartFaces(m));
  let best = Infinity, bi = -1, bu = 0, bv = 0;
  for (let i = 0; i < idx.length; i += 3) {
    if (hidden.size && hidden.has(m.faceIds[idx[i]])) continue;
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
    const u = (tx * px + ty * py + tz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (t < best) {
      best = t;
      bi = i;
      bu = u;
      bv = v;
    }
  }
  if (bi < 0) return null;
  const w = 1 - bu - bv;
  const a = idx[bi] * 3, b = idx[bi + 1] * 3, c = idx[bi + 2] * 3;
  const normal = normalize([w * nor[a] + bu * nor[b] + bv * nor[c], w * nor[a + 1] + bu * nor[b + 1] + bv * nor[c + 1], w * nor[a + 2] + bu * nor[b + 2] + bv * nor[c + 2]]);
  return { point: add(o, scale(d, best)), normal };
}

const hiddenPartFaces = (m: MeshData) => [...hiddenParts()].flatMap((i) => m.parts[i]?.faces ?? []);

/** Where a rotation turns, the way Onshape picks it: the model under the cursor when the drag starts, or the model's center from empty space. */
function rotationPivot(m: MeshData | null, renderer: Renderer, x: number, y: number): V3 {
  if (!m || !m.indices.length) return [0, 0, 0];
  return surfaceHit(m, renderer, x, y)?.point ?? [(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2, (m.min[2] + m.max[2]) / 2];
}

function drawOrigin(ctx: CanvasRenderingContext2D, renderer: Renderer, selected: boolean) {
  const d = renderer.dpr;
  const [x, y] = renderer.camera.project([0, 0, 0]);
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.strokeStyle = selected ? '#D97E00' : '#1C2227';
  ctx.fillStyle = selected ? '#D97E00' : '#1C2227';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 1.2, 0, Math.PI * 2);
  ctx.fill();
}

function GlNotice(props: { problem: 'missing' | 'lost' }) {
  const inEditor = /\bCode\/\d|Electron/.test(navigator.userAgent);
  const [copied, setCopied] = createSignal(false);
  let address!: HTMLInputElement;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
    } catch {
      // Embedded previews often refuse the clipboard. Selecting it leaves Ctrl C one key away.
      address.focus();
      address.select();
    }
  };
  return (
    <div class="gl-notice" data-testid="gl-missing" onPointerDown={(e) => e.stopPropagation()}>
      <Show when={props.problem === 'missing'} fallback={<><h3>The graphics driver stopped responding</h3><p>Your part is saved. It comes back here as soon as the driver does.</p></>}>
        <h3>This window can’t draw 3D</h3>
        <p>{inEditor ? 'VS Code’s built-in preview has graphics turned off, so the model can’t be drawn here.' : 'This browser isn’t providing WebGL2, which schmishape needs to draw the model.'} Open this address in Chrome, Edge or Firefox instead:</p>
        <div class="gl-address">
          <input ref={address} readOnly value={location.href} aria-label="Address to open" onFocus={(e) => e.currentTarget.select()} />
          <button class="btn" onClick={copy}>{copied() ? 'Copied' : 'Copy'}</button>
          <a class="btn primary" href={location.href} target="_blank" rel="noopener">Open in browser</a>
        </div>
      </Show>
    </div>
  );
}

export function Viewport() {
  let host!: HTMLDivElement;
  let glCanvas!: HTMLCanvasElement;
  let overlay!: HTMLCanvasElement;
  let dimInput: HTMLInputElement | undefined;
  const [hoverHit, setHoverHit] = createSignal<PickHit | null>(null);
  /** The line of a revolve's sketch under the pointer, while the axis box takes clicks. */
  const [hoverLine, setHoverLine] = createSignal<number | null>(null);
  const [cursor, setCursor] = createSignal('');
  const [box, setBox] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);
  const [context, setContext] = createSignal<{ x: number; y: number; items: (MenuItem | null)[] } | null>(null);
  const [shownRegions, setShownRegions] = createSignal<ShownRegion[]>([]);
  let renderer!: Renderer;
  let labels: { name: string; plane: Plane; half: number }[] = [];
  let lastMesh: unknown = null;
  let hadSolid = false;
  let planeSize = 50;
  let partCount = 0;

  onMount(() => {
    try {
      renderer = new Renderer(glCanvas);
    } catch {
      setGlProblem('missing');
      return;
    }
    // A driver reset wipes everything on the GPU. Reloading rebuilds it all from the autosave.
    glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      flushAutosave();
      setGlProblem('lost');
    });
    glCanvas.addEventListener('webglcontextrestored', () => location.reload());
    view.renderer = renderer;
    view.redraw = () => {
      renderer.dirty = true;
    };
    const ctx = overlay.getContext('2d')!;
    // The overlay is only touched while it has something to show. Leaving a sketch resets it outright and
    // hides it, so a part can never show a leftover frame of a sketch on top of it.
    let painted = false;
    let wasSketching = false;
    renderer.afterRender = () => {
      const s = session();
      const origin = !geometryHidden().has('origin');
      if (wasSketching && !s) overlay.width = Math.round(renderer.camera.width * renderer.dpr);
      wasSketching = !!s;
      if (s || labels.length || origin || inAssembly()) {
        const d = renderer.dpr;
        overlay.style.display = '';
        ctx.setTransform(d, 0, 0, d, 0, 0);
        ctx.clearRect(0, 0, renderer.camera.width, renderer.camera.height);
        for (const l of labels) drawPlaneLabel(ctx, renderer, l.name, l.plane, l.half);
        if (s) {
          ctx.setTransform(d, 0, 0, d, 0, 0);
          drawSketch(ctx, s);
        } else if (origin) drawOrigin(ctx, renderer, selectedGeometry() === 'origin');
        if (inAssembly()) drawAssemblyOverlay(ctx);
        painted = true;
      } else if (painted) {
        overlay.width = Math.round(renderer.camera.width * renderer.dpr);
        overlay.style.display = 'none';
        painted = false;
      }
      view.redrawCube();
    };
    const fit = () => {
      const box = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.resize(box.width, box.height, dpr);
      overlay.width = Math.round(box.width * dpr);
      overlay.height = Math.round(box.height * dpr);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    fit();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = host.getBoundingClientRect();
      renderer.camera.zoomAt(Math.exp(e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)), e.clientX - b.left, e.clientY - b.top);
      renderer.invalidate();
    };
    host.addEventListener('wheel', wheel, { passive: false });
    onCleanup(() => {
      ro.disconnect();
      host.removeEventListener('wheel', wheel);
      renderer.dispose();
    });

    // The solid, and what's lit on it. One effect, so a new mesh never misses its highlights.
    createEffect(() => {
      const m = mesh();
      if (m !== lastMesh) {
        lastMesh = m;
        renderer.setMesh(m);
        const has = !!m && m.indices.length > 0;
        // Not while picking regions: fitting to the first one would push the others out of view.
        if (has && !hadSolid && !takesRegions()) fitView();
        // Rolling back to before the first solid hasn't lost it: coming forward again mustn't move the view.
        hadSolid = has || (hadSolid && doc.rollback !== null);
        // Part numbers go by position, so a change in how many there are makes old choices meaningless.
        if ((m?.parts.length ?? 0) !== partCount) {
          partCount = m?.parts.length ?? 0;
          setHiddenParts(new Set<number>());
          setSelectedPart(null);
        }
      }
      const sel = selection();
      const hit = hoverHit();
      const base = pickBase();
      const key = pickKey();
      const faces = new Map<number, number>();
      const edges = new Map<number, number>();
      if (base && key && pickKind() !== 'regions' && pickKind() !== 'axis') {
        const v = values[key];
        const list: any[] = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
        const kind = pickKind();
        if (kind === 'edges') {
          const chosen = new Set(list.map(canonical));
          base.edges.forEach((e, i) => {
            if (chosen.has(canonical(e.select))) edges.set(i, 2);
          });
        } else if (kind === 'part' || kind === 'parts') {
          for (const p of base.mesh.parts) if (list.includes(p.name)) p.faces.forEach((i) => faces.set(i, 2));
        } else if (kind === 'faces' || kind === 'face') {
          const names = new Set(list);
          base.faces.forEach((f, i) => {
            if (names.has(f.name) || names.has(f.key)) faces.set(i, 2);
          });
        }
      } else {
        sel.faces.forEach((i) => faces.set(i, 2));
        sel.edges.forEach((i) => edges.set(i, 2));
      }
      const hoverPart = base && hit?.kind === 'face' && (pickKind() === 'part' || pickKind() === 'parts') ? base.mesh.parts.find((p) => p.faces.includes(hit.id)) : null;
      if (hoverPart) hoverPart.faces.forEach((i) => { if (!faces.has(i)) faces.set(i, 1); });
      if (hit?.kind === 'face' && !faces.has(hit.id)) faces.set(hit.id, 1);
      if (hit?.kind === 'edge' && !edges.has(hit.id)) edges.set(hit.id, 1);
      const parts = m?.parts ?? [];
      const hidden = [...hiddenParts()].filter((i) => parts[i]);
      renderer.setStates(faces, edges, hidden.flatMap((i) => parts[i].faces), hidden.flatMap((i) => parts[i].edges));
    });

    createEffect(() => {
      const lit = hoverPlane();
      const chosen = selectedGeometry();
      const hidden = geometryHidden();
      const picking = mode() === 'pick-plane';
      const m = mesh();
      // Going back to an earlier step leaves the planes as they were, like the rest of the view.
      // And so does trying out regions, which would otherwise resize them with every click.
      if (doc.rollback === null && !takesRegions()) planeSize = m && m.indices.length ? Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]) * 0.8 : 50;
      const size = planeSize;
      const on = inAssembly() ? [] : PLANES.filter((p) => picking || lit === p.id || !hidden.has(p.id));
      renderer.setPlanes(on.map((p) => ({ id: p.id, origin: p.plane.origin, u: p.plane.x, v: p.plane.y, half: size, lit: lit === p.id || chosen === p.id })));
      labels = on.map((p) => ({ name: p.name, plane: p.plane, half: size }));
      renderer.pickMask = activeDef() ? renderer.pickMask : { faces: true, edges: !picking, planes: on.length > 0, regions: !picking };
      renderer.invalidate();
    });

    // While picking regions, an added feature's preview is glass over the model before it, so the sketch stays in sight.
    // A cut stays solid, because the hole is what you need to see, and Final shows the finished model as it is.
    createEffect(() => {
      renderer.ghostPreview = takesRegions() && !showingFinal() && values.body !== 'surface' && (values.mode === 'add' || values.mode === 'new_body');
      renderer.invalidate();
    });

    // Clicks go to whichever box in the dialog has the blue edge, so the view only offers what that box takes.
    createEffect(() => {
      activeDef();
      pickKind();
      applyPickMask();
    });

    createEffect(() => {
      const base = previewBase();
      renderer.setPreviewBase(base);
      const hidden = [...hiddenParts()];
      if (base) renderer.setPreviewBaseHidden(hidden.flatMap((i) => base.parts[i]?.faces ?? []), hidden.flatMap((i) => base.parts[i]?.edges ?? []));
    });

    // A used sketch stays on show while it's chosen in a dialog, or while one of its regions is selected.
    const alsoShown = (): (number | null | undefined)[] => (activeDef() ? [values.sketch, ...((values.regions ?? []) as RegionPick[]).map((p) => p.sketch)] : [selectedRegions()?.sketch]);

    // The closed areas of those sketches, shaded and pickable. A dialog can only use what comes before it.
    createEffect(() => {
      mesh();
      selectedFeature();
      sketchesHidden();
      const limit = takesRegions() ? pickLimit() : Infinity;
      const editing = session()?.featureId;
      const list: ShownRegion[] = [];
      const positions: number[] = [];
      const ids: number[] = [];
      for (const f of visibleSketches(alsoShown())) {
        if (f.id === editing || doc.features.findIndex((x) => x.id === f.id) >= limit) continue;
        const plane = planeFromPlacement(f.plane, doc.env);
        for (const region of sketchRegions().get(f.id) ?? []) {
          for (const i of region.triangles) {
            positions.push(...toWorld(plane, region.points[i]));
            ids.push(list.length);
          }
          list.push({ sketch: f.id, sketchName: f.name, plane, region });
        }
      }
      renderer.setRegions(new Float32Array(positions), new Uint32Array(ids));
      setShownRegions(list);
    });

    createEffect(() => {
      const list = shownRegions();
      const hit = hoverHit();
      const picks: RegionPick[] = takesRegions() ? (values.regions ?? []) : (() => { const s = selectedRegions(); return s ? s.ids.map((id) => ({ sketch: s.sketch, id })) : []; })();
      const states = new Map<number, number>();
      list.forEach((r, i) => {
        if (picks.some((p) => p.sketch === r.sketch && p.id === r.region.id)) states.set(i, 2);
      });
      if (hit?.kind === 'region' && !states.has(hit.id)) states.set(hit.id, 1);
      renderer.setRegionStates(states);
    });

    // Sketches not being edited, as lines in the part.
    createEffect(() => {
      mesh();
      selectedFeature();
      sketchesHidden();
      const seg: number[] = [];
      const editing = session()?.featureId;
      for (const f of visibleSketches(alsoShown())) {
        if (f.id === editing) continue;
        const plane = planeFromPlacement(f.plane, doc.env);
        for (const e of f.sketch?.entities ?? []) {
          const pts = polyline(e);
          for (let i = 0; i + 1 < pts.length; i++) {
            if (!e.construction) {
              seg.push(...toWorld(plane, pts[i]), ...toWorld(plane, pts[i + 1]));
              continue;
            }
            // Dotted, as in the sketch. The line shader draws solid lines, so the dots are short pieces of line.
            const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
            const dash = renderer.camera.worldPerPixel * 4, gap = renderer.camera.worldPerPixel * 3;
            for (let t = 0; t < len; t += dash + gap) {
              const at = (d: number): V2 => [pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * d) / len, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * d) / len];
              seg.push(...toWorld(plane, at(t)), ...toWorld(plane, at(Math.min(len, t + dash))));
            }
          }
        }
      }
      renderer.setSketchLines(new Float32Array(seg));
    });

    // A revolve's axis, drawn long and on top, and the sketch line under the pointer while the axis box takes clicks.
    createEffect(() => {
      const seg: number[] = [];
      const ids: number[] = [];
      const states = new Map<number, number>();
      const sketchId = values.sketch;
      const f = activeDef()?.id === 'revolve' && typeof sketchId === 'number' ? doc.features.find((x) => x.id === sketchId) : null;
      if (f) {
        sketchRegions();
        const plane = planeFromPlacement(f.plane, doc.env);
        const axis = axisJson(sketchId, values.axis, values.customAxis) as { point: V2; direction: V2 } | null | undefined;
        if (axis) {
          const m = mesh();
          const reach = m && m.indices.length ? Math.hypot(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]) : 100;
          const len = Math.hypot(axis.direction[0], axis.direction[1]) || 1;
          const d: V2 = [axis.direction[0] / len, axis.direction[1] / len];
          const at = (t: number): V2 => [axis.point[0] + d[0] * t, axis.point[1] + d[1] * t];
          seg.push(...toWorld(plane, at(-reach)), ...toWorld(plane, at(reach)));
          ids.push(0);
        }
        const hover = hoverLine();
        const line = hover !== null && pickKind() === 'axis' ? sketchLines(sketchId).find((l) => l.id === hover) : null;
        if (line && values.axis !== `line:${line.id}`) {
          seg.push(...toWorld(plane, line.start), ...toWorld(plane, line.end));
          ids.push(1);
          states.set(1, 1);
        }
      }
      renderer.setAxisLines(new Float32Array(seg), new Uint32Array(ids), states);
    });

    // Whatever the pointer rested on stops mattering once a sketch opens.
    createEffect(() => {
      if (session()) onLeave();
    });

    createEffect(() => {
      const e = session()?.editing[0]();
      if (e) queueMicrotask(() => { dimInput?.focus(); dimInput?.select(); });
    });
  });

  let drag: { button: number; x: number; y: number; px: number; py: number; moved: boolean; sketch: boolean; shift: boolean; ctrl: boolean; alt: boolean; pivot: V3; assembly?: boolean } | null = null;
  let hoverToken = 0;
  let hoverQueued: [number, number] | null = null;

  const rel = (e: PointerEvent | MouseEvent) => {
    const b = host.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top] as [number, number];
  };

  /** The line of the revolve's sketch nearest a point on screen, within a few pixels. */
  const lineAt = (x: number, y: number): number | null => {
    const sketchId = values.sketch;
    const f = typeof sketchId === 'number' ? doc.features.find((g) => g.id === sketchId) : null;
    if (!f) return null;
    const plane = planeFromPlacement(f.plane, doc.env);
    let best: number | null = null;
    let bestD = 7;
    for (const l of sketchLines(sketchId)) {
      const [ax, ay] = renderer.camera.project(toWorld(plane, l.start));
      const [bx, by] = renderer.camera.project(toWorld(plane, l.end));
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
      if (d < bestD) {
        bestD = d;
        best = l.id;
      }
    }
    return best;
  };

  const updateHover = () => {
    if (!hoverQueued) return;
    const [x, y] = hoverQueued;
    hoverQueued = null;
    if (pickKind() === 'axis') {
      const line = lineAt(x, y);
      setHoverLine(line);
      setHoverText(line !== null ? 'Line: click to turn around it' : '');
      return;
    }
    const hit = renderer.pick(x, y);
    if (inAssembly()) asmHover(hit, x, y);
    const old = hoverHit();
    if (old?.kind === hit?.kind && old?.id === hit?.id) return;
    setHoverHit(hit);
    setHoverPlane(hit?.kind === 'plane' ? hit.id : null);
    if (inAssembly()) return;
    const token = ++hoverToken;
    const base = pickBase();
    if (!hit) setHoverText('');
    else if (hit.kind === 'plane') setHoverText(`${PLANES[hit.id - 1]?.name ?? ''} plane`);
    else if (hit.kind === 'region') setHoverText(describeRegion(shownRegions()[hit.id]));
    else if (hit.kind === 'face') {
      if (base) setHoverText(describeFace(base.faces[hit.id]));
      else void faceList().then((l) => token === hoverToken && setHoverText(describeFace(l[hit.id])));
    } else if (base) setHoverText(describeEdge(base.edges[hit.id]));
    else void edgeList().then((l) => token === hoverToken && setHoverText(describeEdge(l[hit.id])));
  };

  const click = async (x: number, y: number, shift: boolean) => {
    const hit = renderer.pick(x, y);
    if (inAssembly()) return asmClick(hit, x, y, shift);
    // Waiting for a plane is the one time a click starts a sketch.
    if (mode() === 'pick-plane') {
      if (hit?.kind === 'plane') {
        setHoverPlane(null);
        setMode('part');
        startSketch(PLANES[hit.id - 1].plane);
      } else if (hit?.kind === 'face') {
        const on = await sketchPlaneAt(hit.id, x, y);
        setMode('part');
        if (on) startSketch(on);
      }
      return;
    }
    if (pickKind() === 'axis') {
      const line = lineAt(x, y);
      if (line !== null) pickAxisLine(line);
      return;
    }
    if (pickKind() === 'regions') {
      const r = hit?.kind === 'region' ? shownRegions()[hit.id] : null;
      if (r) toggleRegion(r.sketch, r.region.id);
      return;
    }
    if (activeDef()) {
      const base = pickBase();
      if (!hit || !base) return;
      // For a corner, whichever end of the edge is nearer the pointer.
      let end: 'start' | 'end' = 'start';
      if (hit.kind === 'edge' && pickKind() === 'vertex') {
        const e = base.edges[hit.id];
        if (e) {
          const [ax, ay] = renderer.camera.project(e.start);
          const [bx, by] = renderer.camera.project(e.end);
          end = Math.hypot(x - ax, y - ay) <= Math.hypot(x - bx, y - by) ? 'start' : 'end';
        }
      }
      togglePick(hit, end);
      return;
    }
    const cur = selection();
    if (!hit) {
      if (!shift) clearSelection();
      return;
    }
    if (hit.kind === 'plane') {
      clearSelection();
      setSelectedGeometry(hit.id);
      return;
    }
    if (hit.kind === 'region') {
      const r = shownRegions()[hit.id];
      if (r) selectRegion(r, shift);
      return;
    }
    const list = hit.kind === 'face' ? 'faces' : 'edges';
    setSelectedGeometry(null);
    setSelectedFeature(null);
    setSelectedPart(null);
    setSelectedRegions(null);
    if (shift) {
      const has = cur[list].includes(hit.id);
      setSelection({ ...cur, [list]: has ? cur[list].filter((i) => i !== hit.id) : [...cur[list], hit.id] });
    } else {
      setSelection({ faces: list === 'faces' ? [hit.id] : [], edges: list === 'edges' ? [hit.id] : [] });
    }
  };

  /** Selects a region. Shift adds to or drops from the ones already selected, as long as they're in the same sketch. */
  const selectRegion = (r: ShownRegion, adding: boolean) => {
    const cur = selectedRegions();
    const ids = adding && cur?.sketch === r.sketch ? cur.ids : [];
    const next = ids.includes(r.region.id) ? ids.filter((id) => id !== r.region.id) : [...ids, r.region.id];
    clearSelection();
    setSelectedRegions(next.length ? { sketch: r.sketch, ids: next } : null);
  };

  /** A sketch plane on a face: the face itself if it's flat, or the plane touching it under the cursor if it's curved. */
  const sketchPlaneAt = async (face: number, x: number, y: number): Promise<Plane | null> => {
    const f = (await faceList())[face];
    if (f?.surface === 'plane') return planeOnFace(f.center, f.normal);
    const under = surfaceHit(mesh(), renderer, x, y);
    return under ? planeOnFace(under.point, under.normal) : null;
  };

  const openContext = async (x: number, y: number, cx: number, cy: number) => {
    const fit = { label: 'Fit to window', keys: 'F', run: fitView };
    const iso = { label: 'Isometric view', keys: '0', run: () => setView('iso') };
    const s = session();
    if (s) {
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'Normal to sketch plane', keys: 'N', command: 'view.normal', run: looksAtSketch },
          fit,
          null,
          { label: 'Finish sketch', keys: 'Ctrl Enter', run: finishSketch },
          { label: 'Discard sketch', run: cancelSketch },
        ],
      });
      return;
    }
    if (activeDef()) return;
    const hit = renderer.pick(x, y);
    if (inAssembly()) return setContext({ x: cx, y: cy, items: asmMenu(hit, fit, iso) });
    if (hit?.kind === 'region') {
      const r = shownRegions()[hit.id];
      if (!r) return;
      // Right-clicking something already selected keeps the rest of the selection, as anywhere.
      if (selectedRegions()?.sketch !== r.sketch || !selectedRegions()?.ids.includes(r.region.id)) selectRegion(r, false);
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'Extrude', keys: 'Shift E', command: 'menu.extrude', run: () => startFeature('extrude') },
          { label: 'Edit sketch', run: () => editSketch(r.sketch) },
          null,
          { label: 'New sketch', keys: 'Shift S', command: 'menu.sketch', run: () => startSketch(r.plane) },
          { label: 'Normal to sketch plane', keys: 'N', run: () => normalTo(r.plane) },
          fit,
        ],
      });
    } else if (hit?.kind === 'plane') {
      const p = PLANES[hit.id - 1];
      clearSelection();
      setSelectedGeometry(hit.id);
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'New sketch', keys: 'Shift S', command: 'menu.sketch', run: () => startSketch(p.plane) },
          { label: 'Normal to plane', keys: 'N', run: () => normalTo(p.plane) },
          null,
          { label: 'Hide plane', run: () => toggleGeometry(p.id) },
          fit,
        ],
      });
    } else if (hit?.kind === 'face') {
      const plane = await sketchPlaneAt(hit.id, x, y);
      const flat = (await faceList())[hit.id]?.surface === 'plane';
      setSelectedGeometry(null);
      setSelection({ faces: [hit.id], edges: [] });
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: flat ? 'New sketch' : 'New sketch, touching here', keys: flat ? 'Shift S' : undefined, command: 'menu.sketch', disabled: !plane, run: () => startSketch(plane!) },
          { label: flat ? 'Normal to face' : 'Normal to surface here', keys: flat ? 'N' : undefined, disabled: !plane, run: () => normalTo(plane!) },
          null,
          { label: 'Shell', run: () => startFeature('shell') },
          fit,
        ],
      });
    } else if (hit?.kind === 'edge') {
      setSelectedGeometry(null);
      setSelection({ faces: [], edges: [hit.id] });
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'Fillet', keys: 'G', run: () => startFeature('fillet') },
          { label: 'Chamfer', run: () => startFeature('chamfer') },
          null,
          fit,
        ],
      });
    } else {
      setContext({ x: cx, y: cy, items: [fit, iso, null, { label: 'Show or hide planes', keys: 'P', run: togglePlanes }] });
    }
  };

  const onDown = (e: PointerEvent) => {
    if (glProblem() || session()?.editing[0]()) return;
    host.setPointerCapture(e.pointerId);
    const [x, y] = rel(e);
    const s = session();
    const sketch = !!s && e.button === 0;
    drag = { button: e.button, x, y, px: x, py: y, moved: false, sketch, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, pivot: e.button === 2 ? rotationPivot(mesh(), renderer, x, y) : renderer.camera.target };
    if (sketch) s!.pointerDown(x, y, e.shiftKey);
    if (inAssembly() && e.button === 0) drag.assembly = asmDown(renderer, x, y, e.shiftKey);
    e.preventDefault();
  };

  const onMove = (e: PointerEvent) => {
    if (glProblem()) return;
    const [x, y] = rel(e);
    const s = session();
    if (drag) {
      if (Math.hypot(x - drag.x, y - drag.y) > 3) drag.moved = true;
      const dx = x - drag.px, dy = y - drag.py;
      drag.px = x;
      drag.py = y;
      if (drag.assembly) return asmMove(x, y);
      if (drag.sketch) {
        s?.pointerMove(x, y, e.shiftKey);
        return;
      }
      if (!drag.moved) return;
      // Left selects, so its drag draws a box. Right drag rotates. Middle drag pans, and so does Ctrl with right.
      if (drag.button === 0) {
        if (mode() !== 'pick-plane') setBox({ x: Math.min(drag.x, x), y: Math.min(drag.y, y), w: Math.abs(x - drag.x), h: Math.abs(y - drag.y) });
        return;
      }
      if (drag.button === 1 || drag.ctrl) renderer.camera.pan(dx, dy);
      else renderer.camera.orbit(dx, dy, drag.pivot, drag.alt);
      renderer.invalidate();
      return;
    }
    if (s) {
      s.pointerMove(x, y, e.shiftKey);
      const tool = s.tool[0]();
      setCursor(tool === 'select' ? (s.hover ? 'pointer' : '') : 'crosshair');
      return;
    }
    setCursor('');
    noteAsmShift(e.shiftKey);
    const fresh = hoverQueued === null;
    hoverQueued = [x, y];
    if (fresh) requestAnimationFrame(updateHover);
  };

  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const [x, y] = rel(e);
    const d = drag;
    drag = null;
    if (d.assembly) asmUp(x, y, d.shift, renderer.pick(x, y));
    else if (d.sketch) session()?.pointerUp(x, y);
    else if (d.button === 2 && !d.moved) void openContext(x, y, e.clientX, e.clientY);
    else if (d.button === 0 && !session()) {
      const b = box();
      setBox(null);
      if (b) selectInBox(b, d.shift);
      else if (!d.moved) void click(x, y, d.shift);
    }
  };

  /** The regions whose whole outline is inside a screen rectangle. */
  const regionsInBox = (b: { x: number; y: number; w: number; h: number }) =>
    shownRegions().filter((r) => r.region.loops[0].every((p) => {
      const [sx, sy] = renderer.camera.project(toWorld(r.plane, p));
      return sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h;
    }));

  const selectInBox = (b: { x: number; y: number; w: number; h: number }, adding: boolean) => {
    if (inAssembly()) return asmBox(withinBox(mesh(), renderer, b), adding);
    const inside = regionsInBox(b);
    if (pickKind() === 'regions') return addRegions(inside.map((r) => ({ sketch: r.sketch, id: r.region.id })));
    if (pickKind() === 'axis') return;
    const base = pickBase();
    if (!base) {
      const cur = selectedRegions();
      const sketch = cur && adding && inside.some((r) => r.sketch === cur.sketch) ? cur.sketch : inside[0]?.sketch;
      const ids = inside.filter((r) => r.sketch === sketch).map((r) => r.region.id);
      const kept = adding && cur?.sketch === sketch ? cur!.ids : [];
      setSelectedRegions(ids.length ? { sketch: sketch!, ids: [...new Set([...kept, ...ids])] } : adding ? cur : null);
    }
    const found = withinBox(base ? base.mesh : mesh(), renderer, b);
    if (!found) return;
    if (base) return addPicks(found);
    const cur = selection();
    setSelection(adding ? { faces: [...new Set([...cur.faces, ...found.faces])], edges: [...new Set([...cur.edges, ...found.edges])] } : found);
  };

  const onLeave = () => {
    hoverQueued = null;
    hoverToken++;
    setHoverHit(null);
    setHoverLine(null);
    setHoverText('');
    setHoverPlane(null);
  };

  const editing = () => session()?.editing[0]();

  return (
    <div class="viewport" ref={host} style={{ cursor: cursor() }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()} data-testid="viewport">
      <canvas ref={glCanvas} class="layer" />
      <canvas ref={overlay} class="layer overlay" />
      <Show when={!glProblem()}><ViewCube onEnter={onLeave} /></Show>
      <Show when={editing()}>
        {(ed) => (
          <input
            ref={dimInput}
            class="dim-input"
            style={{ left: `${ed().x}px`, top: `${ed().y}px` }}
            value={ed().text}
            data-testid="dim-input"
            aria-label="Dimension value"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') session()?.setDimension(ed().id, e.currentTarget.value);
              if (e.key === 'Escape') session()?.editing[1](null);
            }}
          />
        )}
      </Show>
      <Show when={mode() === 'pick-plane'}>
        <div class="banner" onPointerDown={(e) => e.stopPropagation()}>Pick a plane or a flat face to sketch on<button class="link" onClick={() => setMode('part')}>Cancel</button></div>
      </Show>
      <Show when={context()}>{(c) => <ContextMenu {...c()} close={() => setContext(null)} />}</Show>
      <Show when={box()}>{(b) => <div class="select-box" data-testid="select-box" style={{ left: `${b().x}px`, top: `${b().y}px`, width: `${b().w}px`, height: `${b().h}px` }} />}</Show>
      <Show when={glProblem()}>{(p) => <GlNotice problem={p()} />}</Show>
    </div>
  );
}
