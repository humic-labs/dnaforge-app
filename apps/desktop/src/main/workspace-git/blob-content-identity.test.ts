import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLooseBlobContentIdentity } from './blob-content-identity';

describe('committed loose blob streaming', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dnaforge-blob-identity-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function object(bytes: Buffer, header = `blob ${bytes.length}`) {
    const wrapped = Buffer.concat([Buffer.from(`${header}\0`), bytes]);
    const oid = createHash('sha1').update(wrapped).digest('hex');
    const path = join(root, oid);
    await writeFile(path, deflateSync(wrapped));
    return { path, oid };
  }

  it.each([Buffer.alloc(0), Buffer.from([0, 255, 10, 128]), Buffer.alloc(256 * 1024, 65)])(
    'checks exact binary contents and Git identity across decompressor chunks',
    async (bytes) => {
      const { path, oid } = await object(bytes);
      await expect(readLooseBlobContentIdentity(path, oid, bytes.length)).resolves.toEqual({
        sizeBytes: bytes.length,
        contentSha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  );

  it.each(['tree 4', 'blob 04', 'blob -1', 'blob nope', 'blob 9007199254740992', 'x'.repeat(65)])(
    'rejects malformed or non-blob headers (%s)',
    async (header) => {
      const { path, oid } = await object(Buffer.from('data'), header);
      await expect(readLooseBlobContentIdentity(path, oid, 4)).rejects.toThrow(
        'MANAGED_GIT_INVALID_BLOB_HEADER'
      );
    }
  );

  it('rejects a declared length beyond the admitted capture before hashing its payload', async () => {
    const { path, oid } = await object(Buffer.from('data'), 'blob 5368709120');
    await expect(readLooseBlobContentIdentity(path, oid, 4)).rejects.toThrow(
      'MANAGED_GIT_BLOB_EXCEEDS_CAPTURE'
    );
  });

  it('rejects output beyond the declared length', async () => {
    const { path, oid } = await object(Buffer.from('data'), 'blob 3');
    await expect(readLooseBlobContentIdentity(path, oid, 4)).rejects.toThrow(
      'MANAGED_GIT_BLOB_EXCEEDS_CAPTURE'
    );
  });

  it('rejects truncated contents, wrong Git hashes and corrupt compressed objects', async () => {
    const truncated = await object(Buffer.from('data'), 'blob 5');
    await expect(readLooseBlobContentIdentity(truncated.path, truncated.oid, 5)).rejects.toThrow(
      'MANAGED_GIT_BLOB_INTEGRITY_MISMATCH'
    );
    const valid = await object(Buffer.from('data'));
    await expect(readLooseBlobContentIdentity(valid.path, '0'.repeat(40), 4)).rejects.toThrow(
      'MANAGED_GIT_BLOB_INTEGRITY_MISMATCH'
    );
    await writeFile(valid.path, Buffer.from('not zlib'));
    await expect(readLooseBlobContentIdentity(valid.path, valid.oid, 4)).rejects.toThrow();
  });

  it('rejects symlinks, directories and missing object files', async () => {
    const { path, oid } = await object(Buffer.from('data'));
    const link = join(root, 'linked-object');
    await symlink(path, link);
    await expect(readLooseBlobContentIdentity(link, oid, 4)).rejects.toThrow(
      'MANAGED_GIT_INVALID_BLOB_FILE'
    );
    await expect(readLooseBlobContentIdentity(root, oid, 4)).rejects.toThrow(
      'MANAGED_GIT_INVALID_BLOB_FILE'
    );
    await expect(readLooseBlobContentIdentity(join(root, 'missing'), oid, 4)).rejects.toMatchObject(
      {
        code: 'ENOENT',
      }
    );
  });
});
