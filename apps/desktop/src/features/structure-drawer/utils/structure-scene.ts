import type {
  Structure3dAttrs,
  StructureComplexMember,
  StructureMemberMappingEvidence,
  StructureMemberMappingStatus,
  StructureMemberSelection,
  StructureScene,
  StructureSceneLayer,
  StructureSceneSourceRef,
} from '../../page/public/embeds/structure3d/types';
import {
  activeFocusForStructureMember,
  cloneStructureMemberSelection,
} from '../../page/public/embeds/structure3d/utils/structureScene';
import type {
  ResolverResult,
  StructureCandidate,
  StructureDrawerRequest,
} from '../types/structure-drawer';

interface BuildSingleQueryStructureSceneInput {
  resolved: ResolverResult;
  candidate: StructureCandidate | null;
  structureId: string;
  attrs: Structure3dAttrs;
  label: string;
  request?: StructureDrawerRequest;
}

export function buildSingleQueryStructureScene({
  resolved,
  candidate,
  structureId,
  attrs,
  label,
  request,
}: BuildSingleQueryStructureSceneInput): StructureScene {
  const selection = selectionFromStructureAttrs(attrs);
  const memberId = `member:${structureId}:query`;
  const mappingStatus = mappingStatusForRequest(request);
  const mappingEvidence = mappingEvidenceForRequest(request, mappingStatus);
  const workspaceFeatureRef =
    request?.entityId && request.cdsBounds
      ? {
          entityId: request.entityId,
          ...(request.proteinIdentity?.feature?.featureKey
            ? { featureKey: request.proteinIdentity.feature.featureKey }
            : {}),
          cdsBounds: request.cdsBounds,
          ...(request.cdsLabel ? { label: request.cdsLabel } : {}),
        }
      : undefined;
  const identifiers = identifiersFromAttrs(attrs, candidate);
  const member: StructureComplexMember = {
    memberId,
    kind: request?.moleculeType ?? 'protein',
    displayName: request?.cdsLabel ?? label,
    selection: cloneStructureMemberSelection(selection),
    ...(attrs.pdbEntityId ? { pdbEntityId: attrs.pdbEntityId } : {}),
    ...(attrs.labelAsymIds ? { labelAsymIds: [...attrs.labelAsymIds] } : {}),
    ...(attrs.authAsymIds ? { authAsymIds: [...attrs.authAsymIds] } : {}),
    relationToAnchor: 'query',
    mappingStatus,
    ...(mappingEvidence ? { mappingEvidence } : {}),
    ...(workspaceFeatureRef ? { workspaceFeatureRef } : {}),
    ...(identifiers ? { identifiers } : {}),
  };
  const contextMembers = contextMembersFromCandidate(candidate, attrs, structureId);
  const members = [member, ...contextMembers];
  const isComplexScene = contextMembers.length > 0;
  const primaryResourceId = primaryResourceIdFor(attrs, structureId, {
    fullPdbEntry: isComplexScene,
  });
  const queryAnchor: StructureScene['queryAnchor'] = {
    memberId,
    ...(request?.entityId ? { sourceEntityId: request.entityId } : {}),
    ...(request?.sourceWorkspaceRoot ? { sourceWorkspaceRoot: request.sourceWorkspaceRoot } : {}),
    ...(request?.identityRequestKey ? { identityRequestKey: request.identityRequestKey } : {}),
    ...(request?.cdsBounds ? { cdsBounds: request.cdsBounds } : {}),
    label: request?.cdsLabel ?? label,
    ...((request?.proteinIdentity ?? resolved.proteinIdentity)
      ? { proteinIdentity: request?.proteinIdentity ?? resolved.proteinIdentity }
      : {}),
    targetSelection: cloneStructureMemberSelection(selection),
  };
  const provenance: StructureScene['provenance'] = {
    createdBy: 'structure-drawer',
    resolverSource: resolved.source,
    resolverIdentity: resolved.identity,
    ...(candidate?.id ? { candidateId: candidate.id } : {}),
    ...(attrs.source ? { provider: attrs.source } : {}),
    ...(attrs.providerIdentityKey ? { providerIdentityKey: attrs.providerIdentityKey } : {}),
    ...(candidate?.metadata.sourceUrl ? { sourceUrl: candidate.metadata.sourceUrl } : {}),
  };

  return {
    schemaVersion: 1,
    sceneId: `scene:${structureId}`,
    sceneKind: isComplexScene ? 'complex' : 'single_query',
    primaryResourceId,
    queryAnchor,
    activeFocus: activeFocusForStructureMember(member, memberId),
    members,
    layers: [layerFromStructureAttrs(attrs, structureId, primaryResourceId)],
    provenance,
  };
}

function contextMembersFromCandidate(
  candidate: StructureCandidate | null,
  attrs: Structure3dAttrs,
  structureId: string
): StructureComplexMember[] {
  if (!candidate || attrs.source !== 'pdb' || !attrs.pdbId) return [];
  if (!hasHeteromericCandidateContext(candidate)) return [];

  const queryAuthChains = new Set(attrs.authAsymIds ?? attrs.labelAsymIds ?? []);
  if (queryAuthChains.size === 0) return [];

  const candidateChains = candidate.metadata.chainIds ?? [];
  const contextChains = candidateChains.filter((chainId) => !queryAuthChains.has(chainId));
  if (contextChains.length === 0) return [];

  return contextChains.map((chainId) => ({
    memberId: `member:${structureId}:chain:${chainId}`,
    kind: 'protein',
    displayName: `Chain ${chainId}`,
    selection: {
      ...(attrs.providerIdentityKey ? { providerIdentityKey: attrs.providerIdentityKey } : {}),
      pdbId: attrs.pdbId,
      authAsymIds: [chainId],
    },
    authAsymIds: [chainId],
    relationToAnchor: 'known_partner',
    mappingStatus: 'unmapped',
    mappingEvidence: [
      {
        kind: 'provider_xref',
        label: 'Additional chain in the same PDB complex',
        confidence: 'heuristic',
        source: attrs.providerIdentityKey ?? attrs.pdbId,
      },
    ],
  }));
}

function hasHeteromericCandidateContext(candidate: StructureCandidate): boolean {
  const entityDescriptions = new Set(
    (candidate.metadata.entityDescriptions ?? [])
      .map((description) => description.trim().toLowerCase())
      .filter(Boolean)
  );
  if (entityDescriptions.size > 1) return true;

  const polymerTypes = new Set(
    (candidate.metadata.polymerTypes ?? [])
      .map((polymerType) => polymerType.trim().toLowerCase())
      .filter(Boolean)
  );
  return polymerTypes.size > 1;
}

function selectionFromStructureAttrs(attrs: Structure3dAttrs): StructureMemberSelection {
  const accession = attrs.accession ?? attrs.uniprotId;
  return {
    ...(attrs.providerIdentityKey ? { providerIdentityKey: attrs.providerIdentityKey } : {}),
    ...(attrs.pdbId ? { pdbId: attrs.pdbId } : {}),
    ...(accession ? { accession } : {}),
    ...(attrs.pdbEntityId ? { entityIds: [attrs.pdbEntityId] } : {}),
    ...(attrs.labelAsymIds ? { labelAsymIds: [...attrs.labelAsymIds] } : {}),
    ...(attrs.authAsymIds ? { authAsymIds: [...attrs.authAsymIds] } : {}),
  };
}

function identifiersFromAttrs(
  attrs: Structure3dAttrs,
  candidate: StructureCandidate | null
): StructureComplexMember['identifiers'] | undefined {
  const uniprotAccession = attrs.accession ?? candidate?.metadata.uniprotAccession;
  const pdbEntityDescription = candidate?.metadata.description ?? candidate?.metadata.title;
  if (!uniprotAccession && !pdbEntityDescription) return undefined;
  return {
    ...(uniprotAccession ? { uniprotAccessions: [uniprotAccession] } : {}),
    ...(pdbEntityDescription ? { pdbEntityDescription } : {}),
  };
}

function mappingStatusForRequest(
  request: StructureDrawerRequest | undefined
): StructureMemberMappingStatus {
  return request?.entityId && request.cdsBounds ? 'mapped_current_sequence' : 'unmapped';
}

function mappingEvidenceForRequest(
  request: StructureDrawerRequest | undefined,
  mappingStatus: StructureMemberMappingStatus
): StructureMemberMappingEvidence[] | undefined {
  if (mappingStatus !== 'mapped_current_sequence' || !request?.entityId) return undefined;
  return [
    {
      kind: 'query_anchor',
      label: request.cdsLabel
        ? `Opened from ${request.cdsLabel}`
        : 'Opened from source CDS annotation',
      confidence: 'authoritative',
      source: request.entityId,
    },
  ];
}

function primaryResourceIdFor(
  attrs: Structure3dAttrs,
  structureId: string,
  options: { fullPdbEntry?: boolean } = {}
): string {
  if (options.fullPdbEntry && attrs.source === 'pdb' && attrs.pdbId) {
    return `RCSB:${attrs.pdbId.toUpperCase()}:ENTRY`;
  }
  if (attrs.providerIdentityKey) return attrs.providerIdentityKey;
  if (attrs.source === 'file') return structureId;
  return attrs.sourceId ?? structureId;
}

function layerFromStructureAttrs(
  attrs: Structure3dAttrs,
  structureId: string,
  primaryResourceId = primaryResourceIdFor(attrs, structureId)
): StructureSceneLayer {
  return {
    id: `layer:model:${primaryResourceId}`,
    kind: 'model',
    role: 'query',
    visible: true,
    source: sourceRefFromStructureAttrs(attrs),
  };
}

function sourceRefFromStructureAttrs(attrs: Structure3dAttrs): StructureSceneSourceRef {
  return {
    source: attrs.source ?? 'file',
    ...(attrs.sourceId ? { sourceId: attrs.sourceId } : {}),
    ...(attrs.providerIdentityKey ? { providerIdentityKey: attrs.providerIdentityKey } : {}),
    ...(attrs.pdbId ? { pdbId: attrs.pdbId } : {}),
    ...(attrs.uniprotId ? { uniprotId: attrs.uniprotId } : {}),
    ...(attrs.accession ? { accession: attrs.accession } : {}),
    ...(attrs.assemblyId ? { assemblyId: attrs.assemblyId } : {}),
    ...(attrs.url ? { url: attrs.url } : {}),
  };
}
