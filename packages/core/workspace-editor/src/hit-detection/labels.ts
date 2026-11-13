import type { LabelBounds } from './types';

export function hitTestLabels<T>(
  x: number,
  y: number,
  labels: ReadonlyArray<{ labelBounds: LabelBounds } & T>
): T | null {
  for (const label of labels) {
    const bounds = label.labelBounds;
    if (
      x >= bounds.x &&
      x <= bounds.x + bounds.width &&
      y >= bounds.y &&
      y <= bounds.y + bounds.height
    ) {
      return label;
    }
  }
  return null;
}

export function detectCutSiteLabelHit<T extends { labelBounds: LabelBounds; cutSite: unknown }>(
  x: number,
  y: number,
  renderedSites: readonly T[]
): T['cutSite'] | null {
  const hit = hitTestLabels(x, y, renderedSites);
  return hit ? hit.cutSite : null;
}

export function detectGGLabelHit<T extends { labelBounds: LabelBounds }>(
  x: number,
  y: number,
  renderedLabels: readonly T[]
): T | null {
  return hitTestLabels(x, y, renderedLabels);
}
