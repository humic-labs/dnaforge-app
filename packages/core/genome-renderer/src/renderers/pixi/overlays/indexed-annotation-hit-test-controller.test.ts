import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { AnnotationHitTestController } from './indexed-annotation-hit-test-controller';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('AnnotationHitTestController', () => {
  it('records interaction telemetry on the controller', () => {
    const hits = new AnnotationHitTestController();
    hits.recordPrepackedAnnotationInteraction(3, 2, 4.5);
    expect(hits.prepackedAnnotationInteractionQueries).toBe(1);
    expect(hits.prepackedAnnotationInteractionLastVisitedNodes).toBe(3);
    expect(hits.prepackedAnnotationInteractionP99Ms()).toBe(4.5);
    expect(hits.hitCache).toEqual([]);
  });

  it('does not keep hit-cache or interaction telemetry as overlay-owned data', () => {
    const overlay = new IndexedAnnotationOverlay();
    const hits = overlay.getHitTestControllerForTest();

    expect(Object.hasOwn(overlay, 'hitCache')).toBe(false);
    expect(Object.hasOwn(overlay, 'prepackedAnnotationInteractionQueries')).toBe(false);
    expect(Object.hasOwn(overlay, 'prepackedAnnotationLastHitOwnerKey')).toBe(false);
    hits.prepackedAnnotationLastHitOwnerKey = 'owner-a';
    expect(overlay.prepackedAnnotationLastHitOwnerKey).toBe('owner-a');
    expect(hits).toBeInstanceOf(AnnotationHitTestController);
    expect(Object.hasOwn(hits, 'hitCache')).toBe(true);
    expect(hits.hitCache).toEqual([]);

    const source = overlaySource();
    expect(source).toContain('private readonly hits = new AnnotationHitTestController');
    expect(source).not.toContain('this as unknown as AnnotationHitDispatchHost');
    expect(source).not.toContain('this as unknown as AnnotationHitTestHost');
    expect(source).not.toContain('this as unknown as RetainedTranscriptHitHost');
  });
});
