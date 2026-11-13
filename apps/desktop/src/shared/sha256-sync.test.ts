// @vitest-environment node

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from './sha256-sync';

describe('sha256Hex', () => {
  it('matches node crypto for successive UTF-8 and byte parts', () => {
    const parts = ['dnaforge-reference-assembly-identity.v2\0', 'é∑', new Uint8Array([0, 255, 7])];
    const expected = createHash('sha256');
    for (const part of parts) expected.update(part);
    expect(sha256Hex(...parts)).toBe(expected.digest('hex'));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
