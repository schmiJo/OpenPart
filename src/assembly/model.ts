import type { Frame, MateType, Pose } from './solver';

/**
 * What an Assembly tab keeps. Parts are referred to by their Part Studio's tab and the kernel's body name, and connectors
 * by the kernel's stable name for a face or edge, so they follow the part when it changes.
 */
export interface ConnectorRef {
  kind: 'face' | 'edge';
  /** A face's key or an edge's name. */
  ref: string;
  /** Which of that entity's inference points. */
  how: string;
  /** Where it was last, in the part's own coordinates. */
  frame: Frame;
}

export interface InstanceData {
  id: string;
  tab: string;
  body: string;
  /** The n in "Part 1 <n>". */
  number: number;
  /** A name given by hand, if any. */
  name: string | null;
  pose: Pose;
  fixed: boolean;
  hidden: boolean;
}

export interface MateData {
  id: string;
  name: string;
  type: MateType;
  /** The first and second connectors picked, and the instances they're on. */
  a: string;
  b: string;
  ca: ConnectorRef;
  cb: ConnectorRef;
  flip: boolean;
  quarter: number;
  suppressed: boolean;
}

export interface AssemblyData {
  format: 'schmishape-assembly';
  version: 1;
  instances: InstanceData[];
  mates: MateData[];
  next: number;
}

export const emptyAssembly = (): AssemblyData => ({ format: 'schmishape-assembly', version: 1, instances: [], mates: [], next: 1 });

export function parseAssembly(text: string | null): AssemblyData {
  if (!text) return emptyAssembly();
  try {
    const v = JSON.parse(text);
    if (v?.format === 'schmishape-assembly' && Array.isArray(v.instances) && Array.isArray(v.mates)) return v;
  } catch {
    /* It can't be read, so it's as if there were none. */
  }
  return emptyAssembly();
}

export const MATE_TYPES: MateType[] = ['fastened', 'revolute', 'slider', 'planar', 'cylindrical', 'pin-slot', 'ball', 'parallel'];
