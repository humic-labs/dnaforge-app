// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectClaudeMcpConfig, repairNativeMcpConfig } from './external-mcp-config-files';

describe('native MCP config preservation', () => {
  let home: string;
  let environment: NodeJS.ProcessEnv;
  const oldPath = '/Applications/DNAForge Old.app/Contents/Resources/cli/dnaforge';
  const newPath = '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge';
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dnaforge-native-config-'));
    environment = { WAYPOINT_TEST: '1', DNAFORGE_EXTERNAL_MCP_CONFIG_HOME: home };
    for (const name of ['.claude', '.codex', '.grok']) await mkdir(join(home, name));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it.each(['codex', 'grok'] as const)(
    'repairs only %s command and preserves comments, choices and other servers',
    async (client) => {
      const path = join(home, `.${client}`, 'config.toml');
      const original = `# Personal config\n[mcp_servers.dnaforge]\ncommand = ${JSON.stringify(oldPath)} # installed copy\nargs = ["mcp", "--workspace", "/my/project"]\nenabled = false\nstartup_timeout_sec = 90\n[mcp_servers.dnaforge.env]\nEXAMPLE = "preserved"\n[mcp_servers.other]\ncommand = ${JSON.stringify(oldPath)}\n`;
      await writeFile(path, original);
      expect(await repairNativeMcpConfig(client, oldPath, newPath, environment)).toBe(true);
      expect(await readFile(path, 'utf8')).toBe(
        original.replace(JSON.stringify(oldPath), JSON.stringify(newPath))
      );
    }
  );

  it('repairs Windows command-shell arguments without removing workspace or environment choices', async () => {
    const old = 'C:\\Old\\DNAForge\\resources\\cli\\dnaforge.cmd';
    const next = 'C:\\Program Files\\DNAForge\\resources\\cli\\dnaforge.cmd';
    const path = join(home, '.codex', 'config.toml');
    const original = `[mcp_servers.dnaforge]\ncommand = "cmd"\nargs = ["/c", ${JSON.stringify(old)}, "mcp", "--workspace", "D:/project"]\nenabled = false\n`;
    await writeFile(path, original);
    expect(await repairNativeMcpConfig('codex', old, next, environment)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(
      original.replace(JSON.stringify(old), JSON.stringify(next))
    );
  });

  it('reads Claude configuration without launching a server and preserves all other values on repair', async () => {
    const path = join(home, '.claude', '.claude.json');
    const original = {
      preferences: { example: true },
      mcpServers: {
        dnaforge: {
          command: oldPath,
          args: ['mcp', '--workspace', '/project'],
          env: { EXAMPLE: 'preserved' },
        },
        other: { command: 'other' },
      },
    };
    await writeFile(path, JSON.stringify(original));
    expect(await inspectClaudeMcpConfig(environment)).toEqual({
      ok: true,
      stdout: JSON.stringify({ transport: original.mcpServers.dnaforge }),
    });
    expect(await repairNativeMcpConfig('claude', oldPath, newPath, environment)).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ...original,
      mcpServers: {
        ...original.mcpServers,
        dnaforge: { ...original.mcpServers.dnaforge, command: newPath },
      },
    });
  });

  it.each(['{broken', '{"mcpServers":[]}'])(
    'refuses invalid Claude configuration instead of reporting an absent server',
    async (text) => {
      await writeFile(join(home, '.claude', '.claude.json'), text);
      const inspected = await inspectClaudeMcpConfig(environment);
      expect(inspected.ok).toBe(false);
      expect(inspected.stdout).not.toContain('No MCP server');
    }
  );

  it('refuses a symlink and an unexpected old command without changing the file', async () => {
    const target = join(home, 'user-owned.toml');
    const original = '[mcp_servers.dnaforge]\ncommand = "/bin/other"\n';
    await writeFile(target, original);
    await symlink(target, join(home, '.grok', 'config.toml'));
    expect(await repairNativeMcpConfig('grok', oldPath, newPath, environment)).toBe(false);
    await writeFile(join(home, '.codex', 'config.toml'), original);
    expect(await repairNativeMcpConfig('codex', oldPath, newPath, environment)).toBe(false);
    expect(await readFile(target, 'utf8')).toBe(original);
  });
});
