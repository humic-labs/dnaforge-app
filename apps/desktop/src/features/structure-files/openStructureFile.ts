import { structureCoordinateScores } from '../page/public/embeds/structure3d/structureScoreState';
import { useCanvasStore } from '../canvas/public/store';
import type { TabLoadStatus } from '../canvas/public/types';
import { presentDocument } from '../canvas/public/present-document';
import {
  cancelledDocumentOpen,
  presentedTabId,
  type DocumentOpenResult,
  type OpenStrategy,
} from '../canvas/public/document-presentation';
import { useOversizedDialogStore } from '../sequence/public/oversized-dialog-store';
import { platform } from '../../platform';
import {
  findWorkspaceRootForPath,
  getCatalogWorkspaceRootForFilePath,
  inferCatalogFileKind,
  registerWorkspaceFile,
} from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { documentReadError } from '../../shared/document-read-failure';
import { HARD_CAP_BYTES, SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { getStructureFileFormat, type StructureFileFormat } from '../../utils/fileTypes';
import type {
  Structure3dAttrs,
  StructureCoordinateArtifactRef,
} from '../page/public/embeds/structure3d/types';
import {
  createCoordinateOnlyStructureViewIdentity,
  createUnavailableCoordinateViewId,
} from '../structure-drawer/public/utils/structure-view-identity';
import {
  clearStructureFileSnapshotsForTests,
  registerStructureFileSnapshot,
} from './structure-file-snapshots';

export interface OpenStructureFileOptions {
  filePath: string;
  label: string;
  strategy?: OpenStrategy;
  skipOversizedPrompt?: boolean;
  signal?: AbortSignal;
  operationId?: string;
}

interface InflightStructureOpen {
  promise: Promise<DocumentOpenResult>;
  consumers: Map<symbol, OpenStructureFileOptions>;
  emptyController: AbortController;
  abandoned: boolean;
  started: boolean;
}

const inflight = new Map<string, InflightStructureOpen>();
const queuedSuccessors = new Map<string, InflightStructureOpen>();
const STRUCTURE_READ_MAX_CONCURRENT = 4;
const STRUCTURE_READ_MAX_CONCURRENT_BYTES = HARD_CAP_BYTES;
const STRUCTURE_READ_CAPACITY_MAX_WAITERS = 32;
let activeStructureReads = 0;
let activeStructureReadBytes = 0;

interface StructureReadAfterCapacityHold {
  readonly reached: Promise<void>;
  readonly wait: Promise<void>;
  readonly markReached: () => void;
  readonly release: () => void;
}

let nextStructureReadAfterCapacityHold: StructureReadAfterCapacityHold | null = null;

interface StructureReadCapacityWaiter {
  readonly sizeBytes: number;
  readonly signal: AbortSignal;
  readonly resolve: (release: (() => void) | null) => void;
  readonly onAbort: () => void;
}

const structureReadCapacityWaiters = new Set<StructureReadCapacityWaiter>();

export function holdNextStructureReadAfterCapacityForTest(): {
  reached: Promise<void>;
  release: () => void;
} {
  if (nextStructureReadAfterCapacityHold) {
    throw new Error('A structure read is already armed for an after-capacity hold.');
  }
  let markReached = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  nextStructureReadAfterCapacityHold = { reached, wait, markReached, release };
  return { reached, release };
}

async function waitAfterStructureReadCapacityForTest(): Promise<void> {
  const hold = nextStructureReadAfterCapacityHold;
  if (!hold) return;
  nextStructureReadAfterCapacityHold = null;
  hold.markReached();
  await hold.wait;
}

function canReserveStructureRead(sizeBytes: number): boolean {
  return (
    activeStructureReads < STRUCTURE_READ_MAX_CONCURRENT &&
    activeStructureReadBytes + sizeBytes <= STRUCTURE_READ_MAX_CONCURRENT_BYTES
  );
}

function reserveStructureRead(sizeBytes: number): () => void {
  activeStructureReads += 1;
  activeStructureReadBytes += sizeBytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeStructureReads = Math.max(0, activeStructureReads - 1);
    activeStructureReadBytes = Math.max(0, activeStructureReadBytes - sizeBytes);
    wakeStructureReadCapacityWaiters();
  };
}

function wakeStructureReadCapacityWaiters(): void {
  for (const waiter of structureReadCapacityWaiters) {
    if (waiter.signal.aborted) {
      structureReadCapacityWaiters.delete(waiter);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve(null);
      continue;
    }
    if (!canReserveStructureRead(waiter.sizeBytes)) break;
    structureReadCapacityWaiters.delete(waiter);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(reserveStructureRead(waiter.sizeBytes));
  }
}

function acquireStructureReadCapacity(
  rawSizeBytes: number,
  signal: AbortSignal
): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null);
  const sizeBytes = Math.max(1, Math.ceil(rawSizeBytes));
  if (sizeBytes > STRUCTURE_READ_MAX_CONCURRENT_BYTES) {
    throw new Error('Structure file exceeds the shared renderer read budget.');
  }
  if (structureReadCapacityWaiters.size === 0 && canReserveStructureRead(sizeBytes)) {
    return Promise.resolve(reserveStructureRead(sizeBytes));
  }
  if (structureReadCapacityWaiters.size >= STRUCTURE_READ_CAPACITY_MAX_WAITERS) {
    throw new Error('Structure file read capacity queue is full.');
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      structureReadCapacityWaiters.delete(waiter);
      signal.removeEventListener('abort', onAbort);
      resolve(null);
      wakeStructureReadCapacityWaiters();
    };
    const waiter: StructureReadCapacityWaiter = { sizeBytes, signal, resolve, onAbort };
    structureReadCapacityWaiters.add(waiter);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

let holdNextStructureOpenBeforeCommit = false;
interface StructureOpenOperationDiagnostic {
  operationId: string;
  filePath: string;
  coordinateDigestSha256: string;
}
const structureOpenCancellationDiagnostics = {
  precommitHoldsStarted: 0,
  activePrecommitHolds: 0,
  abortedPrecommitHolds: 0,
  activePrecommitOperation: null as StructureOpenOperationDiagnostic | null,
  lastAbortedPrecommitOperation: null as StructureOpenOperationDiagnostic | null,
};

export function holdNextStructureOpenBeforeCommitForTest(): void {
  if (holdNextStructureOpenBeforeCommit) {
    throw new Error('A structure open is already armed for a precommit hold.');
  }
  holdNextStructureOpenBeforeCommit = true;
}

export function getStructureOpenCancellationDiagnosticsForTest(): {
  inflightCount: number;
  precommitHoldsStarted: number;
  activePrecommitHolds: number;
  abortedPrecommitHolds: number;
  activePrecommitOperation: StructureOpenOperationDiagnostic | null;
  lastAbortedPrecommitOperation: StructureOpenOperationDiagnostic | null;
} {
  return {
    inflightCount: inflight.size,
    precommitHoldsStarted: structureOpenCancellationDiagnostics.precommitHoldsStarted,
    activePrecommitHolds: structureOpenCancellationDiagnostics.activePrecommitHolds,
    abortedPrecommitHolds: structureOpenCancellationDiagnostics.abortedPrecommitHolds,
    activePrecommitOperation: structureOpenCancellationDiagnostics.activePrecommitOperation
      ? { ...structureOpenCancellationDiagnostics.activePrecommitOperation }
      : null,
    lastAbortedPrecommitOperation:
      structureOpenCancellationDiagnostics.lastAbortedPrecommitOperation
        ? { ...structureOpenCancellationDiagnostics.lastAbortedPrecommitOperation }
        : null,
  };
}

function waitForStructureOpenCommitPermission(
  signal: AbortSignal,
  operation: StructureOpenOperationDiagnostic
): Promise<boolean> {
  if (!holdNextStructureOpenBeforeCommit) return Promise.resolve(true);
  holdNextStructureOpenBeforeCommit = false;
  structureOpenCancellationDiagnostics.precommitHoldsStarted += 1;
  structureOpenCancellationDiagnostics.activePrecommitHolds += 1;
  structureOpenCancellationDiagnostics.activePrecommitOperation = { ...operation };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      structureOpenCancellationDiagnostics.activePrecommitHolds = Math.max(
        0,
        structureOpenCancellationDiagnostics.activePrecommitHolds - 1
      );
      structureOpenCancellationDiagnostics.abortedPrecommitHolds += 1;
      structureOpenCancellationDiagnostics.activePrecommitOperation = null;
      structureOpenCancellationDiagnostics.lastAbortedPrecommitOperation = { ...operation };
      resolve(false);
    };
    const abort = (): void => finish();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function consumeInflightStructureOpen(
  entry: InflightStructureOpen,
  options: OpenStructureFileOptions
): Promise<DocumentOpenResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve(cancelledDocumentOpen());
  if (entry.abandoned) {
    if (entry.started) return entry.promise.then(() => cancelledDocumentOpen());
    entry.abandoned = false;
    entry.emptyController = new AbortController();
  }
  const consumer = Symbol('structure-open-consumer');
  entry.consumers.set(consumer, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      entry.consumers.delete(consumer);
      if (entry.consumers.size === 0 && !entry.abandoned) {
        entry.abandoned = true;
        entry.emptyController.abort();
      }
      callback();
    };
    const abort = (): void => finish(() => resolve(cancelledDocumentOpen()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    entry.promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

export function openStructureFileResult(
  options: OpenStructureFileOptions
): Promise<DocumentOpenResult> {
  return openStructureFileInternal(options);
}

async function openStructureFileInternal(
  options: OpenStructureFileOptions,
  bypassSuccessor?: InflightStructureOpen,
  externalConsumers?: Map<symbol, OpenStructureFileOptions>
): Promise<DocumentOpenResult> {
  if (options.signal?.aborted) return cancelledDocumentOpen();
  const format = getStructureFileFormat(options.filePath);
  if (!format)
    return {
      status: 'unsupported',
      message: `Unsupported structure coordinate file: ${options.filePath}`,
    };

  const queuedSuccessor = queuedSuccessors.get(options.filePath);
  if (queuedSuccessor && queuedSuccessor !== bypassSuccessor) {
    return consumeInflightStructureOpen(queuedSuccessor, options);
  }
  if (queuedSuccessor === bypassSuccessor) queuedSuccessors.delete(options.filePath);
  const existing = inflight.get(options.filePath);
  if (existing) {
    if (existing.abandoned) {
      return consumeInflightStructureOpen(queueStructureOpenSuccessor(existing, options), options);
    }
    return consumeInflightStructureOpen(existing, options);
  }

  const entry: InflightStructureOpen = {
    promise: Promise.resolve(cancelledDocumentOpen()),
    consumers: new Map(),
    emptyController: new AbortController(),
    abandoned: false,
    started: true,
  };
  inflight.set(options.filePath, entry);
  const getActiveOptions = (): OpenStructureFileOptions | null =>
    externalConsumers?.values().next().value ?? entry.consumers.values().next().value ?? null;
  entry.promise = Promise.resolve()
    .then(() =>
      openStructureFileOnce(
        options.filePath,
        format,
        getActiveOptions,
        entry.emptyController.signal
      )
    )
    .finally(() => {
      if (inflight.get(options.filePath) === entry) inflight.delete(options.filePath);
    });
  return consumeInflightStructureOpen(entry, options);
}

function queueStructureOpenSuccessor(
  predecessor: InflightStructureOpen,
  options: OpenStructureFileOptions
): InflightStructureOpen {
  const existing = queuedSuccessors.get(options.filePath);
  if (existing) return existing;
  const successor: InflightStructureOpen = {
    promise: Promise.resolve(cancelledDocumentOpen()),
    consumers: new Map(),
    emptyController: new AbortController(),
    abandoned: false,
    started: false,
  };
  queuedSuccessors.set(options.filePath, successor);
  successor.promise = predecessor.promise
    .catch(() => null)
    .then(async () => {
      await Promise.resolve();
      const activeOptions = successor.consumers.values().next().value;
      if (!activeOptions) {
        successor.started = true;
        return cancelledDocumentOpen();
      }
      successor.started = true;
      return openStructureFileInternal(
        { ...activeOptions, signal: successor.emptyController.signal },
        successor,
        successor.consumers
      );
    })
    .finally(() => {
      if (queuedSuccessors.get(options.filePath) === successor) {
        queuedSuccessors.delete(options.filePath);
      }
    });
  return successor;
}

async function openStructureFileOnce(
  filePath: string,
  format: StructureFileFormat,
  getActiveOptions: () => OpenStructureFileOptions | null,
  allConsumersAbortedSignal: AbortSignal
): Promise<DocumentOpenResult> {
  if (!getActiveOptions()) return cancelledDocumentOpen();
  let stat: Awaited<ReturnType<ReturnType<typeof platform>['fs']['stat']>>;
  try {
    stat = await platform().fs.stat(filePath);
  } catch (error) {
    const activeOptions = getActiveOptions();
    if (!activeOptions) return cancelledDocumentOpen();
    const status: TabLoadStatus =
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'error';
    return openUnavailableStructureTab(
      activeOptions,
      activeOptions.strategy ?? { kind: 'focused' },
      format,
      status
    );
  }
  let activeOptions = getActiveOptions();
  if (!activeOptions) return cancelledDocumentOpen();
  if (!stat) {
    return openUnavailableStructureTab(
      activeOptions,
      activeOptions.strategy ?? { kind: 'focused' },
      format,
      'missing'
    );
  }

  if (stat.size > HARD_CAP_BYTES) {
    if (!activeOptions.skipOversizedPrompt) {
      await useOversizedDialogStore.getState().requestBlock({ filePath, sizeBytes: stat.size });
    }
    return { status: 'blocked', message: 'The structure exceeds the file size limit.' };
  }
  if (stat.size >= SOFT_WARN_BYTES && !activeOptions.skipOversizedPrompt) {
    const proceed = await useOversizedDialogStore
      .getState()
      .requestWarn({ filePath, sizeBytes: stat.size });
    if (!proceed) return cancelledDocumentOpen();
    if (!getActiveOptions()) return cancelledDocumentOpen();
  }

  const releaseReadCapacity = await acquireStructureReadCapacity(
    stat.size,
    allConsumersAbortedSignal
  );
  if (!releaseReadCapacity) return cancelledDocumentOpen();
  await waitAfterStructureReadCapacityForTest();
  if (allConsumersAbortedSignal.aborted || !getActiveOptions()) {
    releaseReadCapacity();
    return cancelledDocumentOpen();
  }
  try {
    let data: string | Uint8Array;
    try {
      data =
        format.encoding === 'binary'
          ? await platform().fs.readFile(filePath)
          : await platform().fs.readTextFile(filePath);
    } catch {
      activeOptions = getActiveOptions();
      if (!activeOptions) return cancelledDocumentOpen();
      return openUnavailableStructureTab(
        activeOptions,
        activeOptions.strategy ?? { kind: 'focused' },
        format,
        'error'
      );
    }
    if (!getActiveOptions()) return cancelledDocumentOpen();
    try {
      const { readLooseCoordinateModel } = await import('../../shared/loose-coordinate-reader');
      await readLooseCoordinateModel(data, format);
    } catch (error) {
      if (!getActiveOptions()) return cancelledDocumentOpen();
      return { status: 'failed', message: documentReadError(error).message };
    }
    if (!getActiveOptions()) return cancelledDocumentOpen();
    const coordinateDigestSha256 = await digestStructureData(data);
    activeOptions = getActiveOptions();
    if (!activeOptions) return cancelledDocumentOpen();
    const folders = useWorkspaceStore.getState().folders;
    const workspaceRoot =
      (await getCatalogWorkspaceRootForFilePath(filePath)) ??
      findWorkspaceRootForPath(folders, filePath);
    if (!getActiveOptions()) return cancelledDocumentOpen();
    const fileKind = inferCatalogFileKind(filePath);
    const catalogEntity = await registerWorkspaceFile({
      path: filePath,
      name: activeOptions.label,
      entityType: 'structure',
      fileKind,
      workspaceRoot,
      contentHash: `sha256:${coordinateDigestSha256}`,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
      metadata: {
        discoveredFrom: 'open-structure-file',
        parser: format.parser,
        encoding: format.encoding,
        coordinateDigestSha256,
      },
    });
    if (!getActiveOptions()) return cancelledDocumentOpen();

    const structureId = `structure:file:${catalogEntity.id}:${coordinateDigestSha256}`;
    const revisionId = `structure-coordinate:file:v1:${coordinateDigestSha256}`;
    const structureViewIdentity = createCoordinateOnlyStructureViewIdentity({
      catalogEntityId: catalogEntity.id,
      coordinateDigestSha256,
    });
    const structureArtifactRef: StructureCoordinateArtifactRef = {
      entityId: catalogEntity.id,
      revisionId,
      structureId,
      coordinateDigestSha256,
      artifactPath: filePath,
      format: format.encoding === 'binary' ? 'binary-cif' : format.parser,
    };
    activeOptions = getActiveOptions();
    if (!activeOptions) return cancelledDocumentOpen();
    const operation: StructureOpenOperationDiagnostic = {
      operationId: activeOptions.operationId ?? globalThis.crypto.randomUUID(),
      filePath,
      coordinateDigestSha256,
    };
    if (!(await waitForStructureOpenCommitPermission(allConsumersAbortedSignal, operation))) {
      return cancelledDocumentOpen();
    }
    activeOptions = getActiveOptions();
    if (!activeOptions) return cancelledDocumentOpen();
    const attrs: Structure3dAttrs = {
      source: 'file',
      sourceId: filePath,
      coordinateFilePath: filePath,
      label: activeOptions.label,
      title: activeOptions.label,
      structureArtifactRef,
      structureViewIdentity,
      coordinateScores: structureCoordinateScores(data, coordinateDigestSha256),
    };
    registerStructureFileSnapshot({
      structureViewId: structureViewIdentity.structureViewId,
      revisionId,
      filePath,
      coordinateDigestSha256,
      parser: format.parser,
      encoding: format.encoding,
      data,
    });

    const opened = openInPanel(
      activeOptions.strategy ?? { kind: 'focused' },
      structureViewIdentity.structureViewId,
      activeOptions.label,
      attrs,
      'loaded'
    );
    return opened;
  } finally {
    releaseReadCapacity();
  }
}

function openUnavailableStructureTab(
  options: OpenStructureFileOptions,
  strategy: OpenStrategy,
  format: StructureFileFormat,
  loadStatus: Extract<TabLoadStatus, 'missing' | 'error'>
): DocumentOpenResult {
  const structureViewId = createUnavailableCoordinateViewId(options.filePath);
  const attrs: Structure3dAttrs = {
    source: 'file',
    sourceId: options.filePath,
    coordinateFilePath: options.filePath,
    label: options.label,
    title: options.label,
    structureViewIdentity: { schemaVersion: 1, structureViewId, bindingId: null },
    error:
      loadStatus === 'missing' ? 'Coordinate file is missing' : 'Coordinate file is unreadable',
  };
  return openInPanel(strategy, structureViewId, options.label, attrs, loadStatus);
}

function openInPanel(
  strategy: OpenStrategy,
  structureViewId: string,
  label: string,
  initialStructureAttrs: Structure3dAttrs,
  loadStatus: TabLoadStatus
): DocumentOpenResult {
  const result = presentDocument(
    {
      type: 'structure',
      entityId: structureViewId,
      label,
      initialStructureAttrs,
      loadStatus,
    },
    strategy,
    loadStatus === 'missing' ? 'missing' : loadStatus === 'error' ? 'error' : 'loading'
  );
  if (result.status === 'presented') {
    useCanvasStore
      .getState()
      .updateTab(result.panelId, result.tabId, { initialStructureAttrs, loadStatus });
  }
  return result;
}

async function digestStructureData(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function __resetOpenStructureFileForTests(): void {
  for (const entry of inflight.values()) entry.emptyController.abort();
  for (const entry of queuedSuccessors.values()) entry.emptyController.abort();
  inflight.clear();
  queuedSuccessors.clear();
  nextStructureReadAfterCapacityHold?.release();
  nextStructureReadAfterCapacityHold = null;
  holdNextStructureOpenBeforeCommit = false;
  structureOpenCancellationDiagnostics.precommitHoldsStarted = 0;
  structureOpenCancellationDiagnostics.activePrecommitHolds = 0;
  structureOpenCancellationDiagnostics.abortedPrecommitHolds = 0;
  structureOpenCancellationDiagnostics.activePrecommitOperation = null;
  structureOpenCancellationDiagnostics.lastAbortedPrecommitOperation = null;
  clearStructureFileSnapshotsForTests();
}

export async function openStructureFile(options: OpenStructureFileOptions): Promise<string | null> {
  return presentedTabId(await openStructureFileResult(options));
}
