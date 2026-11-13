import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { AnnotationImmediateDrawController } from './indexed-annotation-immediate-draw-controller';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('AnnotationImmediateDrawController', () => {
  it('holds outline and label caches on the controller', () => {
    const draw = new AnnotationImmediateDrawController();
    draw.outlineCache.set(1, []);
    draw.labelCache.set(1, { text: 'lacZ', width: 12 });
    expect(draw.outlineCache.get(1)).toEqual([]);
    expect(draw.labelCache.get(1)?.text).toBe('lacZ');
  });

  it('does not keep outlineCache as overlay-owned data', () => {
    const overlay = new IndexedAnnotationOverlay();
    const draw = overlay.getImmediateDrawControllerForTest();
    expect(Object.hasOwn(overlay, 'outlineCache')).toBe(false);
    expect(Object.hasOwn(overlay, 'labelCache')).toBe(false);
    expect(draw).toBeInstanceOf(AnnotationImmediateDrawController);
    expect(Object.hasOwn(draw, 'outlineCache')).toBe(true);

    const source = overlaySource();
    expect(source).toContain(
      'private readonly immediateDraw = new AnnotationImmediateDrawController'
    );
    expect(source).not.toContain('this as unknown as ImmediateDrawHost');
    expect(source).not.toContain('this as unknown as CdsLabelStripDrawHost');
    expect(source).not.toContain('this as unknown as StandardFeatureDrawHost');
    expect(source).not.toContain('this as unknown as TranscriptGlyphDrawHost');
    expect(source).not.toContain('this as unknown as PillDrawHost');
    expect(source).not.toContain('this as unknown as FeatureTransitionDrawHost');
  });
});
