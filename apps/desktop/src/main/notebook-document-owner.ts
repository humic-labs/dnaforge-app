import {
  workTaskReferenceHref,
  containsWorkTaskPlacement,
  type WorkNotebookPlacement,
  type WorkPlacementIntent,
} from '../shared/work-task-reference';
import type {
  NotebookConflictComparison,
  NotebookConflictResolution,
  ResolveNotebookConflictRequest,
} from '../shared/notebook-conflict';
import { randomUUID, createHash } from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import {
  notebookTableData,
  tableDocumentKey,
  tableDocumentReferenceSchema,
  type TableDocumentReference,
} from '../shared/table-document-reference';
import type {
  NativeNotebookTableTransitions,
  NativeNotebookTableTransitionSource,
  NativeNotebookTableSourceContext,
} from './table-document-commands';
import {
  NotebookDocumentModel,
  notebookDocumentModelSchema,
} from '../shared/notebook-model/document';
import { extractTitle, shouldDeriveNotebookTitleFromContent } from '../shared/notebook-model/title';
import { contentFingerprint } from '../shared/content-fingerprint';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import {
  nativeNotebookRequestSchema,
  nativeNotebookCreateSchema,
  type NativeNotebookCreateRequest,
  type NotebookCreationContext,
  notebookDocumentSchema,
  type NativeNotebookRequest,
  type NotebookDocumentRequest,
  type NotebookDocumentSnapshot,
  type NotebookDocumentOperation,
} from '../shared/notebook-document';
import type { NativeDirtyDocument } from '../shared/native-document-drafts';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import {
  resolveNotebookResourceReferenceRequestSchema,
  type ResolveNotebookResourceReferenceRequest,
  type ResolvedProjectResourceReference,
} from '../shared/project-resource-reference';

export interface NativeNotebookScope {
  documentId: string;
  path: string;
  workspaceRoot: string;
  readOnly: boolean;
  assertCurrent(): void;
}
export interface NativeNotebookSource {
  content: JSONContent;
  title: string;
  fingerprint: string;
  sourceFileHashes?: Readonly<Record<string, string>>;
  publication?: import('../shared/notebook-publication').NotebookPublicationState;
  updatedAt?: string;
  legacyBaselines?: string[];
  sizeBytes?: number;
  metadataRaw: string;
  preservedPreamble: string;
  sourceShape?: 'v2-package' | 'v1-package' | 'legacy-wpnote';
  preservedTitleProjection: import('../shared/notebook-package-ipc').PreservedNotebookTitleProjection;
}
type TaskPlacementReceipt = { href: string; index: number; expectedRevision: string };
export interface NativeNotebookRecord {
  taskPlacements?: Record<string, TaskPlacementReceipt>;
  version: 1;
  documentId: string;
  path: string;
  baselineFingerprint: string;
  baselineContent?: JSONContent;
  content: JSONContent;
  title: string;
  dirty: boolean;
  publication?: import('../shared/notebook-publication').NotebookPublicationState;
}
export interface NativeNotebookOptions {
  resolveTableSource?(
    reference: TableDocumentReference,
    context: NativeNotebookTableSourceContext
  ): Promise<TableDocumentReference>;
  resolveResourceReference?(
    scope: NativeNotebookScope,
    reference: ResolveNotebookResourceReferenceRequest['reference']
  ): Promise<ResolvedProjectResourceReference>;
  prepareResourceReferences?(
    scope: NativeNotebookScope,
    content: JSONContent,
    previousContent: JSONContent
  ): Promise<{ content: JSONContent; verify(): Promise<void> }>;
  prepareTableAliases?(
    scope: NativeNotebookScope,
    content: JSONContent
  ): Promise<{ content: JSONContent; conflict?: string; verify(): Promise<void> }>;
  inspectConflict?(scope: NativeNotebookScope): Promise<NotebookConflictComparison>;
  resolveConflict?(
    scope: NativeNotebookScope,
    request: ResolveNotebookConflictRequest
  ): Promise<NotebookConflictResolution>;
  beforeExecute?(documentId: string, operation: string): Promise<void>;
  beginLegacyMigration?(): void;
  completeLegacyMigration?(pendingIds: readonly string[]): Promise<void>;
  assertRecoveryClean?(path: string): Promise<void>;
  resolve(id: string, mutating: boolean): Promise<NativeNotebookScope>;
  load(scope: NativeNotebookScope): Promise<NativeNotebookSource>;
  prepareLoad?(
    scope: NativeNotebookScope,
    record?: NativeNotebookRecord
  ): Promise<NativeNotebookScope>;
  migrateLegacyProjectFiles?(
    root: string
  ): Promise<import('../shared/notebook-document').NotebookLegacyProjectMigrationResult>;
  publish(
    scope: NativeNotebookScope,
    source: NativeNotebookSource,
    content: JSONContent,
    title: string
  ): Promise<{ source: NativeNotebookSource; scope?: NativeNotebookScope; warnings?: string[] }>;
  rename?(
    scope: NativeNotebookScope,
    title: string
  ): Promise<{ scope: NativeNotebookScope; source: NativeNotebookSource; warnings?: string[] }>;
  loadRecord(id: string): Promise<NativeNotebookRecord | undefined>;
  storeRecord(record: NativeNotebookRecord): Promise<void>;
  retainedDirty(): Promise<ReadonlyArray<{ documentId: string; path: string }>>;
  normalizePath(path: string): string;
  prepareReferenceInsertion?(
    scope: NativeNotebookScope,
    operation: Extract<NotebookDocumentOperation, { kind: 'insert-reference' }>
  ): Promise<{ block: JSONContent; verify(): Promise<void> }>;
  prepareInsertion(
    scope: NativeNotebookScope,
    source: Extract<NotebookDocumentOperation, { kind: 'insert' }>['source']
  ): Promise<{ block: JSONContent; verify(): Promise<void> }>;
  search(
    root: string,
    query: string,
    type: Extract<NotebookDocumentOperation, { kind: 'search' }>['type'],
    limit: number
  ): Promise<unknown[]>;
  list(): Promise<unknown[]>;
  create(
    input: Extract<NotebookDocumentOperation, { kind: 'create' }>,
    requestId?: string,
    extra?: { context?: NotebookCreationContext; source: 'agent' | 'file-explorer-new-menu' }
  ): Promise<NotebookDocumentSnapshot>;
}
interface NotebookCopy {
  scope: NativeNotebookScope;
  source: NativeNotebookSource;
  model: NotebookDocumentModel;
  version: number;
  taskPlacements: Record<string, TaskPlacementReceipt>;
  persistedRevision: string;
  tail: Promise<unknown>;
  recordTail: Promise<unknown>;
  recovery?: NativeNotebookRecord;
  tableTransitionUnavailable?: boolean;
  tableAliasConflict?: string;
  tableAliasBaseline?: { source: NativeNotebookSource; content: JSONContent };
  saves: Map<number, Promise<NotebookDocumentSnapshot>>;
  saveReceipts: Map<
    string,
    { pending?: Promise<NotebookDocumentSnapshot>; failure?: unknown; settled: boolean }
  >;
  warnings?: string[];
  requests: Map<
    string,
    {
      fingerprint: string;
      pending?: Promise<NotebookDocumentSnapshot>;
      receipt?: { revision: string; result?: unknown; saveCaptureId?: string };
      failure?: { code: string; message: string; stateChanged: boolean | 'unknown' };
      bytes: number;
    }
  >;
  receiptBytes: number;
}
const refused = (code: string, message: string) =>
  new NativeDocumentCommandError(code, message, false);
export class NativeNotebookWorkingCopyOwner {
  private readonly generation = randomUUID();
  private readonly copies = new Map<string, Promise<NotebookCopy>>();
  private readonly listeners = new Set<(snapshot: NotebookDocumentSnapshot) => void>();
  private readonly protections = new Map<symbol, readonly string[]>();
  private closed = false;
  private pendingRequestBytes = 0;
  constructor(private readonly options: NativeNotebookOptions) {}
  readonly tableTransitions: NativeNotebookTableTransitions = {
    withSource: (input, transition) => this.withTableSource(input, transition),
    inspectSource: (reference, context) => this.inspectTableSource(reference, context),
  };
  private tableReference(reference: TableDocumentReference) {
    const parsed = tableDocumentReferenceSchema.parse(reference);
    tableDocumentKey(parsed);
    if (parsed.backing.kind !== 'notebook-inline' || parsed.binding.kind !== 'current')
      throw refused('TABLE_SOURCE_UNSUPPORTED', 'Choose a current notebook-backed table.');
    return parsed as TableDocumentReference & {
      backing: Extract<TableDocumentReference['backing'], { kind: 'notebook-inline' }>;
    };
  }
  private async tableSourceRoute(
    reference: TableDocumentReference,
    context?: NativeNotebookTableSourceContext
  ) {
    const original = this.tableReference(reference);
    if (!context || !this.options.resolveTableSource) return original;
    const current = this.tableReference(await this.options.resolveTableSource(original, context));
    if (
      current.backing.blockId !== original.backing.blockId ||
      stripWorkspaceScope(current.backing.notebookDocumentId) !==
        stripWorkspaceScope(original.backing.notebookDocumentId)
    )
      throw refused(
        'TABLE_SOURCE_CONTEXT_CHANGED',
        'The current notebook source does not match the archived portable table identity.'
      );
    return current;
  }
  private tableHashes(source: NativeNotebookSource): Readonly<Record<string, string>> {
    const hashes = source.sourceFileHashes;
    if (
      !hashes ||
      !Object.keys(hashes).length ||
      Object.entries(hashes).some(
        ([path, hash]) =>
          !path ||
          path.includes('\\') ||
          path.startsWith('/') ||
          path.includes('\0') ||
          /^[a-z]:/i.test(path) ||
          path.split('/').some((part) => !part || part === '.' || part === '..') ||
          !/^[a-f0-9]{64}$/.test(hash)
      )
    )
      throw refused(
        'TABLE_SOURCE_HASHES_UNAVAILABLE',
        'Exact saved notebook source hashes are required for extraction.'
      );
    return hashes;
  }
  private tablePlacement(copy: NotebookCopy, blockId: string) {
    const matches: Array<{ position: number; block: JSONContent }> = [];
    copy.model.state.doc.descendants((node, position) => {
      if (node.type.name === 'embed' && node.attrs.refId === blockId)
        matches.push({ position, block: node.toJSON() });
    });
    if (matches.length > 1)
      throw refused('TABLE_SOURCE_AMBIGUOUS', 'The notebook table identity is ambiguous.');
    return matches[0] ?? null;
  }
  private assertTableContext(
    scope: NativeNotebookScope,
    context?: NativeNotebookTableSourceContext
  ) {
    if (
      context &&
      (this.options.normalizePath(context.workspaceRoot) !==
        this.options.normalizePath(scope.workspaceRoot) ||
        this.options.normalizePath(context.sourcePath) !== this.options.normalizePath(scope.path))
    )
      throw refused(
        'TABLE_SOURCE_CONTEXT_CHANGED',
        'The verified notebook source location does not match its native owner.'
      );
  }
  async inspectTableSource(
    reference: TableDocumentReference,
    context?: NativeNotebookTableSourceContext
  ) {
    const sourceReference = this.tableReference(reference);
    if (this.closed) throw refused('NOTEBOOK_OWNER_CLOSED', 'The native notebook owner is closed.');
    const route = await this.tableSourceRoute(sourceReference, context);
    await this.options.beforeExecute?.(route.backing.notebookDocumentId, 'inspect');
    const copy = await this.copy(route.backing.notebookDocumentId);
    const run = copy.tail
      .catch(() => {})
      .then(async () => {
        const scope = await this.resolveCurrentScope(copy, false);
        this.assertTableContext(scope, context);
        copy.scope = scope;
        if (!this.dirty(copy) && !copy.recovery && !copy.saves.size) {
          const actual = await this.options.load(scope);
          scope.assertCurrent();
          if (copy.tableTransitionUnavailable) this.tableHashes(actual);
          if (
            copy.tableTransitionUnavailable ||
            actual.fingerprint !== copy.source.fingerprint ||
            canonicalNotebookJson(actual.sourceFileHashes) !==
              canonicalNotebookJson(copy.source.sourceFileHashes)
          ) {
            copy.source = actual;
            copy.model = new NotebookDocumentModel(actual.content, actual.title);
            copy.version++;
            copy.persistedRevision = this.revision(copy);
            copy.tableTransitionUnavailable = false;
            await this.persist(copy);
            this.publish(this.snapshot(copy));
          }
        }
        const placement = this.tablePlacement(copy, sourceReference.backing.blockId);
        const currentReference =
          placement?.block.attrs?.type === 'table-reference'
            ? tableDocumentReferenceSchema.parse(placement.block.attrs.data?.reference)
            : undefined;
        if (currentReference) tableDocumentKey(currentReference);
        return {
          workspaceRoot: scope.workspaceRoot,
          sourcePath: scope.path,
          revision: this.revision(copy),
          sourceFingerprint: copy.source.fingerprint,
          sourceFileHashes: structuredClone(this.tableHashes(copy.source)),
          originalBlock: currentReference
            ? null
            : placement
              ? structuredClone(placement.block)
              : null,
          ...(currentReference ? { currentReference } : {}),
        };
      });
    copy.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
  async withTableSource<T>(
    input: {
      reference: TableDocumentReference;
      expectedRevision: string;
      context?: NativeNotebookTableSourceContext;
    },
    transition: (source: NativeNotebookTableTransitionSource) => Promise<T>
  ): Promise<T> {
    const reference = this.tableReference(input.reference);
    if (this.closed) throw refused('NOTEBOOK_OWNER_CLOSED', 'The native notebook owner is closed.');
    const route = await this.tableSourceRoute(reference, input.context);
    await this.options.beforeExecute?.(route.backing.notebookDocumentId, 'extract-table');
    const copy = await this.copy(route.backing.notebookDocumentId);
    const run = copy.tail
      .catch(() => {})
      .then(async () => {
        let scope = await this.resolveCurrentScope(copy, true);
        this.assertTableContext(scope, input.context);
        copy.scope = scope;
        await this.refreshTableAliases(copy);
        if (copy.tableAliasConflict) throw refused('TABLE_ALIAS_CONFLICT', copy.tableAliasConflict);
        this.assertUnprotected(scope.path);
        if (scope.readOnly)
          throw refused('NOTEBOOK_READ_ONLY', 'The notebook project is read-only.');
        if (input.expectedRevision !== this.revision(copy))
          throw refused(
            'STALE_NOTEBOOK',
            'Inspect the current native notebook revision before extraction.'
          );
        if (
          copy.tableTransitionUnavailable ||
          this.dirty(copy) ||
          copy.saves.size ||
          copy.recovery ||
          copy.source.publication?.status === 'conflict' ||
          copy.source.publication?.status === 'pending'
        )
          throw refused(
            'TABLE_SOURCE_NOT_SAVED',
            'Save and resolve the notebook before extracting a table.'
          );
        const hashes = structuredClone(this.tableHashes(copy.source));
        const assertBaseline = async () => {
          const actual = await this.options.load(scope);
          scope.assertCurrent();
          if (
            actual.fingerprint !== copy.source.fingerprint ||
            canonicalNotebookJson(this.tableHashes(actual)) !== canonicalNotebookJson(hashes)
          )
            throw refused(
              'NOTEBOOK_EXTERNAL_CONFLICT',
              'The exact saved notebook bytes changed before extraction.'
            );
        };
        await assertBaseline();
        const placement = this.tablePlacement(copy, reference.backing.blockId);
        if (!placement || placement.block.attrs?.type !== 'table')
          throw refused(
            'TABLE_SOURCE_UNAVAILABLE',
            'The notebook has no unique inline table with this identity.'
          );
        const data = notebookTableData(copy.model.content, reference.backing.blockId);
        let active = true;
        let publication:
          | Promise<{
              sourceFingerprint: string;
              sourceFileHashes: Readonly<Record<string, string>>;
              revision: string;
            }>
          | undefined;
        const assertCurrent = () => {
          if (!active || this.closed)
            throw refused(
              'TABLE_SOURCE_EXPIRED',
              'The notebook extraction capability has expired.'
            );
          scope.assertCurrent();
          this.assertUnprotected(scope.path);
        };
        const source: NativeNotebookTableTransitionSource = {
          reference: structuredClone(reference),
          workspaceRoot: scope.workspaceRoot,
          sourcePath: scope.path,
          notebookId: stripWorkspaceScope(scope.documentId),
          blockId: reference.backing.blockId,
          revision: this.revision(copy),
          sourceFingerprint: copy.source.fingerprint,
          sourceFileHashes: structuredClone(hashes),
          originalBlock: structuredClone(placement.block),
          tableData: structuredClone(data),
          assertCurrent,
          publishReference: (destination) => {
            assertCurrent();
            if (publication)
              throw refused(
                'TABLE_SOURCE_ALREADY_PUBLISHED',
                'The selected placement can be published only once per transition.'
              );
            publication = (async () => {
              const parsed = tableDocumentReferenceSchema.parse(destination);
              tableDocumentKey(parsed);
              if (parsed.backing.kind !== 'rich-file' || parsed.binding.kind !== 'current')
                throw refused(
                  'TABLE_DESTINATION_UNSUPPORTED',
                  'Extraction requires a current rich table destination.'
                );
              scope = await this.resolveCurrentScope(copy, true);
              this.assertTableContext(scope, input.context);
              assertCurrent();
              if (scope.readOnly)
                throw refused('NOTEBOOK_READ_ONLY', 'The notebook project is read-only.');
              await assertBaseline();
              const attrs = {
                ...placement.block.attrs,
                type: 'table-reference',
                version: 1,
                data: { reference: parsed, presentation: 'embed' },
              };
              const transaction = closeHistory(copy.model.state.tr).setNodeMarkup(
                placement.position,
                undefined,
                attrs
              );
              const candidate = transaction.doc.toJSON();
              const prepared = await this.prepareResourceReferences(
                scope,
                candidate,
                copy.model.content
              );
              await prepared.verify();
              assertCurrent();
              try {
                const result = await this.options.publish(
                  scope,
                  copy.source,
                  prepared.content,
                  copy.model.title
                );
                copy.source = result.source;
                if (result.scope) copy.scope = result.scope;
                copy.warnings = result.warnings;
                copy.model.apply(transaction);
                if (
                  canonicalNotebookJson(copy.model.content) !==
                  canonicalNotebookJson(result.source.content)
                )
                  copy.model = new NotebookDocumentModel(
                    result.source.content,
                    result.source.title
                  );
                copy.version++;
                copy.persistedRevision = this.revision(copy);
                await this.persist(copy);
                this.publish(this.snapshot(copy));
                return {
                  sourceFingerprint: copy.source.fingerprint,
                  sourceFileHashes: structuredClone(this.tableHashes(copy.source)),
                  revision: this.revision(copy),
                };
              } catch (error) {
                copy.tableTransitionUnavailable = true;
                try {
                  const actual = await this.options.load(scope);
                  this.tableHashes(actual);
                  scope.assertCurrent();
                  if (
                    actual.fingerprint !== copy.source.fingerprint ||
                    canonicalNotebookJson(actual.sourceFileHashes) !==
                      canonicalNotebookJson(copy.source.sourceFileHashes)
                  ) {
                    copy.source = actual;
                    copy.model = new NotebookDocumentModel(actual.content, actual.title);
                    copy.version++;
                    copy.persistedRevision = this.revision(copy);
                    await this.persist(copy);
                    this.publish(this.snapshot(copy));
                  }
                  copy.tableTransitionUnavailable = false;
                } catch {}
                this.publish(this.snapshot(copy));
                throw error;
              }
            })();
            return publication;
          },
        };
        try {
          return await transition(source);
        } finally {
          if (publication) await publication.catch(() => {});
          active = false;
        }
      });
    copy.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
  async resolveResourceReference(
    input: ResolveNotebookResourceReferenceRequest
  ): Promise<ResolvedProjectResourceReference> {
    const request = resolveNotebookResourceReferenceRequestSchema.parse(input);
    if (this.closed) throw refused('NOTEBOOK_OWNER_CLOSED', 'The native notebook owner is closed.');
    const scope = await this.options.resolve(request.documentId, false);
    if (!this.options.resolveResourceReference)
      throw refused(
        'NOTEBOOK_REFERENCE_UNAVAILABLE',
        'Project resource references are unavailable.'
      );
    const result = await this.options.resolveResourceReference(scope, request.reference);
    scope.assertCurrent();
    return result;
  }
  private async prepareResourceReferences(
    scope: NativeNotebookScope,
    content: JSONContent,
    previousContent: JSONContent
  ) {
    if (this.options.prepareResourceReferences)
      return this.options.prepareResourceReferences(scope, content, previousContent);
    return { content, verify: async () => scope.assertCurrent() };
  }
  private async refreshTableAliases(copy: NotebookCopy): Promise<void> {
    const prepare = this.options.prepareTableAliases;
    if (!prepare) return;
    const source = copy.source;
    const baseline = await prepare(copy.scope, source.content);
    const current =
      canonicalNotebookJson(copy.model.content) === canonicalNotebookJson(source.content)
        ? baseline
        : await prepare(copy.scope, copy.model.content);
    const recovery = copy.recovery ? await prepare(copy.scope, copy.recovery.content) : undefined;
    await baseline.verify();
    if (current !== baseline) await current.verify();
    await recovery?.verify();
    copy.scope.assertCurrent();
    copy.tableAliasBaseline = { source, content: baseline.content };
    copy.tableAliasConflict = baseline.conflict ?? current.conflict ?? recovery?.conflict;
    if (
      !current.conflict &&
      canonicalNotebookJson(current.content) !== canonicalNotebookJson(copy.model.content)
    ) {
      copy.model.canonicalize(current.content);
      copy.version++;
      if (!this.dirty(copy)) copy.persistedRevision = this.revision(copy);
    }
  }
  private async prepareTableModel(
    copy: NotebookCopy,
    candidate: NotebookDocumentModel
  ): Promise<void> {
    const references = await this.prepareResourceReferences(
      copy.scope,
      candidate.content,
      copy.model.content
    );
    await references.verify();
    const aliases = await this.options.prepareTableAliases?.(copy.scope, references.content);
    await aliases?.verify();
    if (aliases?.conflict) throw refused('TABLE_ALIAS_CONFLICT', aliases.conflict);
    copy.scope.assertCurrent();
    candidate.canonicalize(aliases?.content ?? references.content);
  }
  async captureTaskPlacement(root: string, placement: WorkNotebookPlacement): Promise<() => void> {
    const copy = await this.copy(placement.documentId);
    const scope = await this.resolveCurrentScope(copy, true);
    scope.assertCurrent();
    if (scope.workspaceRoot !== root || scope.readOnly)
      throw refused('NOTEBOOK_READ_ONLY', 'This notebook cannot accept a project task.');
    const verify = () => {
      if (
        copy.recovery ||
        this.revision(copy) !== placement.expectedRevision ||
        placement.index > (copy.model.content.content?.length ?? 0)
      )
        throw refused('STALE_NOTEBOOK', 'Choose a position in the current notebook.');
    };
    verify();
    return verify;
  }

  async confirmTaskPlacement(root: string, intent: WorkPlacementIntent): Promise<void> {
    const copy = await this.copy(intent.documentId);
    const scope = await this.resolveCurrentScope(copy, false);
    scope.assertCurrent();
    const href = workTaskReferenceHref({
      projectId: intent.projectId,
      taskId: intent.taskId,
      placementId: intent.placementId,
    });
    const record = await this.options.loadRecord(intent.documentId);
    scope.assertCurrent();
    if (scope.workspaceRoot !== root || record?.taskPlacements?.[intent.placementId]?.href !== href)
      throw refused(
        'NOTEBOOK_PLACEMENT_PENDING',
        'The notebook has no retained insertion receipt.'
      );
  }

  async locate(id: string): Promise<{ path: string; workspaceRoot: string }> {
    const scope = await this.options.resolve(id, false);
    scope.assertCurrent();
    return { path: scope.path, workspaceRoot: scope.workspaceRoot };
  }
  async execute(input: NativeNotebookRequest): Promise<NotebookDocumentSnapshot> {
    const request = nativeNotebookRequestSchema.parse(input);
    if (this.closed) throw refused('NOTEBOOK_OWNER_CLOSED', 'The native notebook owner is closed.');
    if (!['inspect-copy', 'retain-legacy-recovery'].includes(request.operation.kind))
      await this.options.beforeExecute?.(request.documentId, request.operation.kind);
    const copy = await this.copy(request.documentId);
    if (request.operation.kind === 'await-save') {
      await this.resolveCurrentScope(copy, false);
      const receipt = copy.saveReceipts.get(request.operation.saveCaptureId);
      if (!receipt)
        throw refused(
          'NOTEBOOK_SAVE_CAPTURE_UNAVAILABLE',
          'Inspect the notebook before starting another save.'
        );
      const snapshot = receipt.pending ? await receipt.pending : this.snapshot(copy);
      copy.scope.assertCurrent();
      if (receipt.failure) throw receipt.failure;
      return snapshot;
    }
    const fingerprint = createHash('sha256').update(canonicalNotebookJson(request)).digest('hex');
    const cacheRequest =
      !(request.operation.kind === 'insert-reference' && request.operation.workTask) &&
      !['inspect', 'inspect-copy', 'schema'].includes(request.operation.kind) &&
      !(request.operation.kind === 'table' && request.operation.command.kind === 'inspect');
    if (request.requestId && cacheRequest) {
      const old = copy.requests.get(request.requestId);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw refused(
            'NOTEBOOK_REQUEST_ID_REUSED',
            'This request identity was already used for another command.'
          );
        if (old.pending) return old.pending;
        const scope = await this.options.resolve(request.documentId, false);
        scope.assertCurrent();
        if (old.failure)
          throw new NativeDocumentCommandError(
            old.failure.code,
            old.failure.message,
            old.failure.stateChanged
          );
        await copy.tail.catch(() => {});
        return {
          ...this.snapshot(copy),
          ...(old.receipt?.result !== undefined ? { result: old.receipt.result } : {}),
          ...(old.receipt?.saveCaptureId ? { saveCaptureId: old.receipt.saveCaptureId } : {}),
          requestReceipt: {
            requestId: request.requestId,
            appliedRevision: old.receipt?.revision ?? this.revision(copy),
            replayed: true,
          },
        };
      }
    }
    const requestBytes = Buffer.byteLength(canonicalNotebookJson(request));
    if (this.pendingRequestBytes + requestBytes > 128 * 1024 * 1024)
      throw refused(
        'NOTEBOOK_PENDING_BUDGET',
        'Wait for the current notebook commands to settle before sending another large edit.'
      );
    this.pendingRequestBytes += requestBytes;
    let commandVersion = copy.version;
    const admitted = copy.tail
      .catch(() => {})
      .then(
        async (): Promise<
          NotebookDocumentSnapshot | { save: Promise<NotebookDocumentSnapshot> }
        > => {
          commandVersion = copy.version;
          const operation = request.operation;
          const reading =
            operation.kind === 'inspect' ||
            operation.kind === 'inspect-copy' ||
            operation.kind === 'schema' ||
            (operation.kind === 'table' && operation.command.kind === 'inspect');
          const retaining = operation.kind === 'retain-legacy-recovery';
          let scope = await this.resolveCurrentScope(copy, !reading && !retaining);
          copy.scope = scope;
          if (reading) {
            if (!this.dirty(copy) && !copy.recovery && !copy.saves.size) {
              scope = (await this.options.prepareLoad?.(scope)) ?? scope;
              copy.scope = scope;
              const source = await this.options.load(scope);
              scope.assertCurrent();
              if (copy.tableTransitionUnavailable) this.tableHashes(source);
              if (
                copy.tableTransitionUnavailable ||
                source.fingerprint !== copy.source.fingerprint
              ) {
                copy.source = source;
                copy.model = new NotebookDocumentModel(source.content, source.title);
                copy.version++;
                copy.persistedRevision = this.revision(copy);
                copy.tableTransitionUnavailable = false;
              }
            }
            await this.refreshTableAliases(copy);
            const result =
              operation.kind === 'schema'
                ? {
                    nodes: Object.keys(copy.model.state.schema.nodes),
                    marks: Object.keys(copy.model.state.schema.marks),
                  }
                : operation.kind === 'table'
                  ? copy.model.execute(operation)
                  : undefined;
            return {
              ...this.snapshot(
                copy,
                operation.kind === 'inspect' ? operation.offset : 0,
                operation.kind === 'inspect' ? operation.limit : 20
              ),
              ...(result !== undefined ? { result } : {}),
            };
          }
          await this.refreshTableAliases(copy);
          if (copy.tableAliasConflict && !retaining)
            throw refused('TABLE_ALIAS_CONFLICT', copy.tableAliasConflict);
          if (copy.tableTransitionUnavailable && !['reload', 'discard'].includes(operation.kind))
            throw refused(
              'TABLE_SOURCE_PUBLICATION_UNCERTAIN',
              'The table cutover could not be re-inspected. Reload its actual saved source before changing this notebook.'
            );
          if (scope.readOnly && !retaining)
            throw refused('NOTEBOOK_READ_ONLY', 'This notebook project is read-only.');
          this.assertUnprotected(scope.path);
          if (operation.kind === 'insert-reference' && operation.workTask) {
            const reference = operation.workTask;
            const href = workTaskReferenceHref(reference);
            const old = copy.taskPlacements[reference.placementId];
            if (
              old &&
              (old.href !== href ||
                old.index !== operation.index ||
                old.expectedRevision !== request.expectedRevision)
            )
              throw refused(
                'NOTEBOOK_REQUEST_ID_REUSED',
                'This placement identity belongs to another insertion.'
              );
            const content = copy.recovery?.content ?? copy.model.content;
            const present = containsWorkTaskPlacement(content, href);
            if (old || present) {
              if (!this.options.prepareReferenceInsertion)
                throw refused(
                  'NOTEBOOK_REFERENCE_UNAVAILABLE',
                  'Restoring a task reference is unavailable.'
                );
              const checked = await this.options.prepareReferenceInsertion(scope, operation);
              await checked.verify();
              scope.assertCurrent();
              await this.persist(copy);
              scope.assertCurrent();
              const disposition = present
                ? copy.recovery
                  ? 'recovery'
                  : containsWorkTaskPlacement(copy.source.content, href)
                    ? 'published'
                    : 'draft'
                : 'removed';
              return {
                ...this.snapshot(copy),
                result: { changed: false, placementId: reference.placementId, disposition },
              };
            }
          }
          if (request.expectedRevision !== this.revision(copy))
            throw refused(
              'STALE_NOTEBOOK',
              'Inspect the current native notebook revision before editing.'
            );
          if (
            copy.recovery &&
            !['restore-recovery', 'discard', 'retain-legacy-recovery'].includes(operation.kind)
          )
            throw refused(
              'NOTEBOOK_RECOVERY_PENDING',
              'Restore or discard the retained notebook draft before editing.'
            );
          let result: unknown;
          if (operation.kind === 'save') return { save: this.save(copy) };
          if (operation.kind === 'capture-save') {
            if (copy.saveReceipts.size >= 256) {
              const settled = [...copy.saveReceipts].find(([, receipt]) => receipt.settled);
              if (!settled)
                throw refused(
                  'NOTEBOOK_SAVE_CAPTURE_LIMIT',
                  'Wait for the captured saves before starting another.'
                );
              copy.saveReceipts.delete(settled[0]);
            }
            const saveCaptureId = randomUUID(),
              pending = this.save(copy),
              receipt: {
                pending?: Promise<NotebookDocumentSnapshot>;
                failure?: unknown;
                settled: boolean;
              } = {
                pending,
                settled: false,
              };
            copy.saveReceipts.set(saveCaptureId, receipt);
            void pending.then(
              () => {
                receipt.pending = undefined;
                receipt.settled = true;
              },
              (error) => {
                receipt.pending = undefined;
                receipt.failure = error;
                receipt.settled = true;
              }
            );
            return { ...this.snapshot(copy), saveCaptureId };
          }
          if (operation.kind === 'rename' && this.options.rename) {
            await this.save(copy);
            const renamed = await this.options.rename(copy.scope, operation.title);
            copy.scope = renamed.scope;
            copy.source = renamed.source;
            copy.model.title = renamed.source.title;
            copy.version++;
            copy.persistedRevision = this.revision(copy);
            copy.warnings = renamed.warnings;
            await this.persist(copy);
            const snapshot = this.snapshot(copy);
            this.publish(snapshot);
            return snapshot;
          }
          if (operation.kind === 'keep-local') {
            await Promise.allSettled(copy.saves.values());
            scope.assertCurrent();
            if (request.expectedRevision !== this.revision(copy))
              throw refused(
                'STALE_NOTEBOOK',
                'Inspect the current native notebook revision before editing.'
              );
            const source = await this.options.load(scope);
            scope.assertCurrent();
            if (source.fingerprint !== operation.expectedCanonicalFingerprint)
              throw refused(
                'NOTEBOOK_EXTERNAL_CONFLICT',
                'The notebook package changed again before keeping these edits.'
              );
            if (
              source.publication?.status === 'conflict' &&
              this.options.inspectConflict &&
              this.options.resolveConflict
            ) {
              const comparison = await this.options.inspectConflict(scope);
              await this.options.resolveConflict(scope, {
                documentId: scope.documentId,
                token: comparison.token,
                choice: 'file',
              });
              copy.source = await this.options.load(scope);
            } else copy.source = source;
            copy.version++;
            copy.persistedRevision = this.revision(copy);
          } else if (operation.kind === 'reload' || operation.kind === 'discard') {
            await Promise.all(copy.saves.values());
            scope.assertCurrent();
            if (operation.kind === 'reload' && this.dirty(copy))
              throw refused('DIRTY_NOTEBOOK', 'Save or discard this notebook before reloading.');
            const source = await this.options.load(scope);
            scope.assertCurrent();
            if (copy.tableTransitionUnavailable) this.tableHashes(source);
            copy.source = source;
            copy.model = new NotebookDocumentModel(source.content, source.title);
            copy.recovery = undefined;
            copy.tableTransitionUnavailable = false;
            copy.version++;
            copy.persistedRevision = this.revision(copy);
          } else if (operation.kind === 'restore-recovery') {
            const recovery = copy.recovery;
            if (!recovery)
              throw refused('NOTEBOOK_RECOVERY_MISSING', 'No retained notebook draft is waiting.');
            if (recovery.baselineFingerprint !== copy.source.fingerprint)
              throw refused(
                'NOTEBOOK_RECOVERY_CONFLICT',
                'The package changed after this retained draft. Both versions remain preserved; resolve the conflict before restoring.'
              );
            copy.model = new NotebookDocumentModel(recovery.content, recovery.title);
            copy.recovery = undefined;
            copy.version++;
          } else if (operation.kind === 'retain-legacy-recovery') {
            const matches =
              operation.baseline === canonicalNotebookJson(copy.source.content) ||
              copy.source.legacyBaselines?.includes(operation.baseline);
            const retainedBaseline = matches
              ? copy.source.fingerprint
              : 'legacy:' + operation.baseline;
            if (
              copy.recovery &&
              canonicalNotebookJson(copy.recovery.content) ===
                canonicalNotebookJson(operation.content) &&
              copy.recovery.baselineFingerprint === retainedBaseline
            )
              return this.snapshot(copy);
            if (copy.recovery)
              throw refused(
                'NOTEBOOK_RECOVERY_ALREADY_RETAINED',
                'A native notebook recovery record is already retained.'
              );
            copy.recovery = {
              version: 1,
              documentId: scope.documentId,
              path: scope.path,
              baselineFingerprint: retainedBaseline,
              baselineContent: matches ? copy.source.content : undefined,
              content: operation.content,
              title: copy.model.title,
              dirty: true,
            };
            copy.version++;
          } else if (operation.kind === 'table-view') {
            copy.model.setTableView(operation.tableId, operation);
            copy.version++;
          } else if (operation.kind === 'set-title') {
            copy.model.execute({ kind: 'rename', title: operation.title });
            copy.version++;
          } else if (operation.kind === 'apply-steps') {
            if (
              operation.baseFingerprint !==
              contentFingerprint(canonicalNotebookJson(copy.model.content))
            )
              throw refused(
                'STALE_NOTEBOOK_TRANSACTION',
                'This view edited another notebook revision. Its unsent content remains preserved.'
              );
            const candidate = copy.model.fork();
            candidate.applySteps(
              operation.steps,
              operation.selection,
              operation.separateHistory,
              operation.time,
              operation.addToHistory
            );
            await this.prepareTableModel(copy, candidate);
            copy.model = candidate;
            copy.version++;
          } else if (operation.kind === 'splice-blocks') {
            const candidate = copy.model.fork();
            candidate.execute(operation);
            await this.prepareTableModel(copy, candidate);
            copy.model = candidate;
            copy.version++;
            result = { changed: true };
          } else if (operation.kind === 'insert' || operation.kind === 'insert-reference') {
            if (operation.kind === 'insert-reference' && !this.options.prepareReferenceInsertion)
              throw new Error('Reference insertion is unavailable.');
            const prepared =
              operation.kind === 'insert-reference'
                ? await this.options.prepareReferenceInsertion!(scope, operation)
                : await this.options.prepareInsertion(scope, operation.source);
            scope.assertCurrent();
            await prepared.verify();
            scope.assertCurrent();
            this.assertUnprotected(scope.path);
            const candidate = copy.model.fork();
            candidate.splice(operation.index, 0, [prepared.block]);
            await this.prepareTableModel(copy, candidate);
            await prepared.verify();
            scope.assertCurrent();
            copy.model = candidate;
            copy.version++;
            if (operation.kind === 'insert-reference' && operation.workTask) {
              const reference = operation.workTask;
              copy.taskPlacements[reference.placementId] = {
                href: workTaskReferenceHref(reference),
                index: operation.index,
                expectedRevision: request.expectedRevision!,
              };
              result = { changed: true, placementId: reference.placementId, disposition: 'draft' };
            } else if (operation.kind === 'insert' && operation.source.kind === 'table') {
              result = { changed: true, tableId: prepared.block.attrs?.refId };
            } else result = { changed: true };
          } else if (['create', 'list', 'search'].includes(operation.kind))
            throw refused(
              'NOTEBOOK_OPERATION_TARGET',
              'Use the notebook catalog command for this operation.'
            );
          else {
            const candidate = copy.model.fork();
            result = candidate.execute(
              operation as Exclude<
                NotebookDocumentOperation,
                {
                  kind:
                    | 'schema'
                    | 'search'
                    | 'list'
                    | 'inspect'
                    | 'create'
                    | 'insert'
                    | 'insert-reference'
                    | 'save'
                    | 'keep-local';
                }
              >
            );
            await this.prepareTableModel(copy, candidate);
            copy.model = candidate;
            copy.version++;
          }
          await this.refreshTableAliases(copy);
          await this.persist(copy);
          scope.assertCurrent();
          const snapshot = { ...this.snapshot(copy), ...(result !== undefined ? { result } : {}) };
          this.publish(snapshot);
          return snapshot;
        }
      )
      .catch((error) => {
        const changed = copy.version !== commandVersion;
        if (changed) this.publish(this.snapshot(copy));
        if (error instanceof NativeDocumentCommandError) {
          if (changed && error.stateChanged === false)
            throw new NativeDocumentCommandError(error.code, error.message, true, [
              { documentId: copy.scope.documentId, nativeDraftChanged: true },
            ]);
          throw error;
        }
        throw new NativeDocumentCommandError(
          'NOTEBOOK_COMMAND_FAILED',
          error instanceof Error ? error.message : String(error),
          changed
        );
      });
    copy.tail = admitted.then(
      () => undefined,
      () => undefined
    );
    const promise = admitted
      .then((result) => ('save' in result ? result.save : result))
      .finally(() => {
        this.pendingRequestBytes -= requestBytes;
      });
    if (request.requestId && cacheRequest) {
      const requestId = request.requestId,
        entry: NotebookCopy['requests'] extends Map<string, infer T> ? T : never = {
          fingerprint,
          pending: promise,
          bytes: 0,
        };
      copy.requests.set(requestId, entry);
      void promise.then(
        (snapshot) => {
          entry.pending = undefined;
          const result = JSON.stringify(snapshot.result ?? null);
          entry.receipt = {
            revision: snapshot.revision,
            ...(Buffer.byteLength(result) < 16384 ? { result: snapshot.result } : {}),
            ...(snapshot.saveCaptureId ? { saveCaptureId: snapshot.saveCaptureId } : {}),
          };
          entry.bytes = Buffer.byteLength(JSON.stringify({ fingerprint, receipt: entry.receipt }));
          copy.receiptBytes += entry.bytes;
          this.trimReceipts(copy);
        },
        (error) => {
          entry.pending = undefined;
          entry.failure = {
            code:
              error instanceof NativeDocumentCommandError ? error.code : 'NOTEBOOK_COMMAND_FAILED',
            message: error instanceof Error ? error.message : String(error),
            stateChanged:
              error instanceof NativeDocumentCommandError ? error.stateChanged : 'unknown',
          };
          entry.bytes = Buffer.byteLength(JSON.stringify({ fingerprint, failure: entry.failure }));
          copy.receiptBytes += entry.bytes;
          this.trimReceipts(copy);
        }
      );
    }
    return promise;
  }
  async create(input: NativeNotebookCreateRequest): Promise<NotebookDocumentSnapshot> {
    const request = nativeNotebookCreateSchema.parse(input);
    const created = await this.options.create(
      { kind: 'create', title: request.title, destinationProject: request.workspaceRoot },
      request.requestId,
      { context: request.context, source: 'file-explorer-new-menu' }
    );
    this.publish(created);
    return created;
  }
  async inspectConflict(documentId: string): Promise<NotebookConflictComparison> {
    if (!this.options.inspectConflict)
      throw refused('NOTEBOOK_CONFLICT_UNAVAILABLE', 'Notebook comparison is unavailable.');
    const scope = await this.options.resolve(documentId, false);
    return this.options.inspectConflict(scope);
  }
  async resolveConflict(
    input: ResolveNotebookConflictRequest
  ): Promise<NotebookConflictResolution> {
    if (!this.options.resolveConflict)
      throw refused('NOTEBOOK_CONFLICT_UNAVAILABLE', 'Notebook recovery is unavailable.');
    const scope = await this.options.resolve(input.documentId, true);
    if (scope.readOnly) throw refused('NOTEBOOK_READ_ONLY', 'This notebook project is read-only.');
    return this.withCleanPaths([scope.path], async () => {
      const resolved = await this.options.resolveConflict!(scope, input);
      this.copies.delete(input.documentId);
      const copy = await this.copy(input.documentId);
      await this.persist(copy);
      this.publish(this.snapshot(copy));
      return resolved;
    });
  }
  async executePublic(input: NotebookDocumentRequest): Promise<Record<string, unknown>> {
    const request = notebookDocumentSchema.parse(input),
      operation = request.operation;
    if (operation.kind === 'inspect-conflict') {
      if (!request.pageId)
        throw refused('NOTEBOOK_ID_REQUIRED', 'Choose the exact notebook identity.');
      return { conflict: await this.inspectConflict(request.pageId) };
    }
    if (operation.kind === 'resolve-conflict') {
      if (!request.pageId)
        throw refused('NOTEBOOK_ID_REQUIRED', 'Choose the exact notebook identity.');
      const resolution = await this.resolveConflict({
        documentId: request.pageId,
        token: operation.token,
        choice: operation.choice,
      });
      return { ...resolution, publication: (await this.copy(request.pageId)).source.publication };
    }
    if (operation.kind === 'list') {
      const items = await this.options.list();
      return {
        pages: items.slice(operation.offset, operation.offset + operation.limit),
        total: items.length,
        nextOffset:
          operation.offset + operation.limit < items.length
            ? operation.offset + operation.limit
            : null,
      };
    }
    if (operation.kind === 'create') {
      const created = await this.options.create(operation, request.requestId);
      this.publish(created);
      return {
        ...this.publicSnapshot(created),
        created: true,
        saved: !created.dirty,
        nextInspectionInput: { pageId: created.pageId, operation: { kind: 'inspect', limit: 1 } },
      };
    }
    if (operation.kind === 'schema' && !request.pageId) {
      const schema = notebookDocumentModelSchema();
      return {
        nodes: Object.keys(schema.nodes),
        marks: Object.keys(schema.marks),
        sources: ['entity', 'file', 'table'],
      };
    }
    if (!request.pageId)
      throw refused('NOTEBOOK_ID_REQUIRED', 'Use the exact notebook pageId from discovery.');
    if (operation.kind === 'search') {
      const scope = await this.options.resolve(request.pageId, false);
      const items = await this.options.search(
        scope.workspaceRoot,
        operation.query,
        operation.type,
        operation.limit
      );
      scope.assertCurrent();
      return { items };
    }
    const snapshot = await this.execute({
      documentId: request.pageId,
      expectedRevision: request.expectedRevision,
      requestId: request.requestId,
      operation,
    });
    return {
      ...this.publicSnapshot(snapshot, operation.kind === 'inspect'),
      ...(operation.kind === 'table' ? { tableId: operation.tableId } : {}),
      ...(operation.kind === 'save'
        ? {
            saved:
              !snapshot.dirty &&
              !snapshot.saving &&
              (!snapshot.publication || snapshot.publication.status === 'settled'),
          }
        : {}),
      ...(snapshot.result && typeof snapshot.result === 'object' ? snapshot.result : {}),
    };
  }
  private publicSnapshot(
    snapshot: NotebookDocumentSnapshot,
    includeBlocks = false
  ): Record<string, unknown> {
    const {
      copy: _copy,
      recovery,
      blocks,
      nextOffset,
      legacyBaselines: _legacyBaselines,
      tableViews: _tableViews,
      ...result
    } = snapshot;
    return {
      ...result,
      ...(includeBlocks ? { blocks, nextOffset } : {}),
      editable: !snapshot.readOnly,
      ...(recovery ? { recovery: { baselineMismatch: recovery.baselineMismatch } } : {}),
    };
  }
  private async resolveCurrentScope(copy: NotebookCopy, mutating: boolean) {
    const resolve = async () => {
      const scope = await this.options.resolve(copy.scope.documentId, mutating);
      scope.assertCurrent();
      if (this.options.normalizePath(scope.path) !== this.options.normalizePath(copy.scope.path))
        throw refused(
          'NOTEBOOK_BINDING_CHANGED',
          'The notebook moved. Inspect its current identity again.'
        );
      return scope;
    };
    const pendingCutover =
      copy.source.sourceShape === 'legacy-wpnote' ? copy.saves.values().next().value : undefined;
    try {
      return await resolve();
    } catch (error) {
      if (!pendingCutover) throw error;
      await pendingCutover;
      return resolve();
    }
  }
  private async copy(id: string): Promise<NotebookCopy> {
    let pending = this.copies.get(id);
    if (pending) return pending;
    pending = (async () => {
      let scope = await this.options.resolve(id, false);
      const record = await this.options.loadRecord(id);
      scope = (await this.options.prepareLoad?.(scope, record)) ?? scope;
      const source = await this.options.load(scope);
      scope.assertCurrent();
      const copy: NotebookCopy = {
        scope,
        source,
        model: new NotebookDocumentModel(source.content, source.title),
        version: 0,
        taskPlacements: record?.taskPlacements ?? {},
        persistedRevision: '',
        tail: Promise.resolve(),
        recordTail: Promise.resolve(),
        saves: new Map(),
        saveReceipts: new Map(),
        requests: new Map(),
        receiptBytes: 0,
      };
      copy.persistedRevision = this.revision(copy);
      if (record?.dirty) copy.recovery = record;
      await this.refreshTableAliases(copy);
      return copy;
    })();
    this.copies.set(id, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.copies.get(id) === pending) this.copies.delete(id);
      throw error;
    }
  }
  private trimReceipts(copy: NotebookCopy): void {
    for (const [id, entry] of copy.requests) {
      if (copy.receiptBytes <= 262144) break;
      if (entry.pending) continue;
      copy.requests.delete(id);
      copy.receiptBytes -= entry.bytes;
    }
  }
  private revision(copy: NotebookCopy): string {
    return `${this.generation}:${copy.version}:${copy.scope.documentId}`;
  }
  private dirty(copy: NotebookCopy): boolean {
    const baseline = copy.tableAliasBaseline;
    return (
      canonicalNotebookJson(copy.model.content) !==
        canonicalNotebookJson(
          baseline?.source === copy.source ? baseline.content : copy.source.content
        ) || copy.model.title !== copy.source.title
    );
  }
  private snapshot(copy: NotebookCopy, offset = 0, limit = 0): NotebookDocumentSnapshot {
    const content = copy.model.content,
      blocks = content.content ?? [];
    const projected: NotebookDocumentSnapshot['blocks'] = [];
    let bytes = 0;
    for (let index = offset; index < Math.min(blocks.length, offset + limit); index++) {
      const block = blocks[index],
        json = canonicalNotebookJson(block),
        size = Buffer.byteLength(json);
      const item: NotebookDocumentSnapshot['blocks'][number] =
        size <= 32768
          ? { index, block }
          : {
              index,
              block: {
                type: block.type,
                ...(block.attrs
                  ? {
                      attrs: Object.fromEntries(
                        Object.entries(block.attrs).filter(
                          ([key, value]) =>
                            [
                              'type',
                              'version',
                              'refId',
                              'id',
                              'label',
                              'entityType',
                              'entityId',
                              'path',
                              'objectUuid',
                              'contentHash',
                            ].includes(key) &&
                            (typeof value === 'number' ||
                              (typeof value === 'string' && value.length <= 1000))
                        )
                      ),
                    }
                  : {}),
              },
              truncated: true,
              byteLength: size,
              sha256: createHash('sha256').update(json).digest('hex'),
            };
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      if (projected.length && bytes + itemBytes > 65536) break;
      projected.push(item);
      bytes += itemBytes;
    }
    return {
      documentId: copy.scope.documentId,
      pageId: copy.scope.documentId,
      path: copy.scope.path,
      workspaceRoot: copy.scope.workspaceRoot,
      title: copy.model.title,
      sizeBytes: copy.source.sizeBytes,
      legacyBaselines: copy.source.legacyBaselines,
      tableViews: copy.model.tableViews,
      updatedAt: copy.source.updatedAt,
      revision: this.revision(copy),
      persistedRevision: copy.persistedRevision,
      canonicalFingerprint: copy.source.fingerprint,
      version: copy.version,
      ready: true,
      ...(copy.source.publication ? { publication: copy.source.publication } : {}),
      readOnly:
        copy.scope.readOnly ||
        Boolean(copy.tableTransitionUnavailable) ||
        Boolean(copy.tableAliasConflict),
      ...(copy.tableAliasConflict
        ? { reason: copy.tableAliasConflict }
        : copy.tableTransitionUnavailable
          ? { reason: 'The table cutover is awaiting a verified source reload.' }
          : {}),
      dirty: this.dirty(copy),
      saving: copy.saves.size > 0,
      canUndo: copy.model.canUndo,
      canRedo: copy.model.canRedo,
      blockCount: blocks.length,
      blocks: projected,
      nextOffset: offset + projected.length < blocks.length ? offset + projected.length : null,
      copy: { content, title: copy.model.title },
      ...(copy.recovery
        ? {
            recovery: {
              baselineMismatch: copy.recovery.baselineFingerprint !== copy.source.fingerprint,
              content: copy.recovery.content,
            },
          }
        : {}),
      ...(copy.warnings ? { warnings: copy.warnings } : {}),
    };
  }
  private persist(copy: NotebookCopy): Promise<void> {
    const record = structuredClone(
      copy.recovery ?? {
        version: 1 as const,
        documentId: copy.scope.documentId,
        path: copy.scope.path,
        baselineFingerprint: copy.source.fingerprint,
        baselineContent: copy.source.content,
        publication: copy.source.publication,
        content: copy.model.content,
        title: copy.model.title,
        dirty: this.dirty(copy),
      }
    );
    if (Object.keys(copy.taskPlacements).length)
      Object.assign(record, { taskPlacements: structuredClone(copy.taskPlacements) });
    const pending = copy.recordTail.catch(() => {}).then(() => this.options.storeRecord(record));
    copy.recordTail = pending;
    return pending;
  }
  private save(copy: NotebookCopy): Promise<NotebookDocumentSnapshot> {
    const previous = [...copy.saves.values()].at(-1);
    if (
      !previous &&
      !this.dirty(copy) &&
      (!copy.source.sourceShape || copy.source.sourceShape === 'v2-package') &&
      copy.source.publication?.status !== 'pending'
    )
      return Promise.resolve(this.snapshot(copy));
    if (shouldDeriveNotebookTitleFromContent(copy.model.title)) {
      const derived = extractTitle(copy.model.content);
      if (derived && derived !== copy.model.title) {
        copy.model.title = derived;
        copy.version++;
      }
    }
    const version = copy.version,
      pending = copy.saves.get(version);
    if (pending) return pending;
    const scope = copy.scope,
      content = structuredClone(copy.model.content),
      title = copy.model.title,
      revision = this.revision(copy);
    let published = false;
    const run = (async () => {
      if (previous) await previous;
      scope.assertCurrent();
      this.assertUnprotected(scope.path);
      if (this.options.normalizePath(scope.path) !== this.options.normalizePath(copy.scope.path))
        throw refused('NOTEBOOK_BINDING_CHANGED', 'The notebook moved before this save began.');
      const references = await this.prepareResourceReferences(scope, content, copy.source.content);
      await references.verify();
      const aliases = await this.options.prepareTableAliases?.(scope, references.content);
      await aliases?.verify();
      if (aliases?.conflict) throw refused('TABLE_ALIAS_CONFLICT', aliases.conflict);
      if (aliases && canonicalNotebookJson(aliases.content) !== canonicalNotebookJson(content))
        throw refused(
          'TABLE_ALIAS_CHANGED',
          'Inspect the canonical table placement before saving.'
        );
      scope.assertCurrent();
      const result = await this.options.publish(scope, copy.source, content, title);
      published = true;
      copy.source = result.source;
      if (result.scope) copy.scope = result.scope;
      copy.warnings = result.warnings;
      copy.persistedRevision = revision;
      try {
        await this.persist(copy);
      } catch (error) {
        copy.warnings = [
          ...(copy.warnings ?? []),
          'The notebook was saved, but its recovery record could not be refreshed.',
        ];
      }
      copy.saves.delete(version);
      const snapshot = this.snapshot(copy);
      this.publish(snapshot);
      return snapshot;
    })()
      .catch((error) => {
        if (error instanceof NativeDocumentCommandError) throw error;
        const failure = new NativeDocumentCommandError(
          'NOTEBOOK_SAVE_FAILED',
          error instanceof Error ? error.message : String(error),
          published ? true : 'unknown'
        );
        failure.cause = error;
        throw failure;
      })
      .finally(() => {
        if (copy.saves.get(version) === run) copy.saves.delete(version);
        this.publish(this.snapshot(copy));
      });
    copy.saves.set(version, run);
    this.publish(this.snapshot(copy));
    return run;
  }
  subscribe(listener: (snapshot: NotebookDocumentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(snapshot: NotebookDocumentSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }
  private under(path: string, parent: string): boolean {
    const candidate = this.options.normalizePath(path),
      root = this.options.normalizePath(parent).replace(/[\\/]+$/, '');
    return candidate === root || candidate.startsWith(root + '/');
  }
  private assertUnprotected(path: string): void {
    for (const paths of this.protections.values())
      if (paths.some((parent) => this.under(path, parent)))
        throw refused(
          'NOTEBOOK_LIFECYCLE_BUSY',
          'The notebook is protected by another lifecycle operation.'
        );
  }
  async listDirty(): Promise<NativeDirtyDocument[]> {
    const found = new Map<string, NativeDirtyDocument>();
    for (const retained of await this.options.retainedDirty()) {
      const scope = await this.options.resolve(retained.documentId, false);
      found.set(scope.documentId, {
        documentId: scope.documentId,
        target: { documentId: scope.documentId },
        path: scope.path,
        workspaceRoot: scope.workspaceRoot,
        kind: 'notebook',
        readOnly: scope.readOnly,
        dirty: true,
        saving: false,
        recovery: true,
        inspectionRequired: true,
      });
    }
    for (const pending of this.copies.values()) {
      const copy = await pending;
      if (!this.dirty(copy) && !copy.recovery && copy.saves.size === 0) {
        found.delete(copy.scope.documentId);
        continue;
      }
      const snapshot = this.snapshot(copy);
      found.set(snapshot.documentId, {
        documentId: snapshot.documentId,
        target: { documentId: snapshot.documentId },
        path: snapshot.path,
        workspaceRoot: snapshot.workspaceRoot,
        kind: 'notebook',
        revision: snapshot.revision,
        readOnly: snapshot.readOnly,
        dirty: snapshot.dirty,
        saving: snapshot.saving,
        recovery: Boolean(snapshot.recovery),
        inspectionRequired: false,
      });
    }
    return [...found.values()];
  }
  async refreshAfterMigration(documentId: string, scope: NativeNotebookScope): Promise<void> {
    const pending = this.copies.get(documentId);
    if (!pending) return;
    const copy = await pending;
    if (this.dirty(copy) || copy.recovery || copy.saves.size)
      throw refused(
        'NOTEBOOK_RECOVERY_PENDING',
        'The notebook draft protects its previous source.'
      );
    copy.scope = scope;
    copy.source = await this.options.load(scope);
    copy.model = new NotebookDocumentModel(copy.source.content, copy.source.title);
    copy.version++;
    copy.persistedRevision = this.revision(copy);
    this.publish(this.snapshot(copy));
  }
  beginLegacyMigration(): void {
    this.options.beginLegacyMigration?.();
  }
  async migrateLegacyProjectFiles(
    root: string
  ): Promise<import('../shared/notebook-document').NotebookLegacyProjectMigrationResult> {
    return (
      this.options.migrateLegacyProjectFiles?.(root) ?? {
        migrated: 0,
        issues: [],
        mutatedGitFiles: [],
        expectedContentSha256: {},
      }
    );
  }
  completeLegacyMigration(pendingIds: readonly string[]): Promise<void> {
    return this.options.completeLegacyMigration?.(pendingIds) ?? Promise.resolve();
  }
  async assertClean(path: string): Promise<void> {
    await this.options.assertRecoveryClean?.(path);
    for (const item of await this.listDirty())
      if (this.under(item.path, path) || this.under(path, item.path))
        throw refused(
          'DIRTY_NOTEBOOK',
          'Save, discard, or recover this notebook before changing its files.'
        );
  }
  async withCleanPaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const key = Symbol();
    this.protections.set(key, paths);
    try {
      for (const path of paths) await this.assertClean(path);
      return await operation();
    } finally {
      this.protections.delete(key);
    }
  }
  async relocate(source: string, destination: string): Promise<void> {
    for (const pending of this.copies.values()) {
      const copy = await pending;
      if (this.under(copy.scope.path, source)) {
        const suffix = this.options
          .normalizePath(copy.scope.path)
          .slice(this.options.normalizePath(source).length);
        copy.scope = { ...copy.scope, path: destination + suffix };
        await this.persist(copy);
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.copies.values()].map(async (pending) => {
        const copy = await pending;
        await copy.tail.catch(() => {});
        await Promise.allSettled(copy.saves.values());
        await this.persist(copy);
      })
    );
    this.listeners.clear();
  }
}
