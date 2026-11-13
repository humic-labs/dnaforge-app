import { randomUUID } from 'node:crypto';
import { reviewedTableSourceRef, assertReviewedTableDecision } from './reviewed-table-source';
import type { BenchlingMigrationAllocationIdentity } from '../../shared/benchling-migration-action-journal';
import { open, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readBoundedWorkspaceFile } from './bounded-workspace-file';
import { syncDirectory } from '../fs-durability';
import type Database from 'better-sqlite3';

import {
  advanceBenchlingMigrationAllocations,
  parseBenchlingMigrationActionJournal,
  type BenchlingMigrationActionJournal,
  type BenchlingMigrationActionAllocation,
  type BenchlingMigrationInstallState,
} from '../../shared/benchling-migration-action-journal';
import type { ImportDecision, Sha256Digest } from '../../shared/benchling-import-decision';
import type {
  MigrationRun,
  ProjectionDestination,
  SourceObject,
} from '../../shared/benchling-migration';
import {
  providerObjectClassForStableId,
  isExactProviderStableId,
} from '../../shared/provider-object-reference';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  parseNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';
import {
  allocateBenchlingDestination,
  safeDestinationSegment,
  type DestinationReservation,
} from './destination-name-allocator';
import { projectionDestinationObjectId, projectionDestinationVariant } from './projection';
import { createKeyedMutex } from '../workspace-git/keyed-mutex';
import { isGitRepo, resolveHeadCommit } from '../workspace-git';
import { readNativeSourceFolderMemberships } from './native-source-memberships';

export const BENCHLING_MIGRATION_ACTIONS_RELATIVE_PATH = '.dnaforge/migration/actions' as const;
const actionJournalMutationMutex = createKeyedMutex();
type AllocationCheckpoint = Parameters<typeof advancePersistedBenchlingMigrationAllocation>[0];
type PendingCheckpoint = {
  input: AllocationCheckpoint;
  resolve(journal: BenchlingMigrationActionJournal): void;
  reject(error: unknown): void;
};
const installationCheckpointQueues = new Map<string, PendingCheckpoint[]>();
let journalObserverForTest:
  | ((workspacePath: string, journal: BenchlingMigrationActionJournal) => Promise<void>)
  | undefined;

export function setMigrationJournalObserverForTest(observer: typeof journalObserverForTest): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Journal test observer requires the test harness.');
  journalObserverForTest = observer;
}

export function summarizeActionDestinationChanges(
  journal: BenchlingMigrationActionJournal | null
): { added: number; updated: number; retained: number } | undefined {
  if (!journal || journal.allocations.some((allocation) => !allocation.writeDisposition))
    return undefined;
  return {
    added: journal.allocations.filter((allocation) => allocation.writeDisposition === 'create')
      .length,
    updated: journal.allocations.filter((allocation) => allocation.writeDisposition === 'replace')
      .length,
    retained: journal.allocations.filter((allocation) => allocation.writeDisposition === 'retain')
      .length,
  };
}

export function benchlingMigrationActionJournalRelativePath(actionId: string): string {
  return `${BENCHLING_MIGRATION_ACTIONS_RELATIVE_PATH}/${safeActionId(actionId)}.json`;
}

export async function readBenchlingMigrationActionJournal(
  workspacePath: string,
  actionId: string
): Promise<BenchlingMigrationActionJournal | null> {
  const paths = actionJournalPaths(workspacePath, actionId);
  const { primary, pending, selected } = await readJournalCandidates(workspacePath, actionId);
  if (!selected) return null;
  if (selected === pending) {
    await mkdir(dirname(paths.primary), { recursive: true });
    await rename(paths.pending, paths.primary);
    await syncDirectory(dirname(paths.primary));
  } else if (primary) {
    await rm(paths.pending, { force: true });
  }
  return selected;
}

export async function inspectBenchlingMigrationActionJournal(
  workspacePath: string,
  actionId: string
): Promise<BenchlingMigrationActionJournal | null> {
  return (await readJournalCandidates(workspacePath, actionId)).selected;
}

async function readJournalCandidates(workspacePath: string, actionId: string) {
  const paths = actionJournalPaths(workspacePath, actionId);
  const [primary, pending] = await Promise.all([
    readCandidate(workspacePath, paths.primary),
    readCandidate(workspacePath, paths.pending),
  ]);

  if (pending) assertSameJournalIdentity(primary, pending);
  const selected =
    pending && (!primary || Date.parse(pending.updatedAt) > Date.parse(primary.updatedAt))
      ? pending
      : primary;
  return { primary, pending, selected };
}

export async function writeBenchlingMigrationActionJournal(
  workspacePath: string,
  value: BenchlingMigrationActionJournal | unknown
): Promise<BenchlingMigrationActionJournal> {
  const journal = parseBenchlingMigrationActionJournal(value);
  const paths = actionJournalPaths(workspacePath, journal.actionId);
  const existing = await readBenchlingMigrationActionJournal(workspacePath, journal.actionId);
  if (existing) assertImmutableJournalIdentity(existing, journal);
  await assertJournalWorkspace(workspacePath, journal);
  await mkdir(dirname(paths.primary), { recursive: true });
  await writeDurableFile(paths.pending, `${JSON.stringify(journal, null, 2)}\n`);
  await rename(paths.pending, paths.primary);
  await syncDirectory(dirname(paths.primary));
  await journalObserverForTest?.(workspacePath, journal);
  return journal;
}

export async function recoverBenchlingMigrationActionJournal(
  workspacePath: string,
  actionId: string
): Promise<BenchlingMigrationActionJournal | null> {
  return readBenchlingMigrationActionJournal(workspacePath, actionId);
}

export async function advancePersistedBenchlingMigrationAllocation(input: {
  workspacePath: string;
  actionId: string;
  sourceObjectId: string;
  nextState: BenchlingMigrationInstallState;
  updatedAt: string;
}): Promise<BenchlingMigrationActionJournal> {
  if (input.nextState === 'staged' || input.nextState === 'installed') {
    const key = JSON.stringify([resolve(input.workspacePath), input.actionId]);
    return new Promise((resolveCheckpoint, reject) => {
      const request = { input, resolve: resolveCheckpoint, reject };
      const pending = installationCheckpointQueues.get(key);
      if (pending) pending.push(request);
      else {
        const queue = [request];
        installationCheckpointQueues.set(key, queue);
        void flushInstallationCheckpoints(key, queue);
      }
    });
  }
  return advancePersistedBenchlingMigrationAllocations({
    workspacePath: input.workspacePath,
    actionId: input.actionId,
    sourceObjectIds: [input.sourceObjectId],
    nextState: input.nextState,
    updatedAt: input.updatedAt,
  });
}

async function flushInstallationCheckpoints(
  key: string,
  queue: PendingCheckpoint[]
): Promise<void> {
  try {
    while (queue.length > 0) {
      await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
      const first = queue[0];
      if (!first) break;
      await actionJournalMutationMutex(resolve(first.input.workspacePath), async () => {
        const batch = queue.splice(0);
        try {
          const { workspacePath, actionId } = first.input;
          let journal = await readBenchlingMigrationActionJournal(workspacePath, actionId);
          if (!journal) throw new Error('Migration action journal is missing.');
          const currentStates = new Map(
            journal.allocations.map((a) => [a.sourceObjectId, a.installState])
          );
          const requestedStates = new Map<string, BenchlingMigrationInstallState>();
          const groups = new Map<BenchlingMigrationInstallState, string[]>();
          for (const { input } of batch) {
            const requested = requestedStates.get(input.sourceObjectId);
            if (requested && requested !== input.nextState) {
              throw new Error('Migration checkpoints must await the preceding durable state.');
            }
            requestedStates.set(input.sourceObjectId, input.nextState);
            if (!currentStates.has(input.sourceObjectId))
              throw new Error('Migration action allocation is missing.');
            if (currentStates.get(input.sourceObjectId) === input.nextState) continue;
            const ids = groups.get(input.nextState) ?? [];
            ids.push(input.sourceObjectId);
            groups.set(input.nextState, ids);
          }
          const updatedAt = batch.reduce(
            (latest, request) =>
              request.input.updatedAt > latest ? request.input.updatedAt : latest,
            journal.updatedAt
          );
          for (const [state, ids] of groups) {
            journal = advanceBenchlingMigrationAllocations(journal, ids, state, updatedAt);
          }
          if (groups.size > 0)
            journal = await writeBenchlingMigrationActionJournal(workspacePath, journal);
          for (const request of batch) request.resolve(journal);
        } catch (error) {
          for (const request of batch) request.reject(error);
        }
      });
    }
  } catch (error) {
    for (const request of queue.splice(0)) request.reject(error);
  } finally {
    installationCheckpointQueues.delete(key);
  }
}

export async function advancePersistedBenchlingMigrationAllocations(input: {
  workspacePath: string;
  actionId: string;
  sourceObjectIds: readonly string[];
  nextState: BenchlingMigrationInstallState;
  updatedAt: string;
}): Promise<BenchlingMigrationActionJournal> {
  return actionJournalMutationMutex(resolve(input.workspacePath), async () => {
    const current = await readBenchlingMigrationActionJournal(input.workspacePath, input.actionId);
    if (!current) throw new Error('Migration action journal is missing.');
    const bySourceId = new Map(
      current.allocations.map((allocation) => [allocation.sourceObjectId, allocation])
    );
    const pending = [...new Set(input.sourceObjectIds)].filter((sourceObjectId) => {
      const allocation = bySourceId.get(sourceObjectId);
      if (!allocation) throw new Error('Migration action allocation is missing.');
      return allocation.installState !== input.nextState;
    });
    if (pending.length === 0) return current;
    const next = advanceBenchlingMigrationAllocations(
      current,
      pending,
      input.nextState,
      input.updatedAt
    );
    return writeBenchlingMigrationActionJournal(input.workspacePath, next);
  });
}

export async function recordBenchlingMigrationActionCommittedHead(input: {
  workspacePath: string;
  actionId: string;
  expectedPreActionHead: string;
  committedHead: string;
  updatedAt: string;
}): Promise<BenchlingMigrationActionJournal> {
  return actionJournalMutationMutex(resolve(input.workspacePath), async () => {
    const current = await readBenchlingMigrationActionJournal(input.workspacePath, input.actionId);
    if (!current) throw new Error('Migration action journal is missing.');
    if (
      current.durability.kind !== 'managed_git' ||
      current.durability.preActionHead !== input.expectedPreActionHead
    ) {
      throw new Error('Migration action Git baseline changed.');
    }
    if (current.durability.committedHead === input.committedHead) return current;
    if (current.durability.committedHead !== null) {
      throw new Error('Migration action committed HEAD changed.');
    }
    return writeBenchlingMigrationActionJournal(input.workspacePath, {
      ...current,
      durability: { ...current.durability, committedHead: input.committedHead },
      updatedAt: input.updatedAt,
    });
  });
}

export async function recordBenchlingMigrationActionComplete(
  journal: BenchlingMigrationActionJournal,
  now: string
) {
  if (journal.completedAt || (journal.allocations.length > 0 && !journal.effectsCaptureSha256))
    return journal;
  return actionJournalMutationMutex(resolve(journal.workspace.workspacePath), async () => {
    const current = await readBenchlingMigrationActionJournal(
      journal.workspace.workspacePath,
      journal.actionId
    );
    if (!current) throw new Error('Migration completion journal is missing.');
    if (current.completedAt) return current;
    return writeBenchlingMigrationActionJournal(journal.workspace.workspacePath, {
      ...current,
      completedAt: now,
      updatedAt: now,
    });
  });
}

export async function reserveBenchlingMigrationAction(input: {
  run: MigrationRun;
  actionId: string;
  sourceObjects: readonly SourceObject[];
  decisions: readonly ImportDecision[];
  reuseExistingSourceObjectIds?: ReadonlySet<string>;
  destinationDb?: Database.Database;
  reservations?: readonly DestinationReservation[];
  expectedPriorImportedHashBySourceObjectId?: ReadonlyMap<string, Sha256Digest>;
  fixedDestinationsBySourceObjectId?: ReadonlyMap<
    string,
    Readonly<{
      destinationEntityId: string;
      destination: ProjectionDestination;
      expectedPriorImportedHash: Sha256Digest;
    }>
  >;
  loadPersistentReservations?: () => Promise<readonly DestinationReservation[]>;
  now: string;
}): Promise<BenchlingMigrationActionJournal> {
  const { run } = input;
  if (!run.externalZipSource) {
    throw new Error('A new-layout migration action requires an external ZIP source record.');
  }
  const staged =
    run.workspaceOrigin?.kind === 'migration_created' &&
    run.workspaceDbId === undefined &&
    run.repoUuid === run.workspaceId &&
    run.projectionScopeId === run.workspaceId;
  if ((!run.workspaceDbId && !staged) || !run.projectionScopeId) {
    throw new Error('A new-layout migration action requires an authoritative workspace binding.');
  }
  const existing = await readBenchlingMigrationActionJournal(run.workspacePath, input.actionId);
  if (existing) {
    const requestedIds = [...input.sourceObjects].map((sourceObject) => sourceObject.id).sort();
    const existingIds = existing.allocations.map((allocation) => allocation.sourceObjectId).sort();
    if (JSON.stringify(requestedIds) !== JSON.stringify(existingIds)) {
      throw new Error('Persisted migration action allocations do not match the source batch.');
    }
    return existing;
  }

  const allocations: BenchlingMigrationActionAllocation[] = [];
  const preActionHead = isGitRepo(run.workspacePath)
    ? await resolveHeadCommit(run.workspacePath)
    : null;
  const durability: BenchlingMigrationActionJournal['durability'] = preActionHead
    ? { kind: 'managed_git', preActionHead, committedHead: null }
    : { kind: 'local_filesystem' };
  let persistentReservations: readonly DestinationReservation[];
  if (input.loadPersistentReservations) {
    persistentReservations = await input.loadPersistentReservations();
  } else if (input.destinationDb) {
    persistentReservations = await collectPersistentDestinationReservations(
      run.workspacePath,
      run.workspaceDbId ?? null,
      input.actionId,
      input.destinationDb
    );
  } else {
    throw new Error('Migration allocation requires the destination catalog database.');
  }
  const reservations = [...persistentReservations, ...(input.reservations ?? [])];
  for (const sourceObject of [...input.sourceObjects].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const canonicalMembership = canonicalMembershipForSourceObject(sourceObject, run.id);
    const reviewedTable = reviewedTableSourceRef(sourceObject);
    if (reviewedTable) {
      if (reviewedTable.actionId !== input.actionId)
        throw new Error('Reviewed table row belongs to another import action.');
      assertReviewedTableDecision(
        reviewedTable,
        input.decisions.filter((decision) => decision.kind === 'registry_table_mapping')
      );
    }
    const identity: BenchlingMigrationAllocationIdentity = isExactProviderStableId(
      sourceObject.stableId
    )
      ? {
          providerIdentity: {
            provider: 'benchling',
            stableObjectId: sourceObject.stableId,
            objectClass: providerObjectClassForStableId(sourceObject.stableId) ?? 'other',
          },
        }
      : reviewedTable
        ? { providerIdentity: null, reviewedTable }
        : (() => {
            throw new Error(
              'Migration source is missing a verified provider or reviewed table identity.'
            );
          })();
    const fixed = input.fixedDestinationsBySourceObjectId?.get(sourceObject.id);
    if (fixed) {
      const reuseExisting = input.reuseExistingSourceObjectIds?.has(sourceObject.id) ?? false;
      const actionOwnedPaths = reuseExisting
        ? []
        : fixed.destination.kind === 'file'
          ? [fixed.destination.relativePath]
          : fixed.destination.kind === 'package'
            ? [fixed.destination.rootRelativePath]
            : [];
      const fixedAllocation: BenchlingMigrationActionAllocation = {
        writeDisposition: reuseExisting ? 'retain' : 'replace',
        sourceObjectId: sourceObject.id,
        ...identity,
        destinationEntityId: fixed.destinationEntityId,
        destination: fixed.destination,
        canonicalMembership,
        collisionSuffixDecision: { kind: 'none' },
        expectedPriorImportedHash: reuseExisting ? null : fixed.expectedPriorImportedHash,
        actionOwnedPaths: Object.freeze(actionOwnedPaths),
        rollback: { kind: 'none' },
        installState: reuseExisting ? 'installed' : 'reserved',
      };
      allocations.push(fixedAllocation);
      reservations.push(reservationForAllocation(fixedAllocation));
      continue;
    }
    const allocation = await allocateBenchlingDestination({
      actionId: input.actionId,
      workspacePath: run.workspacePath,
      sourceObjectId: sourceObject.id,
      ...identity,
      destinationEntityId: projectionDestinationObjectId(sourceObject),
      displayName: sourceObject.name,
      variant: projectionDestinationVariant(sourceObject),
      canonicalMembership,
      expectedPriorImportedHash:
        input.expectedPriorImportedHashBySourceObjectId?.get(sourceObject.id) ?? null,
      decisions: input.decisions,
      reservations,
      existingAllocations: allocations,
    });
    allocations.push(allocation);
    reservations.push(reservationForAllocation(allocation));
  }

  const journal: BenchlingMigrationActionJournal = {
    schema: 'dnaforge.benchling.migration-action-journal.v1',
    actionId: input.actionId,
    runId: run.id,
    workspace: {
      ...(run.workspaceDbId !== undefined
        ? { workspaceDbId: run.workspaceDbId, repoUuid: run.repoUuid ?? null }
        : { workspaceDbId: null, repoUuid: run.workspaceId }),
      projectionScopeId: run.projectionScopeId,
      workspacePath: resolve(run.workspacePath),
    },
    durability,
    externalSource: run.externalZipSource,
    decisions: input.decisions,
    allocations,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return writeBenchlingMigrationActionJournal(run.workspacePath, journal);
}

async function collectPersistentDestinationReservations(
  workspacePath: string,
  workspaceDbId: number | null,
  currentActionId: string,
  destinationDb: Database.Database
): Promise<DestinationReservation[]> {
  const reservations: DestinationReservation[] = [];
  try {
    const manifest = parseNativeWorkspaceManifest(
      await readFile(join(workspacePath, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')
    );
    for (const entity of manifest.entities) {
      if ('path' in entity) {
        reservations.push({
          relativePath: entity.path,
          kind: entity.fileKind === 'folder' ? 'directory' : 'file',
          ownerSourceObjectId: null,
        });
        continue;
      }
      switch (entity.placement.kind) {
        case 'file':
          reservations.push({
            relativePath: entity.placement.relativePath,
            kind: entity.placement.fileKind === 'folder' ? 'directory' : 'file',
            ownerSourceObjectId: null,
          });
          break;
        case 'package':
          reservations.push({
            relativePath: entity.placement.rootRelativePath,
            kind: 'directory',
            ownerSourceObjectId: null,
          });
          break;
        case 'catalog-record':
          reservations.push({
            relativePath: joinRelative(
              entity.placement.parentRelativePath,
              entity.placement.displayName
            ),
            kind: 'catalog-record',
            ownerSourceObjectId: null,
          });
          break;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const actionsPath = join(workspacePath, BENCHLING_MIGRATION_ACTIONS_RELATIVE_PATH);
  try {
    const entries = await readdir(actionsPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const actionId = entry.name.slice(0, -'.json'.length);
      if (actionId === currentActionId) continue;
      const journal = parseBenchlingMigrationActionJournal(
        JSON.parse(await readFile(join(actionsPath, entry.name), 'utf8'))
      );
      for (const allocation of journal.allocations) {
        reservations.push(reservationForAllocation(allocation));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const placements = destinationDb
    .prepare(
      `SELECT parent_relative_path, display_name
       FROM catalog_workspace_placements
      WHERE workspace_id = ? AND status = 'active'
      ORDER BY parent_relative_path, normalized_sibling_name, entity_id`
    )
    .all(workspaceDbId) as Array<{ parent_relative_path: string; display_name: string }>;
  for (const placement of placements) {
    reservations.push({
      relativePath: joinRelative(placement.parent_relative_path, placement.display_name),
      kind: 'catalog-record',
      ownerSourceObjectId: null,
    });
  }
  return reservations;
}

function reservationForAllocation(
  allocation: BenchlingMigrationActionAllocation
): DestinationReservation {
  return {
    relativePath:
      allocation.destination.kind === 'package'
        ? allocation.destination.rootRelativePath
        : allocation.destination.kind === 'file'
          ? allocation.destination.relativePath
          : joinRelative(
              allocation.destination.parentRelativePath,
              allocation.destination.displayName
            ),
    kind:
      allocation.destination.kind === 'package'
        ? 'directory'
        : allocation.destination.kind === 'file'
          ? 'file'
          : 'catalog-record',
    ownerSourceObjectId: allocation.sourceObjectId,
  };
}

function canonicalMembershipForSourceObject(
  sourceObject: SourceObject,
  scopeId: string
): BenchlingMigrationActionAllocation['canonicalMembership'] {
  const sourceSegments = (sourceObject.sourcePath ?? '')
    .normalize('NFC')
    .replace(/\\/gu, '/')
    .split('/')
    .filter(Boolean);
  if (sourceSegments.length > 0) sourceSegments.pop();
  const hierarchySegments = sourceSegments.map((segment) =>
    safeDestinationSegment(segment, 'Imported folder')
  );
  const nativeMemberships = readNativeSourceFolderMemberships(sourceObject, scopeId);
  const memberships = nativeMemberships.length
    ? nativeMemberships.map((membership) => membership.sourceFolderId)
    : [...new Set(sourceObject.memberships)].sort();
  return Object.freeze({
    sourceFolderId: memberships[0] ?? null,
    hierarchySegments: Object.freeze(hierarchySegments),
    alternateSourceFolderIds: Object.freeze(memberships.slice(1)),
  });
}

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

async function readCandidate(
  workspacePath: string,
  path: string
): Promise<BenchlingMigrationActionJournal | null> {
  try {
    const bytes = await readBoundedWorkspaceFile(
      workspacePath,
      relative(workspacePath, path).replaceAll('\\', '/')
    );
    return parseBenchlingMigrationActionJournal(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function actionJournalPaths(
  workspacePath: string,
  actionId: string
): {
  primary: string;
  pending: string;
} {
  const root = resolve(workspacePath);
  const relativePath = benchlingMigrationActionJournalRelativePath(actionId);
  const primary = resolve(root, relativePath);
  if (!primary.startsWith(`${root}${sep}`))
    throw new Error('Migration action journal escapes workspace.');
  return { primary, pending: `${primary}.pending` };
}

function safeActionId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value)) {
    throw new Error('Migration action ID is unsafe.');
  }
  return value;
}

async function assertJournalWorkspace(
  workspacePath: string,
  journal: BenchlingMigrationActionJournal
): Promise<void> {
  if (resolve(workspacePath) !== resolve(journal.workspace.workspacePath)) {
    throw new Error('Migration action journal workspace path does not match its owner.');
  }
}

function assertSameJournalIdentity(
  left: BenchlingMigrationActionJournal | null,
  right: BenchlingMigrationActionJournal
): void {
  if (!left) return;
  assertImmutableJournalIdentity(left, right);
}

function assertImmutableJournalIdentity(
  existing: BenchlingMigrationActionJournal,
  next: BenchlingMigrationActionJournal
): void {
  if (existing.completedAt && existing.completedAt !== next.completedAt)
    throw new Error('Migration action terminal completion changed.');
  if (
    existing.collectionCaptureSha256 &&
    existing.collectionCaptureSha256 !== next.collectionCaptureSha256
  )
    throw new Error('Migration collection capture changed.');
  const immutableExisting = {
    schema: existing.schema,
    actionId: existing.actionId,
    runId: existing.runId,
    workspace: existing.workspace,
    durability:
      existing.durability.kind === 'managed_git'
        ? { kind: 'managed_git', preActionHead: existing.durability.preActionHead }
        : existing.durability,
    externalSource: existing.externalSource,
    createdAt: existing.createdAt,
    effectsCaptureSha256: existing.effectsCaptureSha256,
    retainedClaims: existing.retainedClaims,
  };
  const immutableNext = {
    schema: next.schema,
    actionId: next.actionId,
    runId: next.runId,
    workspace: next.workspace,
    durability:
      next.durability.kind === 'managed_git'
        ? { kind: 'managed_git', preActionHead: next.durability.preActionHead }
        : next.durability,
    externalSource: next.externalSource,
    createdAt: next.createdAt,
    effectsCaptureSha256: next.effectsCaptureSha256,
    retainedClaims: next.retainedClaims,
  };
  if (JSON.stringify(immutableExisting) !== JSON.stringify(immutableNext)) {
    throw new Error('Migration action journal immutable identity changed.');
  }
  const existingAllocationBySource = new Map(
    existing.allocations.map((allocation) => [allocation.sourceObjectId, allocation])
  );
  for (const allocation of next.allocations) {
    const prior = existingAllocationBySource.get(allocation.sourceObjectId);
    if (!prior) continue;
    const immutablePrior = { ...prior, installState: undefined, rollback: undefined };
    const immutableAllocation = { ...allocation, installState: undefined, rollback: undefined };
    if (JSON.stringify(immutablePrior) !== JSON.stringify(immutableAllocation)) {
      throw new Error('Migration action journal allocation changed after reservation.');
    }
  }
}

async function writeDurableFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
