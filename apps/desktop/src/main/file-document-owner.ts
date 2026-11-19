import { createKeyedMutex } from './workspace-git/keyed-mutex';
import { tableDataForPersistence } from '../shared/table-document-data';
import { isForgePackageMetaPath } from '../shared/forge-package-path';
import { canonicalJson } from '../shared/canonical-json';
import { executeTableModelCommand } from '../shared/notebook-model/table/table-model-commands';
import {
  parseTablePackageHead,
  serializeTablePackageHead,
  tablePackageHeadWithData,
  type TablePackageHead,
} from '../shared/table-package';
import {
  legacyFileDraftSchema,
  legacyFileDraftFingerprint,
  type LegacyFileDraft,
  type LegacyFileDraftRetention,
} from '../shared/file-document-legacy-recovery';
import { createHash, randomUUID } from 'node:crypto';
import { EditorState, Text, Transaction } from '@codemirror/state';
import {
  history,
  historyField,
  undo,
  redo,
  undoDepth,
  redoDepth,
  isolateHistory,
} from '@codemirror/commands';
import type { Cell, TableData } from '../shared/table-document-types';
import {
  createTableDataMemory,
  tableDataModel,
  type TableDataMemory,
} from '../shared/notebook-model/table/table-data-model';
import { parseTabularPreview, serializeDelimitedRows } from '../shared/tabular-file';
import {
  fileDocumentRequestSchema,
  type FileDocumentRequest,
  type FileDocumentSnapshot,
  type FileDocumentClientOperation,
  type FileDocumentTextChange,
} from '../shared/file-document';
import type { TextFileAtomicWriteInput } from '../shared/text-file-atomic';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import type { NativeDirtyDocument } from '../shared/native-document-drafts';

export interface NativeFileDocumentAdmission {
  path: string;
  workspaceRoot: string;
  readOnly: boolean;
  assertCurrent(): void;
}

export interface NativeFileDocumentRecord {
  version: 1;
  documentId: string;
  path: string;
  baseline: string;
  revision?: number;
  persistedRevision?: number;
  content: string;
  dirty: boolean;
  textState?: unknown;
  tableData?: TableData;
  firstRowAsHeader?: boolean;
  headerRowValues?: string[];
  tableHistory?: TableDataMemory;
  richTableHistory?: { undo: TableData[]; redo: TableData[] };
  pendingIdentityRetirement?: { previousDocumentId: string; documentId: string };
}

export interface NativeFileDocumentOwnerOptions {
  normalizePath?(path: string): string;
  beforeExecute?(path: string, client: 'native' | 'renderer'): Promise<void>;
  completeLegacyMigration?(pendingPaths: readonly string[]): Promise<void>;
  beginLegacyMigration?(): void;
  admit(
    path: string,
    workspaceRoot: string | undefined,
    mutating: boolean
  ): Promise<NativeFileDocumentAdmission>;
  read(path: string, maximumBytes: number): Promise<Uint8Array>;
  verifyTablePackage?(admission: NativeFileDocumentAdmission, content: string): Promise<void>;
  write(input: TextFileAtomicWriteInput, admission: NativeFileDocumentAdmission): Promise<void>;
  loadRecord(path: string): Promise<NativeFileDocumentRecord | undefined>;
  resolveIdentity?(documentId: string): Promise<string | undefined>;
  identityForPath?(path: string): Promise<string | undefined>;
  retireReboundIdentity?(input: {
    path: string;
    previousDocumentId: string;
    documentId: string;
  }): Promise<void>;
  listRetainedDirty?(): Promise<ReadonlyArray<{ documentId: string; path: string }>>;
  assertRecoveryClean?(path: string): Promise<void>;
  rootRelinkBlocker?(path: string): Promise<'unbound-file-document' | null>;
  relocateRecords?(
    sourcePath: string,
    destinationPath: string,
    loadedIds: ReadonlySet<string>
  ): Promise<ReadonlyArray<{ documentId: string; path: string }>>;
  storeRecord(record: NativeFileDocumentRecord): Promise<void>;
}

interface WorkingCopy {
  documentId: string;
  path: string;
  workspaceRoot: string;
  revision: number;
  persistedRevision: number;
  type: 'text' | 'csv' | 'tsv' | 'table' | 'unsupported';
  tablePackage?: TablePackageHead;
  persistedTableSnapshotSha256?: string;
  richTableHistory: { undo: TableData[]; redo: TableData[] };
  text: EditorState | null;
  tableData: TableData;
  tableMemory: TableDataMemory;
  firstRowAsHeader: boolean;
  headerRowValues: string[];
  persistedContent: string;
  diskContent: string;
  readOnly: boolean;
  reason?: string;
  recovery?: NativeFileDocumentRecord;
  pendingIdentityRetirement?: { previousDocumentId: string; documentId: string };
  saves: Map<number, Promise<FileDocumentSnapshot>>;
  saveTargets: Map<number, string>;
  saveReceipts: Map<string, { promise: Promise<FileDocumentSnapshot>; settled: boolean }>;
  tail: Promise<unknown>;
  requests: Map<
    string,
    { fingerprint: string; promise: Promise<FileDocumentSnapshot>; bytes?: number }
  >;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TABLE_BYTES = 20 * 1024 * 1024;
const MAX_TABLE_ROWS = 1000;
const MAX_RECEIPT_BYTES = 1024 * 1024;
function receiptSnapshot(
  snapshot: FileDocumentSnapshot,
  metadataOnly = false
): FileDocumentSnapshot {
  return {
    ...snapshot,
    content: null,
    persistedContent: null,
    diskContent: null,
    tableData: undefined,
    headerRowValues: undefined,
    firstRowAsHeader: undefined,
    saveCaptureId: undefined,
    ...(metadataOnly ? { text: undefined, table: undefined } : {}),
  };
}
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const nativeArtifacts =
  /\.(?:wpnote|wpdesign|primer|protein|dnaforge-protocol|dnaforge-protocol-run|molview|alignment|trackview)\.json$/i;
const nativeFormats =
  /\.(?:gb|gbk|genbank|fa|fasta|fna|faa|dna|ipynb|forge|notebook|pdf|png|jpe?g|gif|webp|svg|xlsx?|xlsm|parquet|bam|cram|bai|crai|vcf|bcf|bigwig|bw|bigbed|bb|pdb|cif|mmcif|molview|zip|gz|tar|7z|sqlite|db)$/i;
const cells = (rows: string[][]): Cell[][] =>
  rows.map((row) =>
    row.map((value) => ({ value, type: value.startsWith('=') ? 'formula' : 'text' }))
  );

export class NativeFileDocumentOwner {
  private readonly commitDraft = createKeyedMutex();
  private readonly generation = randomUUID();
  private readonly documents = new Map<string, Promise<WorkingCopy>>();
  private readonly identities = new Map<string, string>();
  private readonly listeners = new Set<(snapshot: FileDocumentSnapshot) => void>();
  private readonly protectedPaths = new Map<symbol, readonly string[]>();
  private closed = false;

  constructor(private readonly options: NativeFileDocumentOwnerOptions) {}

  async admitTarget(
    target: FileDocumentRequest['target'],
    mutating = false
  ): Promise<NativeFileDocumentAdmission> {
    const path =
      'path' in target
        ? target.path
        : (this.identities.get(target.documentId) ??
          (await this.options.resolveIdentity?.(target.documentId)));
    if (!path) throw new Error('FILE_DOCUMENT_NOT_FOUND: Inspect an admitted native file.');
    return this.options.admit(
      path,
      'workspaceRoot' in target ? target.workspaceRoot : undefined,
      mutating
    );
  }

  async listDirty(): Promise<NativeDirtyDocument[]> {
    const result = new Map<string, NativeDirtyDocument>();
    for (const retained of (await this.options.listRetainedDirty?.()) ?? []) {
      const admission = await this.options.admit(retained.path, undefined, false);
      result.set(retained.documentId, {
        ...retained,
        target: { documentId: retained.documentId },
        workspaceRoot: admission.workspaceRoot,
        kind: isForgePackageMetaPath(retained.path, 'table.json')
          ? 'table'
          : /\.csv$/i.test(retained.path)
            ? 'csv'
            : /\.tsv$/i.test(retained.path)
              ? 'tsv'
              : 'text',
        readOnly: admission.readOnly,
        dirty: true,
        saving: false,
        recovery: true,
        inspectionRequired: true,
      });
    }
    for (const pending of this.documents.values()) {
      const document = await pending;
      await document.tail;
      if (!this.dirty(document) && !document.recovery && !document.saves.size) continue;
      result.set(document.documentId, {
        documentId: document.documentId,
        target: { documentId: document.documentId },
        path: document.path,
        workspaceRoot: document.workspaceRoot,
        kind: document.type,
        revision: this.revision(document),
        readOnly: document.readOnly,
        dirty: this.dirty(document),
        saving: document.saves.size > 0,
        recovery: Boolean(document.recovery),
        inspectionRequired: false,
      });
    }
    return [...result.values()];
  }

  subscribe(listener: (snapshot: FileDocumentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(
    input: FileDocumentRequest,
    client: 'native' | 'renderer' = 'native'
  ): Promise<FileDocumentSnapshot> {
    if (this.closed) throw new Error('FILE_DOCUMENT_OWNER_CLOSED');
    const request = fileDocumentRequestSchema.parse(input) as FileDocumentRequest;
    const target =
      'path' in request.target
        ? request.target
        : {
            path:
              this.identities.get(request.target.documentId) ??
              (await this.options.resolveIdentity?.(request.target.documentId)),
          };
    if (!target.path)
      throw new Error('FILE_DOCUMENT_NOT_FOUND: Inspect the current admitted file.');
    const reading =
      request.operation.kind === 'inspect' ||
      request.operation.kind === 'await-save' ||
      (request.operation.kind === 'table' && request.operation.command.kind === 'inspect');
    const admission = await this.options.admit(
      target.path,
      'workspaceRoot' in target ? target.workspaceRoot : undefined,
      !reading && !['reload', 'discard', 'restore-recovery'].includes(request.operation.kind)
    );
    admission.assertCurrent();
    this.assertUnprotected(admission.path);
    await this.options.beforeExecute?.(admission.path, client);
    const document = await this.open(admission);
    if ('documentId' in request.target && request.target.documentId !== document.documentId)
      throw new Error(
        'FILE_DOCUMENT_BINDING_CHANGED: This routing identity no longer owns the requested file.'
      );
    if (request.operation.kind === 'await-save') {
      const receipt = document.saveReceipts.get(request.operation.saveCaptureId);
      if (!receipt)
        throw new Error(
          'FILE_SAVE_CAPTURE_UNAVAILABLE: Observe the file before repeating its save.'
        );
      return receipt.promise;
    }
    const fingerprint = hash(JSON.stringify(request));
    const cacheRequest =
      request.requestId && !(client === 'renderer' && request.projection === 'document');
    if (cacheRequest && request.requestId) {
      const previous = document.requests.get(request.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new NativeDocumentCommandError(
            'FILE_DOCUMENT_REQUEST_CHANGED',
            'The original request identity has different arguments.',
            false
          );
        return previous.promise;
      }
    }
    const run = async (): Promise<
      FileDocumentSnapshot | { save: Promise<FileDocumentSnapshot> }
    > => {
      admission.assertCurrent();
      this.assertUnprotected(admission.path);
      document.readOnly =
        admission.readOnly ||
        Boolean(document.reason) ||
        document.tablePackage?.status === 'pending-promotion';
      if (reading)
        return this.snapshot(
          document,
          request.projection === 'document' ? undefined : request.operation
        );
      if (
        document.readOnly &&
        !['reload', 'discard', 'restore-recovery'].includes(request.operation.kind)
      )
        throw new NativeDocumentCommandError(
          'READ_ONLY_FILE',
          'This file does not support editing through the generic file owner.',
          false
        );
      if (request.expectedRevision !== this.revision(document))
        throw new NativeDocumentCommandError(
          'STALE_FILE_DRAFT',
          'The document changed. Inspect it again before editing.',
          false
        );
      if (
        document.recovery &&
        request.operation.kind !== 'restore-recovery' &&
        request.operation.kind !== 'discard' &&
        request.operation.kind !== 'reload'
      )
        throw new NativeDocumentCommandError(
          'RECOVERY_PENDING',
          'Restore or discard the retained native draft before editing.',
          false
        );
      if (request.operation.kind === 'save') return { save: this.save(document, admission) };
      if (request.operation.kind === 'capture-save') {
        if (document.saveReceipts.size >= 256) {
          const settled = [...document.saveReceipts].find(([, receipt]) => receipt.settled);
          if (!settled)
            throw new Error(
              'FILE_SAVE_CAPTURE_LIMIT: Wait for the captured saves before starting another.'
            );
          document.saveReceipts.delete(settled[0]);
        }
        const saveCaptureId = randomUUID();
        const receipt = { promise: this.save(document, admission), settled: false };
        document.saveReceipts.set(saveCaptureId, receipt);
        void receipt.promise.then(
          (snapshot) => {
            receipt.settled = true;
            receipt.promise = Promise.resolve(receiptSnapshot(snapshot, true));
          },
          () => {
            receipt.settled = true;
          }
        );
        return { ...this.snapshot(document), saveCaptureId };
      }
      if (request.operation.kind === 'reload') {
        if (this.dirty(document))
          throw new Error('DIRTY_FILE_DRAFT: Save or discard before reloading.');
        if (document.saves.size > 0)
          throw new Error('FILE_DOCUMENT_BUSY: Wait for the captured save before reloading.');
        const revision = document.revision + 1;
        const loaded = await this.load(admission, document.documentId);
        loaded.revision = revision;
        loaded.persistedRevision = revision;
        Object.assign(document, loaded, { requests: document.requests, tail: document.tail });
      } else {
        await this.commitDraft(document.documentId, async () => {
          const candidate = {
            ...document,
            tableMemory: document.text
              ? document.tableMemory
              : structuredClone(document.tableMemory),
            richTableHistory: {
              undo: [...document.richTableHistory.undo],
              redo: [...document.richTableHistory.redo],
            },
          };
          this.change(candidate, request.operation);
          await this.persist(candidate);
          document.revision = candidate.revision;
          document.recovery = candidate.recovery;
          document.text = candidate.text;
          document.tablePackage = candidate.tablePackage;
          document.tableData = candidate.tableData;
          document.tableMemory = candidate.tableMemory;
          document.richTableHistory = candidate.richTableHistory;
          document.firstRowAsHeader = candidate.firstRowAsHeader;
          document.headerRowValues = candidate.headerRowValues;
        });
      }
      return this.publish(document);
    };
    const admitted = document.tail.then(run);
    document.tail = admitted.then(
      () => undefined,
      () => undefined
    );
    const pending = admitted.then((result) => ('save' in result ? result.save : result));
    if (cacheRequest && request.requestId) {
      const receipt: {
        fingerprint: string;
        promise: Promise<FileDocumentSnapshot>;
        bytes?: number;
      } = { fingerprint, promise: pending };
      document.requests.set(request.requestId, receipt);
      void pending.then(
        (snapshot) => {
          const bounded = receiptSnapshot(snapshot);
          receipt.bytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
          receipt.promise = Promise.resolve(bounded);
          let bytes = [...document.requests.values()].reduce(
            (sum, value) => sum + (value.bytes ?? 0),
            0
          );
          for (const [id, value] of document.requests) {
            if (bytes <= MAX_RECEIPT_BYTES && document.requests.size <= 256) break;
            if (value.bytes === undefined) continue;
            document.requests.delete(id);
            bytes -= value.bytes;
          }
        },
        () => {}
      );
    }
    return pending;
  }

  beginLegacyMigration(): void {
    this.options.beginLegacyMigration?.();
  }

  async completeLegacyMigration(pendingPaths: readonly string[]): Promise<void> {
    if (!this.options.completeLegacyMigration)
      throw new Error('The native legacy migration adapter is unavailable.');
    await this.options.completeLegacyMigration(pendingPaths);
  }

  async retainLegacyDraft(input: LegacyFileDraft): Promise<LegacyFileDraftRetention> {
    const legacy = legacyFileDraftSchema.parse(input);
    const admission = await this.options.admit(legacy.path, undefined, false);
    const document = await this.open(admission);
    const pending = document.tail.then(async () => {
      admission.assertCurrent();
      let content: string;
      let tableData: TableData | undefined;
      if (legacy.kind === 'text') {
        if (document.type !== 'text') throw new Error('LEGACY_FILE_DRAFT_TYPE_CHANGED');
        content = legacy.payload;
      } else {
        if (document.type !== 'csv' && document.type !== 'tsv')
          throw new Error('LEGACY_FILE_DRAFT_TYPE_CHANGED');
        tableData = legacy.payload.tableData as TableData;
        if (
          !Array.isArray(tableData.cells) ||
          tableData.cells.some(
            (row) => !Array.isArray(row) || row.some((cell) => typeof cell.value !== 'string')
          )
        )
          throw new Error('INVALID_LEGACY_TABLE_DRAFT');
        const rows = tableData.cells.map((row) => row.map((cell) => cell.value));
        if (legacy.payload.firstRowAsHeader) rows.unshift(legacy.payload.headerRowValues);
        content = serializeDelimitedRows(
          rows,
          document.type === 'tsv' ? '\t' : ',',
          document.diskContent
        );
      }
      const baseline =
        legacyFileDraftFingerprint(document.diskContent) === legacy.baseline
          ? hash(document.diskContent)
          : `legacy-fingerprint:${legacy.baseline}`;
      const record: NativeFileDocumentRecord = {
        version: 1,
        documentId: document.documentId,
        path: document.path,
        baseline,
        content,
        dirty: true,
        ...(legacy.kind === 'text'
          ? {}
          : {
              tableData,
              firstRowAsHeader: legacy.payload.firstRowAsHeader,
              headerRowValues: legacy.payload.headerRowValues,
            }),
      };
      if (
        document.recovery &&
        (document.recovery.content !== content || document.recovery.baseline !== baseline)
      )
        throw new Error(
          'LEGACY_FILE_DRAFT_CONFLICT: The native and legacy recovery records differ; both are retained.'
        );
      if (this.dirty(document) && this.content(document) !== content)
        throw new Error(
          'LEGACY_FILE_DRAFT_CONFLICT: The active native working copy differs; the legacy record is retained.'
        );
      const sameTypedContent =
        content === this.content(document) &&
        (legacy.kind === 'text' ||
          (JSON.stringify(tableData) === JSON.stringify(document.tableData) &&
            legacy.payload.firstRowAsHeader === document.firstRowAsHeader &&
            JSON.stringify(legacy.payload.headerRowValues) ===
              JSON.stringify(document.headerRowValues)));
      if (!document.recovery && sameTypedContent) {
        await this.persist(document);
        return {
          retained: true as const,
          documentId: document.documentId,
          recoveryId: hash(JSON.stringify(record)),
        };
      }
      if (!document.recovery) {
        await this.options.storeRecord(record);
        document.recovery = record;
      }
      this.publish(document);
      return {
        retained: true as const,
        documentId: document.documentId,
        recoveryId: hash(JSON.stringify(document.recovery)),
      };
    });
    document.tail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  rootRelinkBlocker(path: string): Promise<'unbound-file-document' | null> {
    return this.options.rootRelinkBlocker?.(path) ?? Promise.resolve('unbound-file-document');
  }

  async assertClean(path: string): Promise<void> {
    path = this.options.normalizePath?.(path) ?? path;
    await this.options.assertRecoveryClean?.(path);
    const prefix = path.replace(/[\\/]+$/, '') + '/';
    for (const [candidate, pending] of this.documents) {
      if (
        candidate !== path &&
        !candidate.replace(/\\/g, '/').startsWith(prefix.replace(/\\/g, '/'))
      )
        continue;
      const document = await pending;
      await document.tail;
      if (
        this.dirty(document) ||
        document.recovery ||
        document.saves.size > 0 ||
        document.pendingIdentityRetirement
      )
        throw new Error(
          'DIRTY_FILE_DRAFT: Save, discard or resolve this file working copy before moving or deleting it.'
        );
    }
  }

  async relocate(sourcePath: string, destinationPath: string): Promise<void> {
    sourcePath = this.options.normalizePath?.(sourcePath) ?? sourcePath;
    destinationPath = this.options.normalizePath?.(destinationPath) ?? destinationPath;
    await this.assertClean(sourcePath);
    const prefix = sourcePath.replace(/[\\/]+$/, '') + '/';
    const loadedIds = new Set<string>();
    for (const [path, pending] of [...this.documents]) {
      if (path !== sourcePath && !path.replace(/\\/g, '/').startsWith(prefix.replace(/\\/g, '/')))
        continue;
      const document = await pending;
      const nextPath = destinationPath + path.slice(sourcePath.length);
      const admission = await this.options.admit(nextPath, undefined, false);
      admission.assertCurrent();
      this.documents.delete(path);
      document.path = admission.path;
      document.workspaceRoot = admission.workspaceRoot;
      document.revision += 1;
      this.documents.set(admission.path, Promise.resolve(document));
      this.identities.set(document.documentId, admission.path);
      await this.persist(document);
      this.publish(document);
      loadedIds.add(document.documentId);
    }
    for (const identity of (await this.options.relocateRecords?.(
      sourcePath,
      destinationPath,
      loadedIds
    )) ?? [])
      this.identities.set(identity.documentId, identity.path);
  }

  async withCleanPaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const normalized = [
      ...new Set(paths.map((path) => this.options.normalizePath?.(path) ?? path)),
    ];
    for (const path of normalized) this.assertUnprotected(path);
    const key = Symbol();
    this.protectedPaths.set(key, normalized);
    try {
      for (const path of normalized) await this.assertClean(path);
      return await operation();
    } finally {
      this.protectedPaths.delete(key);
    }
  }

  private assertUnprotected(path: string): void {
    for (const paths of this.protectedPaths.values())
      for (const protectedPath of paths)
        if (
          path === protectedPath ||
          path.startsWith(protectedPath.replace(/[\\/]+$/, '') + '/') ||
          protectedPath.startsWith(path.replace(/[\\/]+$/, '') + '/')
        )
          throw new Error(
            'FILE_DOCUMENT_BUSY: The file or its project is being moved, removed or restored.'
          );
  }

  async close(): Promise<void> {
    this.closed = true;
    const loaded = await Promise.allSettled(this.documents.values());
    await Promise.allSettled(
      loaded.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.tail, ...result.value.saves.values()] : []
      )
    );
    this.listeners.clear();
  }

  private async open(admission: NativeFileDocumentAdmission): Promise<WorkingCopy> {
    let document = this.documents.get(admission.path);
    if (!document) {
      if (this.documents.size >= 64) {
        for (const [path, pending] of this.documents) {
          const candidate = await pending;
          await candidate.tail;
          if (
            !this.dirty(candidate) &&
            !candidate.recovery &&
            candidate.saves.size === 0 &&
            !candidate.pendingIdentityRetirement
          ) {
            this.documents.delete(path);
            break;
          }
        }
        if (this.documents.size >= 64)
          throw new Error(
            'FILE_DOCUMENT_LIMIT: Save or discard existing dirty working copies before opening more files.'
          );
      }
      document = this.load(admission);
      this.documents.set(admission.path, document);
      document.catch(() => {
        if (this.documents.get(admission.path) === document) this.documents.delete(admission.path);
      });
    }
    const current = await document;
    if (current.tablePackage?.status !== 'pending-promotion' && !current.pendingIdentityRetirement)
      return current;
    const refresh = current.tail
      .catch(() => {})
      .then(async () => {
        const retire = async () => {
          const pending = current.pendingIdentityRetirement;
          if (!pending) return;
          await this.options.retireReboundIdentity?.({ path: current.path, ...pending });
          this.identities.delete(pending.previousDocumentId);
          current.pendingIdentityRetirement = undefined;
          try {
            await this.persist(current);
          } catch (error) {
            current.pendingIdentityRetirement = pending;
            throw error;
          }
        };
        if (current.pendingIdentityRetirement) {
          admission.assertCurrent();
          await retire();
          return current;
        }
        if (current.tablePackage?.status !== 'pending-promotion') return current;
        if (this.dirty(current) || current.recovery || current.saves.size)
          throw new Error('TABLE_ACTIVATION_BUSY: The pending table has a retained draft or save.');
        admission.assertCurrent();
        this.assertUnprotected(admission.path);
        const identity =
          (await this.options.identityForPath?.(admission.path)) ?? current.documentId;
        const bound = this.identities.get(identity);
        if (bound && bound !== admission.path)
          throw new Error('AMBIGUOUS_FILE_DOCUMENT: The active table identity has another file.');
        const fresh = await this.load(admission, identity, false);
        if (fresh.tablePackage?.status === 'pending-promotion') return current;
        if (
          fresh.type !== 'table' ||
          fresh.reason ||
          fresh.recovery ||
          fresh.tablePackage?.id !== current.tablePackage.id
        )
          throw new Error(
            'TABLE_ACTIVATION_CHANGED: The active table does not match the verified pending owner.'
          );
        admission.assertCurrent();
        const previousDocumentId = current.documentId;
        const revision = current.revision + 1;
        const tail = current.tail;
        Object.assign(current, fresh, {
          tail,
          revision,
          persistedRevision: revision,
          pendingIdentityRetirement:
            previousDocumentId !== fresh.documentId
              ? { previousDocumentId, documentId: fresh.documentId }
              : undefined,
        });
        this.identities.set(current.documentId, current.path);
        await this.persist(current);
        await retire();
        this.publish(current);
        return current;
      });
    current.tail = refresh.then(
      () => undefined,
      () => undefined
    );
    return refresh;
  }

  private async load(
    admission: NativeFileDocumentAdmission,
    identity?: string,
    retain = true
  ): Promise<WorkingCopy> {
    const richTable = isForgePackageMetaPath(admission.path, 'table.json');
    const maximumBytes =
      richTable || /\.(csv|tsv)$/i.test(admission.path) ? MAX_TABLE_BYTES : MAX_TEXT_BYTES;
    const bytes = await this.options.read(admission.path, maximumBytes + 1);
    admission.assertCurrent();
    const record = await this.options.loadRecord(admission.path);
    const documentId =
      identity ??
      record?.documentId ??
      (await this.options.identityForPath?.(admission.path)) ??
      `file-document:${randomUUID()}`;
    const path = admission.path;
    const reason =
      bytes.byteLength > maximumBytes
        ? 'The file exceeds the full-editing limit.'
        : nativeFormats.test(path) || nativeArtifacts.test(path)
          ? "Use the file type's native document commands."
          : bytes.includes(0)
            ? 'Binary files are read-only.'
            : undefined;
    let raw = '';
    let decodeReason = reason;
    if (!reason) {
      try {
        raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        decodeReason = 'The file is not valid UTF-8 text.';
      }
    }
    let tablePackage: TablePackageHead | undefined;
    if (richTable && !decodeReason) {
      try {
        if (!this.options.verifyTablePackage)
          throw new Error('The native table package verifier is unavailable.');
        tablePackage = parseTablePackageHead(raw);
        await this.options.verifyTablePackage(admission, raw);
        admission.assertCurrent();
      } catch (error) {
        decodeReason = error instanceof Error ? error.message : String(error);
      }
    }
    const type = decodeReason
      ? 'unsupported'
      : richTable
        ? 'table'
        : /\.csv$/i.test(path)
          ? 'csv'
          : /\.tsv$/i.test(path)
            ? 'tsv'
            : 'text';
    const document: WorkingCopy = {
      documentId,
      path,
      workspaceRoot: admission.workspaceRoot,
      revision: record?.revision ? record.revision + (record.baseline === hash(raw) ? 0 : 1) : 1,
      persistedRevision: record?.persistedRevision ?? 1,
      type,
      tablePackage,
      persistedTableSnapshotSha256: tablePackage?.snapshotSha256,
      richTableHistory: { undo: [], redo: [] },
      ...(record?.pendingIdentityRetirement
        ? { pendingIdentityRetirement: structuredClone(record.pendingIdentityRetirement) }
        : {}),
      text: null,
      tableData: {},
      tableMemory: createTableDataMemory(),
      firstRowAsHeader: false,
      headerRowValues: [],
      persistedContent: raw,
      diskContent: raw,
      readOnly:
        admission.readOnly || Boolean(decodeReason) || tablePackage?.status === 'pending-promotion',
      reason:
        decodeReason ??
        (tablePackage?.status === 'pending-promotion'
          ? 'The table promotion is pending recovery.'
          : undefined),
      saves: new Map(),
      saveTargets: new Map(),
      saveReceipts: new Map(),
      tail: Promise.resolve(),
      requests: new Map(),
    };
    if (
      document.pendingIdentityRetirement &&
      (!richTable ||
        document.pendingIdentityRetirement.documentId !== documentId ||
        typeof document.pendingIdentityRetirement.previousDocumentId !== 'string' ||
        !document.pendingIdentityRetirement.previousDocumentId ||
        document.pendingIdentityRetirement.previousDocumentId === documentId)
    )
      throw new Error('The pending table identity retirement record is invalid.');
    if (type === 'text') document.text = this.textState(raw);
    if (type === 'table' && tablePackage) {
      document.tableData = structuredClone(tablePackage.snapshot.data);
      document.tableMemory = createTableDataMemory(document.tableData);
      document.persistedContent = this.content(document);
    }
    if (type === 'csv' || type === 'tsv') {
      const parsed = parseTabularPreview(raw, {
        delimiter: type === 'tsv' ? '\t' : ',',
        maxRows: MAX_TABLE_ROWS,
      });
      if (!parsed.ok) {
        document.reason = parsed.error;
        document.readOnly = true;
      } else {
        document.firstRowAsHeader = parsed.hasHeader;
        document.headerRowValues = parsed.hasHeader ? [...parsed.sourceRows[0]] : [];
        document.tableData = {
          cells: cells(parsed.rows),
          rows: parsed.rows.length,
          cols: parsed.totalColumns,
          columnLabels: document.firstRowAsHeader ? document.headerRowValues : undefined,
        };
        document.persistedContent = this.content(document);
        if (parsed.truncated) {
          document.reason = 'Sliced or truncated table previews are read-only.';
          document.readOnly = true;
        }
      }
    }
    if (record?.version === 1 && record.path === path) {
      if (record.dirty) document.recovery = record;
      else if (record.baseline === hash(raw)) this.restoreRecord(document, record);
    }
    if (retain) {
      this.identities.set(documentId, path);
      if (!document.readOnly && !document.recovery) await this.persist(document);
    }
    return document;
  }

  private textState(content: string): EditorState {
    return EditorState.create({
      doc: content,
      extensions: [
        history(),
        EditorState.lineSeparator.of(content.includes('\r\n') ? '\r\n' : '\n'),
      ],
    });
  }

  private revision(document: WorkingCopy): string {
    return `file-draft-v2:${this.generation}:${document.documentId}:${document.revision}`;
  }

  private content(document: WorkingCopy): string {
    if (document.text) return document.text.sliceDoc();
    if (document.type === 'table' && document.tablePackage)
      return serializeTablePackageHead(
        tablePackageHeadWithData(document.tablePackage, tableDataForPersistence(document.tableData))
      );
    if (document.type !== 'csv' && document.type !== 'tsv') return document.diskContent;
    const rows = (document.tableData.cells ?? []).map((row) => row.map((cell) => cell.value));
    if (document.firstRowAsHeader) rows.unshift(document.headerRowValues);
    return serializeDelimitedRows(rows, document.type === 'tsv' ? '\t' : ',', document.diskContent);
  }

  private dirty(document: WorkingCopy): boolean {
    return this.content(document) !== document.persistedContent;
  }

  private model(document: WorkingCopy) {
    return tableDataModel({
      data: document.tableData,
      memory: document.tableMemory,
      changed: () => {},
      onUpdateAttrs: (next) => {
        document.tableData = { ...document.tableData, ...next };
        if (document.firstRowAsHeader && Array.isArray(next.columnLabels))
          document.headerRowValues = [...next.columnLabels] as string[];
      },
    });
  }

  private change(document: WorkingCopy, operation: FileDocumentClientOperation): void {
    const before = this.content(document);
    if (operation.kind === 'restore-recovery') {
      if (!document.recovery || operation.recoveryId !== hash(JSON.stringify(document.recovery)))
        throw new Error('STALE_FILE_RECOVERY');
      if (document.recovery.baseline !== hash(document.diskContent))
        throw new Error(
          'FILE_CHANGED: The file changed after the retained draft. Its recovery bytes remain preserved.'
        );
      this.restoreRecord(document, document.recovery);
      document.recovery = undefined;
    } else if (operation.kind === 'discard') {
      const target = [...document.saveTargets.values()].at(-1) ?? document.persistedContent;
      if (document.text) document.text = this.textState(target);
      else if (document.type === 'table') {
        const head = parseTablePackageHead(target);
        if (head.id !== document.tablePackage?.id)
          throw new Error('The retained table belongs to a different document.');
        document.tablePackage = head;
        document.tableData = structuredClone(head.snapshot.data);
        document.tableMemory = createTableDataMemory(document.tableData);
        document.richTableHistory = { undo: [], redo: [] };
      } else {
        const parsed = parseTabularPreview(target, {
          delimiter: document.type === 'tsv' ? '\t' : ',',
          maxRows: MAX_TABLE_ROWS,
        });
        if (!parsed.ok) throw new Error(parsed.error);
        document.firstRowAsHeader = parsed.hasHeader;
        document.headerRowValues = parsed.hasHeader ? [...parsed.sourceRows[0]] : [];
        document.tableData = {
          cells: cells(parsed.rows),
          rows: parsed.rows.length,
          cols: parsed.totalColumns,
          columnLabels: parsed.hasHeader ? document.headerRowValues : undefined,
        };
        document.tableMemory = createTableDataMemory(document.tableData);
      }
      document.recovery = undefined;
    } else if (document.type === 'table') {
      this.changeRichTable(document, operation);
    } else if (document.text) {
      if (operation.kind === 'undo' || operation.kind === 'redo') {
        (operation.kind === 'undo' ? undo : redo)({
          state: document.text,
          dispatch: (transaction) => {
            document.text = transaction.state;
          },
        });
      } else if (
        operation.kind === 'replace-string' ||
        operation.kind === 'replace-text' ||
        operation.kind === 'text-transaction'
      ) {
        let changes: readonly FileDocumentTextChange[];
        if (operation.kind === 'replace-string') {
          const text = document.text.doc.toString();
          const from = text.indexOf(operation.oldText);
          if (from < 0)
            throw new NativeDocumentCommandError(
              'TEXT_NOT_FOUND',
              'The old text does not match the current inspected text. Inspect the file and copy the exact text. No edit was applied.',
              false
            );
          if (text.indexOf(operation.oldText, from + 1) >= 0)
            throw new NativeDocumentCommandError(
              'TEXT_MATCH_AMBIGUOUS',
              'The old text matches more than one location. Include surrounding text to identify one match. No edit was applied.',
              false
            );
          changes = [{ from, to: from + operation.oldText.length, text: operation.newText }];
        } else changes = operation.kind === 'replace-text' ? [operation] : operation.changes;
        for (const change of changes)
          if (change.to < change.from || change.to > document.text.doc.length)
            throw new NativeDocumentCommandError(
              'INVALID_TEXT_RANGE',
              `The edit range [${change.from}, ${change.to}) is outside the inspected text of ${document.text.doc.length} UTF-16 code units. Positions start at zero in inspect.text, include its BOM, and exclude the end position. No edit was applied.`,
              false
            );
        document.text = document.text.update({
          changes: changes.map((change) => ({
            from: change.from,
            to: change.to,
            insert:
              operation.kind === 'replace-string'
                ? Text.of(change.text.split(/\r\n?|\n/))
                : change.text,
          })),
          selection: operation.kind === 'text-transaction' ? operation.selection : undefined,
          annotations:
            operation.kind === 'text-transaction'
              ? Transaction.userEvent.of(operation.userEvent ?? 'input')
              : isolateHistory.of('full'),
        }).state;
      } else throw new Error('This file uses text edits.');
    } else {
      const model = this.model(document);
      if (operation.kind === 'table-view') {
        document.tableMemory.sort = operation.sort;
        document.tableMemory.filters = { ...operation.filters };
      } else if (operation.kind === 'replace-table') {
        const next = operation.data;
        if (
          !Array.isArray(next.cells) ||
          next.cells.length > MAX_TABLE_ROWS ||
          next.cells.some(
            (row) => !Array.isArray(row) || row.some((cell) => typeof cell.value !== 'string')
          )
        )
          throw new Error('Invalid table working copy.');
        document.tableMemory.undoStackRef.current.push({
          cells: structuredClone(model.cells),
          layout: {
            columnLabels: [...model.columnLabels],
            columnWidths: { ...model.columnWidths },
            rowHeights: { ...model.rowHeights },
          },
          view: { sort: model.sort, filters: { ...model.filters } },
        });
        if (document.tableMemory.undoStackRef.current.length > 50)
          document.tableMemory.undoStackRef.current.shift();
        document.tableMemory.redoStackRef.current = [];
        document.tableData = structuredClone(next);
        document.firstRowAsHeader = operation.firstRowAsHeader;
        document.headerRowValues = document.firstRowAsHeader ? [...(next.columnLabels ?? [])] : [];
      } else {
        const command = operation.kind === 'table' ? operation.command : operation;
        if ('row' in command && command.row >= model.rows)
          throw new Error('Row is outside this table.');
        if ('column' in command && command.column >= model.cols)
          throw new Error('Column is outside this table.');
        switch (command.kind) {
          case 'set-cell':
            model.updateCell(command.row, command.column, command.value);
            break;
          case 'add-row':
            model.addRow();
            break;
          case 'remove-row':
            if (command.index >= model.rows) throw new Error('Row is outside this table.');
            model.removeRow(command.index);
            break;
          case 'add-column':
            model.addColumn();
            break;
          case 'remove-column':
            if (command.index >= model.cols) throw new Error('Column is outside this table.');
            model.removeColumn(command.index);
            break;
          case 'set-column-label':
            if (!document.firstRowAsHeader) throw new Error('This table has no header row.');
            model.setColumnLabel(command.column, command.label);
            break;
          case 'clear-cells':
            if (
              command.range.startRow > command.range.endRow ||
              command.range.startCol > command.range.endCol ||
              command.range.endRow >= model.rows ||
              command.range.endCol >= model.cols
            )
              throw new Error('Cell range is outside this table.');
            model.deleteRange(command.range);
            break;
          case 'undo':
            model.undo();
            break;
          case 'redo':
            model.redo();
            break;
          case 'inspect':
            break;
          default:
            throw new Error('This file uses table value edits.');
        }
      }
    }
    if (this.content(document) !== before || operation.kind === 'discard') document.revision += 1;
  }

  private changeRichTable(document: WorkingCopy, operation: FileDocumentClientOperation): void {
    const before = structuredClone(document.tableData);
    const view = { sort: document.tableMemory.sort, filters: document.tableMemory.filters };
    const restoreMemory = () => {
      document.tableMemory = createTableDataMemory(document.tableData);
      document.tableMemory.sort = view.sort;
      document.tableMemory.filters = view.filters;
    };
    if (operation.kind === 'table-view') {
      document.tableMemory.sort = operation.sort;
      document.tableMemory.filters = { ...operation.filters };
      return;
    }
    const direction =
      operation.kind === 'undo' || operation.kind === 'redo'
        ? operation.kind
        : operation.kind === 'table' &&
            (operation.command.kind === 'undo' || operation.command.kind === 'redo')
          ? operation.command.kind
          : null;
    if (direction) {
      const from =
        direction === 'undo' ? document.richTableHistory.undo : document.richTableHistory.redo;
      const to =
        direction === 'undo' ? document.richTableHistory.redo : document.richTableHistory.undo;
      const next = from.at(-1);
      if (!next) return;
      tablePackageHeadWithData(document.tablePackage!, next);
      from.pop();
      to.push(before);
      document.tableData = structuredClone(next);
      restoreMemory();
      return;
    }
    try {
      if (operation.kind === 'replace-table') {
        const data = tableDataForPersistence(operation.data);
        tablePackageHeadWithData(document.tablePackage!, data);
        document.tableData = structuredClone(data);
      } else if (operation.kind === 'table') {
        executeTableModelCommand(this.model(document), operation.command);
      } else {
        throw new Error('This rich table uses table commands, not raw text edits.');
      }
      document.tableData = tableDataForPersistence(document.tableData);
      tablePackageHeadWithData(document.tablePackage!, document.tableData);
    } catch (error) {
      document.tableData = before;
      restoreMemory();
      throw error;
    }
    if (canonicalJson(document.tableData) !== canonicalJson(before)) {
      document.richTableHistory.undo.push(before);
      if (document.richTableHistory.undo.length > 50) document.richTableHistory.undo.shift();
      document.richTableHistory.redo = [];
    }
  }

  private save(
    document: WorkingCopy,
    admission: NativeFileDocumentAdmission
  ): Promise<FileDocumentSnapshot> {
    const revision = document.revision;
    const pending = document.saves.get(revision);
    if (pending) return pending;
    const content = this.content(document);
    const baseline = document.diskContent;
    const existingSaves = [...document.saves.values()];
    const previous = existingSaves.at(-1);
    const run = (async () => {
      if (previous) await previous;
      admission.assertCurrent();
      try {
        await this.options.write(
          {
            path: document.path,
            content,
            expectedContentHash: hash(
              previous && document.diskContent !== baseline ? document.diskContent : baseline
            ),
          },
          admission
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/^FILE_CHANGED(?::|$)/.test(message))
          throw new NativeDocumentCommandError(
            'FILE_CHANGED',
            message.replace(/^FILE_CHANGED:?\s*/, ''),
            false
          );
        throw error;
      }
      return this.commitDraft(document.documentId, async () => {
        document.persistedContent = content;
        document.diskContent = content;
        if (document.type === 'table') {
          document.tablePackage = parseTablePackageHead(content);
          document.persistedTableSnapshotSha256 = document.tablePackage.snapshotSha256;
        }
        document.persistedRevision = revision;
        document.recovery = undefined;
        await this.persist(document);
        document.saves.delete(revision);
        return this.snapshot(document);
      });
    })();
    document.saves.set(revision, run);
    document.saveTargets.set(revision, content);
    return run.finally(() => {
      if (document.saves.get(revision) === run) document.saves.delete(revision);
      document.saveTargets.delete(revision);
      this.publish(document);
    });
  }

  private restoreRecord(document: WorkingCopy, record: NativeFileDocumentRecord): void {
    if (document.type === 'text') {
      try {
        document.text = record.textState
          ? EditorState.fromJSON(
              record.textState,
              {
                extensions: [
                  history(),
                  EditorState.lineSeparator.of(record.content.includes('\r\n') ? '\r\n' : '\n'),
                ],
              },
              { history: historyField }
            )
          : this.textState(record.content);
      } catch {
        document.text = this.textState(record.content);
      }
    } else if (record.tableData) {
      if (document.type === 'table') {
        const head = parseTablePackageHead(record.content);
        if (head.id !== document.tablePackage?.id)
          throw new Error('The retained table belongs to a different document.');
        document.tablePackage = head;
        document.richTableHistory = record.richTableHistory
          ? structuredClone(record.richTableHistory)
          : { undo: [], redo: [] };
      }
      document.tableData = structuredClone(record.tableData);
      document.firstRowAsHeader = Boolean(record.firstRowAsHeader);
      document.headerRowValues = [...(record.headerRowValues ?? [])];
      document.tableMemory = record.tableHistory
        ? structuredClone(record.tableHistory)
        : createTableDataMemory(document.tableData);
      document.tableMemory.pendingEvaluation.current = null;
    }
  }

  private persist(document: WorkingCopy): Promise<void> {
    return this.options.storeRecord({
      version: 1,
      documentId: document.documentId,
      path: document.path,
      baseline: hash(document.diskContent),
      revision: document.revision,
      persistedRevision: document.persistedRevision,
      content: this.content(document),
      dirty: this.dirty(document),
      ...(document.pendingIdentityRetirement
        ? { pendingIdentityRetirement: structuredClone(document.pendingIdentityRetirement) }
        : {}),
      ...(document.text
        ? { textState: document.text.toJSON({ history: historyField }) }
        : {
            tableData:
              document.type === 'table'
                ? structuredClone(document.tableData)
                : {
                    ...structuredClone(document.tableData),
                    sort: document.tableMemory.sort ?? undefined,
                    filters: { ...document.tableMemory.filters },
                  },
            ...(document.type === 'table'
              ? { richTableHistory: structuredClone(document.richTableHistory) }
              : {}),
            firstRowAsHeader: document.firstRowAsHeader,
            headerRowValues: [...document.headerRowValues],
            tableHistory: {
              ...structuredClone(document.tableMemory),
              pendingEvaluation: { current: null },
            },
          }),
    });
  }

  private publish(document: WorkingCopy): FileDocumentSnapshot {
    const snapshot = this.snapshot(document);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        try {
          console.error(
            '[FileDocumentOwner] Change notification failed:',
            { filePath: document.path, documentId: document.documentId },
            error
          );
        } catch {}
      }
    }
    return snapshot;
  }

  private snapshot(
    document: WorkingCopy,
    operation?: FileDocumentClientOperation
  ): FileDocumentSnapshot {
    const read =
      operation?.kind === 'inspect'
        ? operation
        : operation?.kind === 'table' && operation.command.kind === 'inspect'
          ? operation.command
          : undefined;
    const offset = operation?.kind === 'inspect' ? operation.offset : 0;
    const limit = operation?.kind === 'inspect' ? operation.limit : 2000;
    const table = document.text ? null : this.model(document);
    const text = document.text?.doc.toString();
    const rowOffset = read?.rowOffset ?? 0,
      rowLimit = read?.rowLimit ?? 20,
      columnOffset = read?.columnOffset ?? 0,
      columnLimit = read?.columnLimit ?? 20;
    let tableInspection: Record<string, unknown> | undefined;
    if (table && document.type !== 'unsupported') {
      tableInspection = {
        rows: table.rows,
        columns: table.cols,
        name: table.name,
        sort: table.sort,
        filters: table.filters,
        columnLabels: table.columnLabels.slice(columnOffset, columnOffset + columnLimit),
        cells: table.cells
          .slice(rowOffset, rowOffset + rowLimit)
          .map((row) => row.slice(columnOffset, columnOffset + columnLimit)),
        rowOffset,
        columnOffset,
        nextRowOffset: rowOffset + rowLimit < table.rows ? rowOffset + rowLimit : null,
      };
      if (Buffer.byteLength(JSON.stringify(tableInspection), 'utf8') > 1024 * 1024) {
        if (read) throw new Error('INSPECTION_TOO_LARGE: Request fewer table rows or columns.');
        tableInspection = {
          rows: table.rows,
          columns: table.cols,
          rowOffset,
          columnOffset,
          cells: [],
          requiresSmallerWindow: true,
        };
      }
    }
    return {
      documentId: document.documentId,
      path: document.path,
      type: document.type,
      revision: this.revision(document),
      persistedRevision: `file-draft-v2:${this.generation}:${document.documentId}:${document.persistedRevision}`,
      ready: !document.reason,
      readOnly: document.readOnly,
      dirty: this.dirty(document),
      saving: document.saves.size > 0,
      canUndo: document.text
        ? undoDepth(document.text) > 0
        : document.type === 'table'
          ? document.richTableHistory.undo.length > 0
          : Boolean(table?.canUndo),
      canRedo: document.text
        ? redoDepth(document.text) > 0
        : document.type === 'table'
          ? document.richTableHistory.redo.length > 0
          : Boolean(table?.canRedo),
      capabilities: document.readOnly
        ? [
            'inspect',
            'reload',
            ...(this.dirty(document) || document.recovery ? ['discard'] : []),
            ...(document.recovery ? ['restore-recovery'] : []),
          ]
        : [
            'inspect',
            ...(document.type === 'text' ? ['replace-string', 'replace-text'] : ['table']),
            'undo',
            'redo',
            'save',
            'discard',
          ],
      content: document.type === 'unsupported' ? null : this.content(document),
      persistedContent: document.type === 'unsupported' ? null : document.persistedContent,
      diskContent: document.type === 'unsupported' ? null : document.diskContent,
      ...(text === undefined
        ? {}
        : {
            text: text.slice(offset, offset + limit),
            length: text.length,
            nextOffset: offset + limit < text.length ? offset + limit : null,
          }),
      ...(table && document.type !== 'unsupported'
        ? {
            table: tableInspection,
            tableData:
              document.type === 'table'
                ? structuredClone(document.tableData)
                : {
                    ...structuredClone(document.tableData),
                    sort: document.tableMemory.sort ?? undefined,
                    filters: { ...document.tableMemory.filters },
                  },
            ...(document.type === 'table' && document.tablePackage
              ? {
                  tableDocument: {
                    id: document.tablePackage.id,
                    snapshotSha256: tablePackageHeadWithData(
                      document.tablePackage,
                      tableDataForPersistence(document.tableData)
                    ).snapshotSha256,
                    persistedSnapshotSha256: document.persistedTableSnapshotSha256!,
                    status: document.tablePackage.status,
                  },
                }
              : {}),
            firstRowAsHeader: document.firstRowAsHeader,
            headerRowValues: [...document.headerRowValues],
          }
        : {}),
      ...(document.recovery ? { recoveryId: hash(JSON.stringify(document.recovery)) } : {}),
      ...(document.reason ? { reason: document.reason } : {}),
    };
  }
}
