import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { HARD_CAP_BYTES } from '../../shared/oversized-guard';

export class BoundedFileReadLimitError extends Error {
  readonly sizeBytes: number;
  readonly maxBytes: number;
  readonly path: string;

  constructor(sizeBytes: number, maxBytes: number, path: string) {
    super(`File exceeds bounded read limit (${sizeBytes} bytes > ${maxBytes} bytes): ${path}`);
    this.name = 'BoundedFileReadLimitError';
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
    this.path = path;
  }
}

export class BoundedFileChangedError extends Error {
  constructor(path: string) {
    super(`File changed during bounded read: ${path}`);
    this.name = 'BoundedFileChangedError';
  }
}

export async function readFileBoundedFromHandle(
  path: string,
  maxBytes: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > HARD_CAP_BYTES) {
    throw new Error(`maxBytes must be between 1 and ${HARD_CAP_BYTES}.`);
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error('Bounded reads require a regular file.');
    if (openedStat.size > maxBytes) {
      throw new BoundedFileReadLimitError(openedStat.size, maxBytes, path);
    }

    const capacity = openedStat.size + 1;
    const bytes = new Uint8Array(capacity);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const result = await handle.read(bytes, bytesRead, bytes.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const finishedStat = await handle.stat();
    if (bytesRead > maxBytes || finishedStat.size > maxBytes) {
      throw new BoundedFileReadLimitError(Math.max(bytesRead, finishedStat.size), maxBytes, path);
    }
    if (
      finishedStat.dev !== openedStat.dev ||
      finishedStat.ino !== openedStat.ino ||
      finishedStat.size !== openedStat.size ||
      finishedStat.mtimeMs !== openedStat.mtimeMs ||
      finishedStat.ctimeMs !== openedStat.ctimeMs ||
      bytesRead !== openedStat.size
    ) {
      throw new BoundedFileChangedError(path);
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
