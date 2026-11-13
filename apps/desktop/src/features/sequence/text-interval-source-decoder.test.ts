// @vitest-environment node

import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import { decodeTextIntervalSource } from './text-interval-source-decoder';

describe('decodeTextIntervalSource', () => {
  it('decodes UTF-8 and fingerprints the original source representation', async () => {
    const plain = strToU8('chr1\t10\t20\tfeature-a\n');
    const compressed = gzipSync(plain);

    const decoded = await decodeTextIntervalSource(compressed, 1_024);

    expect(decoded.text).toBe('chr1\t10\t20\tfeature-a\n');
    expect(decoded.sourceByteLength).toBe(compressed.byteLength);
    expect(decoded.decodedByteLength).toBe(plain.byteLength);
    expect(decoded.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(decodeTextIntervalSource(plain, 1_024)).resolves.not.toMatchObject({
      contentSha256: decoded.contentSha256,
    });
  });

  it('rejects compressed sources whose decoded representation exceeds the bound', async () => {
    const compressed = gzipSync(strToU8('chr1\t10\t20\n'.repeat(100)));

    await expect(decodeTextIntervalSource(compressed, 64)).rejects.toThrow(
      'decoded text exceeds 64 bytes'
    );
  });

  it('rejects invalid UTF-8 instead of replacing corrupt bytes', async () => {
    await expect(decodeTextIntervalSource(new Uint8Array([0xff, 0xfe]), 64)).rejects.toThrow(
      'valid UTF-8'
    );
  });
});
