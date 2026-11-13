import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

const PROCESS_GUARDIAN_NAME = 'dna-process-guardian-x86_64-pc-windows-msvc.exe';

export interface ProcessGuardianPathInput {
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly explicitPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export function resolveProcessGuardianPath(input: ProcessGuardianPathInput): string | undefined {
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') return undefined;

  const arch = input.arch ?? process.arch;
  if (arch !== 'x64' && arch !== 'x86_64' && arch !== 'amd64') {
    throw new Error(`Windows process containment is unsupported on ${platform}/${arch}.`);
  }

  const explicitPath = input.explicitPath?.trim();
  if (!input.isPackaged && explicitPath) return win32.resolve(explicitPath);
  if (input.isPackaged) {
    return win32.join(win32.dirname(input.resourcesPath), 'Helpers', PROCESS_GUARDIAN_NAME);
  }

  const direct = win32.join(input.appPath, 'resources', 'helpers', PROCESS_GUARDIAN_NAME);
  if (existsSync(direct)) return direct;
  const builtAppFallback = win32.resolve(
    input.appPath,
    '..',
    '..',
    'resources',
    'helpers',
    PROCESS_GUARDIAN_NAME
  );
  return existsSync(builtAppFallback) ? builtAppFallback : direct;
}
