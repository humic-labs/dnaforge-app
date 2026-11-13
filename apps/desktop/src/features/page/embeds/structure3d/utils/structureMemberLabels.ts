import type { ChainSequence, StructureComplexMember } from '../types';
import { getDisplayChainId } from '../types';

export function structureMemberDisplayLabel(member: StructureComplexMember): string {
  return member.identifiers?.geneNames?.[0] ?? member.displayName;
}

export function structureMemberDisplayLabelForChain(
  member: StructureComplexMember,
  chain: ChainSequence
): string {
  const label = structureMemberDisplayLabel(member);
  if (/^Chain\s+\S+$/i.test(label)) {
    return `Chain ${getDisplayChainId(chain)}`;
  }
  return label;
}

export function structureMemberChainBadges(member: StructureComplexMember): string[] {
  const badges: string[] = [];
  const authAsymIds = uniqueTokens(member.selection.authAsymIds ?? member.authAsymIds);
  const labelAsymIds = uniqueTokens(member.selection.labelAsymIds ?? member.labelAsymIds);
  const chainIds = uniqueTokens(member.selection.chainIds);
  const entityIds = uniqueTokens(
    member.selection.entityIds ?? (member.pdbEntityId ? [member.pdbEntityId] : undefined)
  );

  if (authAsymIds.length > 0) badges.push(`auth ${authAsymIds.join(', ')}`);
  if (labelAsymIds.length > 0 && !sameTokenSet(labelAsymIds, authAsymIds)) {
    badges.push(`label ${labelAsymIds.join(', ')}`);
  }
  if (
    chainIds.length > 0 &&
    !sameTokenSet(chainIds, authAsymIds) &&
    !sameTokenSet(chainIds, labelAsymIds)
  ) {
    badges.push(`chain ${chainIds.join(', ')}`);
  }
  if (entityIds.length > 0) badges.push(`entity ${entityIds.join(', ')}`);

  return badges;
}

export function structureMemberChainBadgesForChain(
  member: StructureComplexMember,
  chain: ChainSequence
): string[] {
  const badges: string[] = [];
  const authAsymIds = uniqueTokens(
    chain.authAsymId ? [chain.authAsymId] : (member.selection.authAsymIds ?? member.authAsymIds)
  );
  const labelAsymIds = uniqueTokens(
    chain.labelAsymId ? [chain.labelAsymId] : (member.selection.labelAsymIds ?? member.labelAsymIds)
  );
  const chainIds = uniqueTokens(chain.chainId ? [chain.chainId] : member.selection.chainIds);
  const entityIds = uniqueTokens(
    chain.entityId
      ? [chain.entityId]
      : (member.selection.entityIds ?? (member.pdbEntityId ? [member.pdbEntityId] : undefined))
  );

  if (authAsymIds.length > 0) badges.push(`auth ${authAsymIds.join(', ')}`);
  if (labelAsymIds.length > 0 && !sameTokenSet(labelAsymIds, authAsymIds)) {
    badges.push(`label ${labelAsymIds.join(', ')}`);
  }
  if (
    chainIds.length > 0 &&
    !sameTokenSet(chainIds, authAsymIds) &&
    !sameTokenSet(chainIds, labelAsymIds)
  ) {
    badges.push(`chain ${chainIds.join(', ')}`);
  }
  if (entityIds.length > 0) badges.push(`entity ${entityIds.join(', ')}`);

  return badges;
}

export function structureMemberOptionLabel(member: StructureComplexMember): string {
  const badges = structureMemberChainBadges(member);
  return badges.length > 0
    ? `${structureMemberDisplayLabel(member)} | ${badges.join(' | ')}`
    : structureMemberDisplayLabel(member);
}

export function structureMemberRoleLabel(
  member: StructureComplexMember,
  queryAnchorMemberId?: string
): string {
  if (member.memberId === queryAnchorMemberId || member.relationToAnchor === 'query') {
    return 'Query';
  }
  if (member.relationToAnchor === 'known_partner' || member.relationToAnchor === 'same_complex') {
    return 'Partner';
  }
  if (member.mappingStatus === 'external_only') return 'External';
  if (member.mappingStatus === 'unmapped') return 'Unmapped';
  return member.kind;
}

export function stableMemberTestId(memberId: string): string {
  return memberId.replace(/[^A-Za-z0-9_-]+/g, '-');
}

function uniqueTokens(values: readonly string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameTokenSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
