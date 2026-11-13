import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { vi } from 'vitest';

export async function withUnavailableWindowsDirectoryHandles(
  work: (counts: { directoryOpens: number; fileSyncs: number }) => Promise<void>
): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform || !vi.isMockFunction(fs.open))
    throw new Error('Directory-policy tests require configurable fs.open and process.platform.');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const counts = { directoryOpens: 0, fileSyncs: 0 };
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const stat = await actual.lstat(args[0]).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isDirectory()) {
      counts.directoryOpens++;
      throw Object.assign(new Error('Directory handles are unavailable in this policy test.'), {
        code: 'EPERM',
      });
    }
    const handle = await actual.open(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      counts.fileSyncs++;
      const flags = args[1];
      const writable =
        typeof flags === 'number'
          ? (flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0
          : typeof flags === 'string' && /[wa+]/u.test(flags);
      if (!writable)
        throw Object.assign(new Error('Windows flush requires a writable file handle.'), {
          code: 'EPERM',
        });
      await sync();
    };
    return handle;
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    await work(counts);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.mocked(fs.open).mockImplementation(actual.open);
  }
}
