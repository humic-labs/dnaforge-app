import { z } from 'zod';
import type { DocumentWriteSettlement } from '@waypoint/api-client/models';
import type { DocumentCheckpointOutcome } from '@waypoint/domain-services';
import { annotationTargetDocumentRevision } from '../shared/annotation-target-document-revision';
import { SOFT_WARN_BYTES } from '../shared/oversized-guard';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import type {
  NativeAnnotationDocument,
  NativeAnnotationDocumentBarrier,
  NativeAnnotationDocumentCommandDependencies,
} from './managed-annotation-document-command';
import { canonicalWorkspacePath, sha256Bytes, sha256Text } from './primer-artifact-files';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import { readBlobBytesAtCommit, resolveHeadCommit } from './workspace-git';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identity = z.string().min(1).max(128);
const intentSchema = z
  .object({
    before_sha256: digest,
    after_sha256: digest,
    target_revision: z.string().min(1).max(512),
    selection_sha256: digest,
    selection_count: z.number().int().min(1).max(10_000),
  })
  .strict()
  .refine((intent) => intent.before_sha256 !== intent.after_sha256);

export const pendingNativeDocumentActionSchema = z
  .object({
    id: identity,
    operation_id: identity,
    operation_kind: z.string().min(1).max(128),
    action: z.literal('apply_to_document'),
    actor_kind: z.enum(['human', 'agent']),
    actor_id: z.string().min(1).max(256),
    channel: z.enum(['desktop_ui', 'managed_cli', 'agent']),
    recorded_at: z.number().finite().nonnegative(),
    outcome: z.enum(['document_admitted', 'document_writing', 'document_outcome_unresolved']),
    details_json: z
      .object({
        native_owner_instance_id: identity,
        target_document_id: z.string().min(1).max(1024),
        request_sha256: digest,
        write_intent: intentSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .refine(
    (action) =>
      (action.actor_kind === 'agent') === (action.channel === 'agent') &&
      (action.outcome === 'document_admitted') === (action.details_json.write_intent === undefined)
  );

export type PendingNativeDocumentAction = z.infer<typeof pendingNativeDocumentActionSchema>;

export interface NativeDocumentRecoveryDependencies {
  nativeOwnerInstanceId: string;
  resolve: NativeAnnotationDocumentCommandDependencies['resolve'];
  prepare: NativeAnnotationDocumentCommandDependencies['prepare'];
  observeCheckpoint(
    document: NativeAnnotationDocument,
    contentSha256: string
  ): Promise<DocumentCheckpointOutcome>;
  recordObservation(
    action: PendingNativeDocumentAction,
    settlement: DocumentWriteSettlement
  ): Promise<void>;
}

export interface NativeDocumentRecoveryOutcome {
  settlement: DocumentWriteSettlement;
  display?: 'refreshed' | 'not-required' | 'pending';
  displayError?: string;
}

export class NativeAnnotationDocumentRecovery {
  constructor(private readonly deps: NativeDocumentRecoveryDependencies) {}

  async recover(input: PendingNativeDocumentAction): Promise<NativeDocumentRecoveryOutcome> {
    const action = pendingNativeDocumentActionSchema.parse(input);
    if (action.operation_kind !== 'annotation') {
      throw new Error('This recovery adapter cannot interpret that operation kind.');
    }
    if (action.details_json.native_owner_instance_id === this.deps.nativeOwnerInstanceId) {
      throw new Error('Recovery cannot observe an action belonging to the current owner.');
    }
    const intent = action.details_json.write_intent;
    const target = {
      operationId: action.operation_id,
      targetDocumentId: action.details_json.target_document_id,
    };
    let release: (() => void) | undefined;
    let barrier: NativeAnnotationDocumentBarrier | undefined;
    let knownOriginal = false;
    const observe = async (): Promise<DocumentWriteSettlement> => {
      if (!intent)
        return {
          status: 'blocked',
          reason: 'The previous owner ended before recording permission to write.',
        };
      try {
        const document = { ...(await this.deps.resolve(target)) };
        if (document.documentId !== target.targetDocumentId)
          throw new Error('The native document identity changed.');
        release = await acquireWorkspaceSyncMutationLease(document.workspaceRoot);
        if (!sameDocument(document, await this.deps.resolve(target)))
          throw new Error('The document moved while recovery was waiting.');
        barrier = await this.deps.prepare(document);
        const bytes = await readDocument(document);
        const observedSha256 = `sha256:${await sha256Bytes(bytes)}`;
        if (observedSha256 === intent.before_sha256) {
          barrier.assertCurrent();
          knownOriginal = true;
          return {
            status: 'save-failed',
            observed_sha256: observedSha256,
            reason: 'Recovery observed the original file. The intended saved file is not present.',
          };
        }
        if (observedSha256 !== intent.after_sha256)
          return {
            status: 'outcome-unresolved',
            observed_sha256: observedSha256,
            reason: 'The current file matches neither the original nor the intended saved file.',
          };
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const sequence = parseSequenceFileAsDocument(text, document.sourcePath).sequence;
        sequence.id = document.documentId;
        const revision = await annotationTargetDocumentRevision(sequence);
        const additions = (sequence.annotations ?? []).filter((annotation) =>
          annotation.qualifiers?.dnaforge_action_id?.includes(action.id)
        );
        const selectedIds = additions.map((annotation) => {
          const qualifiers = annotation.qualifiers;
          if (
            qualifiers?.dnaforge_operation_id?.length !== 1 ||
            qualifiers.dnaforge_operation_id[0] !== action.operation_id ||
            qualifiers.dnaforge_candidate_id?.length !== 1 ||
            qualifiers.dnaforge_action_id?.length !== 1
          ) {
            throw new Error('The saved file has inconsistent action provenance.');
          }
          return qualifiers.dnaforge_candidate_id[0];
        });
        if (
          revision !== intent.target_revision ||
          additions.length !== intent.selection_count ||
          new Set(selectedIds).size !== selectedIds.length ||
          `sha256:${await sha256Text(JSON.stringify(selectedIds.sort()))}` !==
            intent.selection_sha256
        ) {
          throw new Error(
            'The saved file does not match the recorded revision and candidate selection.'
          );
        }
        let checkpoint: DocumentCheckpointOutcome;
        try {
          checkpoint = await this.deps.observeCheckpoint(document, observedSha256);
        } catch (error) {
          checkpoint = { status: 'failed', reason: reason(error) };
        }
        if (
          !sameDocument(document, await this.deps.resolve(target)) ||
          `sha256:${await sha256Bytes(await readDocument(document))}` !== observedSha256
        ) {
          throw new Error('The document changed while its recovery evidence was being inspected.');
        }
        barrier.assertCurrent();
        return {
          status: 'saved',
          observed_sha256: observedSha256,
          target_revision: revision,
          checkpoint,
        };
      } catch (error) {
        return { status: 'outcome-unresolved', reason: reason(error) };
      }
    };
    try {
      const settlement = await observe();
      await this.deps.recordObservation(action, settlement);
      if (settlement.status === 'saved' && barrier) {
        try {
          const display = await barrier.finish();
          barrier = undefined;
          return { settlement, display };
        } catch (error) {
          return { settlement, display: 'pending', displayError: reason(error) };
        }
      }
      return { settlement };
    } finally {
      try {
        barrier?.abort(knownOriginal ? 'unchanged' : 'needs-recovery');
      } finally {
        release?.();
      }
    }
  }
}

export async function observeNativeDocumentCheckpoint(
  document: NativeAnnotationDocument,
  contentSha256: string
): Promise<DocumentCheckpointOutcome> {
  const canonical = await canonicalWorkspacePath({
    workspaceRoot: document.workspaceRoot,
    path: document.sourcePath,
    artifactNoun: 'sequence document',
  });
  const commit = await resolveHeadCommit(canonical.root);
  if (!commit) return { status: 'failed', reason: 'Recovery found no existing Git checkpoint.' };
  const bytes = await readBlobBytesAtCommit(canonical.root, commit, canonical.candidate);
  if (`sha256:${await sha256Bytes(bytes)}` !== contentSha256)
    return {
      status: 'failed',
      reason: 'The current Git checkpoint does not contain the observed saved file.',
    };
  return { status: 'committed', commit };
}

async function readDocument(document: NativeAnnotationDocument): Promise<Uint8Array> {
  const canonical = await canonicalWorkspacePath({
    workspaceRoot: document.workspaceRoot,
    path: document.sourcePath,
    artifactNoun: 'sequence document',
  });
  return readFileBoundedFromHandle(canonical.candidate, SOFT_WARN_BYTES - 1);
}

function sameDocument(first: NativeAnnotationDocument, second: NativeAnnotationDocument): boolean {
  return (
    first.documentId === second.documentId &&
    first.workspaceRoot === second.workspaceRoot &&
    first.sourcePath === second.sourcePath
  );
}

function reason(error: unknown): string {
  return (
    (error instanceof Error
      ? error.message
      : 'Native document recovery could not establish the file outcome.'
    ).slice(0, 2048) || 'Document recovery failed.'
  );
}
