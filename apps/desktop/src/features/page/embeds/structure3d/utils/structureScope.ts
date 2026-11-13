import type {
  ChainSequence,
  HighlightGroup,
  LigandInfo,
  ResidueInteractionState,
  ResidueLocation,
  Structure3dAttrs,
} from '../types';

type ChainLike = {
  chain?: string;
  chainId?: string;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
};

export function canonicalScopeTokens(values: readonly string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function hasStructureScope(attrs: Structure3dAttrs | undefined): boolean {
  return (
    canonicalScopeTokens(attrs?.labelAsymIds).length > 0 ||
    canonicalScopeTokens(attrs?.authAsymIds).length > 0 ||
    !!attrs?.pdbEntityId ||
    !!attrs?.assemblyId
  );
}

export function structureScopeKey(attrs: Structure3dAttrs | undefined): string {
  return [
    ...(attrs?.labelAsymIds ?? []).slice().sort(),
    ...(attrs?.authAsymIds ?? []).slice().sort(),
    attrs?.pdbEntityId,
    attrs?.assemblyId,
  ]
    .filter(Boolean)
    .join('|');
}

export function chainMatchesScopes(item: ChainLike, attrs: Structure3dAttrs | undefined): boolean {
  if (isComplexScene(attrs)) return true;

  const labelScopes = canonicalScopeTokens(attrs?.labelAsymIds);
  const authScopes = canonicalScopeTokens(attrs?.authAsymIds);
  const entityScope = attrs?.pdbEntityId?.trim();
  if (labelScopes.length === 0 && authScopes.length === 0 && !entityScope) return true;

  const labelTokens = canonicalScopeTokens(
    (item.labelAsymId ? [item.labelAsymId] : [item.chainId, item.baseChain, item.chain]).filter(
      Boolean
    ) as string[]
  );
  const authTokens = canonicalScopeTokens(
    (item.authAsymId ? [item.authAsymId] : [item.baseChain, item.chain, item.chainId]).filter(
      Boolean
    ) as string[]
  );

  const labelOk =
    labelScopes.length === 0 || labelTokens.some((token) => labelScopes.includes(token));
  const authOk = authScopes.length === 0 || authTokens.some((token) => authScopes.includes(token));
  const entityOk = !entityScope || item.entityId === entityScope;
  return labelOk && authOk && entityOk;
}

export function scopedResidueOrNull(
  residue: ResidueLocation | null,
  attrs: Structure3dAttrs | undefined
): ResidueLocation | null {
  if (!residue) return null;
  return chainMatchesScopes(residue, attrs) ? residue : null;
}

export function filterInteractionStateForScopes(
  interactionState: ResidueInteractionState | undefined,
  attrs: Structure3dAttrs | undefined
): ResidueInteractionState {
  return {
    hovered: scopedResidueOrNull(interactionState?.hovered ?? null, attrs),
    selected: (interactionState?.selected ?? []).filter((residue) =>
      chainMatchesScopes(residue, attrs)
    ),
  };
}

export function filterSequenceDataForScopes(
  chains: ChainSequence[] | null,
  attrs: Structure3dAttrs | undefined
): ChainSequence[] | null {
  if (!chains) return null;
  if (isComplexScene(attrs)) return chains;
  if (!hasStructureScope(attrs)) return chains;
  return chains.filter((chain) => chainMatchesScopes(chain, attrs));
}

export function filterLigandsForScopes(
  ligands: LigandInfo[],
  attrs: Structure3dAttrs | undefined
): LigandInfo[] {
  if (isComplexScene(attrs)) return ligands;
  if (!hasStructureScope(attrs)) return ligands;
  return ligands.filter((ligand) => chainMatchesScopes(ligand, attrs));
}

export function filterHighlightGroupsForScopes(
  groups: readonly HighlightGroup[] | undefined,
  scopedChains: ChainSequence[] | null,
  attrs: Structure3dAttrs | undefined,
  scopedLigands: readonly LigandInfo[] = []
): HighlightGroup[] {
  const source = groups ?? [];
  if (isComplexScene(attrs)) return [...source];
  if (!hasStructureScope(attrs)) return [...source];
  const allowedChains = new Set<string>();
  const selectionChainByToken = new Map<string, string>();
  for (const chain of scopedChains ?? []) {
    const selectionChain = chain.labelAsymId ?? chain.baseChain ?? chain.chainId;
    for (const token of canonicalScopeTokens(
      [chain.chainId, chain.baseChain, chain.labelAsymId, chain.authAsymId].filter(
        Boolean
      ) as string[]
    )) {
      allowedChains.add(token);
      selectionChainByToken.set(token, selectionChain);
    }
  }
  for (const ligand of scopedLigands) {
    const selectionChain = ligand.labelAsymId ?? ligand.baseChain ?? ligand.chainId;
    for (const token of canonicalScopeTokens(
      [ligand.chainId, ligand.baseChain, ligand.labelAsymId, ligand.authAsymId].filter(
        Boolean
      ) as string[]
    )) {
      allowedChains.add(token);
      selectionChainByToken.set(token, selectionChain);
    }
  }
  if (allowedChains.size === 0) return [];

  return source
    .map((group) => ({
      ...group,
      selections: group.selections
        .filter((selection) => allowedChains.has(selection.chain))
        .map((selection) => ({
          ...selection,
          chain: selectionChainByToken.get(selection.chain) ?? selection.chain,
        })),
    }))
    .filter((group) => group.selections.length > 0);
}

function isComplexScene(attrs: Structure3dAttrs | undefined): boolean {
  return attrs?.scene?.sceneKind === 'complex' && (attrs.scene.members?.length ?? 0) > 1;
}
