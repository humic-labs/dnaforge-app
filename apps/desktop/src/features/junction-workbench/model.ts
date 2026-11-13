import type { Annotation, ColoredCutSite } from '@waypoint/sequence-utils';
import { isStopCodon, reverseComplement } from '@waypoint/sequence-utils';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type {
  DesignAnnotation,
  DesignPrimerPair,
  DesignRegion,
  GoldenGateJunction,
  HomologyRegion,
  SequenceDesign,
} from '../design/public/types';
import { getComposedSequence } from '../design/public/types';
import {
  getEffectiveDesignRegions,
  getVisibleRestrictionDigestScarSegments,
  isRestrictionDigestRegion,
} from '../design/public/restriction-digest';
import {
  calculateGcContent,
  isGoldenGateJunctionOffsetEditable,
} from '../design/public/algorithms/draft-assembly';
import { getFragmentHexForRegion } from '../design/public/colors';
import {
  DEFAULT_JUNCTION_WINDOW_BP,
  MAX_JUNCTION_WINDOW_BP,
  createCoordMapping,
  makeMappingPoint,
  type CoordMapping,
  type CoordMappingConstraint,
  type CoordMappingPointKind,
  type CoordMappingRow,
  type CoordMappingStrategyName,
} from './coord-mapping';
import {
  sourceWindowKey,
  type SourceContextStatus,
  type SourceContextWindow,
  type SourceContextWindowMap,
} from './SourceContextRegistry';
import { SOURCE_ROW_BUFFER_BP, computeRegisteredWindow } from './registered-window';
import { qualifiersForSourceSpaceAnnotationSlice } from './AnnotationFrameProjection';
import { deriveSourceRowFields } from './provenance/deriveRowFields';
import { projectSourceProvenance } from './provenance/projectJunctionProvenance';
import type { ValidatedSourceProvenanceProjection } from './provenance/types';

export interface JunctionWorkbenchRow extends CoordMappingRow {
  annotations: Annotation[];
  continuousAnnotations?: Annotation[];

  dragShiftedAnnotations?: Annotation[];
  dragShiftedContinuousAnnotations?: Annotation[];
  productDragPreview?: {
    owner: 'left' | 'right';
    sequence: string;
    annotations: Annotation[];
  };
  visibleColumns?: number[];
  contributingColumns?: number[];
  mutedColumns?: number[];
  spacerColumns?: number[];
  primers?: PrimerDisplay[];
  cutSites?: ColoredCutSite[];
  fragmentColor?: string;
  partnerFragmentColor?: string;
  leftFragmentColor?: string;
  rightFragmentColor?: string;
  sourceContextStatus?: SourceContextStatus | 'clipped-fallback';
  sourceProvenance?: ValidatedSourceProvenanceProjection;
  productOwners?: Array<'left' | 'right' | 'spacer'>;

  viewportFocusBioCol?: number;
  viewportFocusRowPosition?: number;
}

export interface JunctionWorkbenchModel {
  id: string;
  title: string;
  subtitle: string;
  method: CoordMappingStrategyName;
  junctionIndex: number;
  rows: JunctionWorkbenchRow[];
  mapping: CoordMapping;
  editable: boolean;
  homologyRegion?: HomologyRegion;
  goldenGateJunction?: GoldenGateJunction;
}

function fragmentColorHex(design: SequenceDesign, fragmentIndex: number): string {
  return getFragmentHexForRegion(design.regions[fragmentIndex], fragmentIndex);
}

function midpoint(startInclusive: number, endExclusive: number): number {
  return (startInclusive + endExclusive) / 2;
}

function unwrapPositionNearRange(
  position: number,
  rangeStartInclusive: number,
  rangeEndExclusive: number,
  sequenceLength: number
): number {
  if (sequenceLength <= 0) return position;
  const target = midpoint(rangeStartInclusive, rangeEndExclusive);
  const normalized = normalizePosition(position, sequenceLength);
  const nearestTurn = Math.round((target - normalized) / sequenceLength);
  let best = normalized + nearestTurn * sequenceLength;
  for (const turn of [nearestTurn - 1, nearestTurn + 1]) {
    const candidate = normalized + turn * sequenceLength;
    if (Math.abs(candidate - target) < Math.abs(best - target)) best = candidate;
  }
  return best;
}

export interface JunctionWorkbenchModelOptions {
  homologyRegions?: HomologyRegion[];
  includeUnannotatedJunctions?: boolean;
  maxWindowBp?: number;
  sourceWindows?: SourceContextWindowMap;

  sourceDragOverride?: {
    junctionIndex: number;
    rowKind: 'left-source' | 'right-source';
    offsetBp: number;
  };
}

interface RegionPosition {
  start: number;
  end: number;
}

interface WorkbenchPrimerDisplay extends PrimerDisplay {
  fragmentIndex?: number;
}

export function buildJunctionWorkbenchModels(
  design: SequenceDesign,
  options: JunctionWorkbenchModelOptions = {}
): JunctionWorkbenchModel[] {
  const canonicalModels = buildCanonicalModels(design, options);
  if (options.includeUnannotatedJunctions && design.regions.length > 1) {
    const displayRegions =
      design.assemblyMethod === 'goldengate'
        ? design.regions
        : getEffectiveDesignRegions({
            ...design,
            homologyRegions: options.homologyRegions ?? design.homologyRegions,
          });
    const productSequence = getComposedSequence(displayRegions, design.spacers);
    const regionPositions = computeRegionPositions(displayRegions, design.spacers);
    const maxWindowBp = Math.min(
      options.maxWindowBp ?? DEFAULT_JUNCTION_WINDOW_BP,
      MAX_JUNCTION_WINDOW_BP
    );
    const sourceAnnotationsByRegionId = sourceAnnotationsByRegionIdFromWindows(
      options.sourceWindows
    );
    const knownJunctions = new Set(canonicalModels.map((model) => model.junctionIndex));
    const junctionCount =
      design.topology === 'circular' ? displayRegions.length : displayRegions.length - 1;
    for (let junctionIndex = 0; junctionIndex < junctionCount; junctionIndex++) {
      if (knownJunctions.has(junctionIndex)) continue;
      canonicalModels.push(
        buildHomologyModel({
          design,
          displayRegions,
          productSequence,
          regionPositions,
          junctionIndex,
          maxWindowBp,
          method: design.assemblyMethod,
          sourceWindows: options.sourceWindows,
          sourceAnnotationsByRegionId,
        })
      );
    }
    canonicalModels.sort((left, right) => left.junctionIndex - right.junctionIndex);
  }
  return applyOverrideToCanonicalModels(
    canonicalModels,
    options.sourceWindows,
    options.sourceDragOverride,
    design
  );
}

function buildCanonicalModels(
  design: SequenceDesign,
  options: JunctionWorkbenchModelOptions
): JunctionWorkbenchModel[] {
  const maxWindowBp = Math.min(
    options.maxWindowBp ?? DEFAULT_JUNCTION_WINDOW_BP,
    MAX_JUNCTION_WINDOW_BP
  );
  if (design.regions.length < 2) return [];

  if (design.assemblyMethod === 'goldengate') {
    return buildGoldenGateModels(design, maxWindowBp, options.sourceWindows);
  }

  const effectiveDesign = {
    ...design,
    homologyRegions: options.homologyRegions ?? design.homologyRegions,
  };
  const displayRegions = getEffectiveDesignRegions(effectiveDesign);
  const productSequence = getComposedSequence(displayRegions, design.spacers);
  const regionPositions = computeRegionPositions(displayRegions, design.spacers);
  const sourceAnnotationsByRegionId = sourceAnnotationsByRegionIdFromWindows(options.sourceWindows);
  const method: CoordMappingStrategyName =
    design.assemblyMethod === 'nebuilder' ? 'nebuilder' : 'gibson';

  return [...effectiveDesign.homologyRegions]
    .sort((a, b) => a.junctionIndex - b.junctionIndex)
    .map((homologyRegion) =>
      buildHomologyModel({
        design,
        displayRegions,
        productSequence,
        regionPositions,
        homologyRegion,
        junctionIndex: homologyRegion.junctionIndex,
        maxWindowBp,
        method,
        sourceWindows: options.sourceWindows,
        sourceAnnotationsByRegionId,
      })
    );
}

function buildHomologyModel(input: {
  design: SequenceDesign;
  displayRegions: DesignRegion[];
  productSequence: string;
  regionPositions: RegionPosition[];
  homologyRegion?: HomologyRegion;
  junctionIndex: number;
  maxWindowBp: number;
  method: CoordMappingStrategyName;
  sourceWindows?: SourceContextWindowMap;
  sourceAnnotationsByRegionId?: Record<string, DesignAnnotation[]>;
}): JunctionWorkbenchModel {
  const {
    design,
    displayRegions,
    productSequence,
    regionPositions,
    homologyRegion,
    maxWindowBp,
    method,
    sourceWindows,
    sourceAnnotationsByRegionId,
  } = input;
  const leftIndex = input.junctionIndex;
  const rightIndex = (leftIndex + 1) % displayRegions.length;
  const leftRegion = displayRegions[leftIndex];
  const rightRegion = displayRegions[rightIndex];
  const spacerLength = spacerLengthForJunction(design, leftIndex);
  const junctionPosition = normalizePosition(
    homologyRegion?.junctionPosition ?? regionPositions[leftIndex].end + spacerLength,
    productSequence.length
  );
  const {
    registeredStartBioCol,
    registeredEndBioCol,
    length: productLength,
  } = computeRegisteredWindow(leftRegion, rightRegion, maxWindowBp, spacerLength);
  const registeredAnchorPosition = junctionPosition - spacerLength;
  const productStartRaw = registeredAnchorPosition + registeredStartBioCol;
  const allPrimers = designPrimersToDisplay(design);
  const homologyGeometry = homologyRegion
    ? homologyProductGeometry({
        design,
        homologyRegion,
        leftIndex,
        rightIndex,
        productOrigin: registeredAnchorPosition,
        productLength: productSequence.length,
        spacerLength,
      })
    : null;
  const crossoverStartBioCol = homologyGeometry?.startBioCol ?? 0;
  const crossoverEndBioCol = homologyGeometry?.endBioCol ?? spacerLength;
  const crossoverLength = crossoverEndBioCol - crossoverStartBioCol;
  const viewportFocusBioCol = midpoint(crossoverStartBioCol, crossoverEndBioCol);
  const effectiveDesign: SequenceDesign = {
    ...design,
    regions: displayRegions,
  };

  const productRow = buildProductRow({
    id: `${method}-${leftIndex}-product`,
    label: `Junction ${leftIndex + 1}`,
    sequence: productSequence,
    regionPositions,
    design: effectiveDesign,
    rawDesign: design,
    startRaw: productStartRaw,
    length: productLength,
    junctionPosition: registeredAnchorPosition,
    viewportFocusBioCol,
    constraints: homologyGeometry
      ? [
          {
            kind: 'homology-width',
            startBioCol: crossoverStartBioCol,
            endBioCol: crossoverEndBioCol,
            editable: true,
            label: `${crossoverLength} bp crossover`,
            spacerLength,
            leftHomologyEndBioCol: homologyGeometry.leftHomologyEndBioCol,
            rightHomologyStartBioCol: homologyGeometry.rightHomologyStartBioCol,
            leftTailEndBioCol: homologyGeometry.leftTailEndBioCol,
            rightTailStartBioCol: homologyGeometry.rightTailStartBioCol,
            leftTailPresent: homologyGeometry.leftTailPresent,
            rightTailPresent: homologyGeometry.rightTailPresent,
            overlapStartBioCol: homologyGeometry.overlapStartBioCol,
            overlapEndBioCol: homologyGeometry.overlapEndBioCol,
          },
        ]
      : [],
    sourceAnnotationsByRegionId,
    leftFragmentColor: fragmentColorHex(design, leftIndex),
    rightFragmentColor: fragmentColorHex(design, rightIndex),
    primers: projectPrimersToRow(allPrimers, {
      rowId: `${method}-${leftIndex}-product`,
      junctionIndex: leftIndex,
      registeredStartBioCol,
      registeredEndBioCol,
      junctionPosition: registeredAnchorPosition,
      productLength: productSequence.length,
    }),
  });

  const leftRow = buildRegisteredSourceRow({
    id: `${method}-${leftIndex}-left`,
    kind: 'left-source',
    label: leftRegion.sourceSequenceName || `Part ${leftIndex + 1}`,
    region: leftRegion,
    rawRegion: design.regions[leftIndex],
    assemblyMethod: method,
    side: 'left',
    registeredStartBioCol,
    registeredEndBioCol,
    productJunctionPosition: registeredAnchorPosition,
    viewportFocusBioCol,

    spacerLength: 0,
    pointKindForBioCol: (bioCol, includedInProduct) => {
      if (!includedInProduct) return 'unavailable';
      return bioCol >= crossoverStartBioCol && bioCol < 0 ? 'many-to-one' : 'valid';
    },
    constraints: sourceConstraints(design.regions[leftIndex], 'downstream', method),
    fragmentColor: fragmentColorHex(design, leftIndex),
    partnerFragmentColor: fragmentColorHex(design, rightIndex),
    sourceWindow: sourceWindows?.[sourceWindowKey(method, leftIndex, 'left')],
    primers: projectPrimersToRow(allPrimers, {
      rowId: `${method}-${leftIndex}-left`,
      junctionIndex: leftIndex,
      registeredStartBioCol,
      registeredEndBioCol,
      junctionPosition: registeredAnchorPosition,
      productLength: productSequence.length,
      fragmentIndex: leftIndex,
    }),
  });

  const rightRow = buildRegisteredSourceRow({
    id: `${method}-${leftIndex}-right`,
    kind: 'right-source',
    label: rightRegion.sourceSequenceName || `Part ${rightIndex + 1}`,
    region: rightRegion,
    rawRegion: design.regions[rightIndex],
    assemblyMethod: method,
    side: 'right',
    registeredStartBioCol,
    registeredEndBioCol,
    productJunctionPosition: registeredAnchorPosition,
    viewportFocusBioCol,

    spacerLength,
    pointKindForBioCol: (bioCol, includedInProduct) => {
      if (!includedInProduct) return 'unavailable';
      return bioCol >= spacerLength &&
        bioCol < spacerLength + (homologyRegion?.encoding.onRight ?? 0)
        ? 'many-to-one'
        : 'valid';
    },
    constraints: shiftConstraints(
      sourceConstraints(design.regions[rightIndex], 'upstream', method),
      spacerLength
    ),
    fragmentColor: fragmentColorHex(design, rightIndex),
    partnerFragmentColor: fragmentColorHex(design, leftIndex),
    sourceWindow: sourceWindows?.[sourceWindowKey(method, leftIndex, 'right')],
    primers: projectPrimersToRow(allPrimers, {
      rowId: `${method}-${leftIndex}-right`,
      junctionIndex: leftIndex,
      registeredStartBioCol,
      registeredEndBioCol,
      junctionPosition: registeredAnchorPosition,
      productLength: productSequence.length,
      fragmentIndex: rightIndex,
    }),
  });

  const rows = [leftRow, rightRow, productRow].map((row) =>
    homologyRegion
      ? row
      : {
          ...row,
          points: row.points.map((point) => ({ ...point, editable: false })),
          constraints: row.constraints?.map((constraint) => ({ ...constraint, editable: false })),
        }
  );
  return {
    id: `${method}-${leftIndex}`,
    title: `Junction ${leftIndex + 1}`,
    subtitle: !homologyRegion
      ? 'Saved overlap details are unavailable.'
      : method === 'nebuilder'
        ? 'NEBuilder homology with RD-end resection constraints'
        : 'Gibson PCR/PCR homology',
    method,
    junctionIndex: leftIndex,
    rows,
    mapping: createCoordMapping(method, { rows, maxWindowBp }),
    editable: Boolean(homologyRegion),
    homologyRegion,
  };
}

interface HomologyProductGeometry {
  startBioCol: number;
  endBioCol: number;
  leftHomologyEndBioCol: number;
  rightHomologyStartBioCol: number;
  leftTailEndBioCol: number;
  rightTailStartBioCol: number;
  leftTailPresent: boolean;
  rightTailPresent: boolean;

  overlapStartBioCol: number;
  overlapEndBioCol: number;
}

function homologyProductGeometry(input: {
  design: SequenceDesign;
  homologyRegion: HomologyRegion;
  leftIndex: number;
  rightIndex: number;
  productOrigin: number;
  productLength: number;
  spacerLength: number;
}): HomologyProductGeometry {
  const {
    design,
    homologyRegion,
    leftIndex,
    rightIndex,
    productOrigin,
    productLength,
    spacerLength,
  } = input;
  const leftPrimer = design.designPrimers
    .flatMap((pair) => [pair.forward, pair.reverse])
    .find(
      (primer) =>
        primer.junctionIndex === homologyRegion.junctionIndex &&
        primer.fragmentIndex === rightIndex &&
        primer.direction === 'forward'
    );
  const rightPrimer = design.designPrimers
    .flatMap((pair) => [pair.forward, pair.reverse])
    .find(
      (primer) =>
        primer.junctionIndex === homologyRegion.junctionIndex &&
        primer.fragmentIndex === leftIndex &&
        primer.direction === 'reverse'
    );
  const leftHomologyEndBioCol =
    homologyRegion.templateBasis?.leftHomologyEnd !== undefined
      ? productPositionToBioCol(
          homologyRegion.templateBasis.leftHomologyEnd,
          productOrigin,
          productLength
        )
      : spacerLength;
  const rightHomologyStartBioCol =
    homologyRegion.templateBasis?.rightHomologyStart !== undefined
      ? productPositionToBioCol(
          homologyRegion.templateBasis.rightHomologyStart,
          productOrigin,
          productLength
        )
      : spacerLength;
  const leftTailEndBioCol = leftPrimer
    ? productPositionToBioCol(leftPrimer.pbs.start, productOrigin, productLength)
    : spacerLength;
  const rightTailStartBioCol = rightPrimer
    ? productPositionToBioCol(rightPrimer.pbs.end, productOrigin, productLength)
    : 0;
  const starts: number[] = [];
  const ends: number[] = [];

  if (leftPrimer) {
    starts.push(leftHomologyEndBioCol - homologyRegion.encoding.onLeft);
    ends.push(leftHomologyEndBioCol);
  }
  if (rightPrimer) {
    starts.push(rightHomologyStartBioCol);
    ends.push(rightHomologyStartBioCol + homologyRegion.encoding.onRight);
  }
  if (starts.length === 0 || ends.length === 0) {
    starts.push(leftHomologyEndBioCol - homologyRegion.encoding.onLeft);
    ends.push(rightHomologyStartBioCol + homologyRegion.encoding.onRight);
  }

  const leftPrimerTailLength =
    leftPrimer?.overhang.tailLength ?? leftPrimer?.overhang.sequence?.length ?? 0;
  const rightPrimerTailLength =
    rightPrimer?.overhang.tailLength ?? rightPrimer?.overhang.sequence?.length ?? 0;
  const overlapStartBioCol = leftPrimer
    ? leftTailEndBioCol - leftPrimerTailLength
    : rightTailStartBioCol;
  const overlapEndBioCol = rightPrimer
    ? rightTailStartBioCol + rightPrimerTailLength
    : leftTailEndBioCol;

  return {
    startBioCol: Math.min(...starts),
    endBioCol: Math.max(...ends),
    leftHomologyEndBioCol,
    rightHomologyStartBioCol,
    leftTailEndBioCol,
    rightTailStartBioCol,
    leftTailPresent: Boolean(leftPrimer),
    rightTailPresent: Boolean(rightPrimer),
    overlapStartBioCol,
    overlapEndBioCol,
  };
}

function productPositionToBioCol(
  position: number,
  productOrigin: number,
  productLength: number
): number {
  let delta = Math.round(position - productOrigin);
  if (productLength <= 0) return delta;
  while (delta > productLength / 2) delta -= productLength;
  while (delta < -productLength / 2) delta += productLength;
  return delta;
}

function buildGoldenGateModels(
  design: SequenceDesign,
  maxWindowBp: number,
  sourceWindows?: SourceContextWindowMap
): JunctionWorkbenchModel[] {
  const productSequence = getComposedSequence(design.regions, design.spacers);
  const regionPositions = computeRegionPositions(design.regions, design.spacers);
  const sourceAnnotationsByRegionId = sourceAnnotationsByRegionIdFromWindows(sourceWindows);
  const allPrimers = designPrimersToDisplay(design);
  return [...(design.goldenGateJunctions ?? [])]
    .sort((a, b) => a.junctionIndex - b.junctionIndex)
    .map((junction) => {
      const leftIndex = junction.junctionIndex;
      const rightIndex = (leftIndex + 1) % design.regions.length;
      const leftRegion = design.regions[leftIndex];
      const rightRegion = design.regions[rightIndex];
      const spacerLength = spacerLengthForJunction(design, leftIndex);
      const junctionPosition = unwrapPositionNearRange(
        junction.junctionPosition,
        junction.overhangStart,
        junction.overhangEnd,
        productSequence.length
      );
      const {
        registeredStartBioCol,
        registeredEndBioCol,
        length: productLength,
      } = computeRegisteredWindow(leftRegion, rightRegion, maxWindowBp, spacerLength);
      const registeredAnchorPosition = junctionPosition - spacerLength;
      const overhangEditable = isGoldenGateJunctionOffsetEditable(junction);
      const overhangFixed = !overhangEditable;
      const overhangStartBioCol = junction.overhangStart - registeredAnchorPosition;
      const overhangEndBioCol = junction.overhangEnd - registeredAnchorPosition;
      const viewportFocusBioCol = spacerLength / 2;
      const productRow = buildProductRow({
        id: `goldengate-${leftIndex}-product`,
        label: `Junction ${leftIndex + 1}`,
        sequence: productSequence,
        regionPositions,
        design,
        startRaw: registeredAnchorPosition + registeredStartBioCol,
        length: productLength,
        junctionPosition: registeredAnchorPosition,
        viewportFocusBioCol,
        constraints: [
          {
            kind: 'fixed-overhang',
            startBioCol: overhangStartBioCol,
            endBioCol: overhangEndBioCol,
            editable: overhangEditable,
            label: overhangFixed ? 'Fixed RD overhang' : 'PCR-designed overhang',
          },
        ],
        sourceAnnotationsByRegionId,
        leftFragmentColor: fragmentColorHex(design, leftIndex),
        rightFragmentColor: fragmentColorHex(design, rightIndex),
        specialKindForBioCol: (bioCol) => {
          const productPos = normalizePosition(
            registeredAnchorPosition + bioCol,
            productSequence.length
          );
          const inOverhang = productPositionInRange(
            productPos,
            { start: junction.overhangStart, end: junction.overhangEnd },
            productSequence.length
          );
          if (!inOverhang) return 'valid';
          return overhangFixed ? 'constrained-end' : 'generated-tail';
        },
        primers: projectPrimersToRow(allPrimers, {
          rowId: `goldengate-${leftIndex}-product`,
          junctionIndex: leftIndex,
          registeredStartBioCol,
          registeredEndBioCol,
          junctionPosition: registeredAnchorPosition,
          productLength: productSequence.length,
        }),
      });
      const leftRow = buildRegisteredSourceRow({
        id: `goldengate-${leftIndex}-left`,
        kind: 'left-source',
        label: leftRegion.sourceSequenceName || `Part ${leftIndex + 1}`,
        region: leftRegion,
        rawRegion: leftRegion,
        assemblyMethod: 'goldengate',
        side: 'left',
        registeredStartBioCol,
        registeredEndBioCol,
        productJunctionPosition: registeredAnchorPosition,
        viewportFocusBioCol,

        spacerLength: 0,
        pointKindForBioCol: (bioCol, includedInProduct) => {
          if (!includedInProduct) return 'unavailable';
          return overhangFixed && bioCol >= -4 && bioCol < 0 ? 'constrained-end' : 'valid';
        },
        constraints: sourceConstraints(leftRegion, 'downstream', 'goldengate'),
        fragmentColor: fragmentColorHex(design, leftIndex),
        partnerFragmentColor: fragmentColorHex(design, rightIndex),
        sourceWindow: sourceWindows?.[sourceWindowKey('goldengate', leftIndex, 'left')],
        primers: projectPrimersToRow(allPrimers, {
          rowId: `goldengate-${leftIndex}-left`,
          junctionIndex: leftIndex,
          registeredStartBioCol,
          registeredEndBioCol,
          junctionPosition: registeredAnchorPosition,
          productLength: productSequence.length,
          fragmentIndex: leftIndex,
          suppressTypeIISCutSiteRendering: true,
        }),
      });
      const rightRow = buildRegisteredSourceRow({
        id: `goldengate-${leftIndex}-right`,
        kind: 'right-source',
        label: rightRegion.sourceSequenceName || `Part ${rightIndex + 1}`,
        region: rightRegion,
        rawRegion: rightRegion,
        assemblyMethod: 'goldengate',
        side: 'right',
        registeredStartBioCol,
        registeredEndBioCol,
        productJunctionPosition: registeredAnchorPosition,
        viewportFocusBioCol,
        spacerLength,
        pointKindForBioCol: (bioCol, includedInProduct) => {
          if (!includedInProduct) return 'unavailable';
          return overhangFixed && bioCol >= spacerLength && bioCol < spacerLength + 4
            ? 'constrained-end'
            : 'valid';
        },
        constraints: shiftConstraints(
          sourceConstraints(rightRegion, 'upstream', 'goldengate'),
          spacerLength
        ),
        fragmentColor: fragmentColorHex(design, rightIndex),
        partnerFragmentColor: fragmentColorHex(design, leftIndex),
        sourceWindow: sourceWindows?.[sourceWindowKey('goldengate', leftIndex, 'right')],
        primers: projectPrimersToRow(allPrimers, {
          rowId: `goldengate-${leftIndex}-right`,
          junctionIndex: leftIndex,
          registeredStartBioCol,
          registeredEndBioCol,
          junctionPosition: registeredAnchorPosition,
          productLength: productSequence.length,
          fragmentIndex: rightIndex,
          suppressTypeIISCutSiteRendering: true,
        }),
      });
      const rows = [leftRow, rightRow, productRow];
      return {
        id: `goldengate-${leftIndex}`,
        title: `Junction ${leftIndex + 1}`,
        subtitle: overhangFixed
          ? 'Golden Gate fixed overhang'
          : 'Golden Gate PCR-designed overhang',
        method: 'goldengate',
        junctionIndex: leftIndex,
        rows,
        mapping: createCoordMapping('goldengate', { rows, maxWindowBp }),
        editable: overhangEditable,
        goldenGateJunction: junction,
      };
    });
}

export function applyOverrideToCanonicalModels(
  models: JunctionWorkbenchModel[],
  sourceWindows: SourceContextWindowMap | undefined,
  override: JunctionWorkbenchModelOptions['sourceDragOverride'] | undefined,
  design?: SequenceDesign
): JunctionWorkbenchModel[] {
  if (!override || override.offsetBp === 0 || !sourceWindows) return models;
  return models.map((model) => {
    if (model.junctionIndex !== override.junctionIndex) return model;
    let mutated = false;
    let activeShiftedRow: JunctionWorkbenchRow | null = null;
    let nextRows = model.rows.map((row) => {
      if (row.kind !== override.rowKind) return row;
      const side = row.kind === 'left-source' ? 'left' : 'right';
      const key = sourceWindowKey(model.method, model.junctionIndex, side);
      const sourceWindow = sourceWindows[key];
      if (!sourceWindow) return row;
      const shifted = computeShiftedSequence(row, sourceWindow, override.offsetBp);
      if (shifted === null) return row;
      mutated = true;

      const shiftedAnnotations = shiftAnnotationsByRow(row.annotations, -override.offsetBp);
      const shiftedContinuous = row.continuousAnnotations
        ? shiftAnnotationsByRow(row.continuousAnnotations, -override.offsetBp)
        : undefined;
      activeShiftedRow = {
        ...row,
        sequence: shifted,
        dragShiftedAnnotations: shiftedAnnotations,
        dragShiftedContinuousAnnotations: shiftedContinuous,
      };
      return activeShiftedRow;
    });
    if (mutated && design && activeShiftedRow) {
      const productPreview = buildProductDragPreview({
        model,
        design,
        sourceWindows,
        override,
        activeShiftedRow,
      });
      if (productPreview) {
        nextRows = nextRows.map((row) =>
          row.kind === 'product' ? { ...row, productDragPreview: productPreview } : row
        );
      }
    }
    return mutated ? { ...model, rows: nextRows } : model;
  });
}

function shiftAnnotationsByRow(annotations: Annotation[], deltaRowPositions: number): Annotation[] {
  if (deltaRowPositions === 0) return annotations;
  return annotations.map((annotation) => ({
    ...annotation,
    start: annotation.start + deltaRowPositions,
    end: annotation.end + deltaRowPositions,
  }));
}

function computeShiftedSequence(
  row: JunctionWorkbenchRow,
  sourceWindow: SourceContextWindow,
  offsetBp: number
): string | null {
  const ctx = sourceWindow.sourceContextSequence;
  const ctxStart = sourceWindow.sourceContextStart;
  const ctxEnd = sourceWindow.sourceContextEnd;
  if (ctx === undefined || ctxStart === undefined || ctxEnd === undefined) return null;
  const length = row.sequence.length;
  const points = row.points;
  if (!Array.isArray(points) || points.length !== length) return null;
  const chars: string[] = new Array(length);
  for (let i = 0; i < length; i++) {
    const point = points[i];
    const canonicalSp = point?.sourcePosition;
    if (canonicalSp === null || canonicalSp === undefined) {
      chars[i] = ' ';
      continue;
    }
    const shiftedSp = canonicalSp + offsetBp;
    if (shiftedSp >= ctxStart && shiftedSp < ctxEnd) {
      chars[i] = ctx[shiftedSp - ctxStart] ?? ' ';
    } else {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

function sourceAnnotationsByRegionIdFromWindows(
  sourceWindows: SourceContextWindowMap | undefined
): Record<string, DesignAnnotation[]> | undefined {
  if (!sourceWindows) return undefined;
  const byRegionId: Record<string, DesignAnnotation[]> = {};
  for (const window of Object.values(sourceWindows)) {
    if (!window.regionId || window.sourceAnnotations.length === 0) continue;
    byRegionId[window.regionId] = window.sourceAnnotations.map((annotation) => ({
      ...annotation,
      qualifiers: annotation.qualifiers ? { ...annotation.qualifiers } : undefined,
    }));
  }
  return Object.keys(byRegionId).length > 0 ? byRegionId : undefined;
}

function sourceAnnotationKey(regionId: string, annotation: DesignAnnotation): string {
  return [
    regionId,
    annotation.name,
    annotation.type,
    annotation.start,
    annotation.end,
    annotation.strand,
  ].join(':');
}

function buildProductDragPreview(input: {
  model: JunctionWorkbenchModel;
  design: SequenceDesign;
  sourceWindows: SourceContextWindowMap;
  override: NonNullable<JunctionWorkbenchModelOptions['sourceDragOverride']>;
  activeShiftedRow: JunctionWorkbenchRow;
}): NonNullable<JunctionWorkbenchRow['productDragPreview']> | null {
  const productRow = input.model.rows.find((row) => row.kind === 'product');
  if (!productRow) return null;

  const owner = input.override.rowKind === 'left-source' ? 'left' : 'right';
  const leftIndex = input.model.junctionIndex;
  const rightIndex = (leftIndex + 1) % input.design.regions.length;
  const activeRegionIndex = owner === 'left' ? leftIndex : rightIndex;
  const activeWindow =
    input.sourceWindows[sourceWindowKey(input.model.method, input.model.junctionIndex, owner)];
  const sourceAnnotationsByRegionId = sourceAnnotationsByRegionIdFromWindows(input.sourceWindows);
  const effectiveDesign = {
    ...input.design,
    homologyRegions: input.design.homologyRegions,
  };
  const displayRegions = getEffectiveDesignRegions(effectiveDesign);
  const previewRegions = displayRegions.map((region, index) => {
    if (index !== activeRegionIndex) return region;
    const shiftedStart = region.sourceStart + input.override.offsetBp;
    const shiftedEnd = region.sourceEnd + input.override.offsetBp;
    return {
      ...region,
      sourceStart: shiftedStart,
      sourceEnd: shiftedEnd,
      sequence:
        shiftedRegionSequenceForPreview(region, activeWindow, input.override.offsetBp) ??
        region.sequence,
    };
  });
  const previewDesign: SequenceDesign = {
    ...input.design,
    regions: previewRegions,
  };
  const previewProductSequence = getComposedSequence(previewRegions, input.design.spacers);
  const previewRegionPositions = computeRegionPositions(previewRegions, input.design.spacers);
  const sliceStartRaw = productRow.coordinateStart;
  const basePreviewSequence = circularSlice(
    previewProductSequence,
    sliceStartRaw,
    productRow.sequence.length
  );
  const sequence = overlayActiveOwnerProductBases({
    productRow,
    activeShiftedRow: input.activeShiftedRow,
    owner,
    baseSequence: basePreviewSequence,
  });
  const consumedSourceCdsKeys = new Set<string>();
  const continuedCdss = synthesizeCandidateContinuationCdss({
    productSequence: previewProductSequence,
    regionPositions: previewRegionPositions,
    regions: previewRegions,
    spacers: input.design.spacers,
    sliceStartRaw,
    sliceLength: productRow.sequence.length,
    productLength: previewProductSequence.length,
    sourceAnnotationsByRegionId,
    consumedSourceCdsKeys,
  });
  const annotations = [
    ...annotationsForProductSlice(
      previewDesign,
      previewRegionPositions,
      sliceStartRaw,
      productRow.sequence.length,
      previewProductSequence.length,
      sourceAnnotationsByRegionId,
      consumedSourceCdsKeys
    ),
    ...continuedCdss,
  ];
  return { owner, sequence, annotations };
}

function shiftedRegionSequenceForPreview(
  region: DesignRegion,
  sourceWindow: SourceContextWindow | undefined,
  offsetBp: number
): string | null {
  const shiftedStart = region.sourceStart + offsetBp;
  const shiftedEnd = region.sourceEnd + offsetBp;
  if (
    sourceWindow &&
    shiftedStart >= sourceWindow.sourceContextStart &&
    shiftedEnd <= sourceWindow.sourceContextEnd
  ) {
    return sourceWindow.sourceContextSequence.slice(
      shiftedStart - sourceWindow.sourceContextStart,
      shiftedEnd - sourceWindow.sourceContextStart
    );
  }
  if (region.sourceSequence && shiftedStart >= 0 && shiftedEnd <= region.sourceSequence.length) {
    return region.sourceSequence.slice(shiftedStart, shiftedEnd);
  }
  return null;
}

function overlayActiveOwnerProductBases(input: {
  productRow: JunctionWorkbenchRow;
  activeShiftedRow: JunctionWorkbenchRow;
  owner: 'left' | 'right';
  baseSequence: string;
}): string {
  const sourceRowPositionByBioCol = new Map<number, number>();
  for (const point of input.activeShiftedRow.points) {
    sourceRowPositionByBioCol.set(point.bioCol, point.rowPosition);
  }
  const spacerColumns = new Set(input.productRow.spacerColumns ?? []);
  const chars = input.baseSequence.split('');
  for (const point of input.productRow.points) {
    if (spacerColumns.has(point.rowPosition)) continue;
    if (input.owner === 'left' ? point.bioCol >= 0 : point.bioCol < 0) continue;
    const sourceRowPosition = sourceRowPositionByBioCol.get(point.bioCol);
    if (sourceRowPosition === undefined) continue;
    chars[point.rowPosition] = input.activeShiftedRow.sequence[sourceRowPosition] ?? ' ';
  }
  return chars.join('');
}

function buildProductRow(input: {
  id: string;
  label: string;
  sequence: string;
  regionPositions: RegionPosition[];
  design: SequenceDesign;
  rawDesign?: SequenceDesign;
  startRaw: number;
  length: number;
  junctionPosition: number;
  viewportFocusBioCol?: number;
  constraints: CoordMappingConstraint[];
  specialKindForBioCol?: (bioCol: number) => CoordMappingPointKind;
  primers?: PrimerDisplay[];
  leftFragmentColor?: string;
  rightFragmentColor?: string;
  sourceAnnotationsByRegionId?: Record<string, DesignAnnotation[]>;
}): JunctionWorkbenchRow {
  const rowSequence = circularSlice(input.sequence, input.startRaw, input.length);
  const spacerColumns: number[] = [];
  const productOwners: Array<'left' | 'right' | 'spacer'> = [];
  const points = Array.from({ length: rowSequence.length }, (_, rowPosition) => {
    const productPosition = normalizePosition(input.startRaw + rowPosition, input.sequence.length);
    const bioCol = input.startRaw + rowPosition - input.junctionPosition;
    const isSpacer = isSpacerPosition(productPosition, input.regionPositions, input.design);
    if (isSpacer) spacerColumns.push(rowPosition);
    productOwners.push(isSpacer ? 'spacer' : bioCol < 0 ? 'left' : 'right');
    const spacerKind = isSpacer ? 'generated-tail' : 'valid';
    const kind = input.specialKindForBioCol?.(bioCol) ?? spacerKind;
    return makeMappingPoint(input.id, rowPosition, bioCol, productPosition, kind);
  });
  const anchorRowPosition = input.junctionPosition - input.startRaw;
  const viewportFocusBioCol = input.viewportFocusBioCol ?? 0;

  return {
    id: input.id,
    kind: 'product',
    label: input.label,
    sequence: rowSequence,
    coordinateStart: normalizePosition(input.startRaw, input.sequence.length),
    anchorRowPosition,
    viewportFocusBioCol,
    viewportFocusRowPosition: anchorRowPosition + viewportFocusBioCol,
    points,
    visibleColumns: points.map((point) => point.rowPosition),
    contributingColumns: points.map((point) => point.rowPosition),
    mutedColumns: [],
    spacerColumns,
    productOwners,
    constraints: input.constraints,
    primers: input.primers,
    leftFragmentColor: input.leftFragmentColor,
    rightFragmentColor: input.rightFragmentColor,
    annotations: productRowAnnotations({
      design: input.design,
      rawDesign: input.rawDesign,
      regionPositions: input.regionPositions,
      productSequence: input.sequence,
      sliceStartRaw: input.startRaw,
      sliceLength: input.length,
      sourceAnnotationsByRegionId: input.sourceAnnotationsByRegionId,
    }),
  };
}

function productRowAnnotations(input: {
  design: SequenceDesign;
  rawDesign?: SequenceDesign;
  regionPositions: RegionPosition[];
  productSequence: string;
  sliceStartRaw: number;
  sliceLength: number;
  sourceAnnotationsByRegionId?: Record<string, DesignAnnotation[]>;
}): Annotation[] {
  const consumedSourceCdsKeys = new Set<string>();
  const continuedCdss = synthesizeCandidateContinuationCdss({
    productSequence: input.productSequence,
    regionPositions: input.regionPositions,
    regions: input.design.regions,
    spacers: input.design.spacers,
    sliceStartRaw: input.sliceStartRaw,
    sliceLength: input.sliceLength,
    productLength: input.productSequence.length,
    sourceAnnotationsByRegionId: input.sourceAnnotationsByRegionId,
    consumedSourceCdsKeys,
  });
  return [
    ...annotationsForProductSlice(
      input.design,
      input.regionPositions,
      input.sliceStartRaw,
      input.sliceLength,
      input.productSequence.length,
      input.sourceAnnotationsByRegionId,
      consumedSourceCdsKeys,
      input.rawDesign
    ),
    ...continuedCdss,
  ];
}

function buildRegisteredSourceRow(input: {
  id: string;
  kind: 'left-source' | 'right-source';
  label: string;
  region: DesignRegion;
  rawRegion?: DesignRegion;
  assemblyMethod: SequenceDesign['assemblyMethod'];
  side: 'left' | 'right';
  registeredStartBioCol: number;
  registeredEndBioCol: number;
  productJunctionPosition: number;
  viewportFocusBioCol?: number;

  spacerLength: number;
  pointKindForBioCol: (bioCol: number, includedInProduct: boolean) => CoordMappingPointKind;
  constraints: CoordMappingConstraint[];
  primers?: PrimerDisplay[];
  fragmentColor?: string;
  partnerFragmentColor?: string;
  sourceWindow?: SourceContextWindow;
}): JunctionWorkbenchRow {
  const bufferLeft = SOURCE_ROW_BUFFER_BP;
  const bufferRight = SOURCE_ROW_BUFFER_BP;
  const extendedStart = input.registeredStartBioCol - bufferLeft;
  const anchorRowPosition = -extendedStart;
  const viewportFocusBioCol = input.viewportFocusBioCol ?? 0;
  const sourceProvenance = projectSourceProvenance({
    rowId: input.id,
    side: input.side,
    region: input.region,
    rawRegion: input.rawRegion,
    assemblyMethod: input.assemblyMethod,
    registeredStartBioCol: input.registeredStartBioCol,
    registeredEndBioCol: input.registeredEndBioCol,
    productJunctionPosition: input.productJunctionPosition,
    spacerLength: input.spacerLength,
    bufferLeft,
    bufferRight,
    sourceWindow: input.sourceWindow,
  });
  const derived = deriveSourceRowFields(sourceProvenance, {
    pointKindForBioCol: input.pointKindForBioCol,
  });
  const mutedColumnSet = derived.mutedColumnSet;
  const continuousAnnotationMutedColumnSet = new Set<number>();

  const shiftedPrimers = (input.primers ?? []).map((primer) => ({
    ...primer,
    start: primer.start + bufferLeft,
    end: primer.end + bufferLeft,
  }));
  const extraSourceAnnotations = restrictionDigestScarAnnotations(
    input.rawRegion ?? input.region,
    input.assemblyMethod,
    'source'
  );

  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    sequence: derived.sequence,
    coordinateStart: derived.coordinateStart,
    anchorRowPosition,
    viewportFocusBioCol,
    viewportFocusRowPosition: anchorRowPosition + viewportFocusBioCol,
    points: derived.points,
    visibleColumns: derived.visibleColumns,
    contributingColumns: derived.contributingColumns,
    mutedColumns: derived.mutedColumns,

    spacerColumns: [],
    constraints: input.constraints,
    primers: shiftedPrimers,
    cutSites: derived.cutSites,
    fragmentColor: input.fragmentColor,
    partnerFragmentColor: input.partnerFragmentColor,
    sourceContextStatus: sourceProvenance.sourceStatus,
    sourceProvenance,
    annotations: annotationsForRegisteredSource(input.region, {
      sourceByRowPosition: derived.sourceByRowPosition,
      mutedColumnSet,
      sourceAnnotations: input.sourceWindow?.sourceAnnotations,
      extraSourceAnnotations,
      sourceLength: sourceProvenance.sourceLength,
      sourceCircular: sourceProvenance.circular,
    }),
    continuousAnnotations: annotationsForRegisteredSource(input.region, {
      sourceByRowPosition: derived.sourceByRowPosition,
      mutedColumnSet: continuousAnnotationMutedColumnSet,
      sourceAnnotations: input.sourceWindow?.sourceAnnotations,
      extraSourceAnnotations,
      sourceLength: sourceProvenance.sourceLength,
      sourceCircular: sourceProvenance.circular,
    }),
  };
}

function computeRegionPositions(
  regions: DesignRegion[],
  spacers: SequenceDesign['spacers']
): RegionPosition[] {
  const positions: RegionPosition[] = [];
  let pos = 0;
  for (let i = 0; i < regions.length; i++) {
    positions.push({ start: pos, end: pos + regions[i].sequence.length });
    pos += regions[i].sequence.length;
    pos += spacers.find((spacer) => spacer.junctionIndex === i)?.sequence.length ?? 0;
  }
  return positions;
}

function spacerLengthForJunction(design: SequenceDesign, junctionIndex: number): number {
  return (
    design.spacers.find((spacer) => spacer.junctionIndex === junctionIndex)?.sequence.length ?? 0
  );
}

function shiftConstraints(
  constraints: CoordMappingConstraint[],
  deltaBioCol: number
): CoordMappingConstraint[] {
  if (deltaBioCol === 0) return constraints;
  return constraints.map((constraint) => ({
    ...constraint,
    startBioCol: constraint.startBioCol + deltaBioCol,
    endBioCol: constraint.endBioCol + deltaBioCol,
  }));
}

function sourceConstraints(
  region: DesignRegion | undefined,
  end: 'upstream' | 'downstream',
  method: CoordMappingStrategyName
): CoordMappingConstraint[] {
  if (!region || !isRestrictionDigestRegion(region)) return [];
  const rdEnd = region.rdEnds?.[end];
  const resection = rdEnd?.nebuilderResectionBases ?? 0;
  if (method === 'nebuilder' && resection > 0) {
    return [
      {
        kind: 'nebuilder-resection',
        startBioCol: end === 'upstream' ? 0 : -resection,
        endBioCol: end === 'upstream' ? resection : 0,
        editable: true,
        label: `${resection} bp resection window`,
      },
    ];
  }
  return [
    {
      kind: 'physical-end',
      startBioCol: end === 'upstream' ? 0 : -4,
      endBioCol: end === 'upstream' ? 4 : 0,
      editable: false,
      label: 'Physical digest end',
    },
  ];
}

function synthesizeCandidateContinuationCdss(input: {
  productSequence: string;
  regionPositions: RegionPosition[];
  regions: DesignRegion[];
  spacers: SequenceDesign['spacers'];
  sliceStartRaw: number;
  sliceLength: number;
  productLength: number;
  sourceAnnotationsByRegionId?: Record<string, DesignAnnotation[]>;
  consumedSourceCdsKeys?: Set<string>;
}): Annotation[] {
  const candidates: Annotation[] = [];
  if (input.sliceLength <= 0 || input.productLength <= 0) return candidates;

  for (let leftIdx = 0; leftIdx < input.regions.length; leftIdx++) {
    const rightIdx = (leftIdx + 1) % input.regions.length;
    const leftRegion = input.regions[leftIdx];
    const rightRegion = input.regions[rightIdx];
    const leftRegionStart = input.regionPositions[leftIdx]?.start ?? 0;
    const rightRegionStart = input.regionPositions[rightIdx]?.start ?? 0;
    const leftRegionEnd = input.regionPositions[leftIdx]?.end ?? leftRegionStart;
    const spacer = input.spacers.find((s) => s.junctionIndex === leftIdx);
    const spacerLength = spacer?.sequence.length ?? 0;

    walkForwardCandidates(
      candidates,
      leftRegion,
      leftRegionStart,
      leftRegionEnd,
      spacerLength,
      input
    );
    walkReverseCandidates(
      candidates,
      rightRegion,
      rightRegionStart,
      leftRegionEnd,
      spacerLength,
      input
    );
  }

  return candidates;
}

function walkForwardCandidates(
  out: Annotation[],
  leftRegion: DesignRegion,
  leftRegionStart: number,
  leftRegionEnd: number,
  spacerLength: number,
  ctx: {
    productSequence: string;
    sliceStartRaw: number;
    sliceLength: number;
    productLength: number;
    sourceAnnotationsByRegionId?: Record<string, DesignAnnotation[]>;
    consumedSourceCdsKeys?: Set<string>;
  }
): void {
  const sourceAnnotations =
    ctx.sourceAnnotationsByRegionId?.[leftRegion.id] ?? leftRegion.sourceAnnotations ?? [];
  for (const cds of sourceAnnotations) {
    if (cds.type !== 'CDS') continue;
    if (cds.strand !== 'forward') continue;

    if (cds.end <= leftRegion.sourceEnd) continue;
    if (cds.start >= leftRegion.sourceEnd) continue;

    const codonStart = parseInt(designQualifierValue(cds.qualifiers, 'codon_start') ?? '1', 10);

    const frameAnchorInProduct =
      leftRegionStart + (cds.start - leftRegion.sourceStart) + (codonStart - 1);

    const cdsStartInProduct = leftRegionStart + (cds.start - leftRegion.sourceStart);
    const candidateStart = Math.max(leftRegionStart, cdsStartInProduct);
    if (candidateStart < 0) continue;
    const candidateCodonStartOffset = positiveModulo(frameAnchorInProduct - candidateStart, 3);
    const firstContinuationCodonStart = candidateStart + candidateCodonStartOffset;
    const stopAtProduct = walkCodonsForwardUntilStop(
      ctx.productSequence,
      firstContinuationCodonStart,
      ctx.productLength
    );
    pushCandidateClipped(out, {
      name: `${cds.name} (predicted continuation)`,
      productStart: candidateStart,
      productEnd: stopAtProduct,
      direction: 1,
      color: cds.color,
      sliceStartRaw: ctx.sliceStartRaw,
      sliceLength: ctx.sliceLength,
      productLength: ctx.productLength,
      spacerLength,
      codonStart: (candidateCodonStartOffset + 1) as 1 | 2 | 3,
    });
    ctx.consumedSourceCdsKeys?.add(sourceAnnotationKey(leftRegion.id, cds));
  }
}

function walkReverseCandidates(
  out: Annotation[],
  rightRegion: DesignRegion,
  rightRegionStart: number,
  leftRegionEnd: number,
  spacerLength: number,
  ctx: {
    productSequence: string;
    sliceStartRaw: number;
    sliceLength: number;
    productLength: number;
    sourceAnnotationsByRegionId?: Record<string, DesignAnnotation[]>;
    consumedSourceCdsKeys?: Set<string>;
  }
): void {
  const sourceAnnotations =
    ctx.sourceAnnotationsByRegionId?.[rightRegion.id] ?? rightRegion.sourceAnnotations ?? [];
  for (const cds of sourceAnnotations) {
    if (cds.type !== 'CDS') continue;
    if (cds.strand !== 'reverse') continue;

    if (cds.start >= rightRegion.sourceStart) continue;
    if (cds.end <= rightRegion.sourceStart) continue;

    const codonStart = parseInt(designQualifierValue(cds.qualifiers, 'codon_start') ?? '1', 10);

    const frameAnchorInProduct =
      rightRegionStart + (cds.end - rightRegion.sourceStart) - (codonStart - 1);

    const cdsEndInProduct = rightRegionStart + (cds.end - rightRegion.sourceStart);
    const rightRegionEnd = rightRegionStart + (rightRegion.sourceEnd - rightRegion.sourceStart);
    const candidateEnd = Math.min(rightRegionEnd, cdsEndInProduct);
    if (candidateEnd > ctx.productLength) continue;
    const candidateCodonStartOffset = positiveModulo(candidateEnd - frameAnchorInProduct, 3);
    const firstContinuationCodonEnd = candidateEnd - candidateCodonStartOffset;
    const stopAtProduct = walkCodonsReverseUntilStop(
      ctx.productSequence,
      firstContinuationCodonEnd,
      ctx.productLength
    );
    pushCandidateClipped(out, {
      name: `${cds.name} (predicted continuation)`,
      productStart: stopAtProduct,
      productEnd: candidateEnd,
      direction: -1,
      color: cds.color,
      sliceStartRaw: ctx.sliceStartRaw,
      sliceLength: ctx.sliceLength,
      productLength: ctx.productLength,
      spacerLength,
      codonStart: (candidateCodonStartOffset + 1) as 1 | 2 | 3,
    });
    ctx.consumedSourceCdsKeys?.add(sourceAnnotationKey(rightRegion.id, cds));
  }
}

function walkCodonsForwardUntilStop(
  product: string,
  startPos: number,
  productLength: number
): number {
  let pos = startPos;
  while (pos + 3 <= productLength) {
    const codon = product.slice(pos, pos + 3);
    if (isStopCodon(codon)) return pos + 3;
    pos += 3;
  }
  return productLength;
}

function walkCodonsReverseUntilStop(
  product: string,
  endPos: number,
  productLength: number
): number {
  if (productLength <= 0) return 0;
  let pos = normalizePosition(endPos, productLength);
  let walked = 0;
  while (walked + 3 <= productLength) {
    const start = normalizePosition(pos - 3, productLength);
    const forwardSlice =
      start < pos ? product.slice(start, pos) : product.slice(start) + product.slice(0, pos);
    const codon = reverseComplement(forwardSlice);
    if (isStopCodon(codon)) return start;
    pos = start;
    walked += 3;
  }
  return 0;
}

function pushCandidateClipped(
  out: Annotation[],
  input: {
    name: string;
    productStart: number;
    productEnd: number;
    direction: 1 | -1;
    color?: string;
    sliceStartRaw: number;
    sliceLength: number;
    productLength: number;
    spacerLength: number;
    codonStart?: 1 | 2 | 3;
  }
): void {
  if (input.productEnd === input.productStart) return;

  for (let local = 0; local < input.sliceLength; local++) {
    const pos = normalizePosition(input.sliceStartRaw + local, input.productLength);
    if (!productRangeContains(pos, input.productStart, input.productEnd, input.productLength)) {
      continue;
    }
    const runStart = local;
    let runEnd = local + 1;
    while (runEnd < input.sliceLength) {
      const nextPos = normalizePosition(input.sliceStartRaw + runEnd, input.productLength);
      if (
        !productRangeContains(nextPos, input.productStart, input.productEnd, input.productLength)
      ) {
        break;
      }
      runEnd++;
    }
    out.push({
      name: input.name,
      type: 'CDS',
      start: runStart + 1,
      end: runEnd,
      direction: input.direction,
      color: input.color,
      qualifiers: {
        candidate: ['true'],
        codon_start: [
          String(
            clippedCandidateCodonStart({
              direction: input.direction,
              codonStart: input.codonStart ?? 1,
              productStart: input.productStart,
              productEnd: input.productEnd,
              productLength: input.productLength,
              clippedStart: pos,
              clippedEnd: normalizePosition(input.sliceStartRaw + runEnd, input.productLength),
            })
          ),
        ],
      },
    });
    local = runEnd - 1;
  }
}

function sequenceQualifiersFromDesign(
  qualifiers: Record<string, string> | undefined
): Record<string, string[]> | undefined {
  if (!qualifiers) return undefined;
  const converted: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(qualifiers)) {
    converted[key] = [value];
  }
  return converted;
}

function designQualifierValue(
  qualifiers: Record<string, string> | undefined,
  key: string
): string | undefined {
  return qualifiers?.[key];
}

function productRangeContains(
  productPosition: number,
  start: number,
  end: number,
  productLength: number
): boolean {
  if (productLength <= 0 || start === end) return false;
  const normalizedStart = normalizePosition(start, productLength);
  const normalizedEnd =
    end === productLength ? productLength : normalizePosition(end, productLength);
  if (normalizedStart < normalizedEnd) {
    return productPosition >= normalizedStart && productPosition < normalizedEnd;
  }
  return productPosition >= normalizedStart || productPosition < normalizedEnd;
}

function clippedCandidateCodonStart(input: {
  direction: 1 | -1;
  codonStart: 1 | 2 | 3;
  productStart: number;
  productEnd: number;
  productLength: number;
  clippedStart: number;
  clippedEnd: number;
}): 1 | 2 | 3 {
  const baseOffset = Math.max(0, Math.min(2, input.codonStart - 1));
  const skippedFromFivePrime =
    input.direction === 1
      ? circularForwardDistance(input.productStart, input.clippedStart, input.productLength)
      : circularForwardDistance(input.clippedEnd, input.productEnd, input.productLength);
  return (positiveModulo(baseOffset - skippedFromFivePrime, 3) + 1) as 1 | 2 | 3;
}

function circularForwardDistance(start: number, end: number, length: number): number {
  if (length <= 0) return 0;
  return positiveModulo(normalizePosition(end, length) - normalizePosition(start, length), length);
}

function annotationsForProductSlice(
  design: SequenceDesign,
  positions: RegionPosition[],
  startRaw: number,
  length: number,
  productLength: number,
  sourceAnnotationsByRegionId?: Record<string, DesignAnnotation[]>,
  skipSourceAnnotationKeys?: ReadonlySet<string>,
  rawDesign?: SequenceDesign
): Annotation[] {
  const annotations: Annotation[] = [];
  if (productLength <= 0) return annotations;
  design.regions.forEach((region, regionIndex) => {
    const rawRegion = rawDesign?.regions[regionIndex] ?? region;
    const regionStart = positions[regionIndex]?.start ?? 0;
    const sourceAnnotations = sourceAnnotationsByRegionId?.[region.id] ?? region.sourceAnnotations;
    if (sourceAnnotations && sourceAnnotations.length > 0) {
      for (const annotation of sourceAnnotations) {
        if (skipSourceAnnotationKeys?.has(sourceAnnotationKey(region.id, annotation))) continue;
        const clippedStart = Math.max(annotation.start, region.sourceStart);
        const clippedEnd = Math.min(annotation.end, region.sourceEnd);
        if (clippedEnd <= clippedStart) continue;
        pushSlicedSourceAnnotation(
          annotations,
          annotation,
          regionStart,
          region.sourceStart,
          clippedStart,
          clippedEnd,
          startRaw,
          length,
          productLength
        );
      }
    } else {
      for (const annotation of region.annotations) {
        const absStart = regionStart + annotation.start;
        const absEnd = regionStart + annotation.end;
        pushSlicedAnnotation(
          annotations,
          annotation,
          absStart,
          absEnd,
          startRaw,
          length,
          productLength
        );
      }
    }

    for (const annotation of restrictionDigestScarAnnotations(
      rawRegion,
      design.assemblyMethod,
      'product'
    )) {
      const absStart = regionStart + annotation.start;
      const absEnd = regionStart + annotation.end;
      pushSlicedAnnotation(
        annotations,
        annotation,
        absStart,
        absEnd,
        startRaw,
        length,
        productLength
      );
    }
  });
  return annotations;
}

const REVIEW_GRAY_ANNOTATION_COLOR = '#e5e7eb';
const RD_SCAR_ANNOTATION_COLOR = '#f59e0b';

function annotationsForRegisteredSource(
  region: DesignRegion,
  input: {
    sourceByRowPosition: ReadonlyArray<number | null>;
    mutedColumnSet: ReadonlySet<number>;
    sourceAnnotations?: DesignAnnotation[];
    extraSourceAnnotations?: DesignAnnotation[];
    sourceLength: number;
    sourceCircular: boolean;
  }
): Annotation[] {
  const annotations: Annotation[] = [];
  const sourceAnnotations = [
    ...(input.sourceAnnotations ?? fullSourceAnnotationsForRegion(region)),
    ...(input.extraSourceAnnotations ?? []),
  ];

  for (const annotation of sourceAnnotations) {
    let rowPosition = 0;
    while (rowPosition < input.sourceByRowPosition.length) {
      const sourcePosition = input.sourceByRowPosition[rowPosition];
      const muted = input.mutedColumnSet.has(rowPosition);
      if (
        sourcePosition === null ||
        !sourcePositionOverlapsAnnotation(sourcePosition, annotation, {
          sourceLength: input.sourceLength,
          sourceCircular: input.sourceCircular,
        })
      ) {
        rowPosition++;
        continue;
      }

      const runStart = rowPosition;
      let runEnd = rowPosition + 1;
      while (runEnd < input.sourceByRowPosition.length) {
        const nextSourcePosition = input.sourceByRowPosition[runEnd];
        if (
          nextSourcePosition === null ||
          !sourcePositionOverlapsAnnotation(nextSourcePosition, annotation, {
            sourceLength: input.sourceLength,
            sourceCircular: input.sourceCircular,
          }) ||
          input.mutedColumnSet.has(runEnd) !== muted
        ) {
          break;
        }
        runEnd++;
      }

      annotations.push({
        name: annotation.name,
        type: annotation.type,
        start: runStart + 1,
        end: runEnd,
        direction: annotation.strand === 'forward' ? 1 : annotation.strand === 'reverse' ? -1 : 0,
        color: muted ? REVIEW_GRAY_ANNOTATION_COLOR : annotation.color,
        qualifiers: sequenceQualifiersFromDesign(
          qualifiersForSourceSpaceAnnotationSlice({
            annotation,
            clippedStart: sourcePosition,
            clippedEnd: input.sourceByRowPosition[runEnd - 1]! + 1,
          })
        ),
      });
      rowPosition = runEnd;
    }
  }

  return annotations;
}

function sourcePositionOverlapsAnnotation(
  sourcePosition: number,
  annotation: DesignAnnotation,
  options: { sourceLength: number; sourceCircular: boolean }
): boolean {
  if (sourcePosition >= annotation.start && sourcePosition < annotation.end) return true;
  if (!options.sourceCircular || options.sourceLength <= 0) return false;

  const normalized = normalizePosition(sourcePosition, options.sourceLength);
  if (annotation.start >= 0 && annotation.end <= options.sourceLength) {
    return normalized >= annotation.start && normalized < annotation.end;
  }

  const normalizedStart = normalizePosition(annotation.start, options.sourceLength);
  const normalizedEnd = normalizePosition(annotation.end, options.sourceLength);
  if (normalizedStart === normalizedEnd && annotation.end > annotation.start) return true;
  if (normalizedEnd > normalizedStart) {
    return normalized >= normalizedStart && normalized < normalizedEnd;
  }
  return normalized >= normalizedStart || normalized < normalizedEnd;
}

function fullSourceAnnotationsForRegion(region: DesignRegion): DesignAnnotation[] {
  const sourceAnnotations =
    region.sourceAnnotations?.map((annotation) => ({ ...annotation })) ??
    region.annotations.map((annotation) => ({
      ...annotation,
      start: region.sourceStart + annotation.start,
      end: region.sourceStart + annotation.end,
    }));

  return [...sourceAnnotations, ...restrictionDigestAnnotations(region)];
}

function restrictionDigestScarAnnotations(
  region: DesignRegion,
  assemblyMethod: SequenceDesign['assemblyMethod'],
  coordinateSpace: 'product' | 'source'
): DesignAnnotation[] {
  const enzyme = region.rdSourceEnzymeName ?? region.rdSourceEnzyme ?? 'RD';
  return getVisibleRestrictionDigestScarSegments(region, assemblyMethod).map((scar) => ({
    name: `${enzyme} ${scar.end} RD scar`,
    type: 'restriction_scar',
    start: coordinateSpace === 'product' ? scar.effectiveStart : scar.sourceStart,
    end: coordinateSpace === 'product' ? scar.effectiveEnd : scar.sourceEnd,
    strand: 'none',
    color: RD_SCAR_ANNOTATION_COLOR,
    qualifiers: {
      source: 'restriction-digest',
      rd_end: scar.end,
      retained_sequence: scar.retainedSequence,
      visible_sequence: scar.sequence,
      trimmed_bases: String(scar.trimmedBases),
    },
  }));
}

function restrictionDigestAnnotations(region: DesignRegion): DesignAnnotation[] {
  const annotations: DesignAnnotation[] = [];
  const enzyme = region.rdSourceEnzymeName ?? region.rdSourceEnzyme;
  if (!enzyme || !region.rdEnds) return annotations;

  for (const [endName, rdEnd] of Object.entries(region.rdEnds) as Array<
    ['upstream' | 'downstream', NonNullable<DesignRegion['rdEnds']>['upstream']]
  >) {
    if (!rdEnd) continue;
    if (
      rdEnd.recognitionStart !== undefined &&
      rdEnd.recognitionEnd !== undefined &&
      rdEnd.recognitionEnd > rdEnd.recognitionStart
    ) {
      annotations.push({
        name: `${enzyme} ${endName} recognition site`,
        type: 'restriction_site',
        start: rdEnd.recognitionStart,
        end: rdEnd.recognitionEnd,
        strand:
          rdEnd.strand === 'forward' ? 'forward' : rdEnd.strand === 'reverse' ? 'reverse' : 'none',
        color: '#f59e0b',
      });
    }
    for (const cutPosition of [rdEnd.cutPositionTop, rdEnd.cutPositionBottom]) {
      if (cutPosition === undefined) continue;
      annotations.push({
        name: `${enzyme} ${endName} cut`,
        type: 'restriction_cut',
        start: cutPosition,
        end: cutPosition + 1,
        strand: 'none',
        color: '#ef4444',
      });
    }
  }

  return annotations;
}

function designPrimersToDisplay(design: SequenceDesign): WorkbenchPrimerDisplay[] {
  const designPrimers = design.designPrimers ?? [];
  const isGoldenGate = design.assemblyMethod === 'goldengate';
  const ggJunctions = design.goldenGateJunctions ?? [];
  if (designPrimers.length === 0 && (!isGoldenGate || ggJunctions.length === 0)) return [];

  const displayRegions = getEffectiveDesignRegions(design);
  const composedSequence = getComposedSequence(displayRegions, design.spacers);
  const composedLength = composedSequence.length;
  const isCircular = design.topology === 'circular';
  const numFragments = design.regions.length;
  const result: WorkbenchPrimerDisplay[] = [];

  for (const pair of designPrimers) {
    pushPrimerPairDisplay(result, pair, {
      design,
      composedLength,
      isCircular,
      numFragments,
      isGoldenGate,
      ggJunctions,
    });
  }

  if (isGoldenGate && ggJunctions.length > 0) {
    const junctionsWithPrimers = new Set<number>();
    for (const pair of designPrimers) {
      if (pair.forward.sequence !== '' && pair.forward.junctionIndex !== null) {
        junctionsWithPrimers.add(pair.forward.junctionIndex);
      }
    }

    for (const junction of ggJunctions) {
      if (junctionsWithPrimers.has(junction.junctionIndex)) continue;
      result.push({
        id: `scar-marker-${junction.junctionIndex}`,
        name: `Scar ${junction.junctionIndex + 1}`,
        start: junction.overhangStart,
        end: junction.overhangEnd,
        direction: 'forward',
        bases: junction.overhang,
        tm: 0,
        gc: 0,
        mismatches: [],
        overhangLength: 4,
        pbsColor: 'transparent',
        overhangColor: 'transparent',
        cutPositionInOverhang: 1,
        enzymeName: design.goldenGateConfig?.enzyme,
        scarAbsolutePosition: junction.overhangStart,
        junctionIndex: junction.junctionIndex,
        isScarMarkerOnly: true,
      });
    }
  }

  return result;
}

function pushPrimerPairDisplay(
  result: WorkbenchPrimerDisplay[],
  pair: DesignPrimerPair,
  input: {
    design: SequenceDesign;
    composedLength: number;
    isCircular: boolean;
    numFragments: number;
    isGoldenGate: boolean;
    ggJunctions: GoldenGateJunction[];
  }
): void {
  const { design, composedLength, isCircular, numFragments, isGoldenGate, ggJunctions } = input;
  const fwdOverhangLen = isGoldenGate
    ? (pair.forward.goldenGateOverhang?.fullSequence.length ?? 0)
    : (pair.forward.overhang.tailLength ?? pair.forward.overhang.sequence.length);
  const revOverhangLen = isGoldenGate
    ? (pair.reverse.goldenGateOverhang?.fullSequence.length ?? 0)
    : (pair.reverse.overhang.tailLength ?? pair.reverse.overhang.sequence.length);
  const fwdGgOh = pair.forward.goldenGateOverhang;
  const revGgOh = pair.reverse.goldenGateOverhang;
  const fwdCutPos =
    isGoldenGate && fwdGgOh
      ? fwdGgOh.padding5prime.length + fwdGgOh.enzymeSite.length + fwdGgOh.spacer.length
      : undefined;
  const revCutPos =
    isGoldenGate && revGgOh
      ? revGgOh.padding5prime.length + revGgOh.enzymeSite.length + revGgOh.spacer.length
      : undefined;
  const fwdRecogStart = isGoldenGate && fwdGgOh ? fwdGgOh.padding5prime.length : undefined;
  const fwdRecogEnd =
    isGoldenGate && fwdGgOh ? fwdGgOh.padding5prime.length + fwdGgOh.enzymeSite.length : undefined;
  const revRecogStart = isGoldenGate && revGgOh ? revGgOh.padding5prime.length : undefined;
  const revRecogEnd =
    isGoldenGate && revGgOh ? revGgOh.padding5prime.length + revGgOh.enzymeSite.length : undefined;
  const fwdJunctionData = isGoldenGate
    ? ggJunctions.find((junction) => junction.junctionIndex === pair.forward.junctionIndex)
    : undefined;
  const revJunctionData = isGoldenGate
    ? ggJunctions.find((junction) => junction.junctionIndex === pair.reverse.junctionIndex)
    : undefined;

  const fwdFragmentIdx = pair.forward.fragmentIndex;
  const fwdJunctionIdx = pair.forward.junctionIndex ?? 0;
  const fwdLeftFrag = fwdJunctionIdx;
  const fwdRightFrag = (fwdJunctionIdx + 1) % numFragments;
  const fwdHomologousFrag = fwdFragmentIdx === fwdLeftFrag ? fwdRightFrag : fwdLeftFrag;
  const rawFwdStart = pair.forward.pbs.start - fwdOverhangLen;
  const fwdStart =
    isCircular && rawFwdStart < 0 ? composedLength + rawFwdStart : Math.max(0, rawFwdStart);

  if (pair.forward.sequence !== '') {
    result.push({
      id: pair.forward.id,
      name: pair.forward.name,
      start: fwdStart,
      end: pair.forward.pbs.end,
      direction: 'forward',
      bases: pair.forward.sequence,
      tm: pair.forward.tm ?? 0,
      gc: calculateGcContent(pair.forward.pbs.sequence),
      mismatches: [],
      overhangLength: fwdOverhangLen,
      pbsColor: fragmentColorHex(design, fwdFragmentIdx),
      overhangColor: fragmentColorHex(design, fwdHomologousFrag),
      cutPositionInOverhang: fwdCutPos,
      enzymeName: isGoldenGate ? design.goldenGateConfig?.enzyme : undefined,
      recognitionStart: fwdRecogStart,
      recognitionEnd: fwdRecogEnd,
      scarAbsolutePosition: fwdJunctionData?.overhangStart,
      cognate4bpLength: pair.forward.cognate4bpLength,
      synthetic4bpSpacerLength: pair.forward.synthetic4bpSpacerLength,
      spacerLength: isGoldenGate
        ? pair.forward.goldenGateOverhang?.literalSpacerLength
        : pair.forward.overhang.spacerSequence?.length,
      junctionIndex: pair.forward.junctionIndex ?? undefined,
      fragmentIndex: fwdFragmentIdx,
    });
  }

  const revFragmentIdx = pair.reverse.fragmentIndex;
  const revJunctionIdx = pair.reverse.junctionIndex ?? 0;
  const revLeftFrag = revJunctionIdx;
  const revRightFrag = (revJunctionIdx + 1) % numFragments;
  const revHomologousFrag = revFragmentIdx === revLeftFrag ? revRightFrag : revLeftFrag;
  const rawRevEnd = pair.reverse.pbs.end + revOverhangLen;
  const revEnd =
    isCircular && rawRevEnd > composedLength
      ? rawRevEnd - composedLength
      : Math.min(composedLength, rawRevEnd);

  if (pair.reverse.sequence !== '') {
    result.push({
      id: pair.reverse.id,
      name: pair.reverse.name,
      start: pair.reverse.pbs.start,
      end: revEnd,
      direction: 'reverse',
      bases: pair.reverse.sequence,
      tm: pair.reverse.tm ?? 0,
      gc: calculateGcContent(pair.reverse.pbs.sequence),
      mismatches: [],
      overhangLength: revOverhangLen,
      pbsColor: fragmentColorHex(design, revFragmentIdx),
      overhangColor: fragmentColorHex(design, revHomologousFrag),
      cutPositionInOverhang: revCutPos,
      enzymeName: isGoldenGate ? design.goldenGateConfig?.enzyme : undefined,
      recognitionStart: revRecogStart,
      recognitionEnd: revRecogEnd,
      scarAbsolutePosition: revJunctionData?.overhangStart,
      cognate4bpLength: pair.reverse.cognate4bpLength,
      synthetic4bpSpacerLength: pair.reverse.synthetic4bpSpacerLength,
      spacerLength: isGoldenGate
        ? pair.reverse.goldenGateOverhang?.literalSpacerLength
        : pair.reverse.overhang.spacerSequence?.length,
      junctionIndex: pair.reverse.junctionIndex ?? undefined,
      fragmentIndex: revFragmentIdx,
    });
  }
}

function projectPrimersToRow(
  primers: readonly WorkbenchPrimerDisplay[],
  input: {
    rowId: string;
    junctionIndex?: number;
    registeredStartBioCol: number;
    registeredEndBioCol: number;
    junctionPosition: number;
    productLength: number;
    fragmentIndex?: number;

    bindingOnly?: boolean;

    suppressTypeIISCutSiteRendering?: boolean;
  }
): PrimerDisplay[] {
  if (input.productLength <= 0) return [];
  const projected: PrimerDisplay[] = [];
  for (const sourcePrimer of primers) {
    if (input.junctionIndex !== undefined && sourcePrimer.junctionIndex !== input.junctionIndex) {
      continue;
    }
    if (input.fragmentIndex !== undefined && sourcePrimer.fragmentIndex !== input.fragmentIndex) {
      continue;
    }

    const primer = input.bindingOnly
      ? clipPrimerToBindingRegion(sourcePrimer, input.productLength)
      : sourcePrimer;
    if (primer === null) continue;
    const rowPrimer = input.suppressTypeIISCutSiteRendering
      ? suppressTypeIISCutSiteRendering(primer)
      : primer;
    const scarAbsolutePosition = input.bindingOnly
      ? undefined
      : projectedScarPosition(sourcePrimer, input);

    const matchingPositions: number[] = [];
    for (let bioCol = input.registeredStartBioCol; bioCol < input.registeredEndBioCol; bioCol++) {
      const productPosition = normalizePosition(
        input.junctionPosition + bioCol,
        input.productLength
      );
      if (productPositionInRange(productPosition, rowPrimer, input.productLength)) {
        matchingPositions.push(bioCol - input.registeredStartBioCol);
      }
    }

    for (const run of contiguousRuns(matchingPositions)) {
      projected.push({
        ...rowPrimer,
        sourcePrimerId: sourcePrimer.id,
        id: `${input.rowId}-${sourcePrimer.id}-${run.start}`,
        start: run.start,
        end: run.end,
        scarAbsolutePosition,
      });
    }
  }
  return projected;
}

function suppressTypeIISCutSiteRendering(primer: WorkbenchPrimerDisplay): WorkbenchPrimerDisplay {
  return {
    ...primer,
    suppressCutSiteRendering: true,
  };
}

function projectedScarPosition(
  primer: Pick<PrimerDisplay, 'scarAbsolutePosition'>,
  input: {
    registeredStartBioCol: number;
    registeredEndBioCol: number;
    junctionPosition: number;
    productLength: number;
  }
): number | undefined {
  if (primer.scarAbsolutePosition === undefined) return undefined;
  const normalizedScar = normalizePosition(primer.scarAbsolutePosition, input.productLength);
  for (let bioCol = input.registeredStartBioCol; bioCol < input.registeredEndBioCol; bioCol++) {
    const productPosition = normalizePosition(input.junctionPosition + bioCol, input.productLength);
    if (productPosition === normalizedScar) return bioCol - input.registeredStartBioCol;
  }
  return undefined;
}

function clipPrimerToBindingRegion(
  primer: WorkbenchPrimerDisplay,
  productLength: number
): WorkbenchPrimerDisplay | null {
  const overhang = Math.max(0, primer.overhangLength ?? 0);
  if (overhang <= 0) return stripSourceOnlyPrimerMetadata(primer);
  const fullLen = primer.bases.length;
  const bindingLen = fullLen - overhang;
  if (bindingLen <= 0) return null;

  if (primer.direction === 'forward') {
    return {
      ...primer,
      start: normalizePosition(primer.start + overhang, productLength),

      bases: primer.bases.slice(overhang),
      overhangLength: 0,
      spacerLength: undefined,
      ...sourceBindingOnlyPrimerMetadata(),
    };
  }

  return {
    ...primer,

    end: normalizePosition(primer.end - overhang, productLength),
    bases: primer.bases.slice(0, bindingLen),
    overhangLength: 0,
    spacerLength: undefined,
    ...sourceBindingOnlyPrimerMetadata(),
  };
}

function stripSourceOnlyPrimerMetadata(primer: WorkbenchPrimerDisplay): WorkbenchPrimerDisplay {
  return {
    ...primer,
    ...sourceBindingOnlyPrimerMetadata(),
  };
}

function sourceBindingOnlyPrimerMetadata(): Partial<WorkbenchPrimerDisplay> {
  return {
    spacerLength: undefined,
    cutPositionInOverhang: undefined,
    enzymeName: undefined,
    recognitionStart: undefined,
    recognitionEnd: undefined,
    scarAbsolutePosition: undefined,
    cognate4bpLength: undefined,
    synthetic4bpSpacerLength: undefined,
  };
}

function productPositionInRange(
  position: number,
  primer: Pick<PrimerDisplay, 'start' | 'end'>,
  productLength: number
): boolean {
  const start = normalizePosition(primer.start, productLength);
  const end = normalizePosition(primer.end, productLength);
  if (start === end) return false;
  return start < end ? position >= start && position < end : position >= start || position < end;
}

function contiguousRuns(positions: number[]): Array<{ start: number; end: number }> {
  if (positions.length === 0) return [];
  const sorted = [...positions].sort((a, b) => a - b);
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = sorted[0];
  let previous = sorted[0];
  for (const position of sorted.slice(1)) {
    if (position === previous + 1) {
      previous = position;
      continue;
    }
    runs.push({ start: runStart, end: previous + 1 });
    runStart = position;
    previous = position;
  }
  runs.push({ start: runStart, end: previous + 1 });
  return runs;
}

function pushSlicedAnnotation(
  target: Annotation[],
  annotation: DesignAnnotation,
  absStart: number,
  absEnd: number,
  sliceStartRaw: number,
  sliceLength: number,
  sequenceLength: number
): void {
  for (let local = 0; local < sliceLength; local++) {
    const pos = normalizePosition(sliceStartRaw + local, sequenceLength);
    if (pos < absStart || pos >= absEnd) continue;
    const runStart = local;
    let runEnd = local + 1;
    while (runEnd < sliceLength) {
      const nextPos = normalizePosition(sliceStartRaw + runEnd, sequenceLength);
      if (nextPos < absStart || nextPos >= absEnd) break;
      runEnd++;
    }
    target.push({
      name: annotation.name,
      type: annotation.type,
      start: runStart + 1,
      end: runEnd,
      direction: annotation.strand === 'forward' ? 1 : annotation.strand === 'reverse' ? -1 : 0,
      color: annotation.color,
      qualifiers: sequenceQualifiersFromDesign(
        qualifiersForSourceSpaceAnnotationSlice({
          annotation: {
            ...annotation,
            start: absStart,
            end: absEnd,
          },
          clippedStart: pos,
          clippedEnd: normalizePosition(sliceStartRaw + runEnd - 1, sequenceLength) + 1,
        })
      ),
    });
    local = runEnd - 1;
  }
}

function pushSlicedSourceAnnotation(
  target: Annotation[],
  annotation: DesignAnnotation,
  regionProductStart: number,
  regionSourceStart: number,
  clippedSourceStart: number,
  clippedSourceEnd: number,
  sliceStartRaw: number,
  sliceLength: number,
  sequenceLength: number
): void {
  const absStart = regionProductStart + (clippedSourceStart - regionSourceStart);
  const absEnd = regionProductStart + (clippedSourceEnd - regionSourceStart);
  for (let local = 0; local < sliceLength; local++) {
    const pos = normalizePosition(sliceStartRaw + local, sequenceLength);
    if (pos < absStart || pos >= absEnd) continue;
    const runStart = local;
    let runEnd = local + 1;
    while (runEnd < sliceLength) {
      const nextPos = normalizePosition(sliceStartRaw + runEnd, sequenceLength);
      if (nextPos < absStart || nextPos >= absEnd) break;
      runEnd++;
    }
    const runProductStart = pos;
    const runProductEnd = normalizePosition(sliceStartRaw + runEnd - 1, sequenceLength) + 1;
    const runSourceStart = regionSourceStart + (runProductStart - regionProductStart);
    const runSourceEnd = regionSourceStart + (runProductEnd - regionProductStart);
    target.push({
      name: annotation.name,
      type: annotation.type,
      start: runStart + 1,
      end: runEnd,
      direction: annotation.strand === 'forward' ? 1 : annotation.strand === 'reverse' ? -1 : 0,
      color: annotation.color,
      qualifiers: sequenceQualifiersFromDesign(
        qualifiersForSourceSpaceAnnotationSlice({
          annotation,
          clippedStart: runSourceStart,
          clippedEnd: runSourceEnd,
        })
      ),
    });
    local = runEnd - 1;
  }
}

function isSpacerPosition(
  productPosition: number,
  regionPositions: RegionPosition[],
  design: SequenceDesign
): boolean {
  for (const spacer of design.spacers) {
    const region = regionPositions[spacer.junctionIndex];
    if (!region) continue;
    const start = region.end;
    const end = start + spacer.sequence.length;
    if (productPosition >= start && productPosition < end) return true;
  }
  return false;
}

function circularSlice(sequence: string, startRaw: number, length: number): string {
  if (sequence.length === 0 || length <= 0) return '';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += sequence[normalizePosition(startRaw + i, sequence.length)];
  }
  return out;
}

function normalizePosition(position: number, length: number): number {
  if (length <= 0) return 0;
  return ((position % length) + length) % length;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
