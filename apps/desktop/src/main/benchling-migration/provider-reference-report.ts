import {
  PROVIDER_REFERENCE_OUTCOMES,
  type RelationshipResolution,
  type SourceObject,
  type ValidationProviderReferenceDetail,
  type ValidationProviderReferenceEvidence,
  type ValidationProviderReferenceOutcome,
} from '../../shared/benchling-migration';

export const PROVIDER_REFERENCE_DETAIL_LIMIT = 200;

const MAX_TITLE_LENGTH = 120;

const PATH_LIKE = /(?:^|[\s'"`(=:])(?:\/(?!\/)|[a-z]:[\\/]|\\\\)/iu;
const MARKUP_LIKE = /[<>]/u;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

function safeReferenceTitle(candidate: string | undefined): string | null {
  const title = candidate?.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) return null;
  if (PATH_LIKE.test(title) || MARKUP_LIKE.test(title) || CONTROL_CHARACTERS.test(title)) {
    return null;
  }
  return title;
}

function outcomeFor(
  resolution: RelationshipResolution,
  importedStableIds: ReadonlySet<string>
): ValidationProviderReferenceOutcome {
  switch (resolution.classification) {
    case 'external':
      return 'external';
    case 'source_broken':
      return 'source_broken';
    case 'ambiguous':
    case 'heuristic':
      return 'ambiguous';
    case 'exact':
    case 'unresolved': {
      const stableId = resolution.targetSourceId?.trim();
      return stableId && importedStableIds.has(stableId) ? 'resolved' : 'pending';
    }
  }
}

function actionFor(
  outcome: ValidationProviderReferenceOutcome
): ValidationProviderReferenceDetail['action'] {
  switch (outcome) {
    case 'resolved':
      return 'none';
    case 'pending':
      return 'add_export';
    case 'ambiguous':
      return 'review';
    case 'external':
      return 'open_in_benchling';
    case 'source_broken':
      return 'unavailable';
  }
}

export function summarizeProviderReferenceOutcomes(input: {
  sourceObjects: readonly SourceObject[];
  resolutions: readonly RelationshipResolution[];
  detailLimit?: number;
}): ValidationProviderReferenceEvidence {
  const detailLimit = input.detailLimit ?? PROVIDER_REFERENCE_DETAIL_LIMIT;
  const namesByStableId = new Map<string, string>();
  const classByStableId = new Map<string, string>();
  const importedStableIds = new Set<string>();
  for (const sourceObject of input.sourceObjects) {
    namesByStableId.set(sourceObject.stableId, sourceObject.name);
    classByStableId.set(sourceObject.stableId, sourceObject.sourceType);
    importedStableIds.add(sourceObject.stableId);
  }

  const counts = Object.fromEntries(
    PROVIDER_REFERENCE_OUTCOMES.map((outcome) => [outcome, 0])
  ) as Record<ValidationProviderReferenceOutcome, number>;

  const seen = new Set<string>();
  const details: ValidationProviderReferenceDetail[] = [];
  const sorted = [...input.resolutions].sort((left, right) =>
    left.relationshipId.localeCompare(right.relationshipId)
  );
  for (const resolution of sorted) {
    if (seen.has(resolution.relationshipId)) continue;
    seen.add(resolution.relationshipId);
    const outcome = outcomeFor(resolution, importedStableIds);
    counts[outcome] += 1;
    if (details.length >= detailLimit) continue;
    const stableId = resolution.targetSourceId?.trim() || null;
    details.push({
      relationshipId: resolution.relationshipId,
      targetStableObjectId: stableId,
      objectClass:
        (stableId && classByStableId.get(stableId)) || resolution.relationType || 'unknown',
      outcome,
      title: stableId ? safeReferenceTitle(namesByStableId.get(stableId)) : null,
      action: actionFor(outcome),
    });
  }

  return {
    schema: 'dnaforge.benchling.provider-reference-outcomes.v1',
    counts,
    total: seen.size,
    details,
    truncated: seen.size > details.length,
  };
}
