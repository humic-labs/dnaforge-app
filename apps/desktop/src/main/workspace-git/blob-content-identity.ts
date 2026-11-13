import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { createInflate } from 'node:zlib';

export interface GitBlobContentIdentity {
  sizeBytes: number;
  contentSha256: string;
}

export async function readLooseBlobContentIdentity(
  objectPath: string,
  blobOid: string,
  maxBytes: number
): Promise<GitBlobContentIdentity> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('MANAGED_GIT_INVALID_BLOB_LIMIT');
  }
  const stat = await lstat(objectPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MANAGED_GIT_INVALID_BLOB_FILE');
  const contentHash = createHash('sha256');
  const gitHash = createHash('sha1');
  let header = Buffer.alloc(0);
  let declaredSize: number | null = null;
  let sizeBytes = 0;

  const consume = (bytes: Buffer): void => {
    gitHash.update(bytes);
    let content = bytes;
    if (declaredSize === null) {
      const end = bytes.indexOf(0);
      const headerBytes = end < 0 ? bytes : bytes.subarray(0, end);
      if (header.length + headerBytes.length > 64) {
        throw new Error('MANAGED_GIT_INVALID_BLOB_HEADER');
      }
      header = Buffer.concat([header, headerBytes]);
      if (end < 0) return;
      const match = /^blob (0|[1-9][0-9]*)$/.exec(header.toString('utf8'));
      declaredSize = match ? Number(match[1]) : null;
      if (declaredSize === null || !Number.isSafeInteger(declaredSize)) {
        throw new Error('MANAGED_GIT_INVALID_BLOB_HEADER');
      }
      if (declaredSize > maxBytes) throw new Error('MANAGED_GIT_BLOB_EXCEEDS_CAPTURE');
      content = bytes.subarray(end + 1);
    }
    sizeBytes += content.length;
    if (sizeBytes > declaredSize || sizeBytes > maxBytes) {
      throw new Error('MANAGED_GIT_BLOB_EXCEEDS_CAPTURE');
    }
    contentHash.update(content);
  };

  const handle = await open(objectPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('MANAGED_GIT_INVALID_BLOB_FILE');
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createInflate(),
      new Writable({
        write(chunk, _encoding, done) {
          try {
            consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            done();
          } catch (error) {
            done(error instanceof Error ? error : new Error(String(error)));
          }
        },
      })
    );
  } finally {
    await handle.close();
  }
  if (declaredSize === null || sizeBytes !== declaredSize || gitHash.digest('hex') !== blobOid) {
    throw new Error('MANAGED_GIT_BLOB_INTEGRITY_MISMATCH');
  }
  return { sizeBytes, contentSha256: contentHash.digest('hex') };
}
