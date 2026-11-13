import { resolve } from 'node:path';

export function requestsManagedRuntime(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--managed-runtime' || arg.startsWith('--managed-runtime='));
}

export function parseManagedRuntimeLaunch(
  argv: readonly string[],
  cwd: string
): { workspaceRoots: string[] } | null {
  if (requestsManagedRuntime(argv)) {
    if (
      argv.filter((arg) => arg === '--managed-runtime').length !== 1 ||
      argv.some((arg) => arg.startsWith('--managed-runtime='))
    ) {
      throw new Error('Use --managed-runtime to start an explicit foreground operation owner.');
    }
  } else return null;
  const roots: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg !== '--workspace' && !arg.startsWith('--workspace=')) continue;
    const value = arg === '--workspace' ? argv[++index] : arg.slice('--workspace='.length);
    if (!value || value.startsWith('--') || value.length > 4096) {
      throw new Error('Each --workspace requires a directory path.');
    }
    roots.push(resolve(cwd, value));
  }
  const workspaceRoots = [...new Set(roots)];
  if (workspaceRoots.length > 128) throw new Error('At most 128 workspaces may be enrolled.');
  return { workspaceRoots };
}
