import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGetRemoteHostsTool,
  createManageRemoteHostTool,
  manageRemoteHostSchema,
  getRemoteHostsOutputSchema,
  manageRemoteHostOutputSchema,
} from './remote-hosts';
const api = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  checkAccess: vi.fn(),
  signIn: vi.fn(),
  openTerminal: vi.fn(),
  endConnection: vi.fn(),
  rename: vi.fn(),
  forget: vi.fn(),
}));
vi.mock('../../../platform', () => ({ platform: () => ({ remoteHosts: api }) }));

describe('agent Remote hosts operations use the product host service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([]);
  });
  it('reads cached observations without starting authentication or opening files', async () => {
    const result = await createGetRemoteHostsTool().execute!(
      {},
      { toolCallId: 'host-list', messages: [] }
    );
    expect(getRemoteHostsOutputSchema.safeParse(result)).toMatchObject({ success: true });
    expect(result).toMatchObject({ ok: true, hosts: [] });
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.checkAccess).not.toHaveBeenCalled();
  });
  it('checks only the requested saved host and reports missing authentication as an observation', async () => {
    api.checkAccess.mockResolvedValue({
      target: 'lab-hpc',
      state: 'needs-authentication',
      checkedAt: null,
      connection: 'none',
      activeConsumers: 0,
      lastFailure: { code: 'authentication-required', message: 'Use Terminal.' },
    });
    const result = await createGetRemoteHostsTool().execute!(
      { target: 'lab-hpc' },
      { toolCallId: 'host-check', messages: [] }
    );
    expect(getRemoteHostsOutputSchema.safeParse(result)).toMatchObject({ success: true });
    expect(result).toMatchObject({ ok: true, access: { state: 'needs-authentication' } });
    expect(api.checkAccess).toHaveBeenCalledExactlyOnceWith('lab-hpc');
    expect(api.signIn).not.toHaveBeenCalled();
  });
  it('saves metadata without logging in and rejects credential fields', async () => {
    api.save.mockResolvedValue({
      profile: {
        endpointId: 'host-1',
        displayName: 'Lab cluster',
        target: 'lab-hpc',
        lastConnectedAt: null,
        observedPlatform: null,
        lastFailure: null,
      },
      access: {
        target: 'lab-hpc',
        state: 'not-checked',
        checkedAt: null,
        connection: 'none',
        activeConsumers: 0,
        lastFailure: null,
      },
    });
    const result = await createManageRemoteHostTool().execute!(
      { action: 'save', target: 'lab-hpc', displayName: 'Lab cluster' },
      { toolCallId: 'host-save', messages: [] }
    );
    expect(manageRemoteHostOutputSchema.safeParse(result)).toMatchObject({ success: true });
    expect(result).toMatchObject({ ok: true, host: { profile: { lastConnectedAt: null } } });
    expect(api.save).toHaveBeenCalledExactlyOnceWith({
      target: 'lab-hpc',
      displayName: 'Lab cluster',
    });
    expect(api.signIn).not.toHaveBeenCalled();
    expect(
      manageRemoteHostSchema.safeParse({
        action: 'sign_in',
        target: 'lab-hpc',
        password: 'never accepted',
      }).success
    ).toBe(false);
    expect(
      manageRemoteHostSchema.safeParse({ action: 'sign_in', target: '-oProxyCommand=evil' }).success
    ).toBe(false);
  });
});
