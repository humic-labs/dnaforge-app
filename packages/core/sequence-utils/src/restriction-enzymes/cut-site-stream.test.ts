import { describe, it, expect } from 'vitest';
import { scanAllStreaming, scanEnzymeStreaming } from './cut-site-stream';
import type { ScanCallbacks } from './cut-site-stream';
import type { RestrictionEnzyme } from './types';

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

const ACutter = enzyme({
  name: 'A-Cutter',
  recognition_sequence: 'A',
  cut_position_top: 0,
  cut_position_bottom: 1,
});

const BsaI = enzyme({
  name: 'BsaI',
  recognition_sequence: 'GGTCTC',
  cut_position_top: 7,
  cut_position_bottom: 11,
});

function makeCallbacks(over?: Partial<ScanCallbacks>): {
  callbacks: ScanCallbacks;
  progress: Array<{ name: string; hits: number; enzymeIndex: number; totalEnzymes: number }>;
  enzymeDone: string[];
} {
  const progress: Array<{ name: string; hits: number; enzymeIndex: number; totalEnzymes: number }> =
    [];
  const enzymeDone: string[] = [];
  const callbacks: ScanCallbacks = {
    onProgress: (name, hits, enzymeIndex, totalEnzymes) =>
      progress.push({ name, hits: hits.length, enzymeIndex, totalEnzymes }),
    onEnzymeDone: (name) => enzymeDone.push(name),
    yieldToEventLoop: () => Promise.resolve(),
    isCancelled: () => false,
    ...over,
  };
  return { callbacks, progress, enzymeDone };
}

describe('scanEnzymeStreaming', () => {
  it('emits a final progress + enzyme-done callback', async () => {
    const { callbacks, progress, enzymeDone } = makeCallbacks();
    const seq = 'TTGAATTCTTGAATTCTTGAATTCTT';
    const hits = await scanEnzymeStreaming(seq, EcoRI, 0, 1, callbacks);
    expect(hits).toHaveLength(3);
    expect(progress.at(-1)?.hits).toBe(3);
    expect(enzymeDone).toEqual(['EcoRI']);
  });

  it('emits intermediate batches when hit count crosses the batch size', async () => {
    const { callbacks, progress } = makeCallbacks();
    const seq = ('GAATTC' + 'AAAA').repeat(25);
    const hits = await scanEnzymeStreaming(seq, EcoRI, 0, 1, callbacks, { batchSize: 10 });
    expect(hits).toHaveLength(25);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)?.hits).toBe(25);
  });

  it('honors maxHitsPerEnzyme as a defensive cap', async () => {
    const { callbacks } = makeCallbacks();
    const seq = 'GAATTC'.repeat(100);
    const hits = await scanEnzymeStreaming(seq, EcoRI, 0, 1, callbacks, { maxHitsPerEnzyme: 5 });
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it('returns 0 hits and one progress emission for an enzyme that never matches', async () => {
    const { callbacks, progress, enzymeDone } = makeCallbacks();
    const seq = 'ACGT'.repeat(500);
    const hits = await scanEnzymeStreaming(seq, ISceI, 0, 1, callbacks);
    expect(hits).toHaveLength(0);
    expect(progress.at(-1)?.hits).toBe(0);
    expect(enzymeDone).toEqual(['I-SceI']);
  });

  it('finds an origin-straddling site only when the streaming scan is circular', async () => {
    const sequence = 'TCAAAAAAAAAAGGTC';
    const linearCallbacks = makeCallbacks().callbacks;
    const circularCallbacks = makeCallbacks().callbacks;

    const linear = await scanEnzymeStreaming(sequence, BsaI, 0, 1, linearCallbacks);
    const circular = await scanEnzymeStreaming(sequence, BsaI, 0, 1, circularCallbacks, {
      circular: true,
    });

    expect(linear).toHaveLength(0);
    expect(circular).toHaveLength(1);
    expect(circular[0]).toMatchObject({
      recognitionStart: sequence.length - 4,
      recognitionEnd: 2,
      cutPositionTop: 3,
      cutPositionBottom: 7,
      cutPositionTopUnwrapped: 19,
      cutPositionBottomUnwrapped: 23,
      strand: 'forward',
    });
  });

  it('stops emitting once cancelled', async () => {
    let cancelled = false;
    const { callbacks, progress, enzymeDone } = makeCallbacks({
      isCancelled: () => cancelled,
      yieldToEventLoop: async () => {
        cancelled = true;
      },
    });
    const seq = ('GAATTC' + 'A').repeat(30);
    await scanEnzymeStreaming(seq, EcoRI, 0, 1, callbacks, { batchSize: 5 });
    expect(enzymeDone).toEqual([]);
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe('scanAllStreaming', () => {
  it('processes all enzymes and reports them complete', async () => {
    const { callbacks, enzymeDone } = makeCallbacks();
    const seq = 'TTGAATTCTT' + 'TAGGGATAACAGGGTAAT' + 'AA';
    await scanAllStreaming(seq, [EcoRI, ISceI], callbacks);
    expect(enzymeDone.sort()).toEqual(['EcoRI', 'I-SceI']);
  });

  it('applies maxHitsPerEnzyme independently for every enzyme in a multi-enzyme scan', async () => {
    const { callbacks, progress, enzymeDone } = makeCallbacks();
    const seq = ('GAATTC' + 'AAAA').repeat(40);

    await scanAllStreaming(seq, [EcoRI, ACutter], callbacks, { maxHitsPerEnzyme: 5 });

    expect(enzymeDone.sort()).toEqual(['A-Cutter', 'EcoRI']);
    const finalByName = new Map<string, number>();
    for (const entry of progress) {
      finalByName.set(entry.name, entry.hits);
    }
    expect(finalByName.get('EcoRI')).toBe(5);
    expect(finalByName.get('A-Cutter')).toBe(5);
  });

  it('preserves the original enzyme indices in callbacks (not the internal sort order)', async () => {
    const { callbacks, progress } = makeCallbacks();
    const seq = 'TTGAATTCTT' + 'TAGGGATAACAGGGTAAT' + 'AA';
    await scanAllStreaming(seq, [EcoRI, ISceI], callbacks);
    const ecoEntry = progress.find((p) => p.name === 'EcoRI');
    const iSceEntry = progress.find((p) => p.name === 'I-SceI');
    expect(ecoEntry?.enzymeIndex).toBe(0);
    expect(iSceEntry?.enzymeIndex).toBe(1);
    expect(ecoEntry?.totalEnzymes).toBe(2);
  });

  it('returns early without running any enzyme when cancelled before start', async () => {
    const { callbacks, progress, enzymeDone } = makeCallbacks({ isCancelled: () => true });
    const seq = 'TTGAATTCTT';
    await scanAllStreaming(seq, [EcoRI, ISceI], callbacks);
    expect(progress).toEqual([]);
    expect(enzymeDone).toEqual([]);
  });
});
