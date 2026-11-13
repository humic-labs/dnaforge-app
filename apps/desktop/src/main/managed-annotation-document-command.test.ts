// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import { annotationInputRevision } from '../shared/annotation-input-revision';
import type { TrustedManagedAnnotationAuthority } from '../shared/annotation-managed-operation-contract';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import {
  NativeAnnotationDocumentCommands,
  type NativeAnnotationDocumentCommandDependencies,
  type NativeAnnotationDocumentBarrier,
} from './managed-annotation-document-command';
import { sha256Text } from './primer-artifact-files';
import * as durability from './fs-durability';
import type { ResolvedSequenceEditLineage } from './sequence-edit-lineage';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dna-native-annotation-'));
  roots.push(root);
  const sourcePath = join(root, 'notes.gb');
  const initial = serializeSequenceForInPlaceSave(
    {
      id: 'document-1',
      name: 'ordinary-file',
      sequence: 'ATGC',
      length: 4,
      circular: false,
      annotations: [],
    },
    sourcePath
  );
  await writeFile(sourcePath, initial);
  const target = { operationId: 'operation-1', targetDocumentId: 'document-1' };
  const document = { documentId: target.targetDocumentId, sourcePath, workspaceRoot: root };
  const authority: TrustedManagedAnnotationAuthority = {
    schema: 'dnaforge.managed-annotation-authority.v1',
    operation: {
      id: target.operationId,
      kind: 'annotation',
      state: 'succeeded',
      result_status: 'available',
      version: 3,
      subject: {
        scope_id: 'workspace-1',
        subject_id: target.targetDocumentId,
        input_revision: await annotationInputRevision({ sequence: 'ATGC', linear: true }),
      },
    },
    resultSha256: `sha256:${'a'.repeat(64)}`,
    result: {
      sequence_length: 4,
      features: [
        {
          name: 'Recorded candidate',
          type: 'misc_feature',
          start: 1,
          end: 4,
          strand: 1,
          identity: 100,
          coverage: 100,
          fragment: false,
          ref_start: 1,
          ref_end: 4,
          ref_length: 4,
          db_source: 'nucleotide',
        },
      ],
    },
  };
  const barrier = {
    finish: vi.fn<NativeAnnotationDocumentBarrier['finish']>(async () => 'refreshed'),
    assertCurrent: vi.fn(),
    abort: vi.fn(),
  };
  const deps = {
    resolve: vi.fn(async () => document),
    authorize: vi.fn(async () => structuredClone(authority)),
    prepare: vi.fn(async () => barrier),
    checkpoint: vi.fn(async () => ({ status: 'committed' as const, commit: 'b'.repeat(40) })),
    recordWriteIntent: vi.fn<NativeAnnotationDocumentCommandDependencies['recordWriteIntent']>(
      async () => ({ status: 'permitted' })
    ),
    recordOutcome: vi.fn(async () => undefined),
    recordLineageAdvance: vi.fn(async () => undefined),
    resolveLineage:
      vi.fn<
        (input: {
          documentId: string;
          currentFileSha256: string;
          analyzedInputRevision: string;
          currentInputRevision: string;
        }) => ResolvedSequenceEditLineage
      >(),
  };
  const owner = new NativeAnnotationDocumentCommands(deps);
  const inspection = await owner.inspect(target);
  const selection = {
    ...target,
    expectedOperationVersion: inspection.operationVersion,
    expectedResultSha256: inspection.resultSha256,
    expectedTargetDocumentRevision: inspection.targetDocumentRevision,
    selectedCandidateIds: [inspection.candidates[0].id],
  };
  const reopen = async () =>
    parseSequenceFileAsDocument(await readFile(sourcePath, 'utf8'), sourcePath).sequence;
  return {
    root,
    sourcePath,
    initial,
    target,
    document,
    authority,
    barrier,
    deps,
    owner,
    inspection,
    selection,
    reopen,
  };
}

describe('native managed annotation document commands', () => {
  it('refuses publication if its editing client reloads while the intent is being acknowledged', async () => {
    const f = await fixture();
    f.deps.recordWriteIntent.mockImplementationOnce(async () => {
      f.barrier.assertCurrent.mockImplementation(() => {
        throw new Error('Editing client reloaded');
      });
      return { status: 'permitted' };
    });
    expect(await f.owner.apply(f.selection, 'action-reloaded')).toMatchObject({
      status: 'save-failed',
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.initial);
    expect(f.deps.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'save-failed',
        write_disposition: 'not-published',
      })
    );
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
  });

  it('keeps a post-publication flush failure unresolved and requires renderer recovery', async () => {
    const f = await fixture();
    vi.spyOn(durability, 'syncDirectory').mockRejectedValueOnce(
      new Error('Directory flush failed')
    );
    expect(await f.owner.apply(f.selection, 'action-flush-failure')).toMatchObject({
      status: 'outcome-unresolved',
      actionId: 'action-flush-failure',
    });
    expect((await f.reopen()).annotations).toHaveLength(1);
    expect(f.deps.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'outcome-unresolved',
        reason: expect.stringContaining('flush failed'),
      })
    );
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
    expect(f.barrier.abort).toHaveBeenCalledWith('needs-recovery');
  });

  it('records the exact saved file and checkpoint before releasing the editing barrier', async () => {
    const f = await fixture();
    f.deps.recordOutcome.mockImplementationOnce(async () => {
      expect(f.barrier.finish).not.toHaveBeenCalled();
      expect(f.barrier.abort).not.toHaveBeenCalled();
      expect(f.deps.checkpoint).toHaveBeenCalledOnce();
    });
    const result = await f.owner.apply(f.selection, 'action-recorded');
    expect(result.status).toBe('saved');
    expect(f.deps.recordOutcome).toHaveBeenCalledWith({
      status: 'saved',
      observed_sha256: `sha256:${await sha256Text(await readFile(f.sourcePath, 'utf8'))}`,
      target_revision: expect.stringMatching(/^annotation-document-v1:sha256:/),
      checkpoint: { status: 'committed', commit: 'b'.repeat(40) },
    });
    expect(f.barrier.finish).toHaveBeenCalledOnce();
  });

  it('advances edit lineage across its annotation-only publication', async () => {
    const f = await fixture();
    const result = await f.owner.apply(f.selection, 'action-lineage');
    const saved = await readFile(f.sourcePath, 'utf8');
    expect(result).toMatchObject({ status: 'saved', lineage: 'recorded' });
    expect(f.deps.recordLineageAdvance).toHaveBeenCalledExactlyOnceWith({
      documentId: f.document.documentId,
      actionId: 'action-lineage',
      beforeFileSha256: `sha256:${await sha256Text(f.initial)}`,
      afterFileSha256: `sha256:${await sha256Text(saved)}`,
      beforeTargetDocumentRevision: f.inspection.targetDocumentRevision,
      afterTargetDocumentRevision: expect.stringMatching(/^annotation-document-v1:sha256:/),
      inputRevision: f.authority.operation.subject.input_revision,
      topology: 'linear',
      sequenceLength: 4,
    });
  });

  it('reports saved truth but unavailable lineage when the post-publication event fails', async () => {
    const f = await fixture();
    f.deps.recordLineageAdvance.mockRejectedValueOnce(new Error('SQLite event append failed'));
    expect(await f.owner.apply(f.selection, 'action-lineage-failure')).toMatchObject({
      status: 'saved',
      lineage: 'unavailable',
    });
    expect((await f.reopen()).annotations).toHaveLength(1);
    expect(f.deps.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: 'saved' }));
  });

  it('keeps a completed write unresolved when the outcome acknowledgement is lost', async () => {
    const f = await fixture();
    f.deps.recordOutcome.mockRejectedValueOnce(new Error('Outcome acknowledgement lost.'));
    expect(await f.owner.apply(f.selection, 'action-lost-outcome')).toMatchObject({
      status: 'outcome-unresolved',
      actionId: 'action-lost-outcome',
    });
    expect((await f.reopen()).annotations).toHaveLength(1);
    expect(f.deps.recordWriteIntent).toHaveBeenCalledOnce();
    expect(f.deps.recordOutcome).toHaveBeenCalledOnce();
    expect(f.barrier.abort).toHaveBeenCalledWith('needs-recovery');
    expect(f.barrier.finish).not.toHaveBeenCalled();
  });

  it('does not certify saved bytes if another writer changes the file during checkpointing', async () => {
    const f = await fixture();
    f.deps.checkpoint.mockImplementationOnce(async () => {
      await writeFile(f.sourcePath, 'external winner');
      return { status: 'committed', commit: 'b'.repeat(40) };
    });
    expect(await f.owner.apply(f.selection, 'action-external-winner')).toMatchObject({
      status: 'outcome-unresolved',
      actionId: 'action-external-winner',
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe('external winner');
    expect(f.deps.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'outcome-unresolved',
      })
    );
  });

  it('records a refusal before a write intent without claiming a saved file', async () => {
    const f = await fixture();
    f.deps.prepare.mockRejectedValueOnce(new Error('Unsaved edits'));
    expect((await f.owner.apply(f.selection, 'action-dirty')).status).toBe('blocked');
    expect(f.deps.recordOutcome).toHaveBeenCalledWith({
      status: 'blocked',
      reason: 'Unsaved edits',
    });
    expect(f.deps.recordWriteIntent).not.toHaveBeenCalled();
  });

  it('records the exact intended file before mutating the document', async () => {
    const f = await fixture();
    f.deps.recordWriteIntent.mockImplementationOnce(async () => {
      expect(await readFile(f.sourcePath, 'utf8')).toBe(f.initial);
      expect(f.deps.checkpoint).not.toHaveBeenCalled();
      return { status: 'permitted' };
    });
    expect(await f.owner.apply(f.selection, 'action-intent')).toMatchObject({ status: 'saved' });
    const [request] = f.deps.recordWriteIntent.mock.calls[0];
    expect(request.actionId).toBe('action-intent');
    expect(request.selection).toEqual(f.selection);
    expect(request.intent).toEqual({
      before_sha256: `sha256:${await sha256Text(f.initial)}`,
      after_sha256: `sha256:${await sha256Text(await readFile(f.sourcePath, 'utf8'))}`,
      target_revision: expect.stringMatching(/^annotation-document-v1:sha256:/),
      selection_sha256: `sha256:${await sha256Text(JSON.stringify(f.selection.selectedCandidateIds))}`,
      selection_count: 1,
    });
  });

  it('does not write when its durable intent acknowledgement is lost', async () => {
    const f = await fixture();
    f.deps.recordWriteIntent.mockRejectedValueOnce(new Error('Intent connection lost.'));
    expect(await f.owner.apply(f.selection, 'action-lost-intent')).toMatchObject({
      status: 'outcome-unresolved',
      actionId: 'action-lost-intent',
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.initial);
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
    expect(f.barrier.abort).toHaveBeenCalledWith('unchanged');
  });

  it('never interprets an existing intent as permission to repeat its write', async () => {
    const f = await fixture();
    f.deps.recordWriteIntent.mockResolvedValueOnce({ status: 'existing' });
    expect(await f.owner.apply(f.selection, 'action-existing')).toMatchObject({
      status: 'outcome-unresolved',
      actionId: 'action-existing',
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.initial);
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
  });

  it('stops before writing when live intent authority refuses the action', async () => {
    const f = await fixture();
    f.deps.recordWriteIntent.mockResolvedValueOnce({
      status: 'refused',
      reason: 'The grant was revoked.',
    });
    expect(await f.owner.apply(f.selection, 'action-refused')).toMatchObject({
      status: 'blocked',
      reason: 'The grant was revoked.',
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.initial);
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
  });
  it('saves the selected retained candidate into an actual file with no renderer', async () => {
    const f = await fixture();
    const result = await f.owner.apply(f.selection, 'action-1');
    expect(result).toMatchObject({
      status: 'saved',
      checkpoint: { status: 'committed' },
      display: 'refreshed',
    });
    const reopened = await f.reopen();
    expect(reopened.sequence).toBe('ATGC');
    expect(reopened.annotations).toHaveLength(1);
    expect(reopened.annotations?.[0]).toMatchObject({
      name: 'Recorded candidate',
      start: 1,
      end: 4,
      qualifiers: {
        dnaforge_operation_id: ['operation-1'],
        dnaforge_action_id: ['action-1'],
        dnaforge_candidate_id: ['operation-1:0'],
        dnaforge_result_sha256: [f.authority.resultSha256],
        dnaforge_input_revision: [f.authority.operation.subject.input_revision],
      },
    });
    expect(await f.owner.inspect(f.target)).toMatchObject({
      targetDocumentRevision:
        'targetDocumentRevision' in result ? result.targetDocumentRevision : null,
    });
    expect(f.barrier.finish).toHaveBeenCalledOnce();
    expect(f.barrier.abort).not.toHaveBeenCalled();
  });

  it('re-inspects and applies the mapped candidate rather than the stale retained coordinates', async () => {
    const f = await fixture();
    const changedSequence = 'TTATGC';
    await writeFile(
      f.sourcePath,
      serializeSequenceForInPlaceSave(
        {
          id: f.document.documentId,
          name: 'ordinary-file',
          sequence: changedSequence,
          length: changedSequence.length,
          circular: false,
          annotations: [],
        },
        f.sourcePath
      )
    );
    const currentInputRevision = await annotationInputRevision({
      sequence: changedSequence,
      linear: true,
    });
    f.deps.resolveLineage.mockReturnValue({
      exact: false,
      transitions: [
        {
          id: 'saved-edit-1',
          createdAt: 1,
          event: {
            schema: 'dnaforge.sequence-edit-transition.v1',
            parentEventId: null,
            draftLineageId: 'draft-1',
            beforeFileSha256: `sha256:${'1'.repeat(64)}`,
            afterFileSha256: `sha256:${'2'.repeat(64)}`,
            beforeTargetDocumentRevision: 'before-document',
            afterTargetDocumentRevision: 'after-document',
            beforeInputRevision: f.authority.operation.subject.input_revision,
            afterInputRevision: currentInputRevision,
            beforeTopology: 'linear',
            afterTopology: 'linear',
            transition: {
              beforeLength: 4,
              afterLength: 6,
              operations: [{ kind: 'insert', at: 0, length: 2 }],
            },
          },
        },
      ],
    });

    const mapped = await f.owner.inspect(f.target);
    expect(mapped).toMatchObject({
      applicable: true,
      coordinates: 'mapped',
      transitionCount: 1,
      candidates: [
        {
          id: 'operation-1:0',
          sourceFeature: { start: 1, end: 4 },
          feature: { start: 3, end: 6 },
        },
      ],
    });
    const outcome = await f.owner.apply(
      {
        ...f.selection,
        expectedTargetDocumentRevision: mapped.targetDocumentRevision,
        selectedCandidateIds: [mapped.candidates[0].id],
      },
      'action-mapped'
    );
    expect(outcome.status).toBe('saved');
    expect((await f.reopen()).annotations[0]).toMatchObject({ start: 3, end: 6 });
  });

  it('refuses dirty client state without touching native bytes and releases the workspace lease', async () => {
    const f = await fixture();
    f.deps.prepare.mockRejectedValueOnce(new Error('An editor has unsaved changes.'));
    expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('unsaved'),
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.initial);
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
    expect(await f.owner.inspect(f.target)).toEqual(f.inspection);
  });

  it('refuses a changed full document even when its sequence is identical', async () => {
    const f = await fixture();
    const changed = f.initial.replace('ordinary-file', 'edited-name');
    await writeFile(f.sourcePath, changed);
    expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('document changed'),
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(changed);
    expect(f.barrier.abort).toHaveBeenCalledWith('unchanged');
  });

  it('rechecks the retained authority after the client barrier', async () => {
    const f = await fixture();
    f.deps.prepare.mockImplementationOnce(async () => {
      f.authority.operation.result_status = 'released';
      return f.barrier;
    });
    expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({ status: 'blocked' });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(f.initial);
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
  });

  it('never overwrites a file changed after the native snapshot was read', async () => {
    const f = await fixture();
    const changed = f.initial.replace('ordinary-file', 'external-name');
    f.deps.authorize.mockImplementationOnce(async () => structuredClone(f.authority));
    f.deps.authorize.mockImplementationOnce(async () => {
      await writeFile(f.sourcePath, changed);
      return structuredClone(f.authority);
    });
    expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({
      status: 'save-failed',
      reason: expect.stringContaining('changed since'),
    });
    expect(await readFile(f.sourcePath, 'utf8')).toBe(changed);
    expect(f.deps.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'save-failed',
        write_disposition: 'not-published',
        observed_sha256: `sha256:${await sha256Text(changed)}`,
      })
    );
  });

  it('serializes competing Apply commands and refuses the stale second selection', async () => {
    const f = await fixture();
    let releasePreparation = () => {};
    let preparationStarted = () => {};
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    f.deps.prepare.mockImplementationOnce(async () => {
      preparationStarted();
      await held;
      return f.barrier;
    });
    const first = f.owner.apply(f.selection, 'action-first');
    await started;
    const second = f.owner.apply(f.selection, 'action-second');
    releasePreparation();
    expect(await first).toMatchObject({ status: 'saved' });
    expect(await second).toMatchObject({
      status: 'blocked',
      reason: expect.stringContaining('document changed'),
    });
    expect((await f.reopen()).annotations).toHaveLength(1);
    expect(f.deps.checkpoint).toHaveBeenCalledOnce();
  });

  it('reports the completed file write truthfully if the later Git checkpoint fails', async () => {
    const f = await fixture();
    f.deps.checkpoint.mockRejectedValueOnce(new Error('Git index is busy.'));
    expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({
      status: 'saved',
      checkpoint: { status: 'failed', reason: 'Git index is busy.' },
    });
    expect((await f.reopen()).annotations).toHaveLength(1);
  });

  it('keeps a failed display delivery distinct from the completed native save', async () => {
    const f = await fixture();
    f.barrier.finish.mockRejectedValueOnce(new Error('Renderer disappeared.'));
    expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({
      status: 'saved',
      display: 'pending',
      displayError: 'Renderer disappeared.',
    });
    expect((await f.reopen()).annotations).toHaveLength(1);
    expect(f.barrier.abort).toHaveBeenCalledWith('needs-recovery');
  });

  it('does not erase a known save when releasing a failed display barrier also throws', async () => {
    const f = await fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.barrier.finish.mockRejectedValueOnce(new Error('Renderer disappeared.'));
    f.barrier.abort.mockImplementationOnce(() => {
      throw new Error('Release failed.');
    });
    try {
      expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({
        status: 'saved',
        display: 'pending',
      });
      expect((await f.reopen()).annotations).toHaveLength(1);
      await expect(f.owner.inspect(f.target)).resolves.toMatchObject({ applicable: true });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it('refuses a symlink to a file outside the authorized workspace', async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'dna-outside-annotation-'));
    roots.push(outside);
    const outsidePath = join(outside, 'untouched.gb');
    await writeFile(outsidePath, f.initial);
    await rm(f.sourcePath);
    await symlink(outsidePath, f.sourcePath);
    expect(await f.owner.apply(f.selection, 'action-1')).toMatchObject({ status: 'blocked' });
    expect(await readFile(outsidePath, 'utf8')).toBe(f.initial);
    expect(f.deps.checkpoint).not.toHaveBeenCalled();
  });
});
