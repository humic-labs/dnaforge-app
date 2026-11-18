import type { NativeWorkTaskFile } from './work-task-preparation';
import type Database from 'better-sqlite3';
import type {
  ScientificSubmissionReceipt,
  ScientificWorkspaceSubmitResult,
  ScientificAcceptedDocumentRevision,
} from '@waypoint/domain-services';
import {
  defineBlob,
  parseResourceId,
  parseWorkspaceVersionId,
  type ApplyMutationResult,
  type Result,
} from '@waypoint/workspace-revisions';
import { createScientificReader } from '@waypoint/scientific-objects';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { submitScientificWorkspace } from './scientific-workspace-service';

import { scientificCopyResourceId } from './scientific-resource-operations';
import type { DesktopScientificWorkspaceRequest } from '../shared/scientific-objects-ipc';
import type { DesktopScientificWorkspaceSubmitRequest } from '../shared/scientific-objects-ipc';
const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok)
    throw new TypeError(`Invalid scientific identity: ${JSON.stringify(result.error)}`);
  return result.value;
};
export function resolveScientificWorkspace(
  db: Database.Database,
  input: DesktopScientificWorkspaceRequest
): number {
  const row = db
    .prepare(
      'SELECT id, repo_uuid FROM workspaces WHERE path = ? AND archived_at IS NULL AND trashed_at IS NULL'
    )
    .get(input.workspaceRoot) as { id: number; repo_uuid: string | null } | undefined;
  if (!row || workspaceScopeKey(row.repo_uuid, row.id) !== input.request.workspace)
    throw new Error('Scientific request does not match its active owning workspace.');
  return row.id;
}
export function scientificSubmissionReceipt(
  result: ApplyMutationResult
): ScientificSubmissionReceipt {
  const outcome = result.kind === 'replay' ? result.original : result;
  const kind = 'outcome' in outcome ? outcome.outcome : outcome.kind;
  if (kind === 'changed' && 'version' in outcome)
    return { outcome: 'changed', version: outcome.version.id };
  if (kind === 'no-op' && 'head' in outcome) return { outcome: 'no-op', head: outcome.head };
  if (kind === 'conflict' && 'conflicts' in outcome)
    return { outcome: 'conflict', conflicts: outcome.conflicts };
  if (
    kind === 'rejected' &&
    'error' in outcome &&
    (outcome.error.kind === 'invalid-mutation' || outcome.error.kind === 'operation-id-reused')
  )
    return { outcome: 'rejected', error: outcome.error };
  throw new Error('Scientific batch produced an unsupported outcome.');
}
export async function submitScientificObjectInMain(
  db: Database.Database,
  input: DesktopScientificWorkspaceSubmitRequest,
  options: {
    renderer?: { ownerId: number; mutationToken?: string };
    mutationLease?: () => void;
    databaseFence?: () => void;
    beforeAccept?: () => void;
    workTaskCommand?: boolean;
    workTaskSuccessor?: NativeWorkTaskFile;
  } = {}
): Promise<ScientificWorkspaceSubmitResult> {
  if (db.inTransaction)
    throw new Error('Scientific workspace commands cannot enter an open database transaction.');
  const workspaceId = resolveScientificWorkspace(db, input);
  const assemblyProduct =
    input.request.source.kind === 'accepted-assembly'
      ? input.request.source.assembly.product
      : null;
  const nativeResourceId =
    input.request.source.kind === 'native-artifact'
      ? must(parseResourceId(input.request.source.entry.resourceId))
      : input.request.source.kind === 'accepted-assembly' &&
          assemblyProduct?.kind === 'submitted' &&
          input.request.source.entries.some(
            (entry) =>
              entry.resourceId === assemblyProduct.resourceId && entry.representation !== undefined
          )
        ? must(parseResourceId(assemblyProduct.resourceId))
        : null;
  const result = await submitScientificWorkspace({
    db,
    workspaceId,
    request: input.request,
    ...(options.workTaskCommand
      ? { workTaskCommand: true, workTaskSuccessor: options.workTaskSuccessor }
      : {}),
    ...(options.renderer ? { renderer: options.renderer } : {}),
    ...(options.mutationLease ? { mutationLease: options.mutationLease } : {}),
    ...(options.databaseFence ? { databaseFence: options.databaseFence } : {}),
    ...(options.beforeAccept ? { beforeAccept: options.beforeAccept } : {}),
  });
  const receipt = scientificSubmissionReceipt(result.acceptance);
  const acceptedHead =
    receipt.outcome === 'changed'
      ? receipt.version
      : receipt.outcome === 'no-op'
        ? receipt.head
        : null;
  let accepted: ScientificAcceptedDocumentRevision | undefined;
  if (nativeResourceId && acceptedHead) {
    const store = new ScientificObjectStore(db, workspaceId);
    const { graph } = store.read();
    const snapshot = createScientificReader({
      graph,
      head: must(parseWorkspaceVersionId(acceptedHead)),
      readBlob: (blob) => store.readBlob(blob),
      codecs: scientificNativeCodecs,
    }).current(nativeResourceId);
    if (!snapshot?.representation) throw new Error('Accepted native publication is unavailable.');
    accepted = {
      kind: 'accepted-object',
      resourceId: nativeResourceId,
      resourceRevisionId: snapshot.revisionId,
      workspaceVersionId: acceptedHead,
      contentSha256: defineBlob(new TextEncoder().encode(snapshot.representation.text)).hash.slice(
        'sha256:'.length
      ),
      sequenceEditParentEventId: null,
    };
  }
  return {
    operationId: input.request.operationId,
    replayed: result.acceptance.kind === 'replay',
    currentHead: result.currentHead,
    receipt,
    ...(accepted ? { accepted } : {}),
    ...(accepted && (result.acceptance.kind === 'changed' || result.acceptance.kind === 'no-op')
      ? { nativeProjectionComplete: true }
      : {}),
    ...(acceptedHead && input.request.source.kind === 'copy'
      ? {
          createdResourceId: scientificCopyResourceId(
            input.request.operationId,
            input.request.source.resourceId
          ),
        }
      : {}),
    delivery:
      result.delivery === null
        ? null
        : result.delivery.kind === 'complete'
          ? { kind: 'complete' }
          : {
              kind: 'blocked',
              versionId: result.delivery.versionId,
              error: result.delivery.error,
            },
  };
}
