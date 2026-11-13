// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceSyncReplicaLifecycleEvent } from '../shared/workspace-sync-ipc';
import type { WorkspaceRendererMutationEvent } from '../shared/workspace-renderer-mutation';

const preloadHarness = vi.hoisted(() => ({
  exposedApi: null as unknown,
  eventOrder: [] as string[],
  listeners: new Map<string, (...args: unknown[]) => void>(),
  send: vi.fn((channel: string) => {
    preloadHarness.eventOrder.push(`send:${channel}`);
  }),
}));

vi.mock('../shared/ipc-contract', () => ({
  rendererIpc: {
    invoke: vi.fn(async () => undefined),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      preloadHarness.eventOrder.push(`on:${channel}`);
      preloadHarness.listeners.set(channel, listener);
    }),
    removeListener: vi.fn(),
    send: preloadHarness.send,
  },
  createClient: vi.fn(() => ({})),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: unknown) => {
      preloadHarness.exposedApi = api;
    }),
  },
  webUtils: { getPathForFile: vi.fn(() => '') },
}));

vi.mock('./indexed-genome-ipc', () => ({
  createIndexedGenomeIpc: vi.fn(() => ({})),
}));

import './index';

interface ReplicaLifecycleApi {
  workspaceMutations: {
    onLifecycle(
      callback: (event: WorkspaceRendererMutationEvent) => void | Promise<void>
    ): () => void;
  };
  on(channel: 'workspace:set-path', callback: () => void): () => void;
  cloudSync: {
    onReplicaLifecycle(
      callback: (event: WorkspaceSyncReplicaLifecycleEvent) => void | Promise<void>
    ): () => void;
  };
}

describe('preload workspace replica lifecycle acknowledgement', () => {
  it('waits for native document protection before acknowledging, and never acknowledges release', async () => {
    const api = preloadHarness.exposedApi as ReplicaLifecycleApi;
    let release = () => {};
    api.workspaceMutations.onLifecycle(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const listener = preloadHarness.listeners.get('workspace:mutation');
    const event: WorkspaceRendererMutationEvent = {
      phase: 'preparing',
      deliveryId: 'native-delivery',
      workspaceRoot: '/workspace',
      source: {
        kind: 'document-command',
        actionId: 'action-a',
        documentId: 'doc-a',
        sourcePath: '/workspace/doc.gb',
      },
      affectedNotebookIds: [],
      affectedDesignIds: [],
      affectedEntityIds: ['doc-a'],
    };
    listener?.({}, event);
    await Promise.resolve();
    expect(preloadHarness.send).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(preloadHarness.send).toHaveBeenCalledWith('workspace:mutationAck', {
        deliveryId: 'native-delivery',
        phase: 'preparing',
        status: 'ok',
      })
    );
    preloadHarness.send.mockClear();
    listener?.({}, { ...event, phase: 'released', disposition: 'unchanged' });
    await Promise.resolve();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(preloadHarness.send).not.toHaveBeenCalled();
  });

  it('reports native document protection failure as a failed acknowledgement', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = preloadHarness.exposedApi as ReplicaLifecycleApi;
    api.workspaceMutations.onLifecycle(() => {
      throw new Error('Unsaved document');
    });
    const listener = preloadHarness.listeners.get('workspace:mutation');
    listener?.({}, { phase: 'preparing', deliveryId: 'native-delivery' });
    await vi.waitFor(() =>
      expect(preloadHarness.send).toHaveBeenCalledWith('workspace:mutationAck', {
        deliveryId: 'native-delivery',
        phase: 'preparing',
        status: 'failed',
        error: 'Unsaved document',
      })
    );
  });

  afterEach(() => {
    preloadHarness.eventOrder.length = 0;
    preloadHarness.listeners.clear();
    preloadHarness.send.mockClear();
    vi.restoreAllMocks();
  });

  it('announces workspace listener readiness only after installing the listener', () => {
    const api = preloadHarness.exposedApi as ReplicaLifecycleApi;

    api.on('workspace:set-path', () => undefined);

    expect(preloadHarness.eventOrder).toEqual([
      'on:workspace:set-path',
      'send:workspace:set-path-listener-ready',
    ]);
    expect(preloadHarness.listeners.has('workspace:set-path')).toBe(true);
  });

  it('turns a synchronous renderer callback throw into an immediate failed acknowledgement', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = preloadHarness.exposedApi as ReplicaLifecycleApi;
    api.cloudSync.onReplicaLifecycle(() => {
      throw new Error('synchronous hydration failure');
    });
    const listener = preloadHarness.listeners.get('cloudSync:replicaApplied');
    expect(listener).toBeDefined();

    const event: WorkspaceSyncReplicaLifecycleEvent = {
      deliveryId: 'delivery-a',
      phase: 'preparing',
      workspaceUuid: 'workspace-a',
      workspaceRoot: '/managed/workspace-a/repo',
      remoteVersionId: 'version-a',
      affectedNotebookIds: [],
      affectedDesignIds: [],
    };
    listener?.({}, event);

    await vi.waitFor(() => {
      expect(preloadHarness.send).toHaveBeenCalledWith('cloudSync:replicaAppliedAck', {
        deliveryId: 'delivery-a',
        phase: 'preparing',
        status: 'failed',
        error: 'synchronous hydration failure',
      });
    });
  });
});
