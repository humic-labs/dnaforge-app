// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { AnnotationBodyFrameController } from './indexed-annotation-body-frame-controller';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('AnnotationBodyFrameController', () => {
  it('commits a body owner on the controller without constructing IndexedAnnotationOverlay', () => {
    const frame = new AnnotationBodyFrameController({
      maxAnnotationLane: 2,
      prepackedAnnotationRuntimePolicy: { isoformMode: 'canonical', laneLimit: null },
      currentAnnotationSourceFingerprint: 'src',
      currentAnnotationPlacementFingerprint: 'place',
      prepackedAnnotationSceneResidents: new Map(),
      annotationLayerTypesForPresentation: () => ['mRNA'],
      compiledBroadSurfaceOwnerForTrack: (trackId) =>
        trackId === 'mRNA' ? { manifest: { manifestFingerprint: 'mrna-fp' } } : null,
      compiledBroadSurfaceManifestFingerprintForTrack: (trackId) =>
        trackId === 'mRNA' ? 'mrna-fp' : null,
    });

    frame.noteAnnotationBodyFrameOwner('compiled-broad');

    expect(frame.annotationBodyFrameOwner).toBe('compiled-broad');
    expect(frame.annotationBodyFrameEligibility['compiled-broad']).toBe(true);
    expect(frame.annotationBodyPresentationCommitEpoch).toBe(1);
    expect(frame.annotationBodyPresentationGeneration?.productKind).toBe('compiled-broad');
    expect(frame.annotationBodyPresentationGeneration?.productFingerprints).toEqual(['mrna-fp']);
  });

  it('does not keep body-frame fields as overlay-owned data', () => {
    const overlay = new IndexedAnnotationOverlay();
    const frame = overlay.getBodyFrameControllerForTest();

    expect(Object.hasOwn(overlay, 'annotationBodyFrameOwner')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationBodyFrameEligibility')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationBodyPresentationGeneration')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationBodyPresentationCommitEpoch')).toBe(false);
    expect(frame).toBeInstanceOf(AnnotationBodyFrameController);
    expect(Object.hasOwn(frame, 'annotationBodyFrameOwner')).toBe(true);
    expect(frame.annotationBodyFrameOwner).toBe('none');

    const source = overlaySource();
    expect(source).toContain('private readonly bodyFrame = new AnnotationBodyFrameController();');
    expect(source).toContain('this.bodyFrame.attach({');
    expect(source).not.toContain('createBodyFrameGlue');
    expect(source).not.toContain('this as unknown as BodyCommitHost');
    expect(source).not.toContain('this as unknown as BodyOwnerHost');
    expect(source).not.toContain('this as unknown as BodyProbeHost');
    expect(source).not.toContain('this as unknown as ExclusiveBodyFrameHost');
  });
});
