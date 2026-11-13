import type Database from 'better-sqlite3';
import { sequenceSavePrimerPublicationSlots } from './sequence-save-primer-publications';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import {
  inspectResourceRevision,
  inspectResourceState,
  inspectWorkspaceVersion,
  listWorkspaceResources,
  parseWorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';
import { parseNativeJson, nativeRecord } from './scientific-native-json';
import git from 'isomorphic-git';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
} from '../db/sequence-package';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import type {
  SequenceDocumentHistoryInput,
  SequenceDocumentHistoryResult,
} from '../shared/sequence-edit-lineage';
import { WORKSPACE_GIT_AUTHOR } from '../shared/workspace-git-author';
import { SOFT_WARN_BYTES } from '../shared/oversized-guard';
import type { NativeAnnotationDocument } from './managed-annotation-document-command';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { readSequenceEditTransitions } from './sequence-edit-lineage';
import {
  acquireWorkspaceMutationShared,
  assertWorkspaceMutationLease,
} from './workspace-sync-mutation-lease';
import { withDeclaredRendererWorkspaceMutation } from './ipc/workspace-mutation-authority';
import { assertNativeSequenceContentWritable } from './native-sequence-content-access';
import {
  commitOwnedPathsIfDirty,
  flushManagedCommitDurably,
  resolveHeadCommit,
  withManagedWorkspaceMutationLock,
} from './workspace-git';

interface Dependencies {
  db: Database.Database;
  resolve(documentId: string): Promise<NativeAnnotationDocument>;
  assertCurrent?(): void;
  commit?: typeof commitOwnedPathsIfDirty;
  mutationLease?: () => void;
  renderer?: { ownerId: number; mutationToken?: string };
}

export async function commitSequenceDocumentHistory(
  input: SequenceDocumentHistoryInput,
  dependencies: Dependencies
): Promise<SequenceDocumentHistoryResult> {
  const nativeActionId = randomUUID();
  const result = (
    status: SequenceDocumentHistoryResult['status']
  ): SequenceDocumentHistoryResult => ({ status, nativeActionId });
  if (
    !input ||
    typeof input.documentId !== 'string' ||
    !input.documentId ||
    input.documentId.length > 256 ||
    typeof input.sourcePath !== 'string' ||
    typeof input.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.contentSha256) ||
    typeof input.message !== 'string' ||
    !input.message.trim() ||
    input.message.length > 512 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      input.nativeActionId
    ) ||
    typeof input.wrote !== 'boolean' ||
    (input.primerPublicationIds !== undefined && !input.accepted) ||
    (input.revisionId !== null &&
      (typeof input.revisionId !== 'string' || input.revisionId.length > 256))
  )
    return result('unavailable');
  if (!input.revisionId) return result('unavailable');
  let release: (() => void) | undefined;
  try {
    dependencies.assertCurrent?.();
    const document = await dependencies.resolve(input.documentId);
    if (document.documentId !== input.documentId) return result('revision-changed');
    assertNativeSequenceContentWritable(dependencies.db, input.documentId, document.workspaceRoot);
    const bound = await canonicalWorkspacePath({
      workspaceRoot: document.workspaceRoot,
      path: document.sourcePath,
      artifactNoun: 'sequence document',
    });
    const requested = await canonicalWorkspacePath({
      workspaceRoot: document.workspaceRoot,
      path: input.sourcePath,
      artifactNoun: 'sequence document',
    });
    if (bound.candidate !== requested.candidate) return result('revision-changed');
    const checkpoint = () =>
      withManagedWorkspaceMutationLock(bound.root, async () => {
        const head = await resolveHeadCommit(bound.root);
        if (!head) return result('not-a-repository');
        const product = await readFileBoundedFromHandle(bound.candidate, SOFT_WARN_BYTES - 1);
        if (sha256(product) !== input.contentSha256) return result('revision-changed');
        const acceptedPaths = input.accepted
          ? acceptedHistoryPaths(input, dependencies.db, bound.root, bound.candidate)
          : undefined;
        if (input.accepted && !acceptedPaths) return result('revision-changed');
        const paths = acceptedPaths ? [...acceptedPaths.keys()] : [bound.candidate];
        const capturedHashes =
          acceptedPaths ?? new Map<string, string | null>([[bound.candidate, input.contentSha256]]);
        const packageRoot = dirname(bound.candidate);
        const markerPath = sequencePackagePaths(packageRoot).metaPath;
        if (!acceptedPaths && fs.existsSync(markerPath)) {
          const markerBytes = await readFileBoundedFromHandle(markerPath, 4 * 1024 * 1024);
          capturedHashes.set(markerPath, sha256(markerBytes));
          const marker = parseSequencePackageDocument(
            new TextDecoder('utf-8', { fatal: true }).decode(markerBytes)
          );
          const revision = marker.versionHistory.revisions.find(
            (entry) => entry.id === input.revisionId
          );
          if (
            marker.id !== input.documentId ||
            marker.product.file !== basename(bound.candidate) ||
            marker.versionHistory.headId !== input.revisionId ||
            revision?.productSnapshot.sha256 !== `sha256:${input.contentSha256}`
          )
            return result('revision-changed');
          paths.push(
            markerPath,
            ...marker.members
              .filter((member) => member.role === 'sequence-snapshot')
              .map((member) => fromPackageRelative(member.path, packageRoot))
          );
          for (const archived of marker.versionHistory.revisions) {
            capturedHashes.set(
              fromPackageRelative(archived.productSnapshot.path, packageRoot),
              archived.productSnapshot.sha256.slice('sha256:'.length)
            );
          }
          const journal = sequencePackagePaths(packageRoot).revisionJournalPath;
          if (fs.existsSync(journal)) paths.push(journal);
        } else if (!acceptedPaths) {
          const transition = readSequenceEditTransitions(dependencies.db, input.documentId).find(
            (entry) => entry.id === input.revisionId
          );
          if (transition?.event.afterFileSha256 !== `sha256:${input.contentSha256}`)
            return result('revision-changed');
        }
        const expectedContentSha256: Record<string, string | null> = {};
        for (const path of new Set(paths)) {
          const canonical = await canonicalWorkspacePath({
            workspaceRoot: bound.root,
            path,
            allowMissing: capturedHashes.get(path) === null,
            artifactNoun: 'sequence history',
          });
          const relative = pathRelativeToBoundary(canonical.candidate, bound.root);
          if (!relative) return result('revision-changed');
          const capturedHash = capturedHashes.get(path);
          if (capturedHash === null) {
            try {
              await fs.promises.lstat(canonical.candidate);
              return result('revision-changed');
            } catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                throw error;
            }
            expectedContentSha256[relative] = null;
            continue;
          }
          const observedHash = sha256(
            await readFileBoundedFromHandle(canonical.candidate, SOFT_WARN_BYTES - 1)
          );
          if (capturedHash && observedHash !== capturedHash) return result('revision-changed');
          expectedContentSha256[relative] = capturedHash ?? observedHash;
        }
        const name = await git.getConfig({ fs, dir: bound.root, path: 'user.name' });
        const email = await git.getConfig({ fs, dir: bound.root, path: 'user.email' });
        dependencies.assertCurrent?.();
        if (dependencies.mutationLease)
          assertWorkspaceMutationLease(dependencies.mutationLease, bound.root);
        assertNativeSequenceContentWritable(dependencies.db, input.documentId, bound.root);
        if (acceptedPaths) {
          const current = acceptedHistoryPaths(input, dependencies.db, bound.root, bound.candidate);
          if (
            !current ||
            current.size !== acceptedPaths.size ||
            [...acceptedPaths].some(([path, hash]) => current.get(path) !== hash)
          )
            return result('revision-changed');
        }
        const committed = await (dependencies.commit ?? commitOwnedPathsIfDirty)(
          bound.root,
          input.message,
          {
            paths: Object.keys(expectedContentSha256),
            expectedHead: head,
            expectedContentSha256,
            author: name && email ? { name, email } : WORKSPACE_GIT_AUTHOR,
          }
        );
        if (committed)
          await flushManagedCommitDurably(
            bound.root,
            committed,
            Object.keys(expectedContentSha256)
          );
        return result(committed ? 'committed' : 'already-committed');
      });
    if (dependencies.mutationLease) {
      assertWorkspaceMutationLease(dependencies.mutationLease, bound.root);
      return await checkpoint();
    }
    if (dependencies.renderer) {
      return await withDeclaredRendererWorkspaceMutation({
        db: dependencies.db,
        ownerId: dependencies.renderer.ownerId,
        workspaceRoot: bound.root,
        mutationPaths: [bound.candidate],
        mutationToken: dependencies.renderer.mutationToken,
        fileWrite: true,
        operation: checkpoint,
      });
    }
    release = await acquireWorkspaceMutationShared(bound.root);
    return await checkpoint();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return result(
      /MANAGED_GIT_(OWNED_CONTENT_CHANGED|HEAD_CHANGED|INDEX_CHANGED)/u.test(message)
        ? 'revision-changed'
        : 'failed'
    );
  } finally {
    release?.();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function acceptedHistoryPaths(
  input: SequenceDocumentHistoryInput,
  db: Database.Database,
  root: string,
  productPath: string
): Map<string, string | null> | null {
  const accepted = input.accepted;
  const workspaceId = scientificWorkspaceIdForRoot(db, root);
  if (
    !accepted ||
    typeof accepted.operationId !== 'string' ||
    !accepted.operationId ||
    accepted.operationId.length > 256 ||
    accepted.kind !== 'accepted-object' ||
    accepted.resourceId !== input.documentId ||
    accepted.contentSha256 !== input.contentSha256 ||
    accepted.sequenceEditParentEventId !== input.revisionId ||
    input.revisionId !==
      `sequence-edit-${sha256(new TextEncoder().encode(accepted.operationId))}` ||
    workspaceId === null
  )
    return null;
  const version = parseWorkspaceVersionId(accepted.workspaceVersionId);
  if (!version.ok) return null;
  const store = new ScientificObjectStore(db, workspaceId);
  const { graph, head } = store.read();
  if (!head) return null;
  const saved = listWorkspaceResources(graph, version.value),
    current = listWorkspaceResources(graph, head),
    workspace = inspectWorkspaceVersion(graph, version.value);
  if (!saved.ok || !current.ok || !workspace.ok || workspace.value.parentIds.length !== 1)
    return null;
  const parent = listWorkspaceResources(graph, workspace.value.parentIds[0]);
  if (!parent.ok) return null;
  const source = saved.value.find(
    (slot) => slot.resourceId === input.documentId && !slot.tombstone
  );
  if (
    !source?.path ||
    source.revisionId !== accepted.resourceRevisionId ||
    resolve(root, source.path) !== productPath
  )
    return null;
  const historyPath = `.dnaforge/history/sequence-edits/${input.revisionId}.json`;
  const history = saved.value.find((slot) => slot.path === historyPath && !slot.tombstone);
  if (!history) return null;
  const historyRevision = inspectResourceRevision(graph, history.revisionId);
  const historyState =
    historyRevision.ok && historyRevision.value.stateHash
      ? inspectResourceState(graph, historyRevision.value.stateHash)
      : null;
  if (!historyState?.ok || historyState.value.layout !== 'file') return null;
  const bytes = store.readBlob(historyState.value.blob);
  if (!bytes) return null;
  const record = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    record.documentId !== input.documentId ||
    record.afterRevisionId !== accepted.resourceRevisionId ||
    record.eventId !== input.revisionId ||
    record.replacedWorkspaceVersionId !== workspace.value.parentIds[0] ||
    nativeRecord(record.event).afterFileSha256 !== `sha256:${input.contentSha256}`
  )
    return null;
  const intended = saved.value.filter(
    (slot) =>
      !slot.tombstone &&
      slot.path &&
      (slot.resourceId === source.resourceId ||
        slot.path === scientificIdentityPath ||
        !parent.value.some(
          (before) =>
            before.resourceId === slot.resourceId &&
            before.revisionId === slot.revisionId &&
            before.path === slot.path
        ))
  );
  const event = nativeRecord(record.event);
  if (typeof event.draftLineageId !== 'string') return null;
  const followups = sequenceSavePrimerPublicationSlots({
    request: input,
    db,
    workspaceId,
    store,
    graph,
    head,
    draftLineageId: event.draftLineageId,
  });
  if (!followups) return null;
  const selected = new Map([...intended, ...followups].map((slot) => [slot.resourceId, slot]));
  const hashes = new Map<string, string | null>();
  for (const slot of selected.values()) {
    const path = slot.path ?? slot.lastPath;
    if (
      !path ||
      !current.value.some(
        (live) =>
          live.tombstone === slot.tombstone &&
          live.resourceId === slot.resourceId &&
          live.revisionId === slot.revisionId &&
          live.path === slot.path &&
          live.lastPath === slot.lastPath
      )
    )
      return null;
    if (slot.tombstone) {
      hashes.set(resolve(root, path), null);
      continue;
    }
    const revision = inspectResourceRevision(graph, slot.revisionId);
    const state =
      revision.ok && revision.value.stateHash
        ? inspectResourceState(graph, revision.value.stateHash)
        : null;
    if (!state?.ok || state.value.layout !== 'file' || !store.readBlob(state.value.blob))
      return null;
    hashes.set(resolve(root, path), state.value.blob.hash.slice('sha256:'.length));
  }
  return hashes.get(productPath) === input.contentSha256 ? hashes : null;
}
