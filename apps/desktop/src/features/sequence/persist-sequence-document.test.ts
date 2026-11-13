import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence, Annotation } from '@waypoint/sequence-utils';
import type { EditorPastePrimerBinding } from '@waypoint/workspace-editor';
import type {
  SequenceDocumentSaveInput,
  SequenceDocumentSaveResult,
} from '../../shared/sequence-edit-lineage';

import { useSequenceStore } from './store';
import { persistSequenceDocument, SequenceSaveCombinedError } from './persist-sequence-document';
import { saveSequenceDocumentWithCompletion } from './complete-sequence-document-save';
import { SequenceDocumentSaveProjectionError } from '../../services/sequence-document-save-completion';
const { checksumOutcome } = vi.hoisted(() => ({
  checksumOutcome: vi.fn<() => { ok: true } | { ok: false; error: unknown }>(() => ({ ok: true })),
}));
vi.mock('@waypoint/sequence-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/sequence-utils')>();
  return {
    ...actual,
    computeChecksum: async (content: string) => {
      const outcome = checksumOutcome();
      if (!outcome.ok) throw outcome.error;
      return actual.computeChecksum(content);
    },
  };
});

type PersistBindings = NonNullable<
  Parameters<typeof persistSequenceDocument>[0]['persistPendingPrimerBindings']
>;
import { useWorkspaceStore } from '../../stores/workspaceStore';

const {
  writeTextFile,
  exists,
  saveSequenceDocument,
  beginWorkspaceMutation,
  endWorkspaceMutation,
  reconcileWorkspaceAfterFilesChanged,
  isGitRepo,
  gitStatus,
  gitCommitPaths,
  nativeSave,
  nativeClient,
  workflowFail,
  workflowComplete,
  workflowBegin,
} = vi.hoisted(() => ({
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  saveSequenceDocument: vi.fn(),
  beginWorkspaceMutation: vi.fn(),
  endWorkspaceMutation: vi.fn(),
  reconcileWorkspaceAfterFilesChanged: vi.fn(),
  isGitRepo: vi.fn(),
  gitStatus: vi.fn(),
  gitCommitPaths: vi.fn(),
  nativeSave: vi.fn(),
  nativeClient: { enabled: false },
  workflowFail: vi.fn(),
  workflowComplete: vi.fn(),
  workflowBegin: vi.fn(),
}));

vi.mock('../../lib/workflow-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/workflow-telemetry')>()),
  beginWorkflowAction: workflowBegin,
}));

vi.mock('./sequence-document-client', () => ({
  getNativeSequenceDocumentClient: () => (nativeClient.enabled ? { save: nativeSave } : null),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      writeTextFile,
      saveSequenceDocument,
      beginWorkspaceMutation,
      endWorkspaceMutation,
      exists,
    },
  }),
}));
vi.mock('../../services/workspace-operations', () => ({ reconcileWorkspaceAfterFilesChanged }));
vi.mock('../workspace/public/git', () => ({ isGitRepo, gitStatus, gitCommitPaths }));

const DOCUMENT_ID = 'sequence-document-save-command';
const SOURCE_PATH = '/workspace/sequence.gb';

function sequence(): AnnotatedSequence {
  return {
    id: DOCUMENT_ID,
    name: 'sequence',
    sequence: 'ATGC',
    length: 4,
    circular: true,
    annotations: [],
  };
}

const annotation: Annotation = {
  name: 'saved-feature',
  type: 'misc_feature',
  start: 1,
  end: 4,
  direction: 1,
};

describe('persistSequenceDocument', () => {
  beforeEach(() => {
    nativeClient.enabled = false;
    nativeSave.mockReset();
    workflowFail.mockReset();
    workflowComplete.mockReset();
    workflowBegin.mockReset().mockReturnValue({ fail: workflowFail, complete: workflowComplete });
    useSequenceStore.getState().clearAll();
    checksumOutcome.mockReset().mockReturnValue({ ok: true });
    useWorkspaceStore.setState({ folders: [] });
    beginWorkspaceMutation.mockReset().mockResolvedValue('sequence-save-token');
    endWorkspaceMutation.mockReset().mockResolvedValue(undefined);
    reconcileWorkspaceAfterFilesChanged.mockReset().mockResolvedValue(undefined);
    isGitRepo.mockReset().mockResolvedValue(false);
    gitStatus.mockReset().mockResolvedValue(new Map());
    gitCommitPaths.mockReset().mockResolvedValue('commit');
    writeTextFile.mockReset().mockResolvedValue(undefined);
    saveSequenceDocument.mockReset().mockResolvedValue({ status: 'unbound' });
    exists.mockReset().mockResolvedValue(false);
    useSequenceStore.getState().setSequence(DOCUMENT_ID, sequence());
  });

  it('does not publish completion when the native owner refuses to write a required capture', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('The required native Save capture is missing.');
    nativeClient.enabled = true;
    nativeSave.mockResolvedValue({ dirty: false, saved: false });
    const onPersisted = vi.fn();
    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      requiredCapture: capture,
      onPersisted,
    });
    expect(result).toMatchObject({
      ok: false,
      wrote: false,
      error: { code: 'required_save_not_completed' },
    });
    expect(onPersisted).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(saveSequenceDocument).not.toHaveBeenCalled();
  });

  it('returns the captured revision when the native owner writes it successfully', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('The native Save capture is missing.');
    nativeClient.enabled = true;
    nativeSave.mockResolvedValue({ dirty: false, saved: true });
    const onPersisted = vi.fn();
    expect(
      await persistSequenceDocument({
        document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
        requiredCapture: capture,
        onPersisted,
      })
    ).toEqual({
      ok: true,
      outcome: 'saved',
      attempts: 1,
      wrote: true,
      writtenRevision: capture.revision,
    });
    expect(onPersisted).toHaveBeenCalledOnce();
  });

  it('reports the confirmed native product write when primer settlement fails without attempting completion', async () => {
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AT',
        annotations: [],
        primerBindings: [{ primerId: 'owned-primer', start: 0, end: 2, strand: 1 }],
      },
    });
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('Missing native primer capture');
    nativeClient.enabled = true;
    nativeSave.mockResolvedValue({
      saved: true,
      dirty: true,
      version: capture.revision,
      primerBindingFailure: { message: 'Owned binding write denied' },
    });
    const complete = vi.fn();
    const result = await saveSequenceDocumentWithCompletion({
      kind: 'write',
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      requiredCapture: capture,
      complete,
    });
    expect(result.persistence).toMatchObject({
      ok: false,
      wrote: true,
      writtenRevision: capture.revision,
      attempts: 1,
      error: { code: 'primer_bindings_failed' },
    });
    expect(result.publication).toEqual({ status: 'not-attempted' });
    expect(complete).not.toHaveBeenCalled();
    expect(nativeSave).toHaveBeenCalledOnce();
    expect(workflowFail).toHaveBeenLastCalledWith('primer_bindings_failed', {
      attemptCount: 1,
      wrote: true,
      dirty: true,
      capturedRevision: capture.revision,
      acknowledgedRevision: useSequenceStore.getState().savedVersions[DOCUMENT_ID],
      revisionRelation: 'written_pending_ack',
      recordWriteStatus: 'written',
      recordHistoryStatus: 'not_attempted',
      recordProjectionStatus: 'not_attempted',
      stateRevision: capture.revision,
      valueDelivered: false,
      status: 'failed',
    });
    expect(useSequenceStore.getState().captureForSave(DOCUMENT_ID)).toEqual(capture);
  });

  it('delivers the native captured-root history receipt to completion after the view is replaced', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('Missing native Save capture');
    nativeClient.enabled = true;
    nativeSave.mockImplementationOnce(async () => {
      useWorkspaceStore.setState({ folders: [] });
      return {
        saved: true,
        dirty: false,
        workspaceRoot: '/captured-project',
        history: { status: 'committed' },
      };
    });
    const complete = vi.fn().mockResolvedValue({
      status: 'committed',
      repositoryRoot: '/captured-project',
    });
    const result = await saveSequenceDocumentWithCompletion({
      kind: 'write',
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      requiredCapture: capture,
      complete,
    });
    expect(result.persistence).toMatchObject({ ok: true, wrote: true, outcome: 'saved' });
    expect(complete).toHaveBeenCalledExactlyOnceWith({
      kind: 'native-capture',
      repositoryRoot: '/captured-project',
    });
    expect(result.publication).toMatchObject({
      status: 'completed',
      completion: { status: 'committed', repositoryRoot: '/captured-project' },
    });
    expect(gitStatus).not.toHaveBeenCalled();
    expect(gitCommitPaths).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'carries a captured Save continuation only when its native revision matches the next capture: %s',
    async (matches) => {
      useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
      const initial = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
      if (!initial) throw new Error('Missing initial native Save capture');
      nativeClient.enabled = true;
      const captureId = '427fd0c5-f1ae-4439-8f58-8ced0ad53c37';
      nativeSave.mockImplementationOnce(async () => {
        useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'INSERT', text: 'G' });
        const newer = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
        if (!newer) throw new Error('Missing newer native Save capture');
        return {
          saved: true,
          dirty: true,
          version: newer.revision + (matches ? 0 : 1),
          savedVersion: initial.revision,
          captureId,
        };
      });
      nativeSave.mockResolvedValueOnce({ dirty: false, saved: true });
      const onPersisted = vi.fn();
      const result = await persistSequenceDocument({
        document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
        requiredCapture: initial,
        onPersisted,
      });
      expect(result).toMatchObject({ ok: true, outcome: 'saved', attempts: 2, wrote: true });
      expect(nativeSave).toHaveBeenCalledTimes(2);
      expect(nativeSave.mock.calls[1][1].fromCaptureId).toBe(matches ? captureId : undefined);
      expect(onPersisted).toHaveBeenCalledOnce();
    }
  );

  it('retains the native write and first completion error without calling completion twice', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('The native Save capture is missing.');
    nativeClient.enabled = true;
    nativeSave.mockResolvedValue({ dirty: false, saved: true });
    const refusal = new Error('Completion refused');
    const laterRefusal = new Error('Completion repeated');
    const onPersisted = vi.fn().mockRejectedValueOnce(refusal).mockRejectedValue(laterRefusal);
    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      requiredCapture: capture,
      onPersisted,
    });
    expect(result).toMatchObject({
      ok: false,
      wrote: true,
      writtenRevision: capture.revision,
      error: { code: 'completion_failed', cause: refusal },
    });
    expect(onPersisted).toHaveBeenCalledOnce();
  });

  it.each(['projection-failed', 'unconfirmed'] as const)(
    'keeps a confirmed native write through the actual command wrapper when completion is %s',
    async (outcome) => {
      useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
      const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
      if (!capture) throw new Error('The native Save capture is missing.');
      nativeClient.enabled = true;
      nativeSave.mockResolvedValue({ dirty: false, saved: true });
      const refusal =
        outcome === 'projection-failed'
          ? new SequenceDocumentSaveProjectionError(
              { status: 'committed', repositoryRoot: '/workspace' },
              [{ stage: 'lims', error: new Error('Projection refused') }]
            )
          : new Error('Completion unavailable');
      const complete = vi.fn().mockRejectedValue(refusal);
      const result = await saveSequenceDocumentWithCompletion({
        kind: 'write',
        document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
        requiredCapture: capture,
        complete,
      });
      expect(result.persistence).toMatchObject({
        ok: false,
        wrote: true,
        writtenRevision: capture.revision,
        error: { code: 'completion_failed', cause: refusal },
      });
      expect(result.publication).toMatchObject({ status: outcome, error: refusal });
      expect(complete).toHaveBeenCalledOnce();
      expect(workflowFail).toHaveBeenLastCalledWith(
        'completion_failed',
        expect.objectContaining({
          recordWriteStatus: 'written',
          stateRevision: capture.revision,
          valueDelivered: false,
        })
      );
    }
  );

  it('carries frozen accepted authority and the borrowed write token, and waits for required reconstruction before cleaning the editor', async () => {
    const accepted = {
      kind: 'accepted-object' as const,
      contentSha256: 'a'.repeat(64),
      resourceId: DOCUMENT_ID,
      resourceRevisionId: `rr_${'a'.repeat(64)}`,
      workspaceVersionId: `wv_${'a'.repeat(64)}`,
      sequenceEditParentEventId: null,
    };
    const saved = {
      ...accepted,
      contentSha256: 'b'.repeat(64),
      resourceRevisionId: `rr_${'b'.repeat(64)}`,
      workspaceVersionId: `wv_${'b'.repeat(64)}`,
      sequenceEditParentEventId: 'saved-event',
      operationId: 'saved-operation',
    };
    useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Science', addedAt: 1 }] });
    useSequenceStore.getState().setSequence(DOCUMENT_ID, sequence(), accepted);
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    saveSequenceDocument.mockResolvedValue({
      status: 'saved',
      accepted: saved,
      eventId: 'saved-event',
      lineage: 'recorded',
      publicationPaths: ['sequence.gb'],
    });
    let release!: () => void;
    reconcileWorkspaceAfterFilesChanged.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const task = persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });
    await vi.waitFor(() => expect(reconcileWorkspaceAfterFilesChanged).toHaveBeenCalled());
    expect(saveSequenceDocument.mock.calls[0][0]).toMatchObject({
      mutationToken: 'sequence-save-token',
      accepted: {
        expectedHead: accepted.workspaceVersionId,
        expectedRevisionId: accepted.resourceRevisionId,
        baseline: { head: accepted.workspaceVersionId, revisionId: accepted.resourceRevisionId },
      },
    });
    expect(reconcileWorkspaceAfterFilesChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/workspace',
        mutationToken: 'sequence-save-token',
        strict: true,
        assertCurrent: expect.any(Function),
      })
    );
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(endWorkspaceMutation).not.toHaveBeenCalled();
    release();
    expect(await task).toMatchObject({ ok: true, outcome: 'saved' });
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(false);
    expect(useSequenceStore.getState().acceptedRevisions[DOCUMENT_ID]).toEqual(saved);
    expect(endWorkspaceMutation).toHaveBeenCalledWith('sequence-save-token');
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('retains a dirty capture and exact retry authority when accepted files cannot complete required project reconstruction', async () => {
    const accepted = {
      kind: 'accepted-object' as const,
      contentSha256: 'a'.repeat(64),
      resourceId: DOCUMENT_ID,
      resourceRevisionId: `rr_${'a'.repeat(64)}`,
      workspaceVersionId: `wv_${'a'.repeat(64)}`,
      sequenceEditParentEventId: null,
    };
    useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Science', addedAt: 1 }] });
    useSequenceStore.getState().setSequence(DOCUMENT_ID, sequence(), accepted);
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    saveSequenceDocument.mockResolvedValue({
      status: 'saved',
      accepted: { ...accepted, operationId: 'accepted-save' },
      eventId: 'event',
      lineage: 'recorded',
      publicationPaths: ['sequence.gb'],
    });
    reconcileWorkspaceAfterFilesChanged.mockRejectedValueOnce(Error('projection refused'));
    const document = { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH };
    const failure = await persistSequenceDocument({ document });
    expect(failure).toMatchObject({
      ok: false,
      wrote: true,
      error: { code: 'accepted_pending', message: expect.stringContaining('projection refused') },
    });
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(await persistSequenceDocument({ document })).toMatchObject({
      ok: true,
      outcome: 'saved',
    });
    expect(saveSequenceDocument.mock.calls[1][0].accepted).toEqual(
      saveSequenceDocument.mock.calls[0][0].accepted
    );
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('persists and acknowledges a repository-resolved document without a mounted tab', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const beforeWrite = vi.fn();
    const onPersisted = vi.fn();

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      beforeWrite,
      onPersisted,
    });

    expect(result).toEqual({
      ok: true,
      outcome: 'saved',
      attempts: 1,
      wrote: true,
      writtenRevision: useSequenceStore.getState().savedVersions[DOCUMENT_ID],
    });
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledWith(
      SOURCE_PATH,
      expect.stringContaining('saved-feature')
    );
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(false);
    expect(onPersisted).toHaveBeenCalledTimes(1);
  });

  it('skips another write after post-save Undo and Redo restore exact saved material', async () => {
    const original = { ...sequence(), annotations: [annotation] };
    useSequenceStore.getState().setSequence(DOCUMENT_ID, original);
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'INSERT', text: 'A' });
    const written = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!written) throw new Error('Post-save Undo/Redo has no initial capture');
    const onPersisted = vi.fn();
    const document = { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH };
    const first = await persistSequenceDocument({ document, onPersisted });
    expect(first).toEqual({
      ok: true,
      outcome: 'saved',
      wrote: true,
      writtenRevision: written.revision,
      attempts: 1,
    });
    const saved = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!saved) throw new Error('Post-save Undo/Redo has no saved baseline');
    expect(saved.sequence).toEqual(written.sequence);
    expect(saved.sequence.annotations[0]).toMatchObject({ start: 2, end: 5 });

    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'INSERT', text: 'C' });
    const second = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!second) throw new Error('Post-save Undo/Redo has no second edit');
    expect(second.sequence.sequence).toBe('ACATGC');
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'UNDO' });
    expect(useSequenceStore.getState().sequences[DOCUMENT_ID]).toEqual(saved.sequence);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(false);
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'REDO' });
    expect(useSequenceStore.getState().sequences[DOCUMENT_ID]).toEqual(second.sequence);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, { type: 'UNDO' });
    const restored = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!restored) throw new Error('Post-save Undo/Redo lost the saved material');
    expect(restored).toEqual({ ...saved, revision: restored.revision });
    expect(restored.revision).toBeGreaterThan(second.revision);
    expect(useSequenceStore.getState().savedVersions[DOCUMENT_ID]).toBe(written.revision);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(false);

    const unchanged = await persistSequenceDocument({ document, onPersisted });
    expect(unchanged).toEqual({
      ok: true,
      outcome: 'unchanged',
      attempts: 0,
      wrote: false,
    });
    expect(saveSequenceDocument).toHaveBeenCalledTimes(1);
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(onPersisted).toHaveBeenCalledTimes(1);
    expect(useSequenceStore.getState().savedVersions[DOCUMENT_ID]).toBe(written.revision);
  });

  it('holds the dirty draft and borrowed lease until owned compound Git publication finishes, excluding pre-existing unrelated edits', async () => {
    const accepted = {
      kind: 'accepted-object' as const,
      contentSha256: 'a'.repeat(64),
      resourceId: DOCUMENT_ID,
      resourceRevisionId: `rr_${'a'.repeat(64)}`,
      workspaceVersionId: `wv_${'a'.repeat(64)}`,
      sequenceEditParentEventId: null,
    };
    useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Science', addedAt: 1 }] });
    useSequenceStore.getState().setSequence(DOCUMENT_ID, sequence(), accepted);
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const paths = [
      'sequence.gb',
      '.dnaforge/scientific-objects.json',
      '.dnaforge/history/sequence-edits/event.json',
      '.forge/plasmid.json',
    ];
    saveSequenceDocument.mockResolvedValue({
      status: 'saved',
      accepted: { ...accepted, operationId: 'save-operation' },
      eventId: 'event',
      lineage: 'recorded',
      publicationPaths: paths,
    });
    isGitRepo.mockResolvedValue(true);
    const before = new Map([
      ['README.md', 'M'],
      ['.waypoint/lims/unrelated.json', 'M'],
    ]);
    gitStatus
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(
        new Map([
          ...before,
          ...paths.map((path) => [path, 'M'] as const),
          ['.waypoint/lims/owned.json', 'M'],
        ])
      );
    let release!: () => void;
    gitCommitPaths.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const completion = vi.fn();
    const task = persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      onPersisted: completion,
      commitMessage: 'Reviewed sequence correction',
    });
    await vi.waitFor(() => expect(gitCommitPaths).toHaveBeenCalledOnce());
    expect(gitCommitPaths.mock.calls[0]).toEqual([
      '/workspace',
      'Reviewed sequence correction',
      [...paths, '.waypoint/lims/owned.json'],
      'sequence-save-token',
    ]);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(endWorkspaceMutation).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
    release();
    expect(await task).toMatchObject({ ok: true, outcome: 'saved' });
    expect(completion).toHaveBeenCalledWith({
      kind: 'accepted-object',
      repositoryRoot: '/workspace',
    });
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(false);
  });

  it('retains exact accepted retry authority after a required Git failure and refuses an unbound accepted Save without writing working files', async () => {
    const accepted = {
      kind: 'accepted-object' as const,
      contentSha256: 'a'.repeat(64),
      resourceId: DOCUMENT_ID,
      resourceRevisionId: `rr_${'a'.repeat(64)}`,
      workspaceVersionId: `wv_${'a'.repeat(64)}`,
      sequenceEditParentEventId: null,
    };
    useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Science', addedAt: 1 }] });
    useSequenceStore.getState().setSequence(DOCUMENT_ID, sequence(), accepted);
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    saveSequenceDocument.mockResolvedValue({
      status: 'saved',
      accepted: { ...accepted, operationId: 'save-operation' },
      eventId: 'event',
      lineage: 'recorded',
      publicationPaths: ['sequence.gb'],
    });
    isGitRepo.mockResolvedValue(true);
    gitStatus.mockResolvedValue(new Map([['sequence.gb', 'M']]));
    gitCommitPaths.mockRejectedValueOnce(new Error('Git refused'));
    const document = { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH };
    expect(await persistSequenceDocument({ document })).toMatchObject({
      ok: false,
      error: { code: 'accepted_pending', message: expect.stringContaining('Git refused') },
    });
    const first = saveSequenceDocument.mock.calls[0][0];
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(await persistSequenceDocument({ document })).toMatchObject({ ok: true });
    expect(saveSequenceDocument.mock.calls[1][0]).toEqual(first);
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, { ...annotation, name: 'another edit' });
    saveSequenceDocument.mockResolvedValue({ status: 'unbound' });
    expect(await persistSequenceDocument({ document })).toMatchObject({ ok: false });
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
  });

  it('persists a required capture when the live store has the observed clean-but-diverged state', async () => {
    const base = useSequenceStore.getState().savedSequences[DOCUMENT_ID];
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, {
      ...annotation,
      qualifiers: { dnaforge_operation_id: ['annotation-operation-live'] },
    });
    const edited = useSequenceStore.getState();

    useSequenceStore.setState({
      sequenceVersions: { ...edited.sequenceVersions, [DOCUMENT_ID]: 1 },
      savedVersions: { ...edited.savedVersions, [DOCUMENT_ID]: 1 },
      dirtyPaths: {},
    });
    const requiredCapture = useSequenceStore.getState().captureForSave(DOCUMENT_ID)!;

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      requiredCapture,
    });

    expect(result).toEqual({
      ok: true,
      outcome: 'saved',
      attempts: 1,
      wrote: true,
      writtenRevision: useSequenceStore.getState().savedVersions[DOCUMENT_ID],
    });
    expect(writeTextFile).toHaveBeenCalledWith(
      SOURCE_PATH,
      expect.stringContaining('dnaforge_operation_id')
    );
    const settled = useSequenceStore.getState();
    expect(base?.annotations).toEqual([]);
    expect(settled.savedSequences[DOCUMENT_ID]?.annotations).toEqual(
      settled.sequences[DOCUMENT_ID]?.annotations
    );
    expect(settled.savedVersions[DOCUMENT_ID]).toBe(settled.sequenceVersions[DOCUMENT_ID]);
    expect(settled.dirtyPaths[DOCUMENT_ID]).toBeUndefined();
  });

  it('returns the exact completed capture revision after an ordinary native Save', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('Expected a dirty capture');

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: 'saved',
      wrote: true,
      writtenRevision: capture.revision,
    });
    expect(useSequenceStore.getState().savedVersions[DOCUMENT_ID]).toBe(capture.revision);
  });

  it('retains the completed capture revision when a newer edit arrives before primer failure', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('Expected a dirty capture');
    saveSequenceDocument.mockImplementationOnce(async () => {
      useSequenceStore.getState().addAnnotation(DOCUMENT_ID, { ...annotation, name: 'newer-edit' });
      return {
        status: 'saved',
        fileSha256: `sha256:${'4'.repeat(64)}`,
        eventId: 'synthetic-completed-native-save',
        lineage: 'recorded',
      } satisfies SequenceDocumentSaveResult;
    });
    const failure = new Error('synthetic primer refusal');
    const onPersisted = vi.fn();
    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      persistPendingPrimerBindings: vi.fn<PersistBindings>().mockRejectedValueOnce(failure),
      onPersisted,
    });

    expect(result).toMatchObject({
      ok: false,
      wrote: true,
      writtenRevision: capture.revision,
      error: { code: 'primer_bindings_failed', cause: failure },
    });
    expect(useSequenceStore.getState().sequenceVersions[DOCUMENT_ID]).toBeGreaterThan(
      capture.revision
    );
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(onPersisted).not.toHaveBeenCalled();
  });

  it('keeps an ordinary clean save as a no-write success', async () => {
    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });

    expect(result).toEqual({ ok: true, outcome: 'unchanged', attempts: 0, wrote: false });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('keeps an unavailable Save capture as a no-write result after document removal', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    expect(useSequenceStore.getState().captureForSave(DOCUMENT_ID)).not.toBeNull();
    useSequenceStore.getState().clearSequence(DOCUMENT_ID);
    const state = useSequenceStore.getState();
    expect(state.captureForSave(DOCUMENT_ID)).toBeNull();
    const beforeWrite = vi.fn();
    const onPersisted = vi.fn();
    const persistPendingPrimerBindings = vi.fn<PersistBindings>();

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      beforeWrite,
      onPersisted,
      persistPendingPrimerBindings,
    });

    expect(result).toEqual({ ok: true, outcome: 'unchanged', attempts: 0, wrote: false });
    expect(useSequenceStore.getState()).toBe(state);
    expect(saveSequenceDocument).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(onPersisted).not.toHaveBeenCalled();
    expect(persistPendingPrimerBindings).not.toHaveBeenCalled();
  });

  it('fails an explicit required save when the document has no source path', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const requiredCapture = useSequenceStore.getState().captureForSave(DOCUMENT_ID)!;

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: '' },
      requiredCapture,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected required-save failure');
    expect(result.error.code).toBe('required_save_not_completed');
    expect(result.wrote).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('returns a typed write error and keeps the captured revision dirty', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    writeTextFile.mockRejectedValue(new Error('disk refused the write'));

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected persistence failure');
    expect(result.error.code).toBe('write_failed');
    expect(result.error.message).toContain('disk refused the write');
    expect(result.wrote).toBe(false);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
  });

  it('preserves unsaved annotations when a required save discovers a read-only document', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const requiredCapture = useSequenceStore.getState().captureForSave(DOCUMENT_ID)!;

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      requiredCapture,
      readOnly: true,
    });

    expect(result.ok).toBe(false);
    expect(result.wrote).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().getSequence(DOCUMENT_ID)?.annotations).toContainEqual(
      annotation
    );
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(useSequenceStore.getState().savedSequences[DOCUMENT_ID]?.annotations).toEqual([]);
  });

  it('reports an ordinary read-only Save as an honest no-op while retaining its pending bindings', async () => {
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AA',
        annotations: [],
        primerBindings: [{ primerId: 'primer-a', start: 0, end: 2, strand: 1 }],
      },
    });
    const before = useSequenceStore.getState();
    const capture = before.captureForSave(DOCUMENT_ID);
    expect(capture?.pendingPrimerBindings).toHaveLength(1);
    const complete = vi.fn();
    const result = await saveSequenceDocumentWithCompletion({
      kind: 'write',
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      readOnly: true,
      complete,
    });
    expect(result.persistence).toEqual({
      ok: true,
      outcome: 'unchanged',
      attempts: 0,
      wrote: false,
    });
    expect(result.publication).toEqual({ status: 'not-attempted' });
    expect(complete).not.toHaveBeenCalled();
    expect(workflowFail).not.toHaveBeenCalled();
    expect(workflowComplete).toHaveBeenCalledExactlyOnceWith({
      attemptCount: 0,
      wrote: false,
      dirty: true,
      capturedRevision: useSequenceStore.getState().sequenceVersions[DOCUMENT_ID],
      acknowledgedRevision: useSequenceStore.getState().savedVersions[DOCUMENT_ID],
      revisionRelation: 'unchanged',
      recordWriteStatus: 'existing',
      recordHistoryStatus: 'not_attempted',
      recordProjectionStatus: 'not_attempted',
      valueDelivered: false,
      status: 'success',
      outcomeKind: 'unchanged',
    });
    expect(useSequenceStore.getState()).toBe(before);
    expect(useSequenceStore.getState().captureForSave(DOCUMENT_ID)).toEqual(capture);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(saveSequenceDocument).not.toHaveBeenCalled();
    expect(nativeSave).not.toHaveBeenCalled();
  });

  it('preserves an ordinary read-only draft without writing or publishing a completion', async () => {
    const baseline = useSequenceStore.getState().savedSequences[DOCUMENT_ID];
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AA',
        annotations: [],
        primerBindings: [{ primerId: 'primer-a', start: 0, end: 2, strand: 1 }],
      },
    });
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    const capturedState = useSequenceStore.getState();
    const capture = capturedState.captureForSave(DOCUMENT_ID);
    expect(capture?.pendingPrimerBindings).toHaveLength(1);
    const beforeWrite = vi.fn();
    const onPersisted = vi.fn();
    const persistPendingPrimerBindings = vi.fn<PersistBindings>();

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      readOnly: true,
      beforeWrite,
      onPersisted,
      persistPendingPrimerBindings,
    });

    expect(result).toEqual({ ok: true, outcome: 'unchanged', attempts: 0, wrote: false });
    const state = useSequenceStore.getState();
    expect(state).toBe(capturedState);
    expect(state.savedSequences[DOCUMENT_ID]).toBe(baseline);
    expect(state.sequences[DOCUMENT_ID]).toBe(capturedState.sequences[DOCUMENT_ID]);
    expect(state.isDirty(DOCUMENT_ID)).toBe(true);
    expect(state.captureForSave(DOCUMENT_ID)).toEqual(capture);
    expect(saveSequenceDocument).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(persistPendingPrimerBindings).not.toHaveBeenCalled();
    expect(onPersisted).not.toHaveBeenCalled();
  });

  it('joins each native capture to its binding checksum before acknowledging a newer edit', async () => {
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AA',
        annotations: [],
        primerBindings: [{ primerId: 'primer-a', start: 0, end: 2, strand: 1 }],
      },
    });
    const first = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!first) throw new Error('Initial dirty capture missing');
    const requests: SequenceDocumentSaveInput[] = [];
    const checksums = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];
    const onPersisted = vi.fn();
    saveSequenceDocument.mockImplementation(async (input: SequenceDocumentSaveInput) => {
      requests.push(structuredClone(input));
      if (requests.length === 1) {
        useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
          type: 'SET_CURSOR',
          position: first.sequence.sequence.length,
        });
        useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
          type: 'INSERT_FRAGMENT',
          fragment: {
            sequence: 'CC',
            annotations: [],
            primerBindings: [{ primerId: 'primer-b', start: 0, end: 2, strand: -1 }],
          },
        });
        expect(useSequenceStore.getState().savedSequences[DOCUMENT_ID]?.sequence).toBe('ATGC');
      } else {
        expect(useSequenceStore.getState().savedSequences[DOCUMENT_ID]?.sequence).toBe(
          first.sequence.sequence
        );
      }
      expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
      expect(onPersisted).not.toHaveBeenCalled();
      return {
        status: 'saved',
        fileSha256: checksums[requests.length - 1],
        eventId: `native-event-${requests.length}`,
        lineage: 'recorded',
      } satisfies SequenceDocumentSaveResult;
    });
    const persistPendingPrimerBindings = vi.fn<PersistBindings>(async () => {
      expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
      expect(onPersisted).not.toHaveBeenCalled();
    });

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      persistPendingPrimerBindings,
      onPersisted,
    });

    expect(result).toEqual({
      ok: true,
      outcome: 'saved',
      attempts: 2,
      wrote: true,
      writtenRevision: useSequenceStore.getState().savedVersions[DOCUMENT_ID],
    });
    expect(requests.map(({ capture }) => capture.sequence.sequence)).toEqual([
      first.sequence.sequence,
      `${first.sequence.sequence}CC`,
    ]);
    expect(
      requests.map(({ documentId, sourcePath, capture }) => ({
        documentId,
        sourcePath,
        baseline: capture.draftBaseline,
        lineage: capture.draftLineageId,
      }))
    ).toEqual(
      [1, 2].map(() => ({
        documentId: DOCUMENT_ID,
        sourcePath: SOURCE_PATH,
        baseline: first.draftBaseline,
        lineage: first.draftLineageId,
      }))
    );
    expect(persistPendingPrimerBindings.mock.calls.map(([, context]) => context)).toEqual(
      checksums.map((expectedFileSha256) => ({
        draftLineageId: first.draftLineageId,
        expectedFileSha256,
      }))
    );
    expect(persistPendingPrimerBindings.mock.calls.map(([bindings]) => bindings)).toEqual([
      first.pendingPrimerBindings,
      [
        ...first.pendingPrimerBindings,
        {
          pendingId: expect.any(String),
          primerId: 'primer-b',
          start: first.sequence.sequence.length,
          end: first.sequence.sequence.length + 2,
          strand: -1,
        },
      ],
    ]);
    const state = useSequenceStore.getState();
    expect(state.savedSequences[DOCUMENT_ID]?.sequence).toBe(`${first.sequence.sequence}CC`);
    expect(state.savedVersions[DOCUMENT_ID]).toBe(state.sequenceVersions[DOCUMENT_ID]);
    expect(state.captureForSave(DOCUMENT_ID)?.pendingPrimerBindings).toEqual([]);
    expect(state.isDirty(DOCUMENT_ID)).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(onPersisted).toHaveBeenCalledOnce();
  });

  it('retains a partially saved primer capture for an exact retry without premature completion', async () => {
    const baseline = useSequenceStore.getState().savedSequences[DOCUMENT_ID];
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AA',
        annotations: [],
        primerBindings: [{ primerId: 'primer-a', start: 0, end: 2, strand: 1 }],
      },
    });
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('Initial primer capture missing');
    const fileSha256 = `sha256:${'3'.repeat(64)}`;
    saveSequenceDocument.mockResolvedValue({
      status: 'saved',
      fileSha256,
      eventId: 'native-partial-save',
      lineage: 'recorded',
    } satisfies SequenceDocumentSaveResult);
    const failure = new Error('synthetic primer attachment refused after the native write');
    const persistPendingPrimerBindings = vi
      .fn<PersistBindings>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const onPersisted = vi.fn();
    const options = {
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      persistPendingPrimerBindings,
      onPersisted,
    };

    const failed = await persistSequenceDocument(options);

    expect(failed).toMatchObject({
      ok: false,
      outcome: 'failed',
      attempts: 1,
      wrote: true,
      error: { code: 'primer_bindings_failed', cause: failure },
    });
    expect(useSequenceStore.getState().savedSequences[DOCUMENT_ID]).toBe(baseline);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(useSequenceStore.getState().captureForSave(DOCUMENT_ID)).toEqual(capture);
    expect(onPersisted).not.toHaveBeenCalled();

    await expect(persistSequenceDocument(options)).resolves.toEqual({
      ok: true,
      outcome: 'saved',
      attempts: 1,
      wrote: true,
      writtenRevision: capture.revision,
    });

    expect(saveSequenceDocument).toHaveBeenCalledTimes(2);
    expect(saveSequenceDocument.mock.calls[0]).toEqual(saveSequenceDocument.mock.calls[1]);
    expect(persistPendingPrimerBindings).toHaveBeenCalledTimes(2);
    expect(persistPendingPrimerBindings.mock.calls).toEqual([
      [
        capture.pendingPrimerBindings,
        { draftLineageId: capture.draftLineageId, expectedFileSha256: fileSha256 },
      ],
      [
        capture.pendingPrimerBindings,
        { draftLineageId: capture.draftLineageId, expectedFileSha256: fileSha256 },
      ],
    ]);
    const state = useSequenceStore.getState();
    expect(state.savedSequences[DOCUMENT_ID]?.sequence).toBe(capture.sequence.sequence);
    expect(state.savedVersions[DOCUMENT_ID]).toBe(state.sequenceVersions[DOCUMENT_ID]);
    expect(state.captureForSave(DOCUMENT_ID)?.pendingPrimerBindings).toEqual([]);
    expect(state.isDirty(DOCUMENT_ID)).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(onPersisted).toHaveBeenCalledOnce();
  });

  it('bounds repeated racing edits and reports that newer work remains dirty', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    let race = 0;
    writeTextFile.mockImplementation(async () => {
      race += 1;
      useSequenceStore.getState().addAnnotation(DOCUMENT_ID, {
        ...annotation,
        name: `race-${race}`,
      });
    });

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected racing-edit result');
    expect(result.error.code).toBe('racing_edits');
    expect(result.attempts).toBe(3);
    expect(writeTextFile).toHaveBeenCalledTimes(3);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
  });

  it('persists bindings added by a newer rich paste before acknowledging the retried save', async () => {
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AA',
        annotations: [],
        primerBindings: [{ primerId: 'primer-a', start: 0, end: 2, strand: 1 }],
      },
    });
    const first = useSequenceStore.getState().captureForSave(DOCUMENT_ID)!;
    const batches: EditorPastePrimerBinding[][] = [];
    const persistPendingPrimerBindings = vi.fn(async (bindings: EditorPastePrimerBinding[]) => {
      batches.push(structuredClone(bindings));
      if (batches.length === 1) {
        useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
          type: 'SET_CURSOR',
          position: first.sequence.sequence.length,
        });
        useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
          type: 'INSERT_FRAGMENT',
          fragment: {
            sequence: 'CC',
            annotations: [],
            primerBindings: [{ primerId: 'primer-b', start: 0, end: 2, strand: -1 }],
          },
        });
      }
    });

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      persistPendingPrimerBindings,
    });

    expect(result).toEqual({
      ok: true,
      outcome: 'saved',
      attempts: 2,
      wrote: true,
      writtenRevision: useSequenceStore.getState().savedVersions[DOCUMENT_ID],
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual(first.pendingPrimerBindings);
    expect(batches[1]).toEqual([
      ...first.pendingPrimerBindings,
      {
        pendingId: expect.any(String),
        primerId: 'primer-b',
        start: first.sequence.sequence.length,
        end: first.sequence.sequence.length + 2,
        strand: -1,
      },
    ]);
    const state = useSequenceStore.getState();
    expect(state.savedSequences[DOCUMENT_ID]?.sequence).toBe(`${first.sequence.sequence}CC`);
    expect(state.captureForSave(DOCUMENT_ID)?.pendingPrimerBindings).toEqual([]);
    expect(state.isDirty(DOCUMENT_ID)).toBe(false);
  });

  it('keeps a newer capture dirty when its additional pasted bindings fail to persist', async () => {
    useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
      type: 'INSERT_FRAGMENT',
      fragment: {
        sequence: 'AA',
        annotations: [],
        primerBindings: [{ primerId: 'primer-a', start: 0, end: 2, strand: 1 }],
      },
    });
    const failure = new Error('second binding write refused');
    const persistPendingPrimerBindings = vi
      .fn()
      .mockImplementationOnce(async () => {
        const current = useSequenceStore.getState().captureForSave(DOCUMENT_ID)!;
        useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
          type: 'SET_CURSOR',
          position: current.sequence.sequence.length,
        });
        useSequenceStore.getState().dispatchEdit(DOCUMENT_ID, {
          type: 'INSERT_FRAGMENT',
          fragment: {
            sequence: 'CC',
            annotations: [],
            primerBindings: [{ primerId: 'primer-b', start: 0, end: 2, strand: -1 }],
          },
        });
      })
      .mockRejectedValueOnce(failure);

    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      persistPendingPrimerBindings,
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: 'failed',
      attempts: 2,
      wrote: true,
      error: { code: 'primer_bindings_failed', cause: failure },
    });
    const state = useSequenceStore.getState();
    expect(state.isDirty(DOCUMENT_ID)).toBe(true);
    expect(
      state.captureForSave(DOCUMENT_ID)?.pendingPrimerBindings.map((binding) => binding.primerId)
    ).toEqual(['primer-a', 'primer-b']);
  });

  it('holds first managed annotation stamping until the editor has the returned identity', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    exists.mockResolvedValue(true);
    let finishSave:
      | ((result: {
          status: 'saved';
          fileSha256: string;
          eventId: string;
          lineage: 'recorded';
          managedAnnotationIds: string[];
        }) => void)
      | undefined;
    saveSequenceDocument.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        })
    );
    const saving = persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
    });
    await vi.waitFor(() => expect(saveSequenceDocument).toHaveBeenCalledOnce());
    expect(() =>
      useSequenceStore.getState().updateAnnotation(DOCUMENT_ID, 0, {
        ...annotation,
        name: 'racing rename',
        color: '#000000',
      })
    ).toThrow(/workspace update/i);
    finishSave?.({
      status: 'saved',
      fileSha256: `sha256:${'0'.repeat(64)}`,
      eventId: 'managed-revision',
      lineage: 'recorded',
      managedAnnotationIds: [id],
    });
    await expect(saving).resolves.toMatchObject({ ok: true, outcome: 'saved' });
    useSequenceStore.getState().updateAnnotation(DOCUMENT_ID, 0, {
      ...annotation,
      name: 'later rename',
      color: '#000000',
    });
    expect(
      useSequenceStore.getState().captureForSave(DOCUMENT_ID)?.sequence.annotations[0].qualifiers
        ?.dnaforge_ann_id
    ).toEqual([id]);
  });
  it('reports a completed fallback file write when its checksum fails without premature Git completion', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('Expected a dirty capture');
    const checksumError = new Error('synthetic checksum refusal');
    checksumOutcome.mockReturnValueOnce({ ok: false, error: checksumError });
    const onPersisted = vi.fn();
    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      onPersisted,
    });
    expect(result).toMatchObject({
      ok: false,
      wrote: true,
      writtenRevision: capture.revision,
      error: { code: 'write_receipt_failed', cause: checksumError },
    });
    expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(
      SOURCE_PATH,
      expect.stringContaining('saved-feature')
    );
    expect(onPersisted).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(useSequenceStore.getState().savedSequences[DOCUMENT_ID]?.annotations).toEqual([]);
  });

  it('preserves a failed second write and the separate failed completion of the first write', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    if (!capture) throw new Error('Expected a dirty capture');
    const writeError = new Error('synthetic second-write refusal');
    const completionError = new Error('synthetic completion refusal');
    saveSequenceDocument
      .mockImplementationOnce(async () => {
        useSequenceStore.getState().addAnnotation(DOCUMENT_ID, { ...annotation, name: 'newer' });
        return {
          status: 'saved',
          fileSha256: `sha256:${'5'.repeat(64)}`,
          eventId: 'synthetic-first-write',
          lineage: 'recorded',
        } satisfies SequenceDocumentSaveResult;
      })
      .mockRejectedValueOnce(writeError);
    const onPersisted = vi.fn().mockRejectedValueOnce(completionError);
    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      onPersisted,
    });
    expect(result).toMatchObject({
      ok: false,
      wrote: true,
      writtenRevision: capture.revision,
      attempts: 2,
      error: { code: 'write_failed' },
    });
    if (result.ok || !(result.error.cause instanceof SequenceSaveCombinedError))
      throw new Error('Expected both failures');
    expect(result.error.cause.errors).toEqual([writeError, completionError]);
    expect(onPersisted).toHaveBeenCalledOnce();
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
  });
  it('does not call a dirty ordinary document without a writable source unchanged', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const result = await persistSequenceDocument({
      document: { documentId: DOCUMENT_ID, sourcePath: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.wrote).toBe(false);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(saveSequenceDocument).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('joins repeated ordinary Save while one native captured revision is pending', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    let settle!: (value: SequenceDocumentSaveResult) => void;
    saveSequenceDocument.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const complete = vi.fn().mockResolvedValue({ status: 'not-a-repository' });
    const options = {
      kind: 'write' as const,
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      complete,
    };
    const first = saveSequenceDocumentWithCompletion(options);
    const second = saveSequenceDocumentWithCompletion(options);
    await vi.waitFor(() => expect(saveSequenceDocument).toHaveBeenCalled());
    expect(saveSequenceDocument).toHaveBeenCalledOnce();
    settle({
      status: 'saved',
      fileSha256: `sha256:${'a'.repeat(64)}`,
      eventId: 'native-revision',
      lineage: 'recorded',
    });
    await expect(first).resolves.toMatchObject({ persistence: { ok: true, outcome: 'saved' } });
    await expect(second).resolves.toMatchObject({ persistence: { ok: true, outcome: 'saved' } });
    expect(complete).toHaveBeenCalledOnce();
    expect(
      workflowBegin.mock.calls.filter(
        ([input]) => input.workflow === 'content' && input.action === 'save'
      )
    ).toHaveLength(1);
    expect(
      workflowBegin.mock.calls.filter(
        ([input]) => input.workflow === 'sequence_edit' && input.action === 'save'
      )
    ).toHaveLength(1);
    expect(
      workflowComplete.mock.calls.filter(([result]) => result.attemptCount !== undefined)
    ).toHaveLength(1);
  });

  it('reports unchanged and saved revision boundaries without scientific contents or paths', async () => {
    const complete = vi.fn().mockResolvedValue({ status: 'not-a-repository' });
    const options = {
      kind: 'write' as const,
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      complete,
    };
    await saveSequenceDocumentWithCompletion(options);
    expect(workflowComplete).toHaveBeenLastCalledWith(
      expect.objectContaining({ wrote: false, attemptCount: 0, revisionRelation: 'unchanged' })
    );
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    await saveSequenceDocumentWithCompletion(options);
    expect(workflowComplete).toHaveBeenLastCalledWith(
      expect.objectContaining({
        wrote: true,
        dirty: false,
        attemptCount: 1,
        revisionRelation: 'acknowledged',
        stateRevision: useSequenceStore.getState().savedVersions[DOCUMENT_ID],
      })
    );
    const payload = JSON.stringify([workflowBegin.mock.calls, workflowComplete.mock.calls]);
    for (const privateValue of [DOCUMENT_ID, SOURCE_PATH, annotation.name, 'ATGC'])
      expect(payload).not.toContain(privateValue);
  });
  it.each(['native', 'legacy'] as const)(
    'reports a closed saved outcome from the %s producer with its exact write and history metadata',
    async (route) => {
      useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
      const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID)!;
      if (route === 'native') {
        nativeClient.enabled = true;
        nativeSave.mockImplementationOnce(async () => {
          useSequenceStore.getState().acknowledgeSaved(DOCUMENT_ID, capture);
          return {
            saved: true,
            dirty: false,
            version: capture.revision,
            workspaceRoot: '/captured-project',
            history: { status: 'committed' },
          };
        });
      }
      const complete = vi
        .fn()
        .mockResolvedValue(
          route === 'native'
            ? { status: 'committed', repositoryRoot: '/captured-project' }
            : { status: 'not-a-repository' }
        );
      const result = await saveSequenceDocumentWithCompletion({
        kind: 'write',
        document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
        complete,
      });
      expect(result.persistence).toMatchObject({ ok: true, outcome: 'saved', wrote: true });
      const terminal = workflowComplete.mock.calls
        .map(([metadata]) => metadata)
        .filter((metadata) => metadata.attemptCount !== undefined);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        status: 'saved',
        outcomeKind: 'saved',
        wrote: true,
        dirty: false,
        attemptCount: 1,
        revisionRelation: 'acknowledged',
        recordWriteStatus: 'written',
        recordHistoryStatus: route === 'native' ? 'committed' : 'not_applicable',
        recordProjectionStatus: 'ready',
        valueDelivered: true,
      });
      for (const privateValue of [
        DOCUMENT_ID,
        SOURCE_PATH,
        annotation.name,
        capture.sequence.sequence,
      ])
        expect(JSON.stringify(terminal)).not.toContain(privateValue);
      expect(complete).toHaveBeenCalledOnce();
    }
  );

  it('reports unchanged separately when ordinary Save writes no revision', async () => {
    const complete = vi.fn();
    const result = await saveSequenceDocumentWithCompletion({
      kind: 'write',
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      complete,
    });
    expect(result.persistence).toMatchObject({ ok: true, outcome: 'unchanged', wrote: false });
    expect(workflowComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: 'success',
        outcomeKind: 'unchanged',
        wrote: false,
        attemptCount: 0,
        revisionRelation: 'unchanged',
        recordWriteStatus: 'existing',
        valueDelivered: false,
      })
    );
    expect(nativeSave).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps refused writes out of saved outcome observations and retains the exact draft', async () => {
    useSequenceStore.getState().addAnnotation(DOCUMENT_ID, annotation);
    const capture = useSequenceStore.getState().captureForSave(DOCUMENT_ID);
    saveSequenceDocument.mockRejectedValueOnce(new Error('Synthetic native write refusal'));
    const complete = vi.fn();
    const result = await saveSequenceDocumentWithCompletion({
      kind: 'write',
      document: { documentId: DOCUMENT_ID, sourcePath: SOURCE_PATH },
      complete,
    });
    expect(result.persistence).toMatchObject({ ok: false, wrote: false });
    expect(
      workflowComplete.mock.calls.filter(([metadata]) => metadata.outcomeKind === 'saved')
    ).toEqual([]);
    expect(workflowFail).toHaveBeenLastCalledWith(
      'write_failed',
      expect.objectContaining({ status: 'failed', wrote: false, valueDelivered: false })
    );
    expect(useSequenceStore.getState().captureForSave(DOCUMENT_ID)).toEqual(capture);
    expect(useSequenceStore.getState().isDirty(DOCUMENT_ID)).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });
});
