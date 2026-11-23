import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

import { WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE } from '../shared/workspace-sync-errors';

type Release = () => void;

export type RendererDatabaseLifecycleSender = {
  id: number;
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): unknown;
  on(
    event: 'did-start-navigation',
    listener: (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => void
  ): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
};

interface FenceState {
  tail: Promise<void>;
  requested: boolean;
  fenced: boolean;
  transactionSettledWaiters: Array<() => void>;
  rendererWorkspaceMutations: Set<Promise<void>>;
  rendererTransactionOwnerId: number | null;
}

const states = new WeakMap<Database.Database, FenceState>();
const heldFences = new WeakMap<Release, Database.Database>();
const rendererTransactionCleanupSenders = new Set<number>();
const heldFenceScope = new AsyncLocalStorage<Release>();

export function trackRendererWorkspaceMutation(db: Database.Database): Release {
  const active = stateFor(db).rendererWorkspaceMutations;
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  active.add(settled);
  return () => {
    active.delete(settled);
    finish();
  };
}

export async function waitForRendererWorkspaceMutations(db: Database.Database): Promise<void> {
  const active = stateFor(db).rendererWorkspaceMutations;
  while (active.size) await Promise.all(active);
}

export function assertWorkspaceSyncDatabaseFence(db: Database.Database, release: Release): void {
  if (heldFences.get(release) !== db) throw new Error('WORKSPACE_DATABASE_FENCE_INVALID');
}

export async function acquireWorkspaceSyncDatabaseFence(db: Database.Database): Promise<Release> {
  const state = stateFor(db);
  const previous = state.tail;
  let releaseQueue: (() => void) | undefined;
  state.tail = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;
  state.requested = true;
  while (db.inTransaction) {
    await new Promise<void>((resolve) => state.transactionSettledWaiters.push(resolve));
  }
  state.fenced = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    heldFences.delete(release);
    state.fenced = false;
    state.requested = false;
    releaseQueue?.();
  };
  heldFences.set(release, db);
  return release;
}

export async function withWorkspaceSyncDatabaseFence<T>(
  db: Database.Database,
  operation: (release: Release) => Promise<T>
): Promise<T> {
  const release = await acquireWorkspaceSyncDatabaseFence(db);
  try {
    return await heldFenceScope.run(release, () => operation(release));
  } finally {
    release();
  }
}

export function assertRendererDatabaseStatementAllowed(
  db: Database.Database,
  senderId?: number
): void {
  const state = states.get(db);
  if (
    db.inTransaction &&
    state?.rendererTransactionOwnerId != null &&
    senderId !== state.rendererTransactionOwnerId
  ) {
    throw new Error('DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER');
  }

  if (!db.inTransaction && (state?.requested || state?.fenced)) {
    throw new Error(WORKSPACE_SYNC_DATABASE_BUSY_MESSAGE);
  }
}

export function assertCommittedDatabaseReadAllowed(
  db: Database.Database,
  databaseFence?: Release
): void {
  const fence = databaseFence ?? heldWorkspaceSyncDatabaseFence(db);
  if (fence) assertWorkspaceSyncDatabaseFence(db, fence);
  else assertRendererDatabaseStatementAllowed(db);
  if (db.inTransaction) throw new Error('DATABASE_UNCOMMITTED_AUTHORITY_READ');
}

function heldWorkspaceSyncDatabaseFence(db: Database.Database): Release | undefined {
  const release = heldFenceScope.getStore();
  return release && heldFences.get(release) === db ? release : undefined;
}

export function notifyRendererDatabaseStatementSettled(
  db: Database.Database,
  input?: { senderId: number; wasInTransaction: boolean }
): void {
  const state = stateFor(db);
  if (input && !input.wasInTransaction && db.inTransaction) {
    state.rendererTransactionOwnerId = input.senderId;
  }
  if (db.inTransaction) return;
  state.rendererTransactionOwnerId = null;
  const waiters = state.transactionSettledWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

export function rollbackRendererDatabaseTransactionForOwner(
  db: Database.Database,
  senderId: number
): boolean {
  const state = states.get(db);
  if (!db.inTransaction || state?.rendererTransactionOwnerId !== senderId) return false;
  db.exec('ROLLBACK');
  notifyRendererDatabaseStatementSettled(db);
  return true;
}

export function withRendererDatabaseStatement<T>(
  db: Database.Database,
  sender: RendererDatabaseLifecycleSender,
  operation: () => T
): T {
  const wasInTransaction = db.inTransaction;
  assertRendererDatabaseStatementAllowed(db, sender.id);
  try {
    return operation();
  } finally {
    notifyRendererDatabaseStatementSettled(db, {
      senderId: sender.id,
      wasInTransaction,
    });
    if (db.inTransaction) armRendererTransactionCrashCleanup(db, sender);
  }
}

export async function withRendererDatabaseStatementWhenReady<T>(
  db: Database.Database,
  sender: RendererDatabaseLifecycleSender,
  operation: () => T
): Promise<Awaited<T>> {
  for (;;) {
    const state = states.get(db);

    if (db.inTransaction || !(state?.requested || state?.fenced))
      return await withRendererDatabaseStatement(db, sender, operation);
    await state.tail;
  }
}

export const withRendererDatabaseRead = withRendererDatabaseStatementWhenReady;

export function armRendererTransactionCrashCleanup(
  db: Database.Database,
  sender: RendererDatabaseLifecycleSender
): void {
  const senderId = sender.id;
  if (rendererTransactionCleanupSenders.has(senderId)) return;
  rendererTransactionCleanupSenders.add(senderId);

  const cleanup = (): void => {
    sender.removeListener('destroyed', onDestroyed);
    sender.removeListener('render-process-gone', onRenderProcessGone);
    sender.removeListener('did-start-navigation', onMainFrameNavigation);
    rendererTransactionCleanupSenders.delete(senderId);
    rollbackRendererDatabaseTransactionForOwner(db, senderId);
  };
  const onDestroyed = (): void => cleanup();
  const onRenderProcessGone = (): void => cleanup();
  const onMainFrameNavigation = (
    _event: unknown,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame && !isInPlace) cleanup();
  };

  sender.once('destroyed', onDestroyed);
  sender.once('render-process-gone', onRenderProcessGone);
  sender.on('did-start-navigation', onMainFrameNavigation);
}

function stateFor(db: Database.Database): FenceState {
  const existing = states.get(db);
  if (existing) return existing;
  const created: FenceState = {
    tail: Promise.resolve(),
    requested: false,
    fenced: false,
    transactionSettledWaiters: [],
    rendererWorkspaceMutations: new Set(),
    rendererTransactionOwnerId: null,
  };
  states.set(db, created);
  return created;
}
