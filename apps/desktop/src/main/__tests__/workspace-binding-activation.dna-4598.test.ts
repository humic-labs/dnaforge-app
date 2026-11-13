import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

vi.mock('../ipc/database', () => ({ getDb: vi.fn() }));

vi.mock('../registered-project-authority', () => ({
  createRegisteredProjectAuthority: () => ({ folders: () => [] }),
}));

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => '/tmp' },
  BrowserWindow: { fromWebContents: vi.fn() },
}));

it('acknowledges committed workspace bindings only through current private sidecar authority', async () => {
  const { startAgentToolsBridge } = await import('../agent-tools-bridge');
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
  };
  const server = await startAgentToolsBridge(window as never, {
    sessionToken: 'bridge-token',
    observationSessionToken: () => 'current-sidecar',
  });
  const bind = (source: string, origin?: string) =>
    fetch(`${server.url}/__external-access/workspace-bound`, {
      method: 'POST',
      headers: {
        'X-DNAForge-Session': 'bridge-token',
        'X-DNAForge-Sidecar-Session': source,
        ...(origin ? { Origin: origin } : {}),
      },
    });
  try {
    expect(
      (await fetch(`${server.url}/__external-access/workspace-bound`, { method: 'POST' })).status
    ).toBe(401);
    expect((await bind('old-sidecar')).status).toBe(401);
    expect((await bind('current-sidecar', 'http://untrusted')).status).toBe(403);
    expect((await bind('current-sidecar')).status).toBe(200);
    expect((await bind('current-sidecar')).status).toBe(200);
  } finally {
    await server.close();
  }
});
