import { posix, win32 } from 'node:path';

export const DNAFORGE_DATA_ROOT_ENV = 'DNAFORGE_DATA_ROOT';

export interface ResolveDataRootInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
}

export function resolveDnaforgeDataRoot(input: ResolveDataRootInput): string {
  const path = input.platform === 'win32' ? win32 : posix;
  const override = input.env[DNAFORGE_DATA_ROOT_ENV]?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error(`${DNAFORGE_DATA_ROOT_ENV} must be an absolute path.`);
    }
    return path.resolve(override);
  }
  switch (input.platform) {
    case 'win32': {
      const local = input.env.LOCALAPPDATA?.trim();
      return path.join(local || path.join(input.home, 'AppData', 'Local'), 'DNAForge');
    }
    case 'darwin':
      return path.join(input.home, 'Library', 'Application Support', 'DNAForge');
    default: {
      const xdg = input.env.XDG_DATA_HOME?.trim();
      return path.join(
        xdg && path.isAbsolute(xdg) ? xdg : path.join(input.home, '.local', 'share'),
        'DNAForge'
      );
    }
  }
}
