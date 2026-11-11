import type { MeshData } from '../engine/client';
import { Camera } from './camera';
import { add, scale, type V3 } from './math';

const TEX_W = 2048;
const MARK_RGBA = [0.91, 0.55, 0.03, 1];

const SOLID_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in uint aFace;
uniform mat4 uVP;
uniform highp usampler2D uStates;
out vec3 vN;
flat out uint vState;
flat out uint vId;
void main(){
  vN = aNormal;
  vId = aFace;
  vState = texelFetch(uStates, ivec2(int(aFace) % ${TEX_W}, int(aFace) / ${TEX_W}), 0).r;
  // State 4 is a hidden part: outside the clip volume, so it's neither drawn nor picked.
  gl_Position = vState == 4u ? vec4(2.0, 2.0, 2.0, 1.0) : uVP * vec4(aPos, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision highp float;
in vec3 vN;
flat in uint vState;
flat in uint vId;
uniform vec3 uRight, uUp, uBack;
uniform float uOverlay;
uniform float uAlpha;
out vec4 o;
const vec3 ALLOY = vec3(0.77, 0.80, 0.82);
const vec3 MARK = vec3(0.91, 0.55, 0.03);
void main(){
  if (uOverlay > 0.5) {
    if (vState == 0u) discard;
    o = vec4(MARK, 0.5);
    return;
  }
  vec3 N = normalize(vN);
  vec3 V = uBack;
  vec3 L = normalize(uRight * 0.38 + uUp * 0.62 + uBack * 0.70);
  float wrap = dot(N, L) * 0.5 + 0.5;
  wrap *= wrap;
  float sky = 0.5 + 0.5 * N.z;
  vec3 H = normalize(L + V);
  float gloss = pow(max(dot(N, H), 0.0), 26.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float lum = 0.40 + 0.50 * wrap + 0.10 * sky;
  vec3 c = ALLOY * lum + vec3(gloss * 0.16 + rim * 0.10);
  if (vState == 1u) c = mix(c, MARK, 0.16);
  else if (vState >= 2u) c = mix(c, MARK, 0.4);
  o = vec4(c, uAlpha);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in uint aId;
uniform mat4 uVP;
uniform vec2 uRes;
uniform vec3 uWidths;
uniform float uBias;
uniform highp usampler2D uStates;
flat out uint vState;
flat out uint vId;
out float vDist;
flat out float vHalf;
void main(){
  vId = aId;
  vState = texelFetch(uStates, ivec2(int(aId) % ${TEX_W}, int(aId) / ${TEX_W}), 0).r;
  float width = vState == 0u ? uWidths.x : (vState == 1u ? uWidths.y : uWidths.z);
  float hw = width * 0.5 + 1.0;
  vec4 ca = uVP * vec4(aA, 1.0);
  vec4 cb = uVP * vec4(aB, 1.0);
  vec2 sa = ca.xy * uRes * 0.5;
  vec2 sb = cb.xy * uRes * 0.5;
  vec2 d = sb - sa;
  float len = length(d);
  d = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  vec2 s = mix(sa, sb, aCorner.x) + n * aCorner.y * hw + d * (aCorner.x * 2.0 - 1.0) * (hw - 1.0);
  float z = mix(ca.z, cb.z, aCorner.x) - uBias;
  vDist = aCorner.y * hw;
  vHalf = width * 0.5;
  gl_Position = vState == 4u ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(s / (uRes * 0.5), z, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
flat in uint vState;
in float vDist;
flat in float vHalf;
uniform vec4 uColor0, uColor1, uColor2;
out vec4 o;
void main(){
  vec4 c = vState == 0u ? uColor0 : (vState == 1u ? uColor1 : uColor2);
  // One pixel of fade centred on the edge of the line, so it comes out as wide as it says.
  float a = clamp(vHalf + 0.5 - abs(vDist), 0.0, 1.0);
  o = vec4(c.rgb, c.a * a);
}`;

const PICK_FS = `#version 300 es
precision highp float;
flat in uint vId;
uniform float uKind;
out vec4 o;
void main(){
  o = vec4(float(vId & 255u) / 255.0, float((vId >> 8u) & 255u) / 255.0, float((vId >> 16u) & 255u) / 255.0, uKind / 255.0);
}`;

const FILL_VS = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
void main(){ gl_Position = uVP * vec4(aPos, 1.0); }`;
const FILL_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 o;
void main(){ o = uColor; }`;

const REGION_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in uint aRegion;
uniform mat4 uVP;
uniform highp usampler2D uStates;
flat out uint vState;
flat out uint vId;
void main(){
  vId = aRegion;
  vState = texelFetch(uStates, ivec2(int(aRegion) % ${TEX_W}, int(aRegion) / ${TEX_W}), 0).r;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;
const REGION_FS = `#version 300 es
precision highp float;
flat in uint vState;
uniform uvec2 uShow;
out vec4 o;
void main(){
  if (vState < uShow.x || vState > uShow.y) discard;
  // A closed area is shaded, as in the sketch. The pointer and the selection light it the way they light a face.
  o = vState == 0u ? vec4(0.157, 0.275, 0.431, 0.07) : (vState == 1u ? vec4(0.91, 0.55, 0.03, 0.2) : vec4(0.91, 0.55, 0.03, 0.42));
}`;

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader failed');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
  const u: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i)!.name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

interface GpuLines { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number; states: StateTex }
interface GpuMesh { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; indexCount: number; lines: GpuLines; faceStates: StateTex }
interface GpuRegions { vao: WebGLVertexArrayObject; buffers: WebGLBuffer[]; count: number; states: StateTex }

class StateTex {
  tex: WebGLTexture;
  data = new Uint8Array(TEX_W * 8);
  dirty = true;
  constructor(private gl: WebGL2RenderingContext) {
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  set(states: Map<number, number>) {
    this.data.fill(0);
    for (const [i, v] of states) if (i < this.data.length) this.data[i] = v;
    this.dirty = true;
  }
  bind(unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.dirty) {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, TEX_W, 8, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.data);
      this.dirty = false;
    }
  }
  dispose() {
    this.gl.deleteTexture(this.tex);
  }
}

export interface PlaneQuad { id: number; origin: V3; u: V3; v: V3; half: number; lit: boolean }
export interface PickHit { kind: 'face' | 'edge' | 'plane' | 'region'; id: number }

export class Renderer {
  gl: WebGL2RenderingContext;
  camera = new Camera();
  private solid; private line; private pickSolid; private pickLine; private fill; private region; private pickRegion;
  private regions: GpuRegions | null = null;
  private quad: WebGLBuffer;
  private fillVao: WebGLVertexArrayObject;
  private fillBuf: WebGLBuffer;
  private mesh: GpuMesh | null = null;
  private pickMesh: GpuMesh | null = null;
  /** The model before the feature being previewed, drawn solid under the preview. */
  private previewBase: GpuMesh | null = null;
  private sketchLines: GpuLines | null = null;
  /** A revolve's axis, or a line about to become it, drawn over everything. */
  private axisLines: GpuLines | null = null;
  private planeLines: GpuLines | null = null;
  private planes: PlaneQuad[] = [];
  private meshSize = 1;
  private emptyStates: StateTex;
  private pickFbo: WebGLFramebuffer; private pickColor: WebGLTexture; private pickDepth: WebGLRenderbuffer;
  private pickW = 0; private pickH = 0; private pickDirty = true;
  dpr = 1;
  dirty = true;
  afterRender: (() => void) | null = null;
  pickMask = { faces: true, edges: true, planes: true, regions: true };
  /** While a dialog takes regions they can't hide behind its preview, which grows straight out of them. */
  regionsOnTop = false;
  /** While picking regions, the preview is glass over the model before it, so the sketch stays in sight underneath. */
  ghostPreview = false;
  /** How solid the preview's glass is, from 0 to 1. */
  previewOpacity = 0.35;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('This browser has no WebGL2.');
    this.gl = gl;
    this.solid = program(gl, SOLID_VS, SOLID_FS);
    this.line = program(gl, LINE_VS, LINE_FS);
    this.pickSolid = program(gl, SOLID_VS, PICK_FS);
    this.pickLine = program(gl, LINE_VS, PICK_FS);
    this.fill = program(gl, FILL_VS, FILL_FS);
    this.region = program(gl, REGION_VS, REGION_FS);
    this.pickRegion = program(gl, REGION_VS, PICK_FS);
    this.emptyStates = new StateTex(gl);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.fillVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fillVao);
    this.fillBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.pickFbo = gl.createFramebuffer()!;
    this.pickColor = gl.createTexture()!;
    this.pickDepth = gl.createRenderbuffer()!;
    this.loop();
  }

  private makeLines(segments: Float32Array, ids: Uint32Array): GpuLines {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const seg = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, seg);
    gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 12);
    gl.vertexAttribDivisor(2, 1);
    const id = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, id);
    gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    return { vao, buffers: [seg, id], count: ids.length, states: new StateTex(gl) };
  }

  private freeLines(l: GpuLines | null) {
    if (!l) return;
    this.gl.deleteVertexArray(l.vao);
    l.buffers.forEach((b) => this.gl.deleteBuffer(b));
    l.states.dispose();
  }

  private makeMesh(m: MeshData): GpuMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nor = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nor);
    gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const face = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, face);
    gl.bufferData(gl.ARRAY_BUFFER, m.faceIds, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);
    const idx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, buffers: [pos, nor, face, idx], indexCount: m.indices.length, lines: this.makeLines(m.segments, m.segmentIds), faceStates: new StateTex(gl) };
  }

  private freeMesh(m: GpuMesh | null) {
    if (!m) return;
    this.gl.deleteVertexArray(m.vao);
    m.buffers.forEach((b) => this.gl.deleteBuffer(b));
    m.faceStates.dispose();
    this.freeLines(m.lines);
  }

  setMesh(m: MeshData | null) {
    this.freeMesh(this.mesh);
    this.mesh = m && m.indices.length ? this.makeMesh(m) : null;
    if (m && m.indices.length) {
      const r = Math.hypot(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]) / 2;
      this.meshSize = r * 2;
      this.camera.sceneRadius = Math.max(r + Math.hypot(...m.min, 0), 10);
    }
    this.invalidate();
  }

  /** While a dialog takes a selection, what you pick from is the model before that feature. */
  setPickMesh(m: MeshData | null) {
    this.freeMesh(this.pickMesh);
    this.pickMesh = m && m.indices.length ? this.makeMesh(m) : null;
    this.invalidate();
  }

  /** The model as it stood before the feature being previewed. */
  setPreviewBase(m: MeshData | null) {
    this.freeMesh(this.previewBase);
    this.previewBase = m && m.indices.length ? this.makeMesh(m) : null;
    this.invalidate();
  }

  /** A hidden part stays hidden in the model under the preview. */
  setPreviewBaseHidden(faces: number[], edges: number[]) {
    if (!this.previewBase) return;
    this.previewBase.faceStates.set(new Map(faces.map((f) => [f, 4])));
    this.previewBase.lines.states.set(new Map(edges.map((e) => [e, 4])));
    this.invalidate();
  }

  /** What's lit, and which faces and edges belong to hidden parts. While picking, the lit ones belong to the pick mesh. */
  setStates(faces: Map<number, number>, edges: Map<number, number>, hiddenFaces: number[], hiddenEdges: number[]) {
    const main = this.mesh;
    if (this.pickMesh) {
      this.pickMesh.faceStates.set(faces);
      this.pickMesh.lines.states.set(edges);
      if (main) {
        main.faceStates.set(new Map(hiddenFaces.map((f) => [f, 4])));
        main.lines.states.set(new Map(hiddenEdges.map((e) => [e, 4])));
      }
    } else if (main) {
      for (const f of hiddenFaces) faces.set(f, 4);
      for (const e of hiddenEdges) edges.set(e, 4);
      main.faceStates.set(faces);
      main.lines.states.set(edges);
    }
    this.invalidate();
  }

  /** Sketches that aren't being edited: world-space polylines, flat as line segments. */
  setSketchLines(segments: Float32Array) {
    this.freeLines(this.sketchLines);
    const n = segments.length / 6;
    this.sketchLines = n ? this.makeLines(segments, new Uint32Array(n)) : null;
    this.invalidate();
  }

  /** Lines to stand out over everything: a revolve's axis, and in a fainter way the line under the pointer. */
  setAxisLines(segments: Float32Array, ids: Uint32Array, states: Map<number, number>) {
    this.freeLines(this.axisLines);
    this.axisLines = segments.length ? this.makeLines(segments, ids) : null;
    this.axisLines?.states.set(states);
    this.invalidate();
  }

  /** The closed areas of the sketches on show: three world points per triangle, and which region each vertex is in. */
  setRegions(positions: Float32Array, ids: Uint32Array) {
    const gl = this.gl;
    if (this.regions) {
      gl.deleteVertexArray(this.regions.vao);
      this.regions.buffers.forEach((b) => gl.deleteBuffer(b));
      this.regions.states.dispose();
      this.regions = null;
    }
    if (ids.length) {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const pos = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const id = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, id);
      gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
      gl.bindVertexArray(null);
      this.regions = { vao, buffers: [pos, id], count: ids.length, states: new StateTex(gl) };
    }
    this.invalidate();
  }

  setRegionStates(states: Map<number, number>) {
    this.regions?.states.set(states);
    this.invalidate();
  }

  private drawRegions(prog: { u: Record<string, WebGLUniformLocation | null> }, vp: Float32Array) {
    const gl = this.gl;
    gl.uniformMatrix4fv(prog.u.uVP, false, vp);
    this.regions!.states.bind(0);
    gl.uniform1i(prog.u.uStates, 0);
    gl.bindVertexArray(this.regions!.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.regions!.count);
  }

  setPlanes(planes: PlaneQuad[]) {
    this.planes = planes;
    this.freeLines(this.planeLines);
    const seg: number[] = [];
    for (const p of planes) {
      const c = this.corners(p);
      for (let i = 0; i < 4; i++) seg.push(...c[i], ...c[(i + 1) % 4]);
    }
    this.planeLines = seg.length ? this.makeLines(new Float32Array(seg), new Uint32Array(seg.length / 6)) : null;
    this.invalidate();
  }

  private corners(p: PlaneQuad): V3[] {
    const a = scale(p.u, p.half), b = scale(p.v, p.half);
    return [add(add(p.origin, scale(a, -1)), scale(b, -1)), add(add(p.origin, a), scale(b, -1)), add(add(p.origin, a), b), add(add(p.origin, scale(a, -1)), b)];
  }

  invalidate() {
    this.dirty = true;
    this.pickDirty = true;
  }

  resize(w: number, h: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.camera.width = w;
    this.camera.height = h;
    this.invalidate();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.camera.tick(now)) this.invalidate();
    if (this.dirty) {
      this.dirty = false;
      this.draw();
      this.afterRender?.();
    }
  };

  private drawMeshSolid(prog: { u: Record<string, WebGLUniformLocation | null> }, m: GpuMesh, vp: Float32Array) {
    const gl = this.gl;
    gl.uniformMatrix4fv(prog.u.uVP, false, vp);
    m.faceStates.bind(0);
    gl.uniform1i(prog.u.uStates, 0);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_INT, 0);
  }

  private drawLines(prog: { u: Record<string, WebGLUniformLocation | null> }, l: GpuLines, vp: Float32Array, widths: [number, number, number], colors?: number[][], bias = 3e-4) {
    const gl = this.gl;
    const d = this.dpr;
    gl.uniformMatrix4fv(prog.u.uVP, false, vp);
    gl.uniform2f(prog.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform3f(prog.u.uWidths, widths[0] * d, widths[1] * d, widths[2] * d);
    gl.uniform1f(prog.u.uBias, bias);
    l.states.bind(0);
    gl.uniform1i(prog.u.uStates, 0);
    if (colors) {
      gl.uniform4fv(prog.u.uColor0, colors[0]);
      gl.uniform4fv(prog.u.uColor1, colors[1]);
      gl.uniform4fv(prog.u.uColor2, colors[2]);
    }
    gl.bindVertexArray(l.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
  }

  /** Edges get finer as the part gets smaller on screen, so a part seen from far away isn't all outline. */
  private edgeWidth() {
    const across = this.meshSize / this.camera.worldPerPixel;
    return Math.max(0.65, Math.min(1, 0.65 + across / 1400));
  }

  private draw() {
    const gl = this.gl, cam = this.camera;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.985, 0.988, 0.99, 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = cam.viewProj();
    const r = cam.right(), u = cam.up(), b = cam.back();

    if (this.ghostPreview && this.mesh) {
      this.drawGlass(vp, r, u, b);
      return;
    }

    if (this.mesh) {
      gl.useProgram(this.solid.p);
      gl.uniform3fv(this.solid.u.uRight, r);
      gl.uniform3fv(this.solid.u.uUp, u);
      gl.uniform3fv(this.solid.u.uBack, b);
      gl.uniform1f(this.solid.u.uOverlay, 0);
      gl.uniform1f(this.solid.u.uAlpha, 1);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 1.5);
      this.drawMeshSolid(this.solid, this.mesh, vp);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    if (this.mesh) {
      gl.useProgram(this.line.p);
      const base = [0.13, 0.16, 0.19, 0.82];
      this.drawLines(this.line, this.mesh.lines, vp, [this.edgeWidth(), 2.25, 2.25], [base, MARK_RGBA, MARK_RGBA]);
    }

    if (this.pickMesh) {
      // Overlay of what was picked, on top of the preview.
      gl.useProgram(this.solid.p);
      gl.uniform3fv(this.solid.u.uRight, r);
      gl.uniform3fv(this.solid.u.uUp, u);
      gl.uniform3fv(this.solid.u.uBack, b);
      gl.uniform1f(this.solid.u.uOverlay, 1);
      gl.uniform1f(this.solid.u.uAlpha, 1);
      this.drawMeshSolid(this.solid, this.pickMesh, vp);
      gl.useProgram(this.line.p);
      this.drawLines(this.line, this.pickMesh.lines, vp, [1.1, 2.25, 2.25], [[0.91, 0.55, 0.03, 0.42], MARK_RGBA, MARK_RGBA], 8e-4);
    }

    if (this.regions) {
      gl.useProgram(this.region.p);
      gl.uniform2ui(this.region.u.uShow, 0, this.regionsOnTop ? 0 : 2);
      this.drawRegions(this.region, vp);
      if (this.regionsOnTop) {
        gl.disable(gl.DEPTH_TEST);
        gl.uniform2ui(this.region.u.uShow, 1, 2);
        this.drawRegions(this.region, vp);
        gl.enable(gl.DEPTH_TEST);
      }
    }

    this.drawSketchLines(vp);

    this.drawPlanes(vp);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.pickDirty = true;
  }

  /** While a dialog takes regions, a sketch's outlines stay readable whatever is in front of them. */
  private drawSketchLines(vp: Float32Array) {
    if (!this.sketchLines) return;
    const gl = this.gl;
    gl.useProgram(this.line.p);
    const c = [0.72, 0.42, 0.02, 1];
    if (this.regionsOnTop) gl.disable(gl.DEPTH_TEST);
    this.drawLines(this.line, this.sketchLines, vp, [1.2, 1.2, 1.2], [c, c, c], 1e-3);
    gl.enable(gl.DEPTH_TEST);
    if (this.axisLines) {
      gl.disable(gl.DEPTH_TEST);
      this.drawLines(this.line, this.axisLines, vp, [2.25, 2.25, 2.25], [MARK_RGBA, [0.91, 0.55, 0.03, 0.55], MARK_RGBA], 1e-3);
      gl.enable(gl.DEPTH_TEST);
    }
  }

  private drawPlanes(vp: Float32Array) {
    if (!this.planes.length) return;
    const gl = this.gl;
    gl.useProgram(this.fill.p);
    gl.uniformMatrix4fv(this.fill.u.uVP, false, vp);
    gl.bindVertexArray(this.fillVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
    for (const p of this.planes) {
      const c = this.corners(p);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...c[0], ...c[1], ...c[3], ...c[2]]), gl.DYNAMIC_DRAW);
      gl.uniform4fv(this.fill.u.uColor, p.lit ? [0.91, 0.55, 0.03, 0.07] : [0.42, 0.52, 0.66, 0.035]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (this.planeLines) {
      gl.useProgram(this.line.p);
      const c = [0.5, 0.63, 0.8, 0.5];
      this.drawLines(this.line, this.planeLines, vp, [1, 1, 1], [c, c, c]);
    }
  }

  /**
   * The model before this feature stays solid, the sketch sits on it, and the preview goes over them as glass. A depth
   * pass first leaves only the preview's nearest surface to blend, so its back faces don't muddy what's behind.
   */
  private drawGlass(vp: Float32Array, r: V3, u: V3, b: V3) {
    const gl = this.gl;
    const mesh = this.mesh!;
    const offsetSolid = (m: GpuMesh) => {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 1.5);
      this.drawMeshSolid(this.solid, m, vp);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    };
    gl.useProgram(this.solid.p);
    gl.uniform3fv(this.solid.u.uRight, r);
    gl.uniform3fv(this.solid.u.uUp, u);
    gl.uniform3fv(this.solid.u.uBack, b);
    gl.uniform1f(this.solid.u.uOverlay, 0);
    gl.uniform1f(this.solid.u.uAlpha, 1);
    if (this.previewBase) offsetSolid(this.previewBase);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    const edge = [0.13, 0.16, 0.19, 0.82];
    if (this.previewBase) {
      gl.useProgram(this.line.p);
      this.drawLines(this.line, this.previewBase.lines, vp, [this.edgeWidth(), 2.25, 2.25], [edge, MARK_RGBA, MARK_RGBA]);
    }
    // What's picked on the model before the feature, such as the face an extrude goes up to, shows through the glass.
    if (this.pickMesh) {
      gl.useProgram(this.solid.p);
      gl.uniform1f(this.solid.u.uOverlay, 1);
      this.drawMeshSolid(this.solid, this.pickMesh, vp);
      gl.uniform1f(this.solid.u.uOverlay, 0);
      gl.useProgram(this.line.p);
      this.drawLines(this.line, this.pickMesh.lines, vp, [1.1, 2.25, 2.25], [[0.91, 0.55, 0.03, 0.42], MARK_RGBA, MARK_RGBA], 8e-4);
    }
    if (this.regions) {
      gl.useProgram(this.region.p);
      gl.uniform2ui(this.region.u.uShow, 0, 0);
      this.drawRegions(this.region, vp);
    }
    this.drawPlanes(vp);

    gl.useProgram(this.solid.p);
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    offsetSolid(mesh);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.uniform1f(this.solid.u.uAlpha, this.previewOpacity);
    offsetSolid(mesh);
    gl.uniform1f(this.solid.u.uAlpha, 1);
    gl.useProgram(this.line.p);
    const faint = [0.13, 0.16, 0.19, 0.5];
    this.drawLines(this.line, mesh.lines, vp, [this.edgeWidth(), 2.25, 2.25], [faint, MARK_RGBA, MARK_RGBA]);

    if (this.regions) {
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.region.p);
      gl.uniform2ui(this.region.u.uShow, 1, 2);
      this.drawRegions(this.region, vp);
      gl.enable(gl.DEPTH_TEST);
    }
    this.drawSketchLines(vp);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this.pickDirty = true;
  }

  private ensurePickTarget() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (w === this.pickW && h === this.pickH) return;
    this.pickW = w;
    this.pickH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.pickColor);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickColor, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private drawPick() {
    const gl = this.gl;
    this.ensurePickTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.pickW, this.pickH);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = this.camera.viewProj();
    // Planes go first, and the depth is cleared after them, so the model always wins a click. They're only picked
    // where nothing is in front of them or behind them on the part.
    if (this.pickMask.planes && this.planes.length) {
      gl.useProgram(this.fill.p);
      gl.uniformMatrix4fv(this.fill.u.uVP, false, vp);
      gl.bindVertexArray(this.fillVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fillBuf);
      for (const p of this.planes) {
        const c = this.corners(p);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([...c[0], ...c[1], ...c[3], ...c[2]]), gl.DYNAMIC_DRAW);
        gl.uniform4fv(this.fill.u.uColor, [p.id / 255, 0, 0, 3 / 255]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    const m = this.pickMesh ?? this.mesh;
    const pickRegions = () => {
      if (!this.regions || !this.pickMask.regions) return;
      gl.useProgram(this.pickRegion.p);
      gl.uniform1f(this.pickRegion.u.uKind, 4);
      if (this.regionsOnTop) gl.disable(gl.DEPTH_TEST);
      this.drawRegions(this.pickRegion, vp);
      gl.enable(gl.DEPTH_TEST);
    };
    if (m) {
      gl.useProgram(this.pickSolid.p);
      // A part that can't be picked right now still blocks what's behind it, and still counts as being there.
      gl.uniform1f(this.pickSolid.u.uKind, this.pickMask.faces ? 1 : 5);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1.5, 1.5);
      this.drawMeshSolid(this.pickSolid, m, vp);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    // A sketch lying on a face beats the face, and a part's edges stay easy to hit across it.
    pickRegions();
    if (m && this.pickMask.edges) {
      gl.useProgram(this.pickLine.p);
      gl.uniform1f(this.pickLine.u.uKind, 2);
      // Edges are easier to hit than to draw: picking uses a wide line, whatever the state. Hidden stays hidden.
      const saved = m.lines.states.data.slice();
      m.lines.states.data.forEach((v, i, a) => { a[i] = v === 4 ? 4 : 0; });
      m.lines.states.dirty = true;
      // The band reaches over the faces either side, which at a glancing angle sit nearer than the edge, so it gets more lift than a drawn line.
      this.drawLines(this.pickLine, m.lines, vp, [10, 10, 10], undefined, 1.5e-3);
      m.lines.states.data.set(saved);
      m.lines.states.dirty = true;
    }
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickDirty = false;
  }

  private readPick(sx: number, sy: number) {
    const gl = this.gl;
    if (this.pickDirty) this.drawPick();
    const x = Math.round(sx * this.dpr), y = this.pickH - 1 - Math.round(sy * this.dpr);
    if (x < 0 || y < 0 || x >= this.pickW || y >= this.pickH) return null;
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  /** Whether the model or a sketch region is under a pixel, whether or not it can be picked right now. */
  overModel(sx: number, sy: number) {
    const kind = this.readPick(sx, sy)?.[3];
    return kind === 1 || kind === 2 || kind === 4 || kind === 5;
  }

  pick(sx: number, sy: number): PickHit | null {
    const px = this.readPick(sx, sy);
    if (!px) return null;
    const id = px[0] | (px[1] << 8) | (px[2] << 16);
    if (px[3] === 1) return { kind: 'face', id };
    if (px[3] === 2) return { kind: 'edge', id };
    if (px[3] === 3) return { kind: 'plane', id };
    if (px[3] === 4) return { kind: 'region', id };
    return null;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }
}
