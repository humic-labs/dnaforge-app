import {
  isExactProviderStableId,
  isSafeProviderCanonicalUrl,
  type ProviderObjectReference,
  type ProviderReferenceResolution,
} from '../../shared/provider-object-reference';

export type ProviderBindingCandidate = {
  entityId: string;
  objectClass: string;
  bindingKind: 'observed' | 'reviewed';
  scope: 'workspace' | 'registry';
  workspaceId: string | null;
  providerAccountHint: string | null;
  corroborationConflict?: boolean;
};

export type ProviderReferenceDisposition = 'pending' | 'external' | 'source_broken';

export type ProviderReferenceResolutionInput = {
  reference: ProviderObjectReference | null;
  disposition?: ProviderReferenceDisposition;
  sourceUrl?: string | null;
  brokenReason?: string | null;
  destinationWorkspaceId?: string | null;
  allowedWorkspaceIds?: readonly string[];
  allowedRegistryEntityIds?: readonly string[];
  candidates?: readonly ProviderBindingCandidate[];
};

export function resolveProviderReference(
  input: ProviderReferenceResolutionInput
): ProviderReferenceResolution {
  if (input.disposition === 'source_broken') {
    return {
      status: 'source_broken',
      reason: input.brokenReason?.trim() || 'The source link is broken in the export.',
    };
  }
  if (input.disposition === 'external') {
    const sourceUrl = input.sourceUrl?.trim();
    return isSafeProviderCanonicalUrl(sourceUrl)
      ? { status: 'external', sourceUrl }
      : { status: 'pending', reason: 'identity_missing' };
  }

  const reference = input.reference;
  if (!reference || !isExactProviderStableId(reference.stableObjectId)) {
    return { status: 'pending', reason: 'identity_missing' };
  }

  const allowedWorkspaceIds = new Set(input.allowedWorkspaceIds ?? []);
  if (input.destinationWorkspaceId) allowedWorkspaceIds.add(input.destinationWorkspaceId);
  const allowedRegistryEntityIds = new Set(input.allowedRegistryEntityIds ?? []);

  const allowed = (input.candidates ?? []).filter((candidate) => {
    if (candidate.objectClass !== reference.objectClass) return false;
    if (candidate.scope === 'registry') return allowedRegistryEntityIds.has(candidate.entityId);
    return candidate.workspaceId !== null && allowedWorkspaceIds.has(candidate.workspaceId);
  });

  const conflicting = allowed.filter((candidate) => candidate.corroborationConflict === true);
  if (conflicting.length > 0) {
    return {
      status: 'ambiguous',
      candidateEntityIds: distinctEntityIds(conflicting),
      reason: 'identity_conflict',
    };
  }

  if (allowed.length === 0) {
    return { status: 'pending', reason: 'target_not_imported' };
  }

  const byEntity = new Map<string, ProviderBindingCandidate[]>();
  for (const candidate of allowed) {
    const existing = byEntity.get(candidate.entityId);
    if (existing) existing.push(candidate);
    else byEntity.set(candidate.entityId, [candidate]);
  }

  if (byEntity.size === 1) {
    return resolvedFrom([...byEntity.values()][0]);
  }

  if (input.destinationWorkspaceId) {
    const local = [...byEntity.values()].filter((rows) =>
      rows.some((row) => row.workspaceId === input.destinationWorkspaceId)
    );
    if (local.length === 1) return resolvedFrom(local[0]);
  }

  if (reference.providerAccountHint) {
    const hinted = [...byEntity.values()].filter((rows) =>
      rows.some(
        (row) =>
          row.providerAccountHint === null ||
          row.providerAccountHint === reference.providerAccountHint
      )
    );
    if (hinted.length === 1) return resolvedFrom(hinted[0]);
  }

  const reviewed = [...byEntity.values()].filter((rows) =>
    rows.some((row) => row.bindingKind === 'reviewed')
  );
  if (reviewed.length === 1) return resolvedFrom(reviewed[0]);

  return {
    status: 'ambiguous',
    candidateEntityIds: distinctEntityIds(allowed),
    reason: 'multiple_exact_candidates',
  };
}

function resolvedFrom(rows: readonly ProviderBindingCandidate[]): ProviderReferenceResolution {
  const row = rows.find((entry) => entry.scope === 'workspace') ?? rows[0];
  const reviewed = rows.some((entry) => entry.bindingKind === 'reviewed');
  return {
    status: 'resolved',
    entityId: row.entityId,
    scope: row.scope,
    evidence: reviewed ? 'reviewed_mapping' : 'stable_id',
  };
}

function distinctEntityIds(candidates: readonly ProviderBindingCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.entityId))].sort();
}
