import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256BoundedNodeV1 } from './bounded-binary-sha256';

describe('bounded binary sha256', () => {
  it('matches Node SHA-256 across multiple bounded chunks without changing input', async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 37);
    for (let index = 0; index < bytes.length; index += 4093) bytes[index] = index & 0xff;
    const expected = createHash('sha256').update(bytes).digest('hex');

    await expect(sha256BoundedNodeV1(bytes)).resolves.toBe(expected);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
  });

  it('stops a large validation hash after its owner cancels', async () => {
    const controller = new AbortController();
    const pending = sha256BoundedNodeV1(new Uint8Array(32 * 1024 * 1024), {
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
