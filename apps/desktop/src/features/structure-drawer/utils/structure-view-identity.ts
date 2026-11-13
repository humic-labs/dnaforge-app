import {
  translatedCdsMoleculeIdFromParts,
  type SavedSelectionPolymerRevision,
} from '@waypoint/workspace-editor';
import type {
  Structure3dAttrs,
  StructureBinding,
  StructureCoordinateRevisionPin,
  StructureViewIdentity,
} from '../../page/public/embeds/structure3d/types';
import type { StructureLinkResidueTarget } from '../state/use-structure-link-registry';
import type { StructureDrawerRequest } from '../types/structure-drawer';
import { canonicalJsonWithArrays, sha256Hex } from '../api/protein-identity';

export type { StructureBinding, StructureCoordinateRevisionPin, StructureViewIdentity };

export type LegacyStructureTargetResolution =
  | { status: 'not-found'; structureId: string }
  | { status: 'resolved'; binding: StructureBinding }
  | { status: 'ambiguous'; structureId: string; candidates: string[] };

export function createStructureBinding(input: {
  structureId: string;
  attrs: Structure3dAttrs;
  request: StructureDrawerRequest;
  linkOwnerId?: string;
}): StructureBinding {
  const sequenceDigestSha256 = input.request.proteinIdentity?.sequence.digests.sha256;
  if (!sequenceDigestSha256) {
    throw new Error('Structure binding requires a revision-pinned protein sequence digest');
  }

  const featureKey =
    input.request.proteinIdentity?.feature?.featureKey ?? input.request.identityRequestKey;
  if (!featureKey) {
    throw new Error('Structure binding requires a stable source feature identity');
  }

  const bounds = input.request.cdsBounds;
  const sourceEntityId = input.request.entityId;
  const residueMolecule = sourceEntityId ? input.request.residueMolecule : undefined;
  const moleculeId =
    residueMolecule?.moleculeId ??
    (sourceEntityId && bounds
      ? translatedCdsMoleculeIdFromParts({
          referenceId: sourceEntityId,
          featureKey,
          start0: bounds.cdsStart,
          end0: bounds.cdsEnd,
          strand: bounds.strand,
        })
      : (input.request.proteinIdentity?.sequence.identityKey ?? `protein:${sequenceDigestSha256}`));
  const translationFeatureId = residueMolecule?.label?.trim() || featureKey;

  const polymerRevision: SavedSelectionPolymerRevision = {
    moleculeId,
    moleculeKind: residueMolecule?.moleculeKind ?? (bounds ? 'translated-cds' : 'protein'),
    sequenceDigestSha256,
    ...(sourceEntityId
      ? {
          sourceArtifact: {
            entityId: sourceEntityId,
            path: sourceEntityId,
          },
        }
      : {}),
    ...(bounds
      ? {
          translation: {
            featureId: translationFeatureId,
            strand: bounds.strand,
            geneticCode:
              input.request.proteinIdentity?.sequence.translationConfig?.geneticCode ?? 1,
            frame: input.request.proteinIdentity?.sequence.translationConfig?.frame ?? 0,
          },
        }
      : {}),
  };

  const coordinateRevision = coordinateRevisionForAttrs(input.attrs, input.structureId);
  const physicalChainScope = explicitPhysicalChainScope(input.attrs);
  const mappingRevisionId = digestId('structure-mapping:v1', {
    identityRequestKey: input.request.identityRequestKey ?? null,
    featureKey,
    polymerRevision,
    coordinateRevision,
    physicalChainScope,
  });
  const bindingId = digestId('structure-binding:v1', {
    structureId: input.structureId,
    coordinateRevision,
    polymerRevision,
    mappingRevisionId,
    physicalChainScope,
    linkOwnerId: input.linkOwnerId ?? null,
  });

  return {
    schemaVersion: 1,
    bindingId,
    structureId: input.structureId,
    coordinateRevision,
    polymerRevision,
    mappingRevisionId,
    physicalChainScope,
    ...(input.linkOwnerId ? { linkOwnerId: input.linkOwnerId } : {}),
  };
}

export function createStructureViewIdentity(
  binding: StructureBinding,
  logicalOwnerId: string
): StructureViewIdentity {
  return {
    schemaVersion: 1,
    structureViewId: digestId('structure-view:v1', {
      bindingId: binding.bindingId,
      logicalOwnerId,
    }),
    bindingId: binding.bindingId,
  };
}

export function createCoordinateOnlyStructureViewIdentity(input: {
  catalogEntityId: string;
  coordinateDigestSha256: string;
}): StructureViewIdentity {
  return {
    schemaVersion: 1,
    structureViewId: digestId('structure-view:file:v1', input),
    bindingId: null,
  };
}

export function createUnavailableCoordinateViewId(filePath: string): string {
  return digestId('structure-view:file-unavailable:v1', { filePath });
}

export function resolveLegacyStructureTarget(
  bindings: ReadonlyArray<StructureBinding>,
  structureId: string
): LegacyStructureTargetResolution {
  const matches = bindings.filter((binding) => binding.structureId === structureId);
  if (matches.length === 0) return { status: 'not-found', structureId };
  if (matches.length === 1) return { status: 'resolved', binding: matches[0] };
  return {
    status: 'ambiguous',
    structureId,
    candidates: matches.map((binding) => binding.bindingId).sort(),
  };
}

function coordinateRevisionForAttrs(
  attrs: Structure3dAttrs,
  structureId: string
): StructureCoordinateRevisionPin {
  const artifact = attrs.structureArtifactRef;
  if (artifact) {
    return {
      kind: 'artifact',
      pinStatus: 'exact',
      revisionId: artifact.revisionId,
      coordinateDigestSha256: artifact.coordinateDigestSha256,
      artifactRef: artifact,
    };
  }

  const providerIdentityKey = attrs.providerIdentityKey?.trim();
  if (providerIdentityKey) {
    const providerRevision = attrs.version?.trim();
    return {
      kind: 'provider',
      pinStatus: 'provider-revision',
      revisionId: digestId('structure-coordinate-provider:v1', {
        providerIdentityKey,
        providerRevision: providerRevision ?? null,
        assemblyId: attrs.assemblyId ?? null,
      }),
      providerIdentityKey,
      ...(providerRevision ? { providerRevision } : {}),
    };
  }

  return {
    kind: 'unresolved',
    pinStatus: 'unresolved',
    revisionId: digestId('structure-coordinate-unresolved:v1', { structureId }),
    reason: 'coordinate-revision-unavailable',
  };
}

function explicitPhysicalChainScope(attrs: Structure3dAttrs): StructureLinkResidueTarget[] {
  const labelAsymIds = normalizedTokens(attrs.labelAsymIds);
  const authAsymIds = normalizedTokens(attrs.authAsymIds);
  const entityId = attrs.pdbEntityId?.trim() || undefined;
  const length = Math.max(labelAsymIds.length, authAsymIds.length);
  const targets: StructureLinkResidueTarget[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < length; index += 1) {
    const labelAsymId = labelAsymIds[index];
    const authAsymId = authAsymIds[index];
    const chain = authAsymId ?? labelAsymId;
    if (!chain) continue;
    const target: StructureLinkResidueTarget = {
      chain,
      ...(labelAsymId ? { baseChain: labelAsymId, labelAsymId } : {}),
      ...(authAsymId ? { authAsymId } : {}),
      ...(entityId ? { entityId } : {}),
      residues: [],
    };
    const key = canonicalJsonWithArrays(target);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }

  return targets;
}

function normalizedTokens(values: readonly string[] | undefined): string[] {
  return values?.map((value) => value.trim()).filter(Boolean) ?? [];
}

function digestId(prefix: string, value: Record<string, unknown>): string {
  return `${prefix}:${sha256Hex(canonicalJsonWithArrays(value)).slice(0, 32)}`;
}
