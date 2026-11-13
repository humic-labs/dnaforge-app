import { describe, expect, it, vi } from 'vitest';
import { createWebGLInstanceId } from './use-pixi-map';

describe('createWebGLInstanceId', () => {
  it('preserves the complete UUID used to correlate a live registry mount', () => {
    const uuid =
      '12345678-1234-4234-8234-123456789abc' as `${string}-${string}-${string}-${string}-${string}`;
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(uuid);
    expect(createWebGLInstanceId()).toBe(uuid);
  });
});
