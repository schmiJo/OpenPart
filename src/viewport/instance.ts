import type { Renderer } from './renderer';

/** The one viewport. Set when it mounts. */
export const view: { renderer: Renderer | null; redraw: () => void; redrawCube: () => void } = { renderer: null, redraw: () => {}, redrawCube: () => {} };
