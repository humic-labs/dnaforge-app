import type { ChainSequence, Structure3dAttrs, StructureMemberSelection } from '../types';
import type { StructureLinkResidueTarget } from '../../../../structure-drawer/public/state/use-structure-link-registry';
import { chainMatchesScopes } from './structureScope';

import {
  mapChainResiduesToExpectedSequence,
  normalizeResidueSequence,
} from '../../../../../shared/polymer-residue-mapping';
export { mapChainResiduesToExpectedSequence } from '../../../../../shared/polymer-residue-mapping';
export type {
  ChainResidueMappingResult,
  ChainResidueMappingUnavailableReason,
} from '../../../../../shared/polymer-residue-mapping';

export function residueTargetsFromExtractedQueryChains(
  attrs: Structure3dAttrs,
  chains: readonly ChainSequence[],
  expectedResidueSequence?: string
): StructureLinkResidueTarget[] {
  const selectedChains = selectExtractedQueryChainsForStructure(attrs, chains);

  const targets: StructureLinkResidueTarget[] = [];
  const seen = new Set<string>();
  for (const chain of selectedChains) {
    const target = residueTargetFromChain(chain, expectedResidueSequence);
    if (attrs.comparisonProvenance) {
      target.residues = chain.residues.flatMap((residue) => {
        if (residue.labelSeqId === undefined) return [];
        const position = residue.labelSeqId - 1;
        const residueIndex =
          chain.labelAsymId === 'R'
            ? position
            : chain.labelAsymId === 'V'
              ? attrs.comparisonProvenance!.allele.alternateToReference[position]
              : null;
        return residueIndex == null
          ? []
          : [{ residueIndex, position: residue.position, labelSeqId: residue.labelSeqId }];
      });
    }
    const key = [
      target.chain,
      target.baseChain ?? '',
      target.labelAsymId ?? '',
      target.authAsymId ?? '',
      target.entityId ?? '',
      target.operator ?? '',
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

export function selectExtractedQueryChainsForStructure(
  attrs: Structure3dAttrs,
  chains: readonly ChainSequence[]
): ChainSequence[] {
  if (!attrs.comparisonProvenance)
    chains = chains.filter((chain) => chain.isPrimarySource !== false);
  const explicitQuerySelection =
    attrs.scene?.queryAnchor.targetSelection ??
    attrs.scene?.members.find((member) => member.memberId === attrs.scene?.queryAnchor.memberId)
      ?.selection;
  const attrSelection = selectionFromStructureAttrsForLinkTargets(attrs);
  const scopedExplicitQuerySelection = memberSelectionHasResidueScope(explicitQuerySelection)
    ? explicitQuerySelection
    : undefined;
  const scopedAttrSelection = memberSelectionHasResidueScope(attrSelection)
    ? attrSelection
    : undefined;
  const querySelection = scopedExplicitQuerySelection ?? scopedAttrSelection;
  const queryChains = querySelection
    ? chains.filter((chain) => chainMatchesMemberSelection(chain, querySelection))
    : [];
  const selectedChains =
    queryChains.length > 0
      ? queryChains
      : scopedExplicitQuerySelection
        ? []
        : attrs.scene?.sceneKind === 'complex'
          ? []
          : chains.filter((chain) => chainMatchesScopes(chain, attrs));

  return selectedChains;
}

function residueTargetFromChain(
  chain: ChainSequence,
  expectedResidueSequence?: string
): StructureLinkResidueTarget {
  const baseChain = chain.labelAsymId ?? chain.baseChain ?? chain.chainId;
  return {
    chain: chain.chainId,
    ...(baseChain ? { baseChain } : {}),
    ...(chain.labelAsymId ? { labelAsymId: chain.labelAsymId } : {}),
    ...(chain.authAsymId ? { authAsymId: chain.authAsymId } : {}),
    ...(chain.entityId ? { entityId: chain.entityId } : {}),
    ...(chain.operator ? { operator: chain.operator } : {}),
    residues: residuePositionMapForChain(chain, expectedResidueSequence),
  };
}

function residuePositionMapForChain(
  chain: ChainSequence,
  expectedResidueSequence?: string
): StructureLinkResidueTarget['residues'] {
  const expected = normalizeResidueSequence(expectedResidueSequence);
  if (expected) {
    const mapping = mapChainResiduesToExpectedSequence(chain, expected);
    return mapping.status === 'mapped' ? mapping.residues : [];
  }

  const residues = chain.residues
    .map((residue, chainIndex) => {
      const residueIndex = residue.sequenceIndex ?? chainIndex;
      if (residueIndex === null) return null;
      if (residueIndex < 0) return null;
      return {
        residueIndex,
        position: residue.position,
        ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
      };
    })
    .filter((entry): entry is { residueIndex: number; position: number } => entry !== null);

  return residues.length > 0 ? residues : undefined;
}

function selectionFromStructureAttrsForLinkTargets(
  attrs: Structure3dAttrs
): StructureMemberSelection {
  return {
    ...(attrs.pdbEntityId ? { entityIds: [attrs.pdbEntityId] } : {}),
    ...(attrs.labelAsymIds ? { labelAsymIds: attrs.labelAsymIds } : {}),
    ...(attrs.authAsymIds ? { authAsymIds: attrs.authAsymIds } : {}),
  };
}

function memberSelectionHasResidueScope(
  selection: StructureMemberSelection | undefined
): selection is StructureMemberSelection {
  return (
    (selection?.entityIds?.length ?? 0) > 0 ||
    (selection?.labelAsymIds?.length ?? 0) > 0 ||
    (selection?.authAsymIds?.length ?? 0) > 0 ||
    (selection?.chainIds?.length ?? 0) > 0
  );
}

function chainMatchesMemberSelection(
  chain: ChainSequence,
  selection: StructureMemberSelection | undefined
): boolean {
  if (!selection) return false;
  const entityIds = new Set(selection.entityIds ?? []);
  const labelAsymIds = new Set(selection.labelAsymIds ?? []);
  const authAsymIds = new Set(selection.authAsymIds ?? []);
  const chainIds = new Set(selection.chainIds ?? []);
  const hasLabelScope = labelAsymIds.size > 0;
  const hasAuthScope = authAsymIds.size > 0;

  if (hasLabelScope && chain.labelAsymId && labelAsymIds.has(chain.labelAsymId)) return true;
  if (hasAuthScope) {
    const authCandidates = (
      chain.authAsymId ? [chain.authAsymId] : [chain.baseChain, chain.chainId]
    ).filter(Boolean) as string[];
    if (authCandidates.some((candidate) => authAsymIds.has(candidate))) return true;
  }
  if (!hasLabelScope && !hasAuthScope && chainIds.size > 0) {
    const chainCandidates = [
      chain.chainId,
      chain.labelAsymId,
      chain.authAsymId,
      chain.baseChain,
    ].filter(Boolean) as string[];
    if (chainCandidates.some((candidate) => chainIds.has(candidate))) return true;
  }
  if (hasLabelScope || hasAuthScope || chainIds.size > 0) return false;
  return entityIds.size > 0 && !!chain.entityId && entityIds.has(chain.entityId);
}
