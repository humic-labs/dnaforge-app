import { describe, expect, it } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { DesignRegion } from '../../design/types';
import { projectSourceProvenance } from './projectJunctionProvenance';
import { deriveSourceRowFields } from './deriveRowFields';
import * as deriveRowFields from './deriveRowFields';
import { validateSourceProvenance } from './validateJunctionProvenance';
import * as provenanceValidation from './validateJunctionProvenance';

describe('junction provenance module surface', () => {
  it('does not export unused product provenance helpers', () => {
    expect(provenanceValidation).not.toHaveProperty('validateProductProvenance');
    expect(provenanceValidation).not.toHaveProperty('productSegmentsFromBases');
    expect(provenanceValidation.validateSourceProvenance).toBe(validateSourceProvenance);
  });
});

describe('junction provenance projection', () => {
  it('keeps wrapped circular source intervals unwrapped and partitions visible bases exactly', () => {
    const source = annotatedSource('wrapped-source', 'AAAACCCCGGGGTTTT', true);
    const region = regionFromSource(source, 12, 20);

    const projection = projectSourceProvenance({
      rowId: 'gibson-0-left',
      side: 'left',
      region,
      assemblyMethod: 'gibson',
      registeredStartBioCol: -8,
      registeredEndBioCol: 8,
      productJunctionPosition: 20,
      spacerLength: 0,
      bufferLeft: 0,
      bufferRight: 0,
    });
    const derived = deriveSourceRowFields(projection);

    expect(projection.intervals.assembledContributionIntervals).toEqual([
      { start: 12, end: 20, sourceLength: 16, circular: true },
    ]);
    expect(
      projection.bases
        .filter((base) => base.owner === 'contributing')
        .map((base) => base.sourceBase)
    ).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(projection.bases.filter((base) => base.normalizedSourceBase === 2)[0]?.owner).toBe(
      'contributing'
    );
    expect(projection.bases.filter((base) => base.normalizedSourceBase === 8)[0]?.owner).toBe(
      'muted'
    );
    expect(derived.visibleColumns).toHaveLength(16);
    expect(derived.contributingColumns).toHaveLength(8);
    expect(derived.mutedColumns).toHaveLength(8);
    expect(derived.contributingColumns.length + derived.mutedColumns.length).toBe(
      derived.visibleColumns.length
    );
  });

  it('does not export unused source background helpers', () => {
    expect(deriveRowFields).not.toHaveProperty('sourceBackgroundSegmentsFromProjection');
    expect(deriveRowFields).not.toHaveProperty('sourceBaseContributes');
    expect(deriveRowFields.deriveSourceRowFields).toBe(deriveSourceRowFields);
  });

  it('projects RD cut geometry and source coloring from the same provenance frame', () => {
    const source = annotatedSource('rd-source', 'AAAAGAATTCTTTTCCCC', false);
    const region = {
      ...regionFromSource(source, 0, 14),
      sourceType: 'rd' as const,
      rdSourceEnzyme: 'EcoRI',
      rdSourceEnzymeName: 'EcoRI',
      rdEnds: {
        upstream: {
          recognitionStart: 4,
          recognitionEnd: 10,
          cutPositionTop: 5,
          cutPositionBottom: 9,
          strand: 'forward' as const,
          retainedScarSequence: 'AATT',
        },
      },
    };

    const projection = projectSourceProvenance({
      rowId: 'gibson-0-left-rd',
      side: 'left',
      region,
      assemblyMethod: 'gibson',
      registeredStartBioCol: -14,
      registeredEndBioCol: 6,
      productJunctionPosition: 14,
      spacerLength: 0,
      bufferLeft: 0,
      bufferRight: 0,
    });
    const derived = deriveSourceRowFields(projection);

    expect(projection.digestBoundaries).toHaveLength(1);
    expect(projection.digestBoundaries[0]).toMatchObject({
      id: 'gibson-0-left-rd:upstream:EcoRI:5:9',
      topCutBoundary: 5,
      bottomCutBoundary: 9,
      participatesInContribution: true,
    });
    expect(derived.cutSites).toHaveLength(1);
    expect(derived.cutSites[0]).toMatchObject({
      cutPositionTop: 5,
      cutPositionBottom: 9,
      recognitionStart: 4,
      recognitionEnd: 10,
    });
    expect(derived.contributingColumns.length).toBe(14);
    expect(derived.mutedColumns.length).toBe(4);
    expect(derived.contributingColumns.length + derived.mutedColumns.length).toBe(
      derived.visibleColumns.length
    );
  });
});

function annotatedSource(id: string, sequence: string, circular: boolean): AnnotatedSequence {
  return {
    id,
    name: id,
    sequence,
    length: sequence.length,
    circular,
    annotations: [],
  };
}

function regionFromSource(
  source: AnnotatedSequence,
  sourceStart: number,
  sourceEnd: number
): DesignRegion {
  return {
    id: `${source.id}-region`,
    sourceSequenceId: source.id,
    sourceSequenceName: source.name,
    sourceStart,
    sourceEnd,
    sourceSequence: source.sequence,
    sourceIsCircular: source.circular,
    sequence: sliceSource(source.sequence, sourceStart, sourceEnd - sourceStart),
    annotations: [],
    sourceAnnotations: [],
    sourceType: 'pcr',
  };
}

function sliceSource(sequence: string, start: number, length: number): string {
  let result = '';
  for (let offset = 0; offset < length; offset++) {
    const position = (((start + offset) % sequence.length) + sequence.length) % sequence.length;
    result += sequence[position] ?? '';
  }
  return result;
}
