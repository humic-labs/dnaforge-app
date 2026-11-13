import { describe, expect, it } from 'vitest';
import type { ResidueSelection } from './residue-selection-store';
import {
  residueIndicesForProjectionSelection,
  residueMoleculeKindsCompatible,
  residueSelectionHasForeignProjectionMolecule,
  residueSelectionProjectsIntoContract,
  residueSelectionTargetsProjectionMolecule,
  selectionMappingsForProjectionResidueIndex,
  type ResidueProjectionContract,
} from './residue-projection-contract';

const translatedContract: ResidueProjectionContract = {
  contractId: 'translated-cds:/fixtures/ref.gb:geneA',
  molecule: {
    moleculeId: 'translated-cds:/fixtures/ref.gb:geneA:100-399:1',
    moleculeKind: 'translated-cds',
    label: 'geneA',
    aliases: [
      {
        moleculeId: 'translated-cds:/fixtures/ref.gb:Gene A CDS:100-399:1',
        moleculeKind: 'translated-cds',
        label: 'Gene A CDS',
      },
    ],
  },
  rules: [
    {
      kind: 'coding-dna',
      selectionToResidueIndices(selection) {
        const indices: number[] = [];
        for (const mapping of selection.mappings ?? []) {
          if (mapping.kind !== 'coding-dna') continue;
          if (mapping.referenceId !== '/fixtures/ref.gb') continue;
          if (mapping.featureId !== 'geneA') continue;
          for (const interval of mapping.intervals) {
            indices.push(Math.floor((interval.start - 99) / 3));
          }
        }
        return indices;
      },
      residueIndexToMappings(residueIndex) {
        const start = 99 + residueIndex * 3;
        return [
          {
            kind: 'coding-dna',
            referenceId: '/fixtures/ref.gb',
            featureId: 'geneA',
            strand: 1,
            intervals: [{ start, end: start + 2 }],
          },
        ];
      },
    },
    {
      kind: 'future-track',
      selectionToResidueIndices(selection) {
        const mapping = selection.mappings?.find(
          (candidate): candidate is { kind: 'future-track'; rowId: string; residueIndex: number } =>
            candidate.kind === 'future-track' && 'rowId' in candidate && 'residueIndex' in candidate
        );
        return mapping?.rowId === 'geneA-row' ? [mapping.residueIndex] : [];
      },
    },
  ],
};

function selection(
  target: ResidueSelection['target'],
  mappings: ResidueSelection['mappings'] = [],
  sourceKind = 'translation-track'
): ResidueSelection {
  return {
    source: { kind: sourceKind },
    target,
    mappings,
  };
}

describe('residue projection contract', () => {
  it('projects target residue intervals when the selected molecule is the contract molecule', () => {
    const selected = selection({
      moleculeId: 'translated-cds:/fixtures/ref.gb:geneA:100-399:1',
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [
        { start: 2, end: 3 },
        { start: 8, end: 8 },
      ],
    });

    expect(residueSelectionTargetsProjectionMolecule(selected, translatedContract)).toBe(true);
    expect(residueSelectionHasForeignProjectionMolecule(selected, translatedContract)).toBe(false);
    expect(residueIndicesForProjectionSelection(translatedContract, selected)).toEqual([2, 3, 8]);
  });

  it('treats declared aliases and compatible protein molecule kinds as the same residue domain', () => {
    const proteinContract: ResidueProjectionContract = {
      contractId: 'protein:uniprot:P0AD86',
      molecule: {
        moleculeId: 'protein:uniprot:P0AD86',
        moleculeKind: 'protein',
        aliases: [
          { moleculeId: 'protein-sequence:/fixtures/thrL.faa', moleculeKind: 'protein-sequence' },
        ],
      },
      rules: [],
    };
    const selected = selection({
      moleculeId: 'protein-sequence:/fixtures/thrL.faa',
      moleculeKind: 'protein-sequence',
      coordinateSystem: 'residue',
      intervals: [{ start: 4, end: 4 }],
    });

    expect(residueMoleculeKindsCompatible('protein-sequence', 'protein')).toBe(true);
    expect(residueSelectionTargetsProjectionMolecule(selected, proteinContract)).toBe(true);
    expect(residueIndicesForProjectionSelection(proteinContract, selected)).toEqual([4]);
  });

  it('blocks mapping-rule projection when the selection explicitly belongs to a different molecule', () => {
    const selected = selection(
      {
        moleculeId: 'translated-cds:/fixtures/ref.gb:otherGene:100-399:1',
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 5, end: 5 }],
      },
      [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/ref.gb',
          featureId: 'geneA',
          strand: 1,
          intervals: [{ start: 114, end: 116 }],
        },
      ]
    );

    expect(residueSelectionTargetsProjectionMolecule(selected, translatedContract)).toBe(false);
    expect(residueSelectionHasForeignProjectionMolecule(selected, translatedContract)).toBe(true);
    expect(residueSelectionProjectsIntoContract(translatedContract, selected)).toBe(false);
    expect(residueIndicesForProjectionSelection(translatedContract, selected)).toEqual([]);
  });

  it('allows explicit compatibility sources to project by mapping even when legacy target ids are fake', () => {
    const compatContract: ResidueProjectionContract = {
      ...translatedContract,
      ignoreForeignTargetForSourceKinds: ['selected-codon-compat'],
    };
    const selected = selection(
      {
        moleculeId: 'coding-dna:/fixtures/ref.gb:114-116:1',
        moleculeKind: 'coding-dna-compat',
        coordinateSystem: 'residue',
        intervals: [{ start: 0, end: 0 }],
      },
      [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/ref.gb',
          featureId: 'geneA',
          strand: 1,
          intervals: [{ start: 114, end: 116 }],
        },
      ],
      'selected-codon-compat'
    );

    expect(residueSelectionHasForeignProjectionMolecule(selected, compatContract)).toBe(false);
    expect(residueIndicesForProjectionSelection(compatContract, selected)).toEqual([5]);
  });

  it('lets a future surface add a projection rule without changing the selection primitive', () => {
    const selected = selection(
      {
        moleculeId: 'track:vcf:sample-1',
        moleculeKind: 'variant-track',
        coordinateSystem: 'residue',
        intervals: [{ start: 0, end: 0 }],
      },
      [{ kind: 'future-track', rowId: 'geneA-row', residueIndex: 12 } as never],
      'vcf-track'
    );
    const trackContract: ResidueProjectionContract = {
      ...translatedContract,
      ignoreForeignTargetForSourceKinds: ['vcf-track'],
    };

    expect(residueIndicesForProjectionSelection(trackContract, selected)).toEqual([12]);
  });

  it('builds selection mappings for a residue index from all rules that can express one', () => {
    expect(selectionMappingsForProjectionResidueIndex(translatedContract, 4)).toEqual([
      {
        kind: 'coding-dna',
        referenceId: '/fixtures/ref.gb',
        featureId: 'geneA',
        strand: 1,
        intervals: [{ start: 111, end: 113 }],
      },
    ]);
  });
});
