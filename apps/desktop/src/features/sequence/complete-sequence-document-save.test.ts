import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';

const mocks = vi.hoisted(() => ({
  gitRepoRoot: vi.fn<(sourcePath: string) => Promise<string | null>>(),
  gitCommitFile:
    vi.fn<(sourcePath: string, message: string, repositoryRoot: string) => Promise<void>>(),
  gitCommitPaths: vi.fn(),
  exists: vi.fn(),
  readTextFile: vi.fn(),
  commitSequenceDocumentHistory: vi.fn(),
  checkStaleness: vi.fn<(documentId: string) => Promise<void>>(),
  emitLimsRegistrationChanged: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock('../workspace-session/public/electron-session', () => ({
  refreshElectronWorkspaceSessionForPath: mocks.refreshSession,
}));

vi.mock('../workspace/git', () => ({
  gitRepoRoot: mocks.gitRepoRoot,
  gitCommitFile: mocks.gitCommitFile,
  gitCommitPaths: mocks.gitCommitPaths,
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      exists: mocks.exists,
      readTextFile: mocks.readTextFile,
      commitSequenceDocumentHistory: mocks.commitSequenceDocumentHistory,
    },
  }),
}));

vi.mock('../alignment-manager/store', () => ({
  useVerificationStore: {
    getState: () => ({ checkStaleness: mocks.checkStaleness }),
  },
}));

vi.mock('../lims/events', () => ({
  emitLimsRegistrationChanged: mocks.emitLimsRegistrationChanged,
}));

import { completeSequenceDocumentSave } from './complete-sequence-document-save';
import {
  completeSavedSequenceDocument,
  SequenceDocumentSaveProjectionError,
} from '../../services/sequence-document-save-completion';

const document = {
  documentId: 'sequence-document-1',
  sourcePath: '/workspace/construct.gb',
};

describe('completeSequenceDocumentSave', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gitRepoRoot.mockResolvedValue('/workspace');
    mocks.gitCommitFile.mockResolvedValue();
    mocks.gitCommitPaths.mockResolvedValue(undefined);
    mocks.exists.mockResolvedValue(false);
    mocks.checkStaleness.mockResolvedValue();
    mocks.refreshSession.mockResolvedValue(undefined);
  });

  it('uses the exact native write acknowledgement for history and reports its own native action', async () => {
    const receipt = {
      nativeActionId: '550e8400-e29b-41d4-a716-446655440001',
      revisionId: 'native-revision',
      contentSha256: 'a'.repeat(64),
      wrote: true,
    };
    const nativeActionId = '550e8400-e29b-41d4-a716-446655440002';
    mocks.commitSequenceDocumentHistory.mockResolvedValue({ status: 'committed', nativeActionId });
    expect(await completeSequenceDocumentSave(document, 'Save exact revision', receipt)).toEqual({
      status: 'committed',
      repositoryRoot: '/workspace',
      nativeActionId,
    });
    expect(mocks.commitSequenceDocumentHistory).toHaveBeenCalledExactlyOnceWith({
      ...document,
      ...receipt,
      message: 'Save exact revision',
    });
    expect(mocks.gitCommitFile).not.toHaveBeenCalled();
    expect(mocks.gitCommitPaths).not.toHaveBeenCalled();
    expect(mocks.refreshSession).toHaveBeenCalledExactlyOnceWith(document.sourcePath, null);
  });

  it('commits through the workspace Git service before publishing every post-write signal', async () => {
    const calls: string[] = [];
    mocks.gitRepoRoot.mockImplementation(async () => {
      calls.push('repository');
      return '/workspace';
    });
    mocks.gitCommitFile.mockImplementation(async () => {
      calls.push('commit');
    });
    mocks.checkStaleness.mockImplementation(async () => {
      calls.push('staleness');
    });
    mocks.emitLimsRegistrationChanged.mockImplementation(() => {
      calls.push('lims');
    });
    window.addEventListener(
      'waypoint:workspace-files-changed',
      () => calls.push('workspace-files-changed'),
      { once: true }
    );

    const result = await completeSequenceDocumentSave(document, 'Apply reviewed annotations');

    expect(result).toEqual({ status: 'committed', repositoryRoot: '/workspace' });
    expect(mocks.gitCommitFile).toHaveBeenCalledWith(
      '/workspace/construct.gb',
      'Apply reviewed annotations',
      '/workspace'
    );
    expect(calls).toEqual(['repository', 'commit', 'workspace-files-changed', 'staleness', 'lims']);
    expect(mocks.checkStaleness).toHaveBeenCalledWith('sequence-document-1');
    expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledWith({
      documentId: 'sequence-document-1',
      filePath: '/workspace/construct.gb',
    });
  });

  it('preserves non-repository saves as a distinct nonfatal outcome', async () => {
    mocks.gitRepoRoot.mockResolvedValue(null);

    const result = await completeSequenceDocumentSave(document, 'Auto-save construct.gb');

    expect(result).toEqual({ status: 'not-a-repository' });
    expect(mocks.gitCommitFile).not.toHaveBeenCalled();
    expect(mocks.checkStaleness).toHaveBeenCalledWith('sequence-document-1');
    expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce();
  });

  it.each(['accepted-object', 'native-capture'] as const)(
    'publishes passive completion from %s history without creating a second single-file commit',
    async (kind) => {
      expect(
        await completeSequenceDocumentSave(document, 'Save accepted sequence', {
          kind,
          repositoryRoot: '/workspace',
        })
      ).toEqual({ status: 'committed', repositoryRoot: '/workspace' });
      expect(mocks.gitRepoRoot).not.toHaveBeenCalled();
      expect(mocks.gitCommitFile).not.toHaveBeenCalled();
      expect(mocks.checkStaleness).toHaveBeenCalledWith(document.documentId);
      expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce();
    }
  );

  it('lets the sequencing owner supply its own staleness check without entering the sequence store', async () => {
    const checkSequencingStaleness = vi.fn<(documentId: string) => Promise<void>>();
    checkSequencingStaleness.mockResolvedValue();

    const result = await completeSavedSequenceDocument(
      document,
      'Apply reviewed sequencing mutations',
      checkSequencingStaleness
    );

    expect(result).toEqual({ status: 'committed', repositoryRoot: '/workspace' });
    expect(checkSequencingStaleness).toHaveBeenCalledExactlyOnceWith(document.documentId);
    expect(mocks.checkStaleness).not.toHaveBeenCalled();
    expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce();
  });

  it('publishes saved-file signals while awaiting the supplied staleness owner', async () => {
    let settleStaleness!: () => void;
    const pendingStaleness = new Promise<void>((resolve) => {
      settleStaleness = resolve;
    });
    mocks.checkStaleness.mockReturnValueOnce(pendingStaleness);
    let completed = false;
    const save = completeSequenceDocumentSave(document, 'Save sequence').then((result) => {
      completed = true;
      return result;
    });

    await vi.waitFor(() => expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    settleStaleness();

    await expect(save).resolves.toEqual({ status: 'committed', repositoryRoot: '/workspace' });
    expect(mocks.checkStaleness).toHaveBeenCalledExactlyOnceWith(document.documentId);
  });

  it('reports a real commit failure while still publishing that the saved file changed', async () => {
    const commitError = new Error('nothing to commit');
    mocks.gitCommitFile.mockRejectedValue(commitError);
    const changed = vi.fn();
    window.addEventListener('waypoint:workspace-files-changed', changed, { once: true });

    const result = await completeSequenceDocumentSave(document, 'Auto-save construct.gb');

    expect(result).toEqual({ status: 'commit-failed', error: commitError });
    expect(changed).toHaveBeenCalledOnce();
    expect(mocks.checkStaleness).toHaveBeenCalledWith('sequence-document-1');
    expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce();
  });

  it('retains a successful Git receipt when the staleness projection rejects', async () => {
    const projectionError = new Error('synthetic staleness refusal');
    mocks.checkStaleness.mockRejectedValueOnce(projectionError);
    const failure: unknown = await completeSequenceDocumentSave(document, 'Save sequence').then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(SequenceDocumentSaveProjectionError);
    if (!(failure instanceof SequenceDocumentSaveProjectionError))
      throw new Error('Expected the retained save completion');
    expect(failure.completion).toEqual({ status: 'committed', repositoryRoot: '/workspace' });
    expect(failure.cause).toBe(projectionError);
    expect(mocks.gitCommitFile).toHaveBeenCalledOnce();
    expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce();
  });

  it('retains the separate Git failure when a later projection also rejects', async () => {
    const commitError = new Error('synthetic Git refusal');
    const projectionError = new Error('synthetic staleness refusal');
    mocks.gitCommitFile.mockRejectedValueOnce(commitError);
    mocks.checkStaleness.mockRejectedValueOnce(projectionError);
    const failure: unknown = await completeSequenceDocumentSave(document, 'Save sequence').then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(SequenceDocumentSaveProjectionError);
    if (!(failure instanceof SequenceDocumentSaveProjectionError))
      throw new Error('Expected the retained save completion');
    expect(failure.completion).toEqual({ status: 'commit-failed', error: commitError });
    expect(failure.cause).toBe(projectionError);
    expect(mocks.gitCommitFile).toHaveBeenCalledOnce();
    expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce();
  });

  it('commits the package marker and immutable snapshots with a managed sequence save', async () => {
    const managed = { documentId: 'package-1', sourcePath: '/workspace/plasmid/plasmid.gb' };
    const marker = buildSequencePackageDocument({
      id: 'package-1',
      name: 'Plasmid',
      product: { file: 'plasmid.gb' },
      members: [
        {
          id: 'snapshot',
          role: 'sequence-snapshot',
          path: 'contents/sequence-snapshot-test.gb',
          replaceable: false,
          createdAt: '2026-09-29T00:00:00.000Z',
        },
      ],
    });
    mocks.exists.mockImplementation(
      async (path: string) =>
        path === '/workspace/plasmid/.forge/plasmid.json' ||
        path === '/workspace/plasmid/.forge/sequence-revision-publication.json'
    );
    mocks.readTextFile.mockResolvedValue(serializeSequencePackageDocument(marker));
    const result = await completeSequenceDocumentSave(managed, 'Save managed sequence');
    expect(result.status).toBe('committed');
    expect(mocks.gitCommitFile).not.toHaveBeenCalled();
    expect(mocks.gitCommitPaths).toHaveBeenCalledWith('/workspace', 'Save managed sequence', [
      'plasmid/plasmid.gb',
      'plasmid/.forge/plasmid.json',
      'plasmid/contents/sequence-snapshot-test.gb',
      'plasmid/.forge/sequence-revision-publication.json',
    ]);
  });
  it('settles pending staleness after synchronous LIMS failure and retains both errors and Git', async () => {
    const limsError = new Error('synthetic LIMS refusal');
    const stalenessError = new Error('synthetic staleness refusal');
    let rejectStaleness: ((error: unknown) => void) | undefined;
    mocks.checkStaleness.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStaleness = reject;
        })
    );
    mocks.emitLimsRegistrationChanged.mockImplementationOnce(() => {
      throw limsError;
    });
    let settled = false;
    const saving = completeSequenceDocumentSave(document, 'Save sequence').then(
      (result) => {
        settled = true;
        return result;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(mocks.emitLimsRegistrationChanged).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    if (!rejectStaleness) throw new Error('Pending staleness rejection missing');
    rejectStaleness(stalenessError);
    const failure: unknown = await saving;
    expect(failure).toBeInstanceOf(SequenceDocumentSaveProjectionError);
    if (!(failure instanceof SequenceDocumentSaveProjectionError))
      throw new Error('Expected retained projection errors');
    expect(failure.completion).toEqual({ status: 'committed', repositoryRoot: '/workspace' });
    expect(failure.failures).toEqual([
      { stage: 'lims', error: limsError },
      { stage: 'staleness', error: stalenessError },
    ]);
    expect(failure.cause).toBe(limsError);
    expect(mocks.gitCommitFile).toHaveBeenCalledOnce();
  });

  it('retains synchronous undefined failures from both projection owners', async () => {
    mocks.checkStaleness.mockImplementationOnce(() => {
      throw undefined;
    });
    mocks.emitLimsRegistrationChanged.mockImplementationOnce(() => {
      throw undefined;
    });
    const failure: unknown = await completeSequenceDocumentSave(document, 'Save sequence').catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(SequenceDocumentSaveProjectionError);
    if (!(failure instanceof SequenceDocumentSaveProjectionError))
      throw new Error('Expected retained projection failures');
    expect(failure.failures).toEqual([
      { stage: 'staleness', error: undefined },
      { stage: 'lims', error: undefined },
    ]);
    expect(failure.completion.status).toBe('committed');
  });

  it('retains the native History commit and its pending delivery when accepted workspace refresh fails', async () => {
    const receipt = {
      nativeActionId: '550e8400-e29b-41d4-a716-446655440001',
      revisionId: 'native-revision',
      contentSha256: 'a'.repeat(64),
      wrote: true,
    };
    const nativeActionId = '550e8400-e29b-41d4-a716-446655440002';
    const projectionError = new Error('Accepted read snapshot unavailable');
    mocks.commitSequenceDocumentHistory.mockResolvedValue({ status: 'committed', nativeActionId });
    mocks.refreshSession.mockRejectedValueOnce(projectionError);
    const failure: unknown = await completeSequenceDocumentSave(
      document,
      'Save sequence',
      receipt
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(SequenceDocumentSaveProjectionError);
    if (!(failure instanceof SequenceDocumentSaveProjectionError))
      throw new Error('Expected the retained native Save completion.');
    expect(failure.completion).toEqual({
      status: 'committed',
      repositoryRoot: '/workspace',
      nativeActionId,
    });
    expect(failure.cause).toBe(projectionError);
    expect(mocks.commitSequenceDocumentHistory).toHaveBeenCalledOnce();
    expect(mocks.refreshSession).toHaveBeenCalledExactlyOnceWith(document.sourcePath, null);
    expect(mocks.gitCommitFile).not.toHaveBeenCalled();
    expect(mocks.gitCommitPaths).not.toHaveBeenCalled();
  });
});
