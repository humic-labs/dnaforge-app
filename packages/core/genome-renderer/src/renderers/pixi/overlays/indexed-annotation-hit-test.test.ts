import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  hitTestCompiledBroadAnnotationInteraction,
  hitTestRetainedLinearTranscripts,
  prepackedAnnotationInteractionP99Ms,
  recordPrepackedAnnotationInteraction,
  type AnnotationHitTestHost,
} from './indexed-annotation-hit-test';
import type { PathMapper } from '../shared/path-mapper';
import { buildAnnotationPolicyProjectionTableV1 } from '../overview/annotation-policy-projection-v1';
import { buildPrepackedAnnotationInteractionIndexV2 } from '../overview/prepacked-annotation-interaction-index-v2';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function host(overrides: Partial<AnnotationHitTestHost> = {}): AnnotationHitTestHost {
  return {
    genomeLength: 1000,
    maxAnnotationLane: 3,
    prepackedAnnotationRuntimePolicy: null,
    prepackedAnnotationLastHitOwnerKey: null,
    prepackedAnnotationSceneResidents: new Map(),
    prepackedAnnotationInteractionQueries: 0,
    prepackedAnnotationInteractionLastVisitedNodes: 0,
    prepackedAnnotationInteractionMaxVisitedNodes: 0,
    prepackedAnnotationInteractionLastPrimitiveCandidates: 0,
    prepackedAnnotationInteractionMaxMs: 0,
    prepackedAnnotationInteractionDurations: new Float32Array(8),
    prepackedAnnotationInteractionDurationCursor: 0,
    prepackedAnnotationInteractionDurationCount: 0,
    annotationLayerTypesForPresentation: () => [],
    prepackedAnnotationScenePresentingResidents: () => [],
    compiledBroadAnnotationInteractionResidentForTrack: () => null,
    compiledBroadSurfaceLaneStart: () => 0,
    compiledBroadSurfaceOwnerForTrack: () => null,
    compiledBroadSurfaceInteractionResidentForTrack: () => null,
    prepackedAnnotationCenterScreenY: () => 0,
    prepackedResidentTrackOffsetPx: () => 0,
    prepackedPolicyTrackLaneForPrimitive: () => 0,
    ...overrides,
  };
}

describe('indexed annotation hit-test presenter', () => {
  it('keeps compiled-broad and prepacked hit testers out of the overlay class', () => {
    const source = overlaySource();
    expect(source).toContain('private readonly hits = new AnnotationHitTestController');
    expect(source).toContain('this.hits.hitTestCompiledBroadAnnotationInteraction(');
    expect(source).not.toContain('queryPrepackedAnnotationInteractionIndexV2(');
  });

  it('records interaction durations and reports p99', () => {
    const next = host();
    for (const duration of [1, 2, 3, 4, 5, 6, 7, 8]) {
      recordPrepackedAnnotationInteraction(next, duration, duration, duration);
    }
    expect(next.prepackedAnnotationInteractionQueries).toBe(8);
    expect(next.prepackedAnnotationInteractionMaxMs).toBe(8);
    expect(prepackedAnnotationInteractionP99Ms(next)).toBe(8);
  });

  it('keeps case-distinct annotation tracks separate during hit testing', () => {
    const resident = (annotationType: string, rendererId: number) => {
      const features = [
        {
          rendererId,
          startBp: 100,
          endBp: 200,
          lane: 0,
          direction: 'none' as const,
          displayName: annotationType,
          type: annotationType,
          transcriptId: null,
          sourceId: `source-${rendererId}`,
          canonicalIdentity: `${annotationType}|${rendererId}`,
        },
      ];
      const primitives = [
        {
          featureIndex: 0,
          startBp: 100,
          endBp: 200,
          offsetCenter: 0,
          halfH: 5,
          color: 0x3b82f6,
          alpha: 1,
          cdsFade: 0,
          dirSign: 0 as const,
        },
      ];
      const featureLookup = buildPrepackedAnnotationInteractionIndexV2(features, primitives);
      const policyProjection = buildAnnotationPolicyProjectionTableV1({
        features: [
          {
            annotationType,
            expandedLane: 0,
            expandedTrackLane: 0,
            canonicalLane: 0,
            canonicalTrackLane: 0,
          },
        ],
        expandedBandOrder: [annotationType],
        canonicalBandOrder: [annotationType],
      });
      return {
        ownerKey: `owner-${annotationType}`,
        featureLookup,
        policyProjection,
        metadata: { annotationBarHeightPx: 10 },
      };
    };
    let activeResident = resident('transposon:Dm88', 1);
    const next = host({
      compiledBroadAnnotationInteractionResidentForTrack: () => activeResident,
      compiledBroadSurfaceOwnerForTrack: () => ({
        manifest: { laneRowCssHeightPx: 16 },
        presenter: { isPresenting: true },
      }),
      prepackedAnnotationCenterScreenY: () => 50,
    });
    const path = {
      isArcMode: false,
      pixelsPerBp: 1,
      viewStartBp: 0,
      bpLeftX: (bp: number) => bp,
    } as unknown as PathMapper;

    expect(
      hitTestCompiledBroadAnnotationInteraction(next, 150, 50, path, ['transposon:DM88'])
    ).toBeNull();
    expect(next.prepackedAnnotationLastHitOwnerKey).toBeNull();

    activeResident = resident('transposon:DM88', 2);
    expect(
      hitTestCompiledBroadAnnotationInteraction(next, 150, 50, path, ['transposon:DM88'])
    ).toMatchObject({ payload: { id: 2, type: 'transposon:DM88' } });
    expect(next.prepackedAnnotationLastHitOwnerKey).toBe('owner-transposon:DM88');
  });

  it('preserves transcript identity through retained-mode hit testing', () => {
    const transcript = {
      id: 17,
      type: 'mRNA',
      start: 100,
      end: 200,
      direction: 'reverse' as const,
      displayName: 'TX17',
      color: 0x3b82f6,
      lane: 2,
      transcriptId: 'transcript-17',
      sourceId: 'source-17',
      canonicalIdentity: 'canonical-17',
      exons: [{ start: 101, end: 200 }],
    };
    const path = {
      isArcMode: false,
      viewStartBp: 0,
      viewEndBp: 500,
      bpLeftX: (bp: number) => bp,
      featureLabelPosAt: () => ({ x: 0, y: 50, angle: 0 }),
    } as unknown as PathMapper;

    expect(
      hitTestRetainedLinearTranscripts(
        {
          retainedLinearTranscriptFeatureSet: new Set([transcript]),
          scaledBarHeight: () => 10,
          featuresInRange: () => [transcript],
          featureOffset: () => 0,
          transcriptIntronGapRanges: () => [],
        },
        150,
        50,
        path
      )
    ).toEqual({
      kind: 'feature',
      payload: {
        id: 17,
        start: 100,
        end: 200,
        canonicalIdentity: 'canonical-17',
        displayName: 'TX17',
        type: 'mRNA',
        transcriptId: 'transcript-17',
        sourceId: 'source-17',
        lane: 2,
        direction: 'reverse',
      },
    });
  });
});
