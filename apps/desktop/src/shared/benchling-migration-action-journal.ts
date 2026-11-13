import type { ImportDecision, Sha256Digest } from './benchling-import-decision';
import {
  parseRegistryTableMappingDecision,
  parseReviewedRegistryTableRowRef,
  type ReviewedRegistryTableRowRef,
} from './benchling-registry-table-review';
import { isCatalogRecordPresentationKind } from './catalog-entity';
import type { ExternalZipSource, ProjectionDestination } from './benchling-migration';
import { isSafeWorkspaceRelativePath } from './path-boundary';
import { isProviderObjectClass, type ProviderObjectClass } from './provider-object-reference';

export const BENCHLING_MIGRATION_ACTION_JOURNAL_SCHEMA =
  'dnaforge.benchling.migration-action-journal.v1' as const;

export const BENCHLING_MIGRATION_INSTALL_STATES = [
  'reserved',
  'staged',
  'installed',
  'catalog_committed',
  'manifest_committed',
  'complete',
] as const;

export type BenchlingMigrationInstallState = (typeof BENCHLING_MIGRATION_INSTALL_STATES)[number];

export type BenchlingProviderStableIdentity = Readonly<{
  provider: 'benchling';
  stableObjectId: string;
  objectClass: ProviderObjectClass;
}>;

export type BenchlingCanonicalMembership = Readonly<{
  sourceFolderId: string | null;
  hierarchySegments: readonly string[];
  alternateSourceFolderIds: readonly string[];
}>;

export type BenchlingCollisionSuffixDecision =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'stable_id'; suffix: string; ordinal: number }>;

export type BenchlingMigrationRollbackState =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'displaced';
      targetRelativePath: string;
      backupRelativePath: string;
      expectedExistingState: import('./benchling-import-decision').ExistingPathFingerprint;
    }>;

export type BenchlingMigrationActionAllocation = Readonly<{
  writeDisposition?: 'create' | 'replace' | 'retain';
  sourceObjectId: string;
  destinationEntityId: string;
  destination: ProjectionDestination;
  canonicalMembership: BenchlingCanonicalMembership;
  collisionSuffixDecision: BenchlingCollisionSuffixDecision;
  expectedPriorImportedHash: Sha256Digest | null;
  actionOwnedPaths: readonly string[];
  rollback: BenchlingMigrationRollbackState;
  installState: BenchlingMigrationInstallState;
}> &
  BenchlingMigrationAllocationIdentity;

export type BenchlingMigrationAllocationIdentity =
  | Readonly<{ providerIdentity: BenchlingProviderStableIdentity; reviewedTable?: never }>
  | Readonly<{ providerIdentity: null; reviewedTable: ReviewedRegistryTableRowRef }>;

export type BenchlingMigrationRetainedClaim = Readonly<{
  sourceObjectId: string;
  destinationEntityId: string;
  destination: ProjectionDestination;
}>;

export type BenchlingMigrationActionJournal = Readonly<{
  schema: typeof BENCHLING_MIGRATION_ACTION_JOURNAL_SCHEMA;
  actionId: string;
  runId: string;
  workspace: Readonly<
    { projectionScopeId: string; workspacePath: string } & (
      | { workspaceDbId: number; repoUuid: string | null }
      | { workspaceDbId: null; repoUuid: string }
    )
  >;
  durability:
    | Readonly<{ kind: 'managed_git'; preActionHead: string; committedHead: string | null }>
    | Readonly<{ kind: 'local_filesystem' }>;
  externalSource: ExternalZipSource;
  decisions: readonly ImportDecision[];
  allocations: readonly BenchlingMigrationActionAllocation[];
  createdAt: string;
  updatedAt: string;
  effectsCaptureSha256?: string;
  collectionCaptureSha256?: string;
  retainedClaims?: readonly BenchlingMigrationRetainedClaim[];
  completedAt?: string;
}>;

const INSTALL_STATE_INDEX = new Map(
  BENCHLING_MIGRATION_INSTALL_STATES.map((state, index) => [state, index])
);

export function parseBenchlingMigrationActionJournal(
  value: unknown
): BenchlingMigrationActionJournal {
  const record = requireRecord(value, 'Migration action journal');
  requireExactKeys(record, [
    'schema',
    'actionId',
    'runId',
    'workspace',
    'durability',
    'externalSource',
    'decisions',
    'allocations',
    'createdAt',
    'updatedAt',
    ...('effectsCaptureSha256' in record ? ['effectsCaptureSha256'] : []),
    ...('collectionCaptureSha256' in record ? ['collectionCaptureSha256'] : []),
    ...('retainedClaims' in record ? ['retainedClaims'] : []),
    ...('completedAt' in record ? ['completedAt'] : []),
  ]);
  if (record.schema !== BENCHLING_MIGRATION_ACTION_JOURNAL_SCHEMA) {
    throw new Error('Migration action journal schema is unsupported.');
  }
  const actionId = requireIdentifier(record.actionId, 'action ID');
  const runId = requireIdentifier(record.runId, 'run ID');
  const workspace = parseWorkspace(record.workspace);
  const durability = parseDurability(record.durability);
  const externalSource = parseExternalSource(record.externalSource);
  const decisions = parseDecisions(record.decisions);
  const allocations = parseAllocations(record.allocations);
  const retainedClaims =
    'retainedClaims' in record ? parseRetainedClaims(record.retainedClaims) : undefined;
  if (
    retainedClaims?.some((claim) =>
      allocations.some((a) => a.destinationEntityId === claim.destinationEntityId)
    )
  )
    throw new Error('A retained claim duplicates an allocation.');
  const createdAt = requireTimestamp(record.createdAt, 'created timestamp');
  const updatedAt = requireTimestamp(record.updatedAt, 'updated timestamp');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('Migration action journal update precedes its creation.');
  }
  const completedAt =
    'completedAt' in record
      ? requireTimestamp(record.completedAt, 'completion timestamp')
      : undefined;
  if (
    completedAt &&
    (Date.parse(completedAt) < Date.parse(createdAt) ||
      allocations.some((a) => a.installState !== 'complete'))
  )
    throw new Error('Migration action completion precedes its complete allocations.');
  const sourceObjectIds = new Set<string>();
  const destinationEntityIds = new Set<string>();
  for (const allocation of allocations) {
    if (sourceObjectIds.has(allocation.sourceObjectId)) {
      throw new Error('Migration action journal repeats a source object allocation.');
    }
    if (destinationEntityIds.has(allocation.destinationEntityId)) {
      throw new Error('Migration action journal repeats a destination entity allocation.');
    }
    sourceObjectIds.add(allocation.sourceObjectId);
    destinationEntityIds.add(allocation.destinationEntityId);
    if (
      allocation.rollback.kind === 'displaced' &&
      !allocation.rollback.backupRelativePath.startsWith(
        `.dnaforge/migration/rollback/${actionId}/`
      )
    ) {
      throw new Error('Migration rollback backup belongs to another action.');
    }
  }
  return Object.freeze({
    schema: BENCHLING_MIGRATION_ACTION_JOURNAL_SCHEMA,
    actionId,
    runId,
    workspace,
    durability,
    externalSource,
    decisions: Object.freeze(decisions),
    allocations: Object.freeze(allocations),
    createdAt,
    updatedAt,
    ...('effectsCaptureSha256' in record
      ? { effectsCaptureSha256: requireSha256(record.effectsCaptureSha256, 'effects capture') }
      : {}),
    ...(retainedClaims ? { retainedClaims } : {}),
    ...('collectionCaptureSha256' in record
      ? {
          collectionCaptureSha256: requireSha256(
            record.collectionCaptureSha256,
            'collection capture'
          ),
        }
      : {}),
    ...(completedAt ? { completedAt } : {}),
  });
}

function parseRetainedClaims(value: unknown): readonly BenchlingMigrationRetainedClaim[] {
  if (!Array.isArray(value) || value.length > 100_000)
    throw new Error('Retained claims are invalid.');
  const ids = new Set<string>();
  return value.map((item) => {
    const record = requireRecord(item, 'Retained claim');
    requireExactKeys(record, ['sourceObjectId', 'destinationEntityId', 'destination']);
    const destinationEntityId = requireIdentifier(record.destinationEntityId, 'retained entity ID');
    if (ids.has(destinationEntityId)) throw new Error('Retained claims repeat an entity.');
    ids.add(destinationEntityId);
    return {
      sourceObjectId: requireIdentifier(record.sourceObjectId, 'retained source ID'),
      destinationEntityId,
      destination: parseProjectionDestination(record.destination),
    };
  });
}

function parseDurability(value: unknown): BenchlingMigrationActionJournal['durability'] {
  const record = requireRecord(value, 'Migration action durability');
  if (record.kind === 'local_filesystem') {
    requireExactKeys(record, ['kind']);
    return Object.freeze({ kind: 'local_filesystem' });
  }
  if (record.kind !== 'managed_git') {
    throw new Error('Migration action durability kind is invalid.');
  }
  requireExactKeys(record, ['kind', 'preActionHead', 'committedHead']);
  const preActionHead = requireCommitOid(record.preActionHead, 'pre-action HEAD');
  const committedHead =
    record.committedHead === null ? null : requireCommitOid(record.committedHead, 'committed HEAD');
  return Object.freeze({ kind: 'managed_git', preActionHead, committedHead });
}

export function advanceBenchlingMigrationAllocation(
  journal: BenchlingMigrationActionJournal,
  sourceObjectId: string,
  nextState: BenchlingMigrationInstallState,
  updatedAt: string
): BenchlingMigrationActionJournal {
  return advanceBenchlingMigrationAllocations(journal, [sourceObjectId], nextState, updatedAt);
}

export function advanceBenchlingMigrationAllocations(
  journal: BenchlingMigrationActionJournal,
  sourceObjectIds: readonly string[],
  nextState: BenchlingMigrationInstallState,
  updatedAt: string
): BenchlingMigrationActionJournal {
  const normalized = parseBenchlingMigrationActionJournal(journal);
  const selected = new Set(sourceObjectIds);
  const missing = new Set(selected);
  const nextIndex = INSTALL_STATE_INDEX.get(nextState);
  const allocations = normalized.allocations.map((allocation) => {
    if (!selected.has(allocation.sourceObjectId)) return allocation;
    missing.delete(allocation.sourceObjectId);
    const currentIndex = INSTALL_STATE_INDEX.get(allocation.installState);
    if (currentIndex === undefined || nextIndex === undefined || nextIndex !== currentIndex + 1) {
      throw new Error(
        `Migration action allocation cannot advance from ${allocation.installState} to ${nextState}.`
      );
    }
    return { ...allocation, installState: nextState };
  });
  if (missing.size > 0)
    throw new Error(`Migration action allocation is missing: ${[...missing].join(', ')}`);
  return parseBenchlingMigrationActionJournal({
    ...normalized,
    allocations,
    updatedAt: requireTimestamp(updatedAt, 'updated timestamp'),
  });
}

function parseWorkspace(value: unknown): BenchlingMigrationActionJournal['workspace'] {
  const record = requireRecord(value, 'Migration action workspace');
  requireExactKeys(record, ['workspaceDbId', 'repoUuid', 'projectionScopeId', 'workspacePath']);
  if (
    record.workspaceDbId !== null &&
    (!Number.isSafeInteger(record.workspaceDbId) || Number(record.workspaceDbId) <= 0)
  ) {
    throw new Error('Migration action workspace row ID is invalid.');
  }
  if (record.repoUuid !== null && typeof record.repoUuid !== 'string') {
    throw new Error('Migration action repository identity is invalid.');
  }
  const workspacePath = requireAbsolutePath(record.workspacePath, 'workspace path');
  const projectionScopeId = requireIdentifier(record.projectionScopeId, 'projection scope ID');
  if (record.workspaceDbId === null) {
    const repoUuid = requireIdentifier(record.repoUuid, 'staged repository identity');
    if (projectionScopeId !== repoUuid)
      throw new Error('Staged migration projection scope must match its repository identity.');
    return Object.freeze({ workspaceDbId: null, repoUuid, projectionScopeId, workspacePath });
  }
  return Object.freeze({
    workspaceDbId: Number(record.workspaceDbId),
    repoUuid: record.repoUuid as string | null,
    projectionScopeId,
    workspacePath,
  });
}

function parseExternalSource(value: unknown): ExternalZipSource {
  const record = requireRecord(value, 'Migration action external source');
  requireExactKeys(record, [
    'schema',
    'sourceId',
    'originalPath',
    'displayName',
    'zipSha256',
    'sizeBytes',
    'selectedAt',
  ]);
  if (record.schema !== 'dnaforge.benchling.external-zip-source.v1') {
    throw new Error('Migration action external source schema is unsupported.');
  }
  if (!Number.isSafeInteger(record.sizeBytes) || Number(record.sizeBytes) <= 0) {
    throw new Error('Migration action external source size is invalid.');
  }
  return Object.freeze({
    schema: 'dnaforge.benchling.external-zip-source.v1',
    sourceId: requireIdentifier(record.sourceId, 'external source ID'),
    originalPath: requireAbsolutePath(record.originalPath, 'external source path'),
    displayName: requireNonEmptyString(record.displayName, 'external source display name'),
    zipSha256: requireSha256(record.zipSha256, 'external source SHA-256'),
    sizeBytes: Number(record.sizeBytes),
    selectedAt: requireTimestamp(record.selectedAt, 'external source selection timestamp'),
  });
}

function parseDecisions(value: unknown): ImportDecision[] {
  if (!Array.isArray(value)) throw new Error('Migration action decisions must be an array.');
  return value.map((decision) => parseImportDecision(decision));
}

function parseImportDecision(value: unknown): ImportDecision {
  const record = requireRecord(value, 'Migration action decision');
  switch (record.kind) {
    case 'registry_table_mapping':
      return parseRegistryTableMappingDecision(record);
    case 'provider_version_conflict':
      requireExactKeys(record, ['kind', 'policy']);
      if (record.policy !== 'keep_existing' && record.policy !== 'use_incoming') {
        throw new Error('Migration provider-version decision policy is invalid.');
      }
      return Object.freeze({ kind: record.kind, policy: record.policy });
    case 'unbound_exact_match':
      requireExactKeys(record, [
        'kind',
        'sourceObjectId',
        'candidateEntityId',
        'expectedCandidateScientificSha256',
        'expectedBindingState',
        'policy',
      ]);
      if (
        record.expectedBindingState !== 'unbound' ||
        (record.policy !== 'link_existing' && record.policy !== 'import_separate')
      ) {
        throw new Error('Migration exact-match decision is invalid.');
      }
      return Object.freeze({
        kind: record.kind,
        sourceObjectId: requireIdentifier(record.sourceObjectId, 'decision source object ID'),
        candidateEntityId: requireIdentifier(record.candidateEntityId, 'candidate entity ID'),
        expectedCandidateScientificSha256: requireSha256(
          record.expectedCandidateScientificSha256,
          'candidate scientific SHA-256'
        ),
        expectedBindingState: 'unbound',
        policy: record.policy,
      });
    case 'structural_path_conflict': {
      requireExactKeys(record, ['kind', 'relativePath', 'expectedExistingState', 'policy']);
      if (
        record.policy !== 'rename_incoming' &&
        record.policy !== 'replace_existing' &&
        record.policy !== 'cancel_import'
      ) {
        throw new Error('Migration structural-path decision policy is invalid.');
      }
      return Object.freeze({
        kind: record.kind,
        relativePath: requireSafeRelativePath(record.relativePath, 'decision relative path'),
        expectedExistingState: parseExistingPathFingerprint(record.expectedExistingState),
        policy: record.policy,
      });
    }
    default:
      throw new Error('Migration action decision kind is unsupported.');
  }
}

function parseAllocations(value: unknown): BenchlingMigrationActionAllocation[] {
  if (!Array.isArray(value)) throw new Error('Migration action allocations must be an array.');
  return value.map((allocation) => parseAllocation(allocation));
}

function parseAllocation(value: unknown): BenchlingMigrationActionAllocation {
  const record = requireRecord(value, 'Migration action allocation');
  requireExactKeys(record, [
    ...(record.writeDisposition === undefined ? [] : ['writeDisposition']),
    'sourceObjectId',
    'providerIdentity',
    ...(record.providerIdentity === null ? ['reviewedTable'] : []),
    'destinationEntityId',
    'destination',
    'canonicalMembership',
    'collisionSuffixDecision',
    'expectedPriorImportedHash',
    'actionOwnedPaths',
    'rollback',
    'installState',
  ]);
  const installState = record.installState;
  const writeDisposition = record.writeDisposition;
  if (
    writeDisposition !== undefined &&
    writeDisposition !== 'create' &&
    writeDisposition !== 'replace' &&
    writeDisposition !== 'retain'
  )
    throw new Error('Migration write disposition is invalid.');
  if (
    !BENCHLING_MIGRATION_INSTALL_STATES.includes(installState as BenchlingMigrationInstallState)
  ) {
    throw new Error('Migration action allocation install state is invalid.');
  }
  const destination = parseProjectionDestination(record.destination);
  const actionOwnedPaths = parseSafePathArray(record.actionOwnedPaths, 'action-owned path');
  const rollback = parseRollback(record.rollback);
  const retained =
    actionOwnedPaths.length === 0 &&
    record.expectedPriorImportedHash === null &&
    rollback.kind === 'none' &&
    installState !== 'reserved' &&
    installState !== 'staged';
  assertOwnedPathsMatchDestination(destination, actionOwnedPaths, rollback, retained);
  if (writeDisposition === 'retain' && !retained)
    throw new Error('Retained allocation cannot replace or own destination bytes.');
  if (writeDisposition === 'replace' && record.expectedPriorImportedHash === null)
    throw new Error('Replacement allocation requires its prior scientific hash.');
  if (writeDisposition === 'create' && record.expectedPriorImportedHash !== null)
    throw new Error('Creation allocation cannot carry replacement authority.');
  return Object.freeze({
    ...(writeDisposition ? { writeDisposition } : {}),
    sourceObjectId: requireIdentifier(record.sourceObjectId, 'allocation source object ID'),
    ...(record.providerIdentity === null
      ? {
          providerIdentity: null,
          reviewedTable: parseReviewedRegistryTableRowRef(record.reviewedTable),
        }
      : { providerIdentity: parseProviderIdentity(record.providerIdentity) }),
    destinationEntityId: requireIdentifier(record.destinationEntityId, 'destination entity ID'),
    destination,
    canonicalMembership: parseCanonicalMembership(record.canonicalMembership),
    collisionSuffixDecision: parseCollisionSuffixDecision(record.collisionSuffixDecision),
    expectedPriorImportedHash:
      record.expectedPriorImportedHash === null
        ? null
        : requireSha256(record.expectedPriorImportedHash, 'expected prior imported hash'),
    actionOwnedPaths: Object.freeze(actionOwnedPaths),
    rollback,
    installState: installState as BenchlingMigrationInstallState,
  });
}

function parseProviderIdentity(value: unknown): BenchlingProviderStableIdentity {
  const record = requireRecord(value, 'Migration provider identity');
  requireExactKeys(record, ['provider', 'stableObjectId', 'objectClass']);
  if (record.provider !== 'benchling') throw new Error('Migration provider must be Benchling.');
  if (!isProviderObjectClass(record.objectClass)) {
    throw new Error('Migration provider object class is invalid.');
  }
  return Object.freeze({
    provider: 'benchling',
    stableObjectId: requireIdentifier(record.stableObjectId, 'provider stable object ID'),
    objectClass: record.objectClass,
  });
}

function parseCanonicalMembership(value: unknown): BenchlingCanonicalMembership {
  const record = requireRecord(value, 'Migration canonical membership');
  requireExactKeys(record, ['sourceFolderId', 'hierarchySegments', 'alternateSourceFolderIds']);
  if (record.sourceFolderId !== null && typeof record.sourceFolderId !== 'string') {
    throw new Error('Migration canonical source folder ID is invalid.');
  }
  if (!Array.isArray(record.hierarchySegments) || !Array.isArray(record.alternateSourceFolderIds)) {
    throw new Error('Migration canonical membership lists are invalid.');
  }
  const hierarchySegments = record.hierarchySegments.map((segment) =>
    requireSafeSegment(segment, 'provider hierarchy segment')
  );
  const alternateSourceFolderIds = record.alternateSourceFolderIds.map((folderId) =>
    requireIdentifier(folderId, 'alternate source folder ID')
  );
  return Object.freeze({
    sourceFolderId:
      record.sourceFolderId === null
        ? null
        : requireIdentifier(record.sourceFolderId, 'canonical source folder ID'),
    hierarchySegments: Object.freeze(hierarchySegments),
    alternateSourceFolderIds: Object.freeze(alternateSourceFolderIds),
  });
}

function parseCollisionSuffixDecision(value: unknown): BenchlingCollisionSuffixDecision {
  const record = requireRecord(value, 'Migration collision suffix decision');
  if (record.kind === 'none') {
    requireExactKeys(record, ['kind']);
    return Object.freeze({ kind: 'none' });
  }
  if (record.kind === 'stable_id') {
    requireExactKeys(record, ['kind', 'suffix', 'ordinal']);
    if (!Number.isSafeInteger(record.ordinal) || Number(record.ordinal) <= 0) {
      throw new Error('Migration collision suffix ordinal is invalid.');
    }
    return Object.freeze({
      kind: 'stable_id',
      suffix: requireSafeSegment(record.suffix, 'collision suffix'),
      ordinal: Number(record.ordinal),
    });
  }
  throw new Error('Migration collision suffix decision is unsupported.');
}

function parseRollback(value: unknown): BenchlingMigrationRollbackState {
  const record = requireRecord(value, 'Migration rollback state');
  if (record.kind === 'none') {
    requireExactKeys(record, ['kind']);
    return Object.freeze({ kind: 'none' });
  }
  if (record.kind === 'displaced') {
    requireExactKeys(record, [
      'kind',
      'targetRelativePath',
      'backupRelativePath',
      'expectedExistingState',
    ]);
    return Object.freeze({
      kind: 'displaced',
      targetRelativePath: requireSafeRelativePath(
        record.targetRelativePath,
        'rollback target path'
      ),
      backupRelativePath: requireRollbackBackupPath(record.backupRelativePath),
      expectedExistingState: parseExistingPathFingerprint(record.expectedExistingState),
    });
  }
  throw new Error('Migration rollback state is unsupported.');
}

function requireRollbackBackupPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isSafeWorkspaceRelativePath(value) ||
    !/^\.dnaforge\/migration\/rollback\/[^/]+\/[^/]+$/u.test(value)
  ) {
    throw new Error('Migration rollback backup must be inside its hidden rollback directory.');
  }
  return value;
}

function parseExistingPathFingerprint(
  value: unknown
): import('./benchling-import-decision').ExistingPathFingerprint {
  const record = requireRecord(value, 'Existing path fingerprint');
  if (record.kind === 'file') {
    requireExactKeys(record, ['kind', 'sha256', 'sizeBytes']);
    if (!Number.isSafeInteger(record.sizeBytes) || Number(record.sizeBytes) < 0) {
      throw new Error('Existing file size is invalid.');
    }
    return Object.freeze({
      kind: 'file',
      sha256: requireSha256(record.sha256, 'existing file SHA-256'),
      sizeBytes: Number(record.sizeBytes),
    });
  }
  if (record.kind === 'directory') {
    requireExactKeys(record, ['kind', 'treeSha256']);
    return Object.freeze({
      kind: 'directory',
      treeSha256: requireSha256(record.treeSha256, 'existing directory tree SHA-256'),
    });
  }
  throw new Error('Existing path fingerprint kind is invalid.');
}

function parseProjectionDestination(value: unknown): ProjectionDestination {
  const record = requireRecord(value, 'Migration projection destination');
  if (record.kind === 'file') {
    requireExactKeys(record, ['kind', 'relativePath']);
    return Object.freeze({
      kind: 'file',
      relativePath: requireSafeRelativePath(record.relativePath, 'file destination'),
    });
  }
  if (record.kind === 'package') {
    requireExactKeys(record, ['kind', 'rootRelativePath', 'primaryRelativePath']);
    const rootRelativePath = requireSafeRelativePath(
      record.rootRelativePath,
      'package destination root'
    );
    const primaryRelativePath = requireSafeRelativePath(
      record.primaryRelativePath,
      'package primary destination'
    );
    if (!primaryRelativePath.startsWith(`${rootRelativePath}/`)) {
      throw new Error('Migration package primary path must be inside its root.');
    }
    return Object.freeze({ kind: 'package', rootRelativePath, primaryRelativePath });
  }
  if (record.kind === 'catalog-record') {
    requireExactKeys(record, [
      'kind',
      'parentRelativePath',
      'displayName',
      'catalogType',
      'presentationKind',
    ]);
    if (!isCatalogRecordPresentationKind(record.presentationKind)) {
      throw new Error('Migration catalog presentation kind is invalid.');
    }
    return Object.freeze({
      kind: 'catalog-record',
      parentRelativePath:
        record.parentRelativePath === ''
          ? ''
          : requireSafeRelativePath(record.parentRelativePath, 'catalog parent destination'),
      displayName: requireNonEmptyString(record.displayName, 'catalog display name'),
      catalogType: requireNonEmptyString(record.catalogType, 'catalog type'),
      presentationKind: record.presentationKind,
    });
  }
  throw new Error('Migration projection destination kind is invalid.');
}

function assertOwnedPathsMatchDestination(
  destination: ProjectionDestination,
  actionOwnedPaths: readonly string[],
  rollback: BenchlingMigrationRollbackState,
  retained: boolean
): void {
  const requiredPath =
    destination.kind === 'file'
      ? destination.relativePath
      : destination.kind === 'package'
        ? destination.rootRelativePath
        : null;
  if (requiredPath && !retained && !actionOwnedPaths.includes(requiredPath)) {
    throw new Error('Migration action-owned paths omit the allocated destination.');
  }
  const allowedPaths = new Set([
    ...(requiredPath ? [requiredPath] : []),
    ...(rollback.kind === 'displaced'
      ? [rollback.backupRelativePath, rollback.targetRelativePath]
      : []),
  ]);
  if (actionOwnedPaths.some((path) => !allowedPaths.has(path))) {
    throw new Error('Migration action-owned paths include an unrelated destination.');
  }
}

function parseSafePathArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Migration ${label} list is invalid.`);
  const paths = value.map((path) => requireActionOwnedPath(path, label));
  if (new Set(paths).size !== paths.length)
    throw new Error(`Migration ${label} list repeats a path.`);
  return paths;
}

function requireActionOwnedPath(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Migration ${label} is invalid.`);
  const normalized = value.normalize('NFC').replace(/\\/gu, '/');
  if (!isSafeWorkspaceRelativePath(normalized)) throw new Error(`Migration ${label} is unsafe.`);
  if (
    normalized.toLowerCase().startsWith('.dnaforge/') &&
    !normalized.toLowerCase().startsWith('.dnaforge/migration/')
  ) {
    throw new Error(`Migration ${label} uses a protected root.`);
  }
  const topLevel = normalized.split('/')[0]?.toLowerCase();
  if (topLevel && ['.git', '.forge', '.waypoint'].includes(topLevel)) {
    throw new Error(`Migration ${label} uses a protected root.`);
  }
  return normalized;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new Error('Migration action journal object has unexpected or missing fields.');
  }
}

function requireIdentifier(value: unknown, label: string): string {
  const text = requireNonEmptyString(value, label);
  if (/\s/u.test(text) || text.length > 240) throw new Error(`Migration ${label} is invalid.`);
  return text;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Migration ${label} is required.`);
  return value.trim().normalize('NFC');
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Migration ${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function requireCommitOid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/iu.test(value)) {
    throw new Error(`Migration action ${label} is invalid.`);
  }
  return value.toLowerCase();
}

function requireSha256(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Migration ${label} is invalid.`);
  }
  return value as Sha256Digest;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value))) {
    throw new Error(`Migration ${label} must be absolute.`);
  }
  return value.normalize('NFC');
}

function requireSafeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Migration ${label} is invalid.`);
  const normalized = value.normalize('NFC').replace(/\\/gu, '/');
  if (!isSafeWorkspaceRelativePath(normalized)) throw new Error(`Migration ${label} is unsafe.`);
  const topLevel = normalized.split('/')[0]?.toLowerCase();
  if (topLevel && ['.git', '.dnaforge', '.forge', '.waypoint'].includes(topLevel)) {
    throw new Error(`Migration ${label} uses a protected root.`);
  }
  return normalized;
}

function requireSafeSegment(value: unknown, label: string): string {
  const segment = requireNonEmptyString(value, label);
  if (segment.includes('/') || segment.includes('\\') || segment === '.' || segment === '..') {
    throw new Error(`Migration ${label} is invalid.`);
  }
  return segment;
}
