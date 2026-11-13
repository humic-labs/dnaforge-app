// @vitest-environment node
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  ipcRenderer: {},
}));
const registry = vi.hoisted(() => ({
  profile: {
    endpointId: 'endpoint-1',
    displayName: 'Cluster',
    target: 'me@cluster.example',
  },
  success: vi.fn(),
}));
vi.mock('../remote-endpoint-registry', () => ({
  findRemoteEndpointProfileByTarget: (_db: unknown, target: string) =>
    target === registry.profile.target ? registry.profile : null,
  listRemoteEndpointProfiles: () => [registry.profile],
  renameRemoteEndpointProfile: () => null,
  forgetRemoteEndpointProfile: () => true,
  recordRemoteEndpointSuccess: registry.success,
  saveRemoteEndpointProfile: () => registry.profile,
}));
vi.mock('../ipc/database', () => ({
  getDb: () => {
    throw new Error('Unexpected real database');
  },
}));
vi.mock('./reference-assets', () => ({
  referenceAssetsFeature: { id: 'reference-assets' },
}));
vi.mock('./auth', () => ({ authFeature: { id: 'auth' } }));
vi.mock('./memory-pressure', () => ({ memoryPressureFeature: { id: 'memory-pressure' } }));
vi.mock('./beta-attribution', () => ({ betaAttributionFeature: { id: 'beta-attribution' } }));
vi.mock('./share-links', () => ({ shareLinksFeature: { id: 'share-links' } }));
vi.mock('./native-documents', () => ({ nativeDocuments: {} }));
vi.mock('./agent-tools-bridge', () => ({ agentToolsBridge: {} }));
vi.mock('./mcp-http', () => ({ startMcpHttpServices: () => undefined }));
vi.mock('./workspace-sync', () => ({ workspaceSync: {} }));
vi.mock('./file-associations', () => ({
  fileAssociations: {},
  fileAssociationsFeature: { id: 'file-associations' },
}));
vi.mock('../remote-host-service', () => ({
  remoteHostService: { stopAll: vi.fn(async () => undefined) },
}));

import { mainFeatureShutdownSteps, prepareMainFeatureProfile, MAIN_FEATURES } from '.';
import { scientificRecoveryFeature } from './scientific-recovery';
import { registerRemoteHostsIpc, remoteHostsFeature } from './remote-hosts';

const database = () => ({}) as Database.Database;
const service = {
  status: vi.fn(() => ({ state: 'unknown' as const })),
  signIn: vi.fn(async () => ({ state: 'verified' as const })),
  checkAccess: vi.fn(async () => ({ state: 'verified' as const, checkedAt: 42 })),
  openTerminal: vi.fn(async () => undefined),
  endConnection: vi.fn(async () => true),
};
const invoke = (channel: string, ...args: unknown[]) => {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...args);
};

beforeEach(() => {
  ipc.handlers.clear();
  vi.clearAllMocks();
});

describe('remote hosts feature', () => {
  it('registers every remoteHosts channel and removes them again', () => {
    const dispose = registerRemoteHostsIpc(database, service as never);
    expect([...ipc.handlers.keys()].sort()).toEqual([
      'remoteHosts:checkAccess',
      'remoteHosts:endConnection',
      'remoteHosts:forget',
      'remoteHosts:list',
      'remoteHosts:openTerminal',
      'remoteHosts:rename',
      'remoteHosts:save',
      'remoteHosts:signIn',
    ]);
    dispose();
    expect(ipc.handlers.size).toBe(0);
  });

  it('lists saved hosts with their access state and records a verified access check', async () => {
    registerRemoteHostsIpc(database, service as never);
    expect(await invoke('remoteHosts:list')).toEqual([
      { profile: registry.profile, access: { state: 'unknown' } },
    ]);
    expect(await invoke('remoteHosts:checkAccess', registry.profile.target)).toEqual({
      state: 'verified',
      checkedAt: 42,
    });
    expect(registry.success).toHaveBeenCalledWith(expect.anything(), {
      ...registry.profile,
      lastConnectedAt: 42,
      lastFailure: null,
    });
  });

  it('refuses to sign in to a host that was never saved', async () => {
    registerRemoteHostsIpc(database, service as never);
    await expect(invoke('remoteHosts:signIn', 'stranger@elsewhere')).rejects.toThrow(
      'Save this host in Remote hosts before signing in.'
    );
    expect(service.signIn).not.toHaveBeenCalled();
  });

  it('is on the main feature list and stops the remote host service at quit', async () => {
    expect(MAIN_FEATURES).toContain(remoteHostsFeature);
    const step = mainFeatureShutdownSteps().find((s) => s.name === 'remote host service');
    expect(step).toBeDefined();
    await step!.run();
    const { remoteHostService } = await import('../remote-host-service');
    expect(remoteHostService.stopAll).toHaveBeenCalledTimes(1);
  });
});

describe('main feature list', () => {
  it('prepares the resolved profile before proceeding and propagates ownership refusal', () => {
    expect(MAIN_FEATURES).toContain(scientificRecoveryFeature);
    const later = vi.fn();
    const path = '/owned/resolved/profile';
    const refuse = vi.fn(() => {
      throw new Error('profile already owned');
    });
    expect(() =>
      prepareMainFeatureProfile(path, [
        { id: 'ownership', prepareProfile: refuse },
        { id: 'later', prepareProfile: later },
      ])
    ).toThrow('profile already owned');
    expect(refuse).toHaveBeenCalledWith(path);
    expect(later).not.toHaveBeenCalled();
  });

  it('rejects a repeated feature id or shutdown step name', async () => {
    const { assertUniqueMainFeatures } = await import('.');
    const step = { name: 'stop', run: () => undefined };
    expect(() => assertUniqueMainFeatures([{ id: 'a' }, { id: 'a' }])).toThrow(
      'Main feature "a" is registered twice.'
    );
    expect(() =>
      assertUniqueMainFeatures([
        { id: 'a', shutdown: step },
        { id: 'b', shutdown: step },
      ])
    ).toThrow('Main features share the shutdown step name "stop".');
    expect(() => assertUniqueMainFeatures(MAIN_FEATURES)).not.toThrow();
  });
});
