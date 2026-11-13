// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Feature, Genome } from '@waypoint/genome-renderer';
import { SEQUENCE_EDIT_MARKUP } from '@waypoint/sequence-utils/sequence-edit-markup';
import {
  buildNativeSequenceComparisonScene,
  mapNativeSequenceComparisonDataColors,
  type NativeSequenceComparisonInput,
} from './native-sequence-comparison';

function feature(
  sourceId: string,
  start: number,
  end: number,
  overrides: Partial<Feature> = {}
): Feature {
  return {
    id: 19,
    sourceId,
    start,
    end,
    type: 'gene',
    direction: 'forward',
    displayName: 'repeated',
    color: 0x3399cc,
    lane: 0,
    ...overrides,
  };
}
function genome(sequence: string, features: Feature[]): Genome {
  return { name: 'reference', sequence, length: sequence.length, circular: false, features };
}
function input(
  overrides: Partial<NativeSequenceComparisonInput> = {}
): NativeSequenceComparisonInput {
  return {
    id: 'recorded-op',
    before: genome('ACGT', [feature('retained', 1, 4)]),
    after: genome('AACGT', [feature('retained', 2, 5)]),
    oldGapped: 'A-CGT',
    newGapped: 'AACGT',
    changes: [{ kind: 'insertion', start: 1, end: 2 }],
    referenceName: 'reference',
    referenceOrigin: 200,
    ...overrides,
  };
}

describe('native recorded sequence comparison', () => {
  it('pairs biological reference coding features by stable source identity when numeric IDs change', () => {
    const original = feature('cds', 0, 9, { id: 4, type: 'CDS' });
    const edited = { ...original, id: 71 };
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ATGAAATAA', [original]),
        after: genome('ATGTAATAA', [edited]),
        oldGapped: 'ATGAAATAA',
        newGapped: 'ATGTAATAA',
        changes: [{ start: 3, end: 4, kind: 'substitution' }],
      })
    );
    expect(result.referenceCodingGenome.features).toEqual([{ ...original, id: 71 }]);
    expect(result.referenceCodingGenome.sequence).toBe('ATGAAATAA');
    expect(original.id).toBe(4);
  });
  it('defaults to DNA colors while keeping metadata changes as separate input data', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [feature('retained', 1, 4)]),
        after: genome('ACGT', [feature('retained', 1, 4, { displayName: 'renamed annotation' })]),
        oldGapped: 'ACGT',
        newGapped: 'ACGT',
        changes: [],
      })
    );
    expect(result.annotationData.get(19)).toMatchObject({
      dnaChange: 'unchanged',
      recordChange: 'modified',
    });
    expect(result.annotationColors?.get(19)).toBe(0x9ca3af);
    expect(result.scene.genome.features?.[0].color).toBe(0x3399cc);
  });

  it('retains reference annotations and their ownership when the query has no annotation records', () => {
    const source = input({
      before: genome('ACGTAC', [feature('reference', 0, 6)]),
      after: genome('ACTAC', []),
      oldGapped: 'ACGTAC',
      newGapped: 'AC-TAC',
      changes: [{ start: 2, end: 3, kind: 'deletion' }],
    });
    const result = buildNativeSequenceComparisonScene(source);
    expect(result.scene.genome.features).toEqual([
      expect.objectContaining({ id: 19, start: 0, end: 6 }),
    ]);
    expect(result.scene.genome.features?.[0].outlineOnly).not.toBe(true);
    expect(result.annotationData.get(19)).toMatchObject({
      source: 'before',
      dnaChange: 'modified',
      recordChange: null,
      deletedBases: 1,
    });
    expect(result.annotationColors?.get(19)).toBe(SEQUENCE_EDIT_MARKUP.substitution.text.color);
    expect(source.after.features).toEqual([]);
  });

  it('maps independent arbitrary data to annotations and DNA while retaining the source scene', () => {
    const scene = buildNativeSequenceComparisonScene(input());
    const source = structuredClone(scene.scene.genome);
    const records = [{ external: { counts: new Float64Array([2, 8]) } }];
    const result = mapNativeSequenceComparisonDataColors(scene, {
      records,
      bindings: [
        { inputIndex: 0, target: { kind: 'annotation', id: 19 } },
        { inputIndex: 0, target: { kind: 'nucleotide-change', index: 0 } },
      ],
      color: (record) =>
        record.external.counts[1] / record.external.counts[0] > 1 ? '#8a2be2' : '#ffffff',
    });
    expect(result.annotationColors?.get(19)).toBe(0x8a2be2);
    expect(result.nucleotideChanges[0].style?.text.color).toBe(0x8a2be2);
    expect(result.scene).toBe(scene.scene);
    expect(result.scene.genome).toBe(scene.scene.genome);
    expect(result.scene.genome).toEqual(source);
    expect(scene.annotationColors?.get(19)).toBe(0x9ca3af);
  });

  it('maps custom change colors without requiring annotations on either sequence', () => {
    const source = input({ before: genome('ACGT', []), after: genome('AACGT', []) });
    const result = buildNativeSequenceComparisonScene(source, { insertion: '#8a2be2' });
    expect(result.nucleotideChanges[0]).toMatchObject({
      color: 0x8a2be2,
      style: { text: { color: 0x8a2be2, alpha: 1 }, background: { color: 0x8a2be2, alpha: 0.15 } },
    });
    expect(result.scene.genome.features).toEqual([]);
    expect(result.annotationChangeDecorations.size).toBe(0);
    expect(source.after.features).toEqual([]);
  });

  it('colors DNA changes when only the reference has annotations', () => {
    const source = input({ after: genome('AACGT', []) });
    const result = buildNativeSequenceComparisonScene(source, { insertion: '#8a2be2' });
    expect(result.nucleotideChanges[0]).toMatchObject({ style: { text: { color: 0x8a2be2 } } });
    expect(source.before.features).toHaveLength(1);
    expect(source.after.features).toEqual([]);
    expect(result.correspondenceComplete).toBe(false);
    expect(
      [...result.annotationChangeDecorations.values()].some(({ kind }) => kind === 'removed')
    ).toBe(false);
  });

  it.each(['gene', 'CDS'])(
    'retains an internal deletion in a continuous %s without inventing exons',
    (type) => {
      const result = buildNativeSequenceComparisonScene(
        input({
          before: genome('ACGTAC', [feature('continuous', 0, 6, { type })]),
          after: genome('ACTAC', [feature('continuous', 0, 5, { type })]),
          oldGapped: 'ACGTAC',
          newGapped: 'AC-TAC',
          changes: [{ kind: 'deletion', start: 2, end: 3 }],
        })
      );
      const [retained, removed] = result.scene.genome.features ?? [];
      expect(result.scene.genome.features).toHaveLength(2);
      expect(retained).toMatchObject({ id: 19, sourceId: 'continuous', start: 0, end: 6 });
      expect(retained.segments).toBeUndefined();
      expect(retained.exons).toBeUndefined();
      expect(removed).toMatchObject({
        sourceId: 'continuous',
        start: 2,
        end: 3,
        outlineOnly: true,
      });
      expect(result.annotationChangeDecorations.get(removed.id)?.kind).toBe('removed');
      expect(result.annotationData.get(retained.id)).toMatchObject({
        dnaChange: 'modified',
        deletedBases: 1,
      });
      expect(result.annotationColors?.get(retained.id)).toBe(
        SEQUENCE_EDIT_MARKUP.substitution.text.color
      );
    }
  );

  it('preserves sparse resulting feature IDs and allocates ghosts without collisions', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [
          feature('retained', 2, 4, { id: 7 }),
          feature('deleted', 1, 2, { id: 33 }),
        ]),
        after: genome('AT', [feature('retained', 1, 2, { id: 7 })]),
        oldGapped: 'ACGT',
        newGapped: 'A--T',
        changes: [{ kind: 'deletion', start: 1, end: 3 }],
      })
    );
    expect(result.scene.genome.features?.map((native) => native.id)).toEqual([7, 8, 9]);
    expect(result.scene.genome.features?.[0].sourceId).toBe('retained');
    expect(result.annotationChangeDecorations.get(8)?.kind).toBe('removed');
    expect(result.annotationChangeDecorations.get(9)?.kind).toBe('removed');
    expect(result.annotationChangeDecorations.has(0)).toBe(false);
  });
  it('keeps native sequence/features on recorded columns without marking an upstream shift', () => {
    const result = buildNativeSequenceComparisonScene(input());
    expect(result.scene.genome.sequence).toBe('AACGT');
    expect(result.scene.genome.features).toEqual([
      expect.objectContaining({ sourceId: 'retained', start: 2, end: 5, type: 'gene' }),
    ]);
    expect(result.scene.lanes).toEqual([]);
    expect(result.beforeAxis.bioToColumn(1)).toBe(2);
    expect(result.afterAxis.bioToColumn(2)).toBe(2);
    expect(result.annotationChangeDecorations.size).toBe(0);
    expect(result).toHaveProperty('nucleotideChanges', [
      expect.objectContaining({ start: 1, end: 2, kind: 'insertion', color: expect.any(Number) }),
    ]);
    expect(result).not.toHaveProperty('backboneSegments');
  });

  it('pairs repeated names by pinned identity and retains deleted native ghosts', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [feature('retained', 2, 4), feature('deleted', 1, 2, { id: 20 })]),
        after: genome('AT', [feature('new-donor', 0, 1, { id: 7 }), feature('retained', 1, 2)]),
        oldGapped: 'ACGT',
        newGapped: 'A--T',
        changes: [{ kind: 'deletion', start: 1, end: 3 }],
      })
    );
    expect(result.scene.genome.features?.map((f) => [f.sourceId, f.start, f.end])).toEqual([
      ['new-donor', 0, 1],
      ['retained', 3, 4],
      ['retained', 2, 3],
      ['deleted', 1, 2],
    ]);
    expect(result.annotationData.get(7)).toMatchObject({
      recordChange: 'added',
      dnaChange: 'unchanged',
    });
    expect(result.annotationColors?.get(7)).toBe(0x9ca3af);
    expect(result.annotationData.get(19)).toMatchObject({
      recordChange: 'unchanged',
      dnaChange: 'modified',
    });
    expect(result.annotationChangeDecorations.get(20)?.kind).toBe('removed');
    expect(result.annotationChangeDecorations.get(21)?.kind).toBe('removed');
    expect(result.scene.genome.features?.[2].outlineOnly).toBe(true);
  });

  it('decorates changed native exon portions without converting annotations into transcripts', () => {
    const spliced = feature('cds', 0, 6, {
      type: 'CDS',
      segments: [
        { start: 1, end: 2 },
        { start: 5, end: 6 },
      ],
    });
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGTAC', [spliced]),
        after: genome('ATGTAC', [spliced]),
        oldGapped: 'ACGTAC',
        newGapped: 'ATGTAC',
        changes: [{ kind: 'substitution', start: 1, end: 4 }],
      })
    );
    expect(result.scene.genome.features?.[0]).toMatchObject({
      type: 'CDS',
      segments: spliced.segments,
    });
    expect(result.scene.genome.features?.[0].exons).toBeUndefined();
    expect(result.annotationChangeDecorations.get(19)).toMatchObject({
      ranges: [{ start: 1, end: 2 }],
    });
  });

  it('does not invent annotation additions/removals from missing stable identities', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [feature('left', 1, 4, { sourceId: undefined })]),
        after: genome('AACGT', [feature('right', 2, 5, { sourceId: undefined })]),
      })
    );
    expect(result.correspondenceComplete).toBe(false);
    expect(result.scene.genome.features).toHaveLength(1);
    expect(result.annotationChangeDecorations.size).toBe(0);
  });

  it('still marks recorded DNA changes when annotation correspondence is unknown', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [feature('old', 0, 4, { sourceId: undefined })]),
        after: genome('ATGT', [feature('new', 0, 4, { sourceId: undefined })]),
        oldGapped: 'ACGT',
        newGapped: 'ATGT',
        changes: [{ kind: 'substitution', start: 1, end: 2 }],
      })
    );
    expect(result.scene.genome.features).toHaveLength(1);
    expect(result.annotationChangeDecorations.get(19)).toMatchObject({
      kind: 'modified',
      ranges: [{ start: 1, end: 2 }],
    });
  });

  it('does not classify ambiguous duplicate IDs as annotation additions/removals', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [feature('shared', 1, 2), feature('shared', 2, 4, { id: 20 })]),
        after: genome('AACGT', [feature('shared', 2, 3), feature('shared', 3, 5, { id: 20 })]),
      })
    );
    expect(result.correspondenceComplete).toBe(false);
    expect(result.scene.genome.features).toHaveLength(2);
    expect(result.annotationChangeDecorations.size).toBe(0);
  });

  it('keeps coordinate-derived qualifiers out of metadata changes', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [
          feature('retained', 1, 4, { qualifiers: { _locationString: '2..4', translation: 'R' } }),
        ]),
        after: genome('AACGT', [
          feature('retained', 2, 5, { qualifiers: { _locationString: '3..5', translation: 'R' } }),
        ]),
      })
    );
    expect(result.annotationChangeDecorations.size).toBe(0);
  });

  it('recognizes changed repeated qualifiers beyond the first display value', () => {
    const result = buildNativeSequenceComparisonScene(
      input({
        before: genome('ACGT', [
          feature('retained', 1, 4, { qualifierValues: { note: ['first', 'old second'] } }),
        ]),
        after: genome('AACGT', [
          feature('retained', 2, 5, { qualifierValues: { note: ['first', 'new second'] } }),
        ]),
      })
    );
    expect(result.annotationData.get(19)).toMatchObject({
      recordChange: 'modified',
      dnaChange: 'unchanged',
    });
    expect(result.annotationChangeDecorations.has(19)).toBe(false);
  });

  it('rejects a recorded comparison from a different molecule', () => {
    expect(() => buildNativeSequenceComparisonScene(input({ oldGapped: 'A-CGA' }))).toThrow(
      /reference/i
    );
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects an invalid native resulting feature ID %s', (id) => {
    expect(() =>
      buildNativeSequenceComparisonScene(
        input({ after: genome('AACGT', [feature('retained', 2, 5, { id })]) })
      )
    ).toThrow(/feature IDs/i);
  });

  it('rejects duplicate native IDs even when annotation lineage is unambiguous', () => {
    expect(() =>
      buildNativeSequenceComparisonScene(
        input({
          after: genome('AACGT', [
            feature('first', 0, 1, { id: 7 }),
            feature('second', 2, 5, { id: 7 }),
          ]),
        })
      )
    ).toThrow(/feature IDs/i);
  });
});
