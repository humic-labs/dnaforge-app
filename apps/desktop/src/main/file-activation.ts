import path from 'node:path';
import { realpathSync } from 'node:fs';

import { associationFamilyForPath } from '../shared/file-associations';
import type { FileActivationDelivery } from '../shared/file-association-ipc';

type Realpath = (candidate: string) => string;

function pathImplementation(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isProtocolArgument(argument: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(argument);
}

export function extractAssociationPathsFromArgv(
  argv: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const paths = pathImplementation(platform);
  const candidates: string[] = [];
  for (const argument of argv) {
    if (argument.length === 0 || argument.startsWith('-') || isProtocolArgument(argument)) {
      continue;
    }
    if (!associationFamilyForPath(argument)) continue;
    candidates.push(paths.resolve(cwd, argument));
  }
  return candidates;
}

export const MCP_LAUNCH_ARG = '--launched-by=mcp';

export function shouldShowSecondInstanceError(
  isPackaged: boolean,
  associationPaths: readonly string[],
  protocolUrl: string | null,
  argv: readonly string[]
): boolean {
  return (
    isPackaged &&
    associationPaths.length === 0 &&
    protocolUrl === null &&
    !argv.includes(MCP_LAUNCH_ARG)
  );
}

export function canonicalAssociationPath(
  input: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  realpath: Realpath = realpathSync.native
): string | null {
  const paths = pathImplementation(platform);
  const absolute = paths.resolve(cwd, input);
  if (!associationFamilyForPath(absolute)) return null;
  try {
    return realpath(absolute);
  } catch {
    return null;
  }
}

export interface FileActivationQueueOptions {
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly realpath?: Realpath;
}

export class FileActivationQueue {
  private readonly platform: NodeJS.Platform;
  private readonly cwd: string;
  private readonly realpath: Realpath;
  private readonly pendingKeys = new Set<string>();
  private readonly pending: FileActivationDelivery[] = [];
  private rendererReady = false;
  private nextDeliveryNumber = 1;

  constructor(options: FileActivationQueueOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.cwd = options.cwd ?? process.cwd();
    this.realpath = options.realpath ?? realpathSync.native;
  }

  enqueue(paths: readonly string[]): FileActivationDelivery[] {
    const accepted: FileActivationDelivery[] = [];
    const batchKeys = new Set<string>();
    for (const input of paths) {
      const canonical = canonicalAssociationPath(input, this.cwd, this.platform, this.realpath);
      if (!canonical) continue;
      const family = associationFamilyForPath(canonical);
      if (!family) continue;
      const dedupeKey =
        this.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
      if (batchKeys.has(dedupeKey) || (!this.rendererReady && this.pendingKeys.has(dedupeKey))) {
        continue;
      }
      batchKeys.add(dedupeKey);
      if (!this.rendererReady) this.pendingKeys.add(dedupeKey);
      accepted.push({
        deliveryId: `file-activation-${this.nextDeliveryNumber}`,
        path: canonical,
        familyId: family.id,
      });
      this.nextDeliveryNumber += 1;
    }
    if (this.rendererReady) return accepted;
    this.pending.push(...accepted);
    return [];
  }

  takePendingAndMarkReady(): FileActivationDelivery[] {
    this.rendererReady = true;
    this.pendingKeys.clear();
    return this.pending.splice(0, this.pending.length);
  }
}
