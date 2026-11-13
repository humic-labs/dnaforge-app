// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false, once: vi.fn() },
  listener: vi.fn(),
  register: vi.fn(),
  stop: vi.fn(),
  port: vi.fn(() => 7399),
  getDb: vi.fn(),
}));

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('../external-mcp-registration', () => ({ startExternalMcpRegistration: mocks.register }));
vi.mock('../ipc/database', () => ({ getDb: mocks.getDb }));
vi.mock('../mcp-http-listener', () => ({
  mcpHttpAllowedHostsFile: () => '/user-data/mcp-allowed-hosts.json',
  mcpHttpInternalPort: mocks.port,
  startMcpHttpListener: mocks.listener,
}));

import { startMcpHttpServices } from './mcp-http';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app.isPackaged = false;
  mocks.register.mockReturnValue(mocks.stop);
  vi.stubEnv('WAYPOINT_TEST', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('MCP HTTP main feature', () => {
  it('starts the listener with the database, allowed hosts and the sidecar port reader', () => {
    startMcpHttpServices();

    expect(mocks.listener).toHaveBeenCalledWith({
      allowed: false,
      database: mocks.getDb,
      allowedHostsFile: '/user-data/mcp-allowed-hosts.json',
      sidecarPort: mocks.port,
    });
  });

  it('allows the listener in a packaged app or a WAYPOINT_TEST run', () => {
    mocks.app.isPackaged = true;
    startMcpHttpServices();
    mocks.app.isPackaged = false;
    vi.stubEnv('WAYPOINT_TEST', '1');
    startMcpHttpServices();

    expect(mocks.listener.mock.calls.map((call) => call[0].allowed)).toEqual([true, true]);
  });

  it('registers with external MCP clients and stops that registration at quit', () => {
    startMcpHttpServices();

    expect(mocks.register).toHaveBeenCalledWith({
      isPackaged: false,
      resourcesPath: process.resourcesPath,
    });
    expect(mocks.app.once).toHaveBeenCalledWith('will-quit', mocks.stop);
  });
});
