import type {
  ChainSequence,
  Structure3dAttrs,
  StructureComplexMember,
  StructureMemberSelection,
} from '../types';
import { structureViewStateForScene } from './structureRenderModel';

export function shouldLoadFullPdbEntryForScene(attrs: {
  sourceId?: string;
  providerIdentityKey?: string;
  source?: string;
  pdbId?: string;
  pdbEntityId?: string;
  labelAsymIds?: readonly string[];
  authAsymIds?: readonly string[];
  scene?: Structure3dAttrs['scene'];
}): boolean {
  if (attrs.source !== 'pdb' || !attrs.pdbId) return false;
  if (attrs.scene?.sceneKind === 'complex') return true;
  return attrs.scene?.sceneKind === 'single_query' && hasScopedSelector(attrs);
}

export function fullPdbEntryIdentity(pdbId: string): string {
  return `RCSB:${pdbId.toUpperCase()}:ENTRY`;
}

export function promoteScopedPdbSceneFromChains(
  attrs: Structure3dAttrs,
  chains: ChainSequence[] | null
): Structure3dAttrs | null {
  if (attrs.source !== 'pdb' || !attrs.pdbId || !attrs.scene || !chains?.length) return null;
  if (attrs.scene.sceneKind !== 'single_query' || attrs.scene.members.length !== 1) return null;
  if (!hasScopedSelector(attrs)) return null;

  const queryMember = attrs.scene.members[0];
  const querySelection = attrs.scene.queryAnchor.targetSelection ?? queryMember.selection;
  const directlyMatchedQueryChains = chains.filter((chain) =>
    chainMatchesSelection(chain, querySelection)
  );
  const shouldExpandQueryToEntity = !selectionHasDirectChainScope(querySelection);
  const queryEntityIds = new Set(
    directlyMatchedQueryChains.map((chain) => chain.entityId).filter(Boolean)
  );
  const queryChains = shouldExpandQueryToEntity
    ? chains.filter(
        (chain) =>
          chainMatchesSelection(chain, querySelection) || queryEntityIds.has(chain.entityId)
      )
    : directlyMatchedQueryChains;
  if (queryChains.length === 0) return null;
  const queryChainKeys = new Set(queryChains.map(stableMemberKey));
  const contextChains = chains.filter((chain) => !queryChainKeys.has(stableMemberKey(chain)));
  if (contextChains.length === 0) return null;
  if (!hasNonQueryEntityContext(queryChains, contextChains)) return null;

  const fullEntryId = fullPdbEntryIdentity(attrs.pdbId);
  const enrichedQueryMember = enrichQueryMemberFromChains(queryMember, queryChains);
  const contextMembers = contextChains.map((chain) =>
    memberFromChain(attrs.pdbId!, fullEntryId, attrs.scene!.sceneId, chain)
  );

  const promoted: Structure3dAttrs = {
    ...attrs,
    scene: {
      ...attrs.scene,
      sceneKind: 'complex',
      primaryResourceId: fullEntryId,
      members: [enrichedQueryMember, ...contextMembers],
      layers: attrs.scene.layers.map((layer) =>
        layer.kind === 'model'
          ? {
              ...layer,
              id: layer.id.startsWith('layer:model:') ? `layer:model:${fullEntryId}` : layer.id,
              source: {
                ...layer.source,
                sourceId: fullEntryId,
                providerIdentityKey: fullEntryId,
                pdbId: attrs.pdbId,
              },
            }
          : layer
      ),
    },
  };

  return {
    ...promoted,
    view: structureViewStateForScene(promoted, {
      renderIntent:
        attrs.view?.renderIntent === 'preview' ||
        attrs.view?.activeRecipeId === 'query-in-complex-preview'
          ? 'preview'
          : 'loaded',
    }),
  };
}

function hasScopedSelector(attrs: {
  sourceId?: string;
  providerIdentityKey?: string;
  pdbEntityId?: string;
  labelAsymIds?: readonly string[];
  authAsymIds?: readonly string[];
  scene?: Structure3dAttrs['scene'];
}): boolean {
  const parsed =
    parseScopedRcsbSource(attrs.providerIdentityKey) ?? parseScopedRcsbSource(attrs.sourceId);
  const querySelection = attrs.scene?.queryAnchor.targetSelection;
  return Boolean(
    attrs.pdbEntityId ||
    attrs.labelAsymIds?.length ||
    attrs.authAsymIds?.length ||
    parsed?.pdbEntityId ||
    parsed?.labelAsymIds?.length ||
    parsed?.authAsymIds?.length ||
    hasSelectionScope(querySelection)
  );
}

function memberFromChain(
  pdbId: string,
  fullEntryId: string,
  sceneId: string,
  chain: ChainSequence
): StructureComplexMember {
  const authAsymId = chain.authAsymId ?? chain.baseChain ?? chain.chainId;
  const labelAsymId = chain.labelAsymId;
  const entityId = chain.entityId;
  const memberKey = stableMemberKey(chain);

  return {
    memberId: `member:${sceneId}:chain:${memberKey}`,
    kind: 'protein',
    displayName: chain.chainLabel || `Chain ${authAsymId}`,
    selection: {
      providerIdentityKey: fullEntryId,
      pdbId,
      ...(entityId ? { entityIds: [entityId] } : {}),
      ...(labelAsymId ? { labelAsymIds: [labelAsymId] } : {}),
      ...(authAsymId ? { authAsymIds: [authAsymId] } : {}),
      chainIds: [chain.chainId],
    },
    ...(entityId ? { pdbEntityId: entityId } : {}),
    ...(labelAsymId ? { labelAsymIds: [labelAsymId] } : {}),
    ...(authAsymId ? { authAsymIds: [authAsymId] } : {}),
    relationToAnchor: 'known_partner',
    mappingStatus: 'unmapped',
    mappingEvidence: [
      {
        kind: 'provider_xref',
        label: 'Additional chain in the loaded PDB complex',
        confidence: 'heuristic',
        source: fullEntryId,
      },
    ],
  };
}

function chainMatchesSelection(
  chain: ChainSequence,
  selection: StructureComplexMember['selection']
): boolean {
  const entityIds = new Set(selection.entityIds ?? []);
  const labelAsymIds = new Set(selection.labelAsymIds ?? []);
  const authAsymIds = new Set(selection.authAsymIds ?? []);
  const chainIds = new Set(selection.chainIds ?? []);
  const hasExplicitLabelScope = labelAsymIds.size > 0;
  const hasExplicitAuthScope = authAsymIds.size > 0;

  if (hasExplicitLabelScope && chain.labelAsymId && labelAsymIds.has(chain.labelAsymId)) {
    return true;
  }
  if (hasExplicitAuthScope) {
    const authCandidates = (
      chain.authAsymId ? [chain.authAsymId] : [chain.baseChain, chain.chainId]
    ).filter(Boolean);
    if (authCandidates.some((candidate) => authAsymIds.has(candidate!))) return true;
  }
  if (!hasExplicitLabelScope && !hasExplicitAuthScope && chainIds.size > 0) {
    const ambiguousChainCandidates = [
      chain.chainId,
      chain.labelAsymId,
      chain.authAsymId,
      chain.baseChain,
    ].filter(Boolean) as string[];
    if (ambiguousChainCandidates.some((candidate) => chainIds.has(candidate))) return true;
  }
  if (selectionHasDirectChainScope(selection)) return false;
  return entityIds.size > 0 && chain.entityId ? entityIds.has(chain.entityId) : false;
}

function stableMemberKey(chain: ChainSequence): string {
  return [chain.authAsymId, chain.labelAsymId, chain.entityId, chain.chainId, chain.operator]
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9_-]+/g, '-');
}

function enrichQueryMemberFromChains(
  member: StructureComplexMember,
  queryChains: readonly ChainSequence[]
): StructureComplexMember {
  if (queryChains.length === 0) return member;
  const entityIds = unique(queryChains.map((chain) => chain.entityId));
  const labelAsymIds = unique(queryChains.map((chain) => chain.labelAsymId));
  const authAsymIds = unique(queryChains.map((chain) => chain.authAsymId ?? chain.baseChain));
  const chainIds = unique(queryChains.map((chain) => chain.chainId));

  return {
    ...member,
    selection: {
      ...member.selection,
      entityIds: unique([...(member.selection.entityIds ?? []), ...entityIds]),
      labelAsymIds: unique([...(member.selection.labelAsymIds ?? []), ...labelAsymIds]),
      authAsymIds: unique([...(member.selection.authAsymIds ?? []), ...authAsymIds]),
      chainIds: unique([...(member.selection.chainIds ?? []), ...chainIds]),
    },
    ...(member.pdbEntityId || entityIds.length !== 1 ? {} : { pdbEntityId: entityIds[0] }),
    ...(member.labelAsymIds ? {} : { labelAsymIds }),
    ...(member.authAsymIds ? {} : { authAsymIds }),
  };
}

function hasNonQueryEntityContext(
  queryChains: readonly ChainSequence[],
  contextChains: readonly ChainSequence[]
): boolean {
  const queryEntityIds = new Set(queryChains.map((chain) => chain.entityId).filter(Boolean));
  if (queryEntityIds.size === 0) return true;
  return contextChains.some((chain) => !chain.entityId || !queryEntityIds.has(chain.entityId));
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(Boolean) as string[])];
}

function hasSelectionScope(selection: StructureMemberSelection | undefined): boolean {
  return Boolean(
    selection?.entityIds?.length ||
    selection?.labelAsymIds?.length ||
    selection?.authAsymIds?.length ||
    selection?.chainIds?.length
  );
}

function selectionHasDirectChainScope(selection: StructureMemberSelection | undefined): boolean {
  return Boolean(
    selection?.labelAsymIds?.length || selection?.authAsymIds?.length || selection?.chainIds?.length
  );
}

interface ScopedRcsbSource {
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
}

function parseScopedRcsbSource(sourceId: string | undefined): ScopedRcsbSource | null {
  if (!sourceId || !/^RCSB:/i.test(sourceId)) return null;
  const parts = sourceId.trim().split(':');
  if (parts.length < 3 || parts[0].toUpperCase() !== 'RCSB' || parts[2].toUpperCase() !== 'ENTRY') {
    return null;
  }
  if ((parts.length - 3) % 2 !== 0) return null;

  const scoped: ScopedRcsbSource = {};
  for (let index = 3; index + 1 < parts.length; index += 2) {
    const key = parts[index].toUpperCase();
    const value = parts[index + 1];
    if (key === 'ENTITY') scoped.pdbEntityId = value.toUpperCase();
    else if (key === 'LABEL_ASYM') scoped.labelAsymIds = value.split(',').filter(Boolean);
    else if (key === 'AUTH_ASYM') scoped.authAsymIds = value.split(',').filter(Boolean);
  }
  return scoped;
}
