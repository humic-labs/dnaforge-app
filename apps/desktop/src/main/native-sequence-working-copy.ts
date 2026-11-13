import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import { createHash, randomUUID } from 'node:crypto';
import { getSequenceSavePolicy, type AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  createSequenceDocumentModel,
  type SequenceSaveCapture,
} from '../shared/sequence-document-model';
import {
  applySequenceModelCommand,
  inspectSequenceModel,
} from '../shared/sequence-document-command';
import {
  sequenceDocumentRequestSchema,
  isSequenceViewOnlyAction,
  type SequenceDocumentRequest,
  type SequenceDocumentSnapshot,
  type SequenceDocumentCopy,
  type SequenceDocumentClientCommand,
  legacySequenceDraftSchema,
  sequenceLegacyBaselineFingerprint,
  type LegacySequenceDraft,
  type LegacySequenceDraftRetention,
} from '../shared/sequence-document';
import type {
  SequenceDocumentSaveInput,
  SequenceDocumentSaveResult,
  SequenceDocumentWriteReceipt,
} from '../shared/sequence-edit-lineage';
import type { NativeDirtyDocument } from '../shared/native-document-drafts';
import { observeSequenceSaveVerificationForTest } from './sequence-save-verification-test-seam';

export interface NativeSequenceSaveScope {
  managed?: boolean;
  documentId: string;
  path: string;
  workspaceRoot: string;
  readOnly: boolean;
  reason?: string;
  assertCurrent(): void;
  assertIdentityCurrent?(): void;
  recordedWorkspaceRoot?: string;
}
export interface NativeSequenceScope extends NativeSequenceSaveScope {
  bindingIdentity?: string;
  captureForSave(): NativeSequenceSaveScope;
}
export interface NativeSequenceRecord {
  version: 1;
  documentId: string;
  path: string;
  baselineSha256: string;
  dirty: boolean;
  copy: SequenceDocumentCopy;
}
export interface NativeSequenceWorkingCopyOptions {
  available?(documentId: string): Promise<boolean>;
  beforeExecute?(documentId: string, operation: string): Promise<void>;
  beginLegacyMigration?(): void;
  completeLegacyMigration?(pendingIds: readonly string[]): Promise<void>;
  resolve(documentId: string, mutating: boolean): Promise<NativeSequenceScope>;
  load(scope: NativeSequenceScope): Promise<{
    sequence: AnnotatedSequence;
    sha256: string;
    acceptedRevision?: ScientificAcceptedDocumentRevision;
  }>;
  readSha256(path: string): Promise<string>;
  save(
    input: SequenceDocumentSaveInput,
    scope: NativeSequenceSaveScope,
    baselineSha256: string
  ): Promise<
    | { result: Extract<SequenceDocumentSaveResult, { status: 'accepted-pending' }> }
    | {
        result: Exclude<SequenceDocumentSaveResult, { status: 'accepted-pending' }>;
        fileSha256: string;
      }
  >;
  completeSave?(
    scope: NativeSequenceSaveScope,
    message: string,
    receipt: SequenceDocumentWriteReceipt
  ): Promise<NonNullable<SequenceDocumentSnapshot['history']>>;
  persistPendingPrimerBindings?(
    capture: SequenceSaveCapture,
    scope: NativeSequenceSaveScope,
    fileSha256: string,
    receipt: SequenceDocumentWriteReceipt
  ): Promise<readonly string[] | void>;
  loadRecord(documentId: string): Promise<NativeSequenceRecord | undefined>;
  storeRecord(record: NativeSequenceRecord): Promise<void>;
  assertRecoveryClean?(path: string): Promise<void>;
  normalizePath?(path: string): string;
  listRetainedDirty?(): Promise<ReadonlyArray<{ documentId: string; path: string }>>;
}
interface WorkingCopy {
  stampingCaptureId?: string;
  externalChange?: boolean;
  scope: NativeSequenceScope;
  baselineSha256: string;
  tail: Promise<unknown>;
  recovery?: NativeSequenceRecord;
  captures: Map<
    string,
    {
      kind: 'save' | 'capture-save';
      capture: SequenceSaveCapture;
      copy: SequenceDocumentCopy;
      scope: NativeSequenceSaveScope;
      message: string;
      promise?: Promise<SequenceDocumentSnapshot>;
    }
  >;
  completedCaptures: Map<
    string,
    {
      promise: Promise<SequenceDocumentSnapshot>;
      scope: NativeSequenceSaveScope;
      continuationVersion?: number;
      continuation?: {
        version: number;
        message: string;
        snapshot: SequenceDocumentSnapshot;
      };
    }
  >;
  discardCapture?: { captureId: string; version: number };
  requests: Map<string, { fingerprint: string; promise: Promise<SequenceDocumentSnapshot> }>;
}
const refusal = (message: string) => {
  const match = /^([A-Z][A-Z0-9_]+):?\s*(.*)$/s.exec(message);
  return new NativeDocumentCommandError(
    match?.[1] ?? 'SEQUENCE_DOCUMENT_REFUSED',
    match?.[2] || message,
    false
  );
};
const beforeEffects = async <T>(operation: () => Promise<T> | T): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof NativeDocumentCommandError) throw error;
    throw refusal(error instanceof Error ? error.message : String(error));
  }
};
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const readOnlyAction = (command: SequenceDocumentClientCommand) =>
  command.method === 'dispatchEdit' && isSequenceViewOnlyAction(command.action);

export class NativeSequenceWorkingCopyOwner {
  readonly model = createSequenceDocumentModel();
  private readonly generation = randomUUID();
  private readonly documents = new Map<string, Promise<WorkingCopy>>();
  private readonly listeners = new Set<(snapshot: SequenceDocumentSnapshot) => void>();
  private readonly activeRequests = new Set<Promise<SequenceDocumentSnapshot>>();
  private readonly protectedPaths = new Map<symbol, readonly string[]>();
  private closed = false;
  constructor(private readonly options: NativeSequenceWorkingCopyOptions) {}
  async available(documentId: string): Promise<boolean> {
    if (typeof documentId !== 'string' || !documentId.trim() || documentId.length > 4096)
      throw refusal('INVALID_SEQUENCE_DOCUMENT_REQUEST');
    return (await this.options.available?.(documentId)) ?? false;
  }
  async locate(documentId: string): Promise<{ path: string; workspaceRoot: string }> {
    const scope = await this.options.resolve(documentId, false);
    scope.assertCurrent();
    return { path: scope.path, workspaceRoot: scope.workspaceRoot };
  }
  async listDirty(): Promise<NativeDirtyDocument[]> {
    const result = new Map<string, NativeDirtyDocument>();
    for (const retained of (await this.options.listRetainedDirty?.()) ?? []) {
      const scope = await this.options.resolve(retained.documentId, false);
      result.set(retained.documentId, {
        ...retained,
        path: scope.path,
        target: { documentId: retained.documentId },
        workspaceRoot: scope.workspaceRoot,
        kind: 'sequence',
        readOnly: scope.readOnly,
        dirty: true,
        saving: false,
        recovery: true,
        inspectionRequired: true,
      });
    }
    for (const pending of this.documents.values()) {
      const document = await pending;
      await document.tail;
      const id = document.scope.documentId;
      if (!this.model.getState().isDirty(id) && !document.recovery && !this.saving(document))
        continue;
      result.set(id, {
        documentId: id,
        target: { documentId: id },
        path: document.scope.path,
        workspaceRoot: document.scope.workspaceRoot,
        kind: 'sequence',
        revision: this.revision(id, this.model.getState().getVersion(id)),
        readOnly: document.scope.readOnly,
        dirty: this.model.getState().isDirty(id),
        saving: this.saving(document),
        recovery: Boolean(document.recovery),
        inspectionRequired: false,
      });
    }
    return [...result.values()];
  }
  subscribe(listener: (snapshot: SequenceDocumentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  execute(input: SequenceDocumentRequest): Promise<SequenceDocumentSnapshot> {
    if (this.closed) return Promise.reject(refusal('SEQUENCE_DOCUMENT_OWNER_CLOSED'));
    const pending = this.executeRequest(input);
    this.activeRequests.add(pending);
    return pending.finally(() => this.activeRequests.delete(pending));
  }
  private async executeRequest(input: SequenceDocumentRequest): Promise<SequenceDocumentSnapshot> {
    if (this.closed) throw refusal('SEQUENCE_DOCUMENT_OWNER_CLOSED');
    if (
      !input ||
      typeof input.documentId !== 'string' ||
      !input.documentId.trim() ||
      !input.operation
    )
      throw refusal('INVALID_SEQUENCE_DOCUMENT_REQUEST');
    const request = await beforeEffects(
      () => sequenceDocumentRequestSchema.parse(input) as SequenceDocumentRequest
    );
    await beforeEffects(() =>
      this.options.beforeExecute?.(request.documentId, request.operation.kind)
    );
    const operation = request.operation;
    if (
      request.expectedRevision &&
      !(
        operation.kind === 'inspect' ||
        operation.kind === 'client-command' ||
        (operation.kind === 'capture-save' && !operation.fromCaptureId)
      )
    )
      throw refusal('INVALID_SEQUENCE_DOCUMENT_RECOVERY_REQUEST');
    if (
      operation.kind === 'publish-save' ||
      (operation.kind === 'capture-save' && operation.fromCaptureId)
    )
      return this.executeCapturedRequest(request);
    const mutating =
      request.operation.kind !== 'inspect' &&
      request.operation.kind !== 'reload' &&
      request.operation.kind !== 'refresh-metadata' &&
      !['discard', 'restore-recovery', 'publish-save'].includes(request.operation.kind) &&
      !(
        request.operation.kind === 'client-command' &&
        request.operation.command.method === 'discardEdits'
      ) &&
      !(request.operation.kind === 'client-command' && readOnlyAction(request.operation.command));
    const scope = await beforeEffects(() => this.options.resolve(request.documentId, mutating));
    await beforeEffects(() => {
      scope.assertCurrent();
      this.assertUnprotected(scope.path);
    });
    const document = await this.open(scope);
    return this.admit(document, request, async () => {
      if (operation.kind === 'refresh-metadata') {
        const publications = [...document.captures.values()].flatMap(({ promise }) =>
          promise ? [promise] : []
        );
        await Promise.allSettled(publications);
      }
      await beforeEffects(() => {
        scope.assertCurrent();
        this.assertUnprotected(scope.path);
      });
      if (
        this.normalize(scope.path) !== this.normalize(document.scope.path) ||
        this.normalize(scope.workspaceRoot) !== this.normalize(document.scope.workspaceRoot)
      )
        throw refusal('SEQUENCE_DOCUMENT_BINDING_CHANGED: The document location changed.');
      if (request.expectedRevision) {
        const retainedScope = document.scope;
        const assertRevision = () => {
          if (
            request.expectedRevision!.bindingIdentity !== scope.bindingIdentity ||
            scope.path !== retainedScope.path ||
            scope.workspaceRoot !== retainedScope.workspaceRoot
          )
            throw refusal('SEQUENCE_DOCUMENT_BINDING_CHANGED: The document location changed.');
          retainedScope.assertCurrent();
          scope.assertCurrent();
          if (
            request.expectedRevision!.revision !==
              this.revision(scope.documentId, this.model.getState().getVersion(scope.documentId)) ||
            request.expectedRevision!.copyJson !== JSON.stringify(this.copy(scope.documentId)) ||
            document.externalChange
          )
            throw refusal('STALE_SEQUENCE: The last acknowledged native document changed.');
        };
        await beforeEffects(assertRevision);
        const baseline = await beforeEffects(() => this.options.readSha256(scope.path));
        await beforeEffects(assertRevision);
        if (baseline !== document.baselineSha256)
          throw refusal('FILE_CHANGED: The retained native source changed before input recovery.');
      }
      if (document.externalChange) await this.reloadExternalChange(document, scope);
      const policy = getSequenceSavePolicy(
        this.model.getState().sequences[scope.documentId],
        scope.path
      );
      document.scope = { ...scope, readOnly: scope.readOnly || !policy.capabilities.editable };
      if (operation.kind === 'inspect') return this.snapshot(document, request);
      if (mutating && document.scope.readOnly)
        throw refusal('READ_ONLY_SEQUENCE: This sequence belongs to a read-only source.');
      const state = this.model.getState();
      if (request.expectedVersion !== state.getVersion(scope.documentId))
        throw refusal('STALE_SEQUENCE: Inspect the current sequence before editing.');
      if (document.stampingCaptureId && mutating) {
        if (operation.kind === 'save')
          return { save: this.publishCapture(document, document.stampingCaptureId) };
        throw refusal(
          'MANAGED_ANNOTATION_IDS_BUSY: Wait for the first managed annotation identity save before editing.'
        );
      }
      if (document.recovery && !['restore-recovery', 'discard'].includes(operation.kind))
        throw refusal(
          'RECOVERY_PENDING: Restore or discard the retained sequence draft before editing.'
        );
      if (operation.kind === 'save' || operation.kind === 'capture-save') {
        if (!policy.capabilities.canSaveInPlace)
          throw refusal(
            `SEQUENCE_SAVE_FORMAT_UNSUPPORTED: ${policy.capabilities.saveInPlaceDisabledReason ?? 'This source format cannot be saved in place.'}`
          );
        const captureId = this.capture(document, operation.message, undefined, operation.kind);
        if (operation.kind === 'capture-save') {
          void this.publishCapture(document, captureId).catch(() => {});
          return { ...this.snapshot(document, request), captureId };
        }
        return {
          save: this.publishCapture(document, captureId).then((snapshot) => {
            if (snapshot.history?.status === 'failed')
              throw new NativeDocumentCommandError(
                'SEQUENCE_HISTORY_FAILED',
                snapshot.history.error ??
                  'The sequence was saved but its history could not be recorded.',
                true,
                [
                  {
                    documentId: scope.documentId,
                    path: scope.path,
                    saved: true,
                    saveResult: snapshot.saveResult,
                  },
                ]
              );
            return snapshot;
          }),
        };
      }
      if (operation.kind === 'reload') {
        if (state.isDirty(scope.documentId) || this.saving(document))
          throw refusal('DIRTY_SEQUENCE_DRAFT: Save or discard before reloading.');
        const loaded = await this.options.load(scope);
        scope.assertCurrent();
        if (
          loaded.sha256 !== document.baselineSha256 ||
          loaded.acceptedRevision?.workspaceVersionId !==
            this.model.getState().acceptedRevisions[scope.documentId]?.workspaceVersionId
        ) {
          state.setSequence(scope.documentId, loaded.sequence, loaded.acceptedRevision);
          document.baselineSha256 = loaded.sha256;
        }
      } else if (operation.kind === 'refresh-metadata') {
        const loaded = await this.options.load(scope);
        scope.assertCurrent();
        const saved = state.savedSequences[scope.documentId];
        if (
          (state.acceptedRevisions[scope.documentId] && !loaded.acceptedRevision) ||
          !saved ||
          loaded.sequence.sequence !== saved.sequence ||
          JSON.stringify(loaded.sequence.annotations) !== JSON.stringify(saved.annotations)
        )
          throw refusal(
            'FILE_CHANGED: Resolve changed sequence content before refreshing metadata.'
          );
        state.acknowledgeMetadata(
          scope.documentId,
          saved,
          loaded.sequence,
          loaded.acceptedRevision
        );
        document.baselineSha256 = loaded.sha256;
      } else if (operation.kind === 'restore-recovery') {
        if (!document.recovery || operation.recoveryId !== hash(JSON.stringify(document.recovery)))
          throw refusal('STALE_SEQUENCE_RECOVERY');
        if (document.recovery.baselineSha256 !== document.baselineSha256)
          throw refusal(
            'FILE_CHANGED: The retained sequence draft remains preserved because its source changed.'
          );
        const version = state.getVersion(scope.documentId) + 1;
        this.restoreCopy(scope.documentId, {
          ...document.recovery.copy,
          version,
          savedVersion: state.savedVersions[scope.documentId],
          savedSequence: state.savedSequences[scope.documentId],
        });
        document.recovery = undefined;
      } else if (operation.kind === 'discard') {
        this.discard(document);
        document.recovery = undefined;
      } else if (operation.kind === 'client-command') {
        const before = state.getVersion(scope.documentId);
        if (operation.command.method === 'discardEdits') this.discard(document);
        else this.applyClient(scope.documentId, operation.command);
        if (before === state.getVersion(scope.documentId)) return this.snapshot(document, request);
      } else {
        const result = applySequenceModelCommand(state, {
          documentId: scope.documentId,
          expectedVersion: request.expectedVersion,
          operation,
        });
        if (!result.ok) throw refusal(`${result.code}: ${result.error}`);
      }
      await this.persist(document);
      return this.publish(document, request);
    });
  }
  private admit(
    document: WorkingCopy,
    request: SequenceDocumentRequest,
    operation: () => Promise<SequenceDocumentSnapshot | { save: Promise<SequenceDocumentSnapshot> }>
  ): Promise<SequenceDocumentSnapshot> {
    const fingerprint = hash(JSON.stringify(request));
    if (request.requestId) {
      const previous = document.requests.get(request.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw refusal('SEQUENCE_DOCUMENT_REQUEST_CHANGED');
        return previous.promise;
      }
    }
    const admitted = document.tail.then(operation);
    document.tail = admitted.then(
      () => undefined,
      () => undefined
    );
    const pending = admitted.then((result) => ('save' in result ? result.save : result));
    if (request.requestId) {
      document.requests.set(request.requestId, { fingerprint, promise: pending });
      if (document.requests.size > 256)
        document.requests.delete(document.requests.keys().next().value!);
    }
    return pending;
  }
  private async executeCapturedRequest(
    request: SequenceDocumentRequest
  ): Promise<SequenceDocumentSnapshot> {
    const pending = this.documents.get(request.documentId);
    if (!pending) throw refusal('STALE_SEQUENCE_SAVE_CAPTURE');
    const document = await pending;
    return this.admit(document, request, async () => {
      const operation = request.operation;
      const captureId =
        operation.kind === 'publish-save'
          ? operation.captureId
          : operation.kind === 'capture-save'
            ? operation.fromCaptureId
            : undefined;
      if (!captureId) throw refusal('STALE_SEQUENCE_SAVE_CAPTURE');
      const saved = document.completedCaptures.get(captureId),
        scope = saved?.scope ?? document.captures.get(captureId)?.scope;
      if (!scope) throw refusal('STALE_SEQUENCE_SAVE_CAPTURE');
      await beforeEffects(() => {
        scope.assertCurrent();
        this.assertUnprotected(scope.path);
      });
      if (operation.kind === 'publish-save')
        return { save: this.publishCapture(document, captureId) };
      if (operation.kind !== 'capture-save' || !saved) throw refusal('STALE_SEQUENCE_SAVE_CAPTURE');
      if (saved.continuation) {
        if (
          request.expectedVersion !== saved.continuation.version ||
          operation.message !== saved.continuation.message
        )
          throw refusal('SEQUENCE_SAVE_CONTINUATION_CHANGED');
        return saved.continuation.snapshot;
      }
      await saved.promise;
      await beforeEffects(() => scope.assertCurrent());
      if (
        saved.continuationVersion === undefined ||
        request.expectedVersion !== saved.continuationVersion ||
        request.expectedVersion !== this.model.getState().getVersion(request.documentId) ||
        document.recovery ||
        document.externalChange
      )
        throw refusal('STALE_SEQUENCE_SAVE_CONTINUATION');
      const nextCaptureId = this.capture(document, operation.message, scope, 'capture-save');
      const snapshot = { ...this.snapshot(document, request), captureId: nextCaptureId };
      saved.continuation = {
        version: saved.continuationVersion,
        message: operation.message,
        snapshot,
      };
      void this.publishCapture(document, nextCaptureId).catch(() => {});
      return snapshot;
    });
  }

  async saveCapture(input: SequenceDocumentSaveInput): Promise<SequenceDocumentSaveResult> {
    const scope = await this.options.resolve(input.documentId, true),
      document = await this.open(scope);
    await document.tail;
    const current = this.model.getState().captureForSave(input.documentId);
    if (
      !current ||
      JSON.stringify(current.sequence) !== JSON.stringify(input.capture.sequence) ||
      current.draftLineageId !== input.capture.draftLineageId
    )
      throw new Error('STALE_SEQUENCE: The requested capture is not the native working revision.');
    const result = await this.execute({
      documentId: input.documentId,
      expectedVersion: current.revision,
      operation: { kind: 'save', message: 'Edit sequence' },
      projection: 'document',
    });
    if (!result.saveResult)
      throw new Error('The native sequence save produced no publication receipt.');
    return result.saveResult;
  }

  beginLegacyMigration(): void {
    this.options.beginLegacyMigration?.();
  }
  async completeLegacyMigration(pendingIds: readonly string[]): Promise<void> {
    if (!this.options.completeLegacyMigration)
      throw new Error('The native sequence recovery migration adapter is unavailable.');
    await this.options.completeLegacyMigration(pendingIds);
  }
  async retainLegacyDraft(input: LegacySequenceDraft): Promise<LegacySequenceDraftRetention> {
    const legacy = legacySequenceDraftSchema.parse(input),
      scope = await this.options.resolve(legacy.documentId, false),
      document = await this.open(scope);
    const pending = document.tail.then(async () => {
      scope.assertCurrent();
      const current = this.model.getState(),
        saved = current.savedSequences[legacy.documentId];
      const temporary = createSequenceDocumentModel();
      temporary.getState().setSequence(legacy.documentId, saved);
      temporary.getState().restoreRecoveredDraft(legacy.documentId, legacy.content);
      const state = temporary.getState();
      const copy: SequenceDocumentCopy = {
        sequence: state.sequences[legacy.documentId],
        savedSequence: state.savedSequences[legacy.documentId],
        draft: state.drafts[legacy.documentId],
        lineage: state.draftLineages[legacy.documentId],
        version: state.sequenceVersions[legacy.documentId],
        savedVersion: state.savedVersions[legacy.documentId],
      };
      const baselineSha256 =
        sequenceLegacyBaselineFingerprint(saved) === legacy.baseline
          ? document.baselineSha256
          : `legacy:${legacy.baseline}`;
      const record: NativeSequenceRecord = {
        version: 1,
        documentId: legacy.documentId,
        path: scope.path,
        baselineSha256,
        dirty: true,
        copy,
      };
      const contentKey = (draft: SequenceDocumentCopy['draft']) =>
        JSON.stringify({
          sequence: draft.sequence,
          annotations: draft.annotations,
          insertedRanges: draft.insertedRanges,
          deletedRanges: draft.deletedRanges,
          substitutedRanges: draft.substitutedRanges,
          pendingPrimerBindings: draft.pendingPrimerBindings,
        });
      if (
        document.recovery &&
        (contentKey(document.recovery.copy.draft) !== contentKey(copy.draft) ||
          document.recovery.baselineSha256 !== baselineSha256)
      )
        throw new Error('LEGACY_SEQUENCE_DRAFT_CONFLICT: Both retained drafts remain preserved.');
      if (current.isDirty(legacy.documentId)) {
        if (contentKey(current.drafts[legacy.documentId]) !== contentKey(copy.draft))
          throw new Error(
            'LEGACY_SEQUENCE_DRAFT_CONFLICT: The native working copy differs from the legacy draft.'
          );
        await this.persist(document);
        return {
          retained: true as const,
          documentId: legacy.documentId,
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
        documentId: legacy.documentId,
        recoveryId: hash(JSON.stringify(document.recovery)),
      };
    });
    document.tail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  async assertClean(path: string): Promise<void> {
    path = this.normalize(path);
    await this.options.assertRecoveryClean?.(path);
    for (const pending of this.documents.values()) {
      const document = await pending;
      if (!this.contains(path, document.scope.path)) continue;
      await document.tail;
      if (
        this.model.getState().isDirty(document.scope.documentId) ||
        document.recovery ||
        this.saving(document)
      )
        throw new Error(
          'DIRTY_SEQUENCE_DRAFT: Resolve the sequence working copy before moving or deleting it.'
        );
    }
  }
  async withCleanPaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
    const normalized = paths.map((path) => this.normalize(path));
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
  async protectCleanDocument(
    documentId: string,
    path: string
  ): Promise<{
    assertCurrent(): void;
    finish(): Promise<void>;
    abort(disposition: 'unchanged' | 'needs-recovery'): void;
  }> {
    const scope = await beforeEffects(() => this.options.resolve(documentId, true));
    await beforeEffects(() => {
      scope.assertCurrent();
      if (this.normalize(scope.path) !== this.normalize(path))
        throw refusal('SEQUENCE_DOCUMENT_BINDING_CHANGED');
      this.assertUnprotected(scope.path);
    });
    const key = Symbol();
    this.protectedPaths.set(key, [this.normalize(scope.path)]);
    let document: WorkingCopy | undefined;
    try {
      await this.assertClean(scope.path);
      document = await this.documents.get(documentId);
      scope.assertCurrent();
    } catch (error) {
      this.protectedPaths.delete(key);
      throw error;
    }
    let settled = false;
    const release = () => {
      settled = true;
      this.protectedPaths.delete(key);
    };
    return {
      assertCurrent() {
        if (settled) throw refusal('SEQUENCE_DOCUMENT_PROTECTION_RELEASED');
        scope.assertCurrent();
      },
      finish: async () => {
        if (settled) throw refusal('SEQUENCE_DOCUMENT_PROTECTION_RELEASED');
        if (document) document.externalChange = true;
        try {
          if (document) {
            const current = await this.options.resolve(documentId, false);
            await this.reloadExternalChange(document, current);
          }
        } finally {
          release();
        }
      },
      abort(disposition) {
        if (settled) return;
        if (document && disposition === 'needs-recovery') document.externalChange = true;
        release();
      },
    };
  }
  async relocate(source: string, destination: string): Promise<void> {
    source = this.normalize(source);
    destination = this.normalize(destination);
    await this.assertClean(source);
    for (const pending of this.documents.values()) {
      const document = await pending;
      if (!this.contains(source, document.scope.path)) continue;
      const scope = await this.options.resolve(document.scope.documentId, false);
      if (scope.path !== destination + document.scope.path.slice(source.length))
        throw new Error('SEQUENCE_DOCUMENT_BINDING_CHANGED');
      document.scope = scope;
      await this.persist(document);
      this.publish(document);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.activeRequests]);
    await Promise.allSettled(
      [...this.documents.values()].map(async (pending) => {
        const document = await pending;
        await document.tail;
        await Promise.allSettled(
          [...document.captures.values()].flatMap((capture) =>
            capture.promise ? [capture.promise] : []
          )
        );
      })
    );
    this.listeners.clear();
  }

  private async open(scope: NativeSequenceScope): Promise<WorkingCopy> {
    let pending = this.documents.get(scope.documentId);
    if (!pending) {
      pending = this.load(scope);
      this.documents.set(scope.documentId, pending);
      pending.catch(() => {
        if (this.documents.get(scope.documentId) === pending)
          this.documents.delete(scope.documentId);
      });
    }
    return pending;
  }
  private async load(scope: NativeSequenceScope): Promise<WorkingCopy> {
    const loaded = await this.options.load(scope);
    scope.assertCurrent();
    this.model
      .getState()
      .setSequence(
        scope.documentId,
        { ...loaded.sequence, id: scope.documentId },
        loaded.acceptedRevision
      );
    const record = await this.options.loadRecord(scope.documentId);
    if (
      record &&
      !record.copy.acceptedRevision &&
      loaded.acceptedRevision &&
      record.baselineSha256 === `sha256:${loaded.acceptedRevision.contentSha256}`
    ) {
      record.copy = {
        ...record.copy,
        acceptedRevision: loaded.acceptedRevision,
        lineage: { ...record.copy.lineage, accepted: loaded.acceptedRevision },
      };
    }
    const document: WorkingCopy = {
      scope,
      baselineSha256: loaded.sha256,
      tail: Promise.resolve(),
      captures: new Map(),
      completedCaptures: new Map(),
      requests: new Map(),
    };
    if (record) {
      if (record.documentId !== scope.documentId || record.version !== 1)
        throw new Error('The native sequence recovery record is invalid.');
      if (record.dirty) document.recovery = record;
      else if (record.baselineSha256 === loaded.sha256)
        this.restoreCopy(scope.documentId, record.copy);
      if (record.dirty || record.baselineSha256 !== loaded.sha256) {
        const version = Math.max(
          this.model.getState().getVersion(scope.documentId),
          record.copy.version + 1
        );
        this.model.setState((state) => ({
          sequenceVersions: { ...state.sequenceVersions, [scope.documentId]: version },
          savedVersions: { ...state.savedVersions, [scope.documentId]: version },
        }));
      }
    }
    if (!document.recovery && !scope.readOnly) await this.persist(document);
    return document;
  }
  private async reloadExternalChange(
    document: WorkingCopy,
    scope: NativeSequenceScope
  ): Promise<void> {
    if (
      this.model.getState().isDirty(scope.documentId) ||
      document.recovery ||
      this.saving(document)
    )
      throw refusal(
        'DIRTY_SEQUENCE_DRAFT: Resolve the native working copy before refreshing external changes.'
      );
    const loaded = await this.options.load(scope);
    scope.assertCurrent();
    if (
      loaded.sha256 !== document.baselineSha256 ||
      loaded.acceptedRevision?.workspaceVersionId !==
        this.model.getState().acceptedRevisions[scope.documentId]?.workspaceVersionId
    ) {
      this.model
        .getState()
        .setSequence(
          scope.documentId,
          { ...loaded.sequence, id: scope.documentId },
          loaded.acceptedRevision
        );
      document.baselineSha256 = loaded.sha256;
      document.scope = scope;
      await this.persist(document);
      this.publish(document);
    }
    document.externalChange = false;
  }
  private copy(id: string): SequenceDocumentCopy {
    const state = this.model.getState();
    return {
      sequence: state.sequences[id],
      savedSequence: state.savedSequences[id],
      draft: state.drafts[id],
      lineage: state.draftLineages[id],
      acceptedRevision: state.acceptedRevisions[id],
      version: state.sequenceVersions[id],
      savedVersion: state.savedVersions[id],
    };
  }
  private restoreCopy(id: string, copy: SequenceDocumentCopy): void {
    this.model.setState((state) => ({
      sequences: { ...state.sequences, [id]: copy.sequence },
      savedSequences: { ...state.savedSequences, [id]: copy.savedSequence },
      drafts: { ...state.drafts, [id]: copy.draft },
      draftLineages: { ...state.draftLineages, [id]: copy.lineage },
      acceptedRevisions: copy.acceptedRevision
        ? { ...state.acceptedRevisions, [id]: copy.acceptedRevision }
        : state.acceptedRevisions,
      sequenceVersions: { ...state.sequenceVersions, [id]: copy.version },
      savedVersions: { ...state.savedVersions, [id]: copy.savedVersion },
      dirtyPaths:
        copy.version !== copy.savedVersion
          ? { ...state.dirtyPaths, [id]: true }
          : Object.fromEntries(Object.entries(state.dirtyPaths).filter(([key]) => key !== id)),
    }));
  }
  private persist(document: WorkingCopy): Promise<void> {
    const id = document.scope.documentId;
    return this.options.storeRecord({
      version: 1,
      documentId: id,
      path: document.scope.path,
      baselineSha256: document.baselineSha256,
      dirty: this.model.getState().isDirty(id),
      copy: this.copy(id),
    });
  }
  private applyClient(id: string, command: SequenceDocumentClientCommand): void {
    const state = this.model.getState();
    switch (command.method) {
      case 'dispatchEdit':
        state.dispatchEdit(id, command.action);
        break;
      case 'replaceBases':
        state.replaceBases(id, command.start, command.end, command.bases);
        break;
      case 'updateAnnotation':
        state.updateAnnotation(id, command.index, command.patch);
        break;
      case 'deleteAnnotation':
        state.deleteAnnotation(id, command.index);
        break;
      case 'addAnnotation':
        state.addAnnotation(id, command.annotation);
        break;
      case 'mergeAnnotations':
        state.mergeAnnotations(id, command.annotations);
        break;
      case 'discardEdits':
        state.discardEdits(id);
        break;
      case 'patchSavedMetadata':
        state.patchSavedMetadata(id, command.patch);
        break;
      case 'restoreRecoveredDraft':
        state.restoreRecoveredDraft(id, command.content);
        break;
      default:
        throw refusal('INVALID_SEQUENCE_CLIENT_COMMAND');
    }
  }
  private capture(
    document: WorkingCopy,
    message: string,
    scope: NativeSequenceSaveScope = document.scope.captureForSave(),
    kind: 'save' | 'capture-save' = 'save'
  ): string {
    const capture = this.model.getState().captureForSave(document.scope.documentId);
    if (!capture) throw refusal('SEQUENCE_NOT_LOADED');
    const captureId = randomUUID();
    if (
      document.scope.managed &&
      capture.sequence.annotations.some(
        (annotation) => !annotation.qualifiers?.dnaforge_ann_id?.[0]
      )
    )
      document.stampingCaptureId = captureId;
    document.captures.set(captureId, {
      kind,
      capture: structuredClone(capture),
      copy: structuredClone(this.copy(document.scope.documentId)),
      scope,
      message,
    });
    return captureId;
  }
  private publishCapture(
    document: WorkingCopy,
    captureId: string
  ): Promise<SequenceDocumentSnapshot> {
    const completed = document.completedCaptures.get(captureId);
    if (completed) return completed.promise;
    const saved = document.captures.get(captureId);
    if (!saved) throw refusal('STALE_SEQUENCE_SAVE_CAPTURE');
    if (saved.promise) return saved.promise;
    const existing = [...document.captures.values()]
      .filter((capture) => capture.promise)
      .at(-1)?.promise;
    let writerEntered = false,
      publishedReceipt: Readonly<Record<string, unknown>> | undefined;
    const run = (async () => {
      if (existing) await existing;
      await beforeEffects(() => saved.scope.assertCurrent());
      const id = document.scope.documentId;
      if (
        !this.model.getState().isDirty(id) &&
        saved.capture.revision === this.model.getState().getVersion(id)
      ) {
        document.captures.delete(captureId);
        if (document.stampingCaptureId === captureId) document.stampingCaptureId = undefined;
        return { ...this.snapshot(document), saved: false };
      }
      if (saved.capture.pendingPrimerBindings.length && !this.options.persistPendingPrimerBindings)
        throw new Error(
          'PRIMER_BINDING_PERSISTENCE_UNAVAILABLE: The captured sequence retains copied primer relationships.'
        );
      writerEntered = true;
      const publication = await this.options.save(
        {
          documentId: id,
          sourcePath: saved.scope.path,
          capture: saved.capture,
          ...(saved.capture.accepted ? { accepted: saved.capture.accepted } : {}),
        },
        saved.scope,
        document.baselineSha256
      );
      if (!('fileSha256' in publication)) {
        const { result } = publication;
        if (saved.kind === 'save')
          throw new NativeDocumentCommandError(
            'SEQUENCE_PUBLICATION_PENDING',
            result.reason,
            true,
            [{ documentId: id, path: saved.scope.path, ...result }]
          );
        document.captures.delete(captureId);
        if (document.stampingCaptureId === captureId) document.stampingCaptureId = undefined;
        return { ...this.publish(document), saved: false, saveResult: result };
      }
      const { result: publishedResult, fileSha256 } = publication;
      if (publishedResult.status !== 'saved') throw new Error('SEQUENCE_DOCUMENT_SAVE_UNBOUND');
      const result: Extract<SequenceDocumentSaveResult, { status: 'saved' }> & {
        writeReceipt: SequenceDocumentWriteReceipt;
      } = {
        ...publishedResult,
        writeReceipt: publishedResult.writeReceipt ?? {
          nativeActionId: randomUUID(),
          revisionId: publishedResult.eventId,
          contentSha256: fileSha256.slice('sha256:'.length),
          wrote: true,
          ...(publishedResult.accepted ? { accepted: publishedResult.accepted } : {}),
        },
      };
      publishedReceipt = {
        documentId: id,
        path: saved.scope.path,
        saved: true,
        ...result,
        fileSha256,
      };
      let publishedSha256: string;
      try {
        observeSequenceSaveVerificationForTest(id);
        publishedSha256 = await this.options.readSha256(saved.scope.path);
      } catch (error) {
        if (saved.kind === 'save') throw error;
        document.captures.delete(captureId);
        if (document.stampingCaptureId === captureId) document.stampingCaptureId = undefined;
        return {
          ...this.publish(document),
          saved: true,
          saveResult: result,
          verificationFailed: true,
        };
      }
      if (publishedSha256 !== fileSha256)
        throw new NativeDocumentCommandError(
          'FILE_CHANGED',
          'The published sequence changed before acknowledgement; its native draft is retained.',
          true,
          [publishedReceipt]
        );
      if (this.options.persistPendingPrimerBindings) {
        try {
          const primerPublicationIds = await this.options.persistPendingPrimerBindings(
            saved.capture,
            saved.scope,
            fileSha256,
            result.writeReceipt
          );
          if (primerPublicationIds?.length) {
            result.writeReceipt = {
              ...result.writeReceipt,
              primerPublicationIds: [...primerPublicationIds],
            };
            publishedReceipt = { ...publishedReceipt, writeReceipt: result.writeReceipt };
          }
        } catch (error) {
          saved.scope.assertCurrent();
          if ((await this.options.readSha256(saved.scope.path)) !== fileSha256)
            throw new NativeDocumentCommandError(
              'FILE_CHANGED',
              'The published sequence changed before acknowledgement; its native draft is retained.',
              true,
              [publishedReceipt]
            );
          document.baselineSha256 = fileSha256;
          await this.persist(document);
          saved.scope.assertCurrent();
          if (saved.kind === 'save') throw error;
          document.captures.delete(captureId);
          if (document.stampingCaptureId === captureId) document.stampingCaptureId = undefined;
          return {
            ...this.publish(document),
            saved: true,
            saveResult: result,
            primerBindingFailure: {
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      this.model
        .getState()
        .acknowledgeSaved(id, saved.capture, result.managedAnnotationIds, result.accepted);
      if (
        document.discardCapture?.captureId === captureId &&
        document.discardCapture.version === this.model.getState().getVersion(id)
      ) {
        const current = this.model.getState().captureForSave(id);
        if (current)
          this.model
            .getState()
            .acknowledgeSaved(id, current, result.managedAnnotationIds, result.accepted);
        document.discardCapture = undefined;
      }
      document.baselineSha256 = fileSha256;
      await this.persist(document);
      let history: SequenceDocumentSnapshot['history'];
      try {
        if (saved.kind === 'save' || !this.model.getState().isDirty(id))
          history = await this.options.completeSave?.(
            saved.scope,
            saved.message,
            result.writeReceipt
          );
      } catch (error) {
        history = {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      document.captures.delete(captureId);
      if (document.stampingCaptureId === captureId) document.stampingCaptureId = undefined;
      const snapshot = this.publish(document);
      return {
        ...snapshot,
        saved: true,
        ...(snapshot.dirty ? { captureId } : {}),
        saveResult: result,
        ...(history ? { history } : {}),
      };
    })().catch((error) => {
      if (publishedReceipt)
        throw new NativeDocumentCommandError(
          error instanceof NativeDocumentCommandError
            ? error.code
            : 'SEQUENCE_SAVE_SETTLEMENT_FAILED',
          error instanceof Error ? error.message : String(error),
          true,
          [publishedReceipt]
        );
      if (error instanceof NativeDocumentCommandError) throw error;
      throw new NativeDocumentCommandError(
        'SEQUENCE_SAVE_FAILED',
        error instanceof Error ? error.message : String(error),
        writerEntered ? 'unknown' : false
      );
    });
    saved.promise = run;
    const settled = run
      .then((snapshot) => {
        const completed = document.completedCaptures.get(captureId);
        if (
          completed &&
          snapshot.saved &&
          snapshot.dirty &&
          !snapshot.primerBindingFailure &&
          !snapshot.verificationFailed &&
          snapshot.history?.status !== 'failed'
        )
          completed.continuationVersion = snapshot.version;
        return snapshot;
      })
      .finally(() => {
        if (saved.promise === run) document.captures.delete(captureId);
        if (document.stampingCaptureId === captureId) document.stampingCaptureId = undefined;
      });
    document.completedCaptures.set(captureId, { promise: settled, scope: saved.scope });
    if (document.completedCaptures.size > 32)
      document.completedCaptures.delete(document.completedCaptures.keys().next().value!);
    return settled;
  }
  private discard(document: WorkingCopy): void {
    const pending = [...document.captures.entries()]
      .filter(([, capture]) => Boolean(capture.promise))
      .at(-1);
    if (!pending) {
      this.model.getState().discardEdits(document.scope.documentId);
      return;
    }
    const version = this.model.getState().getVersion(document.scope.documentId) + 1;
    this.restoreCopy(document.scope.documentId, { ...structuredClone(pending[1].copy), version });
    document.discardCapture = { captureId: pending[0], version };
  }
  private snapshot(
    document: WorkingCopy,
    request?: SequenceDocumentRequest
  ): SequenceDocumentSnapshot {
    const id = document.scope.documentId,
      state = inspectSequenceModel(this.model.getState(), id),
      operation = request?.operation;
    const read =
      operation?.kind === 'inspect'
        ? operation
        : { start: 0, limit: 1000, annotationOffset: 0, annotationLimit: 50 };
    if (read.start > state.length)
      throw refusal('INVALID_RANGE: The requested start exceeds the current sequence.');
    let annotations = state.annotations
      .slice(read.annotationOffset, read.annotationOffset + read.annotationLimit)
      .map((annotation, index) => ({ ...annotation, index: read.annotationOffset + index }));
    const annotationPreviewTooLarge =
      Buffer.byteLength(JSON.stringify(annotations), 'utf8') > 1024 * 1024;
    if (annotationPreviewTooLarge) {
      if (operation?.kind === 'inspect' && request?.projection !== 'document')
        throw refusal('INSPECTION_TOO_LARGE: Request fewer sequence annotations.');
      annotations = [];
    }
    const policy = getSequenceSavePolicy(this.model.getState().sequences[id], document.scope.path);
    return {
      requiresManagedAnnotationStamp: Boolean(
        document.scope.managed &&
        this.model
          .getState()
          .sequences[
            id
          ].annotations.some((annotation) => !annotation.qualifiers?.dnaforge_ann_id?.[0])
      ),
      stampingManagedAnnotations: Boolean(document.stampingCaptureId),
      documentId: id,
      path: document.scope.path,
      workspaceRoot: document.scope.workspaceRoot,
      ...(document.scope.bindingIdentity
        ? { bindingIdentity: document.scope.bindingIdentity }
        : {}),
      revision: this.revision(id, state.version),
      persistedRevision: this.revision(id, state.savedVersion),
      version: state.version,
      savedVersion: state.savedVersion,
      ready: true,
      readOnly: document.scope.readOnly,
      dirty: state.dirty,
      saving: this.saving(document),
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      length: state.length,
      annotationCount: state.annotations.length,
      capabilities: document.scope.readOnly
        ? [
            'inspect',
            'reload',
            ...(state.dirty || document.recovery ? ['discard'] : []),
            ...(document.recovery ? ['restore-recovery'] : []),
          ]
        : [
            'inspect',
            'replace-bases',
            'add-annotation',
            'update-annotation',
            'delete-annotation',
            'undo',
            'redo',
            ...(policy.capabilities.canSaveInPlace ? ['save'] : []),
            'discard',
            'reload',
            'restore-recovery',
          ],
      bases: {
        start: read.start,
        end: Math.min(state.length, read.start + read.limit),
        text: state.sequence.slice(read.start, read.start + read.limit),
      },
      annotations,
      nextAnnotationOffset: annotationPreviewTooLarge
        ? read.annotationOffset
        : read.annotationOffset + read.annotationLimit < state.annotations.length
          ? read.annotationOffset + read.annotationLimit
          : null,
      ...(request?.projection === 'document' ? { copy: structuredClone(this.copy(id)) } : {}),
      ...(document.recovery ? { recoveryId: hash(JSON.stringify(document.recovery)) } : {}),
      ...(document.scope.reason ? { reason: document.scope.reason } : {}),
    };
  }
  private publish(
    document: WorkingCopy,
    request?: SequenceDocumentRequest
  ): SequenceDocumentSnapshot {
    const snapshot = this.snapshot(document, {
      documentId: document.scope.documentId,
      operation: {
        kind: 'inspect',
        start: 0,
        limit: 1000,
        annotationOffset: 0,
        annotationLimit: 50,
      },
      projection: 'document',
    });
    for (const listener of this.listeners) listener(snapshot);
    return request?.projection === 'document' ? snapshot : this.snapshot(document, request);
  }
  private revision(id: string, version: number): string {
    return `sequence-draft-v1:${this.generation}:${id}:${version}`;
  }
  private saving(document: WorkingCopy): boolean {
    return [...document.captures.values()].some((capture) => Boolean(capture.promise));
  }
  private normalize(path: string): string {
    return this.options.normalizePath?.(path) ?? path;
  }
  private contains(parent: string, path: string): boolean {
    return path === parent || path.startsWith(parent.replace(/[\\/]+$/, '') + '/');
  }
  private assertUnprotected(path: string): void {
    for (const paths of this.protectedPaths.values())
      for (const parent of paths)
        if (this.contains(parent, path) || this.contains(path, parent))
          throw new Error(
            'SEQUENCE_DOCUMENT_BUSY: The sequence or its project is protected by another native operation.'
          );
  }
}
