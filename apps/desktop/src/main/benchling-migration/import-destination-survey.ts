import { withUserMessage } from '@waypoint/user-messages';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type Database from 'better-sqlite3';

import {
  isExactProviderStableId,
  providerObjectReferenceKey,
  providerObjectClassForStableId,
  type ProviderObjectClass,
} from '../../shared/provider-object-reference';
import { inspectNativeExportArchive } from './native-export-archive';
import { tryAcquireWorkspaceMutationShared } from '../workspace-sync-mutation-lease';
import { readLocalRegistryTableRows } from './registry-table-input';
import { surveyRegistryTableReviews } from './registry-table-review';
import type { RegistryTableReviewCandidate } from '../../shared/benchling-registry-table-review';

export type ImportDestinationCandidate = Readonly<{
  workspaceDbId: number;
  workspaceName: string;
  repoUuid: string | null;
  overlapCount: number;
  busy?: boolean;
}>;

export type RankedImportDestination = ImportDestinationCandidate &
  Readonly<{ workspacePath: string }>;

export type ArchiveProviderReference = Readonly<{
  provider: 'benchling';
  stableObjectId: string;
  objectClass: ProviderObjectClass;
}>;

export type ImportDestinationSurvey = Readonly<{
  archiveObjectCount: number;
  candidates: readonly ImportDestinationCandidate[];
  registryTables: readonly RegistryTableReviewCandidate[];
}>;

export function providerStableIdsInArchiveEntryPaths(
  entryPaths: readonly string[]
): ReadonlySet<string> {
  const found = new Set<string>();
  for (const entryPath of entryPaths) {
    const stem = basename(entryPath).replace(/\.[^.]+$/u, '');
    const parenthesised = stem.match(/\(([^()]+)\)\s*$/u);
    const candidate = parenthesised?.[1]?.trim();
    if (!candidate) continue;
    if (!isExactProviderStableId(candidate)) continue;
    if (providerObjectClassForStableId(candidate) === null) continue;
    found.add(candidate);
  }
  return found;
}

export function providerReferencesInArchiveEntryPaths(
  entryPaths: readonly string[]
): ReadonlyMap<string, ArchiveProviderReference> {
  const found = new Map<string, ArchiveProviderReference>();
  for (const stableObjectId of providerStableIdsInArchiveEntryPaths(entryPaths)) {
    const objectClass = providerObjectClassForStableId(stableObjectId);
    if (objectClass === null) continue;
    const reference: ArchiveProviderReference = {
      provider: 'benchling',
      stableObjectId,
      objectClass,
    };
    found.set(providerObjectReferenceKey(reference), reference);
  }
  return found;
}

export function importableProviderStableIdsInArchiveEntryPaths(
  entryPaths: readonly string[]
): ReadonlySet<string> {
  const stableObjectIds = providerStableIdsInArchiveEntryPaths(entryPaths);
  if (stableObjectIds.size === 0) {
    throw withUserMessage(
      new Error(
        'This ZIP does not include Benchling object IDs. In Benchling, export All Items as HTML and choose that ZIP.'
      ),
      'benchling.invalidExport'
    );
  }
  return stableObjectIds;
}

export function rankWorkspacesByProviderOverlap(
  db: Database.Database,
  references: ReadonlyMap<string, ArchiveProviderReference>
): readonly RankedImportDestination[] {
  const identities = [...references.values()];
  const bindingMatchesArchive =
    identities.length > 0
      ? identities
          .map(() => '(b.provider = ? AND b.stable_object_id = ? AND b.object_class = ?)')
          .join(' OR ')
      : '0';
  const identityParameters = identities.flatMap(({ provider, stableObjectId, objectClass }) => [
    provider,
    stableObjectId,
    objectClass,
  ]);
  const rows = db
    .prepare(
      `SELECT w.id AS workspaceDbId,
              w.name AS workspaceName,
              w.path AS workspacePath,
              w.repo_uuid AS repoUuid,
              COUNT(DISTINCT b.provider || char(0) || b.stable_object_id || char(0) || b.object_class) AS overlapCount
         FROM workspaces w
         LEFT JOIN catalog_entities e
           ON e.workspace_id = w.id
          AND e.status = 'active'
         LEFT JOIN catalog_provider_bindings b
           ON b.entity_id = e.id
          AND (${bindingMatchesArchive})
        WHERE w.archived_at IS NULL
          AND w.trashed_at IS NULL
        GROUP BY w.id, w.name, w.path, w.repo_uuid
        ORDER BY overlapCount DESC, w.id ASC`
    )
    .all(...identityParameters) as Array<{
    workspaceDbId: number;
    workspaceName: string;
    workspacePath: string;
    repoUuid: string | null;
    overlapCount: number;
  }>;
  return rows.map((row) => ({
    workspaceDbId: row.workspaceDbId,
    workspaceName: row.workspaceName,
    workspacePath: row.workspacePath,
    repoUuid: row.repoUuid,
    overlapCount: row.overlapCount,
  }));
}

export type WorkspaceEligibility = 'eligible' | 'missing' | 'read_only' | 'busy';

async function inspectWorkspace(workspacePath: string): Promise<WorkspaceEligibility> {
  try {
    const workspaceStat = await stat(workspacePath);
    if (!workspaceStat.isDirectory()) return 'missing';
  } catch {
    return 'missing';
  }
  try {
    await access(workspacePath, constants.R_OK | constants.W_OK);
  } catch {
    return 'read_only';
  }
  const release = tryAcquireWorkspaceMutationShared(workspacePath);
  if (!release) return 'busy';
  release();
  return 'eligible';
}

export async function eligibleImportDestinations(
  ranked: readonly RankedImportDestination[],
  dependencies: {
    inspectWorkspace?: (workspacePath: string) => Promise<WorkspaceEligibility>;
  } = {}
): Promise<readonly ImportDestinationCandidate[]> {
  const inspect = dependencies.inspectWorkspace ?? inspectWorkspace;
  const inspected = await Promise.all(
    ranked.map(async (candidate) => ({
      candidate,
      eligibility: await inspect(candidate.workspacePath),
    }))
  );
  return inspected.flatMap(({ candidate, eligibility }) => {
    if (eligibility !== 'eligible' && eligibility !== 'busy') return [];
    const { workspacePath: _workspacePath, ...presentation } = candidate;
    return [{ ...presentation, ...(eligibility === 'busy' ? { busy: true } : {}) }];
  });
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve());
  });
  return hash.digest('hex');
}

export async function surveyImportDestinations(input: {
  archivePath: string;
  globalDb: Database.Database;
  managedRootDir: string;
  inspect?: typeof inspectNativeExportArchive;
}): Promise<ImportDestinationSurvey> {
  const [{ size }, sha256] = await Promise.all([
    stat(input.archivePath),
    sha256OfFile(input.archivePath),
  ]);
  const inspect = input.inspect ?? inspectNativeExportArchive;
  const archive = await inspect({
    kind: 'local_path',
    logicalFilename: basename(input.archivePath),
    localPath: input.archivePath,
    expectedSha256: sha256,
    expectedSizeBytes: size,
    duplicateSupportEntryPolicy: 'identical_root_benchling_css',
  });
  const entryPaths = archive.entries.map((entry) => entry.path);
  const references = new Map(providerReferencesInArchiveEntryPaths(entryPaths));
  for (const { sourceObject } of await readLocalRegistryTableRows(archive)) {
    const reference: ArchiveProviderReference = {
      provider: 'benchling',
      stableObjectId: sourceObject.stableId,
      objectClass: 'registry_entity',
    };
    references.set(providerObjectReferenceKey(reference), reference);
  }
  const registryTables = await surveyRegistryTableReviews(archive);
  if (references.size === 0 && registryTables.length === 0)
    importableProviderStableIdsInArchiveEntryPaths(entryPaths);
  return {
    archiveObjectCount: references.size,
    registryTables,
    candidates: await eligibleImportDestinations(
      rankWorkspacesByProviderOverlap(input.globalDb, references)
    ),
  };
}
