import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { snapshotPdfBytes } from './snapshot';

afterEach(() => vi.unstubAllGlobals());
describe('exact PDF input snapshot', () => {
  it('hashes the exact subview and owns its bytes before the caller mutates or transfers input', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const view = input.subarray(1, 4);
    const expected = createHash('sha256')
      .update(new Uint8Array([2, 3, 4]))
      .digest('hex');
    const pending = snapshotPdfBytes(view);
    input.fill(9);
    const snapshot = await pending;
    expect(Array.from(snapshot.bytes)).toEqual([2, 3, 4]);
    expect(snapshot.sha256).toBe(expected);
    structuredClone(snapshot.bytes, { transfer: [snapshot.bytes.buffer] });
    expect(snapshot.sha256).toBe(expected);
    expect(snapshot.bytes.byteLength).toBe(0);
  });
});
