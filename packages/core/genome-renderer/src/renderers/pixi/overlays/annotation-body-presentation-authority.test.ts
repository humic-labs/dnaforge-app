import { describe, expect, it } from 'vitest';
import {
  createAnnotationBodyFrameAuthoritySnapshotV1,
  createAnnotationBodyPresentationGenerationV1,
  emptyAnnotationBodyPresenterEligibility,
  isAnnotationBodyProductInGeneration,
  runExclusiveAnnotationBodyPresenter,
  runExclusiveEligibleAnnotationBodyPresenter,
  runSelectedAnnotationBodyPresenter,
  selectAnnotationBodyPresenter,
  shouldHoldCommittedAnnotationBodyGeneration,
} from './annotation-body-presentation-authority';

describe('annotation-body-presentation-authority', () => {
  it('selects compiled-broad first when multiple are eligible (sole owner)', () => {
    const eligibility = {
      ...emptyAnnotationBodyPresenterEligibility(),
      'compiled-broad': true,
      'prepacked-vector': true,
      'prebuilt-raster': true,
    };
    expect(selectAnnotationBodyPresenter(eligibility)).toBe('compiled-broad');
  });

  it('selects prepacked-vector when broad is ineligible', () => {
    const eligibility = {
      ...emptyAnnotationBodyPresenterEligibility(),
      'prepacked-vector': true,
      'prebuilt-raster': true,
    };
    expect(selectAnnotationBodyPresenter(eligibility)).toBe('prepacked-vector');
  });

  it('returns none when nothing is eligible', () => {
    expect(selectAnnotationBodyPresenter(emptyAnnotationBodyPresenterEligibility())).toBe('none');
  });

  it('freezes a generation receipt with ordered tracks, policy, and stable generationId', () => {
    const generation = createAnnotationBodyPresentationGenerationV1({
      commitEpoch: 3,
      orderedVisibleTrackIds: ['mRNA'],
      policy: { isoformMode: 'canonical', laneLimit: 12 },
      sourceFingerprint: 'abc',
      productKind: 'compiled-broad',
      productFingerprints: ['manifest-fp-1'],
    });
    expect(generation.commitEpoch).toBe(3);
    expect(generation.orderedVisibleTrackIds).toEqual(['mRNA']);
    expect(generation.policy.laneLimit).toBe(12);
    expect(generation.productKind).toBe('compiled-broad');
    expect(generation.generationId).toContain('compiled-broad');
    expect(generation.generationId).toContain('manifest-fp-1');
  });

  it('rejects duplicate track ids in a generation', () => {
    expect(() =>
      createAnnotationBodyPresentationGenerationV1({
        commitEpoch: 1,
        orderedVisibleTrackIds: ['mRNA', 'mRNA'],
        policy: { isoformMode: 'canonical', laneLimit: null },
      })
    ).toThrow(/duplicated/);
  });

  it('holds N-1 when a committed generation exists and the candidate is incomplete', () => {
    expect(
      shouldHoldCommittedAnnotationBodyGeneration({
        hasCommittedGeneration: true,
        replacementReadiness: 'pending',
      })
    ).toBe(true);
    expect(
      shouldHoldCommittedAnnotationBodyGeneration({
        hasCommittedGeneration: true,
        replacementReadiness: 'complete',
      })
    ).toBe(false);
    expect(
      shouldHoldCommittedAnnotationBodyGeneration({
        hasCommittedGeneration: false,
        replacementReadiness: 'pending',
      })
    ).toBe(false);
    expect(
      shouldHoldCommittedAnnotationBodyGeneration({
        hasCommittedGeneration: true,
        replacementReadiness: 'absent',
      })
    ).toBe(false);
  });

  it('builds a frame authority snapshot with sole selected owner', () => {
    const generation = createAnnotationBodyPresentationGenerationV1({
      commitEpoch: 2,
      orderedVisibleTrackIds: ['mRNA', 'lnc_RNA'],
      policy: { isoformMode: 'expanded', laneLimit: null },
    });
    const snapshot = createAnnotationBodyFrameAuthoritySnapshotV1({
      commitEpoch: 2,
      generation,
      eligibility: {
        ...emptyAnnotationBodyPresenterEligibility(),
        'compiled-broad': false,
        'prepacked-vector': true,
      },
    });
    expect(snapshot.frameOwner).toBe('prepacked-vector');
    expect(snapshot.generation?.orderedVisibleTrackIds).toEqual(['mRNA', 'lnc_RNA']);
  });

  it('runs exclusive present handlers in priority order and stops at first win', () => {
    const called: string[] = [];
    const result = runExclusiveAnnotationBodyPresenter({
      'compiled-broad': () => {
        called.push('compiled-broad');
        return false;
      },
      'prepacked-vector': () => {
        called.push('prepacked-vector');
        return true;
      },
      'prebuilt-raster': () => {
        called.push('prebuilt-raster');
        return true;
      },
    });
    expect(result).toEqual({ owner: 'prepacked-vector', presented: true });
    expect(called).toEqual(['compiled-broad', 'prepacked-vector']);
  });

  it('runs exclusive present only among eligible kinds', () => {
    const called: string[] = [];
    const result = runExclusiveEligibleAnnotationBodyPresenter({
      eligibility: {
        ...emptyAnnotationBodyPresenterEligibility(),
        'compiled-broad': false,
        'prepacked-vector': true,
        'prebuilt-raster': true,
      },
      handlers: {
        'compiled-broad': () => {
          called.push('compiled-broad');
          return true;
        },
        'prepacked-vector': () => {
          called.push('prepacked-vector');
          return true;
        },
        'prebuilt-raster': () => {
          called.push('prebuilt-raster');
          return true;
        },
      },
    });
    expect(result).toEqual({ owner: 'prepacked-vector', presented: true });
    expect(called).toEqual(['prepacked-vector']);
  });

  it('select-then-present never falls through when the selected handler fails', () => {
    const called: string[] = [];
    const result = runSelectedAnnotationBodyPresenter({
      eligibility: {
        ...emptyAnnotationBodyPresenterEligibility(),
        'compiled-broad': true,
        'prepacked-vector': true,
      },
      handlers: {
        'compiled-broad': () => {
          called.push('compiled-broad');
          return false;
        },
        'prepacked-vector': () => {
          called.push('prepacked-vector');
          return true;
        },
      },
    });
    expect(result).toEqual({
      selected: 'compiled-broad',
      owner: 'none',
      presented: false,
    });
    expect(called).toEqual(['compiled-broad']);
  });

  it('admits products into an unsealed generation and rejects foreign fingerprints once sealed', () => {
    expect(isAnnotationBodyProductInGeneration(null, 'fp-a')).toBe(true);
    const open = createAnnotationBodyPresentationGenerationV1({
      commitEpoch: 1,
      orderedVisibleTrackIds: ['mRNA'],
      policy: { isoformMode: 'canonical', laneLimit: 12 },
      productKind: 'prepacked-vector',
      productFingerprints: [],
    });
    expect(isAnnotationBodyProductInGeneration(open, 'fp-a')).toBe(true);
    const generation = createAnnotationBodyPresentationGenerationV1({
      commitEpoch: 1,
      orderedVisibleTrackIds: ['mRNA'],
      policy: { isoformMode: 'canonical', laneLimit: 12 },
      productKind: 'compiled-broad',
      productFingerprints: ['fp-a'],
    });
    expect(isAnnotationBodyProductInGeneration(generation, 'fp-a')).toBe(true);
    expect(isAnnotationBodyProductInGeneration(generation, 'fp-b')).toBe(false);
  });
});
