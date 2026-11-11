/** What faces, edges and sizes are called on screen, rather than the kernel's names for them. */
export const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en', { maximumFractionDigits: 1 }) : String(Number(v.toFixed(2))));

const surfaceWords: Record<string, string> = { plane: 'Flat face', cylinder: 'Cylindrical face', cone: 'Conical face', sphere: 'Spherical face', torus: 'Toroidal face' };
const curveWords: Record<string, string> = { line: 'Straight edge', circle: 'Round edge', ellipse: 'Elliptical edge', traced: 'Curved edge', spline: 'Spline edge' };

export const faceWord = (surface?: string) => (surface && surfaceWords[surface]) || 'Curved face';
export const edgeWord = (curve?: string) => (curve && curveWords[curve]) || 'Edge';

/**
 * What a part is called on screen: the name given to it, or Part 2, or Surface 1 for a sheet, numbered by kind in the
 * order they were made.
 */
export function partLabel(parts: { name: string; sheet: boolean }[], name: string, looks?: Record<string, { name?: string }>) {
  if (looks?.[name]?.name) return looks[name].name!;
  const at = parts.findIndex((p) => p.name === name);
  if (at < 0) return name;
  const sheet = parts[at].sheet;
  const n = parts.slice(0, at + 1).filter((p) => p.sheet === sheet).length;
  return `${sheet ? 'Surface' : 'Part'} ${n}`;
}
