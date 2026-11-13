import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { undo as undoPM, redo as redoPM } from '@tiptap/pm/history';
import { platform } from '../../platform';
import type { FileDocumentFlushPurpose } from '../../shared/file-document-client-sync';
import type {
  NativeNotebookRequest,
  NotebookDocumentSnapshot,
} from '../../shared/notebook-document';
import { contentFingerprint } from '../../shared/content-fingerprint';
import { canonicalNotebookJson } from '../../db/notebook-markdown-codec';
import {
  registerNativeDocumentClientFlush,
  waitForNativeFileDocumentReadiness,
} from '../workspace/public/file-document-client';
import { readAllUnsavedDrafts, deleteUnsavedDraft } from '../../shared/unsaved-draft-recovery';
import { useToastStore } from '../../stores/toast-store';
import { NotebookDocumentModel } from './notebook-document-model';
import { projectNotebookDocumentSnapshot } from './notebook-document-projection';
import {
  captureNativeTableNotebookSave,
  confirmNativeTableNotebookSave,
  type NativeTableNotebookSave,
} from './embeds/table/notebook-observation';
import {
  captureNotebookSave,
  confirmNativeNotebookSave,
  observeNotebookSaveFailure,
} from './notebook-workflow';

const clients = new Map<string, NativeNotebookDocumentClient>();
function sameNotebookPositions(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  if (before.eq(after)) return true;
  if (
    before.type !== after.type ||
    before.nodeSize !== after.nodeSize ||
    before.childCount !== after.childCount ||
    before.marks.length !== after.marks.length ||
    before.marks.some((mark, index) => !mark.eq(after.marks[index]))
  )
    return false;
  if (before.type.name === 'mention' && before.isLeaf && after.isLeaf) return true;
  if (!before.sameMarkup(after) || before.text !== after.text) return false;
  for (let index = 0; index < before.childCount; index++)
    if (!sameNotebookPositions(before.child(index), after.child(index))) return false;
  return true;
}
let subscribed = false;
export function getNativeNotebookDocumentClient(pageId: string): NativeNotebookDocumentClient {
  let client = clients.get(pageId);
  if (!client) {
    client = new NativeNotebookDocumentClient(pageId);
    clients.set(pageId, client);
  }
  if (!subscribed) {
    platform().notebook.onChanged((snapshot) =>
      clients.get(snapshot.documentId)?.observe(snapshot)
    );
    registerNativeDocumentClientFlush(flushNativeNotebookDocumentClients);
    subscribed = true;
  }
  return client;
}
export function ownsNativeNotebookPage(pageId: string): boolean {
  return clients.get(pageId)?.ready === true;
}
export async function flushNativeNotebookDocumentClients(
  purpose: FileDocumentFlushPurpose = 'synchronize'
): Promise<void> {
  await Promise.all(
    [...clients.values()].filter((client) => client.ready).map((client) => client.flush(purpose))
  );
}

let legacyMigration: Promise<void> = Promise.resolve();
export function migrateLegacyNotebookDrafts(): Promise<void> {
  const run = legacyMigration.then(async () => {
    const entries = (await readAllUnsavedDrafts()).filter((entry) => entry.key.startsWith('page:')),
      pending: string[] = [];
    for (const entry of entries) {
      const documentId = entry.key.slice(5);
      try {
        if (entry.version !== 1 || !entry.payload || typeof entry.payload !== 'object')
          throw new Error('The earlier notebook recovery record is invalid.');
        const snapshot = await platform().notebook.execute({
          documentId,
          operation: { kind: 'inspect-copy' },
        });
        const retained = await platform().notebook.execute({
          documentId,
          expectedRevision: snapshot.revision,
          requestId: crypto.randomUUID(),
          operation: {
            kind: 'retain-legacy-recovery',
            baseline: entry.baseline,
            content: entry.payload as JSONContent,
          },
        });
        if (
          !retained.recovery ||
          canonicalNotebookJson(retained.recovery.content) !== canonicalNotebookJson(entry.payload)
        )
          throw new Error('The native owner did not acknowledge the earlier notebook draft.');
        await deleteUnsavedDraft(entry.key);
      } catch (error) {
        pending.push(documentId);
        console.warn(
          '[Native notebook recovery] The earlier draft remains in its original store:',
          error
        );
      }
    }
    await platform().notebook.completeLegacyDraftMigration([...new Set(pending)]);
  });
  legacyMigration = run.catch(() => {});
  return run;
}

export class NativeNotebookDocumentClient {
  snapshot: NotebookDocumentSnapshot | null = null;
  error: string | null = null;
  databaseOnly = false;
  lastCommandError: unknown = null;
  private tail: Promise<unknown> = Promise.resolve();
  private loading: Promise<void> | undefined;
  private pending = 0;
  private saves = 0;
  private inputVersion = 0;
  private tableSave: NativeTableNotebookSave | null = null;
  private notebookContent: JSONContent | null = null;
  private readonly capturedSaves = new Map<number, Promise<boolean>>();
  private listeners = new Set<() => void>();
  private readonly editors = new Set<Editor>();
  private applying = false;
  private acknowledgedCapture: {
    revision: string;
    optimisticAfter: ProseMirrorNode;
    nativeAfter: ProseMirrorNode;
  } | null = null;
  constructor(readonly pageId: string) {}
  get nativeDocumentId(): string {
    return this.snapshot?.documentId ?? this.pageId;
  }
  get ready(): boolean {
    return this.snapshot !== null;
  }
  get hasPending(): boolean {
    return this.pending > 0;
  }
  get saving(): boolean {
    return this.saves > 0 || Boolean(this.snapshot?.saving);
  }
  get statusKey(): string {
    return `${this.ready}:${this.dirty}:${this.saving}:${this.snapshot?.readOnly ?? true}:${this.snapshot?.publication?.status ?? 'legacy'}:${this.error ?? ''}`;
  }
  get dirty(): boolean {
    return this.pending > 0 || Boolean(this.snapshot?.dirty) || Boolean(this.snapshot?.recovery);
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  async initialize(beforeLoad?: Promise<unknown>): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await beforeLoad;
      await waitForNativeFileDocumentReadiness();
      this.observe(
        await platform().notebook.execute({
          documentId: this.pageId,
          operation: { kind: 'inspect-copy' },
        })
      );
      this.offerRecovery();
    })().catch((error) => {
      this.databaseOnly = /(?:^|: )NOTEBOOK_NOT_FOUND(?=:|$)/u.test(
        error instanceof Error ? error.message : String(error)
      );
      this.fail(error);
      throw error;
    });
    return this.loading;
  }
  observe(snapshot: NotebookDocumentSnapshot): void {
    if (snapshot.documentId !== this.pageId) return;
    if (this.snapshot) {
      const generation = this.snapshot.revision.split(':', 1)[0],
        incoming = snapshot.revision.split(':', 1)[0];
      if (generation === incoming && snapshot.version < this.snapshot.version) return;
      if (generation !== incoming && this.pending) {
        this.fail(
          new Error(
            'The native notebook owner restarted while edits were pending. Your view remains preserved.'
          )
        );
        return;
      }
    }
    this.snapshot = snapshot;
    if (!this.pending && !this.error) this.project();
    this.notify();
  }
  attach(editor: Editor): () => void {
    this.editors.add(editor);
    editor.setEditable(false, false);
    if (this.ready && !this.pending && !this.error) this.project();
    return () => {
      this.editors.delete(editor);
      void this.flush().catch(() => {});
    };
  }
  capture(transaction: Transaction, content?: JSONContent): void {
    if (this.applying || !transaction.docChanged) return;
    if (!this.snapshot || this.error) {
      this.fail(new Error('The native notebook working copy is not ready for editing.'));
      return;
    }
    const steps = transaction.steps.map((step) => step.toJSON()),
      selection = transaction.selection.toJSON();
    this.inputVersion++;
    this.tableSave = content ? captureNativeTableNotebookSave(this.pageId, content) : null;
    this.notebookContent = content ?? null;
    this.pending++;
    this.notify();
    const work = this.tail
      .then(async () => {
        if (this.error) throw new Error(this.error);
        const current = this.snapshot!,
          acknowledgement = this.acknowledgedCapture;
        let before = transaction.before;
        if (
          acknowledgement?.revision === current.revision &&
          before.eq(acknowledgement.optimisticAfter)
        ) {
          const canonical = before.type.schema.nodeFromJSON(current.copy.content);
          if (canonical.eq(acknowledgement.nativeAfter)) before = canonical;
        }
        const snapshot = await platform().notebook.execute({
          documentId: this.nativeDocumentId,
          expectedRevision: current.revision,
          requestId: crypto.randomUUID(),
          operation: {
            kind: 'apply-steps',
            time: transaction.time,
            addToHistory: transaction.getMeta('addToHistory') === false ? false : undefined,
            separateHistory: transaction.getMeta('closeHistory$') === true,
            steps,
            selection,
            baseFingerprint: contentFingerprint(canonicalNotebookJson(before.toJSON())),
          },
        });
        const nativeAfter = transaction.doc.type.schema.nodeFromJSON(snapshot.copy.content);
        this.acknowledgedCapture =
          !transaction.doc.eq(nativeAfter) && sameNotebookPositions(transaction.doc, nativeAfter)
            ? { revision: snapshot.revision, optimisticAfter: transaction.doc, nativeAfter }
            : null;
        this.observe(snapshot);
      })
      .catch((error) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.pending--;
        if (!this.pending && !this.error) this.project();
        this.notify();
      });
    this.tail = work;
    void work.catch(() => {});
  }
  async flush(purpose: FileDocumentFlushPurpose = 'synchronize'): Promise<void> {
    if (purpose === 'discard') {
      await Promise.allSettled([this.loading, this.tail, ...this.capturedSaves.values()]);
      return;
    }
    await this.tail;
    if (this.error) throw new Error(this.error);
  }
  async command(operation: NativeNotebookRequest['operation']): Promise<NotebookDocumentSnapshot> {
    if (
      !['inspect', 'inspect-copy', 'schema', 'capture-save', 'await-save', 'keep-local'].includes(
        operation.kind
      ) &&
      !(operation.kind === 'table' && operation.command.kind === 'inspect')
    ) {
      this.inputVersion++;
      this.tableSave = null;
      this.notebookContent = null;
    }
    const work = this.tail.then(async () => {
      await this.loading;
      if (this.error) throw new Error(this.error);
      if (!this.snapshot) throw new Error('The notebook owner is not ready.');
      const current = this.snapshot,
        acknowledgement = this.acknowledgedCapture;
      const snapshot = await platform().notebook.execute({
        documentId: this.nativeDocumentId,
        expectedRevision: current.revision,
        requestId: crypto.randomUUID(),
        operation,
      });
      if (
        acknowledgement?.revision === current.revision &&
        ['capture-save', 'save', 'rename', 'set-title', 'table-view'].includes(operation.kind)
      ) {
        const schema = acknowledgement.nativeAfter.type.schema;
        if (
          schema.nodeFromJSON(current.copy.content).eq(acknowledgement.nativeAfter) &&
          schema.nodeFromJSON(snapshot.copy.content).eq(acknowledgement.nativeAfter)
        )
          this.acknowledgedCapture = { ...acknowledgement, revision: snapshot.revision };
      }
      this.observe(snapshot);
      return snapshot;
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async replaceContent(content: JSONContent): Promise<void> {
    await this.flush();
    const current = this.snapshot;
    if (!current) throw new Error('The notebook owner is not ready.');
    if (canonicalNotebookJson(current.copy.content) === canonicalNotebookJson(content)) return;
    const model = new NotebookDocumentModel(current.copy.content, current.title),
      desired = model.state.schema.nodeFromJSON(content);
    desired.check();
    const transaction = model.state.tr.replaceWith(
      0,
      model.state.doc.content.size,
      desired.content
    );
    await this.command({
      kind: 'apply-steps',
      baseFingerprint: contentFingerprint(canonicalNotebookJson(current.copy.content)),
      steps: transaction.steps.map((step) => step.toJSON()),
      separateHistory: true,
    });
  }
  save(): Promise<boolean> {
    const version = this.inputVersion,
      previous = this.capturedSaves.get(version);
    if (previous) return previous;
    const tableSave = this.tableSave;
    const notebookSave = this.notebookContent
      ? captureNotebookSave(this.pageId, this.notebookContent)
      : null;
    const persistedFingerprint = this.snapshot?.canonicalFingerprint;
    this.saves++;
    this.notify();
    this.lastCommandError = null;
    const run = this.command({ kind: 'capture-save' })
      .then(async (capture) => {
        if (!capture.saveCaptureId)
          throw new Error('The native notebook owner did not acknowledge its save capture.');
        const committed = await platform().notebook.execute({
          documentId: this.nativeDocumentId,
          operation: { kind: 'await-save', saveCaptureId: capture.saveCaptureId },
        });
        await confirmNativeTableNotebookSave(tableSave, capture, committed);
        confirmNativeNotebookSave(notebookSave, capture, committed, persistedFingerprint);
        const snapshot = await this.command({ kind: 'inspect-copy' });
        return (
          !snapshot.dirty &&
          !snapshot.saving &&
          (!snapshot.publication || snapshot.publication.status === 'settled') &&
          version === this.inputVersion &&
          !this.pending
        );
      })
      .catch((error) => {
        observeNotebookSaveFailure(notebookSave, error);
        this.lastCommandError = error;
        return false;
      })
      .finally(() => {
        this.saves--;
        if (this.capturedSaves.get(version) === run) this.capturedSaves.delete(version);
        this.notify();
      });
    this.capturedSaves.set(version, run);
    return run;
  }
  async discard(): Promise<void> {
    await this.tail.catch(() => {});
    const current = await platform().notebook.execute({
      documentId: this.nativeDocumentId,
      operation: { kind: 'inspect-copy' },
    });
    const snapshot = await platform().notebook.execute({
      documentId: this.nativeDocumentId,
      expectedRevision: current.revision,
      requestId: crypto.randomUUID(),
      operation: { kind: 'discard' },
    });
    this.error = null;
    this.observe(snapshot);
  }
  history(direction: 'undo' | 'redo'): boolean {
    const allowed = direction === 'undo' ? this.snapshot?.canUndo : this.snapshot?.canRedo;
    if ((!allowed && !(direction === 'undo' && this.pending > 0)) || this.error) return false;
    void this.command({ kind: direction }).catch(() => {});
    return true;
  }
  private project(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.applying = true;
    try {
      for (const editor of this.editors) {
        if (editor.isDestroyed) continue;
        const changed =
          canonicalNotebookJson(editor.getJSON()) !== canonicalNotebookJson(snapshot.copy.content);
        if (changed) {
          const selection = editor.state.selection;
          editor.commands.setContent(snapshot.copy.content, { emitUpdate: false });
          const size = editor.state.doc.content.size;
          editor.commands.setTextSelection({
            from: Math.min(selection.from, size),
            to: Math.min(selection.to, size),
          });
        }
        editor.setEditable(!snapshot.readOnly && !snapshot.recovery && !this.error, false);
      }
      projectNotebookDocumentSnapshot(snapshot);
    } finally {
      this.applying = false;
    }
  }
  private offerRecovery(): void {
    const recovery = this.snapshot?.recovery;
    if (!recovery) return;
    useToastStore.getState().addRichToast({
      definition: 'unsaved-draft-recovery-available',
      message: recovery.baselineMismatch
        ? userMessage(
            'notice.a-retained-notebook-draft-and-its-package-changed-independently-both-r'
          )
        : userMessageWithValues('notice.unsaved-changes-to-value-were-recovered', {
            value0: userMessageValue(this.snapshot!.title),
          }),
      actions: recovery.baselineMismatch
        ? [
            {
              label: 'Keep package',
              onClick: () => this.command({ kind: 'discard' }).then(() => {}),
            },
          ]
        : [
            {
              label: 'Restore',
              onClick: () => this.command({ kind: 'restore-recovery' }).then(() => {}),
            },
            { label: 'Discard', onClick: () => this.command({ kind: 'discard' }).then(() => {}) },
          ],
    });
  }
  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    for (const editor of this.editors) if (!editor.isDestroyed) editor.setEditable(false, false);
    this.notify();
  }
}

export function nativeNotebookHistoryExtension(client: () => NativeNotebookDocumentClient | null) {
  return Extension.create({
    name: 'nativeNotebookHistory',
    priority: 10,
    addCommands() {
      return {
        undo:
          () =>
          ({ state, dispatch }) => {
            const current = client();
            return current
              ? dispatch
                ? current.history('undo')
                : Boolean(current.snapshot?.canUndo)
              : undoPM(state, dispatch);
          },
        redo:
          () =>
          ({ state, dispatch }) => {
            const current = client();
            return current
              ? dispatch
                ? current.history('redo')
                : Boolean(current.snapshot?.canRedo)
              : redoPM(state, dispatch);
          },
      };
    },
    addKeyboardShortcuts() {
      return {
        'Mod-z': () => client()?.history('undo') ?? false,
        'Mod-Shift-z': () => client()?.history('redo') ?? false,
        'Mod-y': () => client()?.history('redo') ?? false,
      };
    },
  });
}
