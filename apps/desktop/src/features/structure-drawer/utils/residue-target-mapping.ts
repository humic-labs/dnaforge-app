import type {
  StructureLinkEntry,
  StructureLinkResidueTarget,
} from '../state/use-structure-link-registry';

export interface StructureResidueTargetLocation {
  chain: string;
  position: number;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  labelSeqId?: number;
  operator?: string;
}

type ResidueTargetLink = Pick<StructureLinkEntry, 'residueTarget' | 'residueTargets'>;

const DEFAULT_RESIDUE_TARGET: StructureLinkResidueTarget = { chain: 'A' };

export function structureResiduesForLinkedResidueIndex(
  link: ResidueTargetLink,
  residueIndex: number
): StructureResidueTargetLocation[] {
  if (residueIndex < 0) return [];

  const residues: StructureResidueTargetLocation[] = [];
  for (const target of residueTargetsForLink(link)) {
    const mappedResidue = target.residues?.find((entry) => entry.residueIndex === residueIndex);
    if (target.residues !== undefined && mappedResidue === undefined) {
      continue;
    }
    if (target.residues === undefined && !usesIdentityResidueMapping(target)) {
      continue;
    }

    residues.push({
      chain: target.chain,
      position: mappedResidue?.position ?? residueIndex + 1,
      ...(target.baseChain ? { baseChain: target.baseChain } : {}),
      ...(target.labelAsymId ? { labelAsymId: target.labelAsymId } : {}),
      ...(target.authAsymId ? { authAsymId: target.authAsymId } : {}),
      ...(target.entityId ? { entityId: target.entityId } : {}),
      ...(mappedResidue?.labelSeqId !== undefined ? { labelSeqId: mappedResidue.labelSeqId } : {}),
      ...(target.operator ? { operator: target.operator } : {}),
    });
  }
  return residues;
}

export function linkedResidueIndexForStructureResidue(
  link: ResidueTargetLink,
  residue: StructureResidueTargetLocation
): number | null {
  const target = targetForStructureResidue(link, residue);
  if (!target) return null;
  const mapped = mappedResiduePositionForStructureResidue(target, residue);
  if (target.residues !== undefined) return mapped?.residueIndex ?? null;
  if (!usesIdentityResidueMapping(target)) return null;
  const residueIndex = residue.position - 1;
  return residueIndex >= 0 ? residueIndex : null;
}

function residueTargetsForLink(link: ResidueTargetLink): StructureLinkResidueTarget[] {
  if (link.residueTargets?.length) return link.residueTargets;
  if (link.residueTarget) return [link.residueTarget];
  return [{ ...DEFAULT_RESIDUE_TARGET, residueMappingKind: 'identity' }];
}

function targetForStructureResidue(
  link: ResidueTargetLink,
  residue: StructureResidueTargetLocation
): StructureLinkResidueTarget | undefined {
  const targets = residueTargetsForLink(link);
  const exactTarget = targets.find((target) => structureTargetMatchesResidue(target, residue));
  if (exactTarget) return exactTarget;
  if (residueHasScope(residue)) return undefined;

  const chainPositionTargets = targets.filter(
    (target) =>
      target.chain === residue.chain &&
      target.residues?.some(
        (entry) =>
          entry.position === residue.position &&
          optionalNumericScopeMatches(entry.labelSeqId, residue.labelSeqId)
      )
  );
  return chainPositionTargets.length === 1 ? chainPositionTargets[0] : undefined;
}

function mappedResiduePositionForStructureResidue(
  target: StructureLinkResidueTarget,
  residue: StructureResidueTargetLocation
): NonNullable<StructureLinkResidueTarget['residues']>[number] | null {
  if (!target.residues) return null;
  const candidates = target.residues.filter(
    (entry) =>
      entry.position === residue.position &&
      optionalNumericScopeMatches(entry.labelSeqId, residue.labelSeqId)
  );
  if (residue.labelSeqId === undefined && candidates.length > 1) return null;
  return candidates[0] ?? null;
}

function structureTargetMatchesResidue(
  target: StructureLinkResidueTarget,
  residue: StructureResidueTargetLocation
): boolean {
  return (
    target.chain === residue.chain &&
    optionalScopeMatches(target.baseChain, residue.baseChain) &&
    optionalScopeMatches(target.labelAsymId, residue.labelAsymId) &&
    optionalScopeMatches(target.authAsymId, residue.authAsymId) &&
    optionalScopeMatches(target.entityId, residue.entityId) &&
    optionalScopeMatches(target.operator, residue.operator)
  );
}

function optionalScopeMatches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

function optionalNumericScopeMatches(
  expected: number | undefined,
  actual: number | undefined
): boolean {
  return expected === undefined || actual === undefined || expected === actual;
}

function residueHasScope(residue: StructureResidueTargetLocation): boolean {
  return (
    residue.baseChain !== undefined ||
    residue.labelAsymId !== undefined ||
    residue.authAsymId !== undefined ||
    residue.entityId !== undefined ||
    residue.labelSeqId !== undefined ||
    residue.operator !== undefined
  );
}

function usesIdentityResidueMapping(target: StructureLinkResidueTarget): boolean {
  return target.residueMappingKind === 'identity';
}
