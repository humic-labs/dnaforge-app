import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpHttpSettings, McpHttpStatus } from '../../../shared/mcp-http';
import {
  applyExternalAgentAccess,
  createGetExternalAgentAccessTool,
  configureExternalAgentAccessOutputSchema,
  externalAgentAccessOutputSchema,
  configureExternalAgentAccessSchema,
  readExternalAgentAccess,
} from './external-agent-access';

const LAUNCHER = '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge';
const getMcpHttpStatus = vi.fn<() => Promise<McpHttpStatus>>();
const setMcpHttp = vi.fn<(settings: McpHttpSettings) => Promise<McpHttpStatus>>();

vi.mock('../../../platform', () => ({
  platform: () => ({
    agentSdk: {
      getExternalMcpRegistration: async () => ({
        state: 'complete',
        launcher: LAUNCHER,
        clients: [{ client: 'Codex', status: 'registered' }],
      }),
      getMcpHttpStatus,
      setMcpHttp,
    },
  }),
}));

const OFF: McpHttpStatus = {
  enabled: false,
  port: 29183,
  allowedHosts: ['relay.example'],
  state: 'off',
  url: null,
};

describe('external agent access tools', () => {
  beforeEach(() => {
    getMcpHttpStatus.mockReset().mockResolvedValue(OFF);
    setMcpHttp.mockReset();
  });

  it('reads registration, the web address, and ready-to-paste setup', async () => {
    const access = await readExternalAgentAccess();

    expect(access.registration.clients).toEqual([{ client: 'Codex', status: 'registered' }]);
    expect(access.urlAccess).toEqual(OFF);
    expect(access.localSetup.find((setup) => setup.id === 'cursor')?.text).toContain(LAUNCHER);
    expect(access.urlSetup).toEqual([]);
    expect(access.keyNote).toContain('agents cannot create keys');
  });

  it('changes only the fields given and returns URL setup once listening', async () => {
    setMcpHttp.mockImplementation(async (settings) => ({
      ...settings,
      state: 'listening',
      url: `http://127.0.0.1:${settings.port}/mcp`,
    }));

    const result = await applyExternalAgentAccess({ urlAccessEnabled: true });

    expect(setMcpHttp).toHaveBeenCalledWith({
      enabled: true,
      port: 29183,
      allowedHosts: ['relay.example'],
    });
    expect(result).toMatchObject({ ok: true, urlAccess: { state: 'listening' } });
    expect(JSON.stringify(result)).toContain('http://127.0.0.1:29183/mcp');
  });

  it('reports a busy port as a failure that says the setting was saved', async () => {
    setMcpHttp.mockResolvedValue({
      enabled: true,
      port: 29183,
      allowedHosts: [],
      state: 'port-in-use',
      url: null,
      message: 'Another program is using port 29183. Choose a different port.',
    });

    const result = await applyExternalAgentAccess({ urlAccessEnabled: true, allowedHosts: [] });

    expect(result).toMatchObject({
      ok: false,
      code: 'PORT_IN_USE',
      stateChanged: true,
      partialEffects: ['saved-settings'],
    });
  });

  it('refuses outside the installed app without changing anything', async () => {
    getMcpHttpStatus.mockResolvedValue({ ...OFF, state: 'unavailable' });

    const result = await applyExternalAgentAccess({ urlAccessEnabled: true });

    expect(result).toMatchObject({
      ok: false,
      code: 'URL_ACCESS_UNAVAILABLE',
      stateChanged: false,
    });
    expect(setMcpHttp).not.toHaveBeenCalled();
  });

  it('rejects a host name the sidecar would not accept', () => {
    expect(
      configureExternalAgentAccessSchema.safeParse({ allowedHosts: ['*.ts.net'] }).success
    ).toBe(false);
    expect(
      configureExternalAgentAccessSchema.safeParse({ allowedHosts: ['laptop.tailnet.ts.net:443'] })
        .success
    ).toBe(true);
  });
});

it('validates real read and configuration receipts against their distinct MCP contracts', async () => {
  getMcpHttpStatus.mockResolvedValue(OFF);
  setMcpHttp.mockResolvedValue(OFF);
  const read = await createGetExternalAgentAccessTool().execute!(
    {},
    { toolCallId: 'read', messages: [] }
  );
  expect(externalAgentAccessOutputSchema.safeParse(read)).toMatchObject({ success: true });
  const configured = await applyExternalAgentAccess({ urlAccessEnabled: false });
  expect(configureExternalAgentAccessOutputSchema.safeParse(configured)).toMatchObject({
    success: true,
  });
});
