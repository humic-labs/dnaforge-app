// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  WorkspaceSessionController,
  type WorkspaceSessionAdapter,
  type WorkspaceSessionSnapshot,
  type WorkspaceSessionFileWrite,
} from '@waypoint/domain-services';
import { HostedSyncStore } from './sync-store';
import { createDurableHostedRuntime } from './sync-runtime';
import { HostedWorkspaceApiError } from './api';

const initial: WorkspaceSessionSnapshot = {
  workspaceId: 'workspace',
  revisionId: 'base',
  revisionNumber: 1,
  files: [],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(
  factory = new IDBFactory(),
  canApplyRemote?: () => boolean,
  prepareWrites?: (input: {
    workspaceId: string;
    snapshot: WorkspaceSessionSnapshot;
    writes: readonly WorkspaceSessionFileWrite[];
    removePaths?: readonly string[];
    expectedAccountId: string;
  }) => Promise<void>
) {
  let account = 'alice';
  let head = initial;
  let online = true;
  const receipts = new Map<string, WorkspaceSessionSnapshot>();
  const authority: WorkspaceSessionAdapter = {
    descriptor: {
      kind: 'hosted-browser',
      authority: 'dnaforge-manifest-revisions',
      identityFidelity: 'stable-resource-id',
      capabilities: {
        createWorkspace: true,
        multiFile: true,
        write: true,
        rename: true,
        move: true,
        delete: true,
        watch: true,
        history: true,
        restore: true,
      },
    },
    listWorkspaces: vi.fn(async () => {
      if (!online) throw new TypeError('Network unavailable');
      return {
        principal: { id: account, label: account },
        workspaces: [
          {
            workspaceId: 'workspace',
            displayName: 'Project',
            latestRevisionId: head.revisionId,
            latestRevisionNumber: head.revisionNumber,
          },
        ],
      };
    }),
    createWorkspace: vi.fn(),
    loadWorkspace: vi.fn(async () => {
      if (!online) throw new TypeError('Network unavailable');
      return head;
    }),
    readFile: vi.fn(async () => {
      throw new Error('Written bytes should be read from durable storage.');
    }),
    commit: vi.fn(async (input) => {
      if (!online) throw new TypeError('Network unavailable');
      if (input.expectedAccountId !== account)
        throw new HostedWorkspaceApiError(409, 'account_changed', 'Wrong mutation owner');
      if (input.operationId && receipts.has(input.operationId))
        return receipts.get(input.operationId)!;
      if (input.snapshot.revisionId !== head.revisionId)
        throw new HostedWorkspaceApiError(409, 'SYNC_CONFLICT', 'Stale base');
      head = {
        ...head,
        revisionId: `revision-${head.revisionNumber + 1}`,
        revisionNumber: head.revisionNumber + 1,
        files: input.writes.map((write) => ({
          resourceId: 'resource',
          path: write.path,
          contentRevision: `sha256:${'a'.repeat(64)}`,
          contentSha256: 'a'.repeat(64),
          sizeBytes: write.bytes.length,
          contentType: write.contentType,
        })),
      };
      if (input.operationId) receipts.set(input.operationId, head);
      return head;
    }),
  };
  const store = new HostedSyncStore('test', factory);
  const lockTails = new Map<string, Promise<unknown>>();
  const durable = createDurableHostedRuntime(authority, {
    store,
    lock: async (key, operation) => {
      const result = (lockTails.get(key) ?? Promise.resolve()).then(operation, operation);
      lockTails.set(key, result);
      return result;
    },
    retryDelayMs: 60_000,
    canApplyRemote,
    prepareWrites,
  });
  cleanups.push(() => {
    durable.dispose();
    void store.close();
  });
  const controller = new WorkspaceSessionController(durable.runtime);
  const save = (text: string) =>
    controller.commit([
      { path: 'notes.txt', bytes: new TextEncoder().encode(text), contentType: 'text/plain' },
    ]);
  return {
    authority,
    durable,
    store,
    controller,
    save,
    setOnline: (value: boolean) => {
      online = value;
    },
    setAccount: (value: string) => {
      account = value;
    },
    getHead: () => head,
    setHead: (value: WorkspaceSessionSnapshot) => {
      head = value;
    },
  };
}

describe('durable hosted synchronization', () => {
  it('prepares later durable writes while an earlier immutable publication is waiting', async () => {
    const prepareWrites = vi.fn(
      async (_input: {
        workspaceId: string;
        snapshot: WorkspaceSessionSnapshot;
        writes: readonly WorkspaceSessionFileWrite[];
        removePaths?: readonly string[];
        expectedAccountId: string;
      }) => {}
    );
    const f = fixture(new IDBFactory(), undefined, prepareWrites);
    await f.controller.initialize();
    let release!: () => void;
    const commit = f.authority.commit;
    f.authority.commit = vi.fn(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return commit(input);
    });
    await f.save('reference');
    await vi.waitFor(() => expect(f.authority.commit).toHaveBeenCalledTimes(1));
    await f.save('query');
    await vi.waitFor(() => expect(prepareWrites).toHaveBeenCalledTimes(2));
    expect(
      prepareWrites.mock.calls.map(([input]) => new TextDecoder().decode(input.writes[0].bytes))
    ).toEqual(['reference', 'query']);
    expect(prepareWrites.mock.calls.every(([input]) => input.expectedAccountId === 'alice')).toBe(
      true
    );
    expect((await f.store.load('alice', 'workspace'))?.accepted.revisionId).toBe('base');
    expect((await f.store.load('alice', 'workspace'))?.operations).toHaveLength(2);
    const firstOperation = (await f.store.load('alice', 'workspace'))!.operations[0];
    expect(prepareWrites.mock.calls[1][0].snapshot.localRevisionId).toBe(firstOperation.id);
    expect(prepareWrites.mock.calls[1][0].snapshot.files).toHaveLength(1);
    const draining = f.durable.flush('workspace');
    f.durable.dispose();
    release();
    await draining;
  });

  it('prepares the retained durable queue after restart without acknowledging a failed preparation', async () => {
    const factory = new IDBFactory();
    const first = fixture(factory);
    await first.controller.initialize();
    first.setOnline(false);
    await first.save('offline reference');
    await first.save('offline query');
    first.durable.dispose();
    const prepareWrites = vi.fn(
      async (_input: {
        workspaceId: string;
        snapshot: WorkspaceSessionSnapshot;
        writes: readonly WorkspaceSessionFileWrite[];
        removePaths?: readonly string[];
        expectedAccountId: string;
      }) => {
        throw new TypeError('Upload unavailable');
      }
    );
    const resumed = fixture(factory, undefined, prepareWrites);
    resumed.authority.commit = vi.fn(async () => {
      throw new HostedWorkspaceApiError(
        503,
        'SEQUENCE_PACKAGE_ADMISSION_PENDING',
        'Still verifying'
      );
    });
    await resumed.controller.initialize();
    await resumed.durable.flushAll();
    await vi.waitFor(() => expect(prepareWrites).toHaveBeenCalledTimes(2));
    expect(prepareWrites.mock.calls.every(([input]) => input.expectedAccountId === 'alice')).toBe(
      true
    );
    const retained = await resumed.store.load('alice', 'workspace');
    expect(retained?.accepted.revisionId).toBe('base');
    expect(retained?.operations).toHaveLength(2);
    expect(retained?.operations[0].state).toBe('queued');
  });

  const resultCondition = {
    kind: 'managed-operation-result' as const,
    operationId: 'retained-operation',
    inputRevision: 'input-revision',
    baseRevisionId: 'base',
    outputPath: 'contents/reference.gb.waypoint.json',
  };
  const resultWrite = {
    path: resultCondition.outputPath,
    bytes: new TextEncoder().encode('{"result":true}'),
    contentType: 'application/json',
  };

  it('only acknowledges a conditional result after server acceptance, without an optimistic outbox write', async () => {
    const f = fixture();
    await f.controller.initialize();
    let release!: () => void;
    const commit = f.authority.commit;
    f.authority.commit = vi.fn(async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return commit(input);
    });
    let settled = false;
    const publishing = f.controller
      .commit([resultWrite], undefined, undefined, resultCondition)
      .then((snapshot) => {
        settled = true;
        return snapshot;
      });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(settled).toBe(false);
    expect((await f.store.load('alice', 'workspace'))?.operations).toEqual([]);
    expect(f.controller.getState().snapshot?.revisionId).toBe('base');
    release();
    expect((await publishing).revisionId).toBe('revision-2');
    expect(f.authority.commit).toHaveBeenCalledWith(
      expect.objectContaining({ publicationCondition: resultCondition, expectedAccountId: 'alice' })
    );
    expect((await f.store.load('alice', 'workspace'))?.accepted.revisionId).toBe('revision-2');
  });

  it('refuses a conditional result on a newer head without rebasing or blocking ordinary saves', async () => {
    const f = fixture();
    await f.controller.initialize();
    f.setHead({ ...initial, revisionId: 'newer-inputs', revisionNumber: 2 });
    await expect(
      f.controller.commit([resultWrite], undefined, undefined, resultCondition)
    ).rejects.toMatchObject({ code: 'SYNC_CONFLICT' });
    expect(f.authority.commit).toHaveBeenCalledTimes(1);
    expect((await f.store.load('alice', 'workspace'))?.operations).toEqual([]);
    expect(f.getHead().revisionId).toBe('newer-inputs');
    await f.controller.initialize();
    await f.save('An ordinary edit still saves');
    await f.durable.flush('workspace');
    expect(f.getHead().revisionId).toBe('revision-3');
  });

  it('never queues an offline result for later blind publication', async () => {
    const f = fixture();
    await f.controller.initialize();
    f.setOnline(false);
    await expect(
      f.controller.commit([resultWrite], undefined, undefined, resultCondition)
    ).rejects.toThrow('Network unavailable');
    expect((await f.store.load('alice', 'workspace'))?.operations).toEqual([]);
  });

  it.each(['account', 'permission'] as const)(
    'does not attach or enqueue a result after %s changes during the preflight',
    async (change) => {
      const f = fixture();
      await f.controller.initialize();
      const list = f.authority.listWorkspaces;
      f.authority.listWorkspaces = vi.fn(async () => {
        const index = await list();
        if (change === 'account') f.setAccount('bob');
        return change === 'permission' ? { ...index, workspaces: [] } : index;
      });
      await expect(
        f.controller.commit([resultWrite], undefined, undefined, resultCondition)
      ).rejects.toThrow();
      expect(f.getHead().revisionId).toBe('base');
      expect((await f.store.load('alice', 'workspace'))?.operations).toEqual([]);
      expect(await f.store.load('bob', 'workspace')).toBeUndefined();
    }
  );
  it('does not restore an account selection when persistence finishes after sign-out', async () => {
    const f = fixture();
    await f.controller.initialize();
    const persist = f.store.saveIndex.bind(f.store);
    let release!: () => void;
    vi.spyOn(f.store, 'saveIndex').mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return persist(...args);
    });
    const refreshing = f.durable.runtime.listWorkspaces();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.durable.signOut();
    release();
    await expect(refreshing).rejects.toThrow('account changed');
    expect(await f.store.loadIndex()).toBeNull();
  });
  it('never rebinds the displayed account’s save or project creation to a newer runtime account', async () => {
    const f = fixture();
    await f.controller.initialize();
    f.setAccount('bob');
    await f.durable.runtime.listWorkspaces();
    expect(f.controller.getState().principal?.id).toBe('alice');
    await expect(f.save('Alice private draft')).rejects.toThrow('signed-in account changed');
    await expect(f.controller.createWorkspace('Alice private project')).rejects.toThrow(
      'signed-in account changed'
    );
    expect(await f.store.load('bob', 'workspace')).toBeUndefined();
    expect(f.authority.commit).not.toHaveBeenCalled();
    expect(f.authority.createWorkspace).not.toHaveBeenCalled();
  });
  it('does not roll an accepted save back when an older refresh arrives late', async () => {
    const f = fixture();
    await f.controller.initialize();
    let release!: () => void;
    f.authority.loadWorkspace = vi.fn(async () => {
      const snapshot = f.getHead();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return snapshot;
    });
    const refreshing = f.durable.runtime.loadWorkspace(f.controller.getState().workspaces[0]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.save('accepted while the refresh was in flight');
    await f.durable.flush('workspace');
    expect((await f.store.load('alice', 'workspace'))?.accepted.revisionNumber).toBe(2);
    release();
    expect((await refreshing).revisionNumber).toBe(2);
    expect((await f.store.load('alice', 'workspace'))?.accepted.files).toHaveLength(1);
    expect(f.durable.getStatus('workspace')?.message).toContain('revision 2');
  });

  it('serializes restore with publication and preserves a save made during its acknowledgement', async () => {
    const f = fixture();
    await f.controller.initialize();
    const first = await f.save('first');
    await f.durable.flush('workspace');
    const before = (await f.store.load('alice', 'workspace'))!;
    let release!: () => void;
    f.authority.restoreRevision = vi.fn(async () => {
      const restored = { ...initial, revisionId: 'restored', revisionNumber: 3 };
      f.setHead(restored);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return restored;
    });
    const restoring = f.durable.runtime.restoreRevision!({
      workspace: f.controller.getState().workspaces[0],
      revisionId: 'base',
      snapshot: before.accepted,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const draft = await f.durable.runtime.commit({
      snapshot: first,
      writes: [
        {
          path: 'notes.txt',
          bytes: new TextEncoder().encode('newer draft'),
          contentType: 'text/plain',
        },
      ],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.authority.commit).toHaveBeenCalledTimes(1);
    release();
    const result = await restoring;
    expect(result.localRevisionId).toBe(draft.localRevisionId);
    const after = (await f.store.load('alice', 'workspace'))!;
    expect(after.acknowledgements).toEqual(before.acknowledgements);
    expect(after.operations).toHaveLength(1);
    expect(new TextDecoder().decode(after.operations[0].writes[0].bytes)).toBe('newer draft');
    await f.durable.flush('workspace');
  });

  it('does not revive an offline account from an index reply delivered after sign-out', async () => {
    const f = fixture();
    await f.controller.initialize();
    const list = f.authority.listWorkspaces;
    let release!: () => void;
    f.authority.listWorkspaces = vi.fn(async () => {
      const index = await list();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return index;
    });
    const refreshing = f.durable.runtime.listWorkspaces();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.durable.signOut();
    release();
    await expect(refreshing).rejects.toThrow('sign-in session changed');
    expect(await f.store.loadIndex()).toBeNull();
    expect(f.durable.getStatus('workspace')).toBeUndefined();
  });
  it('keeps the accepted base pinned if editing starts during a remote refresh', async () => {
    let clean = true;
    const f = fixture(new IDBFactory(), () => clean);
    await f.controller.initialize();
    f.setHead({ ...initial, revisionId: 'other-device', revisionNumber: 2 });
    const load = f.authority.loadWorkspace;
    let release!: () => void;
    f.authority.loadWorkspace = vi.fn(async (workspace) => {
      const snapshot = await load(workspace);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return snapshot;
    });
    const refreshing = f.controller.refreshActiveWorkspace();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    clean = false;
    release();
    await refreshing;
    expect(f.controller.getState().snapshot?.revisionId).toBe('base');
    expect((await f.store.load('alice', 'workspace'))!.accepted.revisionId).toBe('base');
    f.authority.loadWorkspace = load;
    clean = true;
    await f.controller.refreshActiveWorkspace();
    expect(f.controller.getState().snapshot?.revisionId).toBe('other-device');
  });

  it('renews a lost retention acknowledgement only after explicit server expiry', async () => {
    const f = fixture();
    await f.controller.initialize();
    f.authority.retainRecoveryCandidate = vi
      .fn()
      .mockRejectedValueOnce(
        new HostedWorkspaceApiError(410, 'RECOVERY_CANDIDATE_EXPIRED', 'Expired')
      )
      .mockResolvedValue({
        id: 'new-capture',
        coverage: 'captured-bytes',
        expiresAt: '2100-01-01T00:00:00Z',
      });
    await f.save('same frozen bytes');
    await f.durable.flush('workspace');
    const pending = (await f.store.load('alice', 'workspace'))!.operations[0];
    expect(pending.state).toBe('queued');
    expect(pending.recoveryIntentId).not.toBe(pending.id);
    await f.durable.flush('workspace');
    const [first, second] = vi.mocked(f.authority.retainRecoveryCandidate).mock.calls;
    expect(second[0]).toEqual({ ...first[0], operationId: pending.recoveryIntentId });
    expect((await f.store.load('alice', 'workspace'))!.operations).toHaveLength(0);
  });
  it('pins the original owner when the account changes after the publish preflight', async () => {
    const f = fixture();
    await f.controller.initialize();
    let release!: () => void;
    let entered = false;
    const update = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementation(async (...args) => {
      const record = await update(...args);
      if (!entered && record.operations[0]?.state === 'sending') {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return record;
    });
    await f.save('Alice private draft');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.setAccount('bob');
    await f.durable.runtime.listWorkspaces();
    release();
    await vi.waitFor(async () =>
      expect((await f.store.load('alice', 'workspace'))?.operations[0].state).toBe('blocked')
    );
    expect(f.authority.commit).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAccountId: 'alice' })
    );
    expect(f.getHead().revisionNumber).toBe(1);
    expect(await f.store.load('bob', 'workspace')).toBeUndefined();
  });

  it('renews expired recovery retention with one durable replay key', async () => {
    const f = fixture();
    await f.controller.initialize();
    f.setOnline(false);
    await f.save('renew retained bytes');
    await f.durable.flush('workspace');
    const old = (await f.store.load('alice', 'workspace'))!.operations[0];
    await f.store.update('alice', 'workspace', (record) => ({
      ...record!,
      operations: [
        {
          ...old,
          recovery: {
            id: 'expired',
            coverage: 'captured-bytes',
            expiresAt: '2000-01-01T00:00:00Z',
          },
        },
      ],
    }));
    f.authority.retainRecoveryCandidate = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Retention acknowledgement lost'))
      .mockResolvedValue({
        id: 'renewed',
        coverage: 'captured-bytes',
        expiresAt: '2100-01-01T00:00:00Z',
      });
    f.setOnline(true);
    await f.durable.flush('workspace');
    const renewed = (await f.store.load('alice', 'workspace'))!.operations[0];
    expect(renewed.recoveryIntentId).toBeTruthy();
    expect(renewed.recoveryIntentId).not.toBe(old.id);
    expect(renewed.recovery).toBeUndefined();
    await f.durable.flush('workspace');
    const calls = vi.mocked(f.authority.retainRecoveryCandidate).mock.calls;
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(calls[0][0].expectedAccountId).toBe('alice');
    expect(vi.mocked(f.authority.commit).mock.calls[0][0].operationId).toBe(old.id);
    expect((await f.store.load('alice', 'workspace'))!.operations).toHaveLength(0);
  });
  it('recovers exact saved bytes after an offline renderer restart', async () => {
    const factory = new IDBFactory();
    const first = fixture(factory);
    await first.controller.initialize();
    first.setOnline(false);
    const saved = await first.save('unsynced scientific notes');
    await first.durable.flush('workspace');
    expect(saved.revisionId).toBe('base');
    expect(saved.localRevisionId).toBeTruthy();
    expect(first.durable.getStatus('workspace')).toMatchObject({
      state: 'saved-locally',
      pendingCount: 1,
    });
    first.durable.dispose();
    await first.store.close();
    const restarted = fixture(factory);
    restarted.setOnline(false);
    await restarted.controller.initialize();
    const file = await restarted.controller.openFile('notes.txt');
    expect(new TextDecoder().decode(file.bytes)).toBe('unsynced scientific notes');
    expect(restarted.authority.commit).not.toHaveBeenCalled();
  });

  it('replays the same operation and base after acceptance acknowledgement is lost', async () => {
    const f = fixture();
    await f.controller.initialize();
    const publish = f.authority.commit;
    let loseAcknowledgement = true;
    f.authority.commit = vi.fn(async (input) => {
      const accepted = await publish(input);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new TypeError('Response connection lost');
      }
      return accepted;
    });
    await f.save('retained');
    await f.durable.flush('workspace');
    expect(f.getHead().revisionNumber).toBe(2);
    expect((await f.store.load('alice', 'workspace'))?.operations).toHaveLength(1);
    await f.durable.flush('workspace');
    const calls = vi.mocked(f.authority.commit).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect((await f.store.load('alice', 'workspace'))?.operations).toHaveLength(0);
    expect(f.getHead().revisionNumber).toBe(2);
  });

  it('durably queues a second save while the first acknowledgement is pending', async () => {
    const f = fixture();
    await f.controller.initialize();
    const publish = f.authority.commit;
    let acknowledge!: () => void;
    f.authority.commit = vi
      .fn()
      .mockImplementationOnce(async (input) => {
        const accepted = await publish(input);
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        return accepted;
      })
      .mockImplementation(publish);
    const first = await f.save('first');
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    await f.save('second');
    const queued = await f.store.load('alice', 'workspace');
    expect(queued?.operations).toHaveLength(2);
    expect(queued?.operations[1].base.localRevisionId).toBe(first.localRevisionId);
    acknowledge();
    await f.durable.flush('workspace');
    const calls = vi.mocked(f.authority.commit).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].snapshot.revisionId).toBe('revision-2');
    expect(new TextDecoder().decode(calls[1][0].writes[0].bytes)).toBe('second');
    expect((await f.store.load('alice', 'workspace'))?.operations).toHaveLength(0);
  });

  it('never replays Alice’s pending operation under Bob’s session', async () => {
    const f = fixture();
    await f.controller.initialize();
    f.setOnline(false);
    await f.save('private Alice draft');
    await f.durable.flush('workspace');
    f.setOnline(true);
    f.setAccount('bob');
    await f.durable.flush('workspace');
    expect(f.authority.commit).not.toHaveBeenCalled();
    expect(f.durable.getStatus('workspace')).toMatchObject({ state: 'blocked', pendingCount: 1 });
    await f.controller.initialize();
    expect(f.controller.getState().principal?.id).toBe('bob');
    expect(f.controller.getState().snapshot?.files).toEqual([]);
    expect((await f.store.load('alice', 'workspace'))?.operations).toHaveLength(1);
  });

  it('binds a late enqueue to an acknowledgement received after its editor snapshot', async () => {
    const f = fixture();
    await f.controller.initialize();
    const first = await f.save('first');
    await f.durable.flush('workspace');
    expect(first.localRevisionId).toBeTruthy();
    await f.durable.runtime.commit({
      snapshot: first,
      writes: [
        { path: 'notes.txt', bytes: new TextEncoder().encode('second'), contentType: 'text/plain' },
      ],
    });
    await f.durable.flush('workspace');
    expect(f.getHead().revisionNumber).toBe(3);
    expect((await f.store.load('alice', 'workspace'))?.operations).toHaveLength(0);
    expect(vi.mocked(f.authority.commit).mock.calls[1][0].snapshot.revisionId).toBe('revision-2');
  });

  it('gives new local resources stable identities before the server responds', async () => {
    const f = fixture();
    await f.controller.initialize();
    f.setOnline(false);
    const first = await f.save('first');
    const second = await f.save('second');
    expect(first.files[0].resourceId).toBeTruthy();
    expect(second.files[0].resourceId).toBe(first.files[0].resourceId);
    expect(
      (await f.store.load('alice', 'workspace'))?.operations.map(
        (operation) => operation.writes[0].resourceId
      )
    ).toEqual([first.files[0].resourceId, first.files[0].resourceId]);
  });

  it('does not acknowledge a save or upload after durable storage rejects it', async () => {
    const f = fixture();
    await f.controller.initialize();
    vi.spyOn(f.store, 'update').mockRejectedValueOnce(
      new DOMException('Quota exceeded', 'QuotaExceededError')
    );
    await expect(f.save('not stored')).rejects.toThrow('Quota exceeded');
    expect(f.authority.commit).not.toHaveBeenCalled();
    expect(f.controller.getState().snapshot?.localRevisionId).toBeUndefined();
  });

  it('retains conflict bytes across restart without replacing the remote winner', async () => {
    const factory = new IDBFactory();
    const f = fixture(factory);
    await f.controller.initialize();
    f.authority.commit = vi.fn(async () => {
      throw new HostedWorkspaceApiError(409, 'SYNC_CONFLICT', 'Other device edited');
    });
    await f.save('conflicting local draft');
    await f.durable.flush('workspace');
    expect(f.durable.getStatus('workspace')).toMatchObject({ state: 'conflict', pendingCount: 1 });
    f.durable.dispose();
    const restarted = fixture(factory);
    await restarted.controller.initialize();
    expect(new TextDecoder().decode((await restarted.controller.openFile('notes.txt')).bytes)).toBe(
      'conflicting local draft'
    );
    await restarted.durable.flush('workspace');
    expect(restarted.authority.commit).not.toHaveBeenCalled();
  });
});
