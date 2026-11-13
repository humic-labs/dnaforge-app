// @vitest-environment node
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import { annotationTargetDocumentRevision } from '../shared/annotation-target-document-revision';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  NativeAnnotationDocumentRecovery,
  observeNativeDocumentCheckpoint,
  type PendingNativeDocumentAction,
} from './native-document-recovery';
import { sha256Text } from './primer-artifact-files';
import { hasWorkspaceSyncMutationLeaseForTest } from './workspace-sync-mutation-lease';
import { commitPathsIfDirty, initManagedRepo, resolveHeadCommit } from './workspace-git';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-document-recovery-')));
  roots.push(root);
  const document = { documentId: 'doc-1', workspaceRoot: root, sourcePath: join(root, 'notes.gb') };
  const sequence = {
    id: document.documentId,
    name: 'ordinary-file',
    sequence: 'ATGC',
    length: 4,
    circular: false,
    annotations: [],
  };
  const before = serializeSequenceForInPlaceSave(sequence, document.sourcePath);
  const after = serializeSequenceForInPlaceSave(
    {
      ...sequence,
      annotations: [
        {
          name: 'Recorded candidate',
          type: 'misc_feature',
          start: 0,
          end: 4,
          direction: 1,
          qualifiers: {
            dnaforge_action_id: ['action-1'],
            dnaforge_operation_id: ['op-1'],
            dnaforge_candidate_id: ['op-1:0'],
          },
        },
      ],
    },
    document.sourcePath
  );
  const parsed = parseSequenceFileAsDocument(after, document.sourcePath).sequence;
  parsed.id = document.documentId;
  const action: PendingNativeDocumentAction = {
    id: 'action-1',
    operation_id: 'op-1',
    operation_kind: 'annotation',
    action: 'apply_to_document',
    actor_kind: 'human',
    actor_id: 'human-1',
    channel: 'managed_cli',
    recorded_at: 1,
    outcome: 'document_writing',
    details_json: {
      native_owner_instance_id: 'old-owner',
      target_document_id: document.documentId,
      request_sha256: `sha256:${'a'.repeat(64)}`,
      write_intent: {
        before_sha256: `sha256:${await sha256Text(before)}`,
        after_sha256: `sha256:${await sha256Text(after)}`,
        target_revision: await annotationTargetDocumentRevision(parsed),
        selection_count: 1,
        selection_sha256: `sha256:${await sha256Text(JSON.stringify(['op-1:0']))}`,
      },
    },
  };
  await writeFile(document.sourcePath, after);
  const barrier = {
    finish: vi.fn(async () => 'not-required' as const),
    abort: vi.fn(),
    assertCurrent: vi.fn(),
  };
  const deps = {
    nativeOwnerInstanceId: 'new-owner',
    resolve: vi.fn(async () => document),
    prepare: vi.fn(async () => barrier),
    observeCheckpoint: vi.fn(observeNativeDocumentCheckpoint),
    recordObservation: vi.fn(async () => {
      expect(hasWorkspaceSyncMutationLeaseForTest(root)).toBe(true);
      expect(barrier.finish).not.toHaveBeenCalled();
    }),
  };
  return {
    root,
    document,
    before,
    after,
    action,
    barrier,
    deps,
    recovery: new NativeAnnotationDocumentRecovery(deps),
  };
}

it('observes exact saved bytes and an existing Git commit without writing or committing again', async () => {
  const f = await fixture();
  await initManagedRepo(f.root);
  const commit = await commitPathsIfDirty(f.root, 'Existing saved document', {
    paths: ['notes.gb'],
  });
  const result = await f.recovery.recover(f.action);
  expect(result.settlement).toEqual({
    status: 'saved',
    observed_sha256: f.action.details_json.write_intent?.after_sha256,
    target_revision: f.action.details_json.write_intent?.target_revision,
    checkpoint: { status: 'committed', commit },
  });
  expect(result.display).toBe('not-required');
  expect(f.deps.recordObservation).toHaveBeenCalledOnce();
  expect(await readFile(f.document.sourcePath, 'utf8')).toBe(f.after);
  expect(await resolveHeadCommit(f.root)).toBe(commit);
  expect(hasWorkspaceSyncMutationLeaseForTest(f.root)).toBe(false);
});

it('records the original file as an observed failure and never recreates the intended file', async () => {
  const f = await fixture();
  await writeFile(f.document.sourcePath, f.before);
  const result = await f.recovery.recover(f.action);
  expect(result.settlement).toMatchObject({
    status: 'save-failed',
    observed_sha256: f.action.details_json.write_intent?.before_sha256,
  });
  expect(result.settlement.write_disposition).toBeUndefined();
  expect(f.deps.observeCheckpoint).not.toHaveBeenCalled();
  expect(await readFile(f.document.sourcePath, 'utf8')).toBe(f.before);
  expect(f.barrier.abort).toHaveBeenCalledWith('unchanged');
});

it('keeps unknown bytes unresolved and protects the stale editing client', async () => {
  const f = await fixture();
  await writeFile(f.document.sourcePath, 'externally changed');
  const result = await f.recovery.recover(f.action);
  expect(result.settlement.status).toBe('outcome-unresolved');
  expect(f.barrier.abort).toHaveBeenCalledWith('needs-recovery');
  expect(f.barrier.finish).not.toHaveBeenCalled();
  expect(await readFile(f.document.sourcePath, 'utf8')).toBe('externally changed');
});

it('can close an admission with no write intent without accessing a document', async () => {
  const f = await fixture();
  delete f.action.details_json.write_intent;
  f.action.outcome = 'document_admitted';
  f.deps.recordObservation.mockImplementation(async () => undefined);
  expect((await f.recovery.recover(f.action)).settlement.status).toBe('blocked');
  expect(f.deps.resolve).not.toHaveBeenCalled();
  expect(f.deps.prepare).not.toHaveBeenCalled();
});

it('does not reconcile an action owned by the currently running native owner', async () => {
  const f = await fixture();
  f.action.details_json.native_owner_instance_id = 'new-owner';
  await expect(f.recovery.recover(f.action)).rejects.toThrow(/current owner/i);
  expect(f.deps.resolve).not.toHaveBeenCalled();
  expect(f.deps.recordObservation).not.toHaveBeenCalled();
});

it('leaves a replaced or inaccessible binding unresolved', async () => {
  const f = await fixture();
  await rm(f.document.sourcePath);
  const outside = join(f.root, 'other.gb');
  await writeFile(outside, f.after);
  await symlink(outside, f.document.sourcePath);
  expect((await f.recovery.recover(f.action)).settlement.status).toBe('outcome-unresolved');
  expect(f.deps.observeCheckpoint).not.toHaveBeenCalled();
  expect(await readFile(outside, 'utf8')).toBe(f.after);
});

it('does not certify a file that changed while its checkpoint was being inspected', async () => {
  const f = await fixture();
  f.deps.observeCheckpoint.mockImplementation(async () => {
    await writeFile(f.document.sourcePath, f.before);
    return { status: 'committed', commit: 'b'.repeat(40) };
  });
  expect((await f.recovery.recover(f.action)).settlement.status).toBe('outcome-unresolved');
  expect(f.barrier.finish).not.toHaveBeenCalled();
});

it('does not turn a lost journal acknowledgement into another save or another observation', async () => {
  const f = await fixture();
  f.deps.recordObservation.mockRejectedValue(new Error('response lost'));
  await expect(f.recovery.recover(f.action)).rejects.toThrow('response lost');
  expect(f.deps.recordObservation).toHaveBeenCalledOnce();
  expect(f.barrier.abort).toHaveBeenCalledWith('needs-recovery');
  expect(hasWorkspaceSyncMutationLeaseForTest(f.root)).toBe(false);
  expect(await readFile(f.document.sourcePath, 'utf8')).toBe(f.after);
});

it('reports a saved file separately from a missing matching checkpoint', async () => {
  const f = await fixture();
  await initManagedRepo(f.root);
  await writeFile(f.document.sourcePath, f.before);
  const commit = await commitPathsIfDirty(f.root, 'Original document', { paths: ['notes.gb'] });
  await writeFile(f.document.sourcePath, f.after);
  const result = await f.recovery.recover(f.action);
  expect(result.settlement.status).toBe('saved');
  expect(result.settlement.checkpoint?.status).toBe('failed');
  expect(await resolveHeadCommit(f.root)).toBe(commit);
});

it('requires the recorded revision and selected-candidate provenance, even for a matching file hash', async () => {
  const f = await fixture();
  const intent = f.action.details_json.write_intent;
  if (!intent) throw new Error('Fixture write intent missing');
  intent.selection_count = 2;
  expect((await f.recovery.recover(f.action)).settlement.status).toBe('outcome-unresolved');
  expect(f.deps.observeCheckpoint).not.toHaveBeenCalled();
});

it('does not run an annotation recovery adapter on another kind of operation', async () => {
  const f = await fixture();
  f.action.operation_kind = 'another-workflow';
  await expect(f.recovery.recover(f.action)).rejects.toThrow(/operation kind/i);
  expect(f.deps.resolve).not.toHaveBeenCalled();
  expect(f.deps.recordObservation).not.toHaveBeenCalled();
});

it('keeps the result unresolved when the editing client reloads during observation', async () => {
  const f = await fixture();
  f.barrier.assertCurrent.mockImplementation(() => {
    throw new Error('The editing client reloaded.');
  });
  expect((await f.recovery.recover(f.action)).settlement).toEqual({
    status: 'outcome-unresolved',
    reason: 'The editing client reloaded.',
  });
  expect(f.barrier.finish).not.toHaveBeenCalled();
  expect(f.barrier.abort).toHaveBeenCalledWith('needs-recovery');
});
