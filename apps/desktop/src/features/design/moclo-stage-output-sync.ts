import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import {
  computeVirtualDigest,
  type VirtualDigestFragment,
} from '../assembly-panel/public/hooks/useVirtualDigest';
import { fragmentToRegion } from '../assembly-panel/public/utils/fragmentToRegion';
import { classifyGoldenGateCandidate } from './golden-gate-schema';
import { emptyDesignRegion, normalizeAssemblySlots } from './assembly-slots';
import { getComposedSequenceForDesign } from './restriction-digest';
import type {
  DesignAnnotation,
  DesignRegion,
  MocloFactoryDesignContext,
  SequenceDesign,
} from './types';

export interface ReconcileMocloFactoryStageOutputsInput {
  designs: Record<string, SequenceDesign>;
  enzymes: readonly RestrictionEnzyme[];
  now?: Date;
}

export function hasMocloFactoryStageOutputWork(designs: Record<string, SequenceDesign>): boolean {
  const values = Object.values(designs);
  return values.some((target) => {
    const factory = target.mocloFactory;
    const schema = target.goldenGateSchema;
    if (!factory || !schema || factory.stageInputs.length === 0) return false;
    return factory.stageInputs.some((input) =>
      schema.slots.some((slot) => slot.id === input.slotId)
    );
  });
}

export function reconcileMocloFactoryStageOutputs({
  designs,
  enzymes,
  now = new Date(),
}: ReconcileMocloFactoryStageOutputsInput): Record<string, SequenceDesign> {
  const enzymeByName = new Map(enzymes.map((enzyme) => [enzyme.name, enzyme]));
  const resolved = new Map<string, SequenceDesign>();
  const resolving = new Set<string>();

  const resolveDesign = (designId: string): SequenceDesign => {
    const cached = resolved.get(designId);
    if (cached) return cached;
    const original = designs[designId];
    if (!original || resolving.has(designId)) return original;

    resolving.add(designId);
    const next = resolveOneDesign(original, designs, resolveDesign, enzymeByName, now);
    resolving.delete(designId);
    resolved.set(designId, next);
    return next;
  };

  for (const designId of Object.keys(designs)) resolveDesign(designId);

  let changed = false;
  const nextDesigns: Record<string, SequenceDesign> = {};
  for (const [designId, original] of Object.entries(designs)) {
    const next = resolved.get(designId) ?? original;
    nextDesigns[designId] = next;
    if (next !== original) changed = true;
  }
  return changed ? nextDesigns : designs;
}

function resolveOneDesign(
  design: SequenceDesign,
  allDesigns: Record<string, SequenceDesign>,
  resolveDesign: (designId: string) => SequenceDesign,
  enzymeByName: ReadonlyMap<string, RestrictionEnzyme>,
  now: Date
): SequenceDesign {
  const factory = design.mocloFactory;
  const schema = design.goldenGateSchema;
  if (!factory || !schema || factory.stageInputs.length === 0) return design;
  design = normalizeAssemblySlots(design);

  const enzyme = enzymeByName.get(schema.enzyme);
  const nextRegions = [...design.regions];
  let changed = false;

  for (const input of factory.stageInputs) {
    const slotIndex = schema.slots.findIndex((slot) => slot.id === input.slotId);
    const regionIndex = nextRegions.findIndex((region) => region.schemaSlotId === input.slotId);
    const currentRegion = nextRegions[regionIndex];
    if (slotIndex < 0 || !currentRegion) continue;

    const source = selectSourceDesign({
      target: design,
      currentRegion,
      sourceStageId: input.sourceStageId,
      designs: allDesigns,
      resolveDesign,
    });
    const projected =
      source && enzyme
        ? projectCompatibleStageFragment({
            source,
            target: design,
            slotIndex,
            currentRegion,
            enzyme,
            factory,
            sourceStageId: input.sourceStageId,
          })
        : null;
    const nextRegion =
      projected ??
      unresolvedStageOutputOrExisting({
        currentRegion,
        target: design,
        sourceStageId: input.sourceStageId,
      });
    if (!sameRegion(currentRegion, nextRegion)) {
      nextRegions[regionIndex] = nextRegion;
      changed = true;
    }
  }

  if (!changed) return design;
  return {
    ...design,
    regions: nextRegions,
    version: design.version + 1,
    assemblyState: 'drafting',
    status: 'draft',
    validationErrors: [],
    assemblyResult: undefined,
    homologyRegions: [],
    designPrimers: [],
    goldenGateJunctions: [],
    assemblyWorkbench: design.assemblyWorkbench
      ? { ...design.assemblyWorkbench, primerEditIntents: [] }
      : undefined,
    updatedAt: now,
  };
}

function selectSourceDesign(input: {
  target: SequenceDesign;
  currentRegion: DesignRegion;
  sourceStageId: string;
  designs: Record<string, SequenceDesign>;
  resolveDesign: (designId: string) => SequenceDesign;
}): SequenceDesign | null {
  const targetFactory = input.target.mocloFactory;
  if (!targetFactory) return null;
  const candidates = Object.values(input.designs).filter((candidate) => {
    const factory = candidate.mocloFactory;
    return (
      candidate.id !== input.target.id &&
      factory?.runId === targetFactory.runId &&
      factory.kitId === targetFactory.kitId &&
      factory.kitRevision === targetFactory.kitRevision &&
      factory.recipeId === targetFactory.recipeId &&
      factory.stageId === input.sourceStageId
    );
  });
  const previouslyLinked = candidates.find(
    (candidate) =>
      input.currentRegion.mocloStageOutput?.status === 'live' &&
      candidate.id === input.currentRegion.mocloStageOutput.sourceDesignId
  );
  const selected = previouslyLinked ?? (candidates.length === 1 ? candidates[0] : null);
  return selected ? input.resolveDesign(selected.id) : null;
}

function projectCompatibleStageFragment(input: {
  source: SequenceDesign;
  target: SequenceDesign;
  slotIndex: number;
  currentRegion: DesignRegion;
  enzyme: RestrictionEnzyme;
  factory: MocloFactoryDesignContext;
  sourceStageId: string;
}): DesignRegion | null {
  const schema = input.target.goldenGateSchema;
  if (!schema) return null;
  const sourceSequence = getComposedSequenceForDesign(input.source);
  if (sourceSequence.length === 0) return null;

  const sourceAnnotations = flattenDesignAnnotations(input.source);
  const digest = computeVirtualDigest(
    sourceSequence,
    input.enzyme,
    sourceAnnotations.map((annotation) => ({
      name: annotation.name,
      start: annotation.start,
      end: annotation.end,
    })),
    { circular: input.source.topology === 'circular', maxFragments: 500 }
  );
  const compatible = digest.fragments.filter((fragment) =>
    fragmentFitsSlot(fragment, schema, input.slotIndex, input.target.topology)
  );
  const fragment = preserveOrSelectFragment(compatible, input.currentRegion);
  if (!fragment) return null;

  return {
    id: input.currentRegion.id,
    schemaSlotId: input.currentRegion.schemaSlotId,
    ...(input.currentRegion.colorIndex === undefined
      ? {}
      : { colorIndex: input.currentRegion.colorIndex }),
    ...fragmentToRegion({
      fragment,
      sourceSequence,
      sourceSequenceId: input.source.id,
      sourceSequenceName: input.source.name,
      overhangLength: digest.overhangLength,
      enzymeName: input.enzyme.name,
      sourceAnnotations,
      sourceIsCircular: input.source.topology === 'circular',
      allFragments: digest.fragments,
    }),
    isPlaceholder: false,
    mocloStageOutput: {
      status: 'live',
      runId: input.factory.runId,
      kitId: input.factory.kitId,
      kitRevision: input.factory.kitRevision,
      recipeId: input.factory.recipeId,
      sourceStageId: input.sourceStageId,
      sourceDesignId: input.source.id,
    },
  };
}

function fragmentFitsSlot(
  fragment: VirtualDigestFragment,
  schema: NonNullable<SequenceDesign['goldenGateSchema']>,
  slotIndex: number,
  topology: SequenceDesign['topology']
): boolean {
  if (fragment.ggType !== 'insert' && fragment.ggType !== 'backbone') return false;
  return (
    classifyGoldenGateCandidate(schema, slotIndex, topology, {
      id: `stage-output:${fragment.index}`,
      name: 'Prior stage output',
      route: 'restriction-digest',
      upstreamOverhang: fragment.upstream.sequence || null,
      downstreamOverhang: fragment.downstream.sequence || null,
      roleEvidence: [],
      kit: null,
    }).physical.type === 'exact'
  );
}

function preserveOrSelectFragment(
  candidates: readonly VirtualDigestFragment[],
  currentRegion: DesignRegion
): VirtualDigestFragment | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const prior = candidates.find(
    (fragment) =>
      fragment.startPosition === currentRegion.sourceStart &&
      (fragment.wrapsOrigin ? fragment.startPosition + fragment.length : fragment.endPosition) ===
        currentRegion.sourceEnd
  );
  return prior ?? null;
}

function flattenDesignAnnotations(design: SequenceDesign): DesignAnnotation[] {
  const annotations: DesignAnnotation[] = [];
  let offset = 0;
  for (const [regionIndex, region] of design.regions.entries()) {
    for (const annotation of region.annotations) {
      annotations.push({
        ...annotation,
        start: annotation.start + offset,
        end: annotation.end + offset,
      });
    }
    offset += region.sequence.length;
    offset +=
      design.spacers.find((spacer) => spacer.junctionIndex === regionIndex)?.sequence.length ?? 0;
  }
  return annotations;
}

function unresolvedStageOutputOrExisting(input: {
  currentRegion: DesignRegion;
  target: SequenceDesign;
  sourceStageId: string;
}): DesignRegion {
  if (
    !input.currentRegion.mocloStageOutput &&
    (!input.currentRegion.isPlaceholder || input.currentRegion.sequence.length > 0)
  ) {
    return input.currentRegion;
  }
  const factory = input.target.mocloFactory;
  if (!factory) return input.currentRegion;
  return {
    ...emptyDesignRegion(`Output from ${input.sourceStageId}`),
    id: input.currentRegion.id,
    schemaSlotId: input.currentRegion.schemaSlotId,
    ...(input.currentRegion.colorIndex === undefined
      ? {}
      : { colorIndex: input.currentRegion.colorIndex }),
    mocloStageOutput: {
      status: 'unresolved',
      runId: factory.runId,
      kitId: factory.kitId,
      kitRevision: factory.kitRevision,
      recipeId: factory.recipeId,
      sourceStageId: input.sourceStageId,
    },
  };
}

function sameRegion(left: DesignRegion, right: DesignRegion): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
