// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: {},
  create: vi.fn(),
  register: vi.fn(),
  setOwner: vi.fn(),
  capture: vi.fn(),
  providers: vi.fn(async () => []),
  dependencies: vi.fn(),
}));
vi.mock('../ipc/administration', () => ({
  createNativeAdministrationCommands: mocks.create,
  registerAdministrationHandlers: mocks.register,
}));
vi.mock('../compute/ipc', () => ({
  createComputeIpcHandlers: () => ({ listProviders: mocks.providers }),
}));
vi.mock('../sidecar-capabilities', () => ({ DEFAULT_MCP_GRANT_CAPABILITIES: ['read-workspace'] }));
vi.mock('../sidecar-session-runtime', () => ({ sidecarFetch: vi.fn() }));
vi.mock('../ipc/database', () => ({ getDb: vi.fn() }));
vi.mock('./native-documents', () => ({
  nativeDocuments: { setAdministration: mocks.setOwner, workspaces: { capture: mocks.capture } },
}));
vi.mock('./workspace-sync', () => ({
  workspaceSync: { ipcDependencies: mocks.dependencies },
}));

describe('administration main feature', () => {
  it('binds one early native owner and later registers that same owner with live sync actions', async () => {
    mocks.create.mockReturnValue(mocks.owner);
    mocks.dependencies.mockReturnValue(undefined);
    const { administrationFeature, prepareNativeAdministration } = await import('./administration');
    expect(() => administrationFeature.registerIpc!()).toThrow('has not been prepared');
    const getMainWindow = () => null;
    prepareNativeAdministration({ getMainWindow, appVersion: 'test-version' });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.setOwner).toHaveBeenCalledWith(mocks.owner);
    const deps = mocks.create.mock.calls[0][0];
    expect(deps.getMainWindow).toBe(getMainWindow);
    expect(deps.appVersion).toBe('test-version');
    await expect(deps.forceSync('project')).resolves.toMatchObject({ ok: false });
    const forceSync = vi.fn(async () => ({ ok: true }));
    mocks.dependencies.mockReturnValue({ actions: { forceSync } });
    await expect(deps.forceSync('project')).resolves.toEqual({ ok: true });
    expect(forceSync).toHaveBeenCalledWith('project');
    administrationFeature.registerIpc!();
    expect(mocks.register).toHaveBeenCalledWith(deps, mocks.owner);
    expect(() =>
      prepareNativeAdministration({ getMainWindow, appVersion: 'test-version' })
    ).toThrow('already prepared');
  });
});
