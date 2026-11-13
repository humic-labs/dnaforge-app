import { join } from 'node:path';

export interface PackagedSidecarLaunchInput {
  readonly binaryPath: string;
  readonly apiPort: string;
  readonly guardianPath?: string;
  readonly ownerPid: number;
  readonly platform?: NodeJS.Platform;
}

export interface PackagedSidecarLaunch {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface DevelopmentSidecarLaunchInput {
  readonly pythonPath: string;
  readonly apiDir: string;
  readonly apiPort: string;
  readonly ownerPid: number;
  readonly platform?: NodeJS.Platform;
}

export interface DevelopmentSidecarLaunch extends PackagedSidecarLaunch {
  readonly ownerEnv: Record<string, string>;
}

export function resolveDevelopmentSidecarLaunch(
  input: DevelopmentSidecarLaunchInput
): DevelopmentSidecarLaunch {
  return {
    executable: input.pythonPath,
    args: [
      join(input.apiDir, 'run_server.py'),
      '--port',
      input.apiPort,
      '--host',
      '127.0.0.1',
      '--reload',
    ],
    ownerEnv: packagedSidecarOwnerEnv(input.ownerPid, input.platform),
  };
}

export function packagedSidecarOwnerEnv(
  ownerPid: number,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  return platform === 'win32' ? {} : { DNAFORGE_SIDECAR_OWNER_PID: String(ownerPid) };
}

export function resolvePackagedSidecarLaunch(
  input: PackagedSidecarLaunchInput
): PackagedSidecarLaunch {
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') {
    return { executable: input.binaryPath, args: ['--port', input.apiPort] };
  }

  const guardianPath = input.guardianPath?.trim();
  if (!guardianPath) {
    throw new Error('[Sidecar] Windows process guardian is unavailable; no sidecar was started.');
  }

  return {
    executable: guardianPath,
    args: ['--owner-pid', String(input.ownerPid), '--', input.binaryPath, '--port', input.apiPort],
  };
}
