import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeTextFileAtomicInMain } from './text-file-atomic';

type Client = 'claude' | 'codex' | 'grok';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function externalMcpClientEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (result.WAYPOINT_TEST === '1' && result.DNAFORGE_EXTERNAL_MCP_CONFIG_HOME) {
    const home = result.DNAFORGE_EXTERNAL_MCP_CONFIG_HOME;
    result.CLAUDE_CONFIG_DIR = join(home, '.claude');
    result.CODEX_HOME = join(home, '.codex');
    result.GROK_HOME = join(home, '.grok');
    result.GROK_CLAUDE_MCPS_ENABLED = 'false';
    result.GROK_CURSOR_MCPS_ENABLED = 'false';
  }
  return result;
}

function configPath(client: Client, environment: NodeJS.ProcessEnv): string {
  const env = externalMcpClientEnvironment(environment);
  if (client === 'claude') return join(env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
  return join(
    client === 'codex'
      ? (env.CODEX_HOME ?? join(homedir(), '.codex'))
      : (env.GROK_HOME ?? join(homedir(), '.grok')),
    'config.toml'
  );
}

async function readRegularFile(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error('Client config is not a regular file.');
  return readFile(path, 'utf8');
}

export async function inspectClaudeMcpConfig(environment: NodeJS.ProcessEnv) {
  try {
    const config: unknown = JSON.parse(await readRegularFile(configPath('claude', environment)));
    if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers)))
      return { ok: false, stdout: 'Invalid Claude Code config' };
    const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
    const entry = servers.dnaforge;
    return entry === undefined
      ? { ok: false, stdout: 'No MCP server named dnaforge' }
      : { ok: true, stdout: JSON.stringify({ transport: entry }) };
  } catch (error) {
    return {
      ok: false,
      stdout:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'No MCP server named dnaforge'
          : 'Could not read Claude Code config',
    };
  }
}

export async function repairNativeMcpConfig(
  client: Client,
  previous: string,
  launcher: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  try {
    const path = configPath(client, environment);
    const original = await readRegularFile(path);
    let content: string;
    if (client === 'claude') {
      const config = JSON.parse(original) as {
        mcpServers?: Record<string, { command?: string; args?: unknown[] }>;
      };
      const entry = config.mcpServers?.dnaforge;
      if (!entry) return false;
      if (entry.command === previous) entry.command = launcher;
      else if (
        entry.command === 'cmd' &&
        entry.args?.[0] === '/c' &&
        entry.args[1] === previous &&
        entry.args[2] === 'mcp'
      )
        entry.args[1] = launcher;
      else return false;
      content = `${JSON.stringify(config, null, 2)}\n`;
    } else {
      const header =
        /^[\t ]*\[mcp_servers\.(?:dnaforge|"dnaforge"|'dnaforge')\][\t ]*(?:#.*)?\r?$/mu.exec(
          original
        );
      if (!header) return false;
      const start = header.index + header[0].length;
      const remaining = original.slice(start);
      const next = /^[\t ]*\[/mu.exec(remaining);
      const end = start + (next?.index ?? remaining.length);
      const section = original.slice(start, end);
      const command = /^[\t ]*command[\t ]*=[\t ]*("(?:\\.|[^"\\])*"|'[^']*')/mu.exec(section);
      if (!command) return false;
      const value = command[1].startsWith('"') ? JSON.parse(command[1]) : command[1].slice(1, -1);
      let valueStart: number;
      let valueLength: number;
      if (value === previous) {
        valueStart = command.index + command[0].length - command[1].length;
        valueLength = command[1].length;
      } else if (value === 'cmd') {
        const args = /^[\t ]*args[\t ]*=[\t ]*\[([\s\S]*?)\]/mu.exec(section);
        if (!args) return false;
        const literals = [...args[1].matchAll(/"(?:\\.|[^"\\])*"|'[^']*'/gu)];
        const decoded = literals.map(([raw]) =>
          raw.startsWith('"') ? JSON.parse(raw) : raw.slice(1, -1)
        );
        if (decoded[0] !== '/c' || decoded[1] !== previous || decoded[2] !== 'mcp') return false;
        valueStart = args.index + args[0].indexOf('[') + 1 + literals[1].index!;
        valueLength = literals[1][0].length;
      } else return false;
      const updated =
        section.slice(0, valueStart) +
        JSON.stringify(launcher) +
        section.slice(valueStart + valueLength);
      content = original.slice(0, start) + updated + original.slice(end);
    }
    await writeFile(`${path}.dnaforge-backup-${randomUUID()}`, original, {
      flag: 'wx',
      mode: 0o600,
    });
    await writeTextFileAtomicInMain(
      { path, content },
      {
        renameFile: async (temporary, destination) => {
          if ((await readRegularFile(path)) !== original)
            throw new Error('Client config changed during repair.');
          await rename(temporary, destination);
        },
      }
    );
    return true;
  } catch {
    return false;
  }
}
