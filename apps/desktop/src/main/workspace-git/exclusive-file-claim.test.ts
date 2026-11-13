import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimRegularFileNoClobber, publishFileContentNoClobber } from './exclusive-file-claim';

describe('claimRegularFileNoClobber', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dnaforge-exclusive-file-claim-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes the source by hard link without replacing an existing name', async () => {
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await writeFile(source, 'source bytes');

    const claimed = await claimRegularFileNoClobber(source, destination);

    expect(claimed.method).toBe('link');
    expect(await readFile(destination, 'utf8')).toBe('source bytes');
    const [sourceStat, destinationStat] = await Promise.all([lstat(source), lstat(destination)]);
    expect({ dev: destinationStat.dev, ino: destinationStat.ino }).toEqual({
      dev: sourceStat.dev,
      ino: sourceStat.ino,
    });

    await unlink(destination);
    await writeFile(destination, 'outside bytes');
    await expect(claimRegularFileNoClobber(source, destination)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(destination, 'utf8')).toBe('outside bytes');
  });

  it('uses an exclusive streamed copy when hard links cannot cross the filesystem boundary', async () => {
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await writeFile(source, 'source bytes');

    const claimed = await claimRegularFileNoClobber(source, destination, {
      link: async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      },
    });

    expect(claimed.method).toBe('copy');
    expect(await readFile(destination, 'utf8')).toBe('source bytes');
    const sourceStat = await lstat(source);
    expect(claimed.identity).not.toEqual({ dev: sourceStat.dev, ino: sourceStat.ino });
  });

  it('keeps a destination that wins before the copy fallback opens it', async () => {
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await writeFile(source, 'source bytes');

    await expect(
      claimRegularFileNoClobber(source, destination, {
        link: async () => {
          await writeFile(destination, 'outside bytes', { flag: 'wx' });
          throw Object.assign(new Error('hard links unavailable'), { code: 'EPERM' });
        },
      })
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(destination, 'utf8')).toBe('outside bytes');
  });

  it('closes and removes its partial destination when the streamed copy fails', async () => {
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await writeFile(source, 'source bytes');
    let destinationClosed = false;

    await expect(
      claimRegularFileNoClobber(source, destination, {
        link: async () => {
          throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        },
        open: async (path, flags) => {
          const handle = await open(path, flags);
          if (path !== destination) return handle;
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === 'write') {
                return async () => {
                  throw new Error('simulated copy failure');
                };
              }
              if (property === 'close') {
                return async () => {
                  destinationClosed = true;
                  await target.close();
                };
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      })
    ).rejects.toThrow('simulated copy failure');

    expect(destinationClosed).toBe(true);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toBe('source bytes');
  });

  it('rejects and removes the destination when final close reports a write failure', async () => {
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await writeFile(source, 'source bytes');
    let destinationCloseAttempts = 0;

    await expect(
      claimRegularFileNoClobber(source, destination, {
        link: async () => {
          throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        },
        open: async (path, flags) => {
          const handle = await open(path, flags);
          if (path !== destination) return handle;
          return new Proxy(handle, {
            get(target, property, receiver) {
              if (property === 'close') {
                return async () => {
                  destinationCloseAttempts += 1;
                  if (destinationCloseAttempts === 1) {
                    await target.close();
                    throw new Error('simulated final close failure');
                  }
                };
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      })
    ).rejects.toThrow('simulated final close failure');

    expect(destinationCloseAttempts).toBeGreaterThanOrEqual(1);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toBe('source bytes');
  });

  it('rejects a non-regular source before creating a destination', async () => {
    const source = join(root, 'directory-source');
    const destination = join(root, 'destination');
    await mkdir(source);

    await expect(claimRegularFileNoClobber(source, destination)).rejects.toThrow(
      /SOURCE_NOT_REGULAR/u
    );
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('publishFileContentNoClobber', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dnaforge-publish-file-content-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('never exposes the final name before its complete contents exist', async () => {
    const destination = join(root, 'plasmid.json');
    const content = JSON.stringify({ id: 'x', padding: 'y'.repeat(256 * 1024) });
    const observed: { destinationExisted: boolean; stagedBytes: string }[] = [];

    await publishFileContentNoClobber(destination, content, {
      link: async (existingPath, newPath) => {
        observed.push({
          destinationExisted: await lstat(destination).then(
            () => true,
            () => false
          ),
          stagedBytes: await readFile(existingPath, 'utf8'),
        });
        await link(existingPath, newPath);
      },
    });

    expect(observed).toEqual([{ destinationExisted: false, stagedBytes: content }]);
    expect(await readFile(destination, 'utf8')).toBe(content);
    expect(await readdir(root)).toEqual(['plasmid.json']);
  });

  it('refuses an existing name and leaves no staging behind', async () => {
    const destination = join(root, 'plasmid.json');
    await writeFile(destination, 'outside bytes');

    await expect(publishFileContentNoClobber(destination, 'new bytes')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(destination, 'utf8')).toBe('outside bytes');
    expect(await readdir(root)).toEqual(['plasmid.json']);
  });
});
