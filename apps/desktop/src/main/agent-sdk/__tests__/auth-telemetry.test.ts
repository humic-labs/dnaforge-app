import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ipcHandlers, mockCapture, mockAuthenticateAgentCli } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  mockCapture: vi.fn(),
  mockAuthenticateAgentCli: vi.fn(),
}));

vi.mock('posthog-node', () => {
  const MockPostHog = vi.fn(function () {
    return { capture: mockCapture, shutdown: vi.fn().mockResolvedValue(undefined) };
  });
  return { PostHog: MockPostHog };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', getPath: () => '/tmp/waypoint-test', isPackaged: false },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../anonymous-id', () => ({
  getAnonymousId: vi.fn(() => '550e8400-e29b-41d4-a716-446655440000'),
}));

vi.mock('../../ipc/database', () => ({
  getDb: () => {
    throw new Error('no db in unit test');
  },
}));

vi.mock('../auth', () => ({ authenticateAgentCli: mockAuthenticateAgentCli }));
vi.mock('../detect', () => ({ detectAgentSdk: vi.fn() }));
vi.mock('../query', () => ({ queryClaudeCode: vi.fn(), queryCodex: vi.fn() }));
vi.mock('../probe', () => ({
  buildStaticProviderProbeMatrix: vi.fn(),
  getProviderProbeVersions: vi.fn(),
}));
vi.mock('../../agent-tools-bridge', () => ({ cancelRendererToolCallsForTurn: vi.fn() }));

async function invoke(channel: string, ...args: unknown[]) {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({ sender: { send: vi.fn() } }, ...args);
}

async function setupHandlers(): Promise<void> {
  process.env.POSTHOG_API_KEY = 'phc_test123';
  const { initAnalyticsMain, syncAnalyticsIdentityContext } = await import('../../analytics');
  initAnalyticsMain(undefined, { consent: 'true', version: '3', basis: 'explicit' });
  syncAnalyticsIdentityContext({
    distinctId: '550e8400-e29b-41d4-a716-446655440001',
    sessionId: '550e8400-e29b-41d4-a716-446655440002',
    kind: 'anonymous',
    generation: 1,
  });
  const { registerAgentSdkHandlers } = await import('../index');
  registerAgentSdkHandlers();
}

function lastCaptureProps(): Record<string, unknown> {
  expect(mockCapture).toHaveBeenCalledTimes(2);
  const observations = mockCapture.mock.calls
    .map(([call]) => call)
    .filter((call) => call.event === 'agent_auth_state_observed');
  expect(observations).toHaveLength(1);
  expect(observations[0].properties).toMatchObject({
    auth_stage: 'native_result',
    operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    occurred_at_ms: expect.any(Number),
  });
  expect(observations[0].properties).not.toHaveProperty('command');
  expect(observations[0].properties).not.toHaveProperty('output');
  const call = mockCapture.mock.calls
    .map(([call]) => call)
    .find((call) => call.event === 'agent_auth_result') as {
    event: string;
    properties: Record<string, unknown>;
  };
  expect(call.event).toBe('agent_auth_result');
  return call.properties;
}

describe('agent_auth_result telemetry  emit site)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    await setupHandlers();
  });

  it('emits success:true with NO error_class on a completed sign-in', async () => {
    mockAuthenticateAgentCli.mockResolvedValue({
      authId: 'a',
      transport: 'codex-sdk',
      ok: true,
      status: 'completed',
      command: ['/usr/local/bin/codex', 'login'],
      output: '',
      durationMs: 1200,
    });

    await invoke('agentSdk:authenticate', 'codex-sdk', { authId: 'a' });

    const props = lastCaptureProps();
    expect(props).toMatchObject({
      feature_area: 'auth',
      success: true,
      duration_bucket: '1_5s',
    });
    expect(props).not.toHaveProperty('error_class');
    expect(props.platform_family).toEqual(expect.any(String));
    expect(props.app_version).toBe('1.2.3');
    expect(props).not.toHaveProperty('transport');
    expect(props).not.toHaveProperty('status');
    expect(props).not.toHaveProperty('failureKind');
    expect(props).not.toHaveProperty('spawnErrorCode');
  });

  it('encodes a claude spawn error as claude_spawn_error (distinct from exit_nonzero)', async () => {
    mockAuthenticateAgentCli.mockResolvedValue({
      authId: 'a',
      transport: 'claude-agent-sdk',
      ok: false,
      status: 'failed',
      failureKind: 'spawn_error',
      spawnErrorCode: 'ENOENT',
      command: ['claude', 'auth', 'login', '--claudeai'],
      output: '',
      durationMs: 40,
    });

    await invoke('agentSdk:authenticate', 'claude-agent-sdk', { authId: 'a' });

    const props = lastCaptureProps();
    expect(props).toMatchObject({
      feature_area: 'auth',
      success: false,
      error_class: 'claude_spawn_error',
      duration_bucket: 'lt_1s',
    });
    expect(props).not.toHaveProperty('spawnErrorCode');
  });

  it('encodes a non-zero exit as claude_exit_nonzero (does NOT collapse with spawn_error)', async () => {
    mockAuthenticateAgentCli.mockResolvedValue({
      authId: 'a',
      transport: 'claude-agent-sdk',
      ok: false,
      status: 'failed',
      failureKind: 'exit_nonzero',
      command: ['claude', 'auth', 'login', '--claudeai'],
      output: '',
      durationMs: 3000,
    });

    await invoke('agentSdk:authenticate', 'claude-agent-sdk', { authId: 'a' });

    expect(lastCaptureProps()).toMatchObject({
      success: false,
      error_class: 'claude_exit_nonzero',
      duration_bucket: '1_5s',
    });
  });

  it('encodes a missing CLI as claude_not_installed', async () => {
    mockAuthenticateAgentCli.mockResolvedValue({
      authId: 'a',
      transport: 'claude-agent-sdk',
      ok: false,
      status: 'not_installed',
      failureKind: 'not_installed',
      command: ['claude', 'auth', 'login', '--claudeai'],
      output: '',
      durationMs: 5,
    });

    await invoke('agentSdk:authenticate', 'claude-agent-sdk', { authId: 'a' });

    expect(lastCaptureProps()).toMatchObject({
      success: false,
      error_class: 'claude_not_installed',
      duration_bucket: 'lt_1s',
    });
  });

  it('encodes a codex timeout as codex_timed_out with a 30s+ duration bucket', async () => {
    mockAuthenticateAgentCli.mockResolvedValue({
      authId: 'a',
      transport: 'codex-sdk',
      ok: false,
      status: 'timed_out',
      failureKind: 'timed_out',
      command: ['/usr/local/bin/codex', 'login'],
      output: '',
      durationMs: 600_000,
    });

    await invoke('agentSdk:authenticate', 'codex-sdk', { authId: 'a' });

    expect(lastCaptureProps()).toMatchObject({
      success: false,
      error_class: 'codex_timed_out',
      duration_bucket: '30s_plus',
    });
  });

  it('emits unknown_invalid_transport on the invalid-transport IPC branch without launching a CLI', async () => {
    await invoke('agentSdk:authenticate', 'bogus-sdk', { authId: 'a' });

    expect(mockAuthenticateAgentCli).not.toHaveBeenCalled();
    expect(lastCaptureProps()).toMatchObject({
      feature_area: 'auth',
      success: false,
      error_class: 'unknown_invalid_transport',
      duration_bucket: 'lt_1s',
    });
  });

  it('still emits a failure event (and re-throws) when authenticateAgentCli itself throws', async () => {
    mockAuthenticateAgentCli.mockRejectedValue(new Error('detect() blew up'));

    await expect(
      invoke('agentSdk:authenticate', 'claude-agent-sdk', { authId: 'a' })
    ).rejects.toThrow('detect() blew up');

    expect(lastCaptureProps()).toMatchObject({
      feature_area: 'auth',
      success: false,
      error_class: 'claude_handler_error',
    });
  });
});
