// @vitest-environment node
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ObservationOptions = { observationSessionToken: () => string | null; port?: number };
type Provider = () => (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  startBridge: vi.fn(),
  confirm: vi.fn(),
  request: vi.fn(),
  sdkConfirm: vi.fn(),
  sdkRequest: vi.fn(),
  sessionConfirm: vi.fn(),
  sessionRequest: vi.fn(),
  companion: vi.fn(),
  currentToken: vi.fn(),
  snapshot: {
    value: { state: 'ready', token: 'session-token' } as { state: string; token?: string },
  },
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/user-data' },
}));
vi.mock('../agent-confirm', () => ({
  confirmDestructiveFileWithRenderer: mocks.confirm,
  requestAgentUserInputWithRenderer: mocks.request,
}));
vi.mock('../agent-sdk', () => ({
  setAgentSdkConfirmDestructiveFileProvider: mocks.sdkConfirm,
  setAgentSdkRequestUserInputProvider: mocks.sdkRequest,
}));
vi.mock('../agent-session', () => ({
  setAgentSessionConfirmDestructiveFileProvider: mocks.sessionConfirm,
  setAgentSessionRequestUserInputProvider: mocks.sessionRequest,
}));
vi.mock('../agent-tools-bridge', () => ({ startAgentToolsBridge: mocks.startBridge }));
vi.mock('../sidecar-binary', () => ({ resolveMcpCompanionExecutable: mocks.companion }));
vi.mock('../sidecar-session-runtime', () => ({
  sidecarSessionAuthority: {
    snapshot: () => mocks.snapshot.value,
    currentToken: mocks.currentToken,
  },
}));
vi.mock('./test-hooks', () => ({ testRendererBridgeOptions: () => ({ port: 4555 }) }));

import { createAgentToolsBridge } from './agent-tools-bridge';

const mainWindow = { id: 1 } as BrowserWindow;
const server = (close = vi.fn(async () => {})) => ({
  url: 'http://127.0.0.1:4555',
  sessionToken: 'bridge-token',
  agentIdentityId: 'local-in-app-chat',
  capabilities: ['tools.read'],
  close,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.value = { state: 'ready', token: 'session-token' };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('DNAFORGE_MCP_AGENT_IDENTITY', undefined);
  vi.stubEnv('DNAFORGE_MCP_GRANT_CAPABILITIES', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('agent tools bridge main feature', () => {
  it('starts the bridge with the test options and a ready-only observation token', async () => {
    mocks.startBridge.mockResolvedValue(server());
    const bridge = createAgentToolsBridge();

    await bridge.start(mainWindow);

    expect(mocks.startBridge).toHaveBeenCalledWith(
      mainWindow,
      expect.objectContaining({ port: 4555 })
    );
    const options = mocks.startBridge.mock.calls[0]?.[1] as ObservationOptions;
    expect(options.observationSessionToken()).toBe('session-token');
    mocks.snapshot.value = { state: 'starting' };
    expect(options.observationSessionToken()).toBeNull();
    expect(bridge.current()?.url).toBe('http://127.0.0.1:4555');
    expect(bridge.sidecarConnection()).toEqual({
      url: 'http://127.0.0.1:4555',
      sessionToken: 'bridge-token',
    });
  });

  it('publishes the chat identity and grant only when the environment has none', async () => {
    mocks.startBridge.mockResolvedValue(server());
    await createAgentToolsBridge().start(mainWindow);
    expect(process.env.DNAFORGE_MCP_AGENT_IDENTITY).toBe('local-in-app-chat');
    expect(process.env.DNAFORGE_MCP_GRANT_CAPABILITIES).toBe('["tools.read"]');

    vi.stubEnv('DNAFORGE_MCP_AGENT_IDENTITY', 'operator-identity');
    vi.stubEnv('DNAFORGE_MCP_GRANT_CAPABILITIES', '["operator"]');
    await createAgentToolsBridge().start(mainWindow);
    expect(process.env.DNAFORGE_MCP_AGENT_IDENTITY).toBe('operator-identity');
    expect(process.env.DNAFORGE_MCP_GRANT_CAPABILITIES).toBe('["operator"]');
  });

  it('keeps going without a bridge when it fails to start', async () => {
    mocks.startBridge.mockRejectedValue(new Error('port in use'));
    const bridge = createAgentToolsBridge();

    await expect(bridge.start(mainWindow)).resolves.toBeUndefined();

    expect(bridge.current()).toBeNull();
    expect(bridge.sidecarConnection()).toBeUndefined();
    expect(() => bridge.requireReady()).toThrow(
      'The molecular agent tool bridge is unavailable. Restart the app and retry.'
    );
    expect(mocks.currentToken).not.toHaveBeenCalled();
  });

  it('is ready for molecular tools only with a bridge, a session token and a companion', async () => {
    mocks.startBridge.mockResolvedValue(server());
    const bridge = createAgentToolsBridge();
    await bridge.start(mainWindow);

    bridge.requireReady();
    expect(mocks.currentToken).toHaveBeenCalledTimes(1);
    expect(mocks.companion).toHaveBeenCalledWith({
      isPackaged: false,
      appPath: '/app',
      resourcesPath: process.resourcesPath,
    });

    mocks.currentToken.mockImplementationOnce(() => {
      throw new Error('session not ready');
    });
    expect(() => bridge.requireReady()).toThrow('session not ready');
  });

  it('closes the bridge once and logs a failed close', async () => {
    const failingClose = vi.fn(async () => {
      throw new Error('socket busy');
    });
    mocks.startBridge.mockResolvedValue(server(failingClose));
    const bridge = createAgentToolsBridge();
    await bridge.start(mainWindow);

    bridge.close();
    bridge.close();

    expect(failingClose).toHaveBeenCalledTimes(1);
    expect(bridge.current()).toBeNull();
    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith(
        '[AgentToolsBridge] Failed to close renderer bridge:',
        expect.any(Error)
      )
    );
  });

  it('routes agent confirmations and input requests to the renderer of the given window', () => {
    createAgentToolsBridge().installRendererPrompts(mainWindow);
    const signal = new AbortController().signal;
    const provided = (setter: ReturnType<typeof vi.fn>) =>
      (setter.mock.calls[0]?.[0] as Provider)();

    provided(mocks.sdkConfirm)('sdk-confirm');
    expect(mocks.confirm).toHaveBeenLastCalledWith(mainWindow, 'sdk-confirm');
    provided(mocks.sdkRequest)('sdk-input', signal);
    expect(mocks.request).toHaveBeenLastCalledWith(mainWindow, 'sdk-input', undefined, signal);
    provided(mocks.sessionConfirm)('session-confirm', signal);
    expect(mocks.confirm).toHaveBeenLastCalledWith(
      mainWindow,
      'session-confirm',
      undefined,
      signal
    );
    provided(mocks.sessionRequest)('session-input', signal);
    expect(mocks.request).toHaveBeenLastCalledWith(mainWindow, 'session-input', undefined, signal);
  });
});
