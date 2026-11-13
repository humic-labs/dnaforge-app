// @vitest-environment node
import type { WorkspaceSessionControllerState } from '@waypoint/domain-services';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostedAcceptedInputResolver } from './managed-operation-input';
import type { HostedPendingOperation, HostedSyncRecord } from './sync-store';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const VERSION = '33333333-3333-4333-8333-333333333333';
let record: HostedSyncRecord;
let state: WorkspaceSessionControllerState;
const flush = vi.fn();
const load = vi.fn();
const authority = {
  getState: () => state,
  flush,
  load,
  subscribe: () => () => undefined,
};
const prepare = createHostedAcceptedInputResolver(WORKSPACE, authority);
const preparePublication = createHostedAcceptedInputResolver(WORKSPACE, authority, {
  requireSettledWorkspace: true,
});

afterEach(() => vi.useRealTimers());
const inputs = [
  { key: 'reference', path: `/hosted/${WORKSPACE}/sequences/reference/reference.gb` },
];

function pendingHistory(): HostedPendingOperation {
  return {
    id: 'history-save',
    createdAt: new Date().toISOString(),
    base: record.accepted,
    writes: [],
    removePaths: [],
    state: 'queued',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  record = {
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    operations: [],
    accepted: {
      workspaceId: WORKSPACE,
      revisionId: VERSION,
      revisionNumber: 1,
      files: [
        {
          path: 'sequences/reference/reference.gb',
          resourceId: '55555555-5555-4555-8555-555555555555',
          contentRevision: `sha256:${'a'.repeat(64)}`,
          contentSha256: 'a'.repeat(64),
          sizeBytes: 100,
          contentType: 'application/genbank',
        },
      ],
    },
  };
  state = {
    phase: 'idle',
    principal: { id: ACCOUNT, label: 'Scientist' },
    activeWorkspaceId: WORKSPACE,
    workspaces: [],
    snapshot: record.accepted,
    openFiles: [],
    activeFilePath: null,
    history: [],
    error: null,
    refreshError: null,
  };
  flush.mockResolvedValue(undefined);
  load.mockImplementation(async () => record);
});

describe('hosted alignment input capture', () => {
  it('starts from exact accepted inputs while unrelated history is still draining', async () => {
    record = { ...record, operations: [pendingHistory()] };
    let finishFlush!: () => void;
    flush.mockReturnValue(new Promise<void>((resolve) => (finishFlush = resolve)));
    let resolved = false;
    const result = prepare(inputs).then((value) => {
      resolved = true;
      return value;
    });
    try {
      await vi.waitFor(() => expect(resolved).toBe(true));
      expect((await result).version_id).toBe(VERSION);
    } finally {
      record = { ...record, operations: [] };
      finishFlush();
      await result;
    }
  });

  it('keeps the settled-workspace gate for result publication', async () => {
    vi.useFakeTimers();
    record = { ...record, operations: [pendingHistory()] };
    let resolved = false;
    const result = preparePublication(inputs).then((value) => {
      resolved = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolved).toBe(false);
    record = { ...record, operations: [] };
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ version_id: VERSION });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it.each(['contentSha256', 'resourceId', 'sizeBytes'] as const)(
    'waits for the captured input %s, not an older accepted file at that path',
    async (field) => {
      vi.useFakeTimers();
      const input = {
        ...record.accepted.files[0],
        [field]: field === 'sizeBytes' ? 200 : 'b'.repeat(64),
      };
      state = { ...state, snapshot: { ...record.accepted, files: [input] } };
      record = { ...record, operations: [pendingHistory()] };
      let resolved = false;
      const result = prepare(inputs).then((value) => {
        resolved = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(resolved).toBe(false);
      record = { ...record, accepted: { ...record.accepted, files: [input] } };
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await result).files[0]).toMatchObject({
        resource_id: input.resourceId,
        content_sha256: input.contentSha256,
        size_bytes: input.sizeBytes,
      });
      expect(flush).toHaveBeenCalledTimes(1);
    }
  );

  it('does not use another accepted version when the captured input was superseded', async () => {
    record = {
      ...record,
      accepted: {
        ...record.accepted,
        files: [{ ...record.accepted.files[0], contentSha256: 'b'.repeat(64) }],
      },
    };
    await expect(prepare(inputs)).rejects.toThrow(/save and sync/i);
  });

  it('flushes the outbox and binds stable file identities from the accepted version', async () => {
    const result = await prepare(inputs);
    expect(flush).toHaveBeenCalledWith(WORKSPACE);
    expect(load).toHaveBeenCalledWith(ACCOUNT, WORKSPACE);
    expect(result).toMatchObject({
      workspace_id: WORKSPACE,
      version_id: VERSION,
      manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      files: [
        {
          key: 'reference',
          resource_id: record.accepted.files[0].resourceId,
          path: record.accepted.files[0].path,
          content_sha256: 'a'.repeat(64),
          size_bytes: 100,
        },
      ],
    });
  });

  it('never promotes a pending or conflicted local draft into accepted provenance', async () => {
    record = { ...record, operations: [{ id: 'pending', state: 'conflict' } as never] };
    await expect(prepare(inputs)).rejects.toThrow(/save and sync/i);
  });

  it("rejects an account change during flush before loading another account's files", async () => {
    flush.mockImplementation(async () => {
      state = { ...state, principal: { id: VERSION, label: 'Other account' } };
    });
    await expect(prepare(inputs)).rejects.toThrow(/account or project changed/i);
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects a file outside the selected workspace', async () => {
    await expect(
      prepare([{ key: 'reference', path: `/hosted/${VERSION}/sequences/reference/reference.gb` }])
    ).rejects.toThrow(/not a saved file/i);
  });
});
