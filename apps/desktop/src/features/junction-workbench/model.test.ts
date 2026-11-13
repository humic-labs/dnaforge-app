import { describe, expect, it } from 'vitest';
import { getCodonsForSingleCDS } from '@waypoint/workspace-editor';
import type { DesignPrimer, DesignRegion, SequenceDesign } from '../design/types';
import { getComposedSequence } from '../design/types';
import {
  computeDraftAssembly,
  computeGoldenGatePrimers,
} from '../design/algorithms/draft-assembly';
import {
  buildRealAssemblyPipelineDesign,
  realAssemblyPipelineScenarioById,
} from '../../test/scenarios/assembly-real-pipeline';
import { buildJunctionWorkbenchModels, type JunctionWorkbenchRow } from './model';
import { SourceContextRegistry, createJunctionSourceWindowRequests } from './SourceContextRegistry';
import { SOURCE_ROW_BUFFER_BP } from './registered-window';
import { DEFAULT_JUNCTION_WINDOW_BP } from './coord-mapping';

describe('junction workbench model', () => {
  it('registers every row to one junction coordinate axis and keeps source context visible', () => {
    const design = createDesign();
    const leftAnchor = design.regions[0].sourceEnd;
    const rightAnchor = design.regions[1].sourceStart;
    design.regions[0] = {
      ...design.regions[0],
      sourceAnnotations: [
        {
          name: 'left-excluded-context',
          type: 'misc_feature',
          start: leftAnchor + 24,
          end: leftAnchor + 48,
          strand: 'forward',
          color: '#22c55e',
        },
        {
          name: 'left-contributing-feature',
          type: 'misc_feature',
          start: leftAnchor - 12,
          end: leftAnchor,
          strand: 'forward',
          color: '#22c55e',
        },
        {
          name: 'left-crossing-source-feature',
          type: 'misc_feature',
          start: leftAnchor - 6,
          end: leftAnchor + 6,
          strand: 'forward',
          color: '#22c55e',
        },
      ],
    };
    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    );

    expect(models.length).toBeGreaterThan(0);
    const model = models[0];
    const [leftRow, rightRow, productRow] = model.rows;
    expect(model.rows.map((row) => row.kind)).toEqual(['left-source', 'right-source', 'product']);
    const registeredLength = productRow.sequence.length;
    const anchor = productRow.anchorRowPosition;

    expect(leftRow.sequence).toHaveLength(registeredLength + SOURCE_ROW_BUFFER_BP * 2);
    expect(productRow.sequence).toHaveLength(registeredLength);
    expect(rightRow.sequence).toHaveLength(registeredLength + SOURCE_ROW_BUFFER_BP * 2);
    expect(leftRow.anchorRowPosition).toBe(productRow.anchorRowPosition + SOURCE_ROW_BUFFER_BP);
    expect(rightRow.anchorRowPosition).toBe(productRow.anchorRowPosition + SOURCE_ROW_BUFFER_BP);
    for (const productPoint of productRow.points) {
      expect(pointAtBioCol(leftRow, productPoint.bioCol).bioCol).toBe(productPoint.bioCol);
      expect(pointAtBioCol(rightRow, productPoint.bioCol).bioCol).toBe(productPoint.bioCol);
    }
    expect(sequenceSliceByBioCol(leftRow, -12, 0)).toBe(design.regions[0].sequence.slice(-12));
    expect(sequenceSliceByBioCol(leftRow, 0, 12)).toBe(
      design.regions[0].sourceSequence!.slice(leftAnchor, leftAnchor + 12)
    );
    expect(sequenceSliceByBioCol(rightRow, -12, 0)).toBe(
      design.regions[1].sourceSequence!.slice(rightAnchor - 12, rightAnchor)
    );
    expect(sequenceSliceByBioCol(rightRow, 0, 12)).toBe(design.regions[1].sequence.slice(0, 12));
    expect(leftRow.visibleColumns!.length).toBeGreaterThan(registeredLength);
    expect(rightRow.visibleColumns!.length).toBeGreaterThan(registeredLength);
    expect(leftRow.contributingColumns!.length).toBeGreaterThan(anchor);
    expect(rightRow.contributingColumns!.length).toBeGreaterThan(registeredLength - anchor);
    expect(leftRow.mutedColumns).toHaveLength(
      leftRow.visibleColumns!.length - leftRow.contributingColumns!.length
    );
    expect(rightRow.mutedColumns).toHaveLength(
      rightRow.visibleColumns!.length - rightRow.contributingColumns!.length
    );
    expect(leftRow.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'left-excluded-context',
          color: '#e5e7eb',
        }),
        expect.objectContaining({
          name: 'left-contributing-feature',
          color: '#22c55e',
        }),
      ])
    );
    const legacyCrossingAnnotations = leftRow.annotations.filter(
      (annotation) => annotation.name === 'left-crossing-source-feature'
    );
    const continuousCrossingAnnotations = (leftRow.continuousAnnotations ?? []).filter(
      (annotation) => annotation.name === 'left-crossing-source-feature'
    );
    expect(legacyCrossingAnnotations).toHaveLength(2);
    expect(legacyCrossingAnnotations.map((annotation) => annotation.color).sort()).toEqual([
      '#22c55e',
      '#e5e7eb',
    ]);
    expect(continuousCrossingAnnotations).toHaveLength(1);
    expect(continuousCrossingAnnotations[0]).toEqual(
      expect.objectContaining({
        color: '#22c55e',
      })
    );
    expect(leftRow.mutedColumns).toEqual(
      expect.arrayContaining([rowPositionAtBioCol(leftRow, 0), rowPositionAtBioCol(leftRow, 1)])
    );
    expect(leftRow.mutedColumns).not.toContain(rowPositionAtBioCol(leftRow, -1));
    expect(rightRow.mutedColumns).toEqual(
      expect.arrayContaining([rowPositionAtBioCol(rightRow, -1), rowPositionAtBioCol(rightRow, -2)])
    );
    expect(rightRow.mutedColumns).not.toContain(rowPositionAtBioCol(rightRow, 0));
    expect(productRow.mutedColumns).toHaveLength(0);
    expect(productRow.primers!.length).toBeGreaterThan(0);
    expect(leftRow.primers!.length).toBeGreaterThan(0);
    expect(rightRow.primers!.length).toBeGreaterThan(0);
  });

  it('builds rows from bounded source context windows without mutating regions with full sources', () => {
    const design = createDesign();
    const draft = computeDraftAssembly(design);
    const strippedDesign = {
      ...stripInlineSources(design),
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
    };
    const sourceSequences = Object.fromEntries(
      design.regions.map((region) => [
        region.sourceSequenceId,
        {
          id: region.sourceSequenceId,
          name: region.sourceSequenceName,
          sequence: region.sourceSequence!,
          length: region.sourceSequence!.length,
          circular: false,
          annotations: [],
        },
      ])
    );
    const windowRequests = createJunctionSourceWindowRequests(strippedDesign, {
      maxWindowBp: 500,
    });
    const sourceWindows = new SourceContextRegistry(sourceSequences).resolveWindows(windowRequests);
    const models = buildJunctionWorkbenchModels(strippedDesign, {
      maxWindowBp: 500,
      sourceWindows,
    });

    const [leftRow, rightRow, productRow] = models[0].rows;
    expect(models[0].rows.map((row) => row.kind)).toEqual([
      'left-source',
      'right-source',
      'product',
    ]);

    expect(sourceWindows['gibson:0:left'].sourceContextSequence.length).toBeLessThanOrEqual(
      sourceSequences.left.sequence.length
    );
    expect(sourceWindows['gibson:0:left'].sourceContextSequence).toContain('G'.repeat(12));
    expect(leftRow.sourceContextStatus).toBe('windowed');
    expect(rightRow.sourceContextStatus).toBe('windowed');
    expect(sequenceSliceByBioCol(leftRow, 0, 12)).toBe('G'.repeat(12));
    expect(sequenceSliceByBioCol(rightRow, -12, 0)).toBe('C'.repeat(12));
    expect(leftRow.mutedColumns).toEqual(
      expect.arrayContaining([rowPositionAtBioCol(leftRow, 0), rowPositionAtBioCol(leftRow, 1)])
    );
    expect(rightRow.mutedColumns).toEqual(
      expect.arrayContaining([rowPositionAtBioCol(rightRow, -1), rowPositionAtBioCol(rightRow, -2)])
    );
  });

  it('uses a wider default registered window so junction rows have scrollable context', () => {
    const design = createDesign();
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels({
      ...design,
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
    })[0];
    const [leftRow, rightRow, productRow] = model.rows;

    expect(productRow.sequence).toHaveLength(DEFAULT_JUNCTION_WINDOW_BP);
    expect(leftRow.sequence).toHaveLength(DEFAULT_JUNCTION_WINDOW_BP + SOURCE_ROW_BUFFER_BP * 2);
    expect(rightRow.sequence).toHaveLength(DEFAULT_JUNCTION_WINDOW_BP + SOURCE_ROW_BUFFER_BP * 2);
  });

  it('places spacer columns on the product row only — source rows run continuously through the junction', () => {
    const design = createDesign();
    design.spacers = [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AAGC' }];
    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    );

    const [leftRow, rightRow, productRow] = models[0].rows;
    const anchor = productRow.anchorRowPosition;
    const productSpacerColumns = productRow.spacerColumns ?? [];

    expect(productRow.sequence.slice(anchor, anchor + 4)).toBe('AAGC');
    expect(productSpacerColumns).toEqual([anchor, anchor + 1, anchor + 2, anchor + 3]);
    expect(productRow.points.slice(anchor, anchor + 4).map((point) => point.kind)).toEqual([
      'generated-tail',
      'generated-tail',
      'generated-tail',
      'generated-tail',
    ]);

    expect(leftRow.spacerColumns).toEqual([]);
    expect(rightRow.spacerColumns).toEqual([]);

    expect(kindsByBioCol(leftRow, 0, 4)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(kindsByBioCol(rightRow, 0, 4)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
    ]);

    expect(sequenceBaseAtBioCol(leftRow, -1)).toBe(design.regions[0].sequence.at(-1));
    expect(sequenceSliceByBioCol(leftRow, 0, 4)).toBe('G'.repeat(4));
    expect(pointAtBioCol(leftRow, 0).sourcePosition).toBe(design.regions[0].sourceEnd);
    expect(pointAtBioCol(leftRow, 3).sourcePosition).toBe(design.regions[0].sourceEnd + 3);

    expect(sequenceSliceByBioCol(rightRow, 0, 4)).toBe('C'.repeat(4));
    expect(sequenceSliceByBioCol(rightRow, 4, 8)).toBe(design.regions[1].sequence.slice(0, 4));
    expect(pointAtBioCol(rightRow, 0).sourcePosition).toBe(design.regions[1].sourceStart - 4);
    expect(pointAtBioCol(rightRow, 3).sourcePosition).toBe(design.regions[1].sourceStart - 1);
    expect(pointAtBioCol(rightRow, 4).sourcePosition).toBe(design.regions[1].sourceStart);

    expect(leftRow.contributingColumns).toContain(rowPositionAtBioCol(leftRow, -1));
    expect(leftRow.contributingColumns).not.toContain(rowPositionAtBioCol(leftRow, 0));
    expect(rightRow.contributingColumns).not.toContain(rowPositionAtBioCol(rightRow, 3));
    expect(rightRow.contributingColumns).toContain(rowPositionAtBioCol(rightRow, 4));

    const sourceSequences = Object.fromEntries(
      design.regions.map((region) => [
        region.sourceSequenceId,
        {
          id: region.sourceSequenceId,
          name: region.sourceSequenceName,
          sequence: region.sourceSequence!,
          length: region.sourceSequence!.length,
          circular: false,
          annotations: [],
        },
      ])
    );
    const strippedDesign = {
      ...stripInlineSources(design),
      homologyRegions: draft.homologyRegions,
      designPrimers: draft.designPrimers,
    };
    const sourceWindows = new SourceContextRegistry(sourceSequences).resolveWindows(
      createJunctionSourceWindowRequests(strippedDesign, { maxWindowBp: 500 })
    );
    const windowedModel = buildJunctionWorkbenchModels(strippedDesign, {
      maxWindowBp: 500,
      sourceWindows,
    })[0];
    const [windowedLeftRow, windowedRightRow, windowedProductRow] = windowedModel.rows;
    const windowedAnchor = windowedProductRow.anchorRowPosition;
    expect(windowedProductRow.sequence.slice(windowedAnchor, windowedAnchor + 4)).toBe('AAGC');
    expect(windowedProductRow.spacerColumns).toEqual([
      windowedAnchor,
      windowedAnchor + 1,
      windowedAnchor + 2,
      windowedAnchor + 3,
    ]);
    expect(windowedLeftRow.spacerColumns).toEqual([]);
    expect(windowedRightRow.spacerColumns).toEqual([]);
    expect(
      windowedLeftRow.sequence.slice(windowedAnchor, windowedAnchor + 4).replace(/\s/g, '')
    ).not.toBe('');
    expect(
      windowedRightRow.sequence.slice(windowedAnchor, windowedAnchor + 4).replace(/\s/g, '')
    ).not.toBe('');
  });

  it('defines Gibson crossover constraints in the spacer-left-edge workbench axis', () => {
    const design = createDesign();
    design.spacers = [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AAGC' }];
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];

    const productRow = model.rows.find((row) => row.kind === 'product')!;
    const homology = draft.homologyRegions[0];
    const spacerLength = 4;
    const crossoverLength = homology.encoding.onLeft + homology.encoding.onRight;
    const crossoverConstraint = productRow.constraints?.find(
      (constraint) => constraint.kind === 'homology-width'
    );

    expect(crossoverConstraint).toEqual(
      expect.objectContaining({
        startBioCol: spacerLength - homology.encoding.onLeft,
        endBioCol: spacerLength + homology.encoding.onRight,
        label: `${crossoverLength} bp crossover`,
      })
    );
    expect(crossoverConstraint!.endBioCol - crossoverConstraint!.startBioCol).toBe(crossoverLength);
    const expectedFocusBioCol =
      (crossoverConstraint!.startBioCol + crossoverConstraint!.endBioCol) / 2;
    for (const row of model.rows) {
      expect(row.viewportFocusBioCol).toBe(expectedFocusBioCol);
      expect(row.viewportFocusRowPosition).toBe(row.anchorRowPosition + expectedFocusBioCol);
    }
  });

  it('centers Golden Gate junction rows on the stable reconstruction midpoint while overhangs move', () => {
    const design = createDesign('goldengate');
    design.spacers = [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AAA' }];
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      {
        ...design,
        goldenGateJunctions: draft.goldenGateJunctions,
        designPrimers: draft.designPrimers,
      },
      { maxWindowBp: 500 }
    )[0];

    const junction = draft.goldenGateJunctions![0];
    const productRow = model.rows.find((row) => row.kind === 'product')!;
    const overhangConstraint = productRow.constraints?.find(
      (constraint) => constraint.kind === 'fixed-overhang'
    );
    const spacerLength = 3;
    const registeredAnchorPosition = junction.junctionPosition - spacerLength;
    const expectedStartBioCol = junction.overhangStart - registeredAnchorPosition;
    const expectedEndBioCol = junction.overhangEnd - registeredAnchorPosition;
    const expectedFocusBioCol = spacerLength / 2;

    expect(overhangConstraint).toEqual(
      expect.objectContaining({
        startBioCol: expectedStartBioCol,
        endBioCol: expectedEndBioCol,
      })
    );
    for (const row of model.rows) {
      expect(row.viewportFocusBioCol).toBe(expectedFocusBioCol);
      expect(row.viewportFocusRowPosition).toBe(row.anchorRowPosition + expectedFocusBioCol);
    }
  });

  it('centers a circular Golden Gate closure junction in the overhang coordinate frame', () => {
    const design = createDesign('goldengate');
    const draft = computeDraftAssembly(design);
    const productLength = getComposedSequence(design.regions, design.spacers).length;
    const lastJunctionIndex = design.regions.length - 1;
    const lastJunction = draft.goldenGateJunctions!.find(
      (junction) => junction.junctionIndex === lastJunctionIndex
    )!;
    const models = buildJunctionWorkbenchModels(
      {
        ...design,
        goldenGateJunctions: draft.goldenGateJunctions,
        designPrimers: draft.designPrimers,
      },
      { maxWindowBp: 500 }
    );
    const model = models.find((candidate) => candidate.junctionIndex === lastJunctionIndex)!;
    const productRow = model.rows.find((row) => row.kind === 'product')!;
    const overhangConstraint = productRow.constraints?.find(
      (constraint) => constraint.kind === 'fixed-overhang'
    );

    expect(lastJunction.junctionPosition).toBe(productLength);
    expect(lastJunction.overhangStart).toBe(productLength - 2);
    expect(lastJunction.overhangEnd).toBe(productLength + 2);
    expect(overhangConstraint).toEqual(
      expect.objectContaining({
        startBioCol: -2,
        endBioCol: 2,
      })
    );
    expect(productRow.viewportFocusBioCol).toBe(0);
    expect(productRow.viewportFocusRowPosition).toBe(productRow.anchorRowPosition);
    expect(pointAtBioCol(productRow, -2).productPosition).toBe(productLength - 2);
    expect(pointAtBioCol(productRow, -1).productPosition).toBe(productLength - 1);
    expect(pointAtBioCol(productRow, 0).productPosition).toBe(0);
    expect(pointAtBioCol(productRow, 1).productPosition).toBe(1);
  });

  it('source-row primers keep their full heterologous tail while source cuts stay suppressed', () => {
    const design = createDesign();
    design.regions.push(region('third', 'ATGC'.repeat(40)));
    design.spacers = [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AAGC' }];
    const draft = computeDraftAssembly(design);
    const allPrimers = draft.designPrimers;
    expect((allPrimers[0]?.forward.overhang.length ?? 0) > 0).toBe(true);
    expect((allPrimers[0]?.reverse.overhang.length ?? 0) > 0).toBe(true);

    const models = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    );
    const [leftRow, rightRow, productRow] = models[0].rows;
    const spacerCols = new Set(productRow.spacerColumns ?? []);
    expect(spacerCols.size).toBe(4);

    const collectPrimerBioCols = (row: JunctionWorkbenchRow): Set<number> => {
      const bioCols = new Set<number>();
      for (const primer of row.primers ?? []) {
        for (let col = primer.start; col < primer.end; col++) {
          const point = row.points[col];
          if (point) bioCols.add(point.bioCol);
        }
      }
      return bioCols;
    };
    const spacerBioCols = [...spacerCols].map((col) => productRow.points[col]?.bioCol);

    const productPrimerBioCols = collectPrimerBioCols(productRow);
    for (const bioCol of spacerBioCols) expect(productPrimerBioCols.has(bioCol!)).toBe(true);

    const leftPrimers = leftRow.primers ?? [];
    const rightPrimers = rightRow.primers ?? [];
    expect(leftPrimers.length).toBeGreaterThan(0);
    expect(rightPrimers.length).toBeGreaterThan(0);
    for (const primer of [...leftPrimers, ...rightPrimers]) {
      expect(primer.overhangLength ?? 0).toBeGreaterThan(0);
    }

    const leftPrimerBioCols = collectPrimerBioCols(leftRow);
    const rightPrimerBioCols = collectPrimerBioCols(rightRow);
    const leftTouchesSpacer = spacerBioCols.some((bioCol) => leftPrimerBioCols.has(bioCol!));
    const rightTouchesSpacer = spacerBioCols.some((bioCol) => rightPrimerBioCols.has(bioCol!));
    expect(leftTouchesSpacer).toBe(true);
    expect(rightTouchesSpacer).toBe(true);
  });

  it('keeps upstream source-row CDS translation anchored to source coordinates while boundaries move', () => {
    const forwardBefore = leftBoundaryModelWithSourceCds('forward', 0);
    const forwardAfter = leftBoundaryModelWithSourceCds('forward', -1);
    const reverseBefore = leftBoundaryModelWithSourceCds('reverse', 0);
    const reverseAfter = leftBoundaryModelWithSourceCds('reverse', -1);
    const probeSourcePosition = forwardBefore.sourceEnd - 119;

    expect(
      sourceCodonSpanCovering(
        forwardBefore.model.rows[0],
        'source-cds-forward',
        probeSourcePosition
      )
    ).toEqual(
      sourceCodonSpanCovering(forwardAfter.model.rows[0], 'source-cds-forward', probeSourcePosition)
    );
    expect(
      sourceCodonSpanCovering(
        reverseBefore.model.rows[0],
        'source-cds-reverse',
        probeSourcePosition
      )
    ).toEqual(
      sourceCodonSpanCovering(reverseAfter.model.rows[0], 'source-cds-reverse', probeSourcePosition)
    );
  });

  it('projects product CDS frame onto clipped product junction windows', () => {
    const design = createDesign();
    design.regions[0] = {
      ...design.regions[0],
      annotations: [
        {
          name: 'left-product-cds',
          type: 'CDS',
          start: 0,
          end: design.regions[0].sequence.length,
          strand: 'forward',
          color: '#22c55e',
        },
      ],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 60 }
    )[0];
    const productRow = model.rows.find((row) => row.kind === 'product');
    const productCds = productRow?.annotations.find(
      (annotation) => annotation.name === 'left-product-cds'
    );

    expect(productCds).toEqual(
      expect.objectContaining({
        start: 1,
        end: 30,
        qualifiers: expect.objectContaining({ codon_start: ['2'] }),
      })
    );
  });

  it('renders NEBuilder and Golden Gate hard cases as constrained field-level models', () => {
    const nebuilder = createDesign('nebuilder');
    nebuilder.regions[0] = {
      ...nebuilder.regions[0],
      sourceType: 'rd',
      rdSourceEnzymeName: 'BsaI',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
      rdEnds: {
        downstream: {
          overhangType: '5_prime',
          nebuilderResectionBases: 6,
          recognitionStart: nebuilder.regions[0].sourceEnd + 8,
          recognitionEnd: nebuilder.regions[0].sourceEnd + 14,
          cutPositionTop: nebuilder.regions[0].sourceEnd + 10,
          cutPositionBottom: nebuilder.regions[0].sourceEnd + 14,
          strand: 'forward',
        },
      },
    };
    const neDraft = computeDraftAssembly(nebuilder);
    const neModels = buildJunctionWorkbenchModels({
      ...nebuilder,
      homologyRegions: neDraft.homologyRegions,
      designPrimers: neDraft.designPrimers,
    });

    expect(neModels.some((model) => model.method === 'nebuilder')).toBe(true);
    expect(neModels.every((model) => model.editable)).toBe(true);
    expect(
      neModels.some((model) =>
        model.rows.some((row) =>
          row.constraints?.some((constraint) => constraint.kind === 'nebuilder-resection')
        )
      )
    ).toBe(true);
    expect(neModels[0].rows[0].annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'BsaI downstream recognition site',
          type: 'restriction_site',
          color: '#e5e7eb',
        }),
        expect.objectContaining({
          name: 'BsaI downstream cut',
          type: 'restriction_cut',
          color: '#e5e7eb',
        }),
      ])
    );

    const goldengate = createDesign('goldengate');
    goldengate.goldenGateConfig = { enzyme: 'BsaI' };
    goldengate.goldenGateJunctions = [
      {
        junctionIndex: 0,
        junctionPosition: goldengate.regions[0].sequence.length,
        offset: 0,
        overhangStart: goldengate.regions[0].sequence.length - 2,
        overhangEnd: goldengate.regions[0].sequence.length + 2,
        overhang: 'AATG',
        source: { type: 'rd-fixed', fromRegionIndex: 0 },
        isValid: true,
      },
    ];
    const ggModels = buildJunctionWorkbenchModels(goldengate);
    expect(ggModels[0].editable).toBe(false);
    expect(
      ggModels[0].rows.some((row) =>
        row.constraints?.some((constraint) => constraint.kind === 'fixed-overhang')
      )
    ).toBe(true);
    const fixedProductRow = ggModels[0].rows.find((row) => row.kind === 'product');
    expect(fixedProductRow?.primers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePrimerId: 'scar-marker-0',
          bases: 'AATG',
          isScarMarkerOnly: true,
          junctionIndex: 0,
        }),
      ])
    );

    const pcrGoldenGate = createDesign('goldengate');
    pcrGoldenGate.goldenGateConfig = { enzyme: 'BsaI' };
    const pcrDraft = computeDraftAssembly(pcrGoldenGate);
    const pcrModels = buildJunctionWorkbenchModels({
      ...pcrGoldenGate,
      goldenGateJunctions: pcrDraft.goldenGateJunctions,
      designPrimers: pcrDraft.designPrimers,
    });

    expect(pcrModels[0].editable).toBe(true);
    const [leftRow, rightRow, productRow] = pcrModels[0].rows;
    const sourcePrimers = [...(leftRow.primers ?? []), ...(rightRow.primers ?? [])];
    expect(sourcePrimers.length).toBeGreaterThan(0);
    for (const primer of sourcePrimers) {
      expect(primer.overhangLength ?? 0).toBeGreaterThan(0);
      expect(primer.cutPositionInOverhang).toBeDefined();
      expect(primer.enzymeName).toBe('BsaI');
      expect(primer.cognate4bpLength).toBeDefined();
      expect(primer.suppressCutSiteRendering).toBe(true);
    }
    const productScarPrimers = (productRow.primers ?? []).filter(
      (primer) => primer.cutPositionInOverhang !== undefined
    );
    expect(productScarPrimers.length).toBeGreaterThan(0);
    expect(productScarPrimers.some((primer) => primer.enzymeName === 'BsaI')).toBe(true);
    for (const primer of productScarPrimers) {
      expect(primer.scarAbsolutePosition).toBeGreaterThanOrEqual(0);
      expect(primer.scarAbsolutePosition).toBeLessThan(productRow.sequence.length);
    }
  });

  it('models RD-matched Golden Gate overhangs as constrained and non-editable', () => {
    const design = realAssemblyPipelineScenarioById('goldengate-pcr-rd-pcr').buildDesign();
    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels({
      ...design,
      goldenGateJunctions: draft.goldenGateJunctions,
      designPrimers: draft.designPrimers,
    });

    expect(draft.goldenGateJunctions?.map((junction) => junction.source.type)).toEqual([
      'pcr-matched-rd',
      'pcr-matched-rd',
      'pcr-designed',
    ]);
    expect(models.map((model) => model.editable)).toEqual([false, false, true]);
    expect(
      models.map((model) => {
        const productRow = model.rows.find((row) => row.kind === 'product');
        return (productRow?.primers ?? []).some(
          (primer) => primer.scarAbsolutePosition !== undefined
        );
      })
    ).toEqual([true, true, true]);
    for (const model of models.slice(0, 2)) {
      const productRow = model.rows.find((row) => row.kind === 'product')!;
      expect(productRow.constraints).toContainEqual(
        expect.objectContaining({
          kind: 'fixed-overhang',
          editable: false,
        })
      );
      expect(productRow.points.some((point) => point.kind === 'constrained-end')).toBe(true);
    }
  });

  it('keeps Golden Gate optimizer candidate previews registered on the product junction while primers move', () => {
    const design = createDesign('goldengate');
    const draft = computeDraftAssembly(design);
    const drafted: SequenceDesign = {
      ...design,
      goldenGateJunctions: draft.goldenGateJunctions,
      designPrimers: draft.designPrimers,
    };
    const baselineModel = buildJunctionWorkbenchModels(drafted, { maxWindowBp: 500 })[0];
    const baselineProduct = baselineModel.rows.find((row) => row.kind === 'product')!;
    const baselineOverhang = baselineProduct.constraints!.find(
      (constraint) => constraint.kind === 'fixed-overhang'
    )!;
    const shiftedDesign = goldenGateDesignWithOffset(drafted, 0, 4);
    const shiftedModel = buildJunctionWorkbenchModels(shiftedDesign, { maxWindowBp: 500 })[0];
    const shiftedProduct = shiftedModel.rows.find((row) => row.kind === 'product')!;
    const shiftedOverhang = shiftedProduct.constraints!.find(
      (constraint) => constraint.kind === 'fixed-overhang'
    )!;

    expect(shiftedProduct.viewportFocusBioCol).toBe(baselineProduct.viewportFocusBioCol);
    expect(shiftedProduct.viewportFocusRowPosition).toBe(baselineProduct.viewportFocusRowPosition);
    expect(shiftedOverhang.startBioCol).not.toBe(baselineOverhang.startBioCol);
    expect(shiftedOverhang.endBioCol).not.toBe(baselineOverhang.endBioCol);
    expect(goldenGateProductPrimerPositions(shiftedProduct)).not.toEqual(
      goldenGateProductPrimerPositions(baselineProduct)
    );
  });

  it('projects retained Gibson RD scars onto both product and source rows', () => {
    const rd = region('rd-left', 'ATGC'.repeat(12) + 'CTGCA', {
      sourceType: 'rd',
      rdSourceEnzymeName: 'PstI',
      rdOverhangs: { upstream: 'NNNN', downstream: 'TGCA' },
      rdEnds: {
        downstream: {
          overhangType: '3_prime',
          overhang: 'TGCA',
          retainedScarSequence: 'CTGCA',
          retainedScarLength: 5,
        },
      },
    });
    const pcr = region('pcr-right', 'CGTA'.repeat(30));
    const design: SequenceDesign = {
      ...createDesign('gibson'),
      topology: 'linear',
      regions: [rd, pcr],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];
    const leftRow = model.rows.find((row) => row.kind === 'left-source')!;
    const productRow = model.rows.find((row) => row.kind === 'product')!;

    const productScars = scarAnnotations(productRow);
    const sourceScars = scarAnnotations(leftRow);

    expect(productScars.map((annotation) => annotation.name)).toContain('PstI downstream RD scar');
    expect(sourceScars.map((annotation) => annotation.name)).toContain('PstI downstream RD scar');
    expect(scarSequences(productRow)).toContain('CTGCA');
    expect(scarSequences(leftRow)).toContain('CTGCA');
  });

  it('anchors RD-to-PCR Gibson product overlap drawing to the actual PCR primer tail across spacers', () => {
    const spacerSequence = 'AAGC';
    const rd = region('rd-left', 'ATGC'.repeat(12) + 'CTGCA', {
      sourceType: 'rd',
      rdSourceEnzymeName: 'PstI',
      rdOverhangs: { upstream: 'NNNN', downstream: 'TGCA' },
      rdEnds: {
        downstream: {
          overhangType: '3_prime',
          overhang: 'TGCA',
          retainedScarSequence: 'CTGCA',
          retainedScarLength: 5,
        },
      },
    });
    const pcr = region('pcr-right', 'CGTA'.repeat(30));
    const design: SequenceDesign = {
      ...createDesign('gibson'),
      topology: 'linear',
      regions: [rd, pcr],
      spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: spacerSequence }],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];
    const homology = draft.homologyRegions[0];
    const forwardPrimer = draft.designPrimers[0].forward;
    const productRow = model.rows.find((row) => row.kind === 'product')!;
    const overlap = productRow.constraints?.find(
      (constraint) => constraint.kind === 'homology-width'
    );
    const primerTail = primerTailBioRange(
      forwardPrimer,
      homology.junctionPosition - spacerSequence.length
    );

    expect(homology.templateBasis).toEqual(
      expect.objectContaining({
        spacerLength: spacerSequence.length,
        spacerContributesToAnnealing: false,
        leftSpacerIncludedInHomology: false,
      })
    );
    expect(homology.encoding).toMatchObject({ onRight: 0 });
    expect(forwardPrimer.overhang.sequence).toBe(
      `${homology.metadata?.sequence ?? ''}${spacerSequence}`
    );
    expect(forwardPrimer.overhang.tailLength).toBe(
      homology.encoding.onLeft + spacerSequence.length
    );
    const annealingOverlap = {
      startBioCol: -homology.encoding.onLeft,
      endBioCol: 0,
    };
    expect(primerTail).toEqual({
      startBioCol: -homology.encoding.onLeft,
      endBioCol: spacerSequence.length,
    });
    expect(overlap).toEqual(
      expect.objectContaining({
        kind: 'homology-width',
        startBioCol: annealingOverlap.startBioCol,
        endBioCol: annealingOverlap.endBioCol,
        leftTailEndBioCol: primerTail.endBioCol,
      })
    );
  });

  it('anchors PCR-to-RD Gibson product overlap drawing to the actual reverse primer tail across spacers', () => {
    const spacerSequence = 'TTGA';
    const pcr = region('pcr-left', 'GCTA'.repeat(30));
    const rd = region('rd-right', 'CTGCA' + 'ATGC'.repeat(12), {
      sourceType: 'rd',
      rdSourceEnzymeName: 'PstI',
      rdOverhangs: { upstream: 'TGCA', downstream: 'NNNN' },
      rdEnds: {
        upstream: {
          overhangType: '3_prime',
          overhang: 'TGCA',
          retainedScarSequence: 'CTGCA',
          retainedScarLength: 5,
        },
      },
    });
    const design: SequenceDesign = {
      ...createDesign('gibson'),
      topology: 'linear',
      regions: [pcr, rd],
      spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: spacerSequence }],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];
    const homology = draft.homologyRegions[0];
    const reversePrimer = draft.designPrimers[0].reverse;
    const productRow = model.rows.find((row) => row.kind === 'product')!;
    const overlap = productRow.constraints?.find(
      (constraint) => constraint.kind === 'homology-width'
    );
    const primerTail = primerTailBioRange(
      reversePrimer,
      homology.junctionPosition - spacerSequence.length
    );

    expect(homology.templateBasis).toEqual(
      expect.objectContaining({
        spacerLength: spacerSequence.length,
        spacerContributesToAnnealing: false,
        leftSpacerIncludedInHomology: false,
      })
    );
    expect(homology.encoding).toMatchObject({ onLeft: 0 });
    expect(reversePrimer.overhang.tailLength).toBe(
      homology.encoding.onRight + spacerSequence.length
    );
    const annealingOverlap = {
      startBioCol: spacerSequence.length,
      endBioCol: spacerSequence.length + homology.encoding.onRight,
    };
    expect(primerTail).toEqual({
      startBioCol: 0,
      endBioCol: spacerSequence.length + homology.encoding.onRight,
    });
    expect(overlap).toEqual(
      expect.objectContaining({
        kind: 'homology-width',
        startBioCol: annealingOverlap.startBioCol,
        endBioCol: annealingOverlap.endBioCol,
        rightTailStartBioCol: primerTail.startBioCol,
      })
    );
  });

  it('pins overlap{Start,End}BioCol to actual primer-tail geometry  cut-site)', () => {
    const spacerSequence = 'ATGCCT';
    const left = region('pcr-left', 'ACGT'.repeat(30));
    const right = region('pcr-right', 'TGCA'.repeat(30));
    const design: SequenceDesign = {
      ...createDesign('gibson'),
      topology: 'linear',
      regions: [left, right],
      spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: spacerSequence }],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];
    const productRow = model.rows.find((row) => row.kind === 'product')!;
    const overlap = productRow.constraints?.find(
      (constraint) => constraint.kind === 'homology-width'
    ) as
      | {
          overlapStartBioCol?: number;
          overlapEndBioCol?: number;
          leftTailEndBioCol?: number;
          rightTailStartBioCol?: number;
        }
      | undefined;
    expect(overlap).toBeDefined();
    if (!overlap) throw new Error('overlap constraint missing');

    const allPrimers = draft.designPrimers.flatMap((p) => [p.forward, p.reverse]);
    const leftPrimer = allPrimers.find((p) => p.fragmentIndex === 1 && p.direction === 'forward')!;
    const rightPrimer = allPrimers.find((p) => p.fragmentIndex === 0 && p.direction === 'reverse')!;
    const leftTailLength = leftPrimer.overhang.tailLength ?? leftPrimer.overhang.sequence.length;
    const rightTailLength = rightPrimer.overhang.tailLength ?? rightPrimer.overhang.sequence.length;

    expect(overlap.overlapStartBioCol).toBe((overlap.leftTailEndBioCol ?? 0) - leftTailLength);
    expect(overlap.overlapEndBioCol).toBe((overlap.rightTailStartBioCol ?? 0) + rightTailLength);
  });

  it('overlapEnd shifts when right primer PBS intrudes  negative encoding handles asymmetric)', () => {
    const spacer = 'ATGCCT';
    const left = region('pcr-left', 'ACGT'.repeat(30));
    const right = region('pcr-right', 'TGCA'.repeat(30));
    const design: SequenceDesign = {
      ...createDesign('gibson'),
      topology: 'linear',
      regions: [left, right],
      spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: spacer }],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];
    const productRow = model.rows.find((row) => row.kind === 'product')!;
    const overlap = productRow.constraints?.find(
      (constraint) => constraint.kind === 'homology-width'
    ) as
      | {
          overlapStartBioCol?: number;
          overlapEndBioCol?: number;
          rightTailStartBioCol?: number;
          leftTailEndBioCol?: number;
        }
      | undefined;
    expect(overlap).toBeDefined();
    if (!overlap) throw new Error('overlap constraint missing');

    const allPrimers = draft.designPrimers.flatMap((p) => [p.forward, p.reverse]);
    const rightPrimer = allPrimers.find((p) => p.fragmentIndex === 0 && p.direction === 'reverse')!;
    const rightTailLength = rightPrimer.overhang.tailLength ?? rightPrimer.overhang.sequence.length;
    expect(overlap.overlapEndBioCol).toBe((overlap.rightTailStartBioCol ?? 0) + rightTailLength);
  });

  it('projects RD source cut geometry into source rows using the cut-site rendering contract', () => {
    const design = buildRealAssemblyPipelineDesign('gibson-rd-5prime-pcr');
    const draft = computeDraftAssembly(design);
    const models = buildJunctionWorkbenchModels(
      {
        ...design,
        homologyRegions: draft.homologyRegions,
        designPrimers: draft.designPrimers,
        goldenGateJunctions: draft.goldenGateJunctions,
      },
      { maxWindowBp: 500 }
    );
    const rdRows = models.flatMap((model) =>
      model.rows.filter(
        (row) =>
          (row.kind === 'left-source' || row.kind === 'right-source') &&
          (row.cutSites?.length ?? 0) > 0
      )
    );

    expect(rdRows.length).toBeGreaterThan(0);
    expect(rdRows.some((row) => row.cutSites!.some((site) => site.enzyme.name === 'EcoRI'))).toBe(
      true
    );
    expect(
      rdRows.some((row) =>
        row.cutSites!.some((site) => site.cutPositionTop !== site.cutPositionBottom)
      )
    ).toBe(true);
    for (const row of rdRows) {
      for (const site of row.cutSites ?? []) {
        expect(site.cutPositionTop).toBeGreaterThanOrEqual(0);
        expect(site.cutPositionTop).toBeLessThanOrEqual(row.sequence.length);
        expect(site.cutPositionBottom).toBeGreaterThanOrEqual(0);
        expect(site.cutPositionBottom).toBeLessThanOrEqual(row.sequence.length);
        expect(site.recognitionStart).toBeGreaterThanOrEqual(0);
        expect(site.recognitionEnd).toBeGreaterThanOrEqual(site.recognitionStart);
        expect(site.recognitionEnd).toBeLessThanOrEqual(row.sequence.length);
      }
    }
  });

  it('projects only the unresected remainder of NEBuilder RD scars', () => {
    const rd = region('rd-left', 'ATGC'.repeat(12) + 'CTGCA', {
      sourceType: 'rd',
      rdSourceEnzymeName: 'PstI',
      rdOverhangs: { upstream: 'NNNN', downstream: 'TGCA' },
      rdEnds: {
        downstream: {
          overhangType: '3_prime',
          overhang: 'TGCA',
          retainedScarSequence: 'CTGCA',
          retainedScarLength: 5,
          nebuilderResectionBases: 3,
        },
      },
    });
    const pcr = region('pcr-right', 'CGTA'.repeat(30));
    const design: SequenceDesign = {
      ...createDesign('nebuilder'),
      topology: 'linear',
      regions: [rd, pcr],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];
    const leftRow = model.rows.find((row) => row.kind === 'left-source')!;
    const productRow = model.rows.find((row) => row.kind === 'product')!;

    expect(scarSequences(productRow)).toContain('CT');
    expect(scarSequences(leftRow)).toContain('CT');
    expect(scarSequences(productRow)).not.toContain('CTGCA');
    expect(scarSequences(leftRow)).not.toContain('CTGCA');
  });

  it('keeps wrapped circular RD source context contributing across the source origin', () => {
    const sourceSequence = 'AAAACCCCGGGGTTTT'.repeat(4);
    const rdRegion: DesignRegion = {
      id: 'wrapped-rd',
      sourceSequenceId: 'wrapped-source',
      sourceSequenceName: 'Wrapped source',
      sourceStart: 60,
      sourceEnd: 100,
      sequence: sourceSequence.slice(-4) + sourceSequence.slice(0, 36),
      annotations: [],
      sourceSequence,
      sourceAnnotations: [],
      sourceIsCircular: true,
      sourceType: 'rd',
      rdSourceEnzymeName: 'WrapI',
      rdOverhangs: { upstream: 'TTTT', downstream: 'AAAA' },
      rdEnds: {
        downstream: {
          overhangType: '3_prime',
          overhang: 'AAAA',
          retainedScarSequence: 'AAAA',
          retainedScarLength: 4,
        },
      },
    };
    const design: SequenceDesign = {
      ...createDesign('gibson'),
      topology: 'circular',
      regions: [rdRegion, region('pcr-right', 'CGTA'.repeat(30))],
    };
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
      { maxWindowBp: 500 }
    )[0];
    const leftRow = model.rows.find((row) => row.kind === 'left-source')!;
    const wrappedOriginEnd = rdRegion.sourceEnd % sourceSequence.length;
    const contributingSourcePositions = leftRow
      .contributingColumns!.map((column) => leftRow.points[column]?.sourcePosition)
      .filter((position): position is number => typeof position === 'number');

    expect(contributingSourcePositions.length).toBeGreaterThan(0);
    expect(leftRow.mutedColumns!.length).toBeGreaterThan(0);
    expect(contributingSourcePositions.some((position) => position < wrappedOriginEnd)).toBe(true);
    expect(scarSequences(leftRow).length).toBeGreaterThan(0);
  });

  it('scopes rendered 5-prime primer tails to the junction that owns the tail', () => {
    const design = buildRealAssemblyPipelineDesign('gibson-pcr-rd-pcr');
    const models = buildJunctionWorkbenchModels(design, { maxWindowBp: 500 });

    const outOfScopeTails = models.flatMap((model) =>
      model.rows.flatMap((row) =>
        (row.primers ?? [])
          .filter((primer) => (primer.overhangLength ?? 0) > 0)
          .filter((primer) => primer.junctionIndex !== model.junctionIndex)
          .map((primer) => ({
            modelId: model.id,
            modelJunctionIndex: model.junctionIndex,
            rowId: row.id,
            rowKind: row.kind,
            sourcePrimerId: primer.sourcePrimerId,
            primerJunctionIndex: primer.junctionIndex,
            direction: primer.direction,
            start: primer.start,
            end: primer.end,
            overhangLength: primer.overhangLength,
          }))
      )
    );

    expect(outOfScopeTails).toEqual([]);
  });
});

function scarAnnotations(row: JunctionWorkbenchRow) {
  return row.annotations.filter((annotation) => annotation.type === 'restriction_scar');
}

function scarSequences(row: JunctionWorkbenchRow): string[] {
  return scarAnnotations(row).map((annotation) =>
    row.sequence.slice(annotation.start - 1, annotation.end).toUpperCase()
  );
}

function primerTailBioRange(
  primer: DesignPrimer,
  productOrigin: number
): { startBioCol: number; endBioCol: number } {
  const tailLength = primer.overhang.tailLength ?? primer.overhang.sequence.length;
  if (primer.direction === 'forward') {
    return {
      startBioCol: primer.pbs.start - tailLength - productOrigin,
      endBioCol: primer.pbs.start - productOrigin,
    };
  }
  return {
    startBioCol: primer.pbs.end - productOrigin,
    endBioCol: primer.pbs.end + tailLength - productOrigin,
  };
}

function createDesign(assemblyMethod: SequenceDesign['assemblyMethod'] = 'gibson'): SequenceDesign {
  const now = new Date('2026-04-26T00:00:00.000Z');
  return {
    id: `design-${assemblyMethod}`,
    name: 'Model Test Design',
    topology: 'circular',
    regions: [region('left', 'ATGCGTAC'.repeat(100)), region('right', 'GGCATACC'.repeat(100))],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: assemblyMethod === 'goldengate' ? { enzyme: 'BsaI' } : undefined,
    goldenGateJunctions: assemblyMethod === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function region(id: string, sequence: string, overrides: Partial<DesignRegion> = {}): DesignRegion {
  const upstream = `${id === 'left' ? 'T' : 'C'}`.repeat(320);
  const downstream = `${id === 'left' ? 'G' : 'A'}`.repeat(320);
  const sourceSequence = upstream + sequence + downstream;
  return {
    id,
    sourceSequenceId: id,
    sourceSequenceName: id,
    sourceStart: upstream.length,
    sourceEnd: upstream.length + sequence.length,
    sequence,
    annotations: [],
    sourceSequence,
    sourceAnnotations: [],
    sourceIsCircular: false,
    sourceType: 'pcr',
    ...overrides,
  };
}

function stripInlineSources(design: SequenceDesign): SequenceDesign {
  return {
    ...design,
    regions: design.regions.map((region) => ({
      ...region,
      sourceSequence: undefined,
      sourceAnnotations: undefined,
      sourceIsCircular: undefined,
    })),
  };
}

function goldenGateDesignWithOffset(
  design: SequenceDesign,
  junctionIndex: number,
  offset: number
): SequenceDesign {
  const productSequence = getComposedSequence(design.regions, design.spacers);
  const goldenGateJunctions = (design.goldenGateJunctions ?? []).map((junction) => {
    if (junction.junctionIndex !== junctionIndex) return junction;
    const overhangStart = junction.junctionPosition - 2 + offset;
    const overhangEnd = overhangStart + 4;
    return {
      ...junction,
      offset,
      overhangStart,
      overhangEnd,
      overhang: productSequence.slice(overhangStart, overhangEnd),
    };
  });
  return {
    ...design,
    goldenGateJunctions,
    designPrimers: computeGoldenGatePrimers(
      design.regions,
      goldenGateJunctions,
      design.topology,
      design.goldenGateConfig?.enzyme ?? 'BsaI',
      design.spacers
    ),
  };
}

function goldenGateProductPrimerPositions(row: JunctionWorkbenchRow) {
  return (row.primers ?? [])
    .filter((primer) => primer.cutPositionInOverhang !== undefined)
    .map((primer) => ({
      id: primer.sourcePrimerId ?? primer.id,
      start: primer.start,
      end: primer.end,
      scarAbsolutePosition: primer.scarAbsolutePosition,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function pointAtBioCol(row: JunctionWorkbenchRow, bioCol: number) {
  const point = row.points.find((item) => item.bioCol === bioCol);
  if (!point) throw new Error(`Missing bioCol ${bioCol} in row ${row.id}`);
  return point;
}

function rowPositionAtBioCol(row: JunctionWorkbenchRow, bioCol: number): number {
  return pointAtBioCol(row, bioCol).rowPosition;
}

function sequenceBaseAtBioCol(row: JunctionWorkbenchRow, bioCol: number): string {
  return row.sequence[rowPositionAtBioCol(row, bioCol)] ?? '';
}

function sequenceSliceByBioCol(row: JunctionWorkbenchRow, startBioCol: number, endBioCol: number) {
  let sequence = '';
  for (let bioCol = startBioCol; bioCol < endBioCol; bioCol++) {
    sequence += sequenceBaseAtBioCol(row, bioCol);
  }
  return sequence;
}

function kindsByBioCol(row: JunctionWorkbenchRow, startBioCol: number, endBioCol: number) {
  const kinds: string[] = [];
  for (let bioCol = startBioCol; bioCol < endBioCol; bioCol++) {
    kinds.push(pointAtBioCol(row, bioCol).kind);
  }
  return kinds;
}

function leftBoundaryModelWithSourceCds(strand: 'forward' | 'reverse', sourceEndDelta: number) {
  const design = createDesign();
  const leftRegion = design.regions[0];
  const sourceEnd = leftRegion.sourceEnd + sourceEndDelta;
  const sourceAnnotationStart = leftRegion.sourceEnd - 401;
  const sourceAnnotationEnd = leftRegion.sourceEnd + 160;
  design.regions[0] = {
    ...leftRegion,
    sourceEnd,
    sequence: leftRegion.sourceSequence!.slice(leftRegion.sourceStart, sourceEnd),
    sourceAnnotations: [
      {
        name: `source-cds-${strand}`,
        type: 'CDS',
        start: sourceAnnotationStart,
        end: sourceAnnotationEnd,
        strand,
        color: '#22c55e',
      },
    ],
  };
  const draft = computeDraftAssembly(design);
  const models = buildJunctionWorkbenchModels(
    { ...design, homologyRegions: draft.homologyRegions, designPrimers: draft.designPrimers },
    { maxWindowBp: 500 }
  );
  return {
    sourceEnd,
    model: models[0],
  };
}

function sourceCodonSpanCovering(
  row: JunctionWorkbenchRow,
  annotationName: string,
  sourcePosition: number
): number[] {
  const annotation = row.annotations.find(
    (item) => item.name === annotationName && item.type === 'CDS'
  );
  if (!annotation) throw new Error(`Missing ${annotationName}`);
  const codons = getCodonsForSingleCDS(annotation, 0, row.sequence.length, row.sequence);
  for (const codon of codons) {
    const sourcePositions = row.points
      .slice(codon.startPos, codon.endPos + 1)
      .map((point) => point.sourcePosition);
    if (sourcePositions.includes(sourcePosition)) {
      return sourcePositions.filter((position): position is number => typeof position === 'number');
    }
  }
  throw new Error(`No codon covers source position ${sourcePosition}`);
}
