import { useCanvasStore } from '../canvas/public/store';
import type { Tab, TabLoadStatus } from '../canvas/public/types';
import { presentDocument } from '../canvas/public/present-document';
import {
  cancelledDocumentOpen,
  presentedTabId,
  type DocumentOpenResult,
  type PresentedDocument,
  type OpenStrategy,
} from '../canvas/public/document-presentation';
export type { OpenStrategy } from '../canvas/public/document-presentation';
import { platform } from '../../platform';
import { isHostedBrowserRuntime } from '../../utils/environment';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
import {
  findWorkspaceRootForPath,
  getCatalogEntityForFilePath,
  inferCatalogFileKind,
  registerWorkspaceFile,
  type CatalogEntityType,
} from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
  projectPathIsReadOnly,
  type ProjectEditFolder,
} from '../workspace-loader/public/project-edit-folders';
import {
  HARD_CAP_BYTES,
  SOFT_WARN_BYTES,
  extBucket,
  sizeBucket,
} from '../../shared/oversized-guard';
import {
  isCompressedGenBankPath,
  sequenceParserRouteForPath,
} from '../../shared/scientific-file-types';
import { useOversizedDialogStore } from './oversized-dialog-store';
import { logOversizedDecision } from './oversized-telemetry';
import { registerIndexedGenomeOpen } from './indexed-genome-lifecycle-telemetry';
import { extensionForPath, safeIndexedGenomeName } from './indexed-genome-paths';
import { candidatePackagedConstructPath } from './resolve-construct-path';
import {
  attachImportOperationToPendingFileOpen,
  fileSizeBucket,
  fileTypeCategory,
  registerPendingFileOpen,
  trackFileOpenFailure,
  type FileOpenSourceSurface,
} from './file-open-telemetry';
import {
  sequenceDocumentKey,
  type ManagedSequenceDocumentRef,
  type SequenceDocumentRef,
} from '../../shared/managed-sequence-document';
import { managedSequenceRepository } from './managed-sequence-repository';
import {
  catalogSequenceDocumentRef,
  resolveSequenceDocument,
} from './sequence-document-repository';
import { readStableWorkspaceGeneration } from '../../services/workspace-sync-renderer-generation';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import type { QuickLookPackageReceipt } from '../../shared/file-association-ipc';
import type { FileAssociationFamilyId } from '../../shared/file-associations';
import { MANAGED_DNA_FILE_EXTENSIONS } from '@waypoint/sequence-utils/sequence-file-types';

export interface QuickLookSequencePresentation {
  readonly kind: 'quick-look';
  readonly receipt: QuickLookPackageReceipt;
}

export type SequenceOpenPresentation = QuickLookSequencePresentation;

export interface OpenSequenceFileOptions {
  filePath: string;
  label: string;
  strategy?: OpenStrategy;

  signal?: AbortSignal;

  readOnly?: boolean;

  skipOversizedPrompt?: boolean;
  sourceSurface?: FileOpenSourceSurface;
  presentation?: SequenceOpenPresentation;

  importOperationId?: string;
}

export type SequenceOpenRoute = 'indexed' | 'block' | 'warn' | 'load';

export function decideSequenceOpenRoute(filePath: string, sizeBytes: number): SequenceOpenRoute {
  const parserRoute = sequenceParserRouteForPath(filePath, sizeBytes);
  if (parserRoute === 'indexed') return 'indexed';
  if (sizeBytes > HARD_CAP_BYTES) return 'block';
  if (sizeBytes >= SOFT_WARN_BYTES) return 'warn';
  return 'load';
}

interface InflightSequenceOpen {
  promise: Promise<DocumentOpenResult>;
  telemetry: OpenSequenceTelemetryContext;
  consumers: Map<symbol, OpenSequenceFileOptions>;
  emptyController: AbortController;
  abandoned: boolean;
  started: boolean;
}

interface OpenSequenceTelemetryContext {
  sourceSurface: FileOpenSourceSurface;
  importOperationIds: Set<string>;
}

const inflight = new Map<string, InflightSequenceOpen>();
const queuedSuccessors = new Map<string, InflightSequenceOpen>();

function consumeInflightSequenceOpen(
  entry: InflightSequenceOpen,
  options: OpenSequenceFileOptions
): Promise<DocumentOpenResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve(cancelledDocumentOpen());
  if (entry.abandoned) {
    if (entry.started) return entry.promise.then(() => cancelledDocumentOpen());
    entry.abandoned = false;
    entry.emptyController = new AbortController();
  }
  const consumer = Symbol('sequence-open-consumer');
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

function presentationTabPatch(
  presentation: SequenceOpenPresentation | undefined
): Pick<Tab, 'readOnly' | 'quickLookSource' | 'sourceFileName'> | null {
  if (!presentation) return null;
  return {
    readOnly: true,
    quickLookSource: presentation.receipt,
    sourceFileName: presentation.receipt.sourceFileName,
  };
}

function presentationAssociationFamilyId(
  presentation: SequenceOpenPresentation | undefined
): FileAssociationFamilyId | undefined {
  return presentation?.receipt.familyId;
}

export async function openSequenceFileResult(
  opts: OpenSequenceFileOptions
): Promise<DocumentOpenResult> {
  return openSequenceFileWithTelemetry(opts, telemetryFor(opts));
}

function telemetryFor(opts: OpenSequenceFileOptions): OpenSequenceTelemetryContext {
  return {
    sourceSurface: opts.sourceSurface ?? 'unknown',
    importOperationIds: new Set(opts.importOperationId ? [opts.importOperationId] : []),
  };
}

async function openSequenceFileWithTelemetry(
  opts: OpenSequenceFileOptions,
  requestedTelemetry: OpenSequenceTelemetryContext
): Promise<DocumentOpenResult> {
  if (opts.signal?.aborted) return cancelledDocumentOpen();

  let fs: ReturnType<typeof platform>['fs'];
  try {
    fs = platform().fs;
  } catch {
    return openResolvedSequenceFile(opts, undefined, requestedTelemetry);
  }
  if (!isHostedBrowserRuntime() && typeof fs.canonicalPath === 'function') {
    opts = { ...opts, filePath: await fs.canonicalPath(opts.filePath) };
    if (opts.signal?.aborted) return cancelledDocumentOpen();
  }
  if (typeof fs.exists === 'function') {
    const managed = await managedSequenceRepository.findByMemberPath(opts.filePath);
    if (opts.signal?.aborted) return cancelledDocumentOpen();
    if (managed) {
      return openResolvedSequenceFile(
        { ...opts, filePath: managed.productPath, label: managed.document.name || opts.label },
        managed.ref,
        requestedTelemetry
      );
    }
  }
  if (
    !isHostedBrowserRuntime() &&
    !opts.readOnly &&
    !opts.presentation &&
    !isDeveloperImportSourcePath(opts.filePath) &&
    !isCompressedGenBankPath(opts.filePath) &&
    sequenceParserRouteForPath(opts.filePath, 0) !== 'indexed' &&
    MANAGED_DNA_FILE_EXTENSIONS.includes(extensionForPath(opts.filePath))
  ) {
    const folders = mergeProjectEditFolders(
      await listProjectEditFolders({ includeSharedAccess: false }),
      useWorkspaceStore.getState().folders
    );
    const root = findWorkspaceRootForPath(folders, opts.filePath);
    if (
      root &&
      !projectPathIsReadOnly(opts.filePath, folders) &&
      typeof fs.exists === 'function' &&
      (await fs.exists(opts.filePath))
    ) {
      try {
        const packageRoot = await automaticallyPackageSequence(root, opts.filePath);
        if (opts.signal?.aborted) return cancelledDocumentOpen();
        if (packageRoot) {
          const managed = await managedSequenceRepository.openPackage(packageRoot);
          return openResolvedSequenceFile(
            { ...opts, filePath: managed.productPath, label: managed.document.name || opts.label },
            managed.ref,
            requestedTelemetry
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { reportEntityMigrationIssues } =
          await import('../../services/workspace-reconcile-report');
        reportEntityMigrationIssues(root, {
          migrationIssues: [{ path: opts.filePath, reason: message, kind: 'failed' }],
        });
        if (!/DIRTY_(FILE_DRAFT|NOTEBOOK|SEQUENCE)/u.test(message))
          return { status: 'failed', message };
        const existingEntity = await getCatalogEntityForFilePath(opts.filePath);
        if (!existingEntity || !useCanvasStore.getState().findTab('sequence', existingEntity.id))
          opts = { ...opts, readOnly: true };
      }
    }
  }
  return openResolvedSequenceFile(opts, undefined, requestedTelemetry);
}

const automaticPackageOpens = new Map<string, Promise<string | null>>();

async function automaticallyPackageSequence(
  workspaceRoot: string,
  sourcePath: string
): Promise<string | null> {
  const existing = automaticPackageOpens.get(sourcePath);
  if (existing) return existing;
  const operation = (async () => {
    const owner = platform().looseSequenceFiles;
    if (!owner) return null;
    const inspection = await owner.inspect({ workspaceRoot, sourcePath });
    if (inspection?.state !== 'convertible') return null;
    const conversion = await owner.convert({ workspaceRoot, sourcePath, automatic: true });
    if (!conversion.converted || conversion.packageRoots.length === 0) {
      if (conversion.reason) {
        const { reportEntityMigrationIssues } =
          await import('../../services/workspace-reconcile-report');
        reportEntityMigrationIssues(workspaceRoot, {
          migrationIssues: [{ path: sourcePath, reason: conversion.reason, kind: 'refused' }],
        });
      }
      if (conversion.disposition !== 'source-only' && conversion.disposition !== 'owned')
        throw new Error(
          conversion.reason ??
            'The sequence could not be converted. Its original file was preserved.'
        );
      return null;
    }
    const { reconcileWorkspaceAfterFilesChanged } =
      await import('../../services/workspace-operations');
    await reconcileWorkspaceAfterFilesChanged({
      workspaceRoot,
      revealPath: conversion.packageRoots[0],
      strict: true,
      healManagedHead: false,
    });
    return conversion.packageRoots[0];
  })();
  automaticPackageOpens.set(sourcePath, operation);
  try {
    return await operation;
  } finally {
    if (automaticPackageOpens.get(sourcePath) === operation)
      automaticPackageOpens.delete(sourcePath);
  }
}

export async function openManagedSequenceDocumentResult(
  ref: ManagedSequenceDocumentRef,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<DocumentOpenResult> {
  return openSequenceDocumentResult(ref, options);
}

export async function openSequenceDocumentResult(
  ref: SequenceDocumentRef,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<DocumentOpenResult> {
  const resolved = await resolveSequenceDocument(ref);
  return openResolvedSequenceFile(
    { ...options, filePath: resolved.sourcePath, label: resolved.name || options.label },
    resolved.ref,
    telemetryFor({ ...options, filePath: resolved.sourcePath })
  );
}

export async function openSequencePackageResult(
  packageRoot: string,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<DocumentOpenResult> {
  const managed = await managedSequenceRepository.openPackage(packageRoot);
  return openResolvedSequenceFile(
    { ...options, filePath: managed.productPath, label: managed.document.name || options.label },
    managed.ref,
    telemetryFor({ ...options, filePath: managed.productPath })
  );
}

function reuseAlreadyOpenSequenceTab(args: {
  sequenceDocument: SequenceDocumentRef;
  filePath: string;
  readOnly: boolean;
  presentationPatch:
    | Pick<Tab, 'readOnly' | 'quickLookSource' | 'sourceFileName'>
    | null
    | undefined;
  telemetry: OpenSequenceTelemetryContext;
}): PresentedDocument | null {
  const documentId = sequenceDocumentKey(args.sequenceDocument);
  const alreadyOpen = useCanvasStore.getState().findTab('sequence', documentId);
  if (!alreadyOpen || isTransitionalOpen(alreadyOpen.panelId, alreadyOpen.tabId)) {
    return null;
  }
  for (const importOperationId of args.telemetry.importOperationIds) {
    attachImportOperationToPendingFileOpen({
      documentId,
      filePath: args.filePath,
      importOperationId,
      sourceSurface: args.telemetry.sourceSurface,
    });
  }
  useCanvasStore
    .getState()
    .retargetTab(
      alreadyOpen.panelId,
      alreadyOpen.tabId,
      { type: 'sequence', sequenceDocument: args.sequenceDocument },
      { readOnly: args.readOnly, ...(args.presentationPatch ?? {}) }
    );
  const tab = useCanvasStore
    .getState()
    .panels[alreadyOpen.panelId]?.tabs.find((item) => item.id === alreadyOpen.tabId);
  if (!tab) return null;
  useCanvasStore.getState().focusPanel(alreadyOpen.panelId);
  const { id: _id, ...description } = tab;
  const result = presentDocument(
    description,
    { kind: 'panel', panelId: alreadyOpen.panelId },
    tab.loadStatus === 'missing'
      ? 'missing'
      : tab.loadStatus === 'error' || tab.loadStatus === 'indexed-error'
        ? 'error'
        : 'loading'
  );
  return result.status === 'presented' ? result : null;
}

async function statSequenceOpenSource(
  filePath: string,
  folders: ProjectEditFolder[]
): Promise<{
  sizeBytes: number | null;
  sourceMtimeMs: number | undefined;
  sourceCtimeMs: number | undefined;
  modifiedAt: number | null;
  statKind: 'ok' | 'missing' | 'error';
  workspaceRoot: string | null;
}> {
  const workspaceRoot = findWorkspaceRootForPath(folders, filePath);
  try {
    const s = await readStableWorkspaceGeneration(workspaceRoot, () =>
      platform().fs.stat(filePath)
    );
    if (!s) {
      return {
        sizeBytes: null,
        sourceMtimeMs: undefined,
        sourceCtimeMs: undefined,
        modifiedAt: null,
        statKind: 'missing',
        workspaceRoot,
      };
    }
    return {
      sizeBytes: s.size,
      sourceMtimeMs: s.mtime,
      sourceCtimeMs: s.ctime,
      modifiedAt: s.mtime,
      statKind: 'ok',
      workspaceRoot,
    };
  } catch (err) {
    return {
      sizeBytes: null,
      sourceMtimeMs: undefined,
      sourceCtimeMs: undefined,
      modifiedAt: null,
      statKind: (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'error',
      workspaceRoot,
    };
  }
}

async function openResolvedSequenceFile(
  opts: OpenSequenceFileOptions,
  suppliedDocument: SequenceDocumentRef | undefined,
  requestedTelemetry: OpenSequenceTelemetryContext,
  internal: {
    bypassSuccessor?: InflightSequenceOpen;
    catalogAlreadyChecked?: boolean;
    externalConsumers?: Map<symbol, OpenSequenceFileOptions>;
  } = {}
): Promise<DocumentOpenResult> {
  let sequenceDocument = suppliedDocument;
  if (
    !sequenceDocument &&
    !internal.catalogAlreadyChecked &&
    !isDeveloperImportSourcePath(opts.filePath)
  ) {
    const existingCatalogEntity = await getCatalogEntityForFilePath(opts.filePath);
    if (opts.signal?.aborted) return cancelledDocumentOpen();
    if (existingCatalogEntity) {
      sequenceDocument = catalogSequenceDocumentRef(existingCatalogEntity.id);
    }
  }

  const key = sequenceDocument
    ? sequenceDocumentKey(sequenceDocument)
    : `unresolved-sequence-source:${opts.filePath}`;
  const queuedSuccessor = queuedSuccessors.get(key);
  if (queuedSuccessor && queuedSuccessor !== internal.bypassSuccessor) {
    mergeSequenceOpenTelemetry(queuedSuccessor, requestedTelemetry, sequenceDocument, key, opts);
    return consumeInflightSequenceOpen(queuedSuccessor, opts);
  }
  if (queuedSuccessor === internal.bypassSuccessor) queuedSuccessors.delete(key);
  const existing = inflight.get(key);
  if (existing) {
    if (existing.abandoned) {
      const successor = queueSequenceOpenSuccessor(
        key,
        existing,
        opts,
        sequenceDocument,
        requestedTelemetry
      );
      return consumeInflightSequenceOpen(successor, opts);
    }
    mergeSequenceOpenTelemetry(existing, requestedTelemetry, sequenceDocument, key, opts);
    return consumeInflightSequenceOpen(existing, opts);
  }

  const telemetry = requestedTelemetry;
  const entry: InflightSequenceOpen = {
    promise: Promise.resolve(cancelledDocumentOpen()),
    telemetry,
    consumers: new Map(),
    emptyController: new AbortController(),
    abandoned: false,
    started: true,
  };
  inflight.set(key, entry);
  const hasActiveConsumers = (): boolean => getActiveOptions() !== null;
  const getActiveOptions = (): OpenSequenceFileOptions | null =>
    internal.externalConsumers?.values().next().value ??
    entry.consumers.values().next().value ??
    null;

  entry.promise = Promise.resolve()
    .then(async () => {
      if (!hasActiveConsumers()) return cancelledDocumentOpen();
      const { filePath } = opts;
      const registeredFolders = await listProjectEditFolders({ includeSharedAccess: false });
      const projectFolders = () =>
        mergeProjectEditFolders(registeredFolders, useWorkspaceStore.getState().folders);
      const getActivePresentation = () => {
        const options = getActiveOptions();
        if (!options) return null;
        const presentationPatch = presentationTabPatch(options.presentation);
        const sourceFileName =
          presentationPatch?.sourceFileName ?? filePath.split(/[\\/]/u).filter(Boolean).pop();
        return {
          options,
          label: options.label,
          strategy: options.strategy ?? ({ kind: 'focused' } satisfies OpenStrategy),
          presentationPatch: {
            ...(presentationPatch ?? {}),
            ...(sourceFileName ? { sourceFileName } : {}),
          },
          readOnly:
            isDeveloperImportSourcePath(filePath) ||
            Boolean(presentationPatch?.readOnly ?? options.readOnly) ||
            projectPathIsReadOnly(filePath, projectFolders()),
        };
      };
      const ext = extBucket(filePath);

      if (sequenceDocument) {
        const active = getActivePresentation();
        if (!active) return cancelledDocumentOpen();
        const alreadyOpenTabId = reuseAlreadyOpenSequenceTab({
          sequenceDocument,
          filePath,
          readOnly: active.readOnly,
          presentationPatch: active.presentationPatch,
          telemetry,
        });
        if (alreadyOpenTabId) return alreadyOpenTabId;
      }

      const { sizeBytes, sourceMtimeMs, sourceCtimeMs, modifiedAt, statKind } =
        await statSequenceOpenSource(filePath, projectFolders());
      if (!hasActiveConsumers()) return cancelledDocumentOpen();

      if (statKind === 'missing') {
        const packagedPath = candidatePackagedConstructPath(filePath);
        if (packagedPath && packagedPath !== filePath) {
          try {
            const packagedStat = await platform().fs.stat(packagedPath);
            if (packagedStat) {
              const active = getActivePresentation();
              if (!active) return cancelledDocumentOpen();
              return openSequenceFileWithTelemetry(
                {
                  ...active.options,
                  filePath: packagedPath,
                  signal: entry.emptyController.signal,
                },
                telemetry
              );
            }
          } catch {}
        }
      }

      if (statKind === 'ok' && !sequenceDocument) {
        const active = getActivePresentation();
        if (!active) return cancelledDocumentOpen();
        try {
          if (isDeveloperImportSourcePath(filePath)) {
            const existingPreview = Object.values(useCanvasStore.getState().panels)
              .flatMap((panel) => panel.tabs)
              .map((tab) => tab.sequenceDocument)
              .find((ref) => ref?.kind === 'import-source-sequence' && ref.sourcePath === filePath);
            sequenceDocument = existingPreview ?? {
              kind: 'import-source-sequence',
              documentId: crypto.randomUUID(),
              sourcePath: filePath,
            };
          } else {
            sequenceDocument = await registerSequenceFileInCatalog(
              filePath,
              active.label,
              sizeBytes ?? 0,
              modifiedAt,
              sequenceParserRouteForPath(filePath, sizeBytes ?? 0),
              projectFolders()
            );
          }
        } catch (error) {
          console.error(
            '[openSequenceFile] Refusing to open a sequence without logical identity:',
            error
          );
          return {
            status: 'failed',
            message: 'Could not register the sequence document.',
          } as const;
        }
        if (!hasActiveConsumers()) return cancelledDocumentOpen();
      }

      if (!sequenceDocument) {
        if (statKind !== 'ok') {
          trackFileOpenFailure({
            filePath,
            sourceSurface: telemetry.sourceSurface,
            sizeBucket: 'unknown',
            errorClass: 'filesystem',
            importOperationIds: telemetry.importOperationIds,
          });
        }
        console.error(
          '[openSequenceFile] Refusing to open an unavailable sequence with no catalog identity:',
          filePath
        );
        return {
          status: 'failed',
          message: 'The unavailable sequence has no catalog identity.',
        } as const;
      }

      const tabEntityId = sequenceDocumentKey(sequenceDocument);

      const activeForReuse = getActivePresentation();
      if (!activeForReuse) return cancelledDocumentOpen();
      const alreadyOpenTabId = reuseAlreadyOpenSequenceTab({
        sequenceDocument,
        filePath,
        readOnly: activeForReuse.readOnly,
        presentationPatch: activeForReuse.presentationPatch,
        telemetry,
      });
      if (alreadyOpenTabId) return alreadyOpenTabId;

      if (statKind !== 'ok') {
        const active = getActivePresentation();
        if (!active) return cancelledDocumentOpen();
        const opened = openInPanel(
          active.strategy,
          active.label,
          sequenceDocument,
          'loaded',
          active.readOnly,
          active.presentationPatch
        );
        if (opened) {
          useCanvasStore.getState().updateTab(opened.panelId, opened.tabId, {
            loadStatus: statKind,
            fileSizeBytes: undefined,
          });
        }
        logOversizedDecision({
          extBucket: ext,
          sizeBucket: '<100MB',
          decision: statKind === 'missing' ? 'missing' : 'stat-error',
        });
        trackFileOpenFailure({
          filePath,
          sourceSurface: telemetry.sourceSurface,
          sizeBucket: 'unknown',
          errorClass: 'filesystem',
          importOperationIds: telemetry.importOperationIds,
        });
        return opened
          ? { ...opened, content: statKind }
          : ({
              status: 'failed',
              message: 'The destination panel is no longer available.',
            } as const);
      }

      const size = sizeBytes ?? 0;
      const bucket = sizeBucket(size);

      const route = decideSequenceOpenRoute(filePath, size);
      if (route === 'indexed') {
        const active = getActivePresentation();
        if (!active) return cancelledDocumentOpen();
        const opened = openInPanel(
          active.strategy,
          active.label,
          sequenceDocument,
          'indexed-pending',
          active.readOnly,
          active.presentationPatch
        );
        if (opened) {
          if (opened.disposition === 'created')
            registerIndexedGenomeOpen(opened.tabId, tabEntityId);
          useCanvasStore.getState().updateTab(opened.panelId, opened.tabId, {
            loadStatus: 'indexed-pending',
            fileSizeBytes: size,
            indexedGenome: {
              sourcePath: filePath,
              sourceSizeBytes: size,
              sourceMtimeMs,
              sourceCtimeMs,
              sourceExt: extensionForPath(filePath),
              chrom: safeIndexedGenomeName(filePath),
            },
          });
          registerPendingFileOpen({
            documentId: tabEntityId,
            filePath,
            tabId: opened.tabId,
            fileTypeCategory: fileTypeCategory(filePath),
            sourceSurface: telemetry.sourceSurface,
            sizeBucket: fileSizeBucket(size),
            fileSizeBytes: size,
            associationFamilyId: presentationAssociationFamilyId(active.options.presentation),
            importOperationIds: telemetry.importOperationIds,
          });
        }
        logOversizedDecision({ extBucket: ext, sizeBucket: bucket, decision: 'indexed' });
        return (
          opened ??
          ({ status: 'failed', message: 'The destination panel is no longer available.' } as const)
        );
      }

      if (route === 'block') {
        logOversizedDecision({ extBucket: ext, sizeBucket: bucket, decision: 'blocked' });

        const active = getActivePresentation();
        if (!active) return cancelledDocumentOpen();
        if (!active.options.skipOversizedPrompt) {
          await useOversizedDialogStore.getState().requestBlock({ filePath, sizeBytes: size });
        }
        return { status: 'blocked', message: 'The sequence exceeds the file size limit.' } as const;
      }

      if (route === 'warn') {
        logOversizedDecision({ extBucket: ext, sizeBucket: bucket, decision: 'warned' });
        const active = getActivePresentation();
        if (!active) return cancelledDocumentOpen();
        if (!active.options.skipOversizedPrompt) {
          const proceed = await useOversizedDialogStore
            .getState()
            .requestWarn({ filePath, sizeBytes: size });
          if (!proceed) {
            logOversizedDecision({ extBucket: ext, sizeBucket: bucket, decision: 'cancelled' });
            return cancelledDocumentOpen();
          }
          if (!hasActiveConsumers()) return cancelledDocumentOpen();
        }
        logOversizedDecision({ extBucket: ext, sizeBucket: bucket, decision: 'confirmed' });
      }

      const active = getActivePresentation();
      if (!active) return cancelledDocumentOpen();
      const opened = openInPanel(
        active.strategy,
        active.label,
        sequenceDocument,
        'loaded',
        active.readOnly,
        active.presentationPatch
      );
      if (opened) {
        useCanvasStore.getState().updateTab(opened.panelId, opened.tabId, {
          loadStatus: 'loaded',
          fileSizeBytes: size,
        });
        registerPendingFileOpen({
          documentId: tabEntityId,
          filePath,
          tabId: opened.tabId,
          fileTypeCategory: fileTypeCategory(filePath),
          sourceSurface: telemetry.sourceSurface,
          sizeBucket: fileSizeBucket(size),
          fileSizeBytes: size,
          associationFamilyId: presentationAssociationFamilyId(active.options.presentation),
          importOperationIds: telemetry.importOperationIds,
        });
      }
      return (
        opened ??
        ({ status: 'failed', message: 'The destination panel is no longer available.' } as const)
      );
    })
    .finally(() => {
      if (inflight.get(key) === entry) inflight.delete(key);
    });

  return consumeInflightSequenceOpen(entry, opts);
}

function mergeSequenceOpenTelemetry(
  entry: InflightSequenceOpen,
  requestedTelemetry: OpenSequenceTelemetryContext,
  sequenceDocument: SequenceDocumentRef | undefined,
  key: string,
  opts: OpenSequenceFileOptions
): void {
  for (const importOperationId of requestedTelemetry.importOperationIds) {
    entry.telemetry.importOperationIds.add(importOperationId);
    entry.telemetry.sourceSurface = requestedTelemetry.sourceSurface;
    attachImportOperationToPendingFileOpen({
      ...(sequenceDocument ? { documentId: key } : {}),
      filePath: opts.filePath,
      importOperationId,
      sourceSurface: requestedTelemetry.sourceSurface,
    });
  }
}

function queueSequenceOpenSuccessor(
  key: string,
  predecessor: InflightSequenceOpen,
  opts: OpenSequenceFileOptions,
  sequenceDocument: SequenceDocumentRef | undefined,
  requestedTelemetry: OpenSequenceTelemetryContext
): InflightSequenceOpen {
  const existing = queuedSuccessors.get(key);
  if (existing) {
    mergeSequenceOpenTelemetry(existing, requestedTelemetry, sequenceDocument, key, opts);
    return existing;
  }
  const successor: InflightSequenceOpen = {
    promise: Promise.resolve(cancelledDocumentOpen()),
    telemetry: requestedTelemetry,
    consumers: new Map(),
    emptyController: new AbortController(),
    abandoned: false,
    started: false,
  };
  queuedSuccessors.set(key, successor);
  successor.promise = predecessor.promise
    .catch(() => null)
    .then(async () => {
      await Promise.resolve();
      let activeOptions = successor.consumers.values().next().value;
      if (!activeOptions) {
        successor.started = true;
        return cancelledDocumentOpen();
      }
      let successorDocument = sequenceDocument;
      if (!successorDocument) {
        const catalogEntity = await getCatalogEntityForFilePath(activeOptions.filePath);
        if (catalogEntity) successorDocument = catalogSequenceDocumentRef(catalogEntity.id);
      }
      activeOptions = successor.consumers.values().next().value;
      if (!activeOptions) {
        successor.started = true;
        return cancelledDocumentOpen();
      }
      successor.started = true;
      return openResolvedSequenceFile(
        { ...activeOptions, signal: successor.emptyController.signal },
        successorDocument,
        successor.telemetry,
        {
          bypassSuccessor: successor,
          catalogAlreadyChecked: true,
          externalConsumers: successor.consumers,
        }
      );
    })
    .finally(() => {
      for (const [candidateKey, candidate] of queuedSuccessors) {
        if (candidate === successor) queuedSuccessors.delete(candidateKey);
      }
    });
  return successor;
}

function isTransitionalOpen(panelId: string, tabId: string): boolean {
  const panel = useCanvasStore.getState().panels[panelId];
  const tab = panel?.tabs.find((t) => t.id === tabId);
  return tab?.loadStatus === 'indexed-pending';
}

function openInPanel(
  strategy: OpenStrategy,
  label: string,
  sequenceDocument: SequenceDocumentRef,
  loadStatus: TabLoadStatus = 'loaded',
  readOnly = false,
  presentationPatch: Pick<Tab, 'readOnly' | 'quickLookSource' | 'sourceFileName'> | null = null
): PresentedDocument | null {
  const result = presentDocument(
    {
      type: 'sequence',
      entityId: sequenceDocumentKey(sequenceDocument),
      label,
      loadStatus,
      readOnly,
      sequenceDocument,
      ...(presentationPatch ?? {}),
    },
    strategy,
    'loading'
  );
  if (result.status !== 'presented') return null;
  useCanvasStore
    .getState()
    .retargetTab(
      result.panelId,
      result.tabId,
      { type: 'sequence', sequenceDocument: sequenceDocument },
      { readOnly, ...(presentationPatch ?? {}) }
    );
  return result;
}

export function retargetOpenSequenceTab(
  current: SequenceDocumentRef,
  next: SequenceDocumentRef,
  options: {
    readonly label: string;
    readonly presentation: SequenceOpenPresentation | null;
  }
): string | null {
  const store = useCanvasStore.getState();
  const currentDocumentId = sequenceDocumentKey(current);
  const nextDocumentId = sequenceDocumentKey(next);
  const source = store.findTab('sequence', currentDocumentId);
  if (!source) return null;

  const duplicate = store.findTab('sequence', nextDocumentId);
  if (duplicate && duplicate.tabId !== source.tabId) {
    store.closeTab(duplicate.panelId, duplicate.tabId);
  }

  const presentationPatch = presentationTabPatch(options.presentation ?? undefined);
  store.retargetTab(
    source.panelId,
    source.tabId,
    { type: 'sequence', sequenceDocument: next },
    {
      label: options.label,
      readOnly: presentationPatch?.readOnly ?? false,
      quickLookSource: presentationPatch?.quickLookSource,
      sourceFileName: presentationPatch?.sourceFileName,
      isDirty: false,
      loadStatus: 'loaded',
    }
  );
  store.focusPanel(source.panelId);
  store.setActiveTab(source.panelId, source.tabId);
  return source.tabId;
}

async function registerSequenceFileInCatalog(
  filePath: string,
  label: string,
  sizeBytes: number,
  modifiedAt: number | null,
  parserRoute: ReturnType<typeof sequenceParserRouteForPath>,
  folders: ProjectEditFolder[]
): Promise<SequenceDocumentRef> {
  const fileKind = inferCatalogFileKind(filePath);
  const workspaceRoot = findWorkspaceRootForPath(folders, filePath);

  const entity = await withRendererWorkspaceMutation(workspaceRoot, (mutationToken) =>
    registerWorkspaceFile({
      path: filePath,
      name: label,
      entityType: catalogEntityTypeForFileKind(fileKind),
      fileKind,
      workspaceRoot,
      sizeBytes,
      modifiedAt,
      metadata: {
        discoveredFrom: 'open-sequence-file',
        parserRoute,
      },
      mutationToken,
    })
  );
  return catalogSequenceDocumentRef(entity.id);
}

function catalogEntityTypeForFileKind(fileKind: string): CatalogEntityType {
  if (fileKind === 'alignment') return 'alignment';
  if (fileKind === 'trace') return 'trace';
  return 'sequence';
}

export function __resetInflightForTests(): void {
  for (const entry of inflight.values()) entry.emptyController.abort();
  for (const entry of queuedSuccessors.values()) entry.emptyController.abort();
  inflight.clear();
  queuedSuccessors.clear();
}

export async function openSequenceFile(options: OpenSequenceFileOptions): Promise<string | null> {
  return presentedTabId(await openSequenceFileResult(options));
}
export async function openSequenceDocument(
  ref: SequenceDocumentRef,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<string | null> {
  return presentedTabId(await openSequenceDocumentResult(ref, options));
}
export async function openManagedSequenceDocument(
  ref: ManagedSequenceDocumentRef,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<string | null> {
  return presentedTabId(await openManagedSequenceDocumentResult(ref, options));
}
export async function openSequencePackage(
  path: string,
  options: Omit<OpenSequenceFileOptions, 'filePath'>
): Promise<string | null> {
  return presentedTabId(await openSequencePackageResult(path, options));
}
