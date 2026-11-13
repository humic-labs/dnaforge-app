import {
  hasCompleteMolecularResidueIdentities,
  resolvedStructureComponentId,
} from '../../../shared/structure-selection-identity';
export { resolvedStructureComponentId } from '../../../shared/structure-selection-identity';
import type { ResidueLocation } from '../../page/public/embeds/structure3d/types';
import { AMINO_ACID_NAMES } from '@waypoint/sequence-utils';
import { untrustedField } from './sanitize';
import type {
  StructureDescriptorInput,
  StructureResidueIdentity,
  StructureResidueObject,
  StructureResidueRegion,
  StructureResidueSelection,
  StructureSelectionDescriptor,
} from './types';

const STRUCTURE_LABEL_CAP = 200;
export const STRUCTURE_RESIDUE_IDENTITY_CAP = 200;
const THREE_TO_ONE_AMINO_ACID = new Map(
  Object.entries(AMINO_ACID_NAMES)
    .filter(([oneLetter]) => oneLetter !== '*' && oneLetter !== 'X')
    .map(([oneLetter, threeLetter]) => [threeLetter.toUpperCase(), oneLetter] as const)
);

function residueScopeKey(residue: ResidueLocation): string {
  return JSON.stringify([
    residue.chain,
    residue.compId ?? null,
    residue.baseChain ?? null,
    residue.labelAsymId ?? null,
    residue.authAsymId ?? null,
    residue.entityId ?? null,
    residue.operator ?? null,
  ]);
}

function rangesFromPositions(positions: readonly number[]): StructureResidueRegion[] {
  const sorted = Array.from(new Set(positions)).sort((left, right) => left - right);
  const regions: StructureResidueRegion[] = [];
  for (const position of sorted) {
    const current = regions[regions.length - 1];
    if (current && position === current.end + 1) {
      current.end = position;
    } else {
      regions.push({ start: position, end: position });
    }
  }
  return regions;
}

function compareResidues(
  left: Pick<
    StructureResidueObject,
    'chain' | 'authSeqId' | 'labelCompId' | 'authAsymId' | 'labelAsymId' | 'operator'
  >,
  right: Pick<
    StructureResidueObject,
    'chain' | 'authSeqId' | 'labelCompId' | 'authAsymId' | 'labelAsymId' | 'operator'
  >
): number {
  return (
    left.chain.localeCompare(right.chain) ||
    (left.authAsymId ?? '').localeCompare(right.authAsymId ?? '') ||
    (left.labelAsymId ?? '').localeCompare(right.labelAsymId ?? '') ||
    (left.operator ?? '').localeCompare(right.operator ?? '') ||
    left.authSeqId - right.authSeqId ||
    (left.labelCompId ?? '').localeCompare(right.labelCompId ?? '')
  );
}

function boundedResidueObjects(residues: ReadonlyArray<ResidueLocation>): {
  residues: StructureResidueObject[];
  identities: StructureResidueIdentity[];
  knownCount: number;
  unknownCount: number;
  identityOmittedCount: number;
  residueOmittedCount: number;
} {
  const objects = new Map<string, StructureResidueObject>();
  for (const residue of residues) {
    if (!Number.isInteger(residue.position) || residue.position < 1 || !residue.chain) continue;
    const coordinateKey = residueScopeKey(residue) + `:${residue.position}`;
    const normalizedLabelCompId = resolvedStructureComponentId(
      residue.labelCompId ?? residue.compId
    );
    const object: StructureResidueObject = {
      chain: residue.chain,
      authSeqId: residue.position,
      labelCompId: normalizedLabelCompId,
      oneLetterCode: normalizedLabelCompId
        ? (THREE_TO_ONE_AMINO_ACID.get(normalizedLabelCompId) ?? null)
        : null,
      identityStatus: normalizedLabelCompId ? 'known' : 'unknown',
      ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
      ...(residue.baseChain ? { baseChain: residue.baseChain } : {}),
      ...(residue.labelAsymId ? { labelAsymId: residue.labelAsymId } : {}),
      ...(residue.authAsymId ? { authAsymId: residue.authAsymId } : {}),
      ...(residue.entityId ? { entityId: residue.entityId } : {}),
      ...(residue.operator ? { operator: residue.operator } : {}),
    };
    const existing = objects.get(coordinateKey);
    if (!existing || (existing.identityStatus === 'unknown' && object.identityStatus === 'known')) {
      objects.set(coordinateKey, object);
    }
  }

  const allResidues = [...objects.values()].sort(compareResidues);
  const allIdentities: StructureResidueIdentity[] = allResidues.flatMap((residue) =>
    residue.identityStatus === 'known' && residue.labelCompId
      ? [
          {
            chain: residue.chain,
            authSeqId: residue.authSeqId,
            labelCompId: residue.labelCompId,
            ...(residue.oneLetterCode ? { oneLetterCode: residue.oneLetterCode } : {}),
            ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
            ...(residue.baseChain ? { baseChain: residue.baseChain } : {}),
            ...(residue.labelAsymId ? { labelAsymId: residue.labelAsymId } : {}),
            ...(residue.authAsymId ? { authAsymId: residue.authAsymId } : {}),
            ...(residue.entityId ? { entityId: residue.entityId } : {}),
            ...(residue.operator ? { operator: residue.operator } : {}),
          },
        ]
      : []
  );
  const knownCount = allIdentities.length;
  return {
    residues: allResidues.slice(0, STRUCTURE_RESIDUE_IDENTITY_CAP),
    identities: allIdentities.slice(0, STRUCTURE_RESIDUE_IDENTITY_CAP),
    knownCount,
    unknownCount: allResidues.length - knownCount,
    identityOmittedCount: Math.max(0, knownCount - STRUCTURE_RESIDUE_IDENTITY_CAP),
    residueOmittedCount: Math.max(0, allResidues.length - STRUCTURE_RESIDUE_IDENTITY_CAP),
  };
}

export function structureSelectionsFromResidues(
  residues: ReadonlyArray<ResidueLocation>
): StructureResidueSelection[] {
  const groups = new Map<
    string,
    { scope: Omit<StructureResidueSelection, 'regions'>; positions: number[] }
  >();

  for (const residue of residues) {
    if (!Number.isInteger(residue.position) || residue.position < 1 || !residue.chain) continue;
    const key = residueScopeKey(residue);
    const existing = groups.get(key);
    if (existing) {
      existing.positions.push(residue.position);
      continue;
    }
    groups.set(key, {
      scope: {
        chain: residue.chain,
        ...(residue.compId ? { compId: residue.compId } : {}),
        ...(residue.baseChain ? { baseChain: residue.baseChain } : {}),
        ...(residue.labelAsymId ? { labelAsymId: residue.labelAsymId } : {}),
        ...(residue.authAsymId ? { authAsymId: residue.authAsymId } : {}),
        ...(residue.entityId ? { entityId: residue.entityId } : {}),
        ...(residue.operator ? { operator: residue.operator } : {}),
      },
      positions: [residue.position],
    });
  }

  return Array.from(groups.values()).map(({ scope, positions }) => ({
    ...scope,
    regions: rangesFromPositions(positions),
  }));
}

export function buildStructureSelectionDescriptor(
  input: StructureDescriptorInput
): StructureSelectionDescriptor | null {
  const selections = structureSelectionsFromResidues(input.residues);
  if (selections.length === 0) return null;
  const residueCount = selections.reduce(
    (count, selection) =>
      count +
      selection.regions.reduce((subtotal, region) => subtotal + region.end - region.start + 1, 0),
    0
  );
  const regionCount = selections.reduce((count, selection) => count + selection.regions.length, 0);
  const residueIdentity = boundedResidueObjects(input.residues);
  const structureLabel = untrustedField(input.label, STRUCTURE_LABEL_CAP);

  return {
    schemaVersion: 2,
    kind: 'structure',
    label: input.label,
    locator: { path: input.path },
    coordinateSystem: 'auth_seq_id-1-indexed-inclusive',
    sourceVersion: 0,
    measured: {
      structureRef: input.path,
      residueCount,
      regionCount,
      disjoint: regionCount > 1,
      selections,
      residues: residueIdentity.residues,
      residueOmittedCount: residueIdentity.residueOmittedCount,
      residueIdentities: residueIdentity.identities,
      residueIdentityKnownCount: residueIdentity.knownCount,
      residueIdentityUnknownCount: residueIdentity.unknownCount,
      residueIdentityOmittedCount: residueIdentity.identityOmittedCount,
      visibleRepresentations: input.visibleRepresentations,
      ...(input.linkedCodingDna ? { linkedCodingDna: input.linkedCodingDna } : {}),
      ...(input.savedSelectionRef ? { savedSelectionRef: input.savedSelectionRef } : {}),
    },
    fileText: structureLabel ? { structureLabel } : {},
    bases: 'never',
    fetch: { tools: [] },
  };
}

export function hasCompleteStructureResidueIdentities(
  descriptor: unknown
): descriptor is StructureSelectionDescriptor {
  return hasCompleteMolecularResidueIdentities(descriptor);
}
