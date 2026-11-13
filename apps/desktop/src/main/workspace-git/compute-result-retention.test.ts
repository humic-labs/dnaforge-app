import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertComputeSourceUnchanged,
  inventoryComputeSource,
  retainComputeSource,
} from './compute-result-retention';

let scratch: string;
let source: string;
let retained: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'compute-retention-')));
  source = join(scratch, 'source');
  retained = join(scratch, 'retained');
  mkdirSync(source);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('complete legacy compute source retention', () => {
  it('accounts for nested, large, binary, hidden, empty and read-only members without decoding bytes', async () => {
    mkdirSync(join(source, 'nested'));
    mkdirSync(join(source, 'empty'));
    const contents = {
      'large.txt': Buffer.alloc(1024 * 1024 + 1, 120),
      'nested/invalid-utf8.dat': Buffer.from([255, 128, 4]),
      'nested/binary.dat': Buffer.from([4, 0, 5]),
      '.receipt': Buffer.from('{"retain":"exact source"}'),
      'zero.dat': Buffer.alloc(0),
      'read-only.txt': Buffer.from('preserved'),
    };
    for (const [path, bytes] of Object.entries(contents)) writeFileSync(join(source, path), bytes);
    chmodSync(join(source, 'read-only.txt'), 0o444);
    const expected = await inventoryComputeSource(source);
    expect(expected.entries.map((entry) => entry.relativePath).sort()).toEqual(
      [...Object.keys(contents), 'nested', 'empty'].sort()
    );
    await retainComputeSource({ sourceRoot: source, retainedRoot: retained, expected });
    await expect(assertComputeSourceUnchanged(source, expected)).resolves.toBeUndefined();
    expect((await inventoryComputeSource(retained)).treeSha256).toBe(expected.treeSha256);
    expect(statSync(join(retained, 'empty')).isDirectory()).toBe(true);
    expect(statSync(join(retained, 'read-only.txt')).mode & 0o777).toBe(0o444);
    for (const [path, bytes] of Object.entries(contents)) {
      expect(sha256(readFileSync(join(retained, path)))).toBe(sha256(bytes));
      expect(statSync(join(retained, path)).ino).not.toBe(statSync(join(source, path)).ino);
    }
    writeFileSync(join(source, 'nested', 'binary.dat'), Buffer.from([8, 0, 9]));
    expect(readFileSync(join(retained, 'nested', 'binary.dat'))).toEqual(
      contents['nested/binary.dat']
    );
  });

  it('refuses a stale source inventory before creating a retained tree', async () => {
    writeFileSync(join(source, 'model.bin'), 'original');
    const expected = await inventoryComputeSource(source);
    writeFileSync(join(source, 'model.bin'), 'replaced');
    await expect(
      retainComputeSource({ sourceRoot: source, retainedRoot: retained, expected })
    ).rejects.toThrow('COMPUTE_SOURCE_CHANGED');
    expect(existsSync(retained)).toBe(false);
    expect(readFileSync(join(source, 'model.bin'), 'utf8')).toBe('replaced');
  });

  it('does not overwrite an existing retention destination', async () => {
    writeFileSync(join(source, 'model.bin'), 'original');
    const expected = await inventoryComputeSource(source);
    mkdirSync(retained);
    writeFileSync(join(retained, 'user.bin'), 'user-owned');
    await expect(
      retainComputeSource({ sourceRoot: source, retainedRoot: retained, expected })
    ).rejects.toThrow();
    expect(readFileSync(join(retained, 'user.bin'), 'utf8')).toBe('user-owned');
    expect(existsSync(join(retained, 'model.bin'))).toBe(false);
  });

  it('rejects symlinks before any retained output exists', async () => {
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'data.bin'), 'external');
    symlinkSync(outside, join(source, 'linked'));
    await expect(inventoryComputeSource(source)).rejects.toThrow(
      'COMPUTE_SOURCE_SYMLINK_UNSUPPORTED'
    );
    expect(existsSync(retained)).toBe(false);
    expect(readFileSync(join(outside, 'data.bin'), 'utf8')).toBe('external');
  });

  it('rejects a multiply-linked input instead of changing its physical identity', async () => {
    writeFileSync(join(source, 'data.bin'), 'shared');
    linkSync(join(source, 'data.bin'), join(scratch, 'other-owner.bin'));
    await expect(inventoryComputeSource(source)).rejects.toThrow(
      'COMPUTE_SOURCE_HARD_LINK_UNSUPPORTED'
    );
    expect(existsSync(retained)).toBe(false);
    expect(readFileSync(join(scratch, 'other-owner.bin'), 'utf8')).toBe('shared');
  });
});
