// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  SOFT_WARN_BYTES,
  HARD_CAP_BYTES,
  OversizedFileError,
  isOversizedFileError,
  extBucket,
  sizeBucket,
  formatFileSize,
} from './oversized-guard';

describe('SOFT_WARN_BYTES / HARD_CAP_BYTES', () => {
  it('SOFT_WARN_BYTES is 100 MB', () => {
    expect(SOFT_WARN_BYTES).toBe(100 * 1024 * 1024);
  });

  it('HARD_CAP_BYTES is 256 MB', () => {
    expect(HARD_CAP_BYTES).toBe(256 * 1024 * 1024);
  });

  it('HARD_CAP > SOFT_WARN (no overlap in tiers)', () => {
    expect(HARD_CAP_BYTES).toBeGreaterThan(SOFT_WARN_BYTES);
  });
});

describe('OversizedFileError', () => {
  it('preserves sizeBytes / path / hardCap fields', () => {
    const err = new OversizedFileError(300 * 1024 * 1024, '/tmp/big.gb', true);
    expect(err.name).toBe('OversizedFileError');
    expect(err.sizeBytes).toBe(300 * 1024 * 1024);
    expect(err.path).toBe('/tmp/big.gb');
    expect(err.hardCap).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });

  it('message contains "File too large" prefix used for IPC recovery', () => {
    const err = new OversizedFileError(123, '/x', false);
    expect(err.message.startsWith('File too large')).toBe(true);
  });
});

describe('isOversizedFileError', () => {
  it('accepts the real subclass', () => {
    expect(isOversizedFileError(new OversizedFileError(1, '/p', true))).toBe(true);
  });

  it('accepts an IPC-stripped object with name=OversizedFileError', () => {
    const stripped = {
      name: 'OversizedFileError',
      message: 'File too large (256 bytes, above hard cap): /p',
      sizeBytes: 256,
      path: '/p',
      hardCap: true,
    };
    expect(isOversizedFileError(stripped)).toBe(true);
  });

  it('accepts an Error whose message starts with the well-known prefix', () => {
    const err = new Error('File too large (300 bytes, above hard cap): /tmp/x');
    expect(isOversizedFileError(err)).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isOversizedFileError(new Error('ENOENT'))).toBe(false);
    expect(isOversizedFileError({ name: 'TypeError', message: 'oops' })).toBe(false);
    expect(isOversizedFileError(null)).toBe(false);
    expect(isOversizedFileError(undefined)).toBe(false);
    expect(isOversizedFileError('string')).toBe(false);
  });
});

describe('extBucket', () => {
  it.each([
    ['/tmp/x.gb', 'gb'],
    ['/tmp/x.GB', 'gb'],
    ['/tmp/x.GbK', 'gbk'],
    ['/tmp/x.fasta', 'fasta'],
    ['/tmp/x.fa', 'fa'],
    ['/tmp/x.fastq', 'fastq'],
    ['/tmp/x.ab1', 'ab1'],
  ])('whitelisted: %s → %s', (path, expected) => {
    expect(extBucket(path)).toBe(expected);
  });

  it.each([
    ['/tmp/x.txt', 'other'],
    ['/tmp/x.exe', 'other'],
    ['/tmp/x.fq', 'other'],
    ['/tmp/.hidden', 'other'],
    ['/tmp/no-ext', 'other'],
    ['/tmp/.', 'other'],
  ])('non-whitelisted: %s → %s', (path, expected) => {
    expect(extBucket(path)).toBe(expected);
  });
});

describe('sizeBucket', () => {
  it('< SOFT_WARN → <100MB', () => {
    expect(sizeBucket(0)).toBe('<100MB');
    expect(sizeBucket(1)).toBe('<100MB');
    expect(sizeBucket(SOFT_WARN_BYTES - 1)).toBe('<100MB');
  });

  it('exactly SOFT_WARN → 100-256MB', () => {
    expect(sizeBucket(SOFT_WARN_BYTES)).toBe('100-256MB');
  });

  it('exactly HARD_CAP → 100-256MB', () => {
    expect(sizeBucket(HARD_CAP_BYTES)).toBe('100-256MB');
  });

  it('HARD_CAP + 1 → >256MB', () => {
    expect(sizeBucket(HARD_CAP_BYTES + 1)).toBe('>256MB');
  });

  it('huge values → >256MB', () => {
    expect(sizeBucket(10 * 1024 * 1024 * 1024)).toBe('>256MB');
  });
});

describe('formatFileSize', () => {
  it('bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('KB', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('MB', () => {
    expect(formatFileSize(SOFT_WARN_BYTES)).toBe('100.0 MB');
  });

  it('GB', () => {
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });

  it('handles invalid input', () => {
    expect(formatFileSize(NaN)).toBe('NaN B');
    expect(formatFileSize(-1)).toBe('-1 B');
  });
});
