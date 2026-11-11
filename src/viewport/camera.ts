import { add, cross, dot, normalize, quatAxis, quatFromBasis, quatMul, quatNormalize, quatRotate, quatSlerp, scale, sub, lerp3, type Quat, type V3 } from './math';

export const VIEWS: Record<string, { right: V3; up: V3; back: V3 }> = {
  top: { right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1] },
  bottom: { right: [1, 0, 0], up: [0, -1, 0], back: [0, 0, -1] },
  front: { right: [1, 0, 0], up: [0, 0, 1], back: [0, -1, 0] },
  back: { right: [-1, 0, 0], up: [0, 0, 1], back: [0, 1, 0] },
  right: { right: [0, 1, 0], up: [0, 0, 1], back: [1, 0, 0] },
  left: { right: [0, -1, 0], up: [0, 0, 1], back: [-1, 0, 0] },
};

function isoRotation(): Quat {
  const back = normalize([1, -1, 0.8]);
  const right = normalize(cross([0, 0, 1], back));
  return quatFromBasis(right, cross(back, right), back);
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** A Z-up orthographic camera, which is what you want for measuring by eye. */
export class Camera {
  target: V3 = [0, 0, 0];
  rot: Quat = isoRotation();
  halfH = 70;
  width = 1;
  height = 1;
  sceneRadius = 100;
  private jumped = false;
  private anim: { t0: number; ms: number; from: { target: V3; rot: Quat; halfH: number }; to: { target: V3; rot: Quat; halfH: number } } | null = null;

  right = () => quatRotate(this.rot, [1, 0, 0]);
  up = () => quatRotate(this.rot, [0, 1, 0]);
  back = () => quatRotate(this.rot, [0, 0, 1]);
  get worldPerPixel() {
    return (this.halfH * 2) / this.height;
  }

  depthRange() {
    const d = Math.hypot(this.target[0], this.target[1], this.target[2]);
    return Math.max(10, 4 * this.sceneRadius + 2 * d, 4 * this.halfH);
  }

  viewProj(): Float32Array {
    const r = this.right(), u = this.up(), b = this.back();
    const ax = 1 / (this.halfH * (this.width / this.height)), ay = 1 / this.halfH, az = -1 / this.depthRange();
    const t = this.target;
    const tx = -dot(r, t), ty = -dot(u, t), tz = -dot(b, t);
    return new Float32Array([
      ax * r[0], ay * u[0], az * b[0], 0,
      ax * r[1], ay * u[1], az * b[1], 0,
      ax * r[2], ay * u[2], az * b[2], 0,
      ax * tx, ay * ty, az * tz, 1,
    ]);
  }

  /** World point to CSS pixels. */
  project(p: V3): [number, number] {
    const d = sub(p, this.target);
    const k = this.height / (this.halfH * 2);
    return [this.width / 2 + dot(d, this.right()) * k, this.height / 2 - dot(d, this.up()) * k];
  }

  /** The world point under a pixel, on the plane through the target facing the camera. */
  unproject(sx: number, sy: number): V3 {
    const k = this.worldPerPixel;
    return add(add(this.target, scale(this.right(), (sx - this.width / 2) * k)), scale(this.up(), (this.height / 2 - sy) * k));
  }

  /** Where the ray through a pixel meets a plane. */
  onPlane(sx: number, sy: number, origin: V3, normal: V3): V3 | null {
    const p = this.unproject(sx, sy);
    const dir = scale(this.back(), -1);
    const d = dot(dir, normal);
    if (Math.abs(d) < 1e-9) return null;
    return add(p, scale(dir, dot(sub(origin, p), normal) / d));
  }

  /**
   * Rotates the way Onshape does: freely about the screen's axes, or with Z kept upright, and around a pivot that
   * stays exactly where it is on screen.
   */
  orbit(dx: number, dy: number, pivot: V3 = this.target, upright = false) {
    this.anim = null;
    const k = 0.0062;
    const d = sub(pivot, this.target);
    const sx = dot(d, this.right()), sy = dot(d, this.up()), sz = dot(d, this.back());
    this.rot = upright
      ? quatNormalize(quatMul(quatMul(quatAxis([0, 0, 1], -dx * k), this.rot), quatAxis([1, 0, 0], -dy * k)))
      : quatNormalize(quatMul(quatMul(this.rot, quatAxis([0, 1, 0], -dx * k)), quatAxis([1, 0, 0], -dy * k)));
    this.target = sub(pivot, add(add(scale(this.right(), sx), scale(this.up(), sy)), scale(this.back(), sz)));
  }

  pan(dx: number, dy: number) {
    this.anim = null;
    const k = this.worldPerPixel;
    this.target = add(add(this.target, scale(this.right(), -dx * k)), scale(this.up(), dy * k));
  }

  zoomAt(factor: number, sx: number, sy: number) {
    this.anim = null;
    const before = this.unproject(sx, sy);
    this.halfH = Math.min(1e6, Math.max(1e-3, this.halfH * factor));
    const after = this.unproject(sx, sy);
    this.target = add(this.target, sub(before, after));
  }

  animateTo(to: { target?: V3; rot?: Quat; halfH?: number }, ms = 320) {
    const goal = { target: to.target ?? this.target, rot: to.rot ?? this.rot, halfH: to.halfH ?? this.halfH };
    if (reducedMotion() || ms <= 0) {
      Object.assign(this, goal);
      this.anim = null;
      this.jumped = true;
      return;
    }
    this.anim = { t0: performance.now(), ms, from: { target: this.target, rot: this.rot, halfH: this.halfH }, to: goal };
  }

  /** Advances an animation. True while one is running. */
  tick(now: number): boolean {
    if (this.jumped) {
      this.jumped = false;
      return true;
    }
    if (!this.anim) return false;
    const a = this.anim;
    const x = Math.min(1, (now - a.t0) / a.ms);
    const t = 1 - (1 - x) ** 3;
    this.target = lerp3(a.from.target, a.to.target, t);
    this.rot = quatSlerp(a.from.rot, a.to.rot, t);
    this.halfH = a.from.halfH + (a.to.halfH - a.from.halfH) * t;
    if (x >= 1) this.anim = null;
    return true;
  }

  /** Where the view is heading, so quick clicks add up instead of fighting the animation. */
  goalRot(): Quat {
    return this.anim?.to.rot ?? this.rot;
  }

  rotFromBasis(right: V3, up: V3, back: V3): Quat {
    return quatFromBasis(right, up, back);
  }

  viewRot(name: string): Quat {
    if (name === 'iso') return isoRotation();
    const v = VIEWS[name];
    return quatFromBasis(v.right, v.up, v.back);
  }

  /** Frames a box with a margin. */
  fitBox(min: V3, max: V3, ms = 320, rot?: Quat) {
    const q = rot ?? this.anim?.to.rot ?? this.rot;
    const r = quatRotate(q, [1, 0, 0]), u = quatRotate(q, [0, 1, 0]);
    const c = scale(add(min, max), 0.5);
    const half = scale(sub(max, min), 0.5);
    const extent = (axis: V3) => Math.abs(axis[0]) * half[0] + Math.abs(axis[1]) * half[1] + Math.abs(axis[2]) * half[2];
    const aspect = this.width / Math.max(1, this.height);
    const halfH = Math.max(extent(u), extent(r) / aspect, 1) * 1.45;
    this.animateTo({ target: c, halfH, rot: q }, ms);
  }
}
