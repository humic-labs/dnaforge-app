import type {
  AssemblyWorkbenchDesignState,
  AssemblyWorkbenchJunctionIdentity,
  AssemblyWorkbenchPrimerIdentity,
  DesignPrimerPair,
  SequenceDesign,
} from '../design/public/types';

export function ensureAssemblyWorkbenchIdentity(design: SequenceDesign): SequenceDesign {
  const assemblyWorkbench = reconcileAssemblyWorkbenchState(design);
  const designWithState: SequenceDesign = { ...design, assemblyWorkbench };
  return {
    ...designWithState,
    designPrimers: applyStablePrimerIds(designWithState, design.designPrimers),
  };
}

export function reconcileAssemblyWorkbenchState(
  design: SequenceDesign
): AssemblyWorkbenchDesignState {
  const existingJunctions = design.assemblyWorkbench?.junctions ?? [];
  const existingPrimers = design.assemblyWorkbench?.primers ?? [];
  const existingPrimerEditIntents = design.assemblyWorkbench?.primerEditIntents ?? [];
  const autoDraftPrimers = design.assemblyWorkbench?.autoDraftPrimers;
  const existingJunctionByPair = new Map(
    existingJunctions.map((junction) => [
      junctionPairKey(junction.leftRegionId, junction.rightRegionId),
      junction,
    ])
  );
  const existingPrimerByRegionDirection = new Map(
    existingPrimers.map((primer) => [primerKey(primer.regionId, primer.direction), primer])
  );

  const junctions: AssemblyWorkbenchJunctionIdentity[] = Array.from(
    { length: computeJunctionCount(design) },
    (_, slot) => {
      const regions = regionsForJunctionSlot(design, slot);
      const existing = existingJunctionByPair.get(
        junctionPairKey(regions.leftRegionId, regions.rightRegionId)
      );
      return {
        id:
          existing?.id ??
          stableId(
            'jxn',
            design.id,
            regions.leftRegionId ?? 'start',
            regions.rightRegionId ?? 'end'
          ),
        slot,
        leftRegionId: regions.leftRegionId,
        rightRegionId: regions.rightRegionId,
        createdAtVersion: existing?.createdAtVersion ?? design.version,
      };
    }
  );

  const primers: AssemblyWorkbenchPrimerIdentity[] = design.regions.flatMap((region) =>
    (['forward', 'reverse'] as const).map((direction) => {
      const existing = existingPrimerByRegionDirection.get(primerKey(region.id, direction));
      return {
        id: existing?.id ?? stableId('primer', design.id, region.id, direction),
        regionId: region.id,
        direction,
        createdAtVersion: existing?.createdAtVersion ?? design.version,
      };
    })
  );

  const validPrimerKeys = new Set(
    primers.map((primer) => primerKey(primer.regionId, primer.direction))
  );
  const primerEditIntents = existingPrimerEditIntents.filter((intent) =>
    validPrimerKeys.has(primerKey(intent.regionId, intent.direction))
  );

  return { junctions, primers, primerEditIntents, autoDraftPrimers };
}

export function applyStablePrimerIds(
  design: SequenceDesign,
  designPrimers: DesignPrimerPair[]
): DesignPrimerPair[] {
  const primerIds = new Map(
    (design.assemblyWorkbench?.primers ?? []).map((primer) => [
      primerKey(primer.regionId, primer.direction),
      primer.id,
    ])
  );

  return designPrimers.map((pair) => {
    const regionId = design.regions[pair.fragmentIndex]?.id;
    if (!regionId) return pair;

    const forwardId = primerIds.get(primerKey(regionId, 'forward'));
    const reverseId = primerIds.get(primerKey(regionId, 'reverse'));
    return {
      ...pair,
      forward: forwardId ? { ...pair.forward, id: forwardId } : pair.forward,
      reverse: reverseId ? { ...pair.reverse, id: reverseId } : pair.reverse,
    };
  });
}

export function getJunctionIdentity(
  design: SequenceDesign,
  input: { junctionId?: string | null; junctionIndex?: number | null }
): AssemblyWorkbenchJunctionIdentity | null {
  const normalized = ensureAssemblyWorkbenchIdentity(design);
  const junctions = normalized.assemblyWorkbench?.junctions ?? [];
  if (input.junctionId) {
    return junctions.find((junction) => junction.id === input.junctionId) ?? null;
  }
  if (typeof input.junctionIndex === 'number') {
    return junctions.find((junction) => junction.slot === input.junctionIndex) ?? null;
  }
  return null;
}

export function getPrimerIdentity(
  design: SequenceDesign,
  input: {
    primerId?: string;
    fragmentIndex?: number;
    direction?: 'forward' | 'reverse';
  }
): AssemblyWorkbenchPrimerIdentity | null {
  const normalized = ensureAssemblyWorkbenchIdentity(design);
  const primers = normalized.assemblyWorkbench?.primers ?? [];
  if (input.primerId) {
    return primers.find((primer) => primer.id === input.primerId) ?? null;
  }
  if (typeof input.fragmentIndex === 'number' && input.direction) {
    const regionId = normalized.regions[input.fragmentIndex]?.id;
    if (!regionId) return null;
    return (
      primers.find(
        (primer) => primer.regionId === regionId && primer.direction === input.direction
      ) ?? null
    );
  }
  return null;
}

export function computeJunctionCount(design: SequenceDesign): number {
  if (design.regions.length < 2) return 0;
  return design.topology === 'circular' ? design.regions.length : design.regions.length - 1;
}

function regionsForJunctionSlot(
  design: SequenceDesign,
  slot: number
): { leftRegionId: string | null; rightRegionId: string | null } {
  const left = design.regions[slot] ?? null;
  const right = design.regions[(slot + 1) % design.regions.length] ?? null;
  if (design.topology === 'linear' && slot >= design.regions.length - 1) {
    return { leftRegionId: left?.id ?? null, rightRegionId: null };
  }
  return { leftRegionId: left?.id ?? null, rightRegionId: right?.id ?? null };
}

function primerKey(regionId: string, direction: 'forward' | 'reverse'): string {
  return `${regionId}:${direction}`;
}

function junctionPairKey(leftRegionId: string | null, rightRegionId: string | null): string {
  return `${leftRegionId ?? 'start'}>${rightRegionId ?? 'end'}`;
}

function stableId(...parts: string[]): string {
  return parts.map((part) => part.replace(/[^a-zA-Z0-9_-]/g, '_')).join(':');
}
