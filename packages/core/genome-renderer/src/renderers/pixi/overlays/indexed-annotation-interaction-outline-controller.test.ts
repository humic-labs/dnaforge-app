import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { AnnotationInteractionOutlineController } from './indexed-annotation-interaction-outline-controller';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('AnnotationInteractionOutlineController', () => {
  it('holds outline command counts on the controller', () => {
    const outlines = new AnnotationInteractionOutlineController();
    outlines.lastInteractionOutlineCommandCount = 4;
    expect(outlines.lastInteractionOutlineCommandCount).toBe(4);
  });

  it('does not keep outline command counts as overlay-owned data', () => {
    const overlay = new IndexedAnnotationOverlay();
    const outlines = overlay.getInteractionOutlineControllerForTest();

    expect(Object.hasOwn(overlay, 'lastInteractionOutlineCommandCount')).toBe(false);
    expect(Object.hasOwn(overlay, 'interactionGraphics')).toBe(false);
    expect(outlines).toBeInstanceOf(AnnotationInteractionOutlineController);
    expect(Object.hasOwn(outlines, 'lastInteractionOutlineCommandCount')).toBe(true);
    expect(Object.hasOwn(outlines, 'interactionGraphics')).toBe(true);
    expect(outlines.lastInteractionOutlineCommandCount).toBe(0);

    const source = overlaySource();
    expect(source).toContain(
      'private readonly outlines = new AnnotationInteractionOutlineController'
    );
    expect(source).not.toContain('this as unknown as EnsureInteractionOutlineHost');
    expect(source).not.toContain('this as unknown as InteractionOutlineHost');
    expect(source).not.toContain('this as unknown as CompiledBroadStrokeHost');
  });
});
