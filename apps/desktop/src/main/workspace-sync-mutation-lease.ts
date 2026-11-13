import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type Database from 'better-sqlite3';

type Release = () => void;
type Mode = 'shared' | 'exclusive';

interface Waiter {
  mode: Mode;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface WorkspaceMutationState {
  readers: number;
  writer: boolean;
  waiters: Waiter[];
}

const states = new Map<string, WorkspaceMutationState>();
const heldMutationLeases = new WeakMap<Release, string>();
const replicaApplications = new Set<string>();
const releaseListeners = new Set<(workspaceRoot: string) => void>();

export function subscribeWorkspaceMutationReleased(
  listener: (workspaceRoot: string) => void
): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
}

export const MAX_WORKSPACE_MUTATION_WAITERS_PER_ROOT = 64;

export function acquireWorkspaceMutationShared(workspaceRoot: string): Promise<Release> {
  return acquire(workspaceRoot, 'shared');
}

export function assertWorkspaceMutationLease(lease: Release, workspaceRoot: string): void {
  if (heldMutationLeases.get(lease) !== canonicalizePotentialPath(workspaceRoot))
    throw new Error('WORKSPACE_MUTATION_LEASE_INVALID');
}

export function tryAcquireWorkspaceMutationShared(workspaceRoot: string): Release | null {
  const root = canonicalizePotentialPath(workspaceRoot);
  const state = states.get(root);
  if (state && (state.readers > 0 || state.writer || state.waiters.length > 0)) return null;
  const available = state ?? stateFor(root);
  available.readers += 1;
  return releaseOnce(root, available, 'shared');
}

export function waitForWorkspaceMutationShared(
  workspaceRoot: string,
  options: { signal?: AbortSignal } = {}
): Promise<Release> {
  if (options.signal?.aborted) {
    return Promise.reject(new Error('WORKSPACE_MUTATION_WAIT_ABORTED'));
  }
  return acquire(workspaceRoot, 'shared', options.signal);
}

export function acquireWorkspaceSyncMutationLease(workspaceRoot: string): Promise<Release> {
  return acquire(workspaceRoot, 'exclusive');
}

export async function acquireWorkspaceSyncReplicaApplyLease(
  workspaceRoot: string
): Promise<Release> {
  const root = canonicalizePotentialPath(workspaceRoot);
  const release = await acquireWorkspaceSyncMutationLease(root);
  replicaApplications.add(root);
  let released = false;
  const releaseReplica = () => {
    if (released) return;
    released = true;
    heldMutationLeases.delete(releaseReplica);
    replicaApplications.delete(root);
    release();
  };
  heldMutationLeases.set(releaseReplica, root);
  return releaseReplica;
}

export function isWorkspaceSyncReplicaApplying(workspaceRoot: string): boolean {
  return replicaApplications.has(canonicalizePotentialPath(workspaceRoot));
}

export async function withWorkspaceMutation<T>(
  workspaceRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const release = await acquireWorkspaceMutationShared(workspaceRoot);
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function withKnownWorkspacePathMutation<T>(
  db: Database.Database,
  paths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const roots = [
    ...new Set(paths.map((path) => findKnownWorkspaceRoot(db, path)).filter(isString)),
  ].sort();
  if (roots.length > 1) {
    throw new Error('WORKSPACE_MUTATION_CROSSES_KNOWN_WORKSPACES');
  }
  const releases: Release[] = [];
  try {
    for (const root of roots) releases.push(await acquireWorkspaceMutationShared(root));
    return await operation();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export async function withKnownWorkspacePathsMutationAcrossWorkspaces<T>(
  db: Database.Database,
  paths: readonly string[],
  operation: (leases: ReadonlyMap<string, Release>) => Promise<T>
): Promise<T> {
  const roots = [
    ...new Set(paths.map((path) => findKnownWorkspaceRoot(db, path)).filter(isString)),
  ].sort();
  const releases: Release[] = [];
  try {
    for (const root of roots) releases.push(await acquireWorkspaceMutationShared(root));
    return await operation(new Map(roots.map((root, index) => [root, releases[index]])));
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export async function withDeclaredWorkspaceMutation<T>(
  db: Database.Database,
  declaredWorkspaceRoot: string,
  mutationPaths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const owningRoot = findKnownWorkspaceRoot(db, declaredWorkspaceRoot);
  if (!owningRoot) throw new Error('WORKSPACE_MUTATION_UNKNOWN_WORKSPACE');
  for (const path of mutationPaths) {
    const pathRoot = findKnownWorkspaceRoot(db, path);
    if (pathRoot !== owningRoot) {
      throw new Error('WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH');
    }
  }
  return withWorkspaceMutation(owningRoot, operation);
}

export function findKnownWorkspaceRoot(db: Database.Database, path: string): string | null {
  const candidate = canonicalizePotentialPath(path);
  const rows = db
    .prepare(
      `SELECT path
       FROM workspaces
       WHERE path IS NOT NULL
         AND archived_at IS NULL
         AND trashed_at IS NULL`
    )
    .all() as Array<{ path: string }>;
  const matching = [
    ...new Set(
      rows
        .map((row) => canonicalizePotentialPath(row.path))
        .filter((root) => isAtOrUnder(candidate, root))
    ),
  ].sort((left, right) => right.length - left.length);
  const deepest = matching[0];
  if (!deepest) return null;
  const deepestMatches = matching.filter((root) => root.length === deepest.length);
  return deepestMatches.length === 1 ? deepest : null;
}

export function hasWorkspaceSyncMutationLeaseForTest(workspaceRoot?: string): boolean {
  if (workspaceRoot) return states.get(canonicalizePotentialPath(workspaceRoot))?.writer === true;
  return [...states.values()].some((state) => state.writer);
}

export function workspaceMutationWaiterCountForTest(workspaceRoot: string): number {
  return states.get(canonicalizePotentialPath(workspaceRoot))?.waiters.length ?? 0;
}

export function workspaceMutationRootIdentity(workspaceRoot: string): string {
  return canonicalizePotentialPath(workspaceRoot);
}

function acquire(workspaceRoot: string, mode: Mode, signal?: AbortSignal): Promise<Release> {
  const root = canonicalizePotentialPath(workspaceRoot);
  const state = stateFor(root);
  if (
    mode === 'shared' &&
    (state.readers > 0 ||
      state.writer ||
      state.waiters.some((waiter) => waiter.mode === 'exclusive'))
  ) {
    return enqueueWaiter(root, state, mode, signal);
  }
  if (mode === 'shared' && !state.writer && state.waiters.length === 0) {
    state.readers += 1;
    return Promise.resolve(releaseOnce(root, state, mode));
  }
  if (mode === 'exclusive' && !state.writer && state.readers === 0 && state.waiters.length === 0) {
    state.writer = true;
    return Promise.resolve(releaseOnce(root, state, mode));
  }
  return enqueueWaiter(root, state, mode, signal);
}

function enqueueWaiter(
  root: string,
  state: WorkspaceMutationState,
  mode: Mode,
  signal?: AbortSignal
): Promise<Release> {
  if (signal?.aborted) {
    return Promise.reject(new Error('WORKSPACE_MUTATION_WAIT_ABORTED'));
  }
  if (state.waiters.length >= MAX_WORKSPACE_MUTATION_WAITERS_PER_ROOT) {
    return Promise.reject(new Error('WORKSPACE_MUTATION_WAIT_QUEUE_FULL'));
  }
  return new Promise((resolveWaiter, rejectWaiter) => {
    const waiter: Waiter = { mode, resolve: resolveWaiter, reject: rejectWaiter, signal };
    if (signal) {
      waiter.abortListener = () => {
        const index = state.waiters.indexOf(waiter);
        if (index < 0) return;
        state.waiters.splice(index, 1);
        rejectWaiter(new Error('WORKSPACE_MUTATION_WAIT_ABORTED'));
        if (!state.writer && state.readers === 0 && state.waiters.length === 0) {
          states.delete(root);
        }
      };
      signal.addEventListener('abort', waiter.abortListener, { once: true });
    }
    state.waiters.push(waiter);
  });
}

function stateFor(root: string): WorkspaceMutationState {
  const existing = states.get(root);
  if (existing) return existing;
  const created: WorkspaceMutationState = { readers: 0, writer: false, waiters: [] };
  states.set(root, created);
  return created;
}

function releaseOnce(root: string, state: WorkspaceMutationState, mode: Mode): Release {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    heldMutationLeases.delete(release);
    if (mode === 'shared') state.readers -= 1;
    else state.writer = false;
    grantQueued(root, state);
    for (const listener of [...releaseListeners]) {
      try {
        listener(root);
      } catch (error) {
        console.warn('[WorkspaceMutation] Release notification failed:', error);
      }
    }
  };
  heldMutationLeases.set(release, root);
  return release;
}

function grantQueued(root: string, state: WorkspaceMutationState): void {
  if (state.writer || state.readers > 0) return;
  const first = state.waiters.shift();
  if (!first) {
    states.delete(root);
    return;
  }
  if (first.signal && first.abortListener) {
    first.signal.removeEventListener('abort', first.abortListener);
  }
  if (first.mode === 'exclusive') {
    state.writer = true;
    first.resolve(releaseOnce(root, state, 'exclusive'));
    return;
  }
  state.readers += 1;
  first.resolve(releaseOnce(root, state, 'shared'));
}

function isAtOrUnder(candidate: string, root: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function isString(value: string | null): value is string {
  return value !== null;
}

function canonicalizePotentialPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..');
    if (parent === existing) return absolute;
    suffix.unshift(relative(parent, existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}
