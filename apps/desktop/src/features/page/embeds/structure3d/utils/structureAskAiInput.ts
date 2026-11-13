import type { AskAiSelectionInput } from '../../../../ai/public/ask-ai-about-selection';
import {
  resolvedStructureComponentId,
  STRUCTURE_RESIDUE_IDENTITY_CAP,
  structureSelectionsFromResidues,
} from '../../../../ai/public/selection-descriptor/structure';
import type {
  ChainSequence,
  ResidueLocation,
  Structure3dAttrs,
  StructureViewState,
} from '../types';
import type { ResidueSelectionLink } from './residueSelectionBridge';
import {
  deriveAskAiRegionsFromStructureResidues,
  residueLabelClause,
} from './ask-ai-disjoint-regions';
import { visualLayersForView } from './viewLayerOverrides';

interface BuildStructureAskAiSelectionInputOptions {
  structureId: string;
  data: Pick<Structure3dAttrs, 'label' | 'sourceId'> | null | undefined;
  structureLink: ResidueSelectionLink | null | undefined;
  residues: ReadonlyArray<ResidueLocation>;
  chains: ReadonlyArray<ChainSequence> | null | undefined;
  view: StructureViewState | undefined;
}

function optionalScopeMatches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

interface ChainResidueCandidate {
  chain: ChainSequence;
  residue: ChainSequence['residues'][number];
}

function inventoryCoordinateKey(chainId: string, position: number): string {
  return `${chainId}\u0000${position}`;
}

function physicalCandidateKey(candidate: ChainResidueCandidate): string {
  const { chain, residue } = candidate;
  return JSON.stringify([
    chain.chainId,
    chain.baseChain ?? null,
    chain.labelAsymId ?? null,
    chain.authAsymId ?? null,
    chain.entityId ?? null,
    chain.operator ?? null,
    residue.position,
    residue.labelSeqId ?? null,
  ]);
}

function buildChainResidueIndex(
  chains: ReadonlyArray<ChainSequence>
): ReadonlyMap<string, ChainResidueCandidate[]> {
  const index = new Map<string, ChainResidueCandidate[]>();
  for (const chain of chains) {
    for (const residue of chain.residues) {
      const key = inventoryCoordinateKey(chain.chainId, residue.position);
      const candidates = index.get(key);
      const candidate = { chain, residue };
      if (candidates) candidates.push(candidate);
      else index.set(key, [candidate]);
    }
  }
  return index;
}

function matchingChainResidues(
  residue: ResidueLocation,
  index: ReadonlyMap<string, ChainResidueCandidate[]>
): ChainResidueCandidate[] {
  return (index.get(inventoryCoordinateKey(residue.chain, residue.position)) ?? []).filter(
    ({ chain, residue: candidate }) =>
      optionalScopeMatches(residue.baseChain, chain.baseChain) &&
      optionalScopeMatches(residue.labelAsymId, chain.labelAsymId) &&
      optionalScopeMatches(residue.authAsymId, chain.authAsymId) &&
      optionalScopeMatches(residue.entityId, chain.entityId) &&
      optionalScopeMatches(residue.operator, chain.operator) &&
      (residue.labelSeqId === undefined || candidate.labelSeqId === residue.labelSeqId)
  );
}

export function materializeStructureResidueIdentities(
  residues: ReadonlyArray<ResidueLocation>,
  chains: ReadonlyArray<ChainSequence>
): ResidueLocation[] | null {
  const chainResidueIndex = buildChainResidueIndex(chains);
  const materialized = residues.map((residue) => {
    const existingIdentity = resolvedStructureComponentId(residue.labelCompId ?? residue.compId);
    if (existingIdentity) {
      return residue.labelCompId
        ? { ...residue, labelCompId: existingIdentity }
        : { ...residue, compId: existingIdentity };
    }
    const matches = matchingChainResidues(residue, chainResidueIndex);
    const physicalCoordinates = new Map<string, ChainResidueCandidate[]>();
    for (const match of matches) {
      const key = physicalCandidateKey(match);
      const candidates = physicalCoordinates.get(key);
      if (candidates) candidates.push(match);
      else physicalCoordinates.set(key, [match]);
    }
    if (physicalCoordinates.size !== 1) return residue;
    const identities = new Set(
      [...physicalCoordinates.values()][0]
        .map((candidate) => resolvedStructureComponentId(candidate.residue.name3))
        .filter((identity): identity is string => identity !== null)
    );
    if (identities.size !== 1) return residue;
    return { ...residue, labelCompId: identities.values().next().value as string };
  });

  return materialized.every(
    (residue) => resolvedStructureComponentId(residue.labelCompId ?? residue.compId) !== null
  )
    ? materialized
    : null;
}

export function buildStructureAskAiSelectionInput({
  structureId,
  data,
  structureLink,
  residues,
  chains,
  view,
}: BuildStructureAskAiSelectionInputOptions): AskAiSelectionInput | null {
  if (residues.length === 0) return null;
  const identityCompleteResidues = materializeStructureResidueIdentities(residues, chains ?? []);
  if (!identityCompleteResidues) return null;
  if (identityCompleteResidues.length > STRUCTURE_RESIDUE_IDENTITY_CAP) return null;
  const nativeSelections = structureSelectionsFromResidues(identityCompleteResidues);
  if (nativeSelections.length === 0) return null;

  const derivation = deriveAskAiRegionsFromStructureResidues(
    structureLink,
    identityCompleteResidues
  );
  const readableName =
    data?.label?.trim() || structureLink?.cdsLabel?.trim() || data?.sourceId?.trim() || structureId;
  const residueLabel = residueLabelClause(
    Array.from(new Set(identityCompleteResidues.map((residue) => residue.position)))
  );
  const visibleRepresentations = view
    ? visualLayersForView(view)
        .filter((layer) => layer.visible)
        .map((layer) => ({
          layerId: layer.id,
          representation: layer.representation.kind,
          target: layer.target.kind,
          colorMode: layer.color.mode,
        }))
    : [];

  return {
    entityType: 'structure',
    displayLabel: residueLabel ? `${readableName} ${residueLabel}` : readableName,
    locator: structureId,
    deepLinkParams: {
      highlightGroups: [
        {
          id: `ask-ai-selection:${structureId}`,
          label: 'Selected residues',
          selections: nativeSelections.map(({ regions, ...selection }) => ({
            ...selection,
            ranges: regions.map(({ start, end }) => [start, end] as [number, number]),
          })),
          visible: true,
        },
      ],
    },
    structure: {
      residues: identityCompleteResidues,
      visibleRepresentations,
      ...(structureLink?.sequenceDocumentId
        ? {
            linkedCodingDna: {
              documentId: structureLink.sequenceDocumentId,
              regions: derivation.regions,
            },
          }
        : {}),
    },
    seedText: undefined,
  };
}
