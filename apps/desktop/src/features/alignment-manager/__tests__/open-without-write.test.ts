import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { files, mockComputeReferenceHash } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  mockComputeReferenceHash: vi.fn(),
}));

const mockWriteTextFile = vi.hoisted(() =>
  vi.fn(async (path: string, content: string) => {
    files.set(path, content);
  })
);

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      writeTextFile: mockWriteTextFile,
      exists: async (path: string) => files.has(path),
      watchFile: vi.fn().mockResolvedValue(undefined),
      unwatchFile: vi.fn().mockResolvedValue(undefined),
    },
    on: vi.fn(() => vi.fn()),
  }),
}));

vi.mock('../utils/hash', () => ({
  computeReferenceHash: mockComputeReferenceHash,
}));

vi.mock('../../../utils/debug-log', () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

vi.mock('../utils/alignment-api', () => ({
  callAlignmentApi: vi.fn(),
  readSequenceFile: vi.fn().mockResolvedValue('ACGTACGTAC'),
  readReferenceAnnotations: vi.fn(),
  readReferenceForMutations: vi.fn().mockResolvedValue({ annotations: [], geneticCode: 1 }),
}));

import { useVerificationStore } from '../store';

const DOCUMENT_ID = 'opened-reference';
const REFERENCE_PATH = '/workspace/sequences/opened-reference.gb';
const HISTORY_PATH = `${REFERENCE_PATH}.waypoint.json`;
const CHECKSUM = 'sha256:1f2ca6c4413ab63c9f18b25191f8b5880649432d963133eac9b1c8c45999cb9e';

function storedHistory(): string {
  return JSON.stringify(
    {
      type: 'alignment-history',
      version: '3.0',
      reference: { name: 'opened-reference', checksum: CHECKSUM, documentId: DOCUMENT_ID },
      savedAt: '2026-10-28T02:34:14.000Z',
      activeSessionId: 'session-1',
      sessions: [
        {
          id: 'session-1',
          name: 'Saved review',
          createdAt: '2026-10-28T02:34:07.552Z',
          mode: 'one-per-clone',
          tracks: [],
        },
      ],
      viewPreferences: {},
    },
    null,
    2
  );
}

describe('opening a sequence with saved alignment history', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    files.clear();
    files.set(HISTORY_PATH, storedHistory());
    mockWriteTextFile.mockClear();
    mockComputeReferenceHash.mockResolvedValue(CHECKSUM);
    useVerificationStore.setState({
      verificationState: {},
      sessionViewPreferences: {},
      staleReferences: {},
      staleSessionIds: {},
      referenceFileChecksums: {},
      pendingTrackIds: {},
    });
    useVerificationStore.getState().registerReferenceSource(DOCUMENT_ID, REFERENCE_PATH);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('writes nothing after loading, and still autosaves a later edit', async () => {
    expect(await useVerificationStore.getState().loadSidecar(DOCUMENT_ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockWriteTextFile).not.toHaveBeenCalled();
    expect(files.get(HISTORY_PATH)).toBe(storedHistory());

    useVerificationStore.setState((state) => {
      const refState = state.verificationState[DOCUMENT_ID]!;
      return {
        verificationState: {
          ...state.verificationState,
          [DOCUMENT_ID]: {
            ...refState,
            sessions: refState.sessions.map((session) => ({ ...session, name: 'Edited review' })),
          },
        },
      };
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(files.get(HISTORY_PATH)!).sessions[0].name).toBe('Edited review');
  });

  it('skips a save whose only difference is the saved-at time', async () => {
    await useVerificationStore.getState().loadSidecar(DOCUMENT_ID);

    await useVerificationStore.getState().saveSidecar(DOCUMENT_ID, { throwOnError: true });
    expect(mockWriteTextFile).not.toHaveBeenCalled();

    useVerificationStore.getState().renameSession(DOCUMENT_ID, 'session-1', 'Renamed review');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockWriteTextFile).toHaveBeenCalled();
    expect(JSON.parse(files.get(HISTORY_PATH)!).sessions[0].name).toBe('Renamed review');
  });
});
