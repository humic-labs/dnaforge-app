// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { SequenceAnnotationOverlay } from './sequence-annotation-overlay';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('indexed overlay presenter ownership', () => {
  it('does not alias presenter fields onto the overlay prototype', () => {
    const overlay = new IndexedAnnotationOverlay();
    const layout = overlay.getLayoutStateForTest();
    const retained = overlay.getRetainedLinearPresenterForTest();

    expect(Object.hasOwn(overlay, '_layout')).toBe(false);
    expect(Object.hasOwn(overlay, 'lastFrameDoubleDraw')).toBe(false);
    expect(Object.hasOwn(Object.getPrototypeOf(overlay), '_layout')).toBe(false);
    expect(Object.hasOwn(Object.getPrototypeOf(overlay), 'lastFrameDoubleDraw')).toBe(false);
    expect(Object.hasOwn(layout, '_layout')).toBe(true);
    expect(Object.hasOwn(retained, 'lastFrameDoubleDraw')).toBe(true);

    const nextLayout = { annotationOffset: -12, annotationStep: 16 };
    layout._layout = nextLayout as typeof layout._layout;
    expect(layout._layout).toBe(nextLayout);
    expect((overlay as { _layout?: unknown })._layout).toBeUndefined();

    retained.lastFrameDoubleDraw = true;
    expect(retained.lastFrameDoubleDraw).toBe(true);
    expect((overlay as { lastFrameDoubleDraw?: boolean }).lastFrameDoubleDraw).toBeUndefined();
  });

  it('lets lastFrameDoubleDraw live only on the retained presenter', () => {
    const overlay = new IndexedAnnotationOverlay();
    const retained = overlay.getRetainedLinearPresenterForTest();

    retained.lastFrameDoubleDraw = true;
    expect(retained.lastFrameDoubleDraw).toBe(true);

    retained.lastFrameDoubleDraw = false;
    expect(retained.lastFrameDoubleDraw).toBe(false);
  });

  it('does not install indexed presenter accessors on the sequence overlay', () => {
    const sequence = new SequenceAnnotationOverlay();
    const indexed = new IndexedAnnotationOverlay();

    expect(Object.hasOwn(sequence, '_layout')).toBe(true);
    expect(Object.hasOwn(indexed, '_layout')).toBe(false);
    expect(Object.getPrototypeOf(sequence)).not.toBe(Object.getPrototypeOf(indexed));
    expect('requireCompiledBroadSurface' in sequence).toBe(false);
  });

  it('does not import a composition-root glue file', () => {
    const source = overlaySource();
    expect(source).not.toContain('indexed-annotation-overlay-glue');
    expect(source).not.toContain('createRetainedLinearOverlayGlue');
    expect(source).not.toContain('leftoverCollaborators');
    expect(source).not.toContain('collaborators.leftover');
    expect(source).toContain('this.attachPresenterCollaborators()');
  });
});
