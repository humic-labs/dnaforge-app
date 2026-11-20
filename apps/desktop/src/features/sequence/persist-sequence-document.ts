import type { EditorPendingPrimerBinding } from '@waypoint/workspace-editor';
import { getSequenceSavePolicy } from '@waypoint/sequence-utils';
import { UserMessageError } from '@waypoint/user-messages';

import {
  beginWorkspaceEditorWrite,
  freezeWorkspaceEditorWrites,
} from '../../services/workspace-editor-mutation-state';
import { sequencePackageMetaPaths } from '../../db/sequence-package';
import type { ResolvedSequenceDocument } from './sequence-document-repository';
import { useSequenceStore, type SequenceSaveCapture } from './store';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { reconcileWorkspaceAfterFilesChanged } from '../../services/workspace-operations';
import { isGitRepo, gitStatus, gitCommitPaths } from '../workspace/public/git';
import { parseWorkspacePath } from '@waypoint/workspace-revisions';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import type { SequenceDocumentSavePublication } from '../../shared/sequence-edit-lineage';
import { beginWorkflowAction, workflowCountBucket } from '../../lib/workflow-telemetry';
import { getNativeSequenceDocumentClient } from './sequence-document-client';

const MAX_SAVE_ATTEMPTS = 3;

export type PersistableSequenceDocument = Pick<
  ResolvedSequenceDocument,
  'documentId' | 'sourcePath'
>;

export type SequencePersistenceErrorCode =
  | 'cancelled'
  | 'write_failed'
  | 'write_receipt_failed'
  | 'completion_failed'
  | 'primer_bindings_failed'
  | 'racing_edits'
  | 'accepted_pending'
  | 'required_save_not_completed';

export class SequencePersistenceError extends Error {
  readonly code: SequencePersistenceErrorCode;
  readonly cause: unknown;

  constructor(code: SequencePersistenceErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'SequencePersistenceError';
    this.code = code;
    this.cause = cause;
  }
}

export class SequenceSaveCombinedError extends Error {
  readonly errors: readonly [unknown, unknown];
  readonly cause: unknown;

  constructor(errors: [unknown, unknown], message: string) {
    super(message);
    this.name = 'SequenceSaveCombinedError';
    this.errors = errors;
    this.cause = errors[0];
  }
}

export type SequencePersistenceWrite =
  | { wrote: false }
  | { wrote: true; writtenRevision: SequenceSaveCapture['revision'] };

export type SequencePersistenceResult =
  | {
      ok: true;
      outcome: 'unchanged';
      attempts: number;
      wrote: false;
    }
  | {
      ok: true;
      outcome: 'saved';
      attempts: number;
      wrote: true;
      writtenRevision: SequenceSaveCapture['revision'];
      copyDestination?: { filePath: string; releasedSourceRevision: number };
    }
  | ({
      ok: false;
      outcome: 'failed';
      attempts: number;
      error: SequencePersistenceError;
    } & SequencePersistenceWrite);

export interface PersistSequenceDocumentOptions {
  document: PersistableSequenceDocument;
  requiredCapture?: SequenceSaveCapture;
  readOnly?: boolean;
  beforeWrite?: () => void;
  commitMessage?: string;
  onPersisted?: (publication?: SequenceDocumentSavePublication) => void | Promise<void>;
  persistPendingPrimerBindings?: (
    bindings: EditorPendingPrimerBinding[],
    context: { draftLineageId: string; expectedFileSha256: string }
  ) => Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function failed(
  code: SequencePersistenceErrorCode,
  error: unknown,
  {
    attempts,
    write,
    fallback,
  }: {
    attempts: number;
    write: SequencePersistenceWrite;
    fallback: string;
  }
): SequencePersistenceResult {
  return {
    ok: false,
    outcome: 'failed',
    attempts,
    ...write,
    error: new SequencePersistenceError(code, errorMessage(error, fallback), error),
  };
}

export async function persistSequenceDocument({
  document,
  requiredCapture,
  readOnly = false,
  beforeWrite,
  commitMessage,
  onPersisted,
  persistPendingPrimerBindings,
}: PersistSequenceDocumentOptions): Promise<SequencePersistenceResult> {
  const { documentId, sourcePath } = document;
  if (!sourcePath) {
    if (requiredCapture || useSequenceStore.getState().isDirty(documentId)) {
      return failed(
        'required_save_not_completed',
        new Error('The required sequence revision has no writable source path.'),
        {
          attempts: 0,
          write: { wrote: false },
          fallback: 'The required sequence revision has no writable source path.',
        }
      );
    }
    return { ok: true, outcome: 'unchanged', attempts: 0, wrote: false };
  }
  if (readOnly) {
    if (requiredCapture) {
      return failed(
        'required_save_not_completed',
        new Error('The required sequence revision belongs to a read-only document.'),
        {
          attempts: 0,
          write: { wrote: false },
          fallback: 'The required sequence revision belongs to a read-only document.',
        }
      );
    }
    return { ok: true, outcome: 'unchanged', attempts: 0, wrote: false };
  }

  const store = useSequenceStore.getState();
  if (!requiredCapture && !store.dirtyPaths[documentId]) {
    return { ok: true, outcome: 'unchanged', attempts: 0, wrote: false };
  }
  const initialCapture = requiredCapture ?? store.captureForSave(documentId);
  if (!initialCapture) {
    return { ok: true, outcome: 'unchanged', attempts: 0, wrote: false };
  }

  const policy = getSequenceSavePolicy(initialCapture.sequence, sourcePath).capabilities;
  if (policy.editable && policy.canExportGenBank && !policy.canSaveInPlace) {
    const { saveEditedSequenceCopy } = await import('./save-edited-sequence-copy');
    return saveEditedSequenceCopy(document, initialCapture);
  }

  const operation = beginWorkflowAction({ workflow: 'sequence_edit', action: 'save' });
  const native = getNativeSequenceDocumentClient();
  const result = native
    ? await writeNativeSequenceCapture({
        documentId,
        capture: initialCapture,
        requiredCapture,
        beforeWrite,
        commitMessage,
        onPersisted,
      })
    : await writeSequenceCapture({
        documentId,
        sourcePath,
        requiredCapture,
        capture: initialCapture,
        beforeWrite,
        commitMessage,
        onPersisted,
        persistPendingPrimerBindings,
      });
  const edits = {
    basesInsertedBucket: workflowCountBucket(rangeLength(initialCapture.insertedRanges)),
    basesDeletedBucket: workflowCountBucket(rangeLength(initialCapture.deletedRanges)),
    basesSubstitutedBucket: workflowCountBucket(rangeLength(initialCapture.substitutedRanges)),
    saveAttemptCount: result.attempts,
  };
  if (result.ok) operation.complete({ ...edits, status: 'saved' });
  else operation.fail(result.error.code, { ...edits, status: 'failed' });
  return result;
}

async function writeNativeSequenceCapture({
  documentId,
  capture: initial,
  requiredCapture,
  beforeWrite,
  commitMessage,
  onPersisted,
}: Pick<
  PersistSequenceDocumentOptions,
  'requiredCapture' | 'beforeWrite' | 'commitMessage' | 'onPersisted'
> & {
  documentId: string;
  capture: SequenceSaveCapture;
}): Promise<SequencePersistenceResult> {
  const native = getNativeSequenceDocumentClient();
  if (!native) throw new Error('The native sequence client is not installed.');
  let capture = initial,
    fromCaptureId: string | undefined,
    completedPublication: SequenceDocumentSavePublication | undefined,
    write: SequencePersistenceWrite = { wrote: false },
    attempts = 0;
  type Completion = { ok: true } | { ok: false; error: unknown };
  let completion: Promise<Completion> | undefined;
  const completeOnce = (): Promise<Completion> => {
    completion ??= (async (): Promise<Completion> => {
      try {
        await onPersisted?.(completedPublication);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    })();
    return completion;
  };
  try {
    for (attempts = 1; attempts <= MAX_SAVE_ATTEMPTS; attempts++) {
      const snapshot = await native.save(documentId, {
        capture,
        message: commitMessage,
        beforeWrite: attempts === 1 ? beforeWrite : undefined,
        ...(fromCaptureId ? { fromCaptureId } : {}),
      });
      if (snapshot.saveResult?.status === 'accepted-pending') {
        const { reason, superseded } = snapshot.saveResult;
        return failed(
          'accepted_pending',
          new UserMessageError(
            superseded ? 'document.sequenceSaveSuperseded' : 'document.sequenceSaveDeliveryPending',
            { cause: new Error(reason) }
          ),
          { attempts, write, fallback: 'The accepted sequence Save is incomplete.' }
        );
      }
      if (snapshot.saved === true) {
        write = { wrote: true, writtenRevision: capture.revision };
        if (snapshot.verificationFailed)
          return failed(
            'write_receipt_failed',
            new Error('The written sequence could not be verified.'),
            { attempts, write, fallback: 'The written sequence could not be verified.' }
          );
        if (snapshot.primerBindingFailure)
          return failed(
            'primer_bindings_failed',
            new Error(snapshot.primerBindingFailure.message),
            {
              attempts,
              write,
              fallback: 'The saved sequence could not retain its copied primer relationships.',
            }
          );
        const receipt =
          snapshot.saveResult?.status === 'saved' ? snapshot.saveResult.writeReceipt : undefined;
        completedPublication = snapshot.history
          ? {
              kind: 'native-capture',
              repositoryRoot: snapshot.workspaceRoot,
              ...(receipt
                ? {
                    history: {
                      receipt,
                      result: {
                        status:
                          snapshot.history.historyStatus ??
                          (snapshot.history.status === 'committed'
                            ? 'committed'
                            : snapshot.history.status === 'unchanged'
                              ? 'already-committed'
                              : 'failed'),
                        nativeActionId: snapshot.history.nativeActionId ?? receipt.nativeActionId,
                      },
                    },
                  }
                : {}),
            }
          : undefined;
      }
      if (snapshot.history?.status === 'failed' && !completedPublication?.history)
        return failed(
          'completion_failed',
          new Error('The saved sequence has no native History receipt.'),
          {
            attempts,
            write,
            fallback: 'History recovery requires the acknowledged native receipt.',
          }
        );
      if (snapshot.history?.status === 'failed' && snapshot.dirty) {
        const completed = await completeOnce();
        return failed(
          'racing_edits',
          completed.ok ? new Error('Newer edits remain in the native draft.') : completed.error,
          {
            attempts,
            write,
            fallback: 'The acknowledged sequence is saved; newer edits remain dirty.',
          }
        );
      }
      if (!snapshot.dirty) {
        if (requiredCapture && !write.wrote)
          return failed(
            'required_save_not_completed',
            new Error('The required capture did not produce a native write.'),
            { attempts, write, fallback: 'The required capture did not produce a native write.' }
          );
        if (write.wrote) {
          const completed = await completeOnce();
          if (!completed.ok)
            return failed('completion_failed', completed.error, {
              attempts,
              write,
              fallback: 'The saved sequence could not finish its post-save completion.',
            });
        }
        return write.wrote
          ? { ok: true, outcome: 'saved', attempts, ...write }
          : { ok: true, outcome: 'unchanged', attempts, wrote: false };
      }
      const latest = useSequenceStore.getState().captureForSave(documentId);
      if (!latest) break;
      fromCaptureId =
        snapshot.saved === true && latest.revision === snapshot.version
          ? snapshot.captureId
          : undefined;
      capture = latest;
    }
    const racing = new Error('Newer edits remain in the native draft.');
    const completed = write.wrote ? await completeOnce() : { ok: true as const };
    return failed(
      'racing_edits',
      completed.ok
        ? racing
        : new SequenceSaveCombinedError(
            [racing, completed.error],
            'Racing edits and completion failed.'
          ),
      {
        attempts: Math.min(attempts, MAX_SAVE_ATTEMPTS),
        write,
        fallback: 'Newer edits remain in the native draft.',
      }
    );
  } catch (error) {
    const completed = write.wrote ? await completeOnce() : { ok: true as const };
    return failed(
      'write_failed',
      completed.ok
        ? error
        : new SequenceSaveCombinedError(
            [error, completed.error],
            'Native Save and completion failed.'
          ),
      {
        attempts,
        write,
        fallback: 'The native sequence could not be saved.',
      }
    );
  }
}

function rangeLength(ranges: readonly { start: number; end: number }[]): number {
  return ranges.reduce((total, range) => total + Math.max(0, range.end - range.start), 0);
}

async function writeSequenceCapture({
  documentId,
  sourcePath,
  requiredCapture,
  capture: firstCapture,
  beforeWrite,
  commitMessage,
  onPersisted,
  persistPendingPrimerBindings,
}: {
  documentId: string;
  sourcePath: string;
  requiredCapture?: SequenceSaveCapture;
  capture: SequenceSaveCapture;
  beforeWrite?: () => void;
  commitMessage?: string;
  onPersisted?: (publication?: SequenceDocumentSavePublication) => void | Promise<void>;
  persistPendingPrimerBindings?: PersistSequenceDocumentOptions['persistPendingPrimerBindings'];
}): Promise<SequencePersistenceResult> {
  let capture = firstCapture;
  let attempts = 0;
  let completedPublication: SequenceDocumentSavePublication | undefined;
  let write: SequencePersistenceWrite = { wrote: false };
  let canPublishWrite = false;
  type Notification = { ok: true } | { ok: false; error: unknown };
  let notification: Promise<Notification> | undefined;
  const notifyPersisted = (): Promise<Notification> => {
    notification ??= (async (): Promise<Notification> => {
      try {
        await onPersisted?.(completedPublication);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    })();
    return notification;
  };
  let finishWrite: (() => void) | undefined;
  let finishFirstStampFreeze: (() => void) | undefined;

  try {
    finishWrite = beginWorkspaceEditorWrite({ entityId: documentId, path: sourcePath });
    const { serializeSequenceForInPlaceSave, computeChecksum } =
      await import('@waypoint/sequence-utils');
    const { platform } = await import('../../platform');
    const fs = platform().fs;
    const packageRoot = sourcePath.replace(/[/\\][^/\\]+$/u, '');
    const needsFirstStamp = capture.sequence.annotations.some(
      (annotation) => !annotation.qualifiers?.dnaforge_ann_id?.[0]
    );
    const firstManagedStamp =
      needsFirstStamp &&
      packageRoot !== sourcePath &&
      (
        await Promise.all(sequencePackageMetaPaths(packageRoot).map((path) => fs.exists(path)))
      ).some(Boolean);
    if (firstManagedStamp) {
      finishFirstStampFreeze = freezeWorkspaceEditorWrites({
        workspaceRoot: sourcePath,
        affectedEntityIds: [documentId],
      });
      const latest = useSequenceStore.getState().captureForSave(documentId);
      if (!latest || (requiredCapture && latest.revision !== requiredCapture.revision)) {
        return failed(
          'required_save_not_completed',
          new Error('The sequence changed before its managed annotation IDs could be saved.'),
          {
            attempts: 0,
            write: { wrote: false },
            fallback: 'The managed annotation save capture changed.',
          }
        );
      }
      capture = requiredCapture ?? latest;
    }

    for (attempts = 1; attempts <= MAX_SAVE_ATTEMPTS; attempts += 1) {
      const attemptCapture = capture;
      beforeWrite?.();
      const workspaceRoot = capture.accepted
        ? findWorkspaceRootForPath(useWorkspaceStore.getState().folders, sourcePath)
        : null;
      if (capture.accepted && !workspaceRoot)
        throw new Error('The accepted sequence project must be mounted before saving.');
      const nativeSave = await withRendererWorkspaceMutation(
        workspaceRoot,
        async (mutationToken) => {
          const isGit = workspaceRoot ? await isGitRepo(workspaceRoot, mutationToken) : false;
          const dirtyBefore =
            isGit && workspaceRoot
              ? await gitStatus(workspaceRoot, mutationToken)
              : new Map<string, unknown>();
          const saved = await platform().fs.saveSequenceDocument({
            documentId,
            sourcePath,
            ...(mutationToken ? { mutationToken } : {}),
            ...(attemptCapture.accepted ? { accepted: attemptCapture.accepted } : {}),
            capture: {
              sequence: attemptCapture.sequence,
              draftBaseline: attemptCapture.draftBaseline,
              draftSequence: attemptCapture.draftSequence,
              insertedRanges: attemptCapture.insertedRanges,
              deletedRanges: attemptCapture.deletedRanges,
              substitutedRanges: attemptCapture.substitutedRanges,
              draftLineageId: attemptCapture.draftLineageId,
            },
          });
          if (
            attemptCapture.accepted &&
            (saved.status === 'unbound' ||
              (saved.status === 'saved' && (!saved.accepted || !saved.eventId)))
          )
            throw new Error(
              'The accepted sequence document is unavailable. Reopen it before saving.'
            );
          if (saved.status === 'saved' && saved.accepted && workspaceRoot && saved.eventId) {
            try {
              await reconcileWorkspaceAfterFilesChanged({
                workspaceRoot,
                mutationToken,
                strict: true,
                assertCurrent: () => {
                  if (
                    findWorkspaceRootForPath(useWorkspaceStore.getState().folders, sourcePath) !==
                    workspaceRoot
                  )
                    throw new Error('The accepted sequence project was closed during its refresh.');
                },
              });
              const productPath = pathRelativeToBoundary(sourcePath, workspaceRoot);
              if (
                !productPath ||
                !saved.publicationPaths?.includes(productPath) ||
                saved.publicationPaths.some((path) => !parseWorkspacePath(path).ok)
              )
                throw new Error(
                  'The accepted sequence Save did not return its complete publication paths.'
                );
              let history: SequenceDocumentSavePublication['history'];
              if (isGit) {
                const dirtyAfter = await gitStatus(workspaceRoot, mutationToken);
                const owned = [
                  ...saved.publicationPaths,
                  ...[...dirtyAfter.keys()].filter(
                    (path) => path.startsWith('.waypoint/lims/') && !dirtyBefore.has(path)
                  ),
                ];
                const dirty = [...new Set(owned)].filter((path) => dirtyAfter.has(path));
                try {
                  if (dirty.length > 0)
                    await gitCommitPaths(
                      workspaceRoot,
                      commitMessage ?? `Save sequence ${attemptCapture.sequence.name}`,
                      dirty,
                      mutationToken
                    );
                  if (saved.writeReceipt)
                    history = {
                      receipt: saved.writeReceipt,
                      result: {
                        status: 'committed',
                        nativeActionId: saved.writeReceipt.nativeActionId,
                      },
                    };
                } catch (error) {
                  if (!saved.writeReceipt) throw error;
                  history = {
                    receipt: saved.writeReceipt,
                    result: { status: 'failed', nativeActionId: saved.writeReceipt.nativeActionId },
                  };
                }
              }
              if (
                findWorkspaceRootForPath(useWorkspaceStore.getState().folders, sourcePath) !==
                workspaceRoot
              )
                throw new Error('The accepted sequence project was closed during its publication.');
              completedPublication = {
                kind: 'accepted-object',
                repositoryRoot: isGit ? workspaceRoot : null,
                ...(history
                  ? { history }
                  : saved.writeReceipt
                    ? {
                        history: {
                          receipt: saved.writeReceipt,
                          result: {
                            status: 'not-a-repository' as const,
                            nativeActionId: saved.writeReceipt.nativeActionId,
                          },
                        },
                      }
                    : {}),
              };
            } catch (error) {
              return {
                status: 'accepted-pending' as const,
                accepted: saved.accepted,
                eventId: saved.eventId,
                lineage: 'recorded' as const,
                reason: `Save accepted; required publication remains incomplete: ${errorMessage(error, 'publication unavailable')}`,
              };
            }
          }
          return saved;
        }
      );
      if (nativeSave.status === 'accepted-pending') {
        return failed('accepted_pending', new Error(nativeSave.reason), {
          attempts,
          write: { wrote: true, writtenRevision: attemptCapture.revision },
          fallback: 'Save accepted; delivery remains pending.',
        });
      }
      let expectedFileSha256: string;
      if (nativeSave.status === 'unbound') {
        const serialized = serializeSequenceForInPlaceSave(capture.sequence, sourcePath);
        await platform().fs.writeTextFile(sourcePath, serialized);
        write = { wrote: true, writtenRevision: capture.revision };
        canPublishWrite = false;
        expectedFileSha256 = await computeChecksum(serialized);
      } else {
        write = { wrote: true, writtenRevision: capture.revision };
        expectedFileSha256 = nativeSave.fileSha256;
      }
      canPublishWrite = true;

      if (capture.pendingPrimerBindings.length > 0 || persistPendingPrimerBindings) {
        try {
          if (!persistPendingPrimerBindings) {
            throw new Error('This sequence surface cannot persist copied primer bindings.');
          }
          await persistPendingPrimerBindings(capture.pendingPrimerBindings, {
            draftLineageId: capture.draftLineageId,
            expectedFileSha256,
          });
        } catch (error) {
          return failed('primer_bindings_failed', error, {
            attempts,
            write,
            fallback: 'Copied primer bindings were not attached.',
          });
        }
      }

      const { settled } = useSequenceStore
        .getState()
        .acknowledgeSaved(
          documentId,
          capture,
          nativeSave.status === 'saved' ? nativeSave.managedAnnotationIds : undefined,
          nativeSave.status === 'saved' ? nativeSave.accepted : undefined
        );
      if (settled) {
        const published = await notifyPersisted();
        if (!published.ok) {
          return failed('completion_failed', published.error, {
            attempts,
            write,
            fallback: 'The saved sequence could not finish its post-save completion.',
          });
        }
        return {
          ok: true,
          outcome: 'saved',
          attempts,
          wrote: true,
          writtenRevision: capture.revision,
        };
      }

      const latestState = useSequenceStore.getState();
      const nextCapture = latestState.captureForSave(documentId);
      if (!latestState.dirtyPaths[documentId] || !nextCapture) {
        const published = await notifyPersisted();
        if (!latestState.dirtyPaths[documentId]) {
          if (requiredCapture) {
            const error = new Error(
              'The required sequence revision was written but not acknowledged.'
            );
            return failed(
              'required_save_not_completed',
              published.ok
                ? error
                : new SequenceSaveCombinedError(
                    [error, published.error],
                    'Required save and completion failed.'
                  ),
              {
                attempts,
                write,
                fallback: 'The required sequence revision was written but not acknowledged.',
              }
            );
          }
          if (!published.ok) {
            return failed('completion_failed', published.error, {
              attempts,
              write,
              fallback: 'The saved sequence could not finish its post-save completion.',
            });
          }
          return {
            ok: true,
            outcome: 'saved',
            attempts,
            wrote: true,
            writtenRevision: capture.revision,
          };
        }
        const error = new Error('Newer edits remain unsaved.');
        return failed(
          'racing_edits',
          published.ok
            ? error
            : new SequenceSaveCombinedError(
                [error, published.error],
                'Racing edits and completion failed.'
              ),
          {
            attempts,
            write,
            fallback: 'Newer edits remain unsaved.',
          }
        );
      }
      capture = nextCapture;
    }

    attempts = MAX_SAVE_ATTEMPTS;
    const published = await notifyPersisted();
    const error = new Error('Newer edits raced every save attempt.');
    return failed(
      'racing_edits',
      published.ok
        ? error
        : new SequenceSaveCombinedError(
            [error, published.error],
            'Racing edits and completion failed.'
          ),
      {
        attempts,
        write,
        fallback: 'Newer edits raced every save attempt.',
      }
    );
  } catch (error) {
    const published: Notification = canPublishWrite ? await notifyPersisted() : { ok: true };
    return failed(
      write.wrote && !canPublishWrite ? 'write_receipt_failed' : 'write_failed',
      published.ok
        ? error
        : new SequenceSaveCombinedError(
            [error, published.error],
            'Sequence write and completion failed.'
          ),
      {
        attempts,
        write,
        fallback: 'The sequence could not be written.',
      }
    );
  } finally {
    finishFirstStampFreeze?.();
    finishWrite?.();
  }
}
