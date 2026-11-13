import {
  createSavedResidueSelectionDocument,
  type ResidueInterval,
  type ResidueSelection,
  type ResidueSelectionStructureMapping,
  type SavedResidueSelectionDocument,
  type SavedResidueSelectionMember,
  type SavedSelectionStructureRevision,
} from '@waypoint/workspace-editor';
import type {
  ChainPolymerType,
  ChainSelection,
  ChainSequence,
  HighlightGroup,
  ResidueLocation,
  Structure3dAttrs,
  StructureMemberSelection,
} from '../types';
import { positionsToRanges } from './rangeUtils';
import { SAVED_SELECTION_HIGHLIGHT_COLOR } from './highlightUtils';

export interface BuildSavedSelectionDocumentFromStructureInput {
  assetId: string;
  revisionId: string;
  createdAt: string;
  group: HighlightGroup;
  attrs: Structure3dAttrs;
  chains: ReadonlyArray<ChainSequence>;
  structureId: string;
  structureRevision: SavedSelectionStructureRevision;
  sourceArtifactGitCommit?: string;
  actor?: { kind: 'user' | 'agent' | 'system'; id?: string };
}

export async function buildSavedSelectionDocumentFromStructure(
  input: BuildSavedSelectionDocumentFromStructureInput
): Promise<SavedResidueSelectionDocument> {
  const members: SavedResidueSelectionMember[] = [];
  for (let index = 0; index < input.group.selections.length; index += 1) {
    const selectedChain = input.group.selections[index];
    const chain = findPhysicalChain(input.chains, selectedChain);
    if (!chain) {
      throw new Error(`Cannot resolve selected physical chain ${selectedChain.chain}`);
    }
    const selectedResidues = mapAuthorRangesToPolymerResidues(chain, selectedChain);
    const selectedResidueIndices = selectedResidues.map(({ polymerIndex }) => polymerIndex);
    const targetIntervals = positionsToRanges(selectedResidueIndices).map(([start, end]) => ({
      start,
      end,
    }));
    const polymer = await polymerRevisionForChain(
      input.attrs,
      chain,
      input.sourceArtifactGitCommit
    );
    const structureMappings: ResidueSelectionStructureMapping[] = selectedChain.ranges.map(
      ([residueStart, residueEnd]) => ({
        kind: 'structure',
        structureId: input.structureId,
        chain: selectedChain.chain,
        position: residueStart,
        residueStart,
        residueEnd,
        ...(selectedChain.baseChain ? { baseChain: selectedChain.baseChain } : {}),
        ...(selectedChain.labelAsymId ? { labelAsymId: selectedChain.labelAsymId } : {}),
        ...(selectedChain.authAsymId ? { authAsymId: selectedChain.authAsymId } : {}),
        ...(selectedChain.entityId ? { entityId: selectedChain.entityId } : {}),
        ...(selectedChain.operator ? { operator: selectedChain.operator } : {}),
      })
    );
    const selection: ResidueSelection = {
      selectionId: input.assetId,
      source: {
        kind: 'structure',
        id: input.structureId,
        surface: 'molstar',
        label: input.group.label,
      },
      target: {
        moleculeId: polymer.moleculeId,
        moleculeKind: polymer.moleculeKind,
        coordinateSystem: 'residue',
        intervals: targetIntervals,
        label: chain.chainLabel,
      },
      mappings: structureMappings,
    };
    members.push({
      id: `${input.assetId}:member:${index + 1}`,
      selection,
      scope: {
        kind: 'structure-chain-instance',
        structureRevisionId: input.structureRevision.id,
        chain: {
          chain: selectedChain.chain,
          ...(selectedChain.baseChain ? { baseChain: selectedChain.baseChain } : {}),
          ...(selectedChain.labelAsymId ? { labelAsymId: selectedChain.labelAsymId } : {}),
          ...(selectedChain.authAsymId ? { authAsymId: selectedChain.authAsymId } : {}),
          ...(selectedChain.entityId ? { entityId: selectedChain.entityId } : {}),
          ...(selectedChain.operator ? { operator: selectedChain.operator } : {}),
        },
      },
      polymerRevision: polymer,
      residueIdentities: selectedResidues.map(({ polymerIndex, residue }) => ({
        polymerIndex,
        authSeqId: residue.position,
        ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
        labelCompId: residue.name3,
        oneLetterCode: residue.name,
      })),
    });
  }

  return createSavedResidueSelectionDocument({
    id: input.assetId,
    name: input.group.label,
    color: SAVED_SELECTION_HIGHLIGHT_COLOR,
    revisionId: input.revisionId,
    createdAt: input.createdAt,
    actor: input.actor ?? { kind: 'user' },
    members,
    structureRevisions: [input.structureRevision],
  });
}

export function residueLocationsForSavedSelectionRevision(
  document: SavedResidueSelectionDocument,
  revisionId: string
): ResidueLocation[] {
  const revision = document.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) throw new Error(`Saved selection revision is missing: ${revisionId}`);
  const residues: ResidueLocation[] = [];
  for (const member of revision.members) {
    if (member.scope.kind !== 'structure-chain-instance') continue;
    const chain = member.scope.chain;
    if (member.residueIdentities?.length) {
      residues.push(
        ...member.residueIdentities.map((identity) => ({
          chain: chain.chain,
          position: identity.authSeqId,
          labelCompId: identity.labelCompId,
          ...(identity.labelSeqId !== undefined ? { labelSeqId: identity.labelSeqId } : {}),
          ...(chain.baseChain ? { baseChain: chain.baseChain } : {}),
          ...(chain.labelAsymId ? { labelAsymId: chain.labelAsymId } : {}),
          ...(chain.authAsymId ? { authAsymId: chain.authAsymId } : {}),
          ...(chain.entityId ? { entityId: chain.entityId } : {}),
          ...(chain.operator ? { operator: chain.operator } : {}),
        }))
      );
      continue;
    }
    for (const mapping of member.selection.mappings ?? []) {
      if (mapping.kind !== 'structure') continue;
      for (let position = mapping.residueStart; position <= mapping.residueEnd; position += 1) {
        residues.push({
          chain: mapping.chain,
          position,
          ...(mapping.labelSeqId !== undefined ? { labelSeqId: mapping.labelSeqId } : {}),
          ...(mapping.baseChain ? { baseChain: mapping.baseChain } : {}),
          ...(mapping.labelAsymId ? { labelAsymId: mapping.labelAsymId } : {}),
          ...(mapping.authAsymId ? { authAsymId: mapping.authAsymId } : {}),
          ...(mapping.entityId ? { entityId: mapping.entityId } : {}),
          ...(mapping.operator ? { operator: mapping.operator } : {}),
        });
      }
    }
  }
  return residues;
}

export function projectSavedSelectionRevisionToHighlightGroup(
  document: SavedResidueSelectionDocument,
  revisionId: string,
  visible: boolean
): HighlightGroup {
  const revision = document.revisions.find((candidate) => candidate.id === revisionId);
  if (!revision) throw new Error(`Saved selection revision is missing: ${revisionId}`);

  const chains = new Map<string, ChainSelection & { positions: number[] }>();
  for (const member of revision.members) {
    if (member.scope.kind !== 'structure-chain-instance') continue;
    const chain = member.scope.chain;
    const key = JSON.stringify(chain);
    const current = chains.get(key) ?? { ...chain, positions: [], ranges: [] };
    for (const mapping of member.selection.mappings ?? []) {
      if (mapping.kind !== 'structure') continue;
      for (let position = mapping.residueStart; position <= mapping.residueEnd; position += 1) {
        current.positions.push(position);
      }
    }
    chains.set(key, current);
  }

  return {
    id: document.id,
    label: document.name,
    color: SAVED_SELECTION_HIGHLIGHT_COLOR,
    renderMode: 'annotation',
    visible,
    residueLocations: residueLocationsForSavedSelectionRevision(document, revisionId),
    selections: [...chains.values()].map(({ positions, ...chain }) => ({
      ...chain,
      ranges: positionsToRanges(positions),
    })),
  };
}

function findPhysicalChain(
  chains: ReadonlyArray<ChainSequence>,
  selection: ChainSelection
): ChainSequence | undefined {
  return chains.find(
    (chain) =>
      chain.chainId === selection.chain &&
      optionalIdentityEqual(chain.baseChain, selection.baseChain) &&
      optionalIdentityEqual(chain.labelAsymId, selection.labelAsymId) &&
      optionalIdentityEqual(chain.authAsymId, selection.authAsymId) &&
      optionalIdentityEqual(chain.entityId, selection.entityId) &&
      optionalIdentityEqual(chain.operator, selection.operator)
  );
}

function optionalIdentityEqual(actual: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || actual === expected;
}

function mapAuthorRangesToPolymerResidues(
  chain: ChainSequence,
  selection: ChainSelection
): Array<{ polymerIndex: number; residue: ChainSequence['residues'][number] }> {
  const residueByAuthorPosition = new Map<
    number,
    { polymerIndex: number; residue: ChainSequence['residues'][number] }
  >();
  chain.residues.forEach((residue, chainIndex) => {
    residueByAuthorPosition.set(residue.position, {
      polymerIndex: residue.sequenceIndex ?? chainIndex,
      residue,
    });
  });
  const selected: Array<{
    polymerIndex: number;
    residue: ChainSequence['residues'][number];
  }> = [];
  for (const [start, end] of selection.ranges) {
    for (let authorPosition = start; authorPosition <= end; authorPosition += 1) {
      const resolved = residueByAuthorPosition.get(authorPosition);
      if (!resolved) {
        throw new Error(
          `Cannot map author residue ${authorPosition} on physical chain ${selection.chain}`
        );
      }
      selected.push(resolved);
    }
  }
  return [...new Map(selected.map((item) => [item.polymerIndex, item])).values()].sort(
    (left, right) => left.polymerIndex - right.polymerIndex
  );
}

async function polymerRevisionForChain(
  attrs: Structure3dAttrs,
  chain: ChainSequence,
  sourceArtifactGitCommit?: string
) {
  const queryAnchor = attrs.scene?.queryAnchor;
  const proteinIdentity = queryAnchor?.proteinIdentity;
  if (proteinIdentity && chainMatchesSelection(chain, queryAnchor.targetSelection)) {
    const feature = proteinIdentity.feature;
    const sourceEntityId = queryAnchor.sourceEntityId ?? feature?.entityId;
    const translationConfig = proteinIdentity.sequence.translationConfig;
    const strand = feature?.location.segments[0]?.strand;
    return {
      moleculeId: proteinIdentity.sequence.identityKey,
      moleculeKind: 'protein',
      sequenceDigestSha256: proteinIdentity.sequence.digests.sha256,
      ...(sourceEntityId
        ? {
            sourceArtifact: {
              entityId: sourceEntityId,
              ...(sourceArtifactGitCommit ? { gitCommit: sourceArtifactGitCommit } : {}),
            },
          }
        : {}),
      ...(feature && translationConfig && (strand === 1 || strand === -1)
        ? {
            translation: {
              featureId: feature.featureKey,
              strand,
              geneticCode: translationConfig.geneticCode,
              frame: translationConfig.frame,
            },
          }
        : {}),
    };
  }

  const digest = await sha256Hex(chain.sequence);
  const moleculeKind = savedSelectionMoleculeKind(chain.polymerType);
  return {
    moleculeId: `${moleculeKind}-sequence:sha256:${digest}`,
    moleculeKind,
    sequenceDigestSha256: digest,
  };
}

export function savedSelectionMoleculeKind(polymerType: ChainPolymerType | undefined): string {
  switch (polymerType) {
    case 'dna':
      return 'dna';
    default:
      return 'protein';
  }
}

function chainMatchesSelection(chain: ChainSequence, selection: StructureMemberSelection): boolean {
  const matches = (values: string[] | undefined, value: string | undefined) =>
    !values?.length || (!!value && values.includes(value));
  return (
    matches(selection.chainIds, chain.chainId) &&
    matches(selection.labelAsymIds, chain.labelAsymId ?? chain.baseChain ?? chain.chainId) &&
    matches(selection.authAsymIds, chain.authAsymId) &&
    matches(selection.entityIds, chain.entityId)
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function residueIntervalsFromSelection(
  selection: ResidueSelection
): ReadonlyArray<ResidueInterval> {
  return selection.target.intervals;
}
