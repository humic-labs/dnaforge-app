import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDesktopMcpClients } from './external-mcp-desktop-clients';

const LAUNCHER = '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge';

describe('automatic local desktop MCP registration', () => {
  let home: string;
  let claudeConfig: string;
  let cursorConfig: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dnaforge-external-client-'));
    claudeConfig = join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
    cursorConfig = join(home, '.cursor', 'mcp.json');
    await mkdir(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
    await mkdir(join(home, '.cursor'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const register = () =>
    registerDesktopMcpClients(LAUNCHER, { home, platform: 'darwin', applicationDirectories: [] });
  const config = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

  it('registers existing desktop apps without a setup gesture, key or port', async () => {
    expect(await register()).toEqual([
      { client: 'Claude Desktop', status: 'registered' },
      { client: 'Cursor', status: 'registered' },
    ]);
    for (const path of [claudeConfig, cursorConfig]) {
      expect(await config(path)).toEqual({
        mcpServers: { dnaforge: { command: LAUNCHER, args: ['mcp'] } },
      });
      expect(await readFile(path, 'utf8')).not.toMatch(/token|key|127\.0\.0\.1|29183/);
    }
    expect((await register()).map((client) => client.status)).toEqual(['current', 'current']);
  });

  it('preserves other settings and servers and backs up the original file', async () => {
    const original =
      '{"preferences":{"theme":"dark"},"mcpServers":{"other":{"command":"other"}}}\n';
    await writeFile(claudeConfig, original);
    await register();
    expect(await config(claudeConfig)).toMatchObject({
      preferences: { theme: 'dark' },
      mcpServers: { other: { command: 'other' } },
    });
    const backups = (await readdir(join(home, 'Library', 'Application Support', 'Claude'))).filter(
      (name) => name.includes('.dnaforge-backup-')
    );
    expect(backups).toHaveLength(1);
    expect(
      await readFile(join(home, 'Library', 'Application Support', 'Claude', backups[0]), 'utf8')
    ).toBe(original);
  });

  it('repairs only the old DNAForge launcher and preserves its options', async () => {
    await writeFile(
      cursorConfig,
      JSON.stringify({
        mcpServers: {
          dnaforge: {
            command: '/Applications/DNAForge Old.app/Contents/Resources/cli/dnaforge',
            args: ['mcp', '--workspace', '/my/project'],
            env: { EXAMPLE: 'value' },
          },
        },
      })
    );
    expect((await register())[1].status).toBe('repaired');
    expect((await config(cursorConfig)).mcpServers.dnaforge).toEqual({
      command: LAUNCHER,
      args: ['mcp', '--workspace', '/my/project'],
      env: { EXAMPLE: 'value' },
    });
  });

  it('leaves conflicts and malformed settings untouched while registering other clients', async () => {
    const conflict = JSON.stringify({
      mcpServers: { dnaforge: { command: 'unrelated', args: ['serve'] } },
    });
    await writeFile(claudeConfig, conflict);
    await writeFile(cursorConfig, '{broken');
    expect(await register()).toEqual([
      { client: 'Claude Desktop', status: 'name-conflict' },
      { client: 'Cursor', status: 'failed' },
    ]);
    expect(await readFile(claudeConfig, 'utf8')).toBe(conflict);
    expect(await readFile(cursorConfig, 'utf8')).toBe('{broken');
  });

  it('does not replace symlinks or settings another process changed during registration', async () => {
    const target = join(home, 'user-owned.json');
    await writeFile(target, '{}');
    await symlink(target, claudeConfig);
    await writeFile(cursorConfig, '{}');
    const changed = '{"preferences":{"changed":true}}';
    const results = await registerDesktopMcpClients(LAUNCHER, {
      home,
      platform: 'darwin',
      applicationDirectories: [],
      beforeCommit: async (path) => {
        await writeFile(path, changed);
      },
    });
    expect(results.map((client) => client.status)).toEqual(['failed', 'failed']);
    expect(await readFile(target, 'utf8')).toBe('{}');
    expect(await readFile(cursorConfig, 'utf8')).toBe(changed);
  });

  it('uses the Windows app-data directory and a command-shell launcher', async () => {
    const appData = join(home, 'Roaming');
    await mkdir(join(appData, 'Claude'), { recursive: true });
    const launcher = 'C:\\Program Files\\DNAForge\\resources\\cli\\dnaforge.cmd';
    await registerDesktopMcpClients(launcher, { home, appData, platform: 'win32' });
    expect(
      (await config(join(appData, 'Claude', 'claude_desktop_config.json'))).mcpServers.dnaforge
    ).toEqual({ command: 'cmd', args: ['/c', launcher, 'mcp'] });
    expect((await config(cursorConfig)).mcpServers.dnaforge).toEqual({
      command: 'cmd',
      args: ['/c', launcher, 'mcp'],
    });
  });

  it('does not create profiles for absent apps', async () => {
    await rm(join(home, '.cursor'), { recursive: true });
    await rm(join(home, 'Library'), { recursive: true });
    expect((await register()).map((client) => client.status)).toEqual([
      'not-installed',
      'not-installed',
    ]);
    expect(await readdir(home)).toEqual([]);
  });

  it('registers an installed macOS app before its first client launch', async () => {
    await rm(join(home, '.cursor'), { recursive: true });
    await rm(join(home, 'Library'), { recursive: true });
    const applications = join(home, 'Applications');
    await mkdir(join(applications, 'Claude.app'), { recursive: true });
    await mkdir(join(applications, 'Cursor.app'));
    expect(
      (
        await registerDesktopMcpClients(LAUNCHER, {
          home,
          platform: 'darwin',
          applicationDirectories: [applications],
        })
      ).map((client) => client.status)
    ).toEqual(['registered', 'registered']);
    expect((await config(claudeConfig)).mcpServers.dnaforge.command).toBe(LAUNCHER);
    expect((await config(cursorConfig)).mcpServers.dnaforge.command).toBe(LAUNCHER);
  });
});
