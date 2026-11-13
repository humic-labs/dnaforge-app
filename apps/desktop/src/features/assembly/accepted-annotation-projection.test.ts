import { describe, expect, it } from 'vitest';
import type { SequenceDesign } from '../design/types';
import {
  buildAcceptedAssemblyProjectionInput,
  buildSourceProvenanceSnapshot,
} from './accepted-canonical';
import { projectAcceptedAssemblyProductAnnotations } from './accepted-annotation-projection';
import { buildAcceptedAssemblySourceProvenance } from './accepted-service';
import {
  REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
  realAssemblyPipelineAppScenario,
} from '../../test/scenarios/assembly-real-pipeline';

describe('accepted assembly product annotation projection', () => {
  it('continues a forward source CDS across spacer and downstream product from the original start codon', async () => {
    const design = createContinuationDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });

    const annotations = projectAcceptedAssemblyProductAnnotations(projectionInput);

    expect(annotations).toContainEqual(
      expect.objectContaining({
        name: 'left source CDS (predicted continuation)',
        type: 'CDS',
        start: 1,
        end: 18,
        direction: 1,
        qualifiers: expect.objectContaining({
          candidate: ['true'],
          codon_start: ['1'],
        }),
      })
    );
    expect(
      annotations.filter(
        (annotation) => annotation.name === 'left source CDS' && annotation.type === 'CDS'
      )
    ).toHaveLength(0);
    expect(annotations).toContainEqual(
      expect.objectContaining({
        name: 'Spacer spacer-1',
        start: 10,
        end: 12,
      })
    );
    expect(annotations.some((annotation) => annotation.type === 'source_segment')).toBe(false);
  });

  it('recomputes codon_start for clipped source CDSs that do not continue', async () => {
    const design = createContinuationDesign({
      leftSourceAnnotationEnd: 9,
      leftSourceAnnotationStart: -1,
    });
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });

    const annotations = projectAcceptedAssemblyProductAnnotations(projectionInput);

    expect(annotations).toContainEqual(
      expect.objectContaining({
        name: 'left source CDS',
        type: 'CDS',
        start: 1,
        end: 9,
        direction: 1,
        qualifiers: expect.objectContaining({
          codon_start: ['3'],
        }),
      })
    );
  });

  it('continues a reverse source CDS across the previous spacer and upstream product', async () => {
    const design = createReverseContinuationDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });

    const annotations = projectAcceptedAssemblyProductAnnotations(projectionInput);

    expect(annotations).toContainEqual(
      expect.objectContaining({
        name: 'right reverse CDS (predicted continuation)',
        type: 'CDS',
        start: 13,
        end: 21,
        direction: -1,
        qualifiers: expect.objectContaining({
          candidate: ['true'],
          codon_start: ['1'],
        }),
      })
    );
  });

  it('serializes circular-origin reverse CDS continuations as an origin-wrapping product annotation', async () => {
    const design = createOriginWrappingReverseContinuationDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) => buildSourceProvenanceSnapshot(region)),
    });

    const annotations = projectAcceptedAssemblyProductAnnotations(projectionInput);

    expect(annotations).toContainEqual(
      expect.objectContaining({
        name: 'origin reverse CDS (predicted continuation)',
        type: 'CDS',
        start: 13,
        end: 6,
        direction: -1,
        segments: [
          { start: 13, end: 15 },
          { start: 1, end: 6 },
        ],
        qualifiers: expect.objectContaining({
          _locationString: ['complement(join(1..6,13..15))'],
          candidate: ['true'],
        }),
      })
    );
  });

  it('projects source annotations through circular wrapped source selections', async () => {
    const design = createWrappedSourceSelectionDesign();
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) =>
        buildSourceProvenanceSnapshot(region, {
          sourceLength: region.sourceSequence?.length,
          sourceIsCircular: region.sourceIsCircular,
        })
      ),
    });

    const annotations = projectAcceptedAssemblyProductAnnotations(projectionInput);

    expect(annotations).toContainEqual(
      expect.objectContaining({
        name: 'wrapped source feature',
        type: 'misc_feature',
        start: 2,
        end: 4,
        direction: 1,
      })
    );
  });

  it('does not carry source-only location or annotation identity into the product', async () => {
    const original = createWrappedSourceSelectionDesign();
    const design = {
      ...original,
      regions: original.regions.map((region, index) =>
        index === 0
          ? {
              ...region,
              sourceAnnotations: region.sourceAnnotations?.map((annotation) => ({
                ...annotation,
                qualifiers: {
                  ...annotation.qualifiers,
                  _locationString: 'join(10..10,1..2)',
                  dnaforge_ann_id: '550e8400-e29b-41d4-a716-446655440000',
                  note: 'Source note',
                },
              })),
            }
          : region
      ),
    };
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance: design.regions.map((region) =>
        buildSourceProvenanceSnapshot(region, {
          sourceLength: region.sourceSequence?.length,
          sourceIsCircular: region.sourceIsCircular,
        })
      ),
    });
    const projected = projectAcceptedAssemblyProductAnnotations(projectionInput).find(
      (annotation) => annotation.name === 'wrapped source feature'
    );
    expect(projected).toMatchObject({
      start: 2,
      end: 4,
      qualifiers: { note: ['Source note'] },
    });
    expect(projected?.qualifiers).not.toHaveProperty('_locationString');
    expect(projected?.qualifiers).not.toHaveProperty('dnaforge_ann_id');
  });

  it('continues a real pUC19 source-cache CDS across an accepted assembly product junction', async () => {
    const scenario = realAssemblyPipelineAppScenario('gibson-pcr-rd-pcr-two-spacers');
    const design = scenario.designs.designs[scenario.designs.activeDesignId!];
    const sourceProvenance = await buildAcceptedAssemblySourceProvenance(design, {
      [REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]: scenario.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID],
    });
    const projectionInput = await buildAcceptedAssemblyProjectionInput(design, {
      sourceProvenance,
      constructId: design.constructId ?? 'construct-puc19-continuation',
    });

    const annotations = projectAcceptedAssemblyProductAnnotations(projectionInput);
    const continued = sourceProvenance
      .flatMap((snapshot) =>
        snapshot.sourceAnnotations
          .filter((annotation) => annotation.type === 'CDS')
          .map((annotation) => ({ regionId: snapshot.regionId, annotation }))
      )
      .find(({ annotation }) =>
        annotations.some(
          (projected) => projected.name === `${annotation.name} (predicted continuation)`
        )
      );
    if (!continued) {
      throw new Error('Fixture must expose a source-cache CDS that the junction continues.');
    }
    const continuationName = `${continued.annotation.name} (predicted continuation)`;

    const regionIndex = design.regions.findIndex((region) => region.id === continued.regionId);
    const regionStart = productStartForRegion(design, regionIndex);
    const regionEnd = regionStart + design.regions[regionIndex].sequence.length;
    const productLength = projectionInput.productSequence.length;
    const expectedDirection = continued.annotation.strand === 'reverse' ? -1 : 1;

    expect(design.spacers.length).toBeGreaterThan(0);
    expect(annotations).toContainEqual(
      expect.objectContaining({
        name: continuationName,
        type: 'CDS',
        direction: expectedDirection,
        qualifiers: expect.objectContaining({ candidate: ['true'] }),
      })
    );
    expect(
      annotations.filter(
        (annotation) => annotation.name === continued.annotation.name && annotation.type === 'CDS'
      )
    ).toHaveLength(0);

    const continuation = annotations.find((annotation) => annotation.name === continuationName);
    expect(continuation?.segments?.length ?? 1).toBeGreaterThan(1);
    expect(acceptedAnnotationContainsPosition(continuation, 1)).toBe(true);
    expect(acceptedAnnotationContainsPosition(continuation, productLength)).toBe(true);
    expect(regionStart).toBeLessThan(regionEnd);
  });
});

function createContinuationDesign(
  options: { leftSourceAnnotationStart?: number; leftSourceAnnotationEnd?: number } = {}
): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  const leftSequence = 'ATGAAACCC';
  const rightSequence = 'TTTTAACCC';
  return {
    id: 'design-continuation',
    constructId: 'construct-continuation',
    name: 'Continuation design',
    topology: 'linear',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 0,
        sourceEnd: leftSequence.length,
        sequence: leftSequence,
        annotations: [
          {
            name: 'left copied CDS',
            type: 'CDS',
            start: 0,
            end: leftSequence.length,
            strand: 'forward',
            qualifiers: { codon_start: '1' },
          },
        ],
        sourceAnnotations: [
          {
            name: 'left source CDS',
            type: 'CDS',
            start: options.leftSourceAnnotationStart ?? 0,
            end: options.leftSourceAnnotationEnd ?? 15,
            strand: 'forward',
            qualifiers: { codon_start: '1' },
          },
        ],
        sourceType: 'pcr',
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 0,
        sourceEnd: rightSequence.length,
        sequence: rightSequence,
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'GGG' }],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function productStartForRegion(design: SequenceDesign, regionIndex: number): number {
  let cursor = 0;
  for (let index = 0; index < regionIndex; index++) {
    cursor += design.regions[index].sequence.length;
    cursor += design.spacers.find((spacer) => spacer.junctionIndex === index)?.sequence.length ?? 0;
  }
  return cursor;
}

function firstQualifierValue(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function walkForwardUntilStopCircular(sequence: string, startPos: number): number {
  if (sequence.length === 0) return 0;
  let pos = positiveModulo(startPos, sequence.length);
  let walked = 0;
  while (walked + 3 <= sequence.length) {
    const codon = circularSlice(sequence, pos, 3).toUpperCase();
    const end = positiveModulo(pos + 3, sequence.length);
    if (codon === 'TAA' || codon === 'TAG' || codon === 'TGA') {
      return end === 0 ? sequence.length : end;
    }
    pos = end;
    walked += 3;
  }
  return sequence.length;
}

function circularSlice(sequence: string, start: number, length: number): string {
  let value = '';
  for (let offset = 0; offset < length; offset++) {
    value += sequence[positiveModulo(start + offset, sequence.length)] ?? '';
  }
  return value;
}

function acceptedAnnotationContainsPosition(
  annotation: ReturnType<typeof projectAcceptedAssemblyProductAnnotations>[number] | undefined,
  oneBasedPosition: number
): boolean {
  if (!annotation) return false;
  const segments = annotation.segments ?? [{ start: annotation.start, end: annotation.end }];
  return segments.some(
    (segment) => oneBasedPosition >= segment.start && oneBasedPosition <= segment.end
  );
}

function createReverseContinuationDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  const leftSequence = 'AAATTTGGGCCC';
  const rightSequence = 'AAATTTGGGCCC';
  return {
    id: 'design-reverse-continuation',
    constructId: 'construct-reverse-continuation',
    name: 'Reverse continuation design',
    topology: 'linear',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 0,
        sourceEnd: leftSequence.length,
        sequence: leftSequence,
        annotations: [],
        sourceType: 'pcr',
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 60,
        sourceEnd: 60 + rightSequence.length,
        sequence: rightSequence,
        annotations: [],
        sourceAnnotations: [
          {
            name: 'right reverse CDS',
            type: 'CDS',
            start: 60 - 9,
            end: 60 + 6,
            strand: 'reverse',
            qualifiers: { codon_start: '1' },
          },
        ],
        sourceType: 'pcr',
      },
    ],
    spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'TTA' }],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createOriginWrappingReverseContinuationDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-origin-reverse-continuation',
    constructId: 'construct-origin-reverse-continuation',
    name: 'Origin reverse continuation design',
    topology: 'circular',
    regions: [
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 60,
        sourceEnd: 66,
        sequence: 'AAATTT',
        annotations: [],
        sourceAnnotations: [
          {
            name: 'origin reverse CDS',
            type: 'CDS',
            start: 51,
            end: 66,
            strand: 'reverse',
            qualifiers: { codon_start: '1' },
          },
        ],
        sourceType: 'pcr',
      },
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 0,
        sourceEnd: 6,
        sequence: 'GGGCCC',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [{ id: 'spacer-origin', junctionIndex: 1, sequence: 'TTA' }],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createWrappedSourceSelectionDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-wrapped-source-selection',
    constructId: 'construct-wrapped-source-selection',
    name: 'Wrapped source selection design',
    topology: 'linear',
    regions: [
      {
        id: 'wrapped',
        sourceSequenceId: 'wrapped-source',
        sourceSequenceName: 'Wrapped source',
        sourceStart: 8,
        sourceEnd: 2,
        sequence: 'GGAA',
        annotations: [],
        sourceSequence: 'AACCCCGGGG',
        sourceAnnotations: [
          {
            name: 'wrapped source feature',
            type: 'misc_feature',
            start: 9,
            end: 2,
            strand: 'forward',
          },
        ],
        sourceIsCircular: true,
        sourceType: 'pcr',
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 0,
        sourceEnd: 4,
        sequence: 'TTTT',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [],
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}
