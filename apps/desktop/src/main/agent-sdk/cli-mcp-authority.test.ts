import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SidecarSessionAuthority } from '../sidecar-session-authority';
import { createCliMcpAuthorityReceipt } from './cli-mcp-authority';
import { buildCliMcpServerLaunch } from './cli-mcp';

describe('launch-owned delegated compute authority', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps real publication and shutdown permission faults outside compute supervision',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'cli-mcp-authority-fault-test-'));
      const authority = new SidecarSessionAuthority();
      const receipt = createCliMcpAuthorityReceipt({
        directory,
        authority,
        getApiUrl: () => 'http://127.0.0.1:8107',
      });
      const hostDirectory = dirname(receipt.path);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        chmodSync(hostDirectory, 0o500);
        expect(() => authority.markRestarting()).not.toThrow();
        expect(() => receipt.dispose()).not.toThrow();
      } finally {
        chmodSync(hostDirectory, 0o700);
        error.mockRestore();
        receipt.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
  it('publishes only a ready credential from the same host across compute restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cli-mcp-authority-test-'));
    const authority = new SidecarSessionAuthority();
    const receipt = createCliMcpAuthorityReceipt({
      directory,
      authority,
      getApiUrl: () => 'http://127.0.0.1:8107',
    });
    const read = () => JSON.parse(readFileSync(receipt.path, 'utf8'));
    try {
      expect(read()).toMatchObject({
        ownerId: receipt.ownerId,
        state: 'starting',
        sessionToken: '',
      });
      const first = authority.prepareManagedSpawn('initial');
      authority.markReady(first.generation);
      const body = read();
      expect(body).toEqual({
        version: 1,
        ownerId: receipt.ownerId,
        apiUrl: 'http://127.0.0.1:8107',
        generation: 1,
        state: 'ready',
        sessionToken: first.token,
      });
      if (process.platform !== 'win32') expect(statSync(receipt.path).mode & 0o777).toBe(0o600);
      authority.markRestarting();
      expect(read()).toMatchObject({ state: 'restarting', sessionToken: '' });
      const second = authority.prepareManagedSpawn('manual_restart');
      authority.markReady(second.generation);
      expect(read()).toMatchObject({
        ownerId: receipt.ownerId,
        generation: 2,
        sessionToken: second.token,
      });
      expect(second.token).not.toBe(first.token);
      authority.markStopped();
      expect(read()).toMatchObject({
        ownerId: receipt.ownerId,
        state: 'stopped',
        sessionToken: '',
      });
    } finally {
      receipt.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes the exact owner binding without putting authority or credentials in arguments', () => {
    const launch = buildCliMcpServerLaunch({
      apiUrl: 'http://127.0.0.1:8107',
      sessionToken: 'current-compute',
      sessionAuthority: { path: '/private/exact-host/session.json', ownerId: 'exact-host' },
      agentIdentityId: 'same-grant',
      capabilities: ['read-workspace'],
      turnId: 'same-turn',
      command: 'companion',
      commandArgs: ['--mcp-stdio'],
    });
    expect(launch.args).toEqual(['--mcp-stdio']);
    expect(launch.env).toMatchObject({
      DNAFORGE_MCP_SESSION_AUTHORITY_PATH: '/private/exact-host/session.json',
      DNAFORGE_MCP_SESSION_AUTHORITY_OWNER: 'exact-host',
      DNAFORGE_MCP_AGENT_IDENTITY: 'same-grant',
      DNAFORGE_MCP_TURN_ID: 'same-turn',
      DNAFORGE_MCP_API_KEY: '',
    });
  });
});
