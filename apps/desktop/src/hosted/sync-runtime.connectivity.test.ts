// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type {
  WorkspaceSessionAdapter,
  WorkspaceSessionSnapshot,
  WorkspaceSessionWorkspace,
} from '@waypoint/domain-services';
import { userMessage } from '@waypoint/user-messages';
import { HostedWorkspaceApiError } from './api';
import { createDurableHostedRuntime } from './sync-runtime';
import { HostedSyncStore } from './sync-store';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

function fixture() {
  const snapshot: WorkspaceSessionSnapshot = {
    workspaceId: 'project',
    revisionId: 'accepted',
    revisionNumber: 1,
    files: [],
  };
  const workspace: WorkspaceSessionWorkspace = {
    workspaceId: 'project',
    displayName: 'Review project',
    latestRevisionId: 'accepted',
    latestRevisionNumber: 1,
  };
  let manifestFailure: unknown;
  let commitFailure: unknown;
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
    listWorkspaces: async () => ({
      principal: { id: 'alice', label: 'Alice' },
      workspaces: [workspace],
    }),
    createWorkspace: vi.fn(),
    loadWorkspace: async () => {
      if (manifestFailure) throw manifestFailure;
      return snapshot;
    },
    readFile: vi.fn(),
    commit: async () => {
      if (commitFailure) throw commitFailure;
      return { ...snapshot, revisionId: 'next', revisionNumber: 2 };
    },
  };
  const store = new HostedSyncStore('connectivity-regression', new IDBFactory());
  const durable = createDurableHostedRuntime(authority, {
    store,
    lock: async (_key, operation) => operation(),
    retryDelayMs: 60_000,
  });
  cleanups.push(() => {
    durable.dispose();
    void store.close();
  });
  return {
    snapshot,
    workspace,
    durable,
    store,
    failManifest: (failure: unknown) => {
      manifestFailure = failure;
    },
    failCommit: (failure: unknown) => {
      commitFailure = failure;
    },
  };
}

describe('hosted sync remote availability', () => {
  it.each([408, 429, 500, 503])(
    'keeps HTTP %i retries distinct from offline while retaining the accepted revision',
    async (status) => {
      const f = fixture();
      await f.durable.runtime.listWorkspaces();
      await f.durable.runtime.loadWorkspace(f.workspace);
      f.failManifest(
        new HostedWorkspaceApiError(status, 'SEQUENCE_PACKAGE_ADMISSION_PENDING', 'Verifying')
      );

      expect(await f.durable.runtime.loadWorkspace(f.workspace)).toEqual(f.snapshot);
      expect(f.durable.getStatus('project')).toMatchObject({
        state: 'accepted',
        remoteAvailability: 'server-retrying',
        message: userMessage('service.unavailable'),
      });
      expect((await f.store.load('alice', 'project'))?.accepted).toEqual(f.snapshot);

      f.failManifest(undefined);
      await f.durable.runtime.loadWorkspace(f.workspace);
      expect(f.durable.getStatus('project')?.remoteAvailability).toBe('available');
    }
  );

  it.each([
    { online: false, availability: 'offline' },
    { online: true, availability: 'connection-unavailable' },
  ])('distinguishes a transport failure when online=$online', async ({ online, availability }) => {
    vi.stubGlobal('navigator', { onLine: online });
    const f = fixture();
    await f.durable.runtime.listWorkspaces();
    await f.durable.runtime.loadWorkspace(f.workspace);
    f.failManifest(new TypeError('fetch failed'));

    expect(await f.durable.runtime.loadWorkspace(f.workspace)).toEqual(f.snapshot);
    expect(f.durable.getStatus('project')?.remoteAvailability).toBe(availability);
  });

  it('retains pending bytes and the server-retry reason until a save is accepted', async () => {
    const f = fixture();
    await f.durable.runtime.listWorkspaces();
    await f.durable.runtime.loadWorkspace(f.workspace);
    f.failCommit(
      new HostedWorkspaceApiError(503, 'SEQUENCE_PACKAGE_ADMISSION_PENDING', 'Verifying')
    );
    const bytes = new TextEncoder().encode('saved local work');
    await f.durable.runtime.commit({
      snapshot: f.snapshot,
      expectedAccountId: 'alice',
      writes: [{ path: 'notes.txt', contentType: 'text/plain', bytes }],
    });
    await f.durable.flush('project');

    const record = await f.store.load('alice', 'project');
    expect(record?.accepted.revisionId).toBe('accepted');
    expect(record?.operations).toHaveLength(1);
    expect(record?.operations[0]).toMatchObject({
      state: 'queued',
      retryReason: 'server-retrying',
    });
    expect(record?.operations[0].writes[0].bytes).toEqual(bytes);
    expect(f.durable.getStatus('project')).toMatchObject({
      state: 'saved-locally',
      remoteAvailability: 'server-retrying',
      pendingCount: 1,
    });

    f.failCommit(undefined);
    await f.durable.retry('project');
    expect((await f.store.load('alice', 'project'))?.operations).toEqual([]);
    expect(f.durable.getStatus('project')).toMatchObject({
      state: 'accepted',
      remoteAvailability: 'available',
      pendingCount: 0,
    });
  });
});
