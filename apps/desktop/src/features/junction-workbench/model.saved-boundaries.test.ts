import { describe, expect, it } from 'vitest';
import type { SequenceDesign } from '../design/public/types';
import { buildJunctionWorkbenchModels } from './model';

function savedDesign(assemblyMethod: SequenceDesign['assemblyMethod']): SequenceDesign {
  const now = new Date('2026-10-31T00:00:00Z');
  return {
    id: 'saved-boundaries',
    name: 'Saved parts',
    assemblyMethod,
    topology: 'circular',
    regions: ['ACGT'.repeat(12), 'TGCA'.repeat(12)].map((sequence, index) => ({
      id: `part-${index}`,
      sourceSequenceId: `source-${index}`,
      sourceSequenceName: `Source ${index + 1}`,
      sourceStart: 0,
      sourceEnd: sequence.length,
      sequence,
      annotations: [],
      sourceType: 'pcr',
    })),
    spacers: [],
    version: 0,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('saved assembly boundaries without overlap details', () => {
  it.each(['gibson', 'nebuilder', 'goldengate'] as const)(
    'shows both circular %s boundaries without inventing overlap geometry',
    (method) => {
      const design = savedDesign(method);
      const original = JSON.stringify(design);
      expect(buildJunctionWorkbenchModels(design)).toEqual([]);
      const models = buildJunctionWorkbenchModels(design, { includeUnannotatedJunctions: true });
      expect(models.map((model) => model.junctionIndex)).toEqual([0, 1]);
      for (const model of models) {
        const left = design.regions[model.junctionIndex];
        const right = design.regions[(model.junctionIndex + 1) % design.regions.length];
        const product = model.rows.find((row) => row.kind === 'product')!;
        const bases = (start: number, end: number) =>
          product.points
            .filter((point) => point.bioCol >= start && point.bioCol < end)
            .map((point) => product.sequence[point.rowPosition])
            .join('');
        expect(bases(-8, 0)).toBe(left.sequence.slice(-8));
        expect(bases(0, 8)).toBe(right.sequence.slice(0, 8));
        expect(model.homologyRegion).toBeUndefined();
        expect(model.goldenGateJunction).toBeUndefined();
        expect(model.editable).toBe(false);
        expect(model.rows.flatMap((row) => row.constraints ?? [])).toEqual([]);
        expect(model.rows.flatMap((row) => row.points).every((point) => !point.editable)).toBe(
          true
        );
      }
      expect(JSON.stringify(design)).toBe(original);
    }
  );

  it('keeps the saved spacer and linear part boundary in register', () => {
    const design = savedDesign('gibson');
    design.topology = 'linear';
    design.spacers = [{ id: 'spacer', junctionIndex: 0, sequence: 'GGA', name: 'Saved spacer' }];
    const models = buildJunctionWorkbenchModels(design, { includeUnannotatedJunctions: true });
    expect(models).toHaveLength(1);
    const product = models[0].rows.find((row) => row.kind === 'product')!;
    const sequence = product.points
      .filter((point) => point.bioCol >= -4 && point.bioCol < 7)
      .map((point) => product.sequence[point.rowPosition])
      .join('');
    expect(sequence).toBe(
      design.regions[0].sequence.slice(-4) + 'GGA' + design.regions[1].sequence.slice(0, 4)
    );
  });

  it('retains recorded overlap geometry when another saved junction has none', () => {
    const design = savedDesign('gibson');
    const recorded = {
      id: 'saved-overlap',
      junctionIndex: 0,
      junctionPosition: design.regions[0].sequence.length,
      start: design.regions[0].sequence.length - 4,
      end: design.regions[0].sequence.length + 4,
      encoding: { onLeft: 4, onRight: 4 },
    };
    design.homologyRegions = [recorded];
    const models = buildJunctionWorkbenchModels(design, { includeUnannotatedJunctions: true });
    expect(models).toHaveLength(2);
    expect(models[0].homologyRegion).toBe(recorded);
    expect(models[0].rows.flatMap((row) => row.constraints ?? [])).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'homology-width' })])
    );
    expect(models[1].homologyRegion).toBeUndefined();
    expect(design.homologyRegions).toEqual([recorded]);
  });
});
