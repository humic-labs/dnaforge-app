import type {
  StructureComplexMember,
  StructureMemberSelection,
  StructureScene,
  StructureSceneFocus,
  StructureSceneFocusRole,
} from '../types';

export function cloneStructureMemberSelection(
  selection: StructureMemberSelection
): StructureMemberSelection {
  return {
    ...(selection.providerIdentityKey
      ? { providerIdentityKey: selection.providerIdentityKey }
      : {}),
    ...(selection.pdbId ? { pdbId: selection.pdbId } : {}),
    ...(selection.accession ? { accession: selection.accession } : {}),
    ...(selection.entityIds ? { entityIds: [...selection.entityIds] } : {}),
    ...(selection.labelAsymIds ? { labelAsymIds: [...selection.labelAsymIds] } : {}),
    ...(selection.authAsymIds ? { authAsymIds: [...selection.authAsymIds] } : {}),
    ...(selection.chainIds ? { chainIds: [...selection.chainIds] } : {}),
    ...(selection.residueRanges
      ? {
          residueRanges: selection.residueRanges.map(
            ([start, end]) => [start, end] as [number, number]
          ),
        }
      : {}),
  };
}

export function activeFocusForStructureMember(
  member: StructureComplexMember,
  queryAnchorMemberId: string
): StructureSceneFocus {
  return {
    memberId: member.memberId,
    role: focusRoleForMember(member, queryAnchorMemberId),
    selection: cloneStructureMemberSelection(member.selection),
    mappingStatus: member.mappingStatus,
  };
}

export function focusStructureSceneMember(scene: StructureScene, memberId: string): StructureScene {
  const member = scene.members.find((candidate) => candidate.memberId === memberId);
  if (!member) return scene;

  return {
    ...scene,
    activeFocus: activeFocusForStructureMember(member, scene.queryAnchor.memberId),
  };
}

function focusRoleForMember(
  member: StructureComplexMember,
  queryAnchorMemberId: string
): StructureSceneFocusRole {
  if (member.memberId === queryAnchorMemberId || member.relationToAnchor === 'query') {
    return 'query_anchor';
  }
  if (member.kind === 'ligand' || member.kind === 'ion' || member.kind === 'water') {
    return 'ligand';
  }
  if (member.kind === 'dna' || member.kind === 'rna') {
    return 'nucleic_acid';
  }
  if (member.kind === 'protein') {
    return 'partner';
  }
  return 'external_context';
}
