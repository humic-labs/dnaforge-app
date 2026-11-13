import { describe, expect, it } from 'vitest';

import {
  InMemoryGenomeDataSource,
  type GenomeDataSource,
  type IndexedGenomeManifest,
} from '@waypoint/genome-data';

import {
  ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
  type AssemblySequenceSearchRequestV1,
} from '../../shared/indexed-genome';
import { searchAssemblySequence } from './assembly-sequence-search';

function manifest(chrom: string, length: number): IndexedGenomeManifest {
  return {
    chrom,
    fastaPath: `/workspace/${chrom}.fa`,
    faiPath: `/workspace/${chrom}.fa.fai`,
    length,
  };
}

function request(
  chromosomes: ReadonlyArray<{ chrom: string; length: number }>,
  overrides: Partial<AssemblySequenceSearchRequestV1> = {}
): AssemblySequenceSearchRequestV1 {
  return {
    clientId: 'find-client',
    requestId: 'sequence-query-1',
    source: {
      contract: ASSEMBLY_SEQUENCE_SEARCH_SOURCE_V1,
      assemblyId: 'assembly-test',
      chromosomes: chromosomes.map(({ chrom, length }) => ({
        chrom,
        length,
        manifest: manifest(chrom, length),
      })),
    },
    motif: 'ACGT',
    limit: 500,
    reverseComplement: true,
    ...overrides,
  };
}

describe('assembly sequence search', () => {
  it('derives global offsets in main and preserves explicit chromosome-local coordinates', async () => {
    const sources = new Map<string, GenomeDataSource>([
      [
        'chrA',
        new InMemoryGenomeDataSource({
          chrom: 'chrA',
          sequence: 'A'.repeat(100),
          features: [],
        }),
      ],
      [
        'chrB',
        new InMemoryGenomeDataSource({
          chrom: 'chrB',
          sequence: `${'A'.repeat(7)}ACGT${'A'.repeat(109)}`,
          features: [],
        }),
      ],
    ]);

    const result = await searchAssemblySequence(
      request([
        { chrom: 'chrA', length: 100 },
        { chrom: 'chrB', length: 120 },
      ]),
      {
        getSource: async (entry) => sources.get(entry.chrom)!,
      }
    );

    expect(result).toEqual({
      hits: [
        {
          chrom: 'chrB',
          localStartBp: 7,
          localEndBp: 11,
          globalStartBp: 107,
          globalEndBp: 111,
          strand: 'forward',
          motif: 'ACGT',
        },
      ],
      truncated: false,
    });
  });

  it('never creates a match across a chromosome boundary', async () => {
    const sources = new Map<string, GenomeDataSource>([
      [
        'left',
        new InMemoryGenomeDataSource({
          chrom: 'left',
          sequence: 'AAAAACG',
          features: [],
        }),
      ],
      [
        'right',
        new InMemoryGenomeDataSource({
          chrom: 'right',
          sequence: 'TAAAAA',
          features: [],
        }),
      ],
    ]);

    const result = await searchAssemblySequence(
      request([
        { chrom: 'left', length: 7 },
        { chrom: 'right', length: 6 },
      ]),
      { getSource: async (entry) => sources.get(entry.chrom)! }
    );

    expect(result).toEqual({ hits: [], truncated: false });
  });

  it('maps a reverse-complement hit on a non-anchor chromosome to the global axis', async () => {
    const sources = new Map<string, GenomeDataSource>([
      [
        'anchor',
        new InMemoryGenomeDataSource({
          chrom: 'anchor',
          sequence: 'A'.repeat(10),
          features: [],
        }),
      ],
      [
        'target',
        new InMemoryGenomeDataSource({
          chrom: 'target',
          sequence: 'TTGGTTAA',
          features: [],
        }),
      ],
    ]);

    const result = await searchAssemblySequence(
      request(
        [
          { chrom: 'anchor', length: 10 },
          { chrom: 'target', length: 8 },
        ],
        { motif: 'AACC' }
      ),
      { getSource: async (entry) => sources.get(entry.chrom)! }
    );

    expect(result.hits).toEqual([
      expect.objectContaining({
        chrom: 'target',
        localStartBp: 2,
        localEndBp: 6,
        globalStartBp: 12,
        globalEndBp: 16,
        strand: 'reverse',
      }),
    ]);
  });

  it('deduplicates a palindromic motif emitted on both strands at one locus', async () => {
    const result = await searchAssemblySequence(
      request([{ chrom: 'chrA', length: 20 }], {
        motif: 'ACGT',
      }),
      {
        getSource: async () => ({
          async *searchSequence(chrom, motif) {
            yield { chrom, start: 4, end: 8, strand: 'reverse', motif };
            yield { chrom, start: 4, end: 8, strand: 'forward', motif };
          },
        }),
      }
    );

    expect(result.hits).toEqual([
      expect.objectContaining({
        localStartBp: 4,
        localEndBp: 8,
        strand: 'forward',
      }),
    ]);
  });

  it('bounds concurrency and returns deterministic assembly-order results', async () => {
    let active = 0;
    let peak = 0;
    const completionOrder: string[] = [];
    const chromosomes = Array.from({ length: 9 }, (_, index) => ({
      chrom: `chr${index + 1}`,
      length: 20,
    }));

    const result = await searchAssemblySequence(request(chromosomes), {
      concurrency: 99,
      getSource: async (entry) => ({
        async *searchSequence(chrom, motif) {
          active += 1;
          peak = Math.max(peak, active);
          const ordinal = Number(chrom.slice(3));
          await new Promise((resolve) => setTimeout(resolve, (10 - ordinal) * 2));
          completionOrder.push(chrom);
          active -= 1;
          yield {
            chrom,
            start: ordinal,
            end: ordinal + motif.length,
            strand: 'forward' as const,
            motif,
          };
        },
        getSequence: async () => '',
        getFeatures: async () => [],
        getChromosomeLength: async () => entry.length,
      }),
    });

    expect(peak).toBe(4);
    expect(completionOrder.slice(0, 4)).not.toEqual(['chr1', 'chr2', 'chr3', 'chr4']);
    expect(result.hits.map((hit) => hit.chrom)).toEqual(chromosomes.map(({ chrom }) => chrom));
  });

  it('caps structured-clone results and reports truncation truthfully', async () => {
    const result = await searchAssemblySequence(
      request([{ chrom: 'chrA', length: 100 }], { motif: 'AA', limit: 2 }),
      {
        getSource: async () =>
          new InMemoryGenomeDataSource({
            chrom: 'chrA',
            sequence: 'AAAAAA',
            features: [],
          }),
      }
    );

    expect(result.hits).toHaveLength(2);
    expect(result.hits.map(({ localStartBp }) => localStartBp)).toEqual([0, 1]);
    expect(result.truncated).toBe(true);
  });

  it('caps only after merging both strands into true coordinate order', async () => {
    const result = await searchAssemblySequence(
      request([{ chrom: 'chrA', length: 12 }], { motif: 'AACC', limit: 1 }),
      {
        getSource: async () =>
          new InMemoryGenomeDataSource({
            chrom: 'chrA',
            sequence: 'GGTTAAAAAACC',
            features: [],
          }),
      }
    );

    expect(result).toEqual({
      hits: [
        expect.objectContaining({
          chrom: 'chrA',
          localStartBp: 0,
          localEndBp: 4,
          strand: 'reverse',
        }),
      ],
      truncated: true,
    });
  });

  it('propagates one cancellation signal to every active chromosome search', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const closed: string[] = [];
    const observedSignals = new Set<AbortSignal>();
    let releaseStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });

    const pending = searchAssemblySequence(
      request(Array.from({ length: 4 }, (_, index) => ({ chrom: `chr${index + 1}`, length: 10 }))),
      {
        concurrency: 4,
        signal: controller.signal,
        getSource: async (entry) => ({
          async *searchSequence(_chrom, _motif, options) {
            const signal = options?.signal;
            if (!signal) throw new Error('missing search cancellation signal');
            observedSignals.add(signal);
            started.push(entry.chrom);
            if (started.length === 4) releaseStarted();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
                { once: true }
              );
            });
          },
          getSequence: async () => '',
          getFeatures: async () => [],
          getChromosomeLength: async () => entry.length,
          close: async () => {
            closed.push(entry.chrom);
          },
        }),
      }
    );

    await allStarted;
    controller.abort(new DOMException('Superseded', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toHaveLength(4);
    expect(observedSignals.size).toBe(1);
    expect([...observedSignals][0]?.aborted).toBe(true);
    expect(closed).toHaveLength(4);
  });
});
