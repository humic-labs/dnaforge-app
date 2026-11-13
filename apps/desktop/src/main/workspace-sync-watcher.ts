import { createHash } from 'node:crypto';
import { realpathSync, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type Database from 'better-sqlite3';

import type { WorkspaceSyncStatusPublisher } from './workspace-sync-status';
import { isWorkspaceSyncOperationalPath } from './workspace-sync-paths';

export type ManagedWorkspaceSyncWatcherErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_NOT_MANAGED'
  | 'WORKSPACE_ARCHIVED'
  | 'WORKSPACE_TRASHED';

export class ManagedWorkspaceSyncWatcherError extends Error {
  constructor(
    readonly code: ManagedWorkspaceSyncWatcherErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ManagedWorkspaceSyncWatcherError';
  }
}

export interface WatchDirectoryEvent {
  eventType: string;
  filename?: string | null;
}

export type WatchDirectoryCallback = (event: WatchDirectoryEvent) => void;

export interface WatchDirectoryHandle {
  close(): void;
}

export interface ManagedWorkspaceSyncChangeEvent {
  workspaceUuid: string;
  workspaceId: number;
  repoPath: string;
  reason: 'fs_event' | 'poll_changed';
  emittedAt: number;
}

export interface ManagedWorkspaceSyncWatchState {
  workspaceUuid: string;
  workspaceId: number;
  repoPath: string;
  nativeWatchActive: boolean;
  pollFallbackActive: boolean;
  reused: boolean;
}

export interface ManagedWorkspaceSyncWatcherDeps {
  watchDirectory?: (repoPath: string, callback: WatchDirectoryCallback) => WatchDirectoryHandle;
  computeFingerprint?: (repoPath: string) => Promise<string | null>;
  onWorkspaceChanged?: (event: ManagedWorkspaceSyncChangeEvent) => void;
  statusPublisher?: Pick<WorkspaceSyncStatusPublisher, 'invalidate'>;
  debounceMs?: number;
  pollIntervalMs?: number;
  setPollInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearPollInterval?: (handle: unknown) => void;
  nowMs?: () => number;
}

interface WorkspaceRow {
  id: number;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
}

interface ActiveWatcher {
  workspaceUuid: string;
  workspaceId: number;
  repoPath: string;
  ready: Promise<void>;
  nativeWatch: WatchDirectoryHandle | null;
  pollInterval: unknown;
  fingerprint: string | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_DEBOUNCE_MS = 250;
const TREE_SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

export class ManagedWorkspaceSyncWatcher {
  private readonly active = new Map<string, ActiveWatcher>();
  private readonly fingerprintRoots = new Map<string, Set<string>>();

  constructor(
    private readonly db: Database.Database,
    private readonly deps: ManagedWorkspaceSyncWatcherDeps = {}
  ) {}

  async ensureWatching(workspaceUuid: string): Promise<ManagedWorkspaceSyncWatchState> {
    const existing = this.active.get(workspaceUuid);
    if (existing) {
      await existing.ready;
      return toWatchState(existing, true);
    }

    const workspace = selectManagedWorkspace(this.db, workspaceUuid);
    const roots = new Set(this.fingerprintRoots.get(workspaceUuid));
    roots.add(workspace.path);
    this.fingerprintRoots.set(workspaceUuid, roots);
    const active: ActiveWatcher = {
      workspaceUuid,
      workspaceId: workspace.id,
      repoPath: workspace.path,
      ready: Promise.resolve().then(() => this.initialize(active)),
      nativeWatch: null,
      pollInterval: null,
      fingerprint: null,
      debounceTimer: null,
    };

    this.active.set(workspaceUuid, active);
    await active.ready;
    return toWatchState(active, false);
  }

  private async initialize(active: ActiveWatcher): Promise<void> {
    if (this.active.get(active.workspaceUuid) !== active) return;
    try {
      active.nativeWatch = this.startNativeWatch(active);
      if (this.active.get(active.workspaceUuid) !== active) {
        this.retire(active);
        return;
      }
      const fingerprint = await this.safeComputeFingerprint(active.repoPath);
      if (this.active.get(active.workspaceUuid) !== active) return;
      active.fingerprint = fingerprint;
      active.pollInterval = this.setPollInterval(() => {
        void this.checkForChanges(active, 'poll_changed');
      });
      if (this.active.get(active.workspaceUuid) !== active) this.retire(active);
    } catch (error) {
      this.retire(active);
      throw error;
    }
  }

  async pollNow(workspaceUuid: string): Promise<boolean> {
    const active = this.active.get(workspaceUuid);
    if (!active) return false;

    return this.checkForChanges(active, 'poll_changed');
  }

  private async checkForChanges(
    active: ActiveWatcher,
    reason: ManagedWorkspaceSyncChangeEvent['reason']
  ): Promise<boolean> {
    if (this.active.get(active.workspaceUuid) !== active) return false;
    try {
      await active.ready;
    } catch {
      return false;
    }
    if (this.active.get(active.workspaceUuid) !== active) return false;
    const nextFingerprint = await this.safeComputeFingerprint(active.repoPath);
    if (this.active.get(active.workspaceUuid) !== active) return false;
    if (nextFingerprint === null) return false;
    if (active.fingerprint === null) {
      active.fingerprint = nextFingerprint;
      return false;
    }
    if (nextFingerprint === active.fingerprint) return false;

    active.fingerprint = nextFingerprint;
    this.emitChanged(active, reason);
    return true;
  }

  stopWatching(workspaceUuid: string): Promise<void> {
    const active = this.active.get(workspaceUuid);
    return active ? this.retire(active) : this.drainFingerprints(workspaceUuid);
  }

  drainFingerprints(workspaceUuid?: string): Promise<void> {
    const roots = [...this.fingerprintRoots].filter(
      ([uuid]) => workspaceUuid === undefined || uuid === workspaceUuid
    );
    const drained = Promise.all(
      roots.flatMap(([, paths]) => [...paths].map(drainWorkspaceTreeFingerprints))
    );
    return drained.then(() => {
      for (const [uuid, paths] of roots)
        if (!this.active.has(uuid) && this.fingerprintRoots.get(uuid) === paths)
          this.fingerprintRoots.delete(uuid);
    });
  }

  private retire(active: ActiveWatcher): Promise<void> {
    const drain = this.drainFingerprints(active.workspaceUuid);
    if (this.active.get(active.workspaceUuid) === active) this.active.delete(active.workspaceUuid);
    const { nativeWatch, pollInterval, debounceTimer } = active;
    active.nativeWatch = null;
    active.pollInterval = null;
    active.debounceTimer = null;
    try {
      nativeWatch?.close();
    } finally {
      try {
        if (pollInterval !== null) this.clearPollInterval(pollInterval);
      } finally {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
      }
    }
    return drain;
  }

  stopAll(): Promise<void> {
    const drain = this.drainFingerprints();
    const failures: unknown[] = [];
    for (const active of [...this.active.values()]) {
      try {
        this.retire(active);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Workspace watcher cleanup failed');
    return drain;
  }

  activeWatcherCount(): number {
    return this.active.size;
  }

  private startNativeWatch(active: ActiveWatcher): WatchDirectoryHandle | null {
    const watchDirectory = this.deps.watchDirectory ?? defaultWatchDirectory;
    try {
      return watchDirectory(active.repoPath, (event) => {
        if (event.filename && shouldIgnoreRelativePath(event.filename)) return;
        this.scheduleChanged(active, 'fs_event');
      });
    } catch (err) {
      console.warn(
        `[WorkspaceSyncWatcher] Native watch unavailable for ${active.workspaceUuid}:`,
        (err as Error).message
      );
      return null;
    }
  }

  private scheduleChanged(
    active: ActiveWatcher,
    reason: ManagedWorkspaceSyncChangeEvent['reason']
  ) {
    if (this.active.get(active.workspaceUuid) !== active) return;
    if ((this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS) <= 0) {
      void this.checkForChanges(active, reason);
      return;
    }

    if (active.debounceTimer) clearTimeout(active.debounceTimer);
    active.debounceTimer = setTimeout(() => {
      if (this.active.get(active.workspaceUuid) !== active) return;
      active.debounceTimer = null;
      void this.checkForChanges(active, reason);
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private emitChanged(
    active: ActiveWatcher,
    reason: ManagedWorkspaceSyncChangeEvent['reason']
  ): void {
    this.deps.onWorkspaceChanged?.({
      workspaceUuid: active.workspaceUuid,
      workspaceId: active.workspaceId,
      repoPath: active.repoPath,
      reason,
      emittedAt: this.deps.nowMs?.() ?? Date.now(),
    });
    if (this.active.get(active.workspaceUuid) === active)
      this.deps.statusPublisher?.invalidate(active.workspaceUuid, 'workspace_changed');
  }

  private async safeComputeFingerprint(repoPath: string): Promise<string | null> {
    const computeFingerprint = this.deps.computeFingerprint ?? computeWorkspaceTreeFingerprint;
    try {
      return await computeFingerprint(repoPath);
    } catch (err) {
      console.warn(
        `[WorkspaceSyncWatcher] Poll fingerprint failed for ${repoPath}:`,
        (err as Error).message
      );
      return null;
    }
  }

  private setPollInterval(callback: () => void): unknown {
    const intervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const setPollInterval = this.deps.setPollInterval ?? setInterval;
    return setPollInterval(callback, intervalMs);
  }

  private clearPollInterval(handle: unknown): void {
    const clearPollInterval = this.deps.clearPollInterval ?? clearInterval;
    clearPollInterval(handle as never);
  }
}

interface FingerprintTicket {
  result: Promise<string>;
  settled: Promise<void>;
  resolve(value: string): void;
  reject(error: unknown): void;
}

interface FingerprintLane {
  canonicalRoot: string;
  aliases: Set<string>;
  running: FingerprintTicket | null;
  pending: FingerprintTicket | null;
}

const fingerprintLanes = new Map<string, FingerprintLane>();
const fingerprintLanesByAlias = new Map<string, Set<FingerprintLane>>();

function fingerprintTicket(): FingerprintTicket {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    result,
    settled: result.then(
      () => undefined,
      () => undefined
    ),
    resolve,
    reject,
  };
}

function startFingerprintTicket(lane: FingerprintLane, ticket: FingerprintTicket): void {
  lane.running = ticket;
  const finish = () => {
    if (lane.pending) {
      const next = lane.pending;
      lane.pending = null;
      startFingerprintTicket(lane, next);
    } else {
      lane.running = null;
      if (fingerprintLanes.get(lane.canonicalRoot) === lane)
        fingerprintLanes.delete(lane.canonicalRoot);
      for (const alias of lane.aliases) {
        const lanes = fingerprintLanesByAlias.get(alias);
        lanes?.delete(lane);
        if (lanes?.size === 0) fingerprintLanesByAlias.delete(alias);
      }
    }
  };
  void computeRawWorkspaceTreeFingerprint(lane.canonicalRoot).then(
    (value) => {
      ticket.resolve(value);
      finish();
    },
    (error) => {
      ticket.reject(error);
      finish();
    }
  );
}

export function computeWorkspaceTreeFingerprint(repoPath: string): Promise<string> {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(repoPath);
  } catch (error) {
    return Promise.reject(error);
  }
  let lane = fingerprintLanes.get(canonicalRoot);
  if (!lane) {
    lane = { canonicalRoot, aliases: new Set(), running: null, pending: null };
    fingerprintLanes.set(canonicalRoot, lane);
  }
  lane.aliases.add(repoPath);
  const aliases = fingerprintLanesByAlias.get(repoPath) ?? new Set<FingerprintLane>();
  aliases.add(lane);
  fingerprintLanesByAlias.set(repoPath, aliases);
  if (lane.running) {
    lane.pending ??= fingerprintTicket();
    return lane.pending.result;
  }
  const ticket = fingerprintTicket();
  startFingerprintTicket(lane, ticket);
  return ticket.result;
}

function drainWorkspaceTreeFingerprints(repoPath: string): Promise<void> {
  const tickets = new Set<FingerprintTicket>();
  for (const lane of fingerprintLanesByAlias.get(repoPath) ?? []) {
    if (lane.running) tickets.add(lane.running);
    if (lane.pending) tickets.add(lane.pending);
  }
  return Promise.all([...tickets].map((ticket) => ticket.settled)).then(() => undefined);
}

async function computeRawWorkspaceTreeFingerprint(repoPath: string): Promise<string> {
  const entries: string[] = [];
  await collectTreeFingerprintEntries(repoPath, repoPath, entries);
  const hash = createHash('sha256');
  for (const entry of entries.sort()) {
    hash.update(entry);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function selectManagedWorkspace(db: Database.Database, workspaceUuid: string): WorkspaceRow {
  const workspace = db
    .prepare(
      `SELECT id, path, repo_uuid, archived_at, trashed_at
       FROM workspaces
       WHERE repo_uuid = ?
       LIMIT 1`
    )
    .get(workspaceUuid) as WorkspaceRow | undefined;

  if (!workspace) {
    throw new ManagedWorkspaceSyncWatcherError(
      'WORKSPACE_NOT_FOUND',
      `Managed workspace not found for repo_uuid ${workspaceUuid}`
    );
  }
  if (!workspace.repo_uuid) {
    throw new ManagedWorkspaceSyncWatcherError(
      'WORKSPACE_NOT_MANAGED',
      `Workspace ${workspaceUuid} is not managed`
    );
  }
  if (workspace.archived_at !== null) {
    throw new ManagedWorkspaceSyncWatcherError(
      'WORKSPACE_ARCHIVED',
      `Workspace ${workspaceUuid} is archived and cannot be watched for sync`
    );
  }
  if (workspace.trashed_at !== null) {
    throw new ManagedWorkspaceSyncWatcherError(
      'WORKSPACE_TRASHED',
      `Workspace ${workspaceUuid} is trashed and cannot be watched for sync`
    );
  }
  return workspace;
}

async function collectTreeFingerprintEntries(
  rootPath: string,
  dirPath: string,
  entries: string[]
): Promise<void> {
  const dirents = await readdir(dirPath, { withFileTypes: true });
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (TREE_SKIP_NAMES.has(dirent.name) || dirent.isSymbolicLink()) continue;

    const absolutePath = join(dirPath, dirent.name);
    const relPath = normalizeRelativePath(relative(rootPath, absolutePath));
    if (isWorkspaceSyncOperationalPath(relPath, dirent.isDirectory())) continue;

    if (dirent.isDirectory()) {
      await collectTreeFingerprintEntries(rootPath, absolutePath, entries);
      continue;
    }

    if (!dirent.isFile()) continue;
    try {
      const fileStat = await stat(absolutePath);
      entries.push(`f:${relPath}:${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`);
    } catch {}
  }
}

function defaultWatchDirectory(
  repoPath: string,
  callback: WatchDirectoryCallback
): WatchDirectoryHandle {
  const watcher = watch(repoPath, { persistent: false, recursive: true }, (eventType, filename) => {
    callback({
      eventType,
      filename: filename ? filename.toString() : null,
    });
  });
  return watcher;
}

function toWatchState(active: ActiveWatcher, reused: boolean): ManagedWorkspaceSyncWatchState {
  return {
    workspaceUuid: active.workspaceUuid,
    workspaceId: active.workspaceId,
    repoPath: active.repoPath,
    nativeWatchActive: active.nativeWatch !== null,
    pollFallbackActive: active.pollInterval !== null,
    reused,
  };
}

function shouldIgnoreRelativePath(filename: string): boolean {
  const normalized = normalizeRelativePath(filename);
  return (
    normalized.split('/').some((segment) => TREE_SKIP_NAMES.has(segment)) ||
    isWorkspaceSyncOperationalPath(normalized)
  );
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}
