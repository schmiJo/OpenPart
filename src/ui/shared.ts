import { startSketch } from '../sketch/controller';
import type { Plane } from '../sketch/geometry';
import { cancelDialog } from '../features/dialog';

export function beginSketchOn(plane: Plane) {
  void cancelDialog().then(() => startSketch(plane));
}
