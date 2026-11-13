import { constants } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, default: { ...actual, open: openMock }, open: openMock };
});

import { BoundedFileReadLimitError, readFileBoundedFromHandle } from './bounded-file-read';

function statSnapshot(size: number, times: { mtimeMs: number; ctimeMs: number }) {
  return {
    isFile: (): boolean => true,
    size,
    dev: 1,
    ino: 2,
    mtimeMs: times.mtimeMs,
    ctimeMs: times.ctimeMs,
  };
}

function handleFor(
  bytes: Uint8Array,
  opened = statSnapshot(bytes.byteLength, { mtimeMs: 10, ctimeMs: 10 }),
  finished = opened
) {
  let offset = 0;
  return {
    stat: vi.fn().mockResolvedValueOnce(opened).mockResolvedValueOnce(finished),
    read: vi.fn(async (buffer: Uint8Array, bufferOffset: number, length: number) => {
      const bytesRead = Math.min(length, bytes.byteLength - offset);
      buffer.set(bytes.subarray(offset, offset + bytesRead), bufferOffset);
      offset += bytesRead;
      return { bytesRead, buffer };
    }),
    close: vi.fn(async () => undefined),
  };
}

describe('readFileBoundedFromHandle', () => {
  beforeEach(() => {
    openMock.mockReset();
  });

  it('opens the source read-only without following a final symlink and closes the same handle', async () => {
    const handle = handleFor(Uint8Array.from([1, 2, 3]));
    openMock.mockResolvedValue(handle);

    await expect(readFileBoundedFromHandle('/external/source.gb', 3)).resolves.toEqual(
      Uint8Array.from([1, 2, 3])
    );

    expect(openMock).toHaveBeenCalledWith(
      '/external/source.gb',
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    expect(handle.stat).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('rejects a source whose metadata changes while the same handle is being read', async () => {
    const opened = statSnapshot(3, { mtimeMs: 10, ctimeMs: 10 });
    const finished = statSnapshot(3, { mtimeMs: 11, ctimeMs: 10 });
    const handle = handleFor(Uint8Array.from([1, 2, 3]), opened, finished);
    openMock.mockResolvedValue(handle);

    await expect(readFileBoundedFromHandle('/external/source.gb', 3)).rejects.toThrow(
      'File changed during bounded read'
    );
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('rejects a source that grows beyond the limit during the read', async () => {
    const opened = statSnapshot(3, { mtimeMs: 10, ctimeMs: 10 });
    const finished = statSnapshot(4, { mtimeMs: 11, ctimeMs: 11 });
    const handle = handleFor(Uint8Array.from([1, 2, 3, 4]), opened, finished);
    openMock.mockResolvedValue(handle);

    await expect(readFileBoundedFromHandle('/external/source.gb', 3)).rejects.toMatchObject({
      name: BoundedFileReadLimitError.name,
      sizeBytes: 4,
      maxBytes: 3,
    });
    expect(handle.close).toHaveBeenCalledOnce();
  });
});
