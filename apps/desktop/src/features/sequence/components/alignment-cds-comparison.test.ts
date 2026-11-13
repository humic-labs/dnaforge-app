import { describe, expect, it } from 'vitest';
import type { Feature, Genome } from '@waypoint/genome-renderer';
import { buildSharedSequenceAxis } from './shared-sequence-read-model';
import { buildAlignmentCodingProjection } from './alignment-coding-genome';
import {
  computeAlignmentCdsComparison,
  presentAlignmentCdsComparison,
  rebindCdsAnnotationColors,
} from './alignment-cds-comparison';

const feature: Feature = {
  id: 8,
  type: 'CDS',
  start: 0,
  end: 12,
  direction: 'forward',
  displayName: 'Gene',
  color: 0x33aa55,
  lane: 0,
};
const original: Genome = {
  name: 'Original',
  sequence: 'ATGAAACCCTAA',
  length: 12,
  circular: false,
  features: [feature],
};

describe('complete original and mutant CDS presentation', () => {
  it('keeps assigned annotation colors attached to recomputed feature identities', () => {
    const axis = buildSharedSequenceAxis(original.sequence!);
    const query = buildAlignmentCodingProjection(original, {
      mode: 'gapped',
      gappedSequence: original.sequence,
      alignedQuery: 'ATGTAACCCTAA',
    });
    const view = presentAlignmentCdsComparison(
      { genome: original, axis, lanes: [] },
      computeAlignmentCdsComparison({ genome: original, axis }, query),
      'diff'
    );
    const assigned = new Map([
      [8, 0xab36ea],
      [99, 0x123456],
    ]);
    const colors = rebindCdsAnnotationColors(view.scene.genome.features!, assigned);
    expect(colors?.get(view.scene.genome.features![0].id)).toBe(0xab36ea);
    expect(colors?.get(99)).toBe(0x123456);
    expect(assigned.size).toBe(2);
    expect(rebindCdsAnnotationColors(view.scene.genome.features!, undefined)).toBeUndefined();
  });
  it('draws only the final CDS and stops all painted residues at the actual new stop', () => {
    const axis = buildSharedSequenceAxis(original.sequence!);
    const query = buildAlignmentCodingProjection(original, {
      mode: 'gapped',
      gappedSequence: original.sequence,
      alignedQuery: 'ATGTAACCCTAA',
    });
    const model = computeAlignmentCdsComparison({ genome: original, axis }, query);
    const view = presentAlignmentCdsComparison(
      { genome: original, axis, lanes: [] },
      model,
      'diff'
    );
    expect(view.scene.genome.features).toHaveLength(1);
    const mutant = view.scene.genome.features![0];
    expect(mutant).toMatchObject({ codingSource: 'query', start: 0, end: 6 });
    expect([...view.codingFeatures.values()].flatMap((c) => c.codons).map((c) => c.aa)).toEqual([
      'M',
      '*',
    ]);
    expect(view.navigationFeatures).toMatchObject([{ displayName: 'Gene', start: 0, end: 6 }]);
    expect(model.pairs[0].original!.feature.end).toBe(12);
  });
  it('keeps deleted amino acids out of the final protein and its painted gaps', () => {
    const axis = buildSharedSequenceAxis(original.sequence!);
    const query = buildAlignmentCodingProjection(original, {
      mode: 'gapped',
      gappedSequence: original.sequence,
      alignedQuery: 'ATG---CCCTAA',
    });
    const model = computeAlignmentCdsComparison({ genome: original, axis }, query);
    const view = presentAlignmentCdsComparison(
      { genome: original, axis, lanes: [] },
      model,
      'diff'
    );
    expect(view.scene.genome.features).toHaveLength(1);
    const codons = view.codingFeatures.get(view.scene.genome.features![0].id)!.codons;
    expect(codons.map((c) => c.aa)).toEqual(['M', 'P', '*']);
    expect(codons.some((c) => c.startBp < 6 && c.endBp > 3)).toBe(false);
  });
  it('uses one computed short mutant CDS for both layouts while retaining the full original', () => {
    const axis = buildSharedSequenceAxis(original.sequence!);
    const query = buildAlignmentCodingProjection(original, {
      mode: 'gapped',
      gappedSequence: original.sequence,
      alignedQuery: 'ATGTAACCCTAA',
    });
    const before = structuredClone(original);
    const model = computeAlignmentCdsComparison({ genome: original, axis }, query);
    const scene = { genome: original, axis, lanes: [] };
    const rows = presentAlignmentCdsComparison(scene, model, 'rows');
    const shared = presentAlignmentCdsComparison(scene, model, 'shared');
    for (const view of [rows, shared]) {
      const reference = view.scene.genome.features!.find(
        (feature) => feature.codingSource === 'reference'
      )!;
      const mutant = view.scene.genome.features!.find(
        (feature) => feature.codingSource === 'query'
      )!;
      expect(reference).toMatchObject({ start: 0, end: 12 });
      expect(mutant).toMatchObject({ start: 0, end: 6 });
      expect(
        view.codingFeatures
          .get(mutant.id)
          ?.codons.filter((codon) => codon.mutation?.kind !== 'deleted')
          .map((codon) => codon.aa)
          .join('')
      ).toBe('M*');
      expect(view.codingFeatures.get(mutant.id)?.codons.every((codon) => codon.endBp <= 6)).toBe(
        true
      );
      expect(
        view.codingFeatures
          .get(reference.id)
          ?.codons.map((codon) => codon.aa)
          .join('')
      ).toBe('MKP*');
    }
    expect(rows.scene.genome.features![0].cdsLane).not.toBe(rows.scene.genome.features![1].cdsLane);
    expect(shared.scene.genome.features![0].cdsLane).toBe(shared.scene.genome.features![1].cdsLane);
    expect(shared.scene.genome.features![0].outlineOnly).toBe(true);
    expect(rows.model).toBe(shared.model);
    expect(original).toEqual(before);
  });
});
