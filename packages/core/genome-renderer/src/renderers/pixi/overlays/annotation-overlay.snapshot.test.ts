// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotationPresentationSnapshot, Feature, Genome } from '../../../types';

let AnnotationOverlayClass: typeof import('./annotation-overlay').AnnotationOverlay;

beforeAll(async () => {
  ({ AnnotationOverlay: AnnotationOverlayClass } = await import('./annotation-overlay'));
});

beforeEach(() => {
  const target = window as unknown as {
    __webglAnnotationSnapshotApplyCount?: number;
    __webglAnnotationSnapshotApplyLog?: unknown[];
  };
  target.__webglAnnotationSnapshotApplyCount = 0;
  target.__webglAnnotationSnapshotApplyLog = [];
});

const SOURCE = 'grch38-source-v1';
const LENGTH = 3_088_269_832;

function shell(): Genome {
  return {
    name: 'GRCh38 human',
    sourceIdentity: SOURCE,
    length: LENGTH,
    circular: false,
    features: [],
  };
}

function features(count: number): Feature[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    type: 'mRNA',
    start: 10_000 + index * 1_000,
    end: 10_500 + index * 1_000,
    direction: index % 2 === 0 ? ('forward' as const) : ('reverse' as const),
    displayName: `TX-${index + 1}`,
    color: 0x3b82f6,
    lane: index % 12,
    canonicalIdentity: `annotation.v2:TX-${index + 1}`,
  }));
}

function snapshot(input: {
  generation: number;
  count: number;
  policyKey?: string;
  sourceIdentity?: string;
  genomeLengthBp?: number;
  exactCoverage?: AnnotationPresentationSnapshot['exactCoverage'];
}): AnnotationPresentationSnapshot {
  return {
    contract: 'annotation-presentation-snapshot.v1',
    sourceIdentity: input.sourceIdentity ?? SOURCE,
    genomeLengthBp: input.genomeLengthBp ?? LENGTH,
    policyKey: input.policyKey ?? 'canonical:lanes=12:layers=mRNA:glyph=v2',
    generation: input.generation,
    features: features(input.count),
    requestedLayerTypes: ['mRNA'],
    layout: { maxAnnotationLane: 11, maxCdsLane: -1 },
    exactCoverage: input.exactCoverage ?? [{ startBp: 50_000_000, endBp: 52_000_000 }],
  };
}

describe('AnnotationOverlay annotation-only presentation snapshots', () => {
  it('rejects a sidecar before a source shell is loaded', () => {
    const overlay = new AnnotationOverlayClass();
    expect(
      overlay.setAnnotationPresentationSnapshot(snapshot({ generation: 1, count: 1 }))
    ).toEqual({ status: 'rejected', reason: 'no-genome' });
    overlay.destroy();
  });

  it.each([
    ['null snapshot', null],
    ['undefined snapshot', undefined],
    ['missing layout', { ...snapshot({ generation: 1, count: 1 }), layout: undefined }],
    ['null layout', { ...snapshot({ generation: 1, count: 1 }), layout: null }],
    ['empty layout', { ...snapshot({ generation: 1, count: 1 }), layout: {} }],
    ['missing features', { ...snapshot({ generation: 1, count: 1 }), features: undefined }],
    ['null features', { ...snapshot({ generation: 1, count: 1 }), features: null }],
    ['null feature entry', { ...snapshot({ generation: 1, count: 1 }), features: [null] }],
    [
      'missing exact coverage',
      { ...snapshot({ generation: 1, count: 1 }), exactCoverage: undefined },
    ],
    ['null exact coverage', { ...snapshot({ generation: 1, count: 1 }), exactCoverage: null }],
    [
      'null exact coverage entry',
      { ...snapshot({ generation: 1, count: 1 }), exactCoverage: [null] },
    ],
    [
      'missing requested layers',
      { ...snapshot({ generation: 1, count: 1 }), requestedLayerTypes: undefined },
    ],
    [
      'null requested layer entry',
      { ...snapshot({ generation: 1, count: 1 }), requestedLayerTypes: [null] },
    ],
  ])('never throws for malformed JS input: %s', (_label, malformed) => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(shell());
    let result: unknown;
    expect(() => {
      result = overlay.setAnnotationPresentationSnapshot(malformed as never);
    }).not.toThrow();
    expect(result).toEqual({ status: 'rejected', reason: 'invalid-contract' });
    expect(overlay.getDebugSnapshot().featureCount).toBe(0);
    overlay.destroy();
  });

  it('atomically applies semantic 62 -> 40 -> 28 publications with telemetry', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(shell());

    expect(
      overlay.setAnnotationPresentationSnapshot(snapshot({ generation: 1, count: 62 }))
    ).toEqual({ status: 'applied', generation: 1, invalidatedHover: true });
    expect(overlay.getDebugSnapshot().featureCount).toBe(62);
    expect(
      overlay.setAnnotationPresentationSnapshot(snapshot({ generation: 2, count: 40 }))
    ).toEqual({ status: 'applied', generation: 2, invalidatedHover: true });
    expect(overlay.getDebugSnapshot().featureCount).toBe(40);
    expect(
      overlay.setAnnotationPresentationSnapshot(snapshot({ generation: 3, count: 28 }))
    ).toEqual({ status: 'applied', generation: 3, invalidatedHover: true });

    expect(overlay.getDebugSnapshot().featureCount).toBe(28);
    expect(overlay.getLayoutStateForTest().annotationExactCoverage).toEqual([
      { startBp: 50_000_000, endBp: 52_000_000 },
    ]);
    expect(
      (window as unknown as { __webglAnnotationSnapshotApplyCount?: number })
        .__webglAnnotationSnapshotApplyCount
    ).toBe(3);
    expect(
      (
        window as unknown as { __webglAnnotationSnapshotApplyLog?: Array<{ featureCount: number }> }
      ).__webglAnnotationSnapshotApplyLog?.map((entry) => entry.featureCount)
    ).toEqual([62, 40, 28]);

    overlay.destroy();
  });

  it('rejects stale, colliding, wrong-source, and wrong-length publications without mutation', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(shell());
    const current = snapshot({ generation: 7, count: 28 });
    expect(overlay.setAnnotationPresentationSnapshot(current).status).toBe('applied');

    expect(
      overlay.setAnnotationPresentationSnapshot(snapshot({ generation: 6, count: 40 }))
    ).toEqual({ status: 'rejected', reason: 'stale-generation' });
    expect(overlay.setAnnotationPresentationSnapshot({ ...current })).toEqual({
      status: 'rejected',
      reason: 'generation-collision',
    });
    expect(
      overlay.setAnnotationPresentationSnapshot(
        snapshot({ generation: 8, count: 40, sourceIdentity: 'other-source' })
      )
    ).toEqual({ status: 'rejected', reason: 'source-mismatch' });
    expect(
      overlay.setAnnotationPresentationSnapshot(
        snapshot({ generation: 8, count: 40, genomeLengthBp: LENGTH - 1 })
      )
    ).toEqual({ status: 'rejected', reason: 'length-mismatch' });

    expect(overlay.getDebugSnapshot().featureCount).toBe(28);
    expect(
      (window as unknown as { __webglAnnotationSnapshotApplyCount?: number })
        .__webglAnnotationSnapshotApplyCount
    ).toBe(1);
    overlay.destroy();
  });

  it('keeps policy generations independent and reapplies a previously accepted inactive policy', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(shell());
    const canonical = snapshot({ generation: 12, count: 28, policyKey: 'canonical:lanes=12' });
    const expanded = snapshot({ generation: 1, count: 62, policyKey: 'expanded:lanes=12' });

    expect(overlay.setAnnotationPresentationSnapshot(canonical).status).toBe('applied');
    expect(overlay.setAnnotationPresentationSnapshot(expanded).status).toBe('applied');
    expect(overlay.getDebugSnapshot().featureCount).toBe(62);
    expect(overlay.setAnnotationPresentationSnapshot(canonical).status).toBe('applied');
    expect(overlay.getDebugSnapshot().featureCount).toBe(28);
    expect(overlay.setAnnotationPresentationSnapshot(canonical)).toEqual({
      status: 'noop',
      generation: 12,
    });

    overlay.destroy();
  });

  it('accepts an exact valid-empty publication and rejects malformed coverage', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(shell());
    const empty = snapshot({
      generation: 1,
      count: 0,
      exactCoverage: [{ startBp: 123_000, endBp: 125_000 }],
    });
    expect(overlay.setAnnotationPresentationSnapshot(empty).status).toBe('applied');
    expect(overlay.getDebugSnapshot().featureCount).toBe(0);
    expect(overlay.getLayoutStateForTest().annotationExactCoverage).toEqual([
      { startBp: 123_000, endBp: 125_000 },
    ]);

    expect(
      overlay.setAnnotationPresentationSnapshot(
        snapshot({
          generation: 2,
          count: 0,
          exactCoverage: [{ startBp: 125_000, endBp: 123_000 }],
        })
      )
    ).toEqual({ status: 'rejected', reason: 'invalid-contract' });
    expect(overlay.getLayoutStateForTest().annotationExactCoverage).toEqual([
      { startBp: 123_000, endBp: 125_000 },
    ]);
    overlay.destroy();
  });

  it('never mutates caller-owned frozen feature publications during lane preparation', () => {
    const overlay = new AnnotationOverlayClass();
    overlay.loadGenome(shell());
    const frozenFeature = Object.freeze({ ...features(1)[0], lane: 7 });
    const publication = {
      ...snapshot({ generation: 1, count: 0 }),
      features: Object.freeze([frozenFeature]),
      layout: Object.freeze({ maxAnnotationLane: 11, maxCdsLane: -1 }),
      exactCoverage: Object.freeze([Object.freeze({ startBp: 10_000, endBp: 20_000 })]),
    } satisfies AnnotationPresentationSnapshot;

    expect(() => overlay.setAnnotationPresentationSnapshot(publication)).not.toThrow();
    expect(frozenFeature.lane).toBe(7);
    expect(Object.isFrozen(frozenFeature)).toBe(true);
    overlay.destroy();
  });
});
