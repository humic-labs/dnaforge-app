/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseGenBankFull, type Annotation } from '@waypoint/sequence-utils';
import {
  residueSelectionsToCodingDnaRanges,
  type ResidueSelection,
} from './residue-selection-store';
import {
  buildResidueSelectionForCdsCodonRange,
  buildResidueSelectionForCdsCodon,
  toggleResidueSelection,
  translatedCdsMoleculeId,
} from './residue-selection-from-cds';

const FIXTURES_DIR = join(__dirname, '../../../../test-fixtures');
const SFGFP_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/sfgfp-cds.gb');
const ECOLI_REGION_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/ecoli-mg1655-region.gb');

function loadCds(path: string, predicate: (cds: Annotation) => boolean): Annotation {
  const sequence = parseGenBankFull(readFileSync(path, 'utf8'));
  const cds = sequence.annotations?.find(
    (annotation) => annotation.type === 'CDS' && predicate(annotation)
  );
  if (!cds) throw new Error(`CDS not found in ${path}`);
  return cds;
}

describe('buildResidueSelectionForCdsCodon', () => {
  it('builds a residue-native selection for a forward CDS and leaves coding DNA as a mapping', () => {
    const cds = loadCds(SFGFP_FIXTURE, () => true);
    const selection = buildResidueSelectionForCdsCodon({
      referenceId: '/fixtures/sfgfp-cds.gb',
      cds,
      codon: { start: 12, end: 14, strand: 1, residueIndex: 5 },
      fullSequence: parseGenBankFull(readFileSync(SFGFP_FIXTURE, 'utf8')).sequence,
    });

    expect(selection).toMatchObject({
      source: {
        kind: 'translation-track',
        id: '/fixtures/sfgfp-cds.gb',
        surface: 'sequence-cds',
      },
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 4, end: 4 }],
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: '/fixtures/sfgfp-cds.gb',
          strand: 1,
          intervals: [{ start: 12, end: 14 }],
        },
      ],
    });
    expect(selection?.target.moleculeId).toBe(
      translatedCdsMoleculeId('/fixtures/sfgfp-cds.gb', cds)
    );
    expect(selection && 'start' in selection).toBe(false);
    expect(selection && 'end' in selection).toBe(false);
    expect(selection && 'strand' in selection).toBe(false);
    expect(residueSelectionsToCodingDnaRanges(selection ? [selection] : [])).toEqual([
      { start: 12, end: 14, strand: 1 },
    ]);
  });

  it('maps the first protein-order residue of a real reverse-strand CDS without putting strand on the primitive', () => {
    const cds = loadCds(ECOLI_REGION_FIXTURE, (annotation) => annotation.direction === -1);
    const codonStart = cds.end - 3;
    const codonEnd = cds.end - 1;

    const selection = buildResidueSelectionForCdsCodon({
      referenceId: '/fixtures/ecoli-mg1655-region.gb',
      cds,
      codon: { start: codonStart, end: codonEnd, strand: -1 },
      fullSequence: parseGenBankFull(readFileSync(ECOLI_REGION_FIXTURE, 'utf8')).sequence,
    });

    expect(selection?.target).toMatchObject({
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: 0, end: 0 }],
    });
    expect(selection?.mappings).toEqual([
      {
        kind: 'coding-dna',
        referenceId: '/fixtures/ecoli-mg1655-region.gb',
        featureId: selection?.target.label,
        strand: -1,
        intervals: [{ start: codonStart, end: codonEnd }],
      },
    ]);
    expect(selection && 'strand' in selection).toBe(false);
  });

  it('toggles the selected residue target even when a different surface created it', () => {
    const cds = loadCds(SFGFP_FIXTURE, () => true);
    const selection = buildResidueSelectionForCdsCodon({
      referenceId: '/fixtures/sfgfp-cds.gb',
      cds,
      codon: { start: 12, end: 14, strand: 1, residueIndex: 5 },
    });
    if (!selection) throw new Error('selection should be buildable');
    const codingDnaMappings = selection.mappings ?? [];
    const structureOriginSelection: ResidueSelection = {
      selectionId: 'structure:structure:rcsb:1ABC:A:5',
      source: {
        kind: 'structure',
        id: 'structure:rcsb:1ABC',
        surface: 'molstar',
      },
      target: selection.target,
      mappings: [
        ...codingDnaMappings,
        {
          kind: 'structure',
          structureId: 'structure:rcsb:1ABC',
          chain: 'A',
          position: 5,
          residueStart: 5,
          residueEnd: 5,
        },
      ],
    };

    expect(toggleResidueSelection([], selection)).toEqual([selection]);
    expect(toggleResidueSelection([structureOriginSelection], selection)).toEqual([]);
    expect(
      toggleResidueSelection([structureOriginSelection, { ...structureOriginSelection }], selection)
    ).toEqual([]);
  });

  it('does not toggle a neighboring residue target', () => {
    const cds = loadCds(SFGFP_FIXTURE, () => true);
    const selection = buildResidueSelectionForCdsCodon({
      referenceId: '/fixtures/sfgfp-cds.gb',
      cds,
      codon: { start: 12, end: 14, strand: 1, residueIndex: 5 },
    });
    const neighboringSelection = buildResidueSelectionForCdsCodon({
      referenceId: '/fixtures/sfgfp-cds.gb',
      cds,
      codon: { start: 15, end: 17, strand: 1, residueIndex: 6 },
    });
    if (!selection || !neighboringSelection) throw new Error('selections should be buildable');

    expect(toggleResidueSelection([neighboringSelection], selection)).toEqual([
      neighboringSelection,
      selection,
    ]);
  });

  it('builds a residue-order range for a real forward CDS with one mapping interval per codon', () => {
    const cds = loadCds(SFGFP_FIXTURE, () => true);
    const selection = buildResidueSelectionForCdsCodonRange({
      referenceId: '/fixtures/sfgfp-cds.gb',
      cds,
      anchorCodon: { start: 12, end: 14, strand: 1, residueIndex: 5 },
      codon: { start: 21, end: 23, strand: 1, residueIndex: 8 },
      fullSequence: parseGenBankFull(readFileSync(SFGFP_FIXTURE, 'utf8')).sequence,
    });

    expect(selection?.target).toMatchObject({
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: 4, end: 7 }],
    });
    expect(residueSelectionsToCodingDnaRanges(selection ? [selection] : [])).toEqual([
      { start: 12, end: 14, strand: 1 },
      { start: 15, end: 17, strand: 1 },
      { start: 18, end: 20, strand: 1 },
      { start: 21, end: 23, strand: 1 },
    ]);
  });

  it('extends a forward CDS range additively when shift-clicking back across the anchor', () => {
    const cds = loadCds(SFGFP_FIXTURE, () => true);
    const existingSelection = buildResidueSelectionForCdsCodonRange({
      referenceId: '/fixtures/sfgfp-cds.gb',
      cds,
      anchorCodon: { start: 12, end: 14, strand: 1, residueIndex: 5 },
      codon: { start: 21, end: 23, strand: 1, residueIndex: 8 },
      fullSequence: parseGenBankFull(readFileSync(SFGFP_FIXTURE, 'utf8')).sequence,
    });
    if (!existingSelection) throw new Error('existing selection should be buildable');

    const selection = buildResidueSelectionForCdsCodonRange({
      referenceId: '/fixtures/sfgfp-cds.gb',
      cds,
      anchorCodon: { start: 12, end: 14, strand: 1, residueIndex: 5 },
      codon: { start: 6, end: 8, strand: 1, residueIndex: 3 },
      existingSelection,
      fullSequence: parseGenBankFull(readFileSync(SFGFP_FIXTURE, 'utf8')).sequence,
    });

    expect(selection?.target).toMatchObject({
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: 2, end: 7 }],
    });
    expect(residueSelectionsToCodingDnaRanges(selection ? [selection] : [])).toEqual([
      { start: 6, end: 8, strand: 1 },
      { start: 9, end: 11, strand: 1 },
      { start: 12, end: 14, strand: 1 },
      { start: 15, end: 17, strand: 1 },
      { start: 18, end: 20, strand: 1 },
      { start: 21, end: 23, strand: 1 },
    ]);
  });

  it('builds a residue-order range for a real reverse CDS without reversing the residue primitive', () => {
    const parsed = parseGenBankFull(readFileSync(ECOLI_REGION_FIXTURE, 'utf8'));
    const cds = loadCds(ECOLI_REGION_FIXTURE, (annotation) => annotation.direction === -1);
    const selection = buildResidueSelectionForCdsCodonRange({
      referenceId: '/fixtures/ecoli-mg1655-region.gb',
      cds,
      anchorCodon: { start: cds.end - 3, end: cds.end - 1, strand: -1, residueIndex: 1 },
      codon: { start: cds.end - 12, end: cds.end - 10, strand: -1, residueIndex: 4 },
      fullSequence: parsed.sequence,
    });

    expect(selection?.target).toMatchObject({
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: 0, end: 3 }],
    });
    expect(residueSelectionsToCodingDnaRanges(selection ? [selection] : [])).toEqual([
      { start: cds.end - 3, end: cds.end - 1, strand: -1 },
      { start: cds.end - 6, end: cds.end - 4, strand: -1 },
      { start: cds.end - 9, end: cds.end - 7, strand: -1 },
      { start: cds.end - 12, end: cds.end - 10, strand: -1 },
    ]);
    expect(selection && 'start' in selection).toBe(false);
    expect(selection && 'strand' in selection).toBe(false);
  });
});
