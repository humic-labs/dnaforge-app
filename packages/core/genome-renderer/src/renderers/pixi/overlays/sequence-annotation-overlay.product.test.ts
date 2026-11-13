import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PixiLinearRenderer } from '../linear-renderer';
import { PixiStadiumRenderer } from '../stadium-renderer';
import { SequenceAnnotationOverlay } from './sequence-annotation-overlay';

const BANNED = [
  'vector-tile-compositor',
  'rtt-glyph-tile-compositor',
  'compile-prepacked-annotation-scene',
  'tile-pyramid-coords',
  'genome-wide-texture-cache-layer',
  'annotation-sidecar-raster-presenter',
  'bounded-annotation-broad-surface',
  'requireCompiledBroadSurface',
  'loadCompiledBroadSurfaceManifest',
  'loadCompiledBroadAnnotationInteraction',
  'admitCompiledBroadSurfaceRgbaCell',
  'loadPrepackedAnnotationScene',
  'installSidecarRasterSource',
  'ensureTilePyramidVectorCompositor',
  'tryCompositeTilePyramid',
  'compiledBroadSurfaceRequirement',
  'sequence-overlay-indexed-stubs',
  'compiledBroadSurfacePresenter',
  'prepackedAnnotationSceneLayer',
  'tilePyramidVectorCompositor',
  'sidecarRasterPresenter',
  'rttGlyphTilePyramidCompositor',
  'updateAnnotationPresentationPolicy',
  'loadPrebuiltGenomeWideTexture',
  'AnnotationResidentPageStore',
  'ingestAnnotationResidentPages',
  'setAnnotationFlatPresentationSnapshot',
  'setAnnotationPresentationSnapshot',
  'PREBUILT_ANNOTATION_RASTER_SOURCE_PLACEMENT_V1',
  '__DNA708_FORCE_DOUBLE_DRAW',
  'activeResidentPublicationOwnsAnnotationBodyFallback',
];

function sourcePath(): string {
  const metaUrl = import.meta.url;
  if (metaUrl.startsWith('file:')) {
    return join(dirname(fileURLToPath(metaUrl)), 'sequence-annotation-overlay.ts');
  }
  return join(process.cwd(), 'src/renderers/pixi/overlays/sequence-annotation-overlay.ts');
}

describe('SequenceAnnotationOverlay product cut', () => {
  it('is a real class, not an alias of AnnotationOverlay', async () => {
    const { AnnotationOverlay } = await import('./annotation-overlay');
    expect(SequenceAnnotationOverlay).not.toBe(AnnotationOverlay);
    expect(new SequenceAnnotationOverlay()).not.toBeInstanceOf(AnnotationOverlay);
  });

  it('does not import or declare indexed APIs', () => {
    const source = readFileSync(sourcePath(), 'utf8');
    for (const token of BANNED) {
      expect(source, token).not.toContain(token);
    }
  });

  it('is what stadium and the linear default construct', () => {
    expect(Reflect.get(new PixiStadiumRenderer(), 'annotationOverlay')).toBeInstanceOf(
      SequenceAnnotationOverlay
    );
    expect(Reflect.get(new PixiLinearRenderer(), 'annotationOverlay')).toBeInstanceOf(
      SequenceAnnotationOverlay
    );
  });

  it('returns unavailable for resident-page selection', () => {
    const overlay = new SequenceAnnotationOverlay();
    expect(overlay.selectResidentAnnotationFeaturesForViewport(0, 100, null).status).toBe(
      'unavailable'
    );
  });

  it('does not implement indexed publication ingress', () => {
    const overlay = new SequenceAnnotationOverlay();
    expect('ingestAnnotationResidentPages' in overlay).toBe(false);
    expect('setAnnotationFlatPresentationSnapshot' in overlay).toBe(false);
    expect('setAnnotationPresentationSnapshot' in overlay).toBe(false);
  });

  it('stays unavailable after loadGenome and never owns a body-authority generation', () => {
    const overlay = new SequenceAnnotationOverlay();
    overlay.loadGenome({
      name: 'pUC19',
      sourceIdentity: 'pUC19',
      length: 2686,
      circular: true,
      sequenceAvailable: true,
      features: [
        {
          id: 1,
          type: 'CDS',
          start: 100,
          end: 400,
          direction: 'forward',
          color: 0x3366ff,
          lane: 0,
          displayName: 'lacZ',
        },
      ],
    });
    expect(overlay.selectResidentAnnotationFeaturesForViewport(0, 500, null)).toEqual({
      status: 'unavailable',
      key: null,
      features: overlay.getAnnotationPresentationFeatures(),
    });
    expect(overlay.getAnnotationBodyPresentationAuthoritySnapshot()).toMatchObject({
      commitEpoch: 0,
      frameOwner: 'none',
      generation: null,
    });
  });

  it('loads a circular origin-spanning plasmid without indexed raster APIs', () => {
    const overlay = new SequenceAnnotationOverlay();
    expect(() =>
      overlay.loadGenome({
        name: 'pUC19',
        sourceIdentity: 'pUC19',
        length: 2686,
        circular: true,
        sequenceAvailable: true,
        features: [
          {
            id: 1,
            type: 'CDS',
            start: 2600,
            end: 80,
            direction: 'forward',
            color: 0x3366ff,
            lane: 0,
            displayName: 'origin-span',
          },
        ],
      })
    ).not.toThrow();
    expect('requireCompiledBroadSurface' in overlay).toBe(false);
    expect(Object.hasOwn(overlay, '_layout')).toBe(true);
    expect(overlay.selectResidentAnnotationFeaturesForViewport(0, 100, null).status).toBe(
      'unavailable'
    );
  });
});
