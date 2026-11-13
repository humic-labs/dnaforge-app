// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import { useCutSiteScanner } from './cut-site-scanner';

function enzyme(
  partial: Partial<RestrictionEnzyme> & { name: string; recognition_sequence: string }
): RestrictionEnzyme {
  const base: RestrictionEnzyme = {
    name: partial.name,
    recognition_sequence: partial.recognition_sequence,
    recognition_sequence_length:
      partial.recognition_sequence_length ?? partial.recognition_sequence.length,
    cut_position_top: 0,
    cut_position_bottom: partial.recognition_sequence.length,
    overhang_type: null,
    overhang_length: null,
    enzyme_type: 'Type_II',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  };
  return { ...base, ...partial };
}

const EcoRI = enzyme({
  name: 'EcoRI',
  recognition_sequence: 'GAATTC',
  cut_position_top: 1,
  cut_position_bottom: 5,
});

const ISceI = enzyme({
  name: 'I-SceI',
  recognition_sequence: 'TAGGGATAACAGGGTAAT',
  cut_position_top: 13,
  cut_position_bottom: 9,
});

const BsaI = enzyme({
  name: 'BsaI',
  recognition_sequence: 'GGTCTC',
  cut_position_top: 7,
  cut_position_bottom: 11,
});

const SEQ =
  'AAATTGAATTCAAA' +
  'CCCCCC' +
  'TAGGGATAACAGGGTAAT' +
  'GGGGGG' +
  'AATGAATTCAAAA' +
  'TTTTTT' +
  'GGGGAATTCGGGGGGGGGGGGG';

describe('useCutSiteScanner — persistence  v2)', () => {
  it('I1: hits become non-empty even when the FIRST render had empty activeEnzymes (the v1 invisible-markers bug)', async () => {
    const { result, rerender } = renderHook(
      ({ enzymes }: { enzymes: RestrictionEnzyme[] }) =>
        useCutSiteScanner({ sequence: SEQ, activeEnzymes: enzymes }),
      { initialProps: { enzymes: [] as RestrictionEnzyme[] } }
    );

    expect(result.current[0].hits).toEqual([]);

    rerender({ enzymes: [EcoRI, ISceI] });

    await waitFor(
      () => {
        expect(result.current[0].phase).toBe('complete');
      },
      { timeout: 2000 }
    );

    expect(result.current[0].hits.length).toBeGreaterThan(0);
    const ecoHits = result.current[0].hits.filter((h) => h.enzyme.name === 'EcoRI');
    const sceHits = result.current[0].hits.filter((h) => h.enzyme.name === 'I-SceI');
    expect(ecoHits).toHaveLength(3);
    expect(sceHits).toHaveLength(1);
  });

  it('I2: re-rendering with the same inputs after scan completes leaves hits non-empty', async () => {
    const { result, rerender } = renderHook(
      ({ enzymes }: { enzymes: RestrictionEnzyme[] }) =>
        useCutSiteScanner({ sequence: SEQ, activeEnzymes: enzymes }),
      { initialProps: { enzymes: [EcoRI] as RestrictionEnzyme[] } }
    );

    await waitFor(() => {
      expect(result.current[0].phase).toBe('complete');
    });
    expect(result.current[0].hits.length).toBe(3);

    for (let i = 0; i < 5; i++) {
      rerender({ enzymes: [EcoRI] });
      expect(result.current[0].hits.length).toBe(3);
    }
  });

  it('I2b: hits never go from non-empty to empty during a single hook lifetime if inputs are stable', async () => {
    const observedCounts: number[] = [];
    const { result, rerender } = renderHook(
      ({ enzymes }: { enzymes: RestrictionEnzyme[] }) => {
        const r = useCutSiteScanner({ sequence: SEQ, activeEnzymes: enzymes });
        observedCounts.push(r[0].hits.length);
        return r;
      },
      { initialProps: { enzymes: [EcoRI, ISceI] as RestrictionEnzyme[] } }
    );

    await waitFor(() => {
      expect(result.current[0].phase).toBe('complete');
    });

    for (let i = 0; i < 4; i++) {
      rerender({ enzymes: [EcoRI, ISceI] });
    }

    const firstNonZero = observedCounts.findIndex((c) => c > 0);
    expect(firstNonZero).toBeGreaterThanOrEqual(0);
    const tail = observedCounts.slice(firstNonZero);
    expect(
      tail.every((c) => c > 0),
      `hits dropped to zero at some point: ${observedCounts.join(',')}`
    ).toBe(true);
  });

  it('I3: removing an enzyme from activeEnzymes filters hits without rescanning', async () => {
    const { result, rerender } = renderHook(
      ({ enzymes }: { enzymes: RestrictionEnzyme[] }) =>
        useCutSiteScanner({ sequence: SEQ, activeEnzymes: enzymes }),
      { initialProps: { enzymes: [EcoRI, ISceI] as RestrictionEnzyme[] } }
    );

    await waitFor(() => expect(result.current[0].phase).toBe('complete'));
    expect(result.current[0].hits.length).toBe(4);

    rerender({ enzymes: [EcoRI] });

    expect(result.current[0].hits.filter((h) => h.enzyme.name === 'EcoRI')).toHaveLength(3);
    expect(result.current[0].hits.filter((h) => h.enzyme.name === 'I-SceI')).toHaveLength(0);

    rerender({ enzymes: [EcoRI, ISceI] });
    expect(result.current[0].hits.length).toBe(4);
    expect(result.current[0].phase).toBe('complete');
  });

  it('I4: clearing activeEnzymes empties hits but does NOT invalidate the cache', async () => {
    const { result, rerender } = renderHook(
      ({ enzymes }: { enzymes: RestrictionEnzyme[] }) =>
        useCutSiteScanner({ sequence: SEQ, activeEnzymes: enzymes }),
      { initialProps: { enzymes: [EcoRI] as RestrictionEnzyme[] } }
    );

    await waitFor(() => expect(result.current[0].phase).toBe('complete'));
    expect(result.current[0].hits.length).toBe(3);

    rerender({ enzymes: [] });
    expect(result.current[0].hits).toEqual([]);
    expect(result.current[0].phase).toBe('idle');

    rerender({ enzymes: [EcoRI] });
    await waitFor(() => expect(result.current[0].phase).toBe('complete'));
    expect(result.current[0].hits.length).toBe(3);
  });
});

describe('useCutSiteScanner — sequence change invalidates cache ', () => {
  it('changing the sequence forces a fresh scan', async () => {
    const { result, rerender } = renderHook(
      ({ seq, enzymes }: { seq: string; enzymes: RestrictionEnzyme[] }) =>
        useCutSiteScanner({ sequence: seq, activeEnzymes: enzymes }),
      { initialProps: { seq: SEQ, enzymes: [EcoRI] as RestrictionEnzyme[] } }
    );

    await waitFor(() => expect(result.current[0].phase).toBe('complete'));
    expect(result.current[0].hits.length).toBe(3);

    const SEQ2 = 'TTTTGAATTCAAAA';
    rerender({ seq: SEQ2, enzymes: [EcoRI] });

    await waitFor(() => expect(result.current[0].phase).toBe('complete'), { timeout: 2000 });
    expect(result.current[0].hits.length).toBe(1);
  });
});

describe('useCutSiteScanner — topology is part of scan identity ', () => {
  it('does not reuse a linear zero-hit cache entry for the same circular molecule', async () => {
    const sequence = 'TCAAAAAAAAAAGGTC';
    const activeEnzymes = [BsaI];
    const { result, rerender } = renderHook(
      ({ circular }: { circular: boolean }) =>
        useCutSiteScanner({ sequence, circular, activeEnzymes }),
      { initialProps: { circular: false } }
    );

    await waitFor(() => expect(result.current[0].phase).toBe('complete'));
    expect(result.current[0].hits).toHaveLength(0);

    rerender({ circular: true });
    await waitFor(
      () => {
        expect(result.current[0].phase).toBe('complete');
        expect(result.current[0].hits).toHaveLength(1);
      },
      { timeout: 2000 }
    );
  });
});

describe('useCutSiteScanner — scan-limit cache isolation ', () => {
  it('keeps capped preview scans separate from uncapped active-enzyme scans', async () => {
    const denseSeq = 'TTGAATTCAA'.repeat(30);
    const { result, rerender } = renderHook(
      ({
        enzymes,
        maxHitsPerEnzyme,
      }: {
        enzymes: RestrictionEnzyme[];
        maxHitsPerEnzyme?: number;
      }) =>
        useCutSiteScanner({
          sequence: denseSeq,
          activeEnzymes: enzymes,
          maxHitsPerEnzyme,
        }),
      { initialProps: { enzymes: [EcoRI], maxHitsPerEnzyme: 2 as number | undefined } }
    );

    await waitFor(
      () => {
        expect(result.current[0].phase).toBe('complete');
        expect(result.current[0].hits).toHaveLength(2);
      },
      { timeout: 2000 }
    );

    rerender({ enzymes: [EcoRI], maxHitsPerEnzyme: undefined });
    await waitFor(
      () => {
        expect(result.current[0].phase).toBe('complete');
        expect(result.current[0].hits).toHaveLength(30);
      },
      { timeout: 2000 }
    );

    rerender({ enzymes: [EcoRI], maxHitsPerEnzyme: 2 });
    await waitFor(() => {
      expect(result.current[0].phase).toBe('complete');
      expect(result.current[0].hits).toHaveLength(2);
    });
  });
});

describe('useCutSiteScanner — handler stability  stale-closure pin)', () => {
  it('I3: rapid input changes never cause hits to revert below the per-enzyme cached count', async () => {
    const { result, rerender } = renderHook(
      ({ enzymes }: { enzymes: RestrictionEnzyme[] }) =>
        useCutSiteScanner({ sequence: SEQ, activeEnzymes: enzymes }),
      { initialProps: { enzymes: [] as RestrictionEnzyme[] } }
    );

    rerender({ enzymes: [EcoRI] });
    rerender({ enzymes: [EcoRI, ISceI] });
    rerender({ enzymes: [ISceI] });
    rerender({ enzymes: [EcoRI, ISceI] });

    await waitFor(() => expect(result.current[0].phase).toBe('complete'), { timeout: 2000 });
    expect(result.current[0].hits.filter((h) => h.enzyme.name === 'EcoRI')).toHaveLength(3);
    expect(result.current[0].hits.filter((h) => h.enzyme.name === 'I-SceI')).toHaveLength(1);
  });
});
