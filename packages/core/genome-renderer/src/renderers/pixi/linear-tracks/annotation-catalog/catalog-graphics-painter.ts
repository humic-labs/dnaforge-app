import type { Graphics } from 'pixi.js';

import { LineBatch, type ShapeBatch } from './catalog-glyph-batches';

export function paintCatalogBatches(graphics: Graphics, batches: readonly ShapeBatch[]): void {
  graphics.clear();
  for (const batch of batches) {
    if (batch.shapeCount === 0) continue;

    const { rects, polygonPoints, polygonSizes, circles } = batch;
    for (let i = 0; i < rects.length; i += 4) {
      graphics.rect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3]);
    }
    let point = 0;
    for (const size of polygonSizes) {
      graphics.moveTo(polygonPoints[point], polygonPoints[point + 1]);
      for (let v = 1; v < size; v++) {
        graphics.lineTo(polygonPoints[point + 2 * v], polygonPoints[point + 2 * v + 1]);
      }
      graphics.closePath();
      point += 2 * size;
    }
    for (let i = 0; i < circles.length; i += 3) {
      graphics.circle(circles[i], circles[i + 1], circles[i + 2]);
    }
    if (batch instanceof LineBatch) {
      const { segments } = batch;
      for (let i = 0; i < segments.length; i += 4) {
        graphics.moveTo(segments[i], segments[i + 1]).lineTo(segments[i + 2], segments[i + 3]);
      }
    }

    const { paint } = batch;
    if (paint.mode === 'fill') {
      graphics.fill({ color: paint.color, alpha: paint.alpha });
    } else {
      graphics.stroke({ color: paint.color, alpha: paint.alpha, width: paint.widthPx });
    }
  }
}
