import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidecarSessionAuthority } from '../../sidecar-session-authority';
import { createReadyCliMcpBridgeProvider } from '../cli-mcp-provider';
import { buildCliMcpServerLaunch, buildCodexMcpConfig } from '../cli-mcp';

function createProvider(authority: SidecarSessionAuthority) {
  const build = vi.fn((snapshot: { token: string }) => ({
    apiUrl: 'http://sidecar.test.invalid',
    sessionToken: snapshot.token,
    agentIdentityId: 'local-in-app-chat',
    capabilities: ['read-workspace'],
    command: '/test/companion',
    commandArgs: ['--mcp-stdio'],
  }));
  return { build, provide: createReadyCliMcpBridgeProvider(authority, build) };
}

describe('ready CLI MCP bridge provider', () => {
  afterEach(() => vi.useRealTimers());

  it('does not delegate a credential until the current generation is ready', async () => {
    const authority = new SidecarSessionAuthority();
    const spawn = authority.prepareManagedSpawn('initial');
    const { build, provide } = createProvider(authority);
    const pending = provide();
    await Promise.resolve();
    expect(build).not.toHaveBeenCalled();

    authority.markReady(spawn.generation);
    const config = await pending;
    expect(build).toHaveBeenCalledTimes(1);
    expect(config?.sessionToken).toBe(spawn.token);
    expect(() => config?.assertCurrent?.()).not.toThrow();
  });

  it('reacquires readiness if restart revokes a resolved snapshot before continuation', async () => {
    const authority = new SidecarSessionAuthority();
    const first = authority.prepareManagedSpawn('initial');
    authority.markReady(first.generation);
    const { build, provide } = createProvider(authority);
    const pending = provide();
    authority.markRestarting();
    const second = authority.prepareManagedSpawn('respawn');
    await Promise.resolve();
    expect(build).not.toHaveBeenCalled();
    authority.markReady(second.generation);

    const config = await pending;
    expect(build).toHaveBeenCalledTimes(1);
    expect(config?.sessionToken).toBe(second.token);
    expect(config?.sessionToken).not.toBe(first.token);
  });

  it('rejects a revoked generation at launch without serializing the main callback', async () => {
    const authority = new SidecarSessionAuthority();
    authority.markReady(authority.prepareManagedSpawn('initial').generation);
    const { provide } = createProvider(authority);
    const config = await provide();
    if (!config) throw new Error('Expected a ready bridge');
    const launch = buildCliMcpServerLaunch(config);
    expect(JSON.stringify(buildCodexMcpConfig(launch))).not.toContain('assertCurrent');
    authority.markRestarting();
    authority.markReady(authority.prepareManagedSpawn('respawn').generation);
    expect(() => buildCodexMcpConfig(launch)).toThrow(/SIDECAR_SESSION_CHANGED/);
    expect(() => buildCliMcpServerLaunch(config)).toThrow(/SIDECAR_SESSION_CHANGED/);
  });

  it('stops a pending wait and cannot launch when readiness arrives later', async () => {
    const authority = new SidecarSessionAuthority();
    const spawn = authority.prepareManagedSpawn('initial');
    const controller = new AbortController();
    const { build, provide } = createProvider(authority);
    const pending = provide(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    authority.markReady(spawn.generation);
    await Promise.resolve();
    expect(build).not.toHaveBeenCalled();
  });

  it('fails closed when the authority stops', async () => {
    const authority = new SidecarSessionAuthority();
    const { build, provide } = createProvider(authority);
    const pending = provide();
    authority.markStopped();
    await expect(pending).rejects.toMatchObject({ code: 'SIDECAR_SESSION_UNAVAILABLE' });
    expect(build).not.toHaveBeenCalled();
  });

  it('bounds the readiness wait and releases its timer', async () => {
    vi.useFakeTimers();
    const authority = new SidecarSessionAuthority();
    const { build, provide } = createProvider(authority);
    const rejected = expect(provide()).rejects.toMatchObject({
      code: 'SIDECAR_SESSION_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(build).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
