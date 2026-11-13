import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReferenceVerificationState, VerificationTrack } from '../types';

const { reference, mockComputeReferenceHash, mockPublish, mockWrite } = vi.hoisted(() => ({
  reference: { checksum: '', sequence: '' },
  mockComputeReferenceHash: vi.fn(),
  mockPublish: vi.fn(),
  mockWrite: vi.fn(),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: vi.fn(async (path: string) => {
        throw new Error(`ENOENT: ${path}`);
      }),
      writeTextFile: vi.fn(),
      exists: vi.fn(async () => false),
      watchFile: vi.fn().mockResolvedValue(undefined),
      unwatchFile: vi.fn().mockResolvedValue(undefined),
    },
    on: vi.fn(() => vi.fn()),
  }),
}));

vi.mock('../utils/hash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/hash')>()),
  computeReferenceHash: mockComputeReferenceHash,
}));

vi.mock('../utils/alignment-history-persist', () => ({
  publishManagedAlignmentHistory: mockPublish,
  writeAlignmentHistory: mockWrite,
  readAlignmentHistory: vi.fn(async () => null),
}));

vi.mock('../../../utils/debug-log', () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

vi.mock('../utils/alignment-api', () => ({
  callAlignmentApi: vi.fn(),
  readSequenceFile: vi.fn(async () => reference.sequence),
  readReferenceAnnotations: vi.fn(),
  readReferenceForMutations: vi.fn(async () => ({
    annotations: [],
    geneticCode: 1,
    circular: false,
  })),
}));

import { useVerificationStore } from '../store';
import { registerWorkspaceEditorBlocker } from '../../../services/workspace-editor-mutation-state';
import { computePairwiseReferenceRevision } from '../utils/hash';

const DOCUMENT_ID = 'edited-reference';
const ALIGNED_CHECKSUM = 'sha256:aligned-reference';
const EDITED_CHECKSUM = 'sha256:edited-reference';
const ALIGNED_SEQUENCE = 'ACGTACGTAC';

async function track(tested: boolean): Promise<VerificationTrack> {
  return {
    id: 'track-1',
    queryPath: 'contents/query.fasta',
    label: 'query',
    alignment: {
      alignedReference: ALIGNED_SEQUENCE,
      alignedQuery: ALIGNED_SEQUENCE,
      identity: 100,
      coverageStart: 0,
      coverageEnd: ALIGNED_SEQUENCE.length,
      algorithm: 'MAFFT',
    },
    mutations: [],
    status: 'pass',
    alignedAt: '2026-10-29T05:03:13.000Z',
    ...(tested
      ? {
          testedReference: {
            fileSha256: ALIGNED_CHECKSUM,
            sequenceRevision: await computePairwiseReferenceRevision(ALIGNED_SEQUENCE),
            topology: 'linear' as const,
            checkpointId: null,
          },
        }
      : {}),
  };
}

async function attachResult(referencePath: string, tested: boolean): Promise<void> {
  useVerificationStore.getState().registerReferenceSource(DOCUMENT_ID, referencePath);
  const state: ReferenceVerificationState = {
    documentId: DOCUMENT_ID,
    activeSessionId: 'session-1',
    sessions: [
      {
        id: 'session-1',
        name: 'Review',
        createdAt: '2026-10-29T05:03:07.000Z',
        mode: 'one-per-clone',
        tracks: [await track(tested)],
        alignmentOperation: {
          id: 'operation-1',
          inputRevision: 'pairwise-session-alignment-v1:sha256:input',
          status: 'succeeded',
          queries: [{ id: 'track-1', queryPath: 'contents/query.fasta', label: 'query' }],
        },
      },
    ],
  };
  useVerificationStore.setState((current) => ({
    verificationState: { ...current.verificationState, [DOCUMENT_ID]: state },
    referenceFileChecksums: { ...current.referenceFileChecksums, [DOCUMENT_ID]: ALIGNED_CHECKSUM },
    staleReferences: { ...current.staleReferences, [DOCUMENT_ID]: false },
  }));
}

function saveReference(checksum: string, sequence: string): void {
  reference.checksum = checksum;
  reference.sequence = sequence;
}

async function settleSaves(action: () => void): Promise<number> {
  const save = useVerificationStore.getState().saveSidecar;
  const saves: Promise<void>[] = [];
  useVerificationStore.setState({
    saveSidecar: (...args) => {
      const saved = save(...args);
      saves.push(saved);
      return saved;
    },
  });
  try {
    action();
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(saves);
    return saves.length;
  } finally {
    useVerificationStore.setState({ saveSidecar: save });
  }
}

function advanceAutosave(): Promise<number> {
  return settleSaves(() => undefined);
}

async function runAutosave(): Promise<void> {
  expect(await advanceAutosave()).toBe(1);
}

function savedChecksums(): string[] {
  return [...mockPublish.mock.calls, ...mockWrite.mock.calls].map(
    ([, content]) => JSON.parse(content as string).reference.checksum as string
  );
}

describe('the alignment autosave racing a reference save', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockPublish.mockReset().mockImplementation(async (path: string) => path.startsWith('/hosted/'));
    mockWrite.mockReset().mockImplementation(async (path: string) => path);
    mockComputeReferenceHash.mockReset().mockImplementation(async () => reference.checksum);
    saveReference(ALIGNED_CHECKSUM, ALIGNED_SEQUENCE);
    useVerificationStore.setState({
      verificationState: {},
      sessionViewPreferences: {},
      staleReferences: {},
      staleSessionIds: {},
      referenceFileChecksums: {},
      pendingTrackIds: {},
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not attach a web result fingerprinted with an edit it has not checked', async () => {
    await attachResult('/hosted/workspace/sequences/edited-reference/edited-reference.gb', true);
    saveReference(EDITED_CHECKSUM, `GGGGG${ALIGNED_SEQUENCE}`);
    await runAutosave();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
    expect(useVerificationStore.getState().staleReferences[DOCUMENT_ID]).toBe(true);
    expect(useVerificationStore.getState().referenceFileChecksums[DOCUMENT_ID]).toBe(
      ALIGNED_CHECKSUM
    );
  });

  it('keeps an older-format session out of date after a same-length desktop edit', async () => {
    await attachResult('/workspace/sequences/edited-reference.gb', false);
    saveReference(EDITED_CHECKSUM, 'TCGTACGTAC');
    await runAutosave();
    await useVerificationStore.getState().checkStaleness(DOCUMENT_ID);

    expect(mockWrite).not.toHaveBeenCalled();
    expect(useVerificationStore.getState().staleReferences[DOCUMENT_ID]).toBe(true);
    expect(useVerificationStore.getState().referenceFileChecksums[DOCUMENT_ID]).toBe(
      ALIGNED_CHECKSUM
    );
  });

  it('still records a new fingerprint when the edit leaves the alignment current', async () => {
    await attachResult('/hosted/workspace/sequences/edited-reference/edited-reference.gb', true);
    saveReference(EDITED_CHECKSUM, ALIGNED_SEQUENCE);
    await runAutosave();

    expect(savedChecksums()).toEqual([EDITED_CHECKSUM]);
    expect(useVerificationStore.getState().staleReferences[DOCUMENT_ID]).toBe(false);
    expect(useVerificationStore.getState().referenceFileChecksums[DOCUMENT_ID]).toBe(
      EDITED_CHECKSUM
    );
  });

  it('keeps saving a web review change after an annotation-only edit', async () => {
    await attachResult('/hosted/workspace/sequences/edited-reference/edited-reference.gb', true);
    await runAutosave();
    mockPublish.mockClear();
    mockWrite.mockClear();
    saveReference(EDITED_CHECKSUM, ALIGNED_SEQUENCE);

    await settleSaves(() =>
      useVerificationStore
        .getState()
        .toggleMutationChecked(DOCUMENT_ID, 'session-1', 'track-1', 'mutation-1')
    );

    expect(mockPublish).not.toHaveBeenCalled();
    expect(
      mockWrite.mock.calls.map(
        ([, content]) =>
          JSON.parse(content as string).sessions[0].tracks[0].checkedMutations as string[]
      )
    ).toContainEqual(['mutation-1']);
    expect(useVerificationStore.getState().staleReferences[DOCUMENT_ID]).toBe(false);
    expect(useVerificationStore.getState().referenceFileChecksums[DOCUMENT_ID]).toBe(
      EDITED_CHECKSUM
    );
  });
});

describe('the alignment autosave while its reference is being edited', () => {
  const HOSTED_REFERENCE = '/hosted/workspace/sequences/edited-reference/edited-reference.gb';
  const attached = { content: '' };
  const saved: string[] = [];
  const editor: { state: 'clean' | 'dirty' | 'saving' } = { state: 'clean' };
  let releaseEditor: () => void = () => undefined;

  const withoutSavedAt = (content: string) =>
    content ? JSON.stringify({ ...JSON.parse(content), savedAt: null }) : '';

  function enterEditModeAndType(): void {
    useVerificationStore
      .getState()
      .setSessionViewPreferences(DOCUMENT_ID, 'session-1', { alignmentVisible: false });
    editor.state = 'dirty';
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = async (path: string, content: string) => {
      if (withoutSavedAt(attached.content) !== withoutSavedAt(content)) {
        saved.push(content);
        attached.content = content;
      }
      return path;
    };
    mockPublish.mockReset().mockImplementation(async (path: string, content: string) => {
      await store(path, content);
      return true;
    });
    mockWrite.mockReset().mockImplementation(store);
    mockComputeReferenceHash.mockReset().mockImplementation(async () => reference.checksum);
    saveReference(ALIGNED_CHECKSUM, ALIGNED_SEQUENCE);
    useVerificationStore.setState({
      verificationState: {},
      sessionViewPreferences: {},
      staleReferences: {},
      staleSessionIds: {},
      referenceFileChecksums: {},
      pendingTrackIds: {},
    });
    attached.content = '';
    await attachResult(HOSTED_REFERENCE, true);
    await useVerificationStore.getState().saveSidecar(DOCUMENT_ID);
    saved.length = 0;
    editor.state = 'clean';
    releaseEditor = registerWorkspaceEditorBlocker(() => ({
      entityId: DOCUMENT_ID,
      path: HOSTED_REFERENCE,
      state: editor.state,
    }));
  });

  afterEach(() => {
    releaseEditor();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('does not save the history mid-edit, and drops the save once the edit makes it out of date', async () => {
    enterEditModeAndType();
    await advanceAutosave();
    expect(saved).toEqual([]);

    editor.state = 'saving';
    saveReference(EDITED_CHECKSUM, `GGGGG${ALIGNED_SEQUENCE}`);
    await advanceAutosave();
    await useVerificationStore.getState().checkStaleness(DOCUMENT_ID);
    editor.state = 'clean';
    expect(await advanceAutosave()).toBe(0);

    expect(saved).toEqual([]);
    expect(useVerificationStore.getState().staleReferences[DOCUMENT_ID]).toBe(true);
  });

  it('saves the waiting change once the edit is discarded', async () => {
    enterEditModeAndType();
    await advanceAutosave();
    expect(saved).toEqual([]);

    editor.state = 'clean';
    expect(await advanceAutosave()).toBe(1);

    expect(
      saved.map(
        (content) => JSON.parse(content).viewPreferences['session-1'].alignmentVisible as boolean
      )
    ).toEqual([false]);
  });
});
