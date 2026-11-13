import type {
  ChainSequence,
  StructureComplexMember,
  StructureMemberSelection,
  StructureScene,
  StructureViewState,
} from '../types';

export function defaultDetailMemberIds(scene: StructureScene | undefined): string[] {
  return scene?.queryAnchor.memberId ? [scene.queryAnchor.memberId] : [];
}

export function effectiveDetailMemberIds(
  scene: StructureScene | undefined,
  view: StructureViewState | undefined
): string[] {
  return view?.detailMemberIds === undefined
    ? defaultDetailMemberIds(scene)
    : sanitizeDetailIds(view.detailMemberIds);
}

export function setDetailMemberVisibility(
  view: StructureViewState,
  scene: StructureScene | undefined,
  memberId: string,
  visible: boolean
): StructureViewState {
  if (!isValidDetailId(memberId)) return sanitizeStructureViewDetailIds(view);
  const detailIds = new Set(effectiveDetailMemberIds(scene, view));
  if (visible) detailIds.add(memberId);
  else detailIds.delete(memberId);
  return {
    ...view,
    detailMemberIds: [...detailIds],
  };
}

export function effectiveDetailChainInstanceIds(
  view: StructureViewState | undefined
): string[] | undefined {
  return view?.detailChainInstanceIds === undefined
    ? undefined
    : sanitizeDetailIds(view.detailChainInstanceIds);
}

export function setDetailChainInstanceVisibility(
  view: StructureViewState,
  chainInstanceId: string,
  visible: boolean,
  currentVisibleChainInstanceIds: readonly string[]
): StructureViewState {
  if (!isValidDetailId(chainInstanceId)) return sanitizeStructureViewDetailIds(view);
  const detailIds = new Set(
    sanitizeDetailIds(view.detailChainInstanceIds ?? currentVisibleChainInstanceIds)
  );
  if (visible) detailIds.add(chainInstanceId);
  else detailIds.delete(chainInstanceId);
  return {
    ...view,
    detailChainInstanceIds: [...detailIds],
  };
}

export function isChainInDetailedMembers(input: {
  chain: ChainSequence;
  scene?: StructureScene;
  view?: StructureViewState;
}): boolean {
  const scene = input.scene;
  if (!scene) return true;
  const detailIds = new Set(effectiveDetailMemberIds(scene, input.view));
  if (detailIds.size === 0) return false;
  return scene.members.some(
    (member) => detailIds.has(member.memberId) && chainMatchesMember(input.chain, member)
  );
}

export function detailMemberForChain(
  chain: ChainSequence,
  scene: StructureScene | undefined
): StructureScene['members'][number] | undefined {
  if (!scene) return undefined;
  return scene.members.find(
    (member) => member.kind !== 'water' && chainMatchesMember(chain, member)
  );
}

export function chainMatchesMember(
  chain: ChainSequence,
  member: StructureScene['members'][number]
): boolean {
  return chainMatchesSelection(chain, member.selection, member);
}

export function orderChainsForStructureTable(
  chains: readonly ChainSequence[],
  scene: StructureScene | undefined
): ChainSequence[] {
  if (!scene) return [...chains];

  const queryMember = scene.members.find(
    (member) => member.memberId === scene.queryAnchor.memberId
  );
  const activeFocusMember =
    scene.activeFocus && scene.activeFocus.memberId !== scene.queryAnchor.memberId
      ? scene.members.find((member) => member.memberId === scene.activeFocus?.memberId)
      : undefined;

  return [...chains].sort((left, right) => {
    const leftRank = chainTableRank(left, scene, queryMember, activeFocusMember);
    const rightRank = chainTableRank(right, scene, queryMember, activeFocusMember);
    return leftRank - rightRank || chains.indexOf(left) - chains.indexOf(right);
  });
}

function chainTableRank(
  chain: ChainSequence,
  scene: StructureScene,
  queryMember: StructureComplexMember | undefined,
  activeFocusMember: StructureComplexMember | undefined
): number {
  const targetRank = chainSelectionMatchRank(chain, scene.queryAnchor.targetSelection);
  if (targetRank === 0) return 0;
  if (targetRank === 1) return 1;
  if (chainMatchesQueryEntity(chain, scene, queryMember)) return 1;
  if (queryMember && chainMatchesMember(chain, queryMember)) return 2;
  if (activeFocusMember && chainMatchesMember(chain, activeFocusMember)) return 3;
  return 4;
}

function chainMatchesQueryEntity(
  chain: ChainSequence,
  scene: StructureScene,
  queryMember: StructureComplexMember | undefined
): boolean {
  if (!chain.entityId) return false;
  const queryEntityIds = new Set([
    ...(scene.queryAnchor.targetSelection.entityIds ?? []),
    ...(queryMember?.selection.entityIds ?? []),
    ...(queryMember?.pdbEntityId ? [queryMember.pdbEntityId] : []),
  ]);
  return queryEntityIds.has(chain.entityId);
}

function chainMatchesSelection(
  chain: ChainSequence,
  selection: StructureMemberSelection,
  member?: StructureComplexMember
): boolean {
  return chainSelectionMatchRank(chain, selection, member) < 2;
}

function chainSelectionMatchRank(
  chain: ChainSequence,
  selection: StructureMemberSelection,
  member?: StructureComplexMember
): 0 | 1 | 2 {
  const entityIds = new Set(
    selection.entityIds ?? (member?.pdbEntityId ? [member.pdbEntityId] : [])
  );
  const labelAsymIds = new Set(selection.labelAsymIds ?? member?.labelAsymIds ?? []);
  const authAsymIds = new Set(selection.authAsymIds ?? member?.authAsymIds ?? []);
  const chainIds = new Set(selection.chainIds ?? []);
  const hasExplicitLabelScope = labelAsymIds.size > 0;
  const hasExplicitAuthScope = authAsymIds.size > 0;

  if (hasExplicitLabelScope) {
    const labelCandidates = chain.labelAsymId ? [chain.labelAsymId] : [chain.chainId];
    if (labelCandidates.some((candidate) => labelAsymIds.has(candidate))) return 0;
  }
  if (hasExplicitAuthScope) {
    const authCandidates = chain.authAsymId ? [chain.authAsymId] : [chain.baseChain, chain.chainId];
    if (authCandidates.some((candidate) => candidate && authAsymIds.has(candidate))) return 0;
  }
  if (!hasExplicitLabelScope && !hasExplicitAuthScope && chainIds.size > 0) {
    const ambiguousChainCandidates = [
      chain.chainId,
      chain.labelAsymId,
      chain.authAsymId,
      chain.baseChain,
    ].filter(Boolean) as string[];
    if (ambiguousChainCandidates.some((candidate) => chainIds.has(candidate))) return 0;
  }
  if (chainIds.size > 0 || labelAsymIds.size > 0 || authAsymIds.size > 0) return 2;
  if (entityIds.size > 0 && chain.entityId && entityIds.has(chain.entityId)) return 1;
  return 2;
}

function sanitizeDetailIds(ids: readonly unknown[] | undefined): string[] {
  if (!ids) return [];
  return ids.filter(isValidDetailId);
}

function isValidDetailId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sanitizeStructureViewDetailIds(view: StructureViewState): StructureViewState {
  const detailMemberIds =
    view.detailMemberIds === undefined ? undefined : sanitizeDetailIds(view.detailMemberIds);
  const detailChainInstanceIds =
    view.detailChainInstanceIds === undefined
      ? undefined
      : sanitizeDetailIds(view.detailChainInstanceIds);
  return {
    ...view,
    ...(detailMemberIds === undefined ? {} : { detailMemberIds }),
    ...(detailChainInstanceIds === undefined ? {} : { detailChainInstanceIds }),
  };
}
