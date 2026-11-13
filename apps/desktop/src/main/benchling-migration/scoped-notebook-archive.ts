import type { SourceObject } from '../../shared/benchling-migration';
import { resolveOfflineRelationships } from './relationship-resolver';
import { isUrlWithinBenchlingOrganization } from './source-identity';

export type ScopedNotebookArchiveAuthority = {
  scopeKind: 'folder' | 'folder_tree';
  sourceItemId: string;
  sourceItemUrl: string;
  sourceFolderIds: readonly string[];
  organizationBaseUrl: string;
};

export class ScopedNotebookArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ScopedNotebookArchiveError';
  }
}

export function restrictScopedNotebookArchiveSourceObjects(input: {
  sourceObjects: readonly SourceObject[];
  authority: ScopedNotebookArchiveAuthority;
}): SourceObject[] {
  const { sourceObjects, authority } = input;
  const selectedMatches = sourceObjects.filter(
    (sourceObject) =>
      sourceObject.id === authority.sourceItemId || sourceObject.stableId === authority.sourceItemId
  );
  if (selectedMatches.length !== 1) {
    throw new ScopedNotebookArchiveError(
      'scoped_notebook_archive_identity_ambiguous',
      `${scopeLabel(authority.scopeKind)} export ${authority.sourceItemId} must contain exactly one authorized notebook item; found ${selectedMatches.length}.`
    );
  }

  const selected = selectedMatches[0];
  if (
    !isUrlWithinBenchlingOrganization(selected.sourceUrl, authority.organizationBaseUrl) ||
    canonicalSourceUrl(selected.sourceUrl) !== canonicalSourceUrl(authority.sourceItemUrl)
  ) {
    throw new ScopedNotebookArchiveError(
      'scoped_notebook_archive_identity_conflict',
      `${scopeLabel(authority.scopeKind)} export ${authority.sourceItemId} has an item URL outside the confirmed organization.`
    );
  }
  const expectedMemberships = sortedUnique(authority.sourceFolderIds);
  if (canonicalStrings(selected.memberships) !== canonicalStrings(expectedMemberships)) {
    throw new ScopedNotebookArchiveError(
      'scoped_notebook_archive_membership_conflict',
      `${scopeLabel(authority.scopeKind)} export ${authority.sourceItemId} has memberships outside its immutable item authority.`
    );
  }

  const resolution = resolveOfflineRelationships({
    sourceObjects,
    relationships: selected.relationships,
    benchlingOrigin: authority.organizationBaseUrl,
  });
  const ambiguous = resolution.resolutions.find(
    (candidate) => candidate.classification === 'ambiguous'
  );
  if (ambiguous) {
    throw new ScopedNotebookArchiveError(
      'scoped_notebook_archive_dependency_ambiguous',
      `${scopeLabel(authority.scopeKind)} export ${authority.sourceItemId} contains ambiguous archive identity for relationship ${ambiguous.relationshipId}.`
    );
  }

  const dependencyIds = new Set(
    resolution.resolutions.flatMap((candidate) =>
      candidate.classification === 'exact' && candidate.targetSourceId
        ? [candidate.targetSourceId]
        : []
    )
  );
  const allowed = new Set<SourceObject>([selected]);
  for (const targetSourceId of dependencyIds) {
    const matches = sourceObjects.filter(
      (sourceObject) =>
        sourceObject.id === targetSourceId || sourceObject.stableId === targetSourceId
    );
    if (matches.length !== 1) {
      throw new ScopedNotebookArchiveError(
        'scoped_notebook_archive_dependency_ambiguous',
        `${scopeLabel(authority.scopeKind)} export dependency ${targetSourceId} does not identify exactly one archive object.`
      );
    }
    if (!isUrlWithinBenchlingOrganization(matches[0].sourceUrl, authority.organizationBaseUrl)) {
      throw new ScopedNotebookArchiveError(
        'scoped_notebook_archive_dependency_conflict',
        `${scopeLabel(authority.scopeKind)} export dependency ${targetSourceId} has a URL outside the confirmed organization.`
      );
    }
    allowed.add(matches[0]);
  }

  return sourceObjects
    .filter((sourceObject) => allowed.has(sourceObject))
    .map((sourceObject) =>
      sourceObject === selected
        ? sourceObject
        : {
            ...sourceObject,
            memberships: [],
            relationships: [],
          }
    );
}

function canonicalSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ScopedNotebookArchiveError(
      'scoped_notebook_archive_identity_conflict',
      'Scoped notebook item URL is invalid.'
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new ScopedNotebookArchiveError(
      'scoped_notebook_archive_identity_conflict',
      'Scoped notebook item URL is invalid.'
    );
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function canonicalStrings(values: readonly string[]): string {
  return JSON.stringify(sortedUnique(values));
}

function scopeLabel(scopeKind: ScopedNotebookArchiveAuthority['scopeKind']): string {
  return scopeKind === 'folder' ? 'Direct Folder' : 'Folder Tree';
}
