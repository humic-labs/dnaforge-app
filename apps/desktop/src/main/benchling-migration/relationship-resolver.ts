import type {
  RelationshipEvidence,
  RelationshipResolution,
  SourceObject,
  SourceRelationship,
} from '../../shared/benchling-migration';
import { canonicalBenchlingItemUrl } from './canonical-item-url';
import {
  benchlingOrganizationBaseUrlFromSourceUrl,
  isUrlWithinBenchlingOrganization,
} from './source-identity';
import {
  buildStrainRelationshipIndexes,
  strainRelationshipCandidateCompatibility,
  strainRelationshipNameCandidates,
  type StrainRelationshipIndexes,
} from './strain-relationship-resolver';

export type TargetedReadRequest = {
  targetSourceId: string;
  targetSourceUrl: string;
  relationshipIds: string[];
};

export type OfflineRelationshipResolutionInput = {
  sourceObjects: readonly SourceObject[];
  relationships: readonly SourceRelationship[];
  benchlingOrigin?: string;
  selectedSnapshotStableIdsAreAuthoritative?: boolean;
};

export type OfflineRelationshipResolutionResult = {
  resolutions: RelationshipResolution[];
  targetedReadQueue: TargetedReadRequest[];
};

type CandidateMatch = {
  sourceObject: SourceObject;
  score: number;
};

type TargetUrlAuthority =
  | { kind: 'authorized'; url: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'conflicting' };

export type SelectedSnapshotRelationshipTargetAuthority =
  | { kind: 'authorized'; canonicalUrl: string; observedUrl: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'conflicting' };

const BENCHLING_EXACT_TARGET_ID_PATTERN = /^[a-z][a-z0-9]{1,15}_[a-z0-9_]{3,}$/iu;
const BENCHLING_PATH_ID_PATTERN = /^[a-z][a-z0-9]{1,15}_[a-z0-9_-]{3,}$/iu;
const BENCHLING_FOLDER_ID_PREFIXES = ['lib_', 'fld_', 'src_'] as const;

export const EMBEDDED_ENTRY_REFERENCE_RELATION_TYPE = 'embedded_entry_reference';

export function exactRelationshipResolutionCaptureConflict(input: {
  relationship: SourceRelationship;
  resolution: RelationshipResolution;
  sourceObjects: readonly SourceObject[];
  benchlingOrigin: string | undefined;
  selectedSnapshotStableIdsAreAuthoritative?: boolean;
}): string | null {
  const { relationship, resolution, sourceObjects, benchlingOrigin } = input;
  if (resolution.classification !== 'exact') return null;
  if (resolution.relationshipId !== relationship.id) {
    return 'relationship identity does not match the captured relationship';
  }
  if (resolution.sourceObjectId !== relationship.sourceObjectId) {
    return 'source object does not match the captured relationship';
  }
  if (resolution.relationType !== normalizeRelationType(relationship.relationType)) {
    return 'relation type does not match the captured relationship';
  }
  if (JSON.stringify(resolution.evidence) !== JSON.stringify(relationship.evidence)) {
    return 'evidence does not match the captured relationship';
  }
  if (relationship.sourceBroken) {
    return 'captured relationship is explicitly source-broken';
  }

  const targetSourceId = resolution.targetSourceId?.trim() ?? '';
  if (!targetSourceId) return 'exact resolution has no target identity';
  if (resolution.requiresTargetedRead) {
    return 'exact resolution still requires a targeted read';
  }
  if (
    resolution.candidateSourceIds.length !== 1 ||
    resolution.candidateSourceIds[0] !== targetSourceId
  ) {
    return 'exact candidate identity does not match the resolved target';
  }

  const explicitTargetIds = stableTargetIds(relationship);
  if (explicitTargetIds.length > 1) {
    return 'captured relationship contains conflicting explicit target identities';
  }
  if (explicitTargetIds.length === 1 && explicitTargetIds[0] !== targetSourceId) {
    return 'resolved target does not match the captured explicit target identity';
  }

  const targetUrls = relationshipTargetUrls(relationship);
  if (targetUrls.length > 0) {
    if (!benchlingOrigin) {
      return 'captured target URL has no immutable Benchling organization authority';
    }
    const targetUrlAuthority = input.selectedSnapshotStableIdsAreAuthoritative
      ? selectedSnapshotRelationshipTargetUrlAuthority(
          relationship,
          targetSourceId,
          benchlingOrigin
        )
      : relationshipTargetUrlAuthority(relationship, targetSourceId, benchlingOrigin);
    if (targetUrlAuthority.kind !== 'authorized') {
      return 'captured target URL does not authorize the resolved target identity';
    }
  }

  if (explicitTargetIds.length > 0 || targetUrls.length > 0) return null;

  const recomputed = resolveOfflineRelationships({
    sourceObjects,
    relationships: [relationship],
    selectedSnapshotStableIdsAreAuthoritative: true,
  }).resolutions[0];
  if (
    !recomputed ||
    recomputed.classification !== 'exact' ||
    recomputed.targetSourceId !== targetSourceId ||
    recomputed.relationType !== resolution.relationType ||
    recomputed.candidateSourceIds.length !== 1 ||
    recomputed.candidateSourceIds[0] !== targetSourceId ||
    recomputed.requiresTargetedRead
  ) {
    return 'captured evidence no longer has one exact unique target in the source snapshot';
  }
  return null;
}

export function resolveOfflineRelationships(
  input: OfflineRelationshipResolutionInput
): OfflineRelationshipResolutionResult {
  const sourceObjects = [...input.sourceObjects].sort(compareSourceObjects);
  const relationships = input.relationships
    .filter((relationship) => relationship.direction === 'outbound')
    .slice()
    .sort(compareRelationships);
  const selectedSnapshotStableIdsAreAuthoritative =
    input.selectedSnapshotStableIdsAreAuthoritative === true;
  const benchlingOrigin =
    input.benchlingOrigin ??
    (selectedSnapshotStableIdsAreAuthoritative
      ? inferredSelectedSnapshotOrganizationBaseUrl(relationships)
      : undefined);
  const strainIndexes = buildStrainRelationshipIndexes(sourceObjects);

  const preliminaryResolutions = relationships.map((relationship) =>
    resolveRelationship(
      relationship,
      sourceObjects,
      benchlingOrigin,
      selectedSnapshotStableIdsAreAuthoritative,
      strainIndexes
    )
  );
  const authority = collectTargetedReadAuthority(
    relationships,
    preliminaryResolutions,
    benchlingOrigin
  );
  const resolutions = preliminaryResolutions.map((resolution) => {
    const conflictingTargetId =
      resolution.requiresTargetedRead &&
      resolution.targetSourceId &&
      authority.conflictingTargetIds.has(resolution.targetSourceId)
        ? resolution.targetSourceId
        : null;
    if (!conflictingTargetId) return resolution;
    return {
      ...resolution,
      targetSourceId: null,
      classification: 'ambiguous' as const,
      candidateSourceIds: [conflictingTargetId],
      requiresTargetedRead: false,
      reason: 'Conflicting canonical route evidence exists for the same stable target identity.',
    };
  });

  return {
    resolutions,
    targetedReadQueue: [...authority.pending.entries()]
      .filter(([targetSourceId]) => !authority.conflictingTargetIds.has(targetSourceId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([targetSourceId, value]) => ({
        targetSourceId,
        targetSourceUrl: value.targetSourceUrl,
        relationshipIds: [...value.relationshipIds].sort(),
      })),
  };
}

function resolveRelationship(
  relationship: SourceRelationship,
  sourceObjects: readonly SourceObject[],
  benchlingOrigin: string | undefined,
  selectedSnapshotStableIdsAreAuthoritative: boolean,
  strainIndexes: StrainRelationshipIndexes
): RelationshipResolution {
  const relationType = normalizeRelationType(relationship.relationType);
  const targetSourceId = expectedTargetId(relationship, benchlingOrigin);
  const linkableSourceObjects = sourceObjects.filter(
    (sourceObject) => sourceObject.sourceType !== 'unsupported_object'
  );

  if (relationship.sourceBroken) {
    return makeResolution(relationship, {
      targetSourceId,
      relationType,
      classification: 'source_broken',
      candidateSourceIds: [],
      requiresTargetedRead: false,
      reason: 'The source relationship is explicitly marked as broken.',
    });
  }

  const primaryUrl = relationship.targetUrl ?? firstEvidenceValue(relationship.evidence, 'url');
  if (primaryUrl && isExternalTargetUrl(primaryUrl, benchlingOrigin)) {
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: 'external',
      candidateSourceIds: [],
      requiresTargetedRead: false,
      reason:
        'The target is outside the confirmed Benchling tenant and is preserved without fetching.',
    });
  }

  const explicitTargetIds = stableTargetIds(relationship);
  if (explicitTargetIds.length > 1) {
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: 'ambiguous',
      candidateSourceIds: explicitTargetIds,
      requiresTargetedRead: false,
      reason: 'The relationship contains more than one explicit stable target identity.',
    });
  }

  const stableMatches = findStableMatches(
    relationship,
    linkableSourceObjects,
    benchlingOrigin,
    targetSourceId,
    selectedSnapshotStableIdsAreAuthoritative
  ).filter((candidate) => {
    const compatible = strainRelationshipCandidateCompatibility(relationship, candidate);
    return compatible ?? true;
  });
  if (stableMatches.length > 0) {
    return resolutionForDefinitiveMatches(
      relationship,
      relationType,
      stableMatches,
      'stable Benchling ID or URL'
    );
  }

  const strainNameMatches = strainRelationshipNameCandidates(relationship, strainIndexes);
  if (strainNameMatches !== null) {
    const matches = uniqueObjects(strainNameMatches);
    if (matches.length === 1) {
      const exactTargetSourceId = stableObjectId(matches[0]);
      return makeResolution(relationship, {
        targetSourceId: exactTargetSourceId,
        relationType,
        classification: 'exact',
        candidateSourceIds: [exactTargetSourceId],
        requiresTargetedRead: false,
        reason: 'Resolved from one exact name under an audited strain relationship field.',
      });
    }
    if (matches.length > 1) {
      return makeResolution(relationship, {
        targetSourceId: null,
        relationType,
        classification: 'ambiguous',
        candidateSourceIds: stableCandidateIds(matches),
        requiresTargetedRead: false,
        reason: 'Multiple objects share the exact strain relationship name.',
      });
    }
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: 'unresolved',
      candidateSourceIds: [],
      requiresTargetedRead: false,
      reason: 'No object has the exact name from the audited strain relationship field.',
    });
  }

  const registryMatches = findRegistryMatches(relationship.evidence, linkableSourceObjects);
  if (registryMatches.length > 0) {
    const hasSchemaEvidence = relationship.evidence.some(
      (evidence) => evidence.kind === 'source_type' && evidence.value.trim()
    );
    if (!hasSchemaEvidence) {
      return makeResolution(relationship, {
        targetSourceId: null,
        relationType,
        classification: registryMatches.length > 1 ? 'ambiguous' : 'heuristic',
        candidateSourceIds: stableCandidateIds(registryMatches),
        requiresTargetedRead: false,
        reason:
          'Registry ID evidence lacks a corroborating source schema and is not sufficient for an exact link.',
      });
    }
    return resolutionForDefinitiveMatches(
      relationship,
      relationType,
      registryMatches,
      'registry ID within the source schema'
    );
  }

  const archiveMatches = findArchiveMatches(relationship.evidence, linkableSourceObjects);
  if (archiveMatches.length > 0) {
    return resolutionForDefinitiveMatches(
      relationship,
      relationType,
      archiveMatches,
      'unique archive path or attachment hash'
    );
  }

  if (relationType === EMBEDDED_ENTRY_REFERENCE_RELATION_TYPE) {
    return resolveEmbeddedEntryReference(relationship, relationType, linkableSourceObjects);
  }

  const compositeMatches = findCompositeMatches(relationship.evidence, linkableSourceObjects);
  if (compositeMatches.length > 0) {
    const bestScore = compositeMatches[0].score;
    const bestMatches = compositeMatches
      .filter((match) => match.score === bestScore)
      .map((match) => match.sourceObject);

    if (bestMatches.length > 1) {
      return makeResolution(relationship, {
        targetSourceId: null,
        relationType,
        classification: 'ambiguous',
        candidateSourceIds: stableCandidateIds(bestMatches),
        requiresTargetedRead: false,
        reason: 'Multiple source objects share the strongest composite metadata evidence.',
      });
    }

    const [bestMatch] = bestMatches;
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: 'heuristic',
      candidateSourceIds: [stableObjectId(bestMatch)],
      requiresTargetedRead: false,
      reason:
        bestScore >= 2
          ? 'Composite metadata corroborates one candidate but lacks a stable unique identifier.'
          : 'Only one weak metadata dimension matches; it is not sufficient for an exact link.',
    });
  }

  const targetUrlAuthority = targetSourceId
    ? selectedSnapshotStableIdsAreAuthoritative
      ? selectedSnapshotRelationshipTargetUrlAuthority(
          relationship,
          targetSourceId,
          benchlingOrigin
        )
      : relationshipTargetUrlAuthority(relationship, targetSourceId, benchlingOrigin)
    : ({ kind: 'missing' } as const);
  if (targetUrlAuthority.kind === 'conflicting') {
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: 'ambiguous',
      candidateSourceIds: targetSourceId ? [targetSourceId] : [],
      requiresTargetedRead: false,
      reason: 'The relationship contains conflicting canonical route evidence for one target.',
    });
  }
  const requiresTargetedRead =
    !selectedSnapshotStableIdsAreAuthoritative && targetUrlAuthority.kind === 'authorized';
  return makeResolution(relationship, {
    targetSourceId,
    relationType,
    classification: 'unresolved',
    candidateSourceIds: [],
    requiresTargetedRead,
    reason: requiresTargetedRead
      ? 'The expected readable Benchling target is absent from the offline snapshot.'
      : selectedSnapshotStableIdsAreAuthoritative &&
          targetSourceId &&
          targetUrlAuthority.kind === 'authorized'
        ? 'The stable target is absent from the immutable selected snapshot and is preserved without fetching.'
        : targetSourceId && targetUrlAuthority.kind === 'missing'
          ? 'The stable target is missing exact route-bound URL authority for a targeted read.'
          : targetSourceId && targetUrlAuthority.kind === 'invalid'
            ? 'The target route evidence is not exact canonical authority for a targeted read.'
            : 'No stable target identity or matching offline object is available.',
  });
}

function resolveEmbeddedEntryReference(
  relationship: SourceRelationship,
  relationType: string,
  sourceObjects: readonly SourceObject[]
): RelationshipResolution {
  const titles = [...new Set(evidenceValues(relationship.evidence, 'name').map(normalizeText))];
  if (titles.length !== 1) {
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: titles.length > 1 ? 'ambiguous' : 'unresolved',
      candidateSourceIds: [],
      requiresTargetedRead: false,
      reason:
        titles.length > 1
          ? 'The embedded Benchling entry card contains conflicting title evidence.'
          : 'The embedded Benchling entry card has no usable title evidence.',
    });
  }

  const [title] = titles;
  const matches = uniqueObjects(
    sourceObjects.filter(
      (sourceObject) =>
        sourceObject.id !== relationship.sourceObjectId &&
        stableObjectId(sourceObject) !== relationship.sourceObjectId &&
        isNotebookSourceObject(sourceObject) &&
        normalizeText(sourceObject.name) === title
    )
  );
  if (matches.length === 1) {
    const targetSourceId = stableObjectId(matches[0]);
    return makeResolution(relationship, {
      targetSourceId,
      relationType,
      classification: 'exact',
      candidateSourceIds: [targetSourceId],
      requiresTargetedRead: false,
      reason: 'Resolved from one exact notebook title in the immutable selected snapshot.',
    });
  }
  if (matches.length > 1) {
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: 'ambiguous',
      candidateSourceIds: stableCandidateIds(matches),
      requiresTargetedRead: false,
      reason: 'Multiple notebook entries share the embedded Benchling entry-card title.',
    });
  }
  return makeResolution(relationship, {
    targetSourceId: null,
    relationType,
    classification: 'unresolved',
    candidateSourceIds: [],
    requiresTargetedRead: false,
    reason: 'No notebook entry in the immutable selected snapshot has the embedded card title.',
  });
}

function isNotebookSourceObject(sourceObject: SourceObject): boolean {
  const sourceType = normalizeText(sourceObject.sourceType).replace(/[\s-]+/gu, '_');
  return sourceType === 'notebook' || sourceType === 'notebook_entry';
}

function resolutionForDefinitiveMatches(
  relationship: SourceRelationship,
  relationType: string,
  matches: readonly SourceObject[],
  evidenceDescription: string
): RelationshipResolution {
  if (matches.length > 1) {
    return makeResolution(relationship, {
      targetSourceId: null,
      relationType,
      classification: 'ambiguous',
      candidateSourceIds: stableCandidateIds(matches),
      requiresTargetedRead: false,
      reason: `Multiple source objects match the ${evidenceDescription}.`,
    });
  }

  const [match] = matches;
  const matchId = stableObjectId(match);
  return makeResolution(relationship, {
    targetSourceId: matchId,
    relationType,
    classification: 'exact',
    candidateSourceIds: [matchId],
    requiresTargetedRead: false,
    reason: `Resolved from a ${evidenceDescription}.`,
  });
}

function findStableMatches(
  relationship: SourceRelationship,
  sourceObjects: readonly SourceObject[],
  benchlingOrigin: string | undefined,
  targetSourceId: string | null,
  selectedSnapshotStableIdsAreAuthoritative: boolean
): SourceObject[] {
  const stableIds = new Set<string>();
  if (relationship.targetSourceId?.trim()) stableIds.add(relationship.targetSourceId.trim());
  for (const evidence of relationship.evidence) {
    if (evidence.kind === 'stable_id' && evidence.value.trim()) {
      stableIds.add(evidence.value.trim());
    }
  }

  if (stableIds.size > 0) {
    const exactIdMatches = sourceObjects.filter(
      (sourceObject) => stableIds.has(sourceObject.id) || stableIds.has(sourceObject.stableId)
    );
    if (selectedSnapshotStableIdsAreAuthoritative) {
      return selectedSnapshotStableMatches(
        relationship,
        exactIdMatches,
        targetSourceId,
        benchlingOrigin
      );
    }
    if (!targetSourceId) return uniqueObjects(exactIdMatches);
    const authority = relationshipTargetUrlAuthority(relationship, targetSourceId, benchlingOrigin);
    if (authority.kind === 'missing') return uniqueObjects(exactIdMatches);
    if (authority.kind !== 'authorized' || !benchlingOrigin) return [];
    return uniqueObjects(
      exactIdMatches.filter(
        (sourceObject) =>
          canonicalItemUrlOrNull(sourceObject.sourceUrl, targetSourceId, benchlingOrigin) ===
          authority.url
      )
    );
  }

  const urls = [
    relationship.targetUrl,
    ...relationship.evidence
      .filter((evidence) => evidence.kind === 'url')
      .map((evidence) => evidence.value),
  ].filter((value): value is string => Boolean(value?.trim()));

  return uniqueObjects(
    sourceObjects.filter((sourceObject) => {
      return urls.some((url) => {
        if (canonicalUrl(url) === canonicalUrl(sourceObject.sourceUrl)) return true;
        return (
          urlContainsStableId(url, sourceObject.id) ||
          urlContainsStableId(url, sourceObject.stableId)
        );
      });
    })
  );
}

function selectedSnapshotStableMatches(
  relationship: SourceRelationship,
  exactIdMatches: readonly SourceObject[],
  targetSourceId: string | null,
  benchlingOrigin: string | undefined
): SourceObject[] {
  if (exactIdMatches.length === 0 || !targetSourceId) return [];
  const urls = relationshipTargetUrls(relationship);
  if (urls.length === 0) return uniqueObjects(exactIdMatches);
  if (!benchlingOrigin) return [];
  const authority = selectedSnapshotRelationshipTargetUrlAuthority(
    relationship,
    targetSourceId,
    benchlingOrigin
  );
  return authority.kind === 'authorized' ? uniqueObjects(exactIdMatches) : [];
}

export function inferredSelectedSnapshotOrganizationBaseUrl(
  relationships: readonly SourceRelationship[]
): string | undefined {
  const organizationBaseUrls = new Set<string>();
  for (const relationship of relationships) {
    if (relationship.direction !== 'outbound') continue;
    for (const value of relationshipTargetUrls(relationship)) {
      try {
        organizationBaseUrls.add(benchlingOrganizationBaseUrlFromSourceUrl(value));
      } catch {}
    }
  }
  return organizationBaseUrls.size === 1 ? [...organizationBaseUrls][0] : undefined;
}

function findRegistryMatches(
  evidence: readonly RelationshipEvidence[],
  sourceObjects: readonly SourceObject[]
): SourceObject[] {
  const registryIds = evidenceValues(evidence, 'registry_id').map(normalizeText);
  if (registryIds.length === 0) return [];

  let matches = sourceObjects.filter(
    (sourceObject) =>
      sourceObject.registryId != null &&
      registryIds.includes(normalizeText(sourceObject.registryId))
  );

  const schemaOrType = evidenceValues(evidence, 'source_type').map(normalizeText);
  if (schemaOrType.length > 0) {
    const scopedMatches = matches.filter((sourceObject) =>
      schemaOrType.some(
        (value) =>
          value === normalizeText(sourceObject.schemaId ?? '') ||
          value === normalizeText(sourceObject.sourceType)
      )
    );
    matches = scopedMatches;
  }

  return uniqueObjects(matches);
}

function findArchiveMatches(
  evidence: readonly RelationshipEvidence[],
  sourceObjects: readonly SourceObject[]
): SourceObject[] {
  const archivePaths = evidenceValues(evidence, 'archive_path').map(normalizeArchivePath);
  const attachmentHashes = evidenceValues(evidence, 'attachment_hash').map(normalizeHash);

  if (archivePaths.length === 0 && attachmentHashes.length === 0) return [];

  return uniqueObjects(
    sourceObjects.filter((sourceObject) => {
      const pathMatches =
        sourceObject.sourcePath != null &&
        archivePaths.includes(normalizeArchivePath(sourceObject.sourcePath));
      const hashMatches = sourceObject.attachmentHashes.some((hash) =>
        attachmentHashes.includes(normalizeHash(hash))
      );
      return pathMatches || hashMatches;
    })
  );
}

function findCompositeMatches(
  evidence: readonly RelationshipEvidence[],
  sourceObjects: readonly SourceObject[]
): CandidateMatch[] {
  const matches = sourceObjects
    .map((sourceObject) => ({
      sourceObject,
      score: compositeEvidenceScore(evidence, sourceObject),
    }))
    .filter((match) => match.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || compareSourceObjects(left.sourceObject, right.sourceObject)
    );
  return matches;
}

function compositeEvidenceScore(
  evidence: readonly RelationshipEvidence[],
  sourceObject: SourceObject
): number {
  const dimensions = new Set<'label' | 'timestamp' | 'type' | 'sequence'>();

  const names = evidenceValues(evidence, 'name').map(normalizeText);
  const aliases = evidenceValues(evidence, 'alias').map(normalizeText);
  const objectLabels = [sourceObject.name, ...sourceObject.aliases].map(normalizeText);
  if (
    names.some((name) => objectLabels.includes(name)) ||
    aliases.some((alias) => objectLabels.includes(alias))
  ) {
    dimensions.add('label');
  }

  const timestamps = evidenceValues(evidence, 'timestamp').map(normalizeTimestamp);
  const objectTimestamps = [sourceObject.createdAt, sourceObject.modifiedAt]
    .filter((value): value is string => Boolean(value))
    .map(normalizeTimestamp);
  if (timestamps.some((timestamp) => objectTimestamps.includes(timestamp))) {
    dimensions.add('timestamp');
  }

  const types = evidenceValues(evidence, 'source_type').map(normalizeText);
  if (
    types.includes(normalizeText(sourceObject.sourceType)) ||
    types.includes(normalizeText(sourceObject.schemaId ?? ''))
  ) {
    dimensions.add('type');
  }

  const sequences = evidenceValues(evidence, 'sequence_identity').map(normalizeSequenceIdentity);
  const objectSequences = sourceObjectSequenceIdentities(sourceObject);
  if (sequences.some((sequence) => objectSequences.includes(sequence))) {
    dimensions.add('sequence');
  }

  return dimensions.size;
}

function sourceObjectSequenceIdentities(sourceObject: SourceObject): string[] {
  const identities: string[] = [];
  const metadataKeys = ['sequence', 'sequenceIdentity', 'sequenceHash', 'sequenceSha256'];
  for (const key of metadataKeys) {
    const value = sourceObject.metadata[key];
    if (typeof value === 'string') identities.push(normalizeSequenceIdentity(value));
  }

  if (sourceObject.content && typeof sourceObject.content === 'object') {
    const content = sourceObject.content as Record<string, unknown>;
    for (const key of ['sequence', 'bases', 'aminoAcids']) {
      const value = content[key];
      if (typeof value === 'string') identities.push(normalizeSequenceIdentity(value));
    }
  }

  return [...new Set(identities)];
}

function collectTargetedReadAuthority(
  relationships: readonly SourceRelationship[],
  resolutions: readonly RelationshipResolution[],
  benchlingOrigin: string | undefined
): {
  pending: Map<string, { targetSourceUrl: string; relationshipIds: Set<string> }>;
  conflictingTargetIds: Set<string>;
} {
  const relationshipsById = new Map(
    relationships.map((relationship) => [relationship.id, relationship])
  );
  const pending = new Map<string, { targetSourceUrl: string; relationshipIds: Set<string> }>();
  const conflictingTargetIds = new Set<string>();

  for (const resolution of resolutions) {
    if (!resolution.requiresTargetedRead || !resolution.targetSourceId) continue;
    const relationship = relationshipsById.get(resolution.relationshipId);
    if (!relationship) continue;
    const authority = relationshipTargetUrlAuthority(
      relationship,
      resolution.targetSourceId,
      benchlingOrigin
    );
    if (authority.kind !== 'authorized') continue;
    const current = pending.get(resolution.targetSourceId);
    if (current && current.targetSourceUrl !== authority.url) {
      conflictingTargetIds.add(resolution.targetSourceId);
      current.relationshipIds.add(resolution.relationshipId);
      continue;
    }
    const next = current ?? {
      targetSourceUrl: authority.url,
      relationshipIds: new Set<string>(),
    };
    next.relationshipIds.add(resolution.relationshipId);
    pending.set(resolution.targetSourceId, next);
  }

  return { pending, conflictingTargetIds };
}

function relationshipTargetUrlAuthority(
  relationship: SourceRelationship,
  targetSourceId: string,
  benchlingOrigin: string | undefined
): TargetUrlAuthority {
  const values = relationshipTargetUrls(relationship);
  if (values.length === 0) return { kind: 'missing' };
  if (!benchlingOrigin) return { kind: 'invalid' };

  const canonicalUrls = new Set<string>();
  for (const value of values) {
    const canonical = canonicalItemUrlOrNull(value, targetSourceId, benchlingOrigin);
    if (!canonical) return { kind: 'invalid' };
    canonicalUrls.add(canonical);
  }
  if (canonicalUrls.size !== 1) return { kind: 'conflicting' };
  return { kind: 'authorized', url: [...canonicalUrls][0] };
}

function selectedSnapshotRelationshipTargetUrlAuthority(
  relationship: SourceRelationship,
  targetSourceId: string,
  benchlingOrigin: string | undefined
): TargetUrlAuthority {
  const values = relationshipTargetUrls(relationship);
  if (values.length === 0) return { kind: 'missing' };
  if (!benchlingOrigin) return { kind: 'invalid' };

  const canonicalUrls = new Set<string>();
  for (const value of values) {
    const canonical = selectedSnapshotCanonicalRelationshipUrlOrNull(
      value,
      targetSourceId,
      benchlingOrigin
    );
    if (!canonical) return { kind: 'invalid' };
    canonicalUrls.add(canonical);
  }
  if (canonicalUrls.size !== 1) return { kind: 'conflicting' };
  return { kind: 'authorized', url: [...canonicalUrls][0] };
}

export function selectedSnapshotRelationshipTargetAuthority(input: {
  relationship: SourceRelationship;
  targetSourceId: string;
  benchlingOrganizationBaseUrl: string | undefined;
}): SelectedSnapshotRelationshipTargetAuthority {
  const { relationship, targetSourceId, benchlingOrganizationBaseUrl } = input;
  const values = relationshipTargetUrls(relationship);
  if (values.length === 0) return { kind: 'missing' };
  if (!benchlingOrganizationBaseUrl) return { kind: 'invalid' };

  const canonicalUrls = new Set<string>();
  const observedUrls: string[] = [];
  for (const value of values) {
    const canonical = selectedSnapshotCanonicalRelationshipUrlOrNull(
      value,
      targetSourceId,
      benchlingOrganizationBaseUrl
    );
    const observed = exactObservedBenchlingHttpsUrlOrNull(value, benchlingOrganizationBaseUrl);
    if (!canonical || !observed) return { kind: 'invalid' };
    canonicalUrls.add(canonical);
    observedUrls.push(observed);
  }
  if (canonicalUrls.size !== 1) return { kind: 'conflicting' };
  return {
    kind: 'authorized',
    canonicalUrl: [...canonicalUrls][0],
    observedUrl: observedUrls[0],
  };
}

function exactObservedBenchlingHttpsUrlOrNull(
  value: string,
  benchlingOrganizationBaseUrl: string
): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !isUrlWithinBenchlingOrganization(url.toString(), benchlingOrganizationBaseUrl)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function selectedSnapshotCanonicalRelationshipUrlOrNull(
  value: string,
  targetSourceId: string,
  benchlingOrigin: string
): string | null {
  if (!isUrlWithinBenchlingOrganization(value, benchlingOrigin)) return null;
  try {
    const url = new URL(value, `${benchlingOrigin.replace(/\/+$/u, '')}/`);
    if (url.search || url.hash) return null;
    const encodedSegments = url.pathname.split('/').filter(Boolean);
    const decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
    if (decodedSegments.at(-1) === 'edit' || decodedSegments.at(-1) === 'sbs') {
      decodedSegments.pop();
      encodedSegments.pop();
    }
    const targetIndexes = decodedSegments.flatMap((segment, index) =>
      isExactOrPresentationTargetSegment(segment, targetSourceId) ? [index] : []
    );
    const targetIndex = decodedSegments.length - 1;
    if (targetIndexes.length !== 1 || targetIndexes[0] !== targetIndex) return null;

    const conflictingItemSegment = decodedSegments.slice(0, -1).some((segment) => {
      const candidateId = stableIdAtStartOfPresentationSegment(segment);
      return (
        candidateId !== null &&
        !BENCHLING_FOLDER_ID_PREFIXES.some((prefix) => candidateId.startsWith(prefix))
      );
    });
    if (conflictingItemSegment) return null;

    encodedSegments[targetIndex] = targetSourceId;
    url.pathname = `/${encodedSegments.join('/')}`;
    return url.toString();
  } catch {
    return null;
  }
}

function isExactOrPresentationTargetSegment(segment: string, targetSourceId: string): boolean {
  if (segment === targetSourceId) return true;
  if (!segment.startsWith(`${targetSourceId}-`)) return false;
  const presentation = segment.slice(targetSourceId.length + 1);
  return (
    presentation.length > 0 &&
    presentation !== '.' &&
    presentation !== '..' &&
    !hasForbiddenPresentationCharacter(presentation)
  );
}

function hasForbiddenPresentationCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || character === '/' || character === '\\') {
      return true;
    }
  }
  return false;
}

function stableIdAtStartOfPresentationSegment(segment: string): string | null {
  const candidate = segment.split('-', 1)[0] ?? '';
  return BENCHLING_PATH_ID_PATTERN.test(candidate) ? candidate : null;
}

function relationshipTargetUrls(relationship: SourceRelationship): string[] {
  return [
    relationship.targetUrl,
    ...relationship.evidence
      .filter((evidence) => evidence.kind === 'url')
      .map((evidence) => evidence.value),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function canonicalItemUrlOrNull(
  value: string,
  targetSourceId: string,
  benchlingOrigin: string
): string | null {
  try {
    return canonicalBenchlingItemUrl(value, targetSourceId, benchlingOrigin);
  } catch {
    return null;
  }
}

function expectedTargetId(
  relationship: SourceRelationship,
  benchlingOrigin: string | undefined
): string | null {
  if (relationship.targetSourceId?.trim()) return relationship.targetSourceId.trim();
  const evidenceId = firstEvidenceValue(relationship.evidence, 'stable_id');
  if (evidenceId?.trim()) return evidenceId.trim();
  const url = relationship.targetUrl ?? firstEvidenceValue(relationship.evidence, 'url');
  return url ? extractExactBenchlingTargetId(url, benchlingOrigin) : null;
}

function stableTargetIds(relationship: SourceRelationship): string[] {
  const values = [
    relationship.targetSourceId,
    ...relationship.evidence
      .filter((evidence) => evidence.kind === 'stable_id')
      .map((evidence) => evidence.value),
  ];
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].sort();
}

function extractExactBenchlingTargetId(
  rawUrl: string,
  benchlingOrigin: string | undefined
): string | null {
  if (!benchlingOrigin) return null;
  try {
    const parsed = new URL(rawUrl, `${benchlingOrigin.replace(/\/+$/u, '')}/`);
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (segments.at(-1) === 'edit' || segments.at(-1) === 'sbs') segments.pop();

    const protocolIndex = segments.lastIndexOf('protocols');
    if (
      protocolIndex >= 0 &&
      protocolIndex === segments.length - 3 &&
      /^[A-Za-z0-9_-]+$/u.test(segments[protocolIndex + 1] ?? '')
    ) {
      const protocolId = `prt_${segments[protocolIndex + 1]}`;
      return canonicalItemUrlOrNull(rawUrl, protocolId, benchlingOrigin) ? protocolId : null;
    }

    const terminal = segments.at(-1) ?? '';
    if (!BENCHLING_EXACT_TARGET_ID_PATTERN.test(terminal)) return null;
    const conflictingItemSegment = segments
      .slice(0, -1)
      .some(
        (segment) =>
          BENCHLING_PATH_ID_PATTERN.test(segment) &&
          !BENCHLING_FOLDER_ID_PREFIXES.some((prefix) => segment.startsWith(prefix))
      );
    if (conflictingItemSegment) return null;
    return canonicalItemUrlOrNull(rawUrl, terminal, benchlingOrigin) ? terminal : null;
  } catch {
    return null;
  }
}

function isBenchlingUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === 'benchling.com' || hostname.endsWith('.benchling.com');
  } catch {
    return false;
  }
}

function isReadableBenchlingUrl(rawUrl: string, benchlingOrigin: string | undefined): boolean {
  if (!benchlingOrigin) return isBenchlingUrl(rawUrl);
  return isUrlWithinBenchlingOrganization(rawUrl, benchlingOrigin);
}

function isExternalTargetUrl(rawUrl: string, benchlingOrigin: string | undefined): boolean {
  return !isReadableBenchlingUrl(rawUrl, benchlingOrigin);
}

function canonicalUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return null;
  }
}

function urlContainsStableId(rawUrl: string, stableId: string): boolean {
  if (!stableId) return false;
  try {
    const parsed = new URL(rawUrl);
    const values = [
      ...parsed.pathname.split('/').map(decodeURIComponent),
      ...[...parsed.searchParams.values()].map(decodeURIComponent),
    ];
    return values.includes(stableId);
  } catch {
    return false;
  }
}

function makeResolution(
  relationship: SourceRelationship,
  values: Omit<RelationshipResolution, 'relationshipId' | 'sourceObjectId' | 'evidence'>
): RelationshipResolution {
  return {
    relationshipId: relationship.id,
    sourceObjectId: relationship.sourceObjectId,
    evidence: relationship.evidence.slice(),
    ...values,
  };
}

function normalizeRelationType(relationType: string | undefined): string {
  return relationType?.trim() || 'generic';
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function normalizeArchivePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
}

function normalizeHash(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value.trim() : new Date(timestamp).toISOString();
}

function normalizeSequenceIdentity(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function evidenceValues(
  evidence: readonly RelationshipEvidence[],
  kind: RelationshipEvidence['kind']
): string[] {
  return evidence
    .filter((item) => item.kind === kind && item.value.trim())
    .map((item) => item.value);
}

function firstEvidenceValue(
  evidence: readonly RelationshipEvidence[],
  kind: RelationshipEvidence['kind']
): string | null {
  return evidence.find((item) => item.kind === kind && item.value.trim())?.value ?? null;
}

function stableObjectId(sourceObject: SourceObject): string {
  return sourceObject.stableId || sourceObject.id;
}

function stableCandidateIds(sourceObjects: readonly SourceObject[]): string[] {
  return sourceObjects.map(stableObjectId).sort();
}

function uniqueObjects(sourceObjects: readonly SourceObject[]): SourceObject[] {
  const byIdentity = new Map<string, SourceObject>();
  for (const sourceObject of sourceObjects) {
    byIdentity.set(`${sourceObject.id}\u0000${sourceObject.stableId}`, sourceObject);
  }
  return [...byIdentity.values()].sort(compareSourceObjects);
}

function compareSourceObjects(left: SourceObject, right: SourceObject): number {
  return (
    stableObjectId(left).localeCompare(stableObjectId(right)) || left.id.localeCompare(right.id)
  );
}

function compareRelationships(left: SourceRelationship, right: SourceRelationship): number {
  return (
    left.id.localeCompare(right.id) ||
    left.sourceObjectId.localeCompare(right.sourceObjectId) ||
    (left.targetSourceId ?? '').localeCompare(right.targetSourceId ?? '')
  );
}
