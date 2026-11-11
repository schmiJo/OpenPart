export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => {
  const n = length(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const quatMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const quatAxis = (axis: V3, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
export const quatRotate = (q: Quat, v: V3): V3 => {
  const u: V3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
};
export const quatNormalize = (q: Quat): Quat => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d *= s;
  if (d > 0.9995) {
    return quatNormalize([
      a[0] + (s * b[0] - a[0]) * t,
      a[1] + (s * b[1] - a[1]) * t,
      a[2] + (s * b[2] - a[2]) * t,
      a[3] + (s * b[3] - a[3]) * t,
    ]);
  }
  const th = Math.acos(d);
  const wa = Math.sin((1 - t) * th) / Math.sin(th);
  const wb = (s * Math.sin(t * th)) / Math.sin(th);
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2], wa * a[3] + wb * b[3]];
}
/** The rotation whose columns are the given right, up and back axes. */
export function quatFromBasis(r: V3, u: V3, b: V3): Quat {
  const t = r[0] + u[1] + b[2];
  let q: Quat;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(u[2] - b[1]) / s, (b[0] - r[2]) / s, (r[1] - u[0]) / s, s / 4];
  } else if (r[0] > u[1] && r[0] > b[2]) {
    const s = Math.sqrt(1 + r[0] - u[1] - b[2]) * 2;
    q = [s / 4, (u[0] + r[1]) / s, (b[0] + r[2]) / s, (u[2] - b[1]) / s];
  } else if (u[1] > b[2]) {
    const s = Math.sqrt(1 + u[1] - r[0] - b[2]) * 2;
    q = [(u[0] + r[1]) / s, s / 4, (b[1] + u[2]) / s, (b[0] - r[2]) / s];
  } else {
    const s = Math.sqrt(1 + b[2] - r[0] - u[1]) * 2;
    q = [(b[0] + r[2]) / s, (b[1] + u[2]) / s, s / 4, (r[1] - u[0]) / s];
  }
  return quatNormalize(q);
}
