import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import {
  computeVirtualDigest,
  computeVirtualDigestAsync,
  detectGoldenGateDuplicateOverhangs,
  isNativeDigestEnd,
  useVirtualDigest,
  useVirtualDigestCalculation,
  VirtualDigestLimitError,
} from './useVirtualDigest';

describe('computeVirtualDigest', () => {
  it('returns one physical RD fragment for a one-cut circular digest', () => {
    const sequence = 'AAAAGAATTCTTTT';
    const result = computeVirtualDigest(sequence, enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4));

    expect(result.cutSiteCount).toBe(1);
    expect(result.digestKind).toBe('restriction');
    expect(result.ggStatus).toBe('not-ready');
    expect(result.warning).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({
      startPosition: 5,
      endPosition: 5,
      length: sequence.length,
      wrapsOrigin: true,
      ggType: 'rd',
    });
    expect(result.fragments[0].upstream.enzymeName).toBe('EcoRI');
    expect(result.fragments[0].downstream.enzymeName).toBe('EcoRI');
    expect(result.fragments[0].upstream.rdEnd?.retainedScarSequence).toBe('AATTC');
    expect(result.fragments[0].downstream.rdEnd?.retainedScarSequence).toBe('G');
  });

  it('digests an active set with two enzymes that each cut once', () => {
    const sequence = 'GGGATATCGCGGGG';
    const first = enzyme('LeftI', 'ATAT', 1, 1, 'blunt', 0);
    const second = enzyme('RightI', 'CGCG', 1, 1, 'blunt', 0);
    const result = computeVirtualDigest(sequence, [second, first]);

    expect(result.digestKind).toBe('restriction');
    expect(result.enzymeNames).toEqual(['RightI', 'LeftI']);
    expect(result.cutSiteCount).toBe(2);
    expect(result.fragments).toHaveLength(2);
    expect(
      result.fragments.map((fragment) => ({
        start: fragment.startPosition,
        end: fragment.endPosition,
        length: fragment.length,
        upstream: fragment.upstream.enzymeName,
        downstream: fragment.downstream.enzymeName,
        ggType: fragment.ggType,
      }))
    ).toEqual([
      { start: 4, end: 8, length: 4, upstream: 'LeftI', downstream: 'RightI', ggType: 'rd' },
      { start: 8, end: 4, length: 10, upstream: 'RightI', downstream: 'LeftI', ggType: 'rd' },
    ]);
  });

  it('orders fragments by interleaved physical cut positions, not enzyme grouping order', () => {
    const sequence = 'GGGATATCGCGTTTTATATGGGGCGCG';
    const first = enzyme('FirstI', 'ATAT', 1, 1, 'blunt', 0);
    const second = enzyme('SecondI', 'CGCG', 1, 1, 'blunt', 0);
    const result = computeVirtualDigest(sequence, [second, first]);

    expect(result.cutSiteCount).toBe(4);
    expect(
      result.fragments.map((fragment) => ({
        start: fragment.startPosition,
        end: fragment.endPosition,
        length: fragment.length,
        upstream: fragment.upstream.enzymeName,
        downstream: fragment.downstream.enzymeName,
      }))
    ).toEqual([
      { start: 4, end: 8, length: 4, upstream: 'FirstI', downstream: 'SecondI' },
      { start: 8, end: 16, length: 8, upstream: 'SecondI', downstream: 'FirstI' },
      { start: 16, end: 24, length: 8, upstream: 'FirstI', downstream: 'SecondI' },
      { start: 24, end: 4, length: 7, upstream: 'SecondI', downstream: 'FirstI' },
    ]);
  });

  it('coalesces coincident physical cut positions instead of creating zero-length fragments', () => {
    const sequence = 'GGGAAAACCCCGGG';
    const first = enzyme('AOneI', 'AAAA', 1, 1, 'blunt', 0);
    const second = enzyme('ATwoI', 'AAAA', 1, 1, 'blunt', 0);
    const result = computeVirtualDigest(sequence, [first, second]);

    expect(result.cutSiteCount).toBe(1);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0].length).toBe(sequence.length);
    expect(result.fragments[0].upstream.enzymeNames).toEqual(['AOneI', 'ATwoI']);
  });

  it('aborts before fragment materialization when the requested fragment cap is exceeded', () => {
    const manySites = 'GAATTC'.repeat(501);
    const annotations = [
      {
        name: 'must-not-materialize',
        get start(): number {
          throw new Error('fragment materialization started');
        },
        end: 1,
      },
    ];

    expect(() =>
      computeVirtualDigest(manySites, enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4), annotations, {
        maxFragments: 500,
      })
    ).toThrow(VirtualDigestLimitError);
  });

  it('cooperatively aborts a high-hit scan before materializing fragments', async () => {
    const controller = new AbortController();
    let yields = 0;

    const digest = computeVirtualDigestAsync(
      'GAATTC'.repeat(501),
      enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4),
      undefined,
      {
        maxFragments: 1_000,
        scanBatchSize: 1,
        abortSignal: controller.signal,
        yieldToEventLoop: async () => {
          yields += 1;
          controller.abort();
        },
      }
    );

    await expect(digest).rejects.toMatchObject({ name: 'AbortError' });
    expect(yields).toBe(1);
  });

  it('keeps Golden Gate-ready classification only for a single supported Type IIS digest', () => {
    const sequence = 'GGGAAAACCCCTTTTGGG';
    const result = computeVirtualDigest(
      sequence,
      enzyme('BsaI', 'AAAA', 1, 1, 'blunt', 0, 'Type_IIS')
    );

    expect(result.digestKind).toBe('goldengate');
    expect(result.ggStatus).toBe('ready');
    expect(result.fragments.some((fragment) => fragment.ggType === 'insert')).toBe(true);
  });

  it('treats supported isoschizomer-style names as Golden Gate digests', () => {
    const sequence = 'GGGAAAACCCCTTTTGGG';
    const result = computeVirtualDigest(
      sequence,
      enzyme('BpiI', 'AAAA', 1, 1, 'blunt', 0, 'Type_IIS')
    );

    expect(result.digestKind).toBe('goldengate');
    expect(result.overhangLength).toBe(4);
  });

  it('does not produce Golden Gate duplicate diagnostics for generic active-enzyme digests', () => {
    const sequence = 'GGGATATCGCGTTTTATATGGGGCGCG';
    const first = enzyme('FirstI', 'ATAT', 1, 1, 'blunt', 0);
    const second = enzyme('SecondI', 'CGCG', 1, 1, 'blunt', 0);
    const result = computeVirtualDigest(sequence, [first, second]);

    expect(result.digestKind).toBe('restriction');
    expect(result.diagnostics.some((diagnostic) => diagnostic.scope === 'goldengate')).toBe(false);
  });

  it('builds model-owned duplicate-overhang diagnostics with affected fragment ends', () => {
    const diagnostics = detectGoldenGateDuplicateOverhangs([
      mockFragment(0, 'AAAA', 'CCCC'),
      mockFragment(1, 'CCCC', 'AAAA'),
      mockFragment(2, 'AAAA', 'GGGG'),
      mockFragment(3, 'GGGG', 'AAAA'),
    ]);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        scope: 'goldengate',
        kind: 'goldengate-duplicate-overhang',
        overhang: 'AAAA',
        junctionIndices: [1, 3],
        fragmentIndices: [0, 1, 2, 3],
      }),
    ]);
    expect(diagnostics[0].affectedEnds).toEqual([
      { fragmentIndex: 0, end: 'upstream' },
      { fragmentIndex: 1, end: 'downstream' },
      { fragmentIndex: 2, end: 'upstream' },
      { fragmentIndex: 3, end: 'downstream' },
    ]);
  });
});

function mockFragment(
  index: number,
  upstream: string,
  downstream: string
): ReturnType<typeof computeVirtualDigest>['fragments'][number] {
  return {
    index,
    startPosition: index * 100,
    endPosition: (index + 1) * 100,
    length: 100,
    upstream: {
      sequence: upstream,
      enzymeName: 'BsaI',
      enzymeNames: ['BsaI'],
      sitePosition: index * 100,
      siteOrientation: 'forward',
    },
    downstream: {
      sequence: downstream,
      enzymeName: 'BsaI',
      enzymeNames: ['BsaI'],
      sitePosition: (index + 1) * 100,
      siteOrientation: 'reverse',
    },
    ggType: 'insert',
    wrapsOrigin: false,
    annotations: [],
    internalSites: [],
    hasInternalSites: false,
  };
}

function enzyme(
  name: string,
  recognitionSequence: string,
  cutPositionTop: number,
  cutPositionBottom: number,
  overhangType: '5_prime' | '3_prime' | 'blunt',
  overhangLength: number,
  enzymeType: RestrictionEnzyme['enzyme_type'] = 'Type_II'
): RestrictionEnzyme {
  return {
    name,
    recognition_sequence: recognitionSequence,
    recognition_sequence_length: recognitionSequence.length,
    cut_position_top: cutPositionTop,
    cut_position_bottom: cutPositionBottom,
    overhang_type: overhangType,
    overhang_length: overhangLength,
    enzyme_type: enzymeType,
  } as RestrictionEnzyme;
}

describe('computeVirtualDigest — origin-straddling recognition sites  C2)', () => {
  const filler = 'AAAACCCCTTTTAAAACCCCTTTTAAAACCCCTTTT';
  const eco = () => enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4);

  it('counts a cut site whose recognition sequence spans the origin', () => {
    const straddling = 'TC' + filler + 'GAAT';
    const result = computeVirtualDigest(straddling, eco());
    expect(result.cutSiteCount).toBe(1);
  });

  it('still finds an interior site exactly once', () => {
    const interior = filler + 'GAATTC' + filler;
    expect(computeVirtualDigest(interior, eco()).cutSiteCount).toBe(1);
  });

  it('flags the straddling site as internal to a fragment produced by another enzyme', () => {
    const straddling = 'TC' + filler + 'GGATCC' + filler + 'GAAT';
    const result = computeVirtualDigest(straddling, [
      enzyme('BamHI', 'GGATCC', 1, 5, '5_prime', 4),
      eco(),
    ]);
    expect(result.cutSiteCount).toBe(2);
  });

  it('preserves a sticky end whose cut interval crosses the origin', () => {
    const sequence = `AC${'A'.repeat(19)}GGTCTCAGT`;
    const bsaI = enzyme('BsaI', 'GGTCTC', 7, 11, '5_prime', 4);
    const result = computeVirtualDigest(sequence, bsaI);

    expect(result.cutSiteCount).toBe(1);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0].upstream.sequence).toBe('GTAC');
    expect(result.fragments[0].downstream.sequence).toBe('GTAC');
  });

  it('keeps the cancellable scan biologically identical across an origin-crossing cut', async () => {
    const sequence = `AC${'A'.repeat(19)}GGTCTCAGT`;
    const bsaI = enzyme('BsaI', 'GGTCTC', 7, 11, '5_prime', 4);

    const synchronous = computeVirtualDigest(sequence, bsaI);
    const cancellable = await computeVirtualDigestAsync(sequence, bsaI);

    expect(cancellable).toEqual(synchronous);
    expect(cancellable.fragments[0].upstream.sequence).toBe('GTAC');
  });
});

describe('computeVirtualDigest — linear molecules ', () => {
  const linear = { circular: false } as const;
  const ecoRI = () => enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4);

  it('cuts a linear molecule into N+1 pieces, where a circular one gives N', () => {
    const sequence = 'AAAAGAATTCTTTT';

    const asCircular = computeVirtualDigest(sequence, ecoRI());
    const asLinear = computeVirtualDigest(sequence, ecoRI(), undefined, linear);

    expect(asCircular.cutSiteCount).toBe(1);
    expect(asLinear.cutSiteCount).toBe(1);

    expect(asCircular.fragments).toHaveLength(1);
    expect(asLinear.fragments).toHaveLength(2);
    expect(asLinear.circular).toBe(false);
  });

  it('reports the molecule ends as NATIVE, never as an enzyme cut', () => {
    const result = computeVirtualDigest('AAAAGAATTCTTTT', ecoRI(), undefined, linear);
    const [first, last] = result.fragments;

    expect(isNativeDigestEnd(first.upstream)).toBe(true);
    expect(isNativeDigestEnd(last.downstream)).toBe(true);
    expect(first.upstream.sequence).toBe('');
    expect(first.upstream.enzymeName).toBe('');
    expect(first.upstream.siteOrientation).toBeNull();
    expect(first.upstream.rdEnd).toBeUndefined();

    expect(isNativeDigestEnd(first.downstream)).toBe(false);
    expect(isNativeDigestEnd(last.upstream)).toBe(false);
    expect(first.downstream.enzymeName).toBe('EcoRI');
    expect(last.upstream.enzymeName).toBe('EcoRI');
  });

  it('never reports a wrapped fragment, and ends the last piece at the sequence end', () => {
    const sequence = 'AAAAGAATTCTTTT';
    const result = computeVirtualDigest(sequence, ecoRI(), undefined, linear);

    expect(result.fragments.map((fragment) => fragment.wrapsOrigin)).toEqual([false, false]);

    expect(result.fragments[0].startPosition).toBe(0);
    expect(result.fragments[result.fragments.length - 1].endPosition).toBe(sequence.length);

    expect(result.fragments.reduce((total, fragment) => total + fragment.length, 0)).toBe(
      sequence.length
    );
  });

  it('🟥 refuses to call a native-ended Golden Gate fragment usable', () => {
    const sequence = `TTTT${'GGTCTCA'}CCCC${'TGAGACC'}TTTT`;
    const bsaI = enzyme('BsaI', 'GGTCTC', 1, 5, '5_prime', 4, 'Type_IIS');

    const asLinear = computeVirtualDigest(sequence, bsaI, undefined, linear);

    const first = asLinear.fragments[0];
    const last = asLinear.fragments[asLinear.fragments.length - 1];

    expect(asLinear.fragments.length).toBeGreaterThan(1);
    expect(isNativeDigestEnd(first.upstream)).toBe(true);
    expect(isNativeDigestEnd(last.downstream)).toBe(true);
    expect(first.ggType).toBe('unusable');
    expect(last.ggType).toBe('unusable');
    expect(first.hasNativeEnd).toBe(true);
    expect(last.hasNativeEnd).toBe(true);
  });
});

describe('useVirtualDigest hook — topology reaches the engine', () => {
  const ecoRI = enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4);
  const SEQ = 'AAAAGAATTCTTTT';

  it('digests linearly when the caller reports a linear file', () => {
    const { result } = renderHook(() =>
      useVirtualDigest(SEQ, ecoRI, undefined, { circular: false })
    );
    expect(result.current?.circular).toBe(false);
    expect(result.current?.fragments).toHaveLength(2);
  });

  it('still defaults to circular for a caller that passes no topology', () => {
    const { result } = renderHook(() => useVirtualDigest(SEQ, ecoRI));
    expect(result.current?.circular).toBe(true);
    expect(result.current?.fragments).toHaveLength(1);
  });
});

describe('memoized digest calculation outcomes', () => {
  it('exposes the exact calculation failure without exporting its content and preserves the original hook error', () => {
    const failure = new Error('Private calculation detail');
    const broken = enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4);
    Object.defineProperty(broken, 'recognition_sequence', {
      get: () => {
        throw failure;
      },
    });
    const { result } = renderHook(() => useVirtualDigestCalculation('AAAAGAATTCTTTT', broken));
    expect(result.current).toMatchObject({ result: null, errorClass: 'unknown' });
    expect(result.current.error).toBe(failure);
    expect(() => renderHook(() => useVirtualDigest('AAAAGAATTCTTTT', broken))).toThrow(failure);
  });
  it('applies an explicit fragment limit and recomputes when it changes', () => {
    const ecoRI = enzyme('EcoRI', 'GAATTC', 1, 5, '5_prime', 4);
    const sequence = 'AAAAGAATTCTTTT';
    const { result, rerender } = renderHook(
      ({ maxFragments }: { maxFragments?: number }) =>
        useVirtualDigestCalculation(sequence, ecoRI, undefined, {
          circular: false,
          maxFragments,
        }),
      { initialProps: { maxFragments: 1 } }
    );

    expect(result.current).toMatchObject({ result: null, errorClass: 'limit' });
    expect(result.current.error).toMatchObject({ limit: 1 });
    rerender({ maxFragments: 2 });
    expect(result.current.result?.fragments).toHaveLength(2);
    rerender({ maxFragments: 0 });
    expect(result.current).toMatchObject({ result: null, errorClass: 'limit' });
    expect(result.current.error).toMatchObject({ limit: 0 });
  });

  it('does not invent cancellation or a fragment-limit option for the synchronous viewer', () => {
    const { result } = renderHook(() => useVirtualDigestCalculation(undefined, undefined));
    expect(result.current).toEqual({ result: null });
    expect(result.current).not.toHaveProperty('cancel');
  });
});
