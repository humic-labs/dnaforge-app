import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, posix, resolve, sep } from 'node:path';

import type {
  BenchlingCanonicalMembership,
  BenchlingCollisionSuffixDecision,
  BenchlingMigrationActionAllocation,
  BenchlingMigrationAllocationIdentity,
} from '../../shared/benchling-migration-action-journal';
import type {
  ExistingPathFingerprint,
  ImportDecision,
  Sha256Digest,
} from '../../shared/benchling-import-decision';
import type { ProjectionDestination } from '../../shared/benchling-migration';
import type { CatalogRecordPresentationKind } from '../../shared/catalog-entity';
import { isSafeWorkspaceRelativePath } from '../../shared/path-boundary';

const PROTECTED_TOP_LEVEL_NAMES = new Set(['.git', '.dnaforge', '.forge', '.waypoint']);
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'clock$',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export type DestinationReservation = Readonly<{
  relativePath: string;
  kind: 'file' | 'directory' | 'catalog-record';
  ownerSourceObjectId: string | null;
}>;

export type BenchlingDestinationVariant =
  | Readonly<{ kind: 'file'; extension: string }>
  | Readonly<{ kind: 'package'; primaryRelativePath: string }>
  | Readonly<{
      kind: 'catalog-record';
      catalogType: string;
      presentationKind: CatalogRecordPresentationKind;
    }>;

export type AllocateBenchlingDestinationInput = Readonly<{
  actionId: string;
  workspacePath: string;
  sourceObjectId: string;
  destinationEntityId: string;
  displayName: string;
  variant: BenchlingDestinationVariant;
  canonicalMembership: BenchlingCanonicalMembership;
  expectedPriorImportedHash: Sha256Digest | null;
  decisions: readonly ImportDecision[];
  reservations: readonly DestinationReservation[];
  existingAllocations: readonly BenchlingMigrationActionAllocation[];
  protectedTopLevelNames?: readonly string[];
}> &
  BenchlingMigrationAllocationIdentity;

export class DestinationStructuralConflictError extends Error {
  constructor(
    readonly relativePath: string,
    readonly expectedExistingState: ExistingPathFingerprint,
    readonly incomingKind: BenchlingDestinationVariant['kind']
  ) {
    super(`Destination path has a structural conflict: ${relativePath}`);
    this.name = 'DestinationStructuralConflictError';
  }
}

export class DestinationAllocationCancelledError extends Error {
  constructor(readonly relativePath: string) {
    super(`Destination allocation was cancelled for ${relativePath}.`);
    this.name = 'DestinationAllocationCancelledError';
  }
}

export async function allocateBenchlingDestination(
  input: AllocateBenchlingDestinationInput
): Promise<BenchlingMigrationActionAllocation> {
  const existing = input.existingAllocations.find(
    (allocation) => allocation.sourceObjectId === input.sourceObjectId
  );
  if (existing) return existing;

  validateIdentity(input);
  const workspacePath = resolve(input.workspacePath);
  const protectedNames = new Set([
    ...PROTECTED_TOP_LEVEL_NAMES,
    ...(input.protectedTopLevelNames ?? []).map((name) => allocationKey(name)),
  ]);
  const hierarchySegments = input.canonicalMembership.hierarchySegments.map((segment) =>
    safeDestinationSegment(segment, 'Imported folder')
  );
  if (hierarchySegments[0] && protectedNames.has(allocationKey(hierarchySegments[0]))) {
    throw new Error('Benchling destination hierarchy uses a protected workspace root.');
  }

  const reservations = input.reservations.map(normalizeReservation);
  const structuralRollback = await inspectIntermediateComponents({
    input,
    workspacePath,
    hierarchySegments,
    reservations,
  });
  const parentRelativePath = hierarchySegments.join('/');
  const extension =
    input.variant.kind === 'file' ? normalizeExtension(input.variant.extension) : '';
  const displayStem = safeDestinationSegment(
    input.variant.kind === 'file'
      ? stripExtension(input.displayName, extension)
      : input.displayName,
    input.variant.kind === 'catalog-record' ? 'Imported record' : 'Imported item'
  );

  let ordinal = 0;
  let collision: BenchlingCollisionSuffixDecision = { kind: 'none' };
  let selectedName = `${displayStem}${extension}`;
  let selectedRelativePath = joinRelative(parentRelativePath, selectedName);
  let rollback = structuralRollback;

  let allocated = false;
  for (let attempts = 0; attempts < 10_000; attempts += 1) {
    const leaf = await inspectLeaf({
      workspacePath,
      relativePath: selectedRelativePath,
      incomingKind: input.variant.kind,
      reservations,
    });
    if (leaf.kind === 'available') {
      allocated = true;
      break;
    }
    if (leaf.kind === 'same-kind') {
      ordinal += 1;
      const suffix = stableIdSuffix(
        input.providerIdentity?.stableObjectId ?? input.sourceObjectId,
        ordinal
      );
      selectedName = `${displayStem}${suffix}${extension}`;
      selectedRelativePath = joinRelative(parentRelativePath, selectedName);
      collision = { kind: 'stable_id', suffix, ordinal };
      continue;
    }
    const resolution = resolveStructuralConflict(input, selectedRelativePath, leaf.existingState);
    if (resolution === 'rename') {
      ordinal += 1;
      const suffix = stableIdSuffix(
        input.providerIdentity?.stableObjectId ?? input.sourceObjectId,
        ordinal
      );
      selectedName = `${displayStem}${suffix}${extension}`;
      selectedRelativePath = joinRelative(parentRelativePath, selectedName);
      collision = { kind: 'stable_id', suffix, ordinal };
      continue;
    }
    rollback = rollbackForConflict(input, selectedRelativePath, leaf.existingState);
    allocated = true;
    break;
  }
  if (!allocated) {
    throw new Error('Benchling destination allocation exhausted its collision suffix space.');
  }

  const destination = destinationForVariant(
    input.variant,
    parentRelativePath,
    selectedName,
    selectedRelativePath
  );
  const actionOwnedPaths = destinationActionOwnedPaths(destination, rollback);
  return Object.freeze({
    writeDisposition: input.expectedPriorImportedHash ? 'replace' : 'create',
    sourceObjectId: input.sourceObjectId,
    ...(input.providerIdentity
      ? { providerIdentity: input.providerIdentity }
      : { providerIdentity: null, reviewedTable: input.reviewedTable }),
    destinationEntityId: input.destinationEntityId,
    destination,
    canonicalMembership: input.canonicalMembership,
    collisionSuffixDecision: collision,
    expectedPriorImportedHash: input.expectedPriorImportedHash,
    actionOwnedPaths: Object.freeze(actionOwnedPaths),
    rollback,
    installState: 'reserved',
  });
}

export function allocationCollisionKey(relativePath: string): string {
  return relativePath
    .normalize('NFC')
    .replace(/\\/gu, '/')
    .split('')
    .map((character) =>
      character >= 'A' && character <= 'Z' ? character.toLowerCase() : character
    )
    .join('');
}

export function safeDestinationSegment(value: string, fallback: string): string {
  const normalized = typeof value === 'string' ? value.normalize('NFC') : '';
  let safe = normalized
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || /[\\/:*?"<>|]/u.test(character) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 100);
  if (!safe || safe === '.' || safe === '..') safe = fallback;
  const base = safe.slice(0, safe.length - extname(safe).length).toLowerCase();
  if (WINDOWS_RESERVED_BASENAMES.has(base)) safe = `${safe}_`;
  return safe;
}

function validateIdentity(input: AllocateBenchlingDestinationInput): void {
  if (!input.actionId.trim() || !input.sourceObjectId.trim() || !input.destinationEntityId.trim()) {
    throw new Error('Benchling destination allocation identity is incomplete.');
  }
  if (
    input.providerIdentity &&
    (input.providerIdentity.provider !== 'benchling' ||
      !input.providerIdentity.stableObjectId.trim())
  ) {
    throw new Error('Benchling destination allocation provider identity is invalid.');
  }
}

async function inspectIntermediateComponents(input: {
  input: AllocateBenchlingDestinationInput;
  workspacePath: string;
  hierarchySegments: string[];
  reservations: readonly DestinationReservation[];
}): Promise<BenchlingMigrationActionAllocation['rollback']> {
  let rollback: BenchlingMigrationActionAllocation['rollback'] = { kind: 'none' };
  for (let length = 1; length <= input.hierarchySegments.length; length += 1) {
    const relativePath = input.hierarchySegments.slice(0, length).join('/');
    const reserved = input.reservations.find(
      (reservation) =>
        allocationCollisionKey(reservation.relativePath) === allocationCollisionKey(relativePath)
    );
    if (reserved && reserved.kind !== 'directory') {
      throw new Error(`Batch reservation blocks destination hierarchy: ${relativePath}`);
    }
    const state = await filesystemPathState(input.workspacePath, relativePath);
    if (state.kind === 'missing' || state.kind === 'directory') continue;
    if (state.kind === 'symlink') {
      throw new Error(`Benchling destination traverses a symlink: ${relativePath}`);
    }
    const resolution = resolveStructuralConflict(input.input, relativePath, state.fingerprint);
    if (resolution === 'rename') {
      const stem = input.hierarchySegments[length - 1];
      const token = createHash('sha256').update(relativePath).digest('hex').slice(0, 8);
      let available = false;
      for (let ordinal = 0; ordinal < 10_000; ordinal += 1) {
        const segment = `${stem}--import-${token}${ordinal === 0 ? '' : `-${ordinal}`}`;
        const candidate = [...input.hierarchySegments.slice(0, length - 1), segment].join('/');
        const occupied = input.reservations.some(
          (reservation) =>
            allocationCollisionKey(reservation.relativePath) ===
              allocationCollisionKey(candidate) && reservation.kind !== 'directory'
        );
        const candidateState = await filesystemPathState(input.workspacePath, candidate);
        if (
          !occupied &&
          (candidateState.kind === 'missing' || candidateState.kind === 'directory')
        ) {
          input.hierarchySegments[length - 1] = segment;
          available = true;
          break;
        }
      }
      if (!available)
        throw new Error('Incoming folder rename exhausted its collision suffix space.');
      continue;
    }
    if (rollback.kind !== 'none') {
      throw new Error('One allocation cannot replace multiple structural path conflicts.');
    }
    rollback = rollbackForConflict(input.input, relativePath, state.fingerprint);
  }
  return rollback;
}

async function inspectLeaf(input: {
  workspacePath: string;
  relativePath: string;
  incomingKind: BenchlingDestinationVariant['kind'];
  reservations: readonly DestinationReservation[];
}): Promise<
  | Readonly<{ kind: 'available' }>
  | Readonly<{ kind: 'same-kind' }>
  | Readonly<{ kind: 'structural'; existingState: ExistingPathFingerprint }>
> {
  const key = allocationCollisionKey(input.relativePath);
  const reserved = input.reservations.find(
    (reservation) => allocationCollisionKey(reservation.relativePath) === key
  );
  if (reserved) {
    const incomingPathKind = input.incomingKind === 'package' ? 'directory' : input.incomingKind;
    if (reserved.kind === incomingPathKind || input.incomingKind === 'catalog-record') {
      return { kind: 'same-kind' };
    }
    throw new Error(`Reserved destination has a structural conflict: ${input.relativePath}`);
  }
  const state = await filesystemPathState(input.workspacePath, input.relativePath);
  if (state.kind === 'missing') return { kind: 'available' };
  if (state.kind === 'symlink') {
    throw new Error(`Benchling destination is a symlink: ${input.relativePath}`);
  }
  if (input.incomingKind === 'catalog-record') return { kind: 'same-kind' };
  const incomingIsDirectory = input.incomingKind === 'package';
  if ((state.kind === 'directory') === incomingIsDirectory) return { kind: 'same-kind' };
  return { kind: 'structural', existingState: state.fingerprint };
}

function resolveStructuralConflict(
  input: AllocateBenchlingDestinationInput,
  relativePath: string,
  existingState: ExistingPathFingerprint
): 'replace' | 'rename' {
  const decision = input.decisions.find(
    (candidate): candidate is Extract<ImportDecision, { kind: 'structural_path_conflict' }> =>
      candidate.kind === 'structural_path_conflict' &&
      allocationCollisionKey(candidate.relativePath) === allocationCollisionKey(relativePath)
  );
  if (!decision) {
    throw new DestinationStructuralConflictError(relativePath, existingState, input.variant.kind);
  }
  if (JSON.stringify(decision.expectedExistingState) !== JSON.stringify(existingState)) {
    throw new Error(`Structural path decision is stale for ${relativePath}.`);
  }
  if (decision.policy === 'cancel_import')
    throw new DestinationAllocationCancelledError(relativePath);
  return decision.policy === 'rename_incoming' ? 'rename' : 'replace';
}

function rollbackForConflict(
  input: AllocateBenchlingDestinationInput,
  targetRelativePath: string,
  expectedExistingState: ExistingPathFingerprint
): BenchlingMigrationActionAllocation['rollback'] {
  const actionId = safeDestinationSegment(input.actionId, 'action');
  const token = createHash('sha256').update(targetRelativePath).digest('hex').slice(0, 16);
  return Object.freeze({
    kind: 'displaced',
    targetRelativePath,
    backupRelativePath: `.dnaforge/migration/rollback/${actionId}/${token}-${safeDestinationSegment(
      basename(targetRelativePath),
      'displaced'
    )}`,
    expectedExistingState,
  });
}

function destinationForVariant(
  variant: BenchlingDestinationVariant,
  parentRelativePath: string,
  selectedName: string,
  selectedRelativePath: string
): ProjectionDestination {
  switch (variant.kind) {
    case 'file':
      return Object.freeze({ kind: 'file', relativePath: selectedRelativePath });
    case 'package': {
      const primarySuffix = normalizePackagePrimaryPath(variant.primaryRelativePath);
      return Object.freeze({
        kind: 'package',
        rootRelativePath: selectedRelativePath,
        primaryRelativePath: `${selectedRelativePath}/${primarySuffix}`,
      });
    }
    case 'catalog-record':
      return Object.freeze({
        kind: 'catalog-record',
        parentRelativePath,
        displayName: selectedName,
        catalogType: variant.catalogType.trim(),
        presentationKind: variant.presentationKind,
      });
  }
}

function destinationActionOwnedPaths(
  destination: ProjectionDestination,
  rollback: BenchlingMigrationActionAllocation['rollback']
): string[] {
  const paths =
    destination.kind === 'file'
      ? [destination.relativePath]
      : destination.kind === 'package'
        ? [destination.rootRelativePath]
        : [];
  if (rollback.kind === 'displaced') paths.push(rollback.backupRelativePath);
  return paths;
}

function normalizeReservation(reservation: DestinationReservation): DestinationReservation {
  const relativePath = reservation.relativePath.normalize('NFC').replace(/\\/gu, '/');
  if (!isSafeWorkspaceRelativePath(relativePath)) {
    throw new Error(`Destination reservation path is unsafe: ${reservation.relativePath}`);
  }
  return Object.freeze({ ...reservation, relativePath });
}

function normalizeExtension(value: string): string {
  if (typeof value !== 'string' || !/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/u.test(value)) {
    throw new Error('Benchling file destination extension is invalid.');
  }
  return value.toLowerCase();
}

function stripExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension.toLowerCase())
    ? name.slice(0, -extension.length)
    : name;
}

function stableIdSuffix(stableObjectId: string, ordinal: number): string {
  const safeId = stableObjectId.replace(/[^A-Za-z0-9_-]/gu, '_').slice(-32) || 'object';
  return `--${safeId}${ordinal === 1 ? '' : `-${ordinal}`}`;
}

function normalizePackagePrimaryPath(value: string): string {
  const normalized = value.normalize('NFC').replace(/\\/gu, '/');
  if (!isSafeWorkspaceRelativePath(normalized)) {
    throw new Error('Benchling package primary path is unsafe.');
  }
  return normalized;
}

function joinRelative(parent: string, name: string): string {
  const relativePath = parent ? posix.join(parent, name) : name;
  if (!isSafeWorkspaceRelativePath(relativePath)) {
    throw new Error('Allocated Benchling destination path is unsafe.');
  }
  return relativePath;
}

function allocationKey(value: string): string {
  return allocationCollisionKey(value);
}

async function filesystemPathState(
  workspacePath: string,
  relativePath: string
): Promise<
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'symlink' }>
  | Readonly<{ kind: 'file'; fingerprint: Extract<ExistingPathFingerprint, { kind: 'file' }> }>
  | Readonly<{
      kind: 'directory';
      fingerprint: Extract<ExistingPathFingerprint, { kind: 'directory' }>;
    }>
> {
  const absolutePath = resolve(workspacePath, relativePath);
  if (!absolutePath.startsWith(`${resolve(workspacePath)}${sep}`)) {
    throw new Error('Allocated Benchling destination escapes its workspace.');
  }
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return { kind: 'missing' };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) return { kind: 'symlink' };
  if (stats.isDirectory()) {
    return {
      kind: 'directory',
      fingerprint: { kind: 'directory', treeSha256: await directoryTreeSha256(absolutePath) },
    };
  }
  if (!stats.isFile()) throw new Error(`Destination path has an unsupported type: ${relativePath}`);
  return {
    kind: 'file',
    fingerprint: {
      kind: 'file',
      sha256: `sha256:${createHash('sha256')
        .update(await readFile(absolutePath))
        .digest('hex')}`,
      sizeBytes: stats.size,
    },
  };
}

export async function fingerprintExistingDestination(
  workspacePath: string,
  relativePath: string
): Promise<ExistingPathFingerprint | null> {
  const state = await filesystemPathState(workspacePath, relativePath);
  if (state.kind === 'missing') return null;
  if (state.kind === 'symlink') {
    throw new Error(`Benchling destination is a symlink: ${relativePath}`);
  }
  return state.fingerprint;
}

async function directoryTreeSha256(directoryPath: string): Promise<Sha256Digest> {
  const hash = createHash('sha256');
  const walk = async (currentPath: string, relativePrefix: string): Promise<void> => {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) =>
      allocationCollisionKey(left.name).localeCompare(allocationCollisionKey(right.name))
    );
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const absolutePath = join(currentPath, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink())
        throw new Error(`Destination directory contains a symlink: ${relativePath}`);
      if (stats.isDirectory()) {
        hash.update(`d\0${relativePath}\0`);
        await walk(absolutePath, relativePath);
      } else if (stats.isFile()) {
        hash.update(`f\0${relativePath}\0${stats.size}\0`);
        hash.update(await readFile(absolutePath));
      } else {
        throw new Error(`Destination directory contains an unsupported entry: ${relativePath}`);
      }
    }
  };
  await walk(directoryPath, '');
  return `sha256:${hash.digest('hex')}`;
}
