import { chmodSync, closeSync, fsyncSync, openSync, statSync } from 'node:fs';
import { chmod, open, stat } from 'node:fs/promises';

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function flushFileSync(path: string, platform: NodeJS.Platform = process.platform): void {
  const readOnlyMode = platform === 'win32' ? readOnlyPermissions(statSync(path).mode) : null;
  if (readOnlyMode !== null) chmodSync(path, readOnlyMode | 0o200);
  try {
    const fd = openSync(path, platform === 'win32' ? 'r+' : 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    if (readOnlyMode !== null) chmodSync(path, readOnlyMode);
  }
}

export async function flushFile(
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const readOnlyMode = platform === 'win32' ? readOnlyPermissions((await stat(path)).mode) : null;
  if (readOnlyMode !== null) await chmod(path, readOnlyMode | 0o200);
  try {
    const handle = await open(path, platform === 'win32' ? 'r+' : 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    if (readOnlyMode !== null) await chmod(path, readOnlyMode);
  }
}

function readOnlyPermissions(mode: number): number | null {
  const permissions = mode & 0o777;
  return permissions & 0o200 ? null : permissions;
}
