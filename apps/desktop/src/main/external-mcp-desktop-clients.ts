import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ExternalMcpRegistrationResult,
  ExternalMcpRegistrationStatus,
} from '../shared/external-mcp-registration';
import { externalMcpStdioConfig } from '../shared/external-mcp-registration';
import { writeTextFileAtomicInMain } from './text-file-atomic';

interface DesktopClientOptions {
  home: string;
  platform: string;
  appData?: string;
  applicationDirectories?: string[];
  beforeCommit?: (path: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function registerDesktopMcpClients(
  launcher: string,
  options: DesktopClientOptions = {
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
  }
): Promise<ExternalMcpRegistrationResult[]> {
  const { home, platform } = options;
  const applicationDirectories =
    platform === 'darwin'
      ? (options.applicationDirectories ?? ['/Applications', join(home, 'Applications')])
      : [];
  const claudeDirectory =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude')
      : platform === 'win32'
        ? join(options.appData ?? join(home, 'AppData', 'Roaming'), 'Claude')
        : null;
  const clients = [
    {
      client: 'Claude Desktop' as const,
      path: claudeDirectory && join(claudeDirectory, 'claude_desktop_config.json'),
      indicators: [
        claudeDirectory,
        ...applicationDirectories.map((root) => join(root, 'Claude.app')),
      ],
    },
    {
      client: 'Cursor' as const,
      path: join(home, '.cursor', 'mcp.json'),
      indicators: [
        join(home, '.cursor'),
        ...applicationDirectories.map((root) => join(root, 'Cursor.app')),
      ],
    },
  ];
  const results: ExternalMcpRegistrationResult[] = [];
  for (const client of clients) {
    let status: ExternalMcpRegistrationStatus;
    try {
      const installed = await Promise.all(
        client.indicators.flatMap((path) => (path === null ? [] : [path])).map(exists)
      );
      status =
        client.path && installed.some(Boolean)
          ? await registerJsonClient(client.path, launcher, options)
          : 'not-installed';
    } catch {
      status = 'failed';
    }
    results.push({ client: client.client, status });
  }
  return results;
}

async function originalText(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error('Client configuration must be a regular file.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function registerJsonClient(
  path: string,
  launcher: string,
  options: DesktopClientOptions
): Promise<ExternalMcpRegistrationStatus> {
  const original = await originalText(path);
  const parsed: unknown = original === null ? {} : JSON.parse(original);
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    throw new Error('Invalid client configuration.');
  }
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  const existing = servers.dnaforge;
  const desired = externalMcpStdioConfig(launcher, options.platform);
  let status: ExternalMcpRegistrationStatus = 'registered';
  let entry: Record<string, unknown> = desired;
  if (existing !== undefined) {
    if (!isRecord(existing) || !Array.isArray(existing.args)) return 'name-conflict';
    const windows = options.platform === 'win32';
    const existingLauncher = windows ? existing.args[1] : existing.command;
    const mcpIndex = windows ? 2 : 0;
    if (
      (windows && (existing.command !== 'cmd' || existing.args[0] !== '/c')) ||
      existing.args[mcpIndex] !== 'mcp' ||
      typeof existingLauncher !== 'string'
    )
      return 'name-conflict';
    if (existingLauncher === launcher) return 'current';
    if (!/\/resources\/cli\/dnaforge(?:\.cmd)?$/iu.test(existingLauncher.replaceAll('\\', '/')))
      return 'name-conflict';
    entry = {
      ...existing,
      ...desired,
      args: [...desired.args, ...existing.args.slice(mcpIndex + 1)],
    };
    status = 'repaired';
  }
  const content = `${JSON.stringify({ ...parsed, mcpServers: { ...servers, dnaforge: entry } }, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  if (original !== null) {
    await writeFile(`${path}.dnaforge-backup-${randomUUID()}`, original, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  await writeTextFileAtomicInMain(
    { path, content },
    {
      renameFile: async (temporaryPath, destinationPath) => {
        await options.beforeCommit?.(path);
        if ((await originalText(path)) !== original)
          throw new Error('Client configuration changed during registration.');
        await rename(temporaryPath, destinationPath);
      },
    }
  );
  return status;
}
