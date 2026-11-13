import { beforeEach, describe, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ handle: vi.fn(), capture: vi.fn(), report: vi.fn() }));

vi.mock('../analytics', () => ({
  captureOptionalTelemetryOrigin: () => null,
  enqueueOptionalAnalyticsEvent: () => false,
  enqueueOptionalAnalyticsEventFromReceipt: () => false,
}));

vi.mock('electron', () => ({ ipcMain: { handle: seam.handle } }));
vi.mock('./skill-observation', async (original) => ({
  ...(await original<typeof import('./skill-observation')>()),
  captureSkillObservation: seam.capture,
  reportSkillOwnerReturn: seam.report,
}));
import { registerAgentCapabilityHandlers } from './ipc';
const observation = {
  operationId: '20000000-0000-4000-8000-000000000001',
  eventId: '20000000-0000-4000-8000-000000000002',
  returnEventId: '20000000-0000-4000-8000-000000000003',
  origin: {
    consentScope: '10000000-0000-4000-8000-000000000001',
    contextId: '10000000-0000-4000-8000-000000000002',
    processId: '10000000-0000-4000-8000-000000000003',
    classification: 'synthetic' as const,
  },
};
function handler(channel: string) {
  const entry = seam.handle.mock.calls.find(([name]) => name === channel);
  if (!entry) throw new Error(`Missing ${channel}`);
  return entry[1] as (...args: unknown[]) => Promise<unknown>;
}
function fixture() {
  const extensionStore = {
    list: vi.fn(),
    saveCommand: vi.fn(),
    removeCommand: vi.fn(),
    saveSkill: vi.fn(),
    importSkill: vi.fn(),
    setSkillEnabled: vi.fn(),
    setProviderSkillPolicy: vi.fn(),
    removeProviderSkillPolicy: vi.fn(),
    removeSkill: vi.fn(),
  };
  const service = {
    discover: vi.fn(),
    resolve: vi.fn(),
    invalidate: vi.fn(),
    inspectContext: vi.fn(() => ({
      ok: true,
      snapshot: {},
      control: {
        kind: 'skill',
        nativeId: 'private-native-skill',
        provider: 'codex-sdk',
        source: 'provider-native',
      },
    })) as never,
  };
  registerAgentCapabilityHandlers({
    extensionStore,
    service,
    assertWorkspacePath: vi.fn(async () => '/canonical/workspace'),
  });
  return { extensionStore, service };
}
const selection = {
  snapshotId: 'private-snapshot',
  provider: 'codex-sdk',
  capabilityId: 'private-capability',
};
beforeEach(() => {
  vi.clearAllMocks();
  seam.capture.mockReturnValue(observation);
});
describe('Skills failed IPC action provenance', () => {
  it('records a managed disable failure under the admitted closed action and preserves the native error', async () => {
    const { extensionStore } = fixture();
    extensionStore.setSkillEnabled.mockRejectedValue(
      new Error('Synthetic managed disable refused')
    );
    expect(
      await handler('agentCapabilities:setSkillEnabled')({}, { id: 'native-1', enabled: false })
    ).toEqual({ ok: false, error: 'Synthetic managed disable refused' });
    expect(extensionStore.setSkillEnabled).toHaveBeenCalledWith(
      { id: 'native-1', enabled: false },
      observation
    );
    expect(seam.report).toHaveBeenCalledWith(observation, 'disable', 'failed', expect.any(Object));
  });
  it.each([
    { inheritGlobal: false, enabled: false, action: 'disable', owner: 'setProviderSkillPolicy' },
    {
      inheritGlobal: true,
      enabled: undefined,
      action: 'inherit',
      owner: 'removeProviderSkillPolicy',
    },
  ] as const)(
    'preserves the actual provider $action failure',
    async ({ inheritGlobal, enabled, action, owner }) => {
      const { extensionStore } = fixture();
      extensionStore[owner].mockRejectedValue(new Error(`Synthetic ${action} refused`));
      const result = await handler('agentCapabilities:setProviderSkillEnabled')(
        {},
        { selection, inheritGlobal, enabled, scope: 'workspace', workspacePath: '/workspace' }
      );
      expect(result).toEqual({ ok: false, error: `Synthetic ${action} refused` });
      expect(seam.report).toHaveBeenCalledWith(observation, action, 'failed', {
        host: 'codex-sdk',
        scope: 'workspace',
        source: 'provider_native',
      });
    }
  );
  it.each(['agentCapabilities:setSkillEnabled', 'agentCapabilities:setProviderSkillEnabled'])(
    'uses unknown before valid admission for %s',
    async (channel) => {
      const { extensionStore } = fixture();
      const result = await handler(channel)({}, null);
      expect(result).toMatchObject({ ok: false });
      expect(seam.report).toHaveBeenCalledWith(observation, 'unknown', 'failed', {});
      expect(extensionStore.setSkillEnabled).not.toHaveBeenCalled();
      expect(extensionStore.setProviderSkillPolicy).not.toHaveBeenCalled();
      expect(extensionStore.removeProviderSkillPolicy).not.toHaveBeenCalled();
    }
  );
  it('does not reread a hostile request getter during failed diagnostics or replace the primary error', async () => {
    const { extensionStore } = fixture();
    let reads = 0;
    const request = {
      id: 'native-1',
      get enabled() {
        reads += 1;
        throw new Error('Synthetic primary getter error');
      },
    };
    expect(await handler('agentCapabilities:setSkillEnabled')({}, request)).toEqual({
      ok: false,
      error: 'Synthetic primary getter error',
    });
    expect(reads).toBe(1);
    expect(seam.report).toHaveBeenCalledWith(observation, 'unknown', 'failed', {});
    expect(extensionStore.setSkillEnabled).not.toHaveBeenCalled();
  });
  it('keeps a captured disable action even when the original request is changed during a rejected native await', async () => {
    const { extensionStore } = fixture();
    const request = { id: 'native-1', enabled: false };
    extensionStore.setSkillEnabled.mockImplementation(async () => {
      Object.defineProperty(request, 'enabled', {
        get() {
          throw new Error('Synthetic diagnostic replacement');
        },
      });
      throw new Error('Synthetic primary native error');
    });
    expect(await handler('agentCapabilities:setSkillEnabled')({}, request)).toEqual({
      ok: false,
      error: 'Synthetic primary native error',
    });
    expect(seam.report).toHaveBeenCalledWith(observation, 'disable', 'failed', expect.any(Object));
  });
  it('preserves malformed discovery rejection and emits no invented host or install state', async () => {
    const { service } = fixture();
    await expect(
      handler('agentCapabilities:discover')(
        {},
        { provider: 'hostile-private-provider', workspacePath: null }
      )
    ).rejects.toThrow('Invalid agent capability discovery request');
    expect(service.discover).not.toHaveBeenCalled();
    expect(seam.report).toHaveBeenCalledWith(observation, 'discover', 'failed', {
      source: 'mixed',
    });
  });
  it('derives runtime discovery and effective enablement from actual returned controls without claiming installed or loaded', async () => {
    const { service } = fixture();
    const snapshot = {
      capturedAt: 42,
      controls: [
        {
          kind: 'skill',
          stages: { discoverable: true, invocable: false },
          availability: { state: 'disabled-by-policy' },
        },
      ],
    };
    service.discover.mockResolvedValue(snapshot);
    expect(
      await handler('agentCapabilities:discover')(
        {},
        { provider: 'codex-sdk', workspacePath: null }
      )
    ).toBe(snapshot);
    expect(seam.report).toHaveBeenCalledWith(
      observation,
      'discover',
      'runtime_returned',
      expect.objectContaining({
        host: 'codex-sdk',
        scope: 'global',
        runtime: 'discovered',
        effectiveEnablement: 'not_attested',
        observedAtMs: 42,
      })
    );
    const details = seam.report.mock.calls.at(-1)![3];
    expect(details).not.toHaveProperty('installed');
    expect(details).not.toHaveProperty('instruction');
  });
});
