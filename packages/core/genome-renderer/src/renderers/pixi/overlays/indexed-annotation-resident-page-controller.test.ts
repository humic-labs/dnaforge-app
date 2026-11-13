// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { AnnotationResidentPageController } from './indexed-annotation-resident-page-controller';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('AnnotationResidentPageController', () => {
  it('rejects ingest without a genome without constructing IndexedAnnotationOverlay', () => {
    const pages = new AnnotationResidentPageController();
    expect(
      pages.ingestAnnotationResidentPages({
        contract: 'annotation-resident-page-publication.v1',
        sourceIdentity: 'src',
        genomeLengthBp: 100,
        policyKey: 'pol',
        generation: 1,
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: 0, endBp: 100 }],
        pages: [],
      })
    ).toEqual({ status: 'rejected', reason: 'no-genome' });
  });

  it('does not keep resident-page fields as overlay-owned data', () => {
    const overlay = new IndexedAnnotationOverlay();
    const pages = overlay.getResidentPageControllerForTest();

    expect(Object.hasOwn(overlay, 'annotationResidentPageStreams')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationResidentPageStore')).toBe(false);
    expect(Object.hasOwn(overlay, 'activeAnnotationResidentPageStreamKey')).toBe(false);
    expect(Object.hasOwn(overlay, 'residentAnnotationViewportSelectionCache')).toBe(false);
    expect(pages).toBeInstanceOf(AnnotationResidentPageController);
    expect(Object.hasOwn(pages, 'annotationResidentPageStreams')).toBe(true);

    const source = overlaySource();
    expect(source).toContain(
      'private readonly residentPages = new AnnotationResidentPageController();'
    );
    expect(source).toContain('this.residentPages.attach({');
    expect(source).not.toContain('createResidentPagesGlue');
    expect(source).not.toContain('this as unknown as ResidentPageFeatureHost');
    expect(source).not.toContain('this as unknown as ResidentPageLifecycleHost');
  });
});
