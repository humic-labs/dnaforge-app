import type {
  SequenceDesign,
  HomologyRegion,
  DesignPrimerPair,
  GoldenGateJunction,
} from '../types';
import { computeHomologyRegions } from './junctions';
import { computePrimers } from './gibson-primers';
import { computeGoldenGateJunctions, computeGoldenGatePrimers } from './golden-gate';
import { createTmCalculator, type TmCalculator, type TmModelResolution } from './tm-service';

function describeTmResolution(
  tm: TmCalculator
): TmModelResolution & { pendingNebVerification: boolean } {
  return { ...tm.resolution, pendingNebVerification: tm.resolution.model.kind === 'neb' };
}
import { getEffectiveDesignRegions } from '../restriction-digest';
import { isPrimerDesignConstraints } from '../primer-design-constraints';

export { estimateTm, calculateGcContent, calculateTmNN, type TmOptions } from './tm-calculator';
export { createTmCalculator, LOCAL_TM_CALCULATOR, type TmCalculator } from './tm-service';
export { isPalindrome } from '../validation-constants';
export * from './utils';
export * from './junctions';
export * from './gibson-primers';
export * from './golden-gate';
export * from './recompute';

export interface DraftAssemblyResult {
  homologyRegions: HomologyRegion[];
  designPrimers: DesignPrimerPair[];

  goldenGateJunctions?: GoldenGateJunction[];

  tmResolution: TmModelResolution & { pendingNebVerification: boolean };
}

export function computeDraftAssembly(
  design: SequenceDesign,

  targetPcrTm?: number,

  tmCalculator?: TmCalculator
): DraftAssemblyResult {
  const { regions, topology, defaultHomologyLength, assemblyMethod, spacers } = design;
  const constraints = design.primerDesignConstraints;
  if (constraints !== undefined && !isPrimerDesignConstraints(constraints)) {
    throw new Error('Primer rules require a PCR target of 40–75°C and an overlap of 15–60 bp.');
  }
  const pcrTarget =
    constraints?.targetPcrTm ?? targetPcrTm ?? (assemblyMethod === 'goldengate' ? undefined : 60);

  const tm =
    tmCalculator ?? createTmCalculator({ reaction: { polymerase: design.pcrPolymerase ?? null } });

  if (regions.length < 2) {
    return { homologyRegions: [], designPrimers: [], tmResolution: describeTmResolution(tm) };
  }

  if (assemblyMethod === 'goldengate') {
    const enzyme = design.goldenGateConfig?.enzyme ?? 'BsaI';
    const goldenGateJunctions = computeGoldenGateJunctions(regions, topology, spacers, enzyme);
    const designPrimers = computeGoldenGatePrimers(
      regions,
      goldenGateJunctions,
      topology,
      enzyme,
      spacers,
      pcrTarget,
      tm
    );

    return {
      homologyRegions: [],
      designPrimers: preserveAuthoredPrimers(design, designPrimers),
      goldenGateJunctions,
      tmResolution: describeTmResolution(tm),
    };
  }

  const assemblyRegions = getEffectiveDesignRegions(design);
  const homologyRegions = computeHomologyRegions(
    assemblyRegions,
    topology,
    defaultHomologyLength,
    spacers,
    constraints?.overlapLength ?? defaultHomologyLength,
    assemblyRegions.find((region) => region.sourceSequenceId === design.backboneSequenceId)?.id ??
      (assemblyRegions.length === 2 ? assemblyRegions[0]?.id : undefined),
    constraints?.overlapLength !== undefined
  );
  const designPrimers = computePrimers(
    assemblyRegions,
    homologyRegions,
    topology,
    spacers,
    tm,
    pcrTarget
  );

  return {
    homologyRegions,
    designPrimers: preserveAuthoredPrimers(design, designPrimers),
    tmResolution: describeTmResolution(tm),
  };
}

function preserveAuthoredPrimers(
  design: SequenceDesign,
  next: DraftAssemblyResult['designPrimers']
): DraftAssemblyResult['designPrimers'] {
  const identities = new Map(
    (design.assemblyWorkbench?.primers ?? []).map((identity) => [identity.id, identity.regionId])
  );
  const previous = new Map(
    design.designPrimers
      .flatMap((pair) => [pair.forward, pair.reverse])
      .map(
        (primer) =>
          [
            `${identities.get(primer.id) ?? design.regions[primer.fragmentIndex]?.id}:${primer.direction}`,
            primer,
          ] as const
      )
  );
  const restore = (primer: DraftAssemblyResult['designPrimers'][number]['forward']) => {
    const authored = previous.get(
      `${design.regions[primer.fragmentIndex]?.id}:${primer.direction}`
    );
    if (authored?.manuallyEdited)
      return {
        ...authored,
        fragmentIndex: primer.fragmentIndex,
        junctionIndex: primer.junctionIndex,
      };
    return authored?.manuallyNamed
      ? { ...primer, name: authored.name, manuallyNamed: true }
      : primer;
  };
  return next.map((pair) => ({
    ...pair,
    forward: restore(pair.forward),
    reverse: restore(pair.reverse),
  }));
}
