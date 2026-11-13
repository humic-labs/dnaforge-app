import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  acceptDesignArtifact,
  confirmDesignRecoveryBackup,
  useDesignRecoveryStore,
} from './design-recovery';
import { withRevision } from '../../shared/store-revision';
import {
  loadedDesignDraft,
  resolveExistingDesignDraft,
  type DesignDraftIdentity,
  type ResolvedExistingDesignDraft,
} from './design-draft-resolution';
import type {
  SequenceDesign,
  DesignRegion,
  DesignSpacer,
  DesignStatus,
  HomologyRegion,
  AssemblyMethod,
  GoldenGateEnzyme,
  AssemblyWorkbenchDesignState,
  HomologyTemplateBasis,
} from './types';
import { getComposedSequence } from './types';
import {
  emptyDesignRegion,
  normalizeAssemblySlots,
  normalizeRegionInput,
  schemaBackboneSequenceId,
  withAssemblySlotStructure,
} from './assembly-slots';
import { refinePrimersForPolymerase } from './algorithms/design-tm-refinement';
import { backfillSpacerAnchors, reanchorSpacersToCurrentGaps } from './spacer-invariants';
import {
  adjustSpacersForReorder,
  detectSingleRegionMove,
  isGoldenGateFixedRegionOrderCompatible,
} from './assembly-rail-reorder';
import {
  clampNebuilderResection,
  getEffectiveDesignRegions,
  isHomologyAssemblyMethod,
} from './restriction-digest';
import {
  assemblyStateToLegacyStatus,
  createAssemblyDispatcher,
  legacyStatusToAssemblyState,
  normalizeAssemblyDesign,
} from '../assembly/public/dispatcher';
import {
  acceptedAssemblyVersionActivatesDesign,
  appendAcceptedAssemblyVersionToDesign,
} from '../assembly/public/accepted-finalization';
import { sequenceDesignFromAcceptedAssemblyVersion } from '../assembly/public/accepted-reopen';
import type { AcceptedAssemblyVersion } from '../assembly/public/accepted-types';
import type { RichSequenceFragment } from '../sequence-clipboard/public/rich-sequence-clipboard';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../junction-workbench/public/AssemblyWorkbenchReducer';
import { reconcileAssemblyWorkbenchState } from '../junction-workbench/public/AssemblyWorkbenchIdentity';
import {
  recomputePrimers,
  updatePrimerPbsLength,
  calculateNewEncodingForOverhang,
  recomputeHomologyMetadata,
  updatePrimerOverhangFromHomology,
  computeOverhangSequence,
  computePbsSequence,
  forwardSpacerIsSeparateCargo,
  computeGoldenGatePrimers,
  isGoldenGateJunctionOffsetLocked,
  reverseComplement,
  spacerContributesToAnnealing,
  isPalindrome,
  identifyJunctions,
  getHomologyTemplateBasis,
} from './algorithms/draft-assembly';
import { switchAssemblyMethodPreservingDraft } from './assembly-method-drafts';

import { createAppTmCalculator, useSettingsStore } from '../junction-workbench/public/settings';
import { deriveAssemblyIssues } from '../assembly/public/issues/assembly-issues';
import {
  collectInternalCutSiteMarkers,
  markerHighlightRange,
  markerScrollPosition,
  stepCutSiteIndex,
} from './internal-cut-sites';
import {
  designWithSelectedPendingSpacer,
  findProductLayoutBoundary,
  productLayoutSegmentId,
  selectProductLayout,
  type ProductLayoutPartSegment,
  type ProductLayoutSegment,
} from './assembly-boundaries';
import { reverseComplementDesignRegion } from './region-orientation';
import { sameSavedPrimerLinks, type SavedPrimerLink } from './saved-primer-links';
import {
  isGoldenGateSchemaStructureLocked,
  type GoldenGateAssemblySchema,
} from './golden-gate-schema';
import {
  applyGoldenGateSchemaCommand,
  type GoldenGateSchemaCommandResult,
  type GoldenGateSchemaChangeOptions,
} from './golden-gate-schema-command';
import type { MocloFactoryStageSelection } from './moclo-kit-definition';
import {
  applyMocloFactoryStageCommand,
  type MocloFactoryStageCommandResult,
} from './moclo-factory-command';

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 9);
}

function nextAssemblyVersion(design: SequenceDesign): number {
  return (design.version ?? 0) + 1;
}

function normalizeRegionColorIndices(regions: readonly DesignRegion[]): DesignRegion[] {
  const used = new Set<number>();
  let nextOpenSlot = 0;

  return regions.map((region) => {
    const existingSlot = region.colorIndex;
    if (
      typeof existingSlot === 'number' &&
      Number.isInteger(existingSlot) &&
      existingSlot >= 0 &&
      !used.has(existingSlot)
    ) {
      used.add(existingSlot);
      return region;
    }

    while (used.has(nextOpenSlot)) nextOpenSlot += 1;
    used.add(nextOpenSlot);
    return region.colorIndex === nextOpenSlot ? region : { ...region, colorIndex: nextOpenSlot };
  });
}

function nextRegionColorIndex(regions: readonly DesignRegion[]): number {
  const used = new Set(
    regions
      .map((region) => region.colorIndex)
      .filter(
        (slot): slot is number => typeof slot === 'number' && Number.isInteger(slot) && slot >= 0
      )
  );
  let nextOpenSlot = 0;
  while (used.has(nextOpenSlot)) nextOpenSlot += 1;
  return nextOpenSlot;
}

function clampRegionInsertIndex(index: number, regionCount: number): number {
  if (!Number.isFinite(index)) return regionCount;
  return Math.max(0, Math.min(regionCount, Math.trunc(index)));
}

function adjustSpacersForRegionInsert(
  spacers: readonly DesignSpacer[],
  insertIndex: number,
  moveSpacerAfterInsertedPartJunctionIndex: number | null
): DesignSpacer[] {
  return (spacers ?? []).map((spacer) => {
    if (spacer.junctionIndex === moveSpacerAfterInsertedPartJunctionIndex) {
      return { ...spacer, junctionIndex: spacer.junctionIndex + 1 };
    }
    if (spacer.junctionIndex >= insertIndex) {
      return { ...spacer, junctionIndex: spacer.junctionIndex + 1 };
    }
    return spacer;
  });
}

function adjacentProductSegment(
  segments: readonly ProductLayoutSegment[],
  index: number,
  direction: -1 | 1,
  topology: SequenceDesign['topology']
): ProductLayoutSegment | null {
  const adjacentIndex = index + direction;
  if (adjacentIndex >= 0 && adjacentIndex < segments.length) return segments[adjacentIndex];
  if (topology !== 'circular' || segments.length === 0) return null;
  return direction < 0 ? segments[segments.length - 1] : segments[0];
}

function productLayoutOrderToDesign(
  design: SequenceDesign,
  orderedSegmentIds: readonly string[]
): Pick<SequenceDesign, 'regions' | 'spacers'> | null {
  const currentSegments = selectProductLayout(design);
  if (currentSegments.length !== orderedSegmentIds.length) return null;

  const segmentById = new Map(
    currentSegments.map((segment) => [productLayoutSegmentId(segment), segment])
  );
  const orderedSegments: ProductLayoutSegment[] = [];
  for (const id of orderedSegmentIds) {
    const segment = segmentById.get(id);
    if (!segment) return null;
    orderedSegments.push(segment);
  }
  if (new Set(orderedSegmentIds).size !== currentSegments.length) return null;

  const nextRegions = orderedSegments
    .filter((segment): segment is ProductLayoutPartSegment => segment.kind === 'part')
    .map((segment) => segment.region);
  if (nextRegions.length !== design.regions.length) return null;

  const regionIndexBySegment = new Map<ProductLayoutPartSegment, number>();
  let nextRegionIndex = 0;
  for (const segment of orderedSegments) {
    if (segment.kind !== 'part') continue;
    regionIndexBySegment.set(segment, nextRegionIndex);
    nextRegionIndex += 1;
  }
  const usedSpacerJunctions = new Set<number>();
  const nextSpacers: DesignSpacer[] = [];

  for (let index = 0; index < orderedSegments.length; index++) {
    const segment = orderedSegments[index];
    if (segment.kind !== 'spacer') continue;

    const previous = adjacentProductSegment(orderedSegments, index, -1, design.topology);
    const next = adjacentProductSegment(orderedSegments, index, 1, design.topology);
    if (previous?.kind !== 'part' || next?.kind !== 'part') return null;

    const junctionIndex = regionIndexBySegment.get(previous);
    if (junctionIndex === undefined || usedSpacerJunctions.has(junctionIndex)) return null;
    usedSpacerJunctions.add(junctionIndex);
    nextSpacers.push({ ...segment.spacer, junctionIndex });
  }

  return { regions: nextRegions, spacers: nextSpacers };
}

function withDraftingAssemblyState(
  design: SequenceDesign
): Pick<
  SequenceDesign,
  'assemblyState' | 'status' | 'validationErrors' | 'version' | 'assemblyWorkbench'
> {
  return {
    assemblyState: 'drafting',
    status: 'draft',
    validationErrors: [],
    version: nextAssemblyVersion(design),
    assemblyWorkbench: clearAssemblyWorkbenchDraftState(design),
  };
}

function clearAssemblyWorkbenchDraftState(
  design: SequenceDesign
): AssemblyWorkbenchDesignState | undefined {
  if (!design.assemblyWorkbench) return undefined;
  return {
    ...design.assemblyWorkbench,
    primerEditIntents: [],
  };
}

function isRestrictionDigestRegion(region: DesignRegion | undefined): boolean {
  return region?.sourceType === 'rd' || !!region?.rdOverhangs;
}

function normalizeProductPosition(position: number, sequenceLength: number): number {
  if (sequenceLength <= 0) return 0;
  return ((Math.round(position) % sequenceLength) + sequenceLength) % sequenceLength;
}

function productDistanceForward(start: number, end: number, sequenceLength: number): number {
  if (sequenceLength <= 0) return 0;
  return normalizeProductPosition(end - start, sequenceLength);
}

function homologyTemplateBasisForDesign(
  design: SequenceDesign,
  assemblyRegions: DesignRegion[],
  junctionIndex: number
): HomologyTemplateBasis | undefined {
  const junction = identifyJunctions(assemblyRegions, design.topology, design.spacers).find(
    (item) => item.index === junctionIndex
  );
  if (!junction) return undefined;
  return getHomologyTemplateBasis(
    junction,
    assemblyRegions[junction.leftRegionIndex],
    assemblyRegions[junction.rightRegionIndex]
  );
}

function homologyEncodingFromRange(
  start: number,
  end: number,
  basis: HomologyTemplateBasis,
  currentEncoding: HomologyRegion['encoding'],
  sequenceLength: number
): HomologyRegion['encoding'] {
  const leftAllowed = basis.leftHomologyAllowed !== false;
  const rightAllowed = basis.rightHomologyAllowed !== false;

  if (!leftAllowed || !rightAllowed) {
    return {
      onLeft: leftAllowed
        ? productDistanceForward(start, basis.leftHomologyEnd, sequenceLength)
        : 0,
      onRight: rightAllowed
        ? productDistanceForward(basis.rightHomologyStart, end, sequenceLength)
        : 0,
    };
  }

  const currentOnLeft = currentEncoding?.onLeft ?? 0;
  const currentOnRight = currentEncoding?.onRight ?? 0;
  const keepLeft = currentOnLeft > 0 || currentOnRight <= 0;
  const keepRight = currentOnRight > 0 || currentOnLeft <= 0;

  return {
    onLeft: keepLeft ? productDistanceForward(start, basis.leftHomologyEnd, sequenceLength) : 0,
    onRight: keepRight ? productDistanceForward(basis.rightHomologyStart, end, sequenceLength) : 0,
  };
}

function normalizeAssemblyDesignTopology(): 'circular' {
  return 'circular';
}

function normalizePersistedDesign(design: SequenceDesign): SequenceDesign {
  design = normalizeAssemblySlots(design);
  const assemblyState = design.assemblyState ?? legacyStatusToAssemblyState(design.status);
  return {
    ...design,
    regions: normalizeRegionColorIndices(design.regions ?? []),

    spacers: backfillSpacerAnchors(design.spacers, design.regions ?? []),
    topology: normalizeAssemblyDesignTopology(),
    version: design.version ?? 0,
    assemblyState,
    validationErrors: design.validationErrors ?? [],
    proposedPlans: [],
    status: design.status ?? assemblyStateToLegacyStatus(assemblyState),
    backboneSequenceId: design.backboneSequenceId ?? null,
    mocloFactory: design.mocloFactory
      ? {
          ...design.mocloFactory,
          stageInputs: design.mocloFactory.stageInputs ?? [],
        }
      : undefined,
  };
}

function reduceJunctionSpacerChange(
  design: SequenceDesign,
  junctionIndex: number,
  sequence: string,
  name?: string | null
): SequenceDesign | null {
  const normalizedDesign = normalizeAssemblyDesign(design);
  if (!normalizedDesign) return null;

  const result = applyAssemblyWorkbenchCommand({
    design: normalizedDesign,
    viewState: createAssemblyWorkbenchViewState(normalizedDesign),
    command: {
      type: 'setJunctionSpacer',
      junctionIndex,
      sequence,
      ...(name !== undefined ? { name } : {}),
      expectedDesignVersion: normalizedDesign.version,
    },
  });

  if (result.status === 'applied') return result.nextDesign;
  if (result.status === 'rejected' && process.env.NODE_ENV === 'development') {
    console.warn('[Design Store] setJunctionSpacer rejected', result.errors);
  }
  return null;
}

export function migratePersistedDesignState(persistedState: unknown): unknown {
  if (!persistedState || typeof persistedState !== 'object') {
    return persistedState;
  }

  const state = persistedState as Partial<DesignState> & {
    designs?: Record<string, SequenceDesign>;
  };
  const designs = state.designs
    ? Object.fromEntries(
        Object.entries(state.designs).map(([id, design]) => [id, normalizePersistedDesign(design)])
      )
    : {};

  return {
    ...state,
    designs,
    draftDesignIds: {},
    pendingDispatchId: null,
  };
}

export function partializeDesigns(
  designs: Record<string, SequenceDesign>,
  draftDesignIds: Readonly<Record<string, true>> = {}
): Record<string, SequenceDesign> {
  return Object.fromEntries(
    Object.entries(designs).flatMap(([id, design]) => {
      if (draftDesignIds[id]) return [];
      const { proposedPlans: _proposedPlans, ...persistedDesign } =
        normalizePersistedDesign(design);
      return [[id, persistedDesign as SequenceDesign]];
    })
  );
}

function createEmptyDesign(name: string, assemblyMethod: AssemblyMethod): SequenceDesign {
  const now = new Date();
  return {
    id: generateId(),
    constructId: generateId(),
    name,
    topology: normalizeAssemblyDesignTopology(),
    regions: [],
    spacers: [],
    version: 0,
    assemblyState: 'preflight',
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

export function hydrateDesign(design: SequenceDesign): SequenceDesign {
  const normalizedDesign: SequenceDesign = {
    ...normalizeAssemblySlots(design),
    topology: normalizeAssemblyDesignTopology(),
  };

  if (normalizedDesign.historicalComponentSources?.length) return normalizedDesign;

  if (!normalizedDesign.regions || normalizedDesign.regions.length < 2) {
    return normalizedDesign;
  }

  const migratedDesign = normalizedDesign;
  const tm = createAppTmCalculator(migratedDesign.pcrPolymerase);
  const assemblyRegions = getEffectiveDesignRegions(migratedDesign);
  const composedSequence = getComposedSequence(assemblyRegions, normalizedDesign.spacers);
  const seqLen = composedSequence.length;

  if (migratedDesign.assemblyMethod === 'goldengate') {
    return hydrateGoldenGateDesign(migratedDesign, composedSequence, seqLen);
  }

  if (!migratedDesign.homologyRegions || migratedDesign.homologyRegions.length === 0) {
    return migratedDesign;
  }

  const computedJunctions = identifyJunctions(
    assemblyRegions,
    migratedDesign.topology,
    migratedDesign.spacers
  );
  const computedJunctionByIndex = new Map(
    computedJunctions.map((junction) => [junction.index, junction])
  );
  const spacerLengthByJunction = new Map<number, number>();
  if (migratedDesign.spacers) {
    for (const spacer of migratedDesign.spacers) {
      spacerLengthByJunction.set(spacer.junctionIndex, spacer.sequence.length);
    }
  }

  const regionPositions: { start: number; end: number }[] = [];
  let pos = 0;
  for (let i = 0; i < assemblyRegions.length; i++) {
    const region = assemblyRegions[i];
    regionPositions.push({ start: pos, end: pos + region.sequence.length });
    pos += region.sequence.length;

    pos += spacerLengthByJunction.get(i) ?? 0;
  }

  const isCircular = migratedDesign.topology === 'circular';
  const numJunctions = isCircular ? assemblyRegions.length : assemblyRegions.length - 1;
  const computedJunctionPositions = new Map<number, number>();
  for (let i = 0; i < numJunctions; i++) {
    const spacerLen = spacerLengthByJunction.get(i) ?? 0;
    const junctionPos = regionPositions[i].end + spacerLen;
    computedJunctionPositions.set(i, junctionPos);
  }

  const homologyRegions = migratedDesign.homologyRegions.map((hr) => {
    const junctionPosition =
      computedJunctionPositions.get(hr.junctionIndex) ?? hr.junctionPosition ?? 0;
    const junction = computedJunctionByIndex.get(hr.junctionIndex);
    const templateBasis = junction
      ? getHomologyTemplateBasis(
          junction,
          assemblyRegions[junction.leftRegionIndex],
          assemblyRegions[junction.rightRegionIndex]
        )
      : hr.templateBasis;

    return recomputeHomologyMetadata(
      {
        ...hr,
        junctionPosition,
        ...(templateBasis ? { templateBasis } : {}),
      },
      composedSequence,
      hr.encoding
    );
  });

  const homologyMap = new Map<number, HomologyRegion>();
  for (const hr of homologyRegions) {
    homologyMap.set(hr.junctionIndex, hr);
  }

  const spacerSeqByJunction = new Map<number, string>();
  if (migratedDesign.spacers) {
    for (const spacer of migratedDesign.spacers) {
      spacerSeqByJunction.set(spacer.junctionIndex, spacer.sequence);
    }
  }

  const designPrimers = migratedDesign.designPrimers.flatMap((pair) => {
    if (isRestrictionDigestRegion(migratedDesign.regions[pair.fragmentIndex])) {
      return [];
    }

    const regionPos = regionPositions[pair.fragmentIndex];

    const hydrateOnePrimer = (primer: typeof pair.forward) => {
      if (
        primer.manuallyEdited ||
        migratedDesign.assemblyWorkbench?.primerEditIntents?.some(
          (intent) =>
            intent.field === 'tailLength' &&
            intent.regionId === migratedDesign.regions[pair.fragmentIndex]?.id &&
            intent.direction === primer.direction
        )
      )
        return primer;
      const hr = primer.junctionIndex !== null ? homologyMap.get(primer.junctionIndex) : null;
      const spacerSeq =
        primer.junctionIndex !== null ? (spacerSeqByJunction.get(primer.junctionIndex) ?? '') : '';

      let overhangSeq = '';
      let spacerSequence: string | undefined;
      let annealingLength = 0;

      if (hr && isHomologyAssemblyMethod(migratedDesign.assemblyMethod)) {
        const hrSeq = hr.metadata?.sequence ?? '';
        const onLeft = hr.encoding?.onLeft ?? 0;

        if (primer.direction === 'forward') {
          const homologySeq = hrSeq.slice(0, onLeft);
          if (forwardSpacerIsSeparateCargo(hr, spacerSeq)) {
            overhangSeq = homologySeq + spacerSeq;
            spacerSequence = spacerSeq || undefined;
            annealingLength = homologySeq.length;
          } else {
            overhangSeq = homologySeq;
            const spacerInOverhang = Math.min(spacerSeq.length, onLeft);
            if (spacerInOverhang > 0) {
              spacerSequence = spacerSeq.slice(-spacerInOverhang);
            }
            annealingLength = overhangSeq.length;
          }
        } else {
          const rightPortion = hrSeq.slice(onLeft);

          const overhangTemplate = spacerSeq + rightPortion;
          overhangSeq = reverseComplement(overhangTemplate);

          if (spacerSeq) {
            spacerSequence = reverseComplement(spacerSeq);
          }
          annealingLength =
            rightPortion.length + (spacerContributesToAnnealing(hr) ? spacerSeq.length : 0);
        }
      } else if (hr) {
        overhangSeq = computeOverhangSequence(primer.direction, hr);
        annealingLength = overhangSeq.length;
      }

      const storedPbsLength = primer.pbs.end - primer.pbs.start;
      let pbsStart: number;
      let pbsEnd: number;

      if (primer.direction === 'forward') {
        pbsStart = regionPos.start;
        pbsEnd = Math.min(regionPos.start + storedPbsLength, regionPos.end);
      } else {
        pbsEnd = regionPos.end;
        pbsStart = Math.max(regionPos.end - storedPbsLength, regionPos.start);
      }

      const pbsSeq = computePbsSequence(primer.direction, pbsStart, pbsEnd, composedSequence);

      return {
        ...primer,
        pbs: {
          start: pbsStart,
          end: pbsEnd,
          sequence: pbsSeq,
        },
        overhang: {
          length: annealingLength,
          sequence: overhangSeq,
          tailLength: overhangSeq.length,
          spacerSequence,
        },
        sequence: overhangSeq + pbsSeq,
        tm: tm.estimate(pbsSeq),
        tmProvenance: undefined,
      };
    };

    return [
      {
        ...pair,
        forward: hydrateOnePrimer(pair.forward),
        reverse: hydrateOnePrimer(pair.reverse),
      },
    ];
  });

  return {
    ...migratedDesign,
    homologyRegions,
    designPrimers,
  };
}

function hydrateGoldenGateDesign(
  design: SequenceDesign,
  composedSequence: string,
  seqLen: number
): SequenceDesign {
  if (!design.goldenGateConfig || !design.goldenGateJunctions) {
    return design;
  }

  const spacerLengthByJunction = new Map<number, number>();
  if (design.spacers) {
    for (const spacer of design.spacers) {
      spacerLengthByJunction.set(spacer.junctionIndex, spacer.sequence.length);
    }
  }

  const regionPositions: { start: number; end: number }[] = [];
  let pos = 0;
  for (let i = 0; i < design.regions.length; i++) {
    const region = design.regions[i];
    regionPositions.push({ start: pos, end: pos + region.sequence.length });
    pos += region.sequence.length;
    pos += spacerLengthByJunction.get(i) ?? 0;
  }

  const isCircular = design.topology === 'circular';
  const numJunctions = isCircular ? design.regions.length : design.regions.length - 1;
  const computedJunctionPositions = new Map<number, number>();
  for (let i = 0; i < numJunctions; i++) {
    const spacerLen = spacerLengthByJunction.get(i) ?? 0;
    const junctionPos = regionPositions[i].end + spacerLen;
    computedJunctionPositions.set(i, junctionPos);
  }

  const goldenGateJunctions = design.goldenGateJunctions.map((jxn) => {
    const junctionPosition =
      computedJunctionPositions.get(jxn.junctionIndex) ?? jxn.junctionPosition;

    const storedOffset = typeof jxn.offset === 'number' ? jxn.offset : 0;
    const offset = jxn.source?.type === 'rd-fixed' ? 2 : storedOffset;

    const overhangStart = junctionPosition - 2 + offset;
    const overhangEnd = overhangStart + 4;

    let overhang = '';
    for (let i = 0; i < 4; i++) {
      const idx = (((overhangStart + i) % seqLen) + seqLen) % seqLen;
      overhang += composedSequence[idx];
    }

    return {
      ...jxn,
      junctionPosition,
      offset,
      overhangStart,
      overhangEnd,
      overhang,
    };
  });

  const designPrimers = computeGoldenGatePrimers(
    design.regions,
    goldenGateJunctions,
    design.topology,
    design.goldenGateConfig.enzyme,
    design.spacers,
    design.primerDesignConstraints?.targetPcrTm ?? useSettingsStore.getState().defaultPcrTm,
    createAppTmCalculator(design.pcrPolymerase)
  );

  return {
    ...design,
    goldenGateJunctions,
    designPrimers,
  };
}

export type CopiedRegion = RichSequenceFragment;

interface DesignState {
  designs: Record<string, SequenceDesign>;

  draftDesignIds: Record<string, true>;

  activeDesignId: string | null;

  pendingDispatchId: string | null;

  revision: number;
}

export type GoldenGateSchemaStoreResult =
  | GoldenGateSchemaCommandResult
  | {
      status: 'rejected';
      code: 'design-not-found';
      message: string;
    };

export type MocloFactoryStageStoreResult =
  | MocloFactoryStageCommandResult
  | {
      status: 'rejected';
      code: 'design-not-found';
      message: string;
    };

interface DesignActions {
  createDesign: (name: string, topology?: 'circular', assemblyMethod?: AssemblyMethod) => string;

  createDraftDesign: (name: string, assemblyMethod?: AssemblyMethod) => string;

  commitDraftDesign: (designId: string) => void;

  setAssemblyMethod: (designId: string, method: AssemblyMethod, enzyme?: GoldenGateEnzyme) => void;

  deleteDesign: (designId: string) => void;

  setActiveDesign: (designId: string | null) => void;

  updateDesign: (
    designId: string,
    updates: Partial<
      Pick<SequenceDesign, 'name' | 'defaultHomologyLength' | 'primerDesignConstraints'>
    > & {
      topology?: 'circular';
    }
  ) => void;

  commitWorkbenchDesign: (
    designId: string,
    nextDesign: SequenceDesign,
    expectedVersion: number
  ) => boolean;

  setGoldenGateSchema: (
    designId: string,
    schema: GoldenGateAssemblySchema | undefined,
    expectedVersion: number,
    options?: GoldenGateSchemaChangeOptions
  ) => GoldenGateSchemaStoreResult;

  clearGoldenGateSchema: (
    designId: string,
    expectedVersion: number,
    options?: GoldenGateSchemaChangeOptions
  ) => GoldenGateSchemaStoreResult;

  setMocloFactoryStage: (
    designId: string,
    selection: MocloFactoryStageSelection,
    runId: string,
    expectedVersion: number
  ) => MocloFactoryStageStoreResult;

  commitAcceptedAssemblyVersion: (
    designId: string,
    acceptedVersion: AcceptedAssemblyVersion,
    expectedVersion: number
  ) => boolean;

  replaceAcceptedAssemblyVersion: (
    designId: string,
    acceptedVersion: AcceptedAssemblyVersion
  ) => boolean;

  reopenAcceptedAssemblyVersion: (
    acceptedVersion: AcceptedAssemblyVersion,
    options?: { designId?: string; now?: Date; name?: string }
  ) => string;

  upsertDesignFromArtifact: (design: SequenceDesign) => void;

  resolveExistingDraft: (input: {
    designId: string;
    artifactDesign: SequenceDesign | null;
    identity?: DesignDraftIdentity;
  }) => ResolvedExistingDesignDraft;

  loadedDraft: (designId: string, identity?: DesignDraftIdentity) => SequenceDesign | null;

  bindDesignConstructId: (designId: string, constructId: string) => void;

  setSavedPrimerLinks: (designId: string, links: SavedPrimerLink[]) => boolean;

  addRegion: (designId: string, region: Omit<DesignRegion, 'id'>) => void;

  insertRegionAt: (designId: string, index: number, region: Omit<DesignRegion, 'id'>) => void;

  insertRegionAtProductBoundary: (
    designId: string,
    boundaryId: string,
    region: Omit<DesignRegion, 'id'>
  ) => void;

  removeRegion: (designId: string, regionId: string) => void;

  clearRegion: (designId: string, regionId: string) => void;

  updateRegion: (
    designId: string,
    regionId: string,
    updates: Partial<Omit<DesignRegion, 'id'>>
  ) => void;

  reverseComplementRegion: (
    designId: string,
    regionId: string,
    sourceContext?: {
      sourceSequence: string;
      sourceAnnotations?: DesignRegion['sourceAnnotations'];
    }
  ) => boolean;

  reorderRegions: (designId: string, regionIds: string[]) => void;

  reorderProductLayoutSegments: (designId: string, orderedSegmentIds: string[]) => boolean;

  setJunctionSpacer: (
    designId: string,
    junctionIndex: number,
    sequence: string,
    name?: string | null
  ) => boolean;

  addSpacer: (designId: string, junctionIndex: number, sequence: string, name?: string) => void;

  updateSpacer: (
    designId: string,
    spacerId: string,
    updates: { sequence?: string; name?: string }
  ) => void;

  removeSpacer: (designId: string, spacerId: string) => void;

  moveSpacerToProductBoundary: (designId: string, spacerId: string, boundaryId: string) => boolean;

  setStatus: (designId: string, status: DesignStatus) => void;

  setAssemblyResult: (designId: string, result: SequenceDesign['assemblyResult']) => void;

  clearAssemblyResult: (designId: string) => void;

  getOrCreateDesign: () => string;

  draftAssembly: (designId: string) => void;

  clearDraftAssembly: (designId: string) => void;

  setSelectedJunction: (designId: string, junctionIndex: number | null) => void;

  updateHomologyRegion: (
    designId: string,
    junctionIndex: number,
    updates: Partial<Pick<HomologyRegion, 'start' | 'end' | 'encoding'>>
  ) => void;

  updateGoldenGateOffset: (designId: string, junctionIndex: number, offset: number) => void;

  updateRdEndResection: (
    designId: string,
    regionId: string,
    end: 'upstream' | 'downstream',
    bases: number
  ) => void;

  updatePrimerPbs: (
    designId: string,
    fragmentIndex: number,
    direction: 'forward' | 'reverse',
    newLength: number
  ) => void;

  updatePrimerOverhang: (
    designId: string,
    fragmentIndex: number,
    direction: 'forward' | 'reverse',
    newLength: number
  ) => void;

  navigateToPosition: (designId: string, position: number) => void;

  navigateAndHighlight: (
    designId: string,
    position: number,
    start: number,
    end: number,
    wraps?: boolean
  ) => void;

  goToInternalCutSite: (designId: string, index: number) => void;

  stepInternalCutSite: (designId: string, direction: 'next' | 'prev') => void;

  setHoveredCutSiteRegion: (designId: string, regionId: string | null) => void;

  clearScrollPosition: (designId: string) => void;

  clearHighlightRange: (designId: string) => void;
}

const scheduledTmRefinements = new Map<string, AbortController>();

const publishingDesignIds = new Set<string>();
const authorizedPublicationUpdates = new Set<string>();

export function freezeDesignEditsForPublication(designId: string): void {
  publishingDesignIds.add(designId);
}

export function unfreezeDesignEditsForPublication(designId: string): void {
  publishingDesignIds.delete(designId);
}

export function withAuthorizedDesignPublicationUpdate<T>(designId: string, action: () => T): T {
  authorizedPublicationUpdates.add(designId);
  try {
    return action();
  } finally {
    authorizedPublicationUpdates.delete(designId);
  }
}

function withDesignPublicationFence(
  initializer: StateCreator<DesignState & DesignActions, [], []>
): StateCreator<DesignState & DesignActions, [], []> {
  return (set, get, api) => {
    const setUnchecked = set as unknown as (partial: unknown, replace?: boolean) => void;
    const assertAllowed = (
      before: DesignState & DesignActions,
      next: Partial<DesignState & DesignActions> | undefined
    ) => {
      if (!next?.designs) return;
      for (const id of publishingDesignIds) {
        if (next.designs[id] !== before.designs[id] && !authorizedPublicationUpdates.has(id)) {
          throw new Error(`Assembly ${id} is being finalized. Edit it after publication finishes.`);
        }
      }
    };
    const guardedSet: typeof set = ((partial, replace) => {
      if (typeof partial === 'function') {
        setUnchecked((state: DesignState & DesignActions) => {
          const next = partial(state);
          assertAllowed(state, next as Partial<DesignState & DesignActions> | undefined);
          return next;
        }, replace);
      } else {
        assertAllowed(get(), partial);
        setUnchecked(partial, replace);
      }
    }) as typeof set;
    const priorApiSetState = api.setState;
    const priorApiSetUnchecked = priorApiSetState as unknown as (
      partial: unknown,
      replace?: boolean
    ) => void;
    api.setState = ((partial, replace) => {
      if (typeof partial === 'function') {
        priorApiSetUnchecked((state: DesignState & DesignActions) => {
          const next = partial(state);
          assertAllowed(state, next as Partial<DesignState & DesignActions> | undefined);
          return next;
        }, replace);
      } else {
        assertAllowed(get(), partial);
        priorApiSetUnchecked(partial, replace);
      }
    }) as typeof api.setState;
    return initializer(guardedSet, get, api);
  };
}

const withDesignRevision = (initializer: StateCreator<DesignState & DesignActions, [], []>) =>
  withDesignPublicationFence(withRevision(initializer));

export const useDesignStore = create<DesignState & DesignActions>()(
  persist(
    withDesignRevision((set, get) => ({
      designs: {},
      draftDesignIds: {},
      activeDesignId: null,
      pendingDispatchId: null,
      revision: 0,

      createDesign: (name, _topology = 'circular', assemblyMethod = 'gibson') => {
        const design = createEmptyDesign(name, assemblyMethod);
        const id = design.id;

        set((state) => ({
          designs: { ...state.designs, [id]: design },
          activeDesignId: id,
        }));

        return id;
      },

      createDraftDesign: (name, assemblyMethod = 'gibson') => {
        const design = createEmptyDesign(name, assemblyMethod);
        set((state) => ({
          designs: { ...state.designs, [design.id]: design },
          draftDesignIds: { ...(state.draftDesignIds ?? {}), [design.id]: true },
          activeDesignId: design.id,
        }));
        return design.id;
      },

      commitDraftDesign: (designId) => {
        set((state) => {
          if (!state.draftDesignIds?.[designId] || !state.designs[designId]) return state;
          const { [designId]: _committed, ...draftDesignIds } = state.draftDesignIds;
          return { draftDesignIds };
        });
      },

      setAssemblyMethod: (designId, method, enzyme) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          const nextDesign = switchAssemblyMethodPreservingDraft({
            design,
            method,
            enzyme,
            version: nextAssemblyVersion(design),
            now: new Date(),
          });
          if (nextDesign === design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: nextDesign,
            },
          };
        });
      },

      deleteDesign: (designId) => {
        set((state) => {
          const { [designId]: _, ...remaining } = state.designs;
          const { [designId]: _draft, ...draftDesignIds } = state.draftDesignIds;
          return {
            designs: remaining,
            draftDesignIds,
            activeDesignId: state.activeDesignId === designId ? null : state.activeDesignId,
          };
        });
      },

      setActiveDesign: (designId) => {
        if (get().activeDesignId === designId) return;
        set({ activeDesignId: designId });
      },

      updateDesign: (designId, updates) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          const normalizedUpdates: Partial<SequenceDesign> = {
            ...updates,
            ...(updates.topology !== undefined
              ? { topology: normalizeAssemblyDesignTopology() }
              : {}),
          };

          const needsClearDraft =
            (normalizedUpdates.topology !== undefined &&
              normalizedUpdates.topology !== design.topology) ||
            updates.defaultHomologyLength !== undefined ||
            'primerDesignConstraints' in updates;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                ...normalizedUpdates,
                version: nextAssemblyVersion(design),
                updatedAt: new Date(),

                assemblyResult: needsClearDraft ? undefined : design.assemblyResult,
                homologyRegions: needsClearDraft ? [] : design.homologyRegions,
                designPrimers: needsClearDraft ? [] : design.designPrimers,
                ...(needsClearDraft ? withDraftingAssemblyState(design) : {}),
                ...('primerDesignConstraints' in updates
                  ? {
                      assemblyWorkbench: {
                        ...reconcileAssemblyWorkbenchState(design),
                        primerEditIntents: [],
                      },
                    }
                  : {}),
              },
            },
          };
        });
      },

      commitWorkbenchDesign: (designId, nextDesign, expectedVersion) => {
        let committed = false;
        let primersChanged = false;
        set((state) => {
          const current = state.designs[designId];
          if (!current || nextDesign.id !== designId || current.version !== expectedVersion) {
            return state;
          }
          committed = true;
          primersChanged = current.designPrimers !== nextDesign.designPrimers;
          return {
            designs: {
              ...state.designs,
              [designId]: nextDesign,
            },
          };
        });
        if (
          committed &&
          primersChanged &&
          nextDesign.designPrimers.length > 0 &&
          !nextDesign.historicalComponentSources?.some((item) => item.kind === 'primer-pair')
        ) {
          scheduleDraftedPrimerTmRefinement(designId);
        }
        return committed;
      },

      setGoldenGateSchema: (designId, schema, expectedVersion, options) => {
        const current = get().designs[designId];
        if (!current) {
          return {
            status: 'rejected',
            code: 'design-not-found',
            message: `Design ${designId} does not exist.`,
          };
        }

        const result = applyGoldenGateSchemaCommand({
          design: current,
          schema,
          expectedVersion,
          options,
        });
        if (result.status !== 'applied') return result;

        let committed = false;
        let actualVersion = current.version;
        set((state) => {
          const latest = state.designs[designId];
          actualVersion = latest?.version ?? actualVersion;
          if (!latest || latest.version !== expectedVersion) return state;
          committed = true;
          return {
            designs: {
              ...state.designs,
              [designId]: result.nextDesign,
            },
          };
        });

        return committed
          ? result
          : {
              status: 'rejected',
              code: 'stale-version',
              message: `Expected design version ${expectedVersion}, but found ${actualVersion}.`,
            };
      },

      clearGoldenGateSchema: (designId, expectedVersion, options) =>
        get().setGoldenGateSchema(designId, undefined, expectedVersion, options),

      setMocloFactoryStage: (designId, selection, runId, expectedVersion) => {
        const current = get().designs[designId];
        if (!current) {
          return {
            status: 'rejected',
            code: 'design-not-found',
            message: `Design ${designId} does not exist.`,
          };
        }

        const result = applyMocloFactoryStageCommand({
          design: current,
          selection,
          runId,
          expectedVersion,
        });
        if (result.status !== 'applied') return result;

        let committed = false;
        let actualVersion = current.version;
        set((state) => {
          const latest = state.designs[designId];
          actualVersion = latest?.version ?? actualVersion;
          if (!latest || latest.version !== expectedVersion) return state;
          committed = true;
          return {
            designs: {
              ...state.designs,
              [designId]: result.nextDesign,
            },
          };
        });

        return committed
          ? result
          : {
              status: 'rejected',
              code: 'stale-version',
              message: `Expected design version ${expectedVersion}, but found ${actualVersion}.`,
            };
      },

      commitAcceptedAssemblyVersion: (designId, acceptedVersion, expectedVersion) => {
        let committed = false;
        set((state) => {
          const current = state.designs[designId];
          if (!current || current.version !== expectedVersion) return state;
          committed = true;
          return {
            designs: {
              ...state.designs,
              [designId]: appendAcceptedAssemblyVersionToDesign(current, acceptedVersion),
            },
          };
        });
        return committed;
      },

      replaceAcceptedAssemblyVersion: (designId, acceptedVersion) => {
        let committed = false;
        set((state) => {
          const current = state.designs[designId];
          const acceptedVersions = current?.acceptedAssemblyVersions ?? [];
          const versionIndex = acceptedVersions.findIndex(
            (version) => version.id === acceptedVersion.id
          );
          if (!current || versionIndex === -1) return state;
          const nextVersions = [...acceptedVersions];
          nextVersions[versionIndex] = acceptedVersion;
          const activatesDesign = acceptedAssemblyVersionActivatesDesign(acceptedVersion);
          committed = true;
          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...current,
                acceptedAssemblyVersions: nextVersions,
                activeAcceptedAssemblyVersionId: activatesDesign
                  ? acceptedVersion.id
                  : (current.activeAcceptedAssemblyVersionId ?? null),
                assemblyState: activatesDesign ? 'assembled' : current.assemblyState,
                status: activatesDesign ? 'assembled' : current.status,
                version: current.version + 1,
                updatedAt: new Date(),
              },
            },
          };
        });
        return committed;
      },

      reopenAcceptedAssemblyVersion: (acceptedVersion, options = {}) => {
        const designId = options.designId ?? generateId();
        const reopenedDesign = sequenceDesignFromAcceptedAssemblyVersion(acceptedVersion, {
          designId,
          now: options.now,
          name: options.name,
        });
        set((state) => ({
          designs: {
            ...state.designs,
            [designId]: reopenedDesign,
          },
          activeDesignId: designId,
        }));
        return designId;
      },

      upsertDesignFromArtifact: (design) => {
        if (!acceptDesignArtifact(design)) {
          const recovered = useDesignRecoveryStore.getState().records[design.id]?.design;
          if (!recovered) return;
          design = recovered;
        }
        const normalized = normalizePersistedDesign(design);
        normalized.createdAt = new Date(normalized.createdAt);
        normalized.updatedAt = new Date(normalized.updatedAt);
        set((state) => ({
          designs: {
            ...state.designs,
            [normalized.id]: hydrateDesign(normalized),
          },
          activeDesignId: normalized.id,
        }));
      },

      resolveExistingDraft: (input) =>
        resolveExistingDesignDraft(
          {
            loaded: (designId) => get().designs[designId],
            installFromArtifact: (design) => get().upsertDesignFromArtifact(design),
          },
          input
        ),

      loadedDraft: (designId, identity) =>
        loadedDesignDraft(
          { loaded: (id) => get().designs[id], installFromArtifact: () => {} },
          designId,
          identity
        ),

      bindDesignConstructId: (designId, constructId) => {
        const design = get().designs[designId];
        if (!design) return;
        if (design.constructId === constructId) return;
        if (design.constructId && design.constructId !== constructId) {
          throw new Error(
            `Design ${designId} is already bound to construct ${design.constructId}, not ${constructId}.`
          );
        }
        set((state) => {
          const current = state.designs[designId];
          if (!current || current.constructId) return state;
          return {
            designs: {
              ...state.designs,
              [designId]: { ...current, constructId },
            },
          };
        });
      },

      setSavedPrimerLinks: (designId, links) => {
        let changed = false;
        set((state) => {
          const current = state.designs[designId];
          if (!current || sameSavedPrimerLinks(current.savedPrimerLinks, links)) return state;
          changed = true;
          return {
            designs: {
              ...state.designs,
              [designId]: { ...current, savedPrimerLinks: links, updatedAt: new Date() },
            },
          };
        });
        return changed;
      },

      addRegion: (designId, regionData) => {
        const regionId = generateId();

        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);

          const region: DesignRegion = {
            ...regionData,
            id: regionId,
            colorIndex: regionData.colorIndex ?? nextRegionColorIndex(existingRegions),
          };
          const newRegions = [...existingRegions, region];
          const adjustedSpacers = reanchorSpacersToCurrentGaps(
            adjustSpacersForRegionInsert(design.spacers, existingRegions.length, null),
            newRegions,
            design.topology === 'circular'
          );

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                ...withAssemblySlotStructure(design, normalizeRegionColorIndices(newRegions)),
                spacers: adjustedSpacers,
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      insertRegionAt: (designId, index, regionData) => {
        const regionId = generateId();

        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);

          const region: DesignRegion = {
            ...regionData,
            id: regionId,
            colorIndex: regionData.colorIndex ?? nextRegionColorIndex(existingRegions),
          };

          try {
            localStorage.setItem(
              '__DEBUG_PASTE__',
              JSON.stringify({
                timestamp: new Date().toISOString(),
                input: {
                  sourceType: regionData.sourceType,
                  rdOverhangs: regionData.rdOverhangs,
                },
                created: {
                  sourceType: region.sourceType,
                  rdOverhangs: region.rdOverhangs,
                },
              })
            );
          } catch (e) {}

          const insertIndex = clampRegionInsertIndex(index, existingRegions.length);

          const newRegions = [...existingRegions];
          newRegions.splice(insertIndex, 0, region);
          const adjustedSpacers = reanchorSpacersToCurrentGaps(
            adjustSpacersForRegionInsert(design.spacers, insertIndex, null),
            newRegions,
            design.topology === 'circular'
          );

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                ...withAssemblySlotStructure(design, normalizeRegionColorIndices(newRegions)),
                spacers: adjustedSpacers,
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      insertRegionAtProductBoundary: (designId, boundaryId, regionData) => {
        const regionId = generateId();

        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const boundary =
            findProductLayoutBoundary(design, boundaryId) ??
            findProductLayoutBoundary(designWithSelectedPendingSpacer(design), boundaryId);
          if (!boundary || !boundary.canAddPart) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);
          const insertIndex = clampRegionInsertIndex(
            boundary.partInsertIndex,
            existingRegions.length
          );

          const region: DesignRegion = {
            ...regionData,
            id: regionId,
            colorIndex: regionData.colorIndex ?? nextRegionColorIndex(existingRegions),
          };
          const newRegions = [...existingRegions];
          newRegions.splice(insertIndex, 0, region);
          const adjustedSpacers = reanchorSpacersToCurrentGaps(
            adjustSpacersForRegionInsert(
              design.spacers,
              insertIndex,
              boundary.moveSpacerAfterInsertedPartJunctionIndex
            ),
            newRegions,
            design.topology === 'circular'
          );

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                ...withAssemblySlotStructure(design, normalizeRegionColorIndices(newRegions)),
                spacers: adjustedSpacers,
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                selectedJunctionIndex: null,
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      removeRegion: (designId, regionId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);

          const removedIndex = existingRegions.findIndex((r) => r.id === regionId);
          if (removedIndex < 0) return state;
          const newRegions = existingRegions.filter((r) => r.id !== regionId);

          const adjustedSpacers = design.spacers
            .filter((spacer) => {
              return spacer.junctionIndex !== removedIndex;
            })
            .map((spacer) => {
              if (spacer.junctionIndex > removedIndex) {
                return { ...spacer, junctionIndex: spacer.junctionIndex - 1 };
              }
              return spacer;
            })
            .filter((spacer) => {
              const maxJunction =
                design.topology === 'circular' ? newRegions.length - 1 : newRegions.length - 1;
              return spacer.junctionIndex >= 0 && spacer.junctionIndex <= maxJunction;
            });

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                ...withAssemblySlotStructure(design, normalizeRegionColorIndices(newRegions)),
                spacers: adjustedSpacers,
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      clearRegion: (designId, regionId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);
          if (!existingRegions.some((r) => r.id === regionId)) return state;

          const clearedRegions = existingRegions.map((region) =>
            region.id === regionId
              ? {
                  ...emptyDesignRegion(),
                  id: region.id,
                  colorIndex: region.colorIndex,
                  schemaSlotId: region.schemaSlotId,
                }
              : region
          );

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                regions: normalizeRegionColorIndices(clearedRegions),
                backboneSequenceId: schemaBackboneSequenceId(design, clearedRegions),

                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      updateRegion: (designId, regionId, updates) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);

          const regionIndex = design.regions.findIndex((r) => r.id === regionId);
          if (regionIndex === -1) return state;

          const updatedRegions = [...existingRegions];
          updatedRegions[regionIndex] = normalizeRegionInput({
            ...updatedRegions[regionIndex],
            ...updates,
            id: regionId,
            schemaSlotId: updatedRegions[regionIndex].schemaSlotId,
          });

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                regions: normalizeRegionColorIndices(updatedRegions),
                backboneSequenceId: schemaBackboneSequenceId(design, updatedRegions),
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      reverseComplementRegion: (designId, regionId, sourceContext) => {
        let applied = false;
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);
          const regionIndex = existingRegions.findIndex((region) => region.id === regionId);
          if (regionIndex < 0) return state;
          const region = existingRegions[regionIndex];
          const reversibleRegion =
            !region.sourceSequence && sourceContext
              ? {
                  ...region,
                  sourceSequence: sourceContext.sourceSequence,
                  sourceLength: sourceContext.sourceSequence.length,
                  sourceAnnotations: sourceContext.sourceAnnotations,
                }
              : region;
          const reversed = reverseComplementDesignRegion(reversibleRegion);
          if (!reversed) return state;

          const updatedRegions = [...existingRegions];
          updatedRegions[regionIndex] = reversed;
          if (!isGoldenGateFixedRegionOrderCompatible(design, updatedRegions)) {
            if (process.env.NODE_ENV === 'development') {
              console.warn(
                '[Design Store] reverseComplementRegion: incompatible fixed Golden Gate overhangs'
              );
            }
            return state;
          }
          applied = true;
          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                regions: normalizeRegionColorIndices(updatedRegions),
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
        return applied;
      },

      reorderRegions: (designId, regionIds) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const existingRegions = normalizeRegionColorIndices(design.regions);

          const regionMap = new Map(existingRegions.map((r) => [r.id, r]));
          const reordered = regionIds
            .map((id) => regionMap.get(id))
            .filter((r): r is DesignRegion => r !== undefined);

          if (
            reordered.length !== existingRegions.length ||
            new Set(regionIds).size !== existingRegions.length
          ) {
            if (process.env.NODE_ENV === 'development') {
              console.warn('[Design Store] reorderRegions: region count mismatch');
            }
            return state;
          }
          if (!isGoldenGateFixedRegionOrderCompatible(design, reordered)) {
            if (process.env.NODE_ENV === 'development') {
              console.warn(
                '[Design Store] reorderRegions: incompatible fixed Golden Gate overhangs'
              );
            }
            return state;
          }
          const move = detectSingleRegionMove(
            existingRegions.map((region) => region.id),
            reordered.map((region) => region.id)
          );

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                ...withAssemblySlotStructure(design, normalizeRegionColorIndices(reordered)),

                spacers: adjustSpacersForReorder(design.spacers, reordered, move, design.topology),
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      reorderProductLayoutSegments: (designId, orderedSegmentIds) => {
        let applied = false;
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;

          const normalizedDesign = {
            ...design,
            regions: normalizeRegionColorIndices(design.regions),
          };
          const nextOrder = productLayoutOrderToDesign(normalizedDesign, orderedSegmentIds);
          if (!nextOrder) {
            if (process.env.NODE_ENV === 'development') {
              console.warn('[Design Store] reorderProductLayoutSegments: invalid product order');
            }
            return state;
          }
          if (!isGoldenGateFixedRegionOrderCompatible(design, nextOrder.regions)) {
            if (process.env.NODE_ENV === 'development') {
              console.warn(
                '[Design Store] reorderProductLayoutSegments: incompatible fixed Golden Gate overhangs'
              );
            }
            return state;
          }

          const changedRegions = nextOrder.regions.some(
            (region, index) => region !== normalizedDesign.regions[index]
          );
          const changedSpacers =
            nextOrder.spacers.length !== normalizedDesign.spacers.length ||
            nextOrder.spacers.some((spacer, index) => {
              const current = normalizedDesign.spacers[index];
              return (
                !current ||
                current.id !== spacer.id ||
                current.junctionIndex !== spacer.junctionIndex ||
                current.sequence !== spacer.sequence
              );
            });
          if (!changedRegions && !changedSpacers) return state;

          const reorderedRegions = normalizeRegionColorIndices(nextOrder.regions);
          applied = true;
          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                ...withAssemblySlotStructure(design, reorderedRegions),
                spacers: reanchorSpacersToCurrentGaps(
                  nextOrder.spacers,
                  reorderedRegions,
                  design.topology === 'circular'
                ),
                selectedJunctionIndex: null,
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
        return applied;
      },

      setJunctionSpacer: (designId, junctionIndex, sequence, name) => {
        let applied = false;
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const nextDesign = reduceJunctionSpacerChange(design, junctionIndex, sequence, name);
          if (!nextDesign) return state;
          applied = true;
          return {
            designs: {
              ...state.designs,
              [designId]: nextDesign,
            },
          };
        });
        return applied;
      },

      addSpacer: (designId, junctionIndex, sequence, name) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          if ((design.spacers ?? []).some((spacer) => spacer.junctionIndex === junctionIndex)) {
            return state;
          }
          const nextDesign = reduceJunctionSpacerChange(design, junctionIndex, sequence, name);
          if (!nextDesign) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: nextDesign,
            },
          };
        });
      },

      updateSpacer: (designId, spacerId, updates) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const spacer = design.spacers.find((candidate) => candidate.id === spacerId);
          if (!spacer) return state;
          const nextDesign = reduceJunctionSpacerChange(
            design,
            spacer.junctionIndex,
            updates.sequence ?? spacer.sequence,
            updates.name ?? spacer.name
          );
          if (!nextDesign) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: nextDesign,
            },
          };
        });
      },

      removeSpacer: (designId, spacerId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const spacer = design.spacers.find((candidate) => candidate.id === spacerId);
          if (!spacer) return state;
          const nextDesign = reduceJunctionSpacerChange(design, spacer.junctionIndex, '');
          if (!nextDesign) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: nextDesign,
            },
          };
        });
      },

      moveSpacerToProductBoundary: (designId, spacerId, boundaryId) => {
        let applied = false;
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) return state;
          const spacer = design.spacers.find((candidate) => candidate.id === spacerId);
          if (!spacer) return state;

          const boundary = findProductLayoutBoundary(design, boundaryId);
          if (!boundary?.canAddSpacer || boundary.spacerJunctionIndex === null) return state;
          if (boundary.spacerJunctionIndex === spacer.junctionIndex) return state;
          if (
            design.spacers.some(
              (candidate) =>
                candidate.id !== spacerId &&
                candidate.junctionIndex === boundary.spacerJunctionIndex
            )
          ) {
            return state;
          }

          const targetJunctionIndex = boundary.spacerJunctionIndex;
          const movedSpacers = design.spacers.map((candidate) =>
            candidate.id === spacerId
              ? { ...candidate, junctionIndex: targetJunctionIndex }
              : candidate
          );
          applied = true;
          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                spacers: reanchorSpacersToCurrentGaps(
                  movedSpacers,
                  design.regions,
                  design.topology === 'circular'
                ),
                selectedJunctionIndex: null,
                ...withDraftingAssemblyState(design),
                assemblyResult: undefined,
                homologyRegions: [],
                designPrimers: [],
                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                updatedAt: new Date(),
              },
            },
          };
        });
        return applied;
      },

      setStatus: (designId, status) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                status,
                assemblyState: legacyStatusToAssemblyState(status),
                validationErrors: status === 'draft' ? [] : design.validationErrors,
                version: nextAssemblyVersion(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      setAssemblyResult: (designId, result) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                assemblyResult: result,
                status: 'computed',
                assemblyState: 'ready',
                validationErrors: [],
                version: nextAssemblyVersion(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      clearAssemblyResult: (designId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                assemblyResult: undefined,
                ...withDraftingAssemblyState(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      getOrCreateDesign: () => {
        const state = get();

        if (state.activeDesignId && state.designs[state.activeDesignId]) {
          return state.activeDesignId;
        }

        const designIds = Object.keys(state.designs);
        if (designIds.length > 0) {
          const id = designIds[0];
          set({ activeDesignId: id });
          return id;
        }

        return get().createDesign('Untitled');
      },

      draftAssembly: (designId) => {
        const state = get();
        const design = state.designs[designId];
        if (!design || design.regions.length < 2) {
          return;
        }

        void assemblyDispatcher.dispatch({
          type: 'validate',
          designId,
          expectedVersion: design.version ?? 0,
        }).result;
      },

      clearDraftAssembly: (designId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                homologyRegions: [],
                designPrimers: [],

                goldenGateJunctions:
                  design.assemblyMethod === 'goldengate' ? [] : design.goldenGateJunctions,
                selectedJunctionIndex: null,
                scrollToPosition: null,
                highlightRange: null,
                ...withDraftingAssemblyState(design),
                assemblyWorkbench: {
                  ...reconcileAssemblyWorkbenchState(design),
                  primerEditIntents: [],
                  autoDraftPrimers: false,
                },
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      setSelectedJunction: (designId, junctionIndex) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                selectedJunctionIndex: junctionIndex,
              },
            },
          };
        });
      },

      updateHomologyRegion: (designId, junctionIndex, updates) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          const assemblyRegions = getEffectiveDesignRegions(design);
          const composedSequence = getComposedSequence(assemblyRegions, design.spacers);
          const seqLen = composedSequence.length;

          const homologyRegions = design.homologyRegions.map((region) => {
            if (region.junctionIndex !== junctionIndex) return region;

            const updated = { ...region, ...updates };
            const templateBasis =
              updated.templateBasis ??
              homologyTemplateBasisForDesign(design, assemblyRegions, junctionIndex);
            if (templateBasis) {
              updated.templateBasis = templateBasis;
            }

            if (updates.start !== undefined || updates.end !== undefined) {
              const newStart = updated.start;
              const newEnd = updated.end;

              if (templateBasis) {
                updated.encoding = homologyEncodingFromRange(
                  newStart,
                  newEnd,
                  templateBasis,
                  region.encoding,
                  seqLen
                );
              } else {
                const length = newStart > newEnd ? seqLen - newStart + newEnd : newEnd - newStart;
                const halfLeft = Math.floor(length / 2);
                updated.encoding = { onLeft: halfLeft, onRight: length - halfLeft };
              }
            }

            return recomputeHomologyMetadata(updated, composedSequence, region.encoding);
          });

          const designPrimers = recomputePrimers(
            assemblyRegions,
            homologyRegions,
            design.topology,
            design.spacers,
            createAppTmCalculator(design.pcrPolymerase),
            design.primerDesignConstraints?.targetPcrTm
          );

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                homologyRegions,
                designPrimers,
                version: nextAssemblyVersion(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      updateGoldenGateOffset: (designId, junctionIndex, newOffset) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design || !design.goldenGateJunctions || !design.goldenGateConfig) return state;

          const targetJunction = design.goldenGateJunctions.find(
            (junction) => junction.junctionIndex === junctionIndex
          );
          if (!targetJunction || isGoldenGateJunctionOffsetLocked(targetJunction)) return state;

          const composedSequence = getComposedSequence(design.regions, design.spacers);
          const seqLen = composedSequence.length;

          const updatedJunctions = design.goldenGateJunctions.map((junction) => {
            if (junction.junctionIndex !== junctionIndex) return junction;

            const junctionPos = junction.junctionPosition;
            const overhangStart = junctionPos - 2 + newOffset;
            const overhangEnd = overhangStart + 4;

            let overhang = '';
            for (let i = 0; i < 4; i++) {
              const idx = (((overhangStart + i) % seqLen) + seqLen) % seqLen;
              overhang += composedSequence[idx];
            }

            return {
              ...junction,
              offset: newOffset,
              overhangStart,
              overhangEnd,
              overhang,
            };
          });

          const usedOverhangs = new Set<string>();
          const goldenGateJunctions = updatedJunctions.map((junction) => {
            let validationError: string | undefined;
            let isValid = true;

            if (usedOverhangs.has(junction.overhang)) {
              validationError = userMessageWithValues(
                'assembly.overhang.duplicate-overhang-value0',
                { value0: userMessageValue(junction.overhang) }
              );
              isValid = false;
            } else if (isPalindrome(junction.overhang)) {
              validationError = userMessageWithValues(
                'assembly.overhang.palindromic-overhang-value0-risk-of-self-ligation',
                { value0: userMessageValue(junction.overhang) }
              );
              isValid = false;
            }

            usedOverhangs.add(junction.overhang);

            return {
              ...junction,
              isValid,
              validationError,
            };
          });

          const existingPbsLengths = new Map<string, number>();
          for (const pair of design.designPrimers) {
            const fwdLen = pair.forward.pbs.end - pair.forward.pbs.start;
            const revLen = pair.reverse.pbs.end - pair.reverse.pbs.start;
            existingPbsLengths.set(`${pair.fragmentIndex}-forward`, fwdLen);
            existingPbsLengths.set(`${pair.fragmentIndex}-reverse`, revLen);
          }

          const newPrimers = computeGoldenGatePrimers(
            design.regions,
            goldenGateJunctions,
            design.topology,
            design.goldenGateConfig.enzyme,
            design.spacers,
            design.primerDesignConstraints?.targetPcrTm ?? useSettingsStore.getState().defaultPcrTm,
            createAppTmCalculator(design.pcrPolymerase)
          );

          const designPrimers = newPrimers.map((pair) => {
            const fwdPbsLen = existingPbsLengths.get(`${pair.fragmentIndex}-forward`);
            const revPbsLen = existingPbsLengths.get(`${pair.fragmentIndex}-reverse`);

            return {
              ...pair,
              forward:
                fwdPbsLen && fwdPbsLen !== pair.forward.pbs.end - pair.forward.pbs.start
                  ? updatePrimerPbsLength(
                      pair.forward,
                      fwdPbsLen,
                      design.regions,
                      design.spacers,
                      createAppTmCalculator(design.pcrPolymerase)
                    )
                  : pair.forward,
              reverse:
                revPbsLen && revPbsLen !== pair.reverse.pbs.end - pair.reverse.pbs.start
                  ? updatePrimerPbsLength(
                      pair.reverse,
                      revPbsLen,
                      design.regions,
                      design.spacers,
                      createAppTmCalculator(design.pcrPolymerase)
                    )
                  : pair.reverse,
            };
          });

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                goldenGateJunctions,
                designPrimers,
                version: nextAssemblyVersion(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      updateRdEndResection: (designId, regionId, end, bases) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          const resectionBases = clampNebuilderResection(bases);
          const regions = design.regions.map((region) => {
            if (region.id !== regionId) return region;

            const existingEnd = region.rdEnds?.[end] ?? {};
            return {
              ...region,
              rdEnds: {
                ...region.rdEnds,
                [end]: {
                  ...existingEnd,
                  nebuilderResectionBases: resectionBases,
                },
              },
            };
          });

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                regions,
                homologyRegions: [],
                designPrimers: [],
                assemblyResult: undefined,
                ...withDraftingAssemblyState(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      updatePrimerPbs: (designId, fragmentIndex, direction, newLength) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          const designPrimers = design.designPrimers.map((pair) => {
            if (pair.fragmentIndex !== fragmentIndex) return pair;
            const assemblyRegions = getEffectiveDesignRegions(design);

            if (direction === 'forward') {
              const updatedPrimer = updatePrimerPbsLength(
                pair.forward,
                newLength,
                assemblyRegions,
                design.spacers,
                createAppTmCalculator(design.pcrPolymerase)
              );
              return { ...pair, forward: updatedPrimer };
            } else {
              const updatedPrimer = updatePrimerPbsLength(
                pair.reverse,
                newLength,
                assemblyRegions,
                design.spacers,
                createAppTmCalculator(design.pcrPolymerase)
              );
              return { ...pair, reverse: updatedPrimer };
            }
          });

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                designPrimers,
                version: nextAssemblyVersion(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      updatePrimerOverhang: (designId, fragmentIndex, direction, newLength) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          const primerPairIndex = design.designPrimers.findIndex(
            (p) => p.fragmentIndex === fragmentIndex
          );
          if (primerPairIndex === -1) return state;

          const primerPair = design.designPrimers[primerPairIndex];
          const primer = direction === 'forward' ? primerPair.forward : primerPair.reverse;
          const junctionIndex = primer.junctionIndex;
          if (junctionIndex === null) return state;

          const homologyIndex = design.homologyRegions.findIndex(
            (hr) => hr.junctionIndex === junctionIndex
          );
          if (homologyIndex === -1) return state;

          const homologyRegion = design.homologyRegions[homologyIndex];
          const oldEncoding = homologyRegion.encoding;
          const assemblyRegions = getEffectiveDesignRegions(design);
          const composedSequence = getComposedSequence(assemblyRegions, design.spacers);

          const spacerAtJunction = design.spacers?.find((s) => s.junctionIndex === junctionIndex);
          const spacerSeq = spacerAtJunction?.sequence ?? '';
          const spacerLen = spacerSeq.length;

          let adjustedLength: number;
          let shouldIncludeSpacer: boolean;
          const spacerIsSeparateCargo =
            direction === 'reverse' || forwardSpacerIsSeparateCargo(homologyRegion, spacerLen);

          if (spacerLen > 0 && newLength < spacerLen) {
            shouldIncludeSpacer = true;
            adjustedLength = 0;
          } else if (spacerLen > 0 && spacerIsSeparateCargo) {
            shouldIncludeSpacer = true;
            adjustedLength = newLength - spacerLen;
          } else {
            shouldIncludeSpacer = true;
            adjustedLength = newLength;
          }

          const newEncoding = calculateNewEncodingForOverhang(
            oldEncoding,
            direction,
            adjustedLength
          );

          const updatedHomologyRegion = recomputeHomologyMetadata(
            { ...homologyRegion, encoding: newEncoding },
            composedSequence,
            oldEncoding
          );

          const updatedHomologyRegions = [...design.homologyRegions];
          updatedHomologyRegions[homologyIndex] = updatedHomologyRegion;

          const updatedPrimers = design.designPrimers.map((pair) => {
            const fwdNeedsUpdate = pair.forward.junctionIndex === junctionIndex;

            const revNeedsUpdate = pair.reverse.junctionIndex === junctionIndex;

            if (!fwdNeedsUpdate && !revNeedsUpdate) {
              return pair;
            }

            const isTargetForward = pair.fragmentIndex === fragmentIndex && direction === 'forward';
            const isTargetReverse = pair.fragmentIndex === fragmentIndex && direction === 'reverse';

            const fwdCurrentLength =
              pair.forward.overhang.tailLength ?? pair.forward.overhang.sequence.length;
            const revCurrentLength =
              pair.reverse.overhang.tailLength ?? pair.reverse.overhang.sequence.length;

            const updatedFwd = fwdNeedsUpdate
              ? updatePrimerOverhangFromHomology(
                  pair.forward,
                  updatedHomologyRegion,
                  isTargetForward ? shouldIncludeSpacer : true,
                  spacerSeq,
                  composedSequence,
                  isTargetForward ? newLength : fwdCurrentLength
                )
              : pair.forward;

            const updatedRev = revNeedsUpdate
              ? updatePrimerOverhangFromHomology(
                  pair.reverse,
                  updatedHomologyRegion,
                  isTargetReverse ? shouldIncludeSpacer : true,
                  spacerSeq,
                  composedSequence,
                  isTargetReverse ? newLength : revCurrentLength
                )
              : pair.reverse;

            return {
              ...pair,
              forward: updatedFwd,
              reverse: updatedRev,
            };
          });

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                homologyRegions: updatedHomologyRegions,
                designPrimers: updatedPrimers,
                version: nextAssemblyVersion(design),
                updatedAt: new Date(),
              },
            },
          };
        });
      },

      navigateToPosition: (designId, position) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                scrollToPosition: position,
              },
            },
          };
        });
      },

      clearScrollPosition: (designId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                scrollToPosition: null,
              },
            },
          };
        });
      },

      navigateAndHighlight: (designId, position, start, end, wraps) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                scrollToPosition: position,
                highlightRange: { start, end, wraps },
              },
            },
          };
        });
      },

      goToInternalCutSite: (designId, index) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          const markers = collectInternalCutSiteMarkers(design, deriveAssemblyIssues({ design }));
          if (markers.length === 0) return state;
          const clamped = Math.max(0, Math.min(index, markers.length - 1));
          const marker = markers[clamped];
          const range = markerHighlightRange(marker);
          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                activeCutSiteIndex: clamped,
                scrollToPosition: markerScrollPosition(marker),
                highlightRange: range,
              },
            },
          };
        });
      },

      stepInternalCutSite: (designId, direction) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;
          const markers = collectInternalCutSiteMarkers(design, deriveAssemblyIssues({ design }));
          const nextIndex = stepCutSiteIndex(
            markers.length,
            design.activeCutSiteIndex ?? null,
            direction
          );
          if (nextIndex === null) return state;
          const marker = markers[nextIndex];
          const range = markerHighlightRange(marker);
          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                activeCutSiteIndex: nextIndex,
                scrollToPosition: markerScrollPosition(marker),
                highlightRange: range,
              },
            },
          };
        });
      },

      setHoveredCutSiteRegion: (designId, regionId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design || (design.hoveredCutSiteRegionId ?? null) === regionId) return state;
          return {
            designs: {
              ...state.designs,
              [designId]: { ...design, hoveredCutSiteRegionId: regionId },
            },
          };
        });
      },

      clearHighlightRange: (designId) => {
        set((state) => {
          const design = state.designs[designId];
          if (!design) return state;

          return {
            designs: {
              ...state.designs,
              [designId]: {
                ...design,
                highlightRange: null,
              },
            },
          };
        });
      },
    })),
    {
      name: 'waypoint-designs',
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, value);
            if (localStorage.getItem(name) === value)
              confirmDesignRecoveryBackup(JSON.parse(value).state.designRecoveryRecords ?? {});
          } catch {}
        },
        removeItem: (name) => localStorage.removeItem(name),
      })),
      version: 2,
      migrate: (persistedState) => migratePersistedDesignState(persistedState),
      partialize: (state) => ({
        designs: partializeDesigns(state.designs, state.draftDesignIds),
        activeDesignId:
          state.activeDesignId && !state.draftDesignIds[state.activeDesignId]
            ? state.activeDesignId
            : null,
        designRecoveryRecords: useDesignRecoveryStore.getState().records,
      }),
      onRehydrateStorage: () => {
        return (state, error) => {
          if (error) {
            console.error('Failed to rehydrate design state:', error);
            return;
          }
          if (!state) return;

          for (const [id, design] of Object.entries(state.designs)) {
            const normalized = normalizePersistedDesign(design);

            normalized.createdAt = new Date(normalized.createdAt);
            normalized.updatedAt = new Date(normalized.updatedAt);

            if (!normalized.assemblyMethod) {
              normalized.assemblyMethod = 'gibson';
            }

            if (!normalized.spacers) {
              normalized.spacers = [];
            }

            const hydrated = hydrateDesign(normalized);
            state.designs[id] = hydrated;
            if (hydrated.designPrimers.length > 0) {
              scheduleDraftedPrimerTmRefinement(id);
            }
          }
        };
      },
    }
  )
);

export async function refineDraftedPrimerTm(designId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const before = useDesignStore.getState().designs[designId];
  if (!before || before.designPrimers.length === 0) return;

  const expectedVersion = before.version;
  const settings = useSettingsStore.getState();
  const expectedTmContext = tmRefinementContext(before, settings);
  const result = await refinePrimersForPolymerase(before.designPrimers, before.pcrPolymerase, {
    userSetting: settings.tmModel,
    userSettingIsExplicit: settings.tmModelExplicit,
    conditions: settings.tmConditions,
    concNm: settings.primerConcNm,
    signal,
  });
  if (!result.attempted || !result.changed) return;

  useDesignStore.setState((state) => {
    const current = state.designs[designId];
    if (!current || current.version !== expectedVersion) return state;
    if (current.designPrimers !== before.designPrimers) return state;
    if (tmRefinementContext(current, useSettingsStore.getState()) !== expectedTmContext) {
      return state;
    }
    return {
      designs: {
        ...state.designs,
        [designId]: { ...current, designPrimers: result.primers },
      },
    };
  });
}

function tmRefinementContext(
  design: SequenceDesign,
  settings: ReturnType<typeof useSettingsStore.getState>
): string {
  return JSON.stringify({
    polymerase: design.pcrPolymerase ?? null,
    model: settings.tmModel,
    modelExplicit: settings.tmModelExplicit,
    concentrationNm: settings.primerConcNm,
    concentrationExplicit: settings.primerConcExplicit,
    conditions: settings.tmConditions,
  });
}

export function scheduleDraftedPrimerTmRefinement(designId: string): void {
  scheduledTmRefinements.get(designId)?.abort();
  const controller = new AbortController();
  scheduledTmRefinements.set(designId, controller);

  queueMicrotask(() => {
    if (controller.signal.aborted) return;
    void refineDraftedPrimerTm(designId, controller.signal)
      .catch((error: unknown) => {
        if ((error as Error).name !== 'AbortError') {
          console.warn('[tm] background refinement failed', error);
        }
      })
      .finally(() => {
        if (scheduledTmRefinements.get(designId) === controller) {
          scheduledTmRefinements.delete(designId);
        }
      });
  });
}

export const assemblyDispatcher = createAssemblyDispatcher({
  getDesign: (designId) => useDesignStore.getState().designs[designId],
  updateDesign: (designId, updater) => {
    let primersChanged = false;
    let hasPrimers = false;
    useDesignStore.setState((state) => {
      const design = state.designs[designId];
      if (!design) return state;
      const normalized = normalizeAssemblyDesign(design);
      if (!normalized) return state;
      const updated = updater(normalized);
      primersChanged = design.designPrimers !== updated.designPrimers;
      hasPrimers = updated.designPrimers.length > 0;

      return {
        designs: {
          ...state.designs,
          [designId]: updated,
        },
      };
    });
    if (primersChanged && hasPrimers) {
      scheduleDraftedPrimerTmRefinement(designId);
    }
  },
  setPendingDispatchId: (pendingDispatchId) => {
    useDesignStore.setState({ pendingDispatchId });
  },
});

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as unknown as Window & { __DESIGN_STORE__: typeof useDesignStore }).__DESIGN_STORE__ =
    useDesignStore;
}
