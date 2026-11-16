// @vitest-environment node
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeAnnotationDocumentBarrier } from '../managed-annotation-document-command';

type Handler = (event: IpcMainInvokeEvent, request: unknown) => Promise<boolean>;
type OwnerOptions = {
  nativeOwnerInstanceId: string;
  fetch: unknown;
  workspaceRoots: () => readonly string[];
  prepare: (
    actionId: string,
    document: { workspaceRoot: string; documentId: string; sourcePath: string }
  ) => Promise<NativeAnnotationDocumentBarrier>;
};
type RecoveryOptions = { nativeOwnerInstanceId: string; profileKey: string; owner: unknown };

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  registeredRoots: [] as string[],
  owners: [] as OwnerOptions[],
  recoveries: [] as Array<{
    options: RecoveryOptions;
    request: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  serverClose: vi.fn(async () => {}),
  startServer: vi.fn(),
  registerServer: vi.fn(),
  detach: vi.fn(),
  bindProfile: vi.fn(),
  authority: { value: null as { ownerInstanceId: string } | null },
  snapshotState: { value: 'ready' },
  publisher: { start: vi.fn(), stop: vi.fn() },
  createPublisher: vi.fn(),
  barrier: {
    finish: vi.fn(async () => 'refreshed' as const),
    assertCurrent: vi.fn(),
    abort: vi.fn(),
  },
  createBarrier: vi.fn(),
  fetch: vi.fn(),
  flush: vi.fn(async () => {}),
  saveTelemetry: vi.fn(),
  bootLog: vi.fn(),
  inventory: {
    initialize: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    projects: vi.fn(() => []),
    catalog: vi.fn(() => []),
    catalogUpdatePreview: vi.fn(),
    resolveItemCode: vi.fn(),
    prepareLabel: vi.fn(),
    materials: vi.fn(() => ({ items: [], nextCursor: null })),
    execute: vi.fn(),
    inspect: vi.fn(),
    availability: vi.fn(),
    operation: vi.fn(),
    history: vi.fn(),
  },
  inventoryOptions: [] as Array<{ profileKey: string; actor(): string }>,
}));

vi.mock('../analytics', () => ({ trackEvent: mocks.saveTelemetry }));
vi.mock('../boot-log', () => ({ appendBootLog: mocks.bootLog }));
vi.mock('../config', () => ({ getApiUrl: () => 'http://synthetic-grants.invalid' }));

vi.mock('../registered-project-authority', () => ({
  withAgentProjectScope: (_scope: unknown, operation: () => unknown) => operation(),
  createRegisteredProjectAuthority: () => {
    const list = () =>
      mocks.registeredRoots.map((path) => ({
        id: 1,
        projectId: 'project-alpha',
        name: 'Alpha',
        path,
        accessMode: 'writable',
        pinned: false,
      }));
    return {
      list,
      resolve: (reference: string) =>
        list().find((project) => project.path === reference || project.projectId === reference) ??
        null,
      capture: (projectId: string) => () => {
        if (!list().some((project) => project.projectId === projectId))
          throw new Error('PROJECT_ACCESS_CHANGED: The registered project authority changed.');
      },
    };
  },
}));

vi.mock('../file-document-client-sync', () => ({
  createFileDocumentClientSync: () => ({
    flush: mocks.flush,
    hasLiveTarget: () => true,
    close: vi.fn(),
    acknowledge: () => false,
  }),
}));

vi.mock('../../shared/ipc-contract', async () => {
  const { contractEntries } = await vi.importActual<typeof import('../../shared/ipc/contract')>(
    '../../shared/ipc/contract'
  );
  return {
    mainIpc: {
      handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler),
    },
    handleGroup: (
      contract: import('../../shared/ipc/contract').AnyContractGroup,
      group: Record<string, Handler | null>
    ) => {
      for (const { method, channel } of contractEntries(contract)) {
        const handler = group[method];
        if (handler) mocks.handlers.set(channel, handler);
      }
      return () => undefined;
    },
  };
});
vi.mock('../ipc/path-allowlist', () => ({
  assertSafeWritablePath: async (root: string) => root,
  assertSafePath: async (root: string) => root,
}));
vi.mock('../ipc/database', () => ({ getDb: vi.fn() }));
vi.mock('../inventory-owner', () => ({
  createNativeInventoryOwner: (options: { profileKey: string; actor(): string }) => {
    mocks.inventoryOptions.push(options);
    return mocks.inventory;
  },
}));
vi.mock('../native-annotation-document-owner', () => ({
  NativeAnnotationDocumentOwner: class {
    constructor(options: OwnerOptions) {
      mocks.owners.push(options);
    }
  },
}));
vi.mock('../native-document-command-server', () => ({
  startNativeDocumentCommandServer: mocks.startServer,
}));
vi.mock('../native-document-owner-identity', () => ({
  nativeDocumentProfileKey: (userDataPath: string) => `profile:${userDataPath}`,
}));
vi.mock('../native-document-renderer', () => ({
  createNativeDocumentRendererPublisher: mocks.createPublisher,
  createNativeDocumentMutationBarrier: mocks.createBarrier,
}));
vi.mock('../native-document-startup-recovery', () => ({
  NativeDocumentStartupRecovery: class {
    request = vi.fn(async () => {});
    close = vi.fn(async () => {});
    constructor(options: RecoveryOptions) {
      mocks.recoveries.push({ options, request: this.request, close: this.close });
    }
  },
}));
vi.mock('../sidecar-session-runtime', () => ({
  nativeDocumentFetch: mocks.fetch,
  registerNativeDocumentCommandServer: mocks.registerServer,
  sidecarSessionAuthority: {
    bindNativeDocumentProfile: mocks.bindProfile,
    snapshot: () => ({ state: mocks.snapshotState.value }),
    nativeDocumentAuthority: () => mocks.authority.value,
    waitForReadySnapshot: async () => ({ state: 'ready' }),
    isCurrent: () => true,
  },
}));
vi.mock('./test-hooks', () => ({
  withNativeDocumentSettlementTestSeam: <T>(fetch: T) => fetch,
}));

import { createNativeDocuments } from './native-documents';

const AUTHORITY = { ownerInstanceId: 'owner-1' };
const ROOT = '/projects/alpha';
const DOCUMENT = {
  workspaceRoot: ROOT,
  documentId: 'native-document-1',
  sourcePath: ROOT + '/source.gb',
};
const trusted = (loadId: string) => ({ loadId, roots: [ROOT] });

function started(editingClient: 'renderer' | 'none', canAssertNoEditingClient = () => true) {
  const documents = createNativeDocuments();
  documents.bindProfile('/user-data');
  return { documents, start: documents.start({ editingClient, canAssertNoEditingClient }) };
}

function owner(): OwnerOptions {
  const latest = mocks.owners.at(-1);
  if (!latest) throw new Error('no native document owner was created');
  return latest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.registeredRoots.length = 0;
  mocks.owners.length = 0;
  mocks.recoveries.length = 0;
  mocks.inventoryOptions.length = 0;
  mocks.authority.value = AUTHORITY;
  mocks.snapshotState.value = 'ready';
  mocks.startServer.mockResolvedValue({ url: 'http://127.0.0.1:4100/', close: mocks.serverClose });
  mocks.registerServer.mockReturnValue(mocks.detach);
  mocks.createPublisher.mockReturnValue(mocks.publisher);
  mocks.createBarrier.mockReturnValue(async () => mocks.barrier);
});

describe('native documents main feature', () => {
  it('retains a refused native Save All in local diagnostics and safe remote telemetry', async () => {
    const documents = createNativeDocuments();
    const document = {
      documentId: 'private-document',
      target: { documentId: 'private-document' },
      path: '/Users/alice/private/file.txt',
      workspaceRoot: '/Users/alice/private',
      kind: 'text' as const,
      revision: 'draft:7',
      readOnly: false,
      dirty: true,
      saving: false,
      recovery: false,
      inspectionRequired: false,
    };
    vi.spyOn(documents.fileDocuments, 'listDirty').mockResolvedValue([document]);
    vi.spyOn(documents.fileDocuments, 'execute').mockRejectedValue(
      new Error('EACCES: write refused /Users/alice/private/file.txt')
    );
    const result = await documents.settleDirtyDocuments({ action: 'save' });
    expect(result.failures).toHaveLength(1);
    expect(result.remaining).toEqual([document]);
    expect(mocks.bootLog.mock.calls.flat().join('\n')).toContain('EACCES');
    expect(mocks.bootLog.mock.calls.flat().join('\n')).not.toMatch(/alice|private|file\.txt/);
    expect(mocks.saveTelemetry).toHaveBeenCalledWith(
      'workflow_action_observed',
      expect.objectContaining({
        workflow: 'file',
        workflow_action: 'save',
        action_phase: 'error',
        workflow_status: 'failed',
        error_class: 'eacces',
        success: false,
      })
    );
    expect(JSON.stringify(mocks.saveTelemetry.mock.calls)).not.toMatch(/private|alice|file\.txt/);
  });

  it('logs an unreadable Save All inventory and preserves its original rejection', async () => {
    const documents = createNativeDocuments();
    const error = new Error('EIO: dirty inventory unavailable');
    vi.spyOn(documents.fileDocuments, 'listDirty').mockRejectedValue(error);
    await expect(documents.settleDirtyDocuments({ action: 'save' })).rejects.toBe(error);
    expect(mocks.bootLog.mock.calls.flat().join('\n')).toContain('EIO');
    expect(mocks.saveTelemetry).toHaveBeenCalledWith(
      'workflow_action_observed',
      expect.objectContaining({ error_class: 'eio', success: false })
    );
  });

  it('does not report successful settlement or discarded work as a save failure', async () => {
    const documents = createNativeDocuments();
    vi.spyOn(documents.fileDocuments, 'listDirty').mockResolvedValue([]);
    await documents.settleDirtyDocuments({ action: 'save' });
    await documents.settleDirtyDocuments({ action: 'discard' });
    expect(mocks.saveTelemetry).not.toHaveBeenCalled();
    expect(mocks.bootLog).not.toHaveBeenCalled();
  });

  it('binds the profile key derived from the user-data path', () => {
    const documents = createNativeDocuments();
    documents.bindProfile('/user-data');
    expect(mocks.bindProfile).toHaveBeenCalledWith('profile:/user-data');
  });

  it('makes the inventory owner unavailable immediately when the bound profile changes', async () => {
    const { documents, start } = started('renderer');
    await start;
    const target = { id: 9, isDestroyed: () => false } as unknown as import('electron').WebContents;
    documents.startRendererPublisher(() => target);
    documents.registerWorkspaceRootsHandler(() => true);
    const projects = mocks.handlers.get('inventory:projects');
    if (!projects) throw new Error('Inventory projects handler was not registered.');
    expect(projects({ sender: target })).toEqual([]);
    documents.bindProfile('/different-user-data');
    expect(() => projects({ sender: target })).toThrow('INVENTORY_OWNER_UNAVAILABLE');
  });

  it('refuses to start before its profile is bound', async () => {
    await expect(
      createNativeDocuments().start({
        editingClient: 'renderer',
        canAssertNoEditingClient: () => true,
      })
    ).rejects.toThrow('Native documents started before their profile.');
  });

  it('starts nothing without a native authority, except the managed runtime refuses', async () => {
    mocks.authority.value = null;
    await expect(started('renderer').start).resolves.toBeUndefined();
    expect(mocks.owners).toHaveLength(0);
    expect(mocks.startServer).not.toHaveBeenCalled();
    await expect(started('none').start).rejects.toThrow(
      'The managed runtime requires its own native document authority.'
    );
  });

  it('starts the owner, command server, registration and startup recovery for the authority', async () => {
    const { documents, start } = started('renderer');
    await start;

    expect(owner()).toMatchObject({ nativeOwnerInstanceId: 'owner-1', fetch: mocks.fetch });
    expect(mocks.startServer).toHaveBeenCalledTimes(1);
    expect(mocks.inventoryOptions[0]).toMatchObject({ profileKey: 'profile:/user-data' });
    expect(mocks.inventoryOptions[0]?.actor()).toBe('native:owner-1');
    const { getAuthority } = mocks.startServer.mock.calls[0]?.[0] as {
      getAuthority: () => unknown;
    };
    expect(getAuthority()).toBe(AUTHORITY);
    mocks.snapshotState.value = 'starting';
    expect(getAuthority()).toBeNull();
    expect(mocks.registerServer).toHaveBeenCalledWith('http://127.0.0.1:4100/', 'owner-1');
    expect(mocks.recoveries[0]?.options).toMatchObject({
      nativeOwnerInstanceId: 'owner-1',
      profileKey: 'profile:/user-data',
    });
    expect(mocks.recoveries[0]?.request).not.toHaveBeenCalled();
    expect(documents.workspaces.roots()).toEqual([]);
  });

  it('requests startup recovery at start when workspaces are already enrolled', async () => {
    const documents = createNativeDocuments();
    documents.bindProfile('/user-data');
    mocks.registeredRoots.push(ROOT);
    await documents.workspaces.replaceRoots([ROOT]);
    await documents.start({ editingClient: 'none', canAssertNoEditingClient: () => true });
    expect(mocks.recoveries[0]?.request).toHaveBeenCalledTimes(1);
  });

  it('wires inventory agent verification to the current shared grant authorizer', async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        ok: true,
        grants: [{ id: 'inventory-agent', scopes: ['read-workspace'] }],
        hasMore: false,
      })
    );
    await started('renderer').start;
    const { authorizeInventoryAgent } = mocks.startServer.mock.calls[0]?.[0] as {
      authorizeInventoryAgent: (
        agent: { identityId: string; capabilities: string[] },
        required: string[]
      ) => Promise<void>;
    };
    await expect(
      authorizeInventoryAgent(
        { identityId: 'inventory-agent', capabilities: ['read-workspace', 'write-workspace'] },
        ['read-workspace', 'write-workspace']
      )
    ).rejects.toThrow('INVENTORY_CAPABILITY_DENIED');
    expect(String(mocks.fetch.mock.calls[0]?.[0])).toContain('/agent-grants?');
  });

  it('protects a renderer edit with registered project authority independently of display', async () => {
    const { documents, start } = started('renderer');
    await start;
    mocks.registeredRoots.push(ROOT);
    await documents.workspaces.replaceRoots([ROOT]);

    await expect(owner().prepare('action-1', DOCUMENT)).rejects.toThrow(
      'Document editing protection is unavailable.'
    );

    documents.startRendererPublisher(() => null);
    const protection = vi
      .spyOn(documents.sequenceDocuments, 'protectCleanDocument')
      .mockResolvedValue({ assertCurrent: vi.fn(), finish: vi.fn(async () => {}), abort: vi.fn() });
    expect(mocks.publisher.start).toHaveBeenCalledTimes(1);
    const barrier = await owner().prepare('action-1', DOCUMENT);
    expect(protection).toHaveBeenCalledExactlyOnceWith(DOCUMENT.documentId, DOCUMENT.sourcePath);
    expect(mocks.createBarrier).toHaveBeenCalledWith(mocks.publisher, 'action-1');
    barrier.assertCurrent();
    expect(mocks.barrier.assertCurrent).toHaveBeenCalledTimes(1);
    await documents.workspaces.replaceRoots([]);
    expect(() => barrier.assertCurrent()).not.toThrow();
    mocks.registeredRoots.length = 0;
    expect(() => barrier.assertCurrent()).toThrow(
      'PROJECT_ACCESS_CHANGED: The registered project authority changed.'
    );
  });

  it('lets the managed runtime edit only while no editing client can exist', async () => {
    let noEditingClient = false;
    const { documents, start } = started('none', () => noEditingClient);
    await start;
    mocks.registeredRoots.push(ROOT);
    await documents.workspaces.replaceRoots([ROOT]);

    await expect(owner().prepare('action-1', DOCUMENT)).rejects.toThrow(
      'This runtime cannot assert that no editing client exists.'
    );

    noEditingClient = true;
    const protection = vi
      .spyOn(documents.sequenceDocuments, 'protectCleanDocument')
      .mockResolvedValue({ assertCurrent: vi.fn(), finish: vi.fn(async () => {}), abort: vi.fn() });
    const barrier = await owner().prepare('action-2', DOCUMENT);
    expect(protection).toHaveBeenCalledExactlyOnceWith(DOCUMENT.documentId, DOCUMENT.sourcePath);
    expect(mocks.createBarrier).not.toHaveBeenCalled();
    barrier.assertCurrent();
    await expect(barrier.finish()).resolves.toBe('not-required');
    expect(() => barrier.assertCurrent()).toThrow('Document protection was already released.');
  });

  it('enrolls workspace roots only from the current trusted renderer load', async () => {
    const { documents, start } = started('renderer');
    await start;
    const loads: string[] = [];
    documents.registerWorkspaceRootsHandler((_event, loadId) => {
      loads.push(loadId);
      return loadId === 'current';
    });
    const handler = mocks.handlers.get('workspace:setDocumentCommandRoots');
    if (!handler) throw new Error('workspace roots handler was not registered');
    const event = {} as IpcMainInvokeEvent;

    await expect(handler(event, trusted('stale'))).rejects.toThrow(
      'Untrusted document workspace enrollment sender.'
    );
    await expect(handler(event, { roots: [ROOT] })).rejects.toThrow(
      'Untrusted document workspace enrollment sender.'
    );
    expect(documents.workspaces.roots()).toEqual([]);

    mocks.registeredRoots.push(ROOT);
    await expect(handler(event, trusted('current'))).resolves.toBe(true);
    expect(documents.workspaces.roots()).toEqual([ROOT]);
    expect(mocks.recoveries[0]?.request).toHaveBeenCalledTimes(1);
    expect(loads).toEqual(['stale', 'current', 'current']);
  });

  it('shuts each part down once, in the steps the root calls', async () => {
    const { documents, start } = started('renderer');
    await start;
    documents.startRendererPublisher(() => ({}) as WebContents);
    expect(documents.rendererPublisher()).toBe(mocks.publisher);

    await documents.closeServerAndRecovery();
    await documents.closeServerAndRecovery();
    expect(mocks.serverClose).toHaveBeenCalledTimes(1);
    expect(mocks.recoveries[0]?.close).toHaveBeenCalledTimes(1);

    documents.detachCommandServer();
    documents.detachCommandServer();
    expect(mocks.detach).toHaveBeenCalledTimes(1);

    documents.stopRendererPublisher();
    documents.stopRendererPublisher();
    expect(mocks.publisher.stop).toHaveBeenCalledTimes(1);
    expect(documents.rendererPublisher()).toBeNull();
  });
});
