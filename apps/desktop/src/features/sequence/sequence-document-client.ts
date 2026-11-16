import { userMessageWithValues, userMessageValue, toUserMessage } from '@waypoint/user-messages';
import type { StoreApi } from 'zustand/vanilla';
import { cleanSequenceFromEditorState } from '@waypoint/workspace-editor/model';
import { platform } from '../../platform';
import type { FileDocumentFlushPurpose } from '../../shared/file-document-client-sync';
import { isDesktopRuntime } from '../../utils/environment';
import {
  registerNativeDocumentClientFlush,
  waitForNativeFileDocumentReadiness,
} from '../workspace/public/file-document-client';
import type {
  SequenceModelCommand,
  SequenceStore,
  SequenceSaveCapture,
} from './sequence-document-model';
import {
  isSequenceViewOnlyAction,
  type SequenceDocumentClientCommand,
  type SequenceDocumentCopy,
  type SequenceDocumentSnapshot,
  type SequenceDocumentOperation,
} from '../../shared/sequence-document';
import { useToastStore } from '../../stores/toast-store';
import { setSequenceClientPort, isReadOnlySequencePreview } from './sequence-client-port';
import { canonicalJson } from '../../shared/canonical-json';
import { WORKSPACE_RECONCILED_EVENT } from '../../services/workspace-reconciled-event';

function captureJson(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)));
}

interface PendingSequenceCommand {
  command: SequenceDocumentClientCommand;
  viewOnly: boolean;
}

interface Client {
  documentId: string;
  attached: boolean;
  snapshot?: SequenceDocumentSnapshot;
  tail: Promise<unknown>;
  loading?: Promise<void>;
  pending: number;
  explicitPending: number;
  unacknowledged: Set<PendingSequenceCommand>;
  error?: Error;
  offeredRecovery?: string;
  projected?: boolean;
  refreshRequested?: boolean;
}
let bridge: SequenceDocumentClientBridge | undefined;
export function getNativeSequenceDocumentClient(): SequenceDocumentClientBridge | undefined {
  return bridge;
}
export function installNativeSequenceDocumentClient(model: StoreApi<SequenceStore>): () => void {
  if (!isDesktopRuntime()) return () => {};
  const current = new SequenceDocumentClientBridge(model);
  bridge = current;
  const detachPort = setSequenceClientPort(current);
  const detach = platform().fs.subscribeSequenceDocuments((snapshot) => current.observe(snapshot));
  const detachFlush = registerNativeDocumentClientFlush((purpose) => current.flush(purpose));
  const refresh = () => current.refreshAvailableDocuments();
  window.addEventListener(WORKSPACE_RECONCILED_EVENT, refresh);
  current.refreshAvailableDocuments();
  return () => {
    window.removeEventListener(WORKSPACE_RECONCILED_EVENT, refresh);
    current.command({ method: 'clearAll', args: [] });
    detach();
    detachFlush();
    detachPort();
    if (bridge === current) bridge = undefined;
  };
}
const inspect = {
  kind: 'inspect' as const,
  start: 0,
  limit: 1000,
  annotationOffset: 0,
  annotationLimit: 50,
};

export class SequenceDocumentClientBridge {
  private readonly clients = new Map<string, Client>();
  private readonly saves = new Map<string, Promise<SequenceDocumentSnapshot>>();
  constructor(private readonly model: StoreApi<SequenceStore>) {}
  refreshAvailableDocuments(): void {
    for (const [id, sequence] of Object.entries(this.model.getState().sequences)) {
      const client = this.clients.get(id);
      if (client?.projected) continue;
      if (client?.loading) {
        client.refreshRequested = true;
        continue;
      }
      this.command({ method: 'setSequence', args: [id, sequence] });
    }
  }
  owns(documentId: string): boolean {
    return this.clients.get(documentId)?.attached === true;
  }
  private client(id: string): Client {
    let client = this.clients.get(id);
    if (!client) {
      client = {
        documentId: id,
        attached: true,
        tail: Promise.resolve(),
        pending: 0,
        explicitPending: 0,
        unacknowledged: new Set(),
      };
      this.clients.set(id, client);
    }
    return client;
  }
  isInputPending(id: string): boolean {
    const client = this.clients.get(id);
    return (
      !client?.attached || !client.snapshot || Boolean(client.loading) || client.explicitPending > 0
    );
  }
  assertInput(id: string, purpose?: 'discard'): void {
    const client = this.clients.get(id);
    if (client?.explicitPending || client?.loading)
      throw new Error('SEQUENCE_DOCUMENT_NOT_READY: The native document is still loading.');
    if (client?.snapshot?.recoveryId)
      throw new Error('RECOVERY_PENDING: Restore or discard the retained sequence before editing.');
    if (client?.snapshot?.readOnly)
      throw new Error('READ_ONLY_SEQUENCE: This sequence is read-only.');
    if (client?.error && purpose !== 'discard') throw client.error;
    if (client && !client.snapshot)
      throw new Error(
        'SEQUENCE_DOCUMENT_NOT_READY: The current native sequence copy is not ready for editing.'
      );
  }
  command(input: SequenceModelCommand): void {
    const command = structuredClone(input);
    if (command.method === 'clearAll') {
      for (const client of this.clients.values()) client.attached = false;
      return;
    }
    const id = command.args[0];
    if (command.method === 'clearSequence') {
      const client = this.clients.get(id);
      if (client) client.attached = false;
      return;
    }
    if (isReadOnlySequencePreview(id)) return;
    if (command.method === 'setSequence') {
      const client = this.client(id);
      client.attached = true;
      void this.load(client, true).catch((error) => this.failed(client, error));
      return;
    }
    const client = this.clients.get(id);
    if (!client?.attached) return;
    if (command.method === 'acknowledgeMetadata') {
      client.projected = false;
      void this.enqueue(
        client,
        async () => {
          client.snapshot = await platform().fs.sequenceDocument({
            documentId: client.documentId,
            expectedVersion: client.snapshot!.version,
            operation: { kind: 'refresh-metadata' },
            projection: 'document',
          });
        },
        true,
        false,
        true,
        command.method
      ).catch(() => {});
      return;
    }
    let native: SequenceDocumentClientCommand;
    switch (command.method) {
      case 'dispatchEdit':
        native = { method: command.method, action: command.args[1] };
        break;
      case 'replaceBases':
        native = {
          method: command.method,
          start: command.args[1],
          end: command.args[2],
          bases: command.args[3],
        };
        break;
      case 'updateAnnotation':
        native = { method: command.method, index: command.args[1], patch: command.args[2] };
        break;
      case 'deleteAnnotation':
        native = { method: command.method, index: command.args[1] };
        break;
      case 'addAnnotation':
        native = { method: command.method, annotation: command.args[1] };
        break;
      case 'mergeAnnotations':
        native = { method: command.method, annotations: command.args[1] };
        break;
      case 'discardEdits':
        native = { method: command.method };
        break;
      case 'patchSavedMetadata':
        native = { method: command.method, patch: command.args[1] };
        break;
      case 'restoreRecoveredDraft':
        native = { method: command.method, content: command.args[1] };
        break;
    }
    const metadataRead = native.method === 'patchSavedMetadata';
    if (metadataRead) client.projected = false;
    const viewOnly =
      metadataRead ||
      (command.method === 'dispatchEdit' && isSequenceViewOnlyAction(command.args[1]));
    const pending = metadataRead ? undefined : { command: native, viewOnly };
    if (pending) client.unacknowledged.add(pending);
    const explicit = command.method === 'discardEdits';
    if (explicit) {
      client.explicitPending++;
      this.model.getState().setLoading(id, true);
    }
    void this.enqueue(
      client,
      async () => {
        const snapshot = await platform().fs.sequenceDocument({
          documentId: id,
          expectedVersion: client.snapshot!.version,
          operation: metadataRead
            ? { kind: 'refresh-metadata' }
            : { kind: 'client-command', command: native },
          projection: 'document',
        });
        client.snapshot = snapshot;
        if (explicit) client.unacknowledged.clear();
        else if (pending) client.unacknowledged.delete(pending);
        if (metadataRead) client.projected = false;
      },
      true,
      explicit,
      viewOnly,
      command.method
    )
      .finally(() => {
        if (explicit) {
          client.explicitPending--;
          this.model
            .getState()
            .setLoading(id, Boolean(client.loading) || client.explicitPending > 0);
        }
      })
      .catch(() => {});
  }
  observe(snapshot: SequenceDocumentSnapshot): void {
    const client = this.clients.get(snapshot.documentId);
    if (
      !client?.attached ||
      client.pending ||
      client.loading ||
      client.error ||
      client.unacknowledged.size
    )
      return;
    if (
      client.snapshot &&
      (snapshot.version < client.snapshot.version ||
        (snapshot.version === client.snapshot.version &&
          snapshot.savedVersion < client.snapshot.savedVersion))
    )
      return;
    client.snapshot = snapshot;
    this.accept(client);
  }
  async flush(purpose: FileDocumentFlushPurpose = 'synchronize'): Promise<void> {
    if (purpose === 'discard') {
      await Promise.allSettled([
        ...[...this.clients.values()].flatMap((client) => [client.loading, client.tail]),
        ...this.saves.values(),
      ]);
      return;
    }
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        await client.loading;
        await client.tail;
        if (client.error) throw client.error;
      })
    );
  }
  async execute(
    documentId: string,
    operation: SequenceDocumentOperation,
    options: { expectedVersion?: number } = {}
  ): Promise<SequenceDocumentSnapshot> {
    const client = this.client(documentId);
    if (client.unacknowledged.size && operation.kind !== 'discard')
      throw (
        client.error ?? new Error('RECOVERY_PENDING: Unacknowledged sequence input is retained.')
      );
    let result!: SequenceDocumentSnapshot;
    client.explicitPending++;
    this.model.getState().setLoading(documentId, true);
    try {
      await this.enqueue(
        client,
        async () => {
          result = await platform().fs.sequenceDocument({
            documentId,
            expectedVersion: options.expectedVersion ?? client.snapshot!.version,
            operation,
            projection: 'document',
          });
          client.snapshot = result;
          if (operation.kind === 'discard') client.unacknowledged.clear();
        },
        false,
        true
      );
      return result;
    } finally {
      client.explicitPending--;
      this.model
        .getState()
        .setLoading(documentId, Boolean(client.loading) || client.explicitPending > 0);
    }
  }
  async save(
    documentId: string,
    options: {
      capture: SequenceSaveCapture;
      beforeWrite?: () => void;
      message?: string;
      fromCaptureId?: string;
    }
  ): Promise<SequenceDocumentSnapshot> {
    options.beforeWrite?.();
    const key = `${documentId}:${options.capture.revision}:${options.fromCaptureId ?? ''}`,
      previous = this.saves.get(key);
    if (previous) return previous;
    const client = this.client(documentId),
      stamping = Boolean(client.snapshot?.requiresManagedAnnotationStamp);
    if (stamping) {
      client.explicitPending++;
      this.model.getState().setLoading(documentId, true);
    }
    const run = this.saveCaptured(documentId, { ...options, beforeWrite: undefined });
    this.saves.set(key, run);
    try {
      return await run;
    } finally {
      if (this.saves.get(key) === run) this.saves.delete(key);
      if (stamping) {
        client.explicitPending--;
        this.model
          .getState()
          .setLoading(documentId, Boolean(client.loading) || client.explicitPending > 0);
      }
    }
  }
  private async saveCaptured(
    documentId: string,
    options: {
      capture: SequenceSaveCapture;
      beforeWrite?: () => void;
      message?: string;
      fromCaptureId?: string;
    }
  ): Promise<SequenceDocumentSnapshot> {
    const client = this.client(documentId),
      acceptedCapture = structuredClone(options.capture),
      acceptedCommands = [...client.unacknowledged];
    let captureId!: string;
    await this.enqueue(
      client,
      async () => {
        await this.recoverInput(client, acceptedCommands, acceptedCapture);
        if (client.snapshot!.version !== acceptedCapture.revision)
          throw new Error(
            'STALE_SEQUENCE: The requested save gesture no longer matches the native working revision.'
          );
        const admitted = await platform().fs.sequenceDocument({
          documentId,
          expectedVersion: client.snapshot!.version,
          ...(!options.fromCaptureId
            ? { expectedRevision: this.recoveryPrecondition(client.snapshot!) }
            : {}),
          operation: {
            kind: 'capture-save',
            message: options.message ?? 'Edit sequence',
            ...(options.fromCaptureId ? { fromCaptureId: options.fromCaptureId } : {}),
          },
          projection: 'document',
        });
        if (!admitted.captureId)
          throw new Error('The native sequence owner did not admit its save capture.');
        client.snapshot = admitted;
        captureId = admitted.captureId;
      },
      false,
      Boolean(client.snapshot)
    );
    const published = await platform().fs.sequenceDocument({
      documentId,
      operation: { kind: 'publish-save', captureId },
      projection: 'document',
    });
    await this.enqueue(client, async () => {
      const current = client.snapshot!;
      if (
        published.version > current.version ||
        (published.version === current.version && published.savedVersion > current.savedVersion)
      )
        client.snapshot = published;
      else if (
        published.version === current.version &&
        published.savedVersion === current.savedVersion
      )
        client.snapshot = { ...current, saving: published.saving };
    });
    return {
      ...client.snapshot!,
      saved: published.saved,
      saveResult: published.saveResult,
      primerBindingFailure: published.primerBindingFailure,
      verificationFailed: published.verificationFailed,
      history: published.history,
      captureId:
        published.saved &&
        !published.primerBindingFailure &&
        !published.verificationFailed &&
        client.snapshot!.dirty &&
        published.version === client.snapshot!.version &&
        published.savedVersion === client.snapshot!.savedVersion
          ? published.captureId
          : undefined,
    };
  }
  private recoveryPrecondition(snapshot: SequenceDocumentSnapshot) {
    if (!snapshot.copy)
      throw new Error('SEQUENCE_DOCUMENT_NOT_READY: The last acknowledged native copy is missing.');
    return {
      revision: snapshot.revision,
      copyJson: JSON.stringify(snapshot.copy),
      bindingIdentity: snapshot.bindingIdentity,
    };
  }
  private async recoverInput(
    client: Client,
    acceptedCommands: PendingSequenceCommand[],
    capture: SequenceSaveCapture
  ): Promise<boolean> {
    const pending = acceptedCommands.filter((command) => client.unacknowledged.has(command));
    if (!pending.length) {
      if (client.error) throw client.error;
      return false;
    }
    try {
      const previous = client.snapshot!;
      const current = await platform().fs.sequenceDocument({
        documentId: client.documentId,
        expectedVersion: previous.version,
        expectedRevision: this.recoveryPrecondition(previous),
        operation: inspect,
        projection: 'document',
      });
      if (
        current.readOnly ||
        current.recoveryId ||
        current.saving ||
        current.documentId !== previous.documentId ||
        current.path !== previous.path ||
        current.bindingIdentity !== previous.bindingIdentity ||
        current.workspaceRoot !== previous.workspaceRoot ||
        current.revision !== previous.revision ||
        current.persistedRevision !== previous.persistedRevision ||
        current.version !== previous.version ||
        current.savedVersion !== previous.savedVersion ||
        !current.copy ||
        JSON.stringify(current.copy) !== JSON.stringify(previous.copy)
      )
        throw new Error('STALE_SEQUENCE: The last acknowledged native document changed.');
      client.snapshot = current;
      for (const command of pending) {
        const acknowledged = await platform().fs.sequenceDocument({
          documentId: client.documentId,
          expectedVersion: client.snapshot!.version,
          expectedRevision: this.recoveryPrecondition(client.snapshot!),
          operation: { kind: 'client-command', command: command.command },
          projection: 'document',
        });
        client.snapshot = acknowledged;
        client.unacknowledged.delete(command);
      }
      const copy = client.snapshot!.copy;
      const pendingBindings = copy
        ? cleanSequenceFromEditorState(copy.draft).pendingPrimerBindings
        : [];
      if (
        !copy ||
        client.snapshot!.version !== capture.revision ||
        captureJson(copy.sequence) !== captureJson(capture.sequence) ||
        copy.draft.sequence !== capture.draftSequence ||
        copy.lineage.id !== capture.draftLineageId ||
        captureJson(copy.lineage.baseline) !== captureJson(capture.draftBaseline) ||
        captureJson(copy.draft.insertedRanges) !== captureJson(capture.insertedRanges) ||
        captureJson(copy.draft.deletedRanges) !== captureJson(capture.deletedRanges) ||
        captureJson(copy.draft.substitutedRanges) !== captureJson(capture.substitutedRanges) ||
        pendingBindings.length !== capture.pendingPrimerBindings.length ||
        pendingBindings.some((binding, index) => {
          const captured = capture.pendingPrimerBindings[index];
          return (
            !captured ||
            binding.pendingId !== captured.pendingId ||
            binding.primerId !== captured.primerId ||
            binding.start !== captured.start ||
            binding.end !== captured.end ||
            binding.strand !== captured.strand ||
            binding.sourceWorkspaceRoot !== captured.sourceWorkspaceRoot
          );
        })
      )
        throw new Error('STALE_SEQUENCE: Replayed input does not match the captured save gesture.');
      client.error = undefined;
      return true;
    } catch (error) {
      client.error = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }
  private async scopeIsUnavailable(documentId: string): Promise<boolean> {
    try {
      return !(await platform().fs.isSequenceDocumentAvailable(documentId));
    } catch {
      return false;
    }
  }
  private load(client: Client, automatic = false): Promise<void> {
    if (client.loading) return client.loading;
    client.projected = false;
    this.model.getState().setLoading(client.documentId, true);
    let loaded = false;
    const run = (async () => {
      if ([...client.unacknowledged].some((command) => !command.viewOnly))
        throw (
          client.error ?? new Error('RECOVERY_PENDING: Unacknowledged sequence input is retained.')
        );
      await waitForNativeFileDocumentReadiness();
      if (automatic && !(await platform().fs.isSequenceDocumentAvailable(client.documentId)))
        return;
      await waitForNativeFileDocumentReadiness();
      let snapshot = await platform().fs.sequenceDocument({
        documentId: client.documentId,
        operation: inspect,
        projection: 'document',
      });
      if (!snapshot.dirty && !snapshot.recoveryId)
        snapshot = await platform().fs.sequenceDocument({
          documentId: client.documentId,
          expectedVersion: snapshot.version,
          operation: { kind: 'reload' },
          projection: 'document',
        });
      client.snapshot = snapshot;
      client.unacknowledged.clear();
      client.error = undefined;
      loaded = true;
    })().catch(async (error) => {
      if (automatic && (await this.scopeIsUnavailable(client.documentId))) return;
      throw error;
    });
    let completed = false;
    const loading: Promise<void> = run
      .then(() => {
        completed = true;
      })
      .finally(() => {
        if (client.loading === loading) {
          client.loading = undefined;
          this.model.getState().setLoading(client.documentId, client.explicitPending > 0);
          if (loaded && !client.pending && client.snapshot) this.accept(client);
          const refreshRequested = client.refreshRequested;
          client.refreshRequested = false;
          if (
            refreshRequested &&
            completed &&
            client.attached &&
            !client.projected &&
            !client.error &&
            this.model.getState().sequences[client.documentId]
          )
            return this.load(client, true);
        }
      });
    client.loading = loading;
    return loading;
  }
  private enqueue(
    client: Client,
    operation: () => Promise<void>,
    retainError = true,
    allowError = false,
    viewOnly = false,
    context?: string
  ): Promise<void> {
    client.pending += 1;
    let skipProjection = false;
    const run = client.tail
      .then(async () => {
        if (client.error && !allowError) throw client.error;
        if (viewOnly) {
          await waitForNativeFileDocumentReadiness();
          if (!(await platform().fs.isSequenceDocumentAvailable(client.documentId))) {
            skipProjection = true;
            return;
          }
        }
        if (!client.snapshot) {
          await client.loading;
          if (!client.snapshot) await this.load(client, viewOnly);
        }
        if (viewOnly && !client.snapshot) {
          skipProjection = true;
          return;
        }
        await operation();
        client.error = undefined;
      })
      .catch(async (error) => {
        if (viewOnly && (await this.scopeIsUnavailable(client.documentId))) {
          skipProjection = true;
          return;
        }
        if (retainError) this.failed(client, error, context);
        throw error;
      })
      .finally(() => {
        client.pending -= 1;
        if (!skipProjection && !client.pending && !client.error && client.snapshot)
          this.accept(client);
      });
    client.tail = run.catch(() => {});
    return run;
  }
  private accept(client: Client): void {
    if (!client.attached || client.unacknowledged.size) return;
    const snapshot = client.snapshot;
    if (!snapshot?.copy) return;
    this.restore(snapshot.documentId, snapshot.copy, snapshot.dirty, !client.projected);
    client.projected = true;
    if (snapshot.recoveryId && client.offeredRecovery !== snapshot.recoveryId) {
      client.offeredRecovery = snapshot.recoveryId;
      const recoveryId = snapshot.recoveryId;
      useToastStore.getState().addRichToast({
        definition: 'unsaved-sequence-recovery-available',
        message: userMessageWithValues(
          'notice.value-has-an-unsaved-native-draft-from-an-earlier-session',
          { value0: userMessageValue(snapshot.copy.sequence.name ?? 'This sequence') }
        ),
        actions: [
          {
            label: 'Restore',
            onClick: () =>
              this.execute(client.documentId, { kind: 'restore-recovery', recoveryId }),
          },
          { label: 'Discard', onClick: () => this.execute(client.documentId, { kind: 'discard' }) },
        ],
      });
    }
  }
  private restore(id: string, copy: SequenceDocumentCopy, dirty: boolean, force = false): void {
    this.model.setState((state) => ({
      sequences:
        !force &&
        state.sequenceVersions[id] === copy.version &&
        state.savedVersions[id] === copy.savedVersion
          ? state.sequences
          : { ...state.sequences, [id]: copy.sequence },
      savedSequences:
        !force && state.savedVersions[id] === copy.savedVersion
          ? state.savedSequences
          : { ...state.savedSequences, [id]: copy.savedSequence },
      drafts: { ...state.drafts, [id]: copy.draft },
      draftLineages: { ...state.draftLineages, [id]: copy.lineage },
      acceptedRevisions: copy.acceptedRevision
        ? { ...state.acceptedRevisions, [id]: copy.acceptedRevision }
        : Object.fromEntries(Object.entries(state.acceptedRevisions).filter(([key]) => key !== id)),
      sequenceVersions: { ...state.sequenceVersions, [id]: copy.version },
      savedVersions: { ...state.savedVersions, [id]: copy.savedVersion },
      dirtyPaths: dirty
        ? { ...state.dirtyPaths, [id]: true }
        : Object.fromEntries(Object.entries(state.dirtyPaths).filter(([key]) => key !== id)),
    }));
  }
  private failed(client: Client, error: unknown, context?: string): void {
    client.error = error instanceof Error ? error : new Error(String(error));
    if (context) console.error('[Native sequence document]', client.error, `command=${context}`);
    else console.error('[Native sequence document]', client.error);
    useToastStore.getState().addRichToast({
      definition: 'sequence-save-failed',
      message: toUserMessage(client.error, 'operation.failed'),
    });
  }
}
