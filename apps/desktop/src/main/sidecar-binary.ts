import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';

export interface SidecarBinaryOptions {
  resourcesPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  pathExists?: (path: string) => boolean;
}

export interface McpCompanionExecutableOptions extends SidecarBinaryOptions {
  isPackaged: boolean;
  appPath: string;
  resolvePython?: (apiDir: string) => string;
}

export interface McpCompanionExecutable {
  command: string;
  args: string[];
}

export function sidecarTripleForPlatform(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  return 'x86_64-unknown-linux-gnu';
}

export function resolvePackagedSidecarPath(options: SidecarBinaryOptions): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathExists = options.pathExists ?? existsSync;
  const extension = platform === 'win32' ? '.exe' : '';
  const basePath = join(options.resourcesPath, 'binaries');
  const nativeTriple = sidecarTripleForPlatform(platform, arch);
  const nativePath = join(basePath, `waypoint-api-${nativeTriple}`, `waypoint-api${extension}`);

  if (pathExists(nativePath)) {
    return nativePath;
  }

  const tried = [nativePath];
  if (platform === 'darwin' && arch === 'arm64') {
    const rosettaPath = join(
      basePath,
      'waypoint-api-x86_64-apple-darwin',
      `waypoint-api${extension}`
    );
    tried.push(rosettaPath);
    if (pathExists(rosettaPath)) {
      return rosettaPath;
    }
  }

  throw new Error(
    `[Sidecar] Binary not found. Tried:\n${tried.map((path) => `  ${path}`).join('\n')}\n` +
      `Run: cd apps/api && ./scripts/build-sidecar.sh`
  );
}

export function resolveApiDir(
  appPath: string,
  pathExists: (path: string) => boolean = existsSync
): string {
  const directPath = join(dirname(appPath), 'api');
  if (pathExists(directPath)) {
    return directPath;
  }

  const appsDir = appPath.replace(/[/\\]apps[/\\]desktop[/\\].*$/, `${sep}apps`);
  return join(appsDir, 'api');
}

function devPythonCandidates(apiDir: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? [join(apiDir, '.venv', 'Scripts', 'python.exe')]
    : [join(apiDir, '.venv', 'bin', 'python3'), join(apiDir, '.venv', 'bin', 'python')];
}

export function resolveDevPython(
  apiDir: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync
): string {
  const localCandidates = devPythonCandidates(apiDir, platform);
  const localPython = localCandidates.find(pathExists);
  if (localPython) {
    return localPython;
  }

  try {
    const worktreeRoot = resolve(apiDir, '..', '..');
    const gitFile = readFileSync(join(worktreeRoot, '.git'), 'utf8');
    const gitDirValue = /^gitdir:\s*(.+)$/m.exec(gitFile)?.[1]?.trim();
    if (gitDirValue) {
      const gitDir = resolve(worktreeRoot, gitDirValue);
      const marker = `${sep}.git${sep}worktrees${sep}`;
      const markerIndex = gitDir.indexOf(marker);
      if (markerIndex > 0) {
        const primaryPython = devPythonCandidates(
          join(gitDir.slice(0, markerIndex), 'apps', 'api'),
          platform
        ).find(pathExists);
        if (primaryPython) {
          return primaryPython;
        }
      }
    }
  } catch {}

  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: apiDir,
    });
    const primaryLine = output.split('\n').find((line) => line.startsWith('worktree '));
    if (primaryLine) {
      const primaryPython = devPythonCandidates(
        join(primaryLine.slice('worktree '.length).trim(), 'apps', 'api'),
        platform
      ).find(pathExists);
      if (primaryPython) {
        return primaryPython;
      }
    }
  } catch {}

  throw new Error(
    `[Sidecar] Python venv not found.\n` +
      `  Checked: ${localCandidates.join(', ')}\n` +
      `  To fix: cd apps/api && uv sync --extra dev`
  );
}

export function resolveMcpCompanionExecutable(
  options: McpCompanionExecutableOptions
): McpCompanionExecutable {
  if (options.isPackaged) {
    return {
      command: resolvePackagedSidecarPath(options),
      args: ['--mcp-stdio'],
    };
  }

  const pathExists = options.pathExists ?? existsSync;
  const apiDir = resolveApiDir(options.appPath, pathExists);
  const python = options.resolvePython
    ? options.resolvePython(apiDir)
    : resolveDevPython(apiDir, options.platform ?? process.platform, pathExists);
  return {
    command: python,
    args: [join(apiDir, 'run_server.py'), '--mcp-stdio'],
  };
}
