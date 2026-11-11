import type { V3 } from '../viewport/math';

export interface ToolResult {
  ok: boolean;
  text: string;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  faceIds: Uint32Array;
  indices: Uint32Array;
  segments: Float32Array;
  segmentIds: Uint32Array;
  faces: number;
  edges: number;
  /** Each separate solid, by index into the faces and edges above. */
  /** Each body, by the kernel's name for it, such as f3 or f3.2. A sheet is a surface, with no inside. */
  parts: { name: string; sheet: boolean; faces: number[]; edges: number[] }[];
  min: V3;
  max: V3;
  error?: string;
}

/** The kernel panicked, or was stopped. The instance is gone, and so is its document. */
export class EngineCrash extends Error {}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Engine {
  private worker!: Worker;
  private next = 1;
  private pending = new Map<number, Pending>();
  ready!: Promise<void>;
  onBusyChange: ((busy: boolean) => void) | null = null;
  /** The instance is gone with its document. Whoever holds the document has to put it back. */
  onCrash: ((message: string) => void) | null = null;

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.ready) return resolve();
        if (m.failed) return reject(new Error(m.failed));
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (this.pending.size === 0) this.onBusyChange?.(false);
        if (m.ok) p.resolve(m.result);
        else {
          this.onCrash?.(m.crash);
          p.reject(new EngineCrash(m.crash));
        }
      };
      this.worker.onerror = (e) => reject(new Error(e.message));
    });
  }

  private send<T>(op: string, extra: object = {}): Promise<T> {
    return this.ready.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const id = this.next++;
          if (this.pending.size === 0) this.onBusyChange?.(true);
          this.pending.set(id, { resolve, reject });
          this.worker.postMessage({ id, op, ...extra });
        }),
    );
  }

  /** Calls a tool from the CoreShape tool layer: the same call an AI makes. */
  async call(name: string, args: object = {}): Promise<ToolResult> {
    const raw = await this.send<string>('call', { message: JSON.stringify({ name, arguments: args }) });
    const parsed = JSON.parse(raw);
    return {
      ok: !parsed.isError,
      content: parsed.content,
      text: parsed.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n'),
    };
  }

  async mesh(upto: number | null, draft = false): Promise<MeshData> {
    const m = await this.send<any>('mesh', { upto: upto ?? -1, draft });
    const info = JSON.parse(m.info);
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    const p: Float32Array = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    }
    return { ...m, faces: info.faces ?? 0, edges: info.edges ?? 0, parts: info.parts ?? [], min, max, error: info.ok ? undefined : info.error };
  }

  async env(): Promise<Record<string, number>> {
    const v = JSON.parse(await this.send<string>('env'));
    return v.error ? {} : v;
  }

  async tools(): Promise<unknown[]> {
    return JSON.parse(await this.send<string>('tools')).result.tools;
  }

  stl(): Promise<Uint8Array> {
    return this.send<Uint8Array>('stl');
  }

  /** Stops whatever is running by replacing the worker. The caller has to restore the document. */
  stop() {
    this.worker.terminate();
    const stopped = [...this.pending.values()];
    this.pending.clear();
    this.onBusyChange?.(false);
    this.spawn();
    this.onCrash?.('Stopped');
    for (const p of stopped) p.reject(new EngineCrash('Stopped'));
  }
}

export const engine = new Engine();
