import { describe, expect, it } from 'vitest';
import {
  canonicalNativeMutationRequest,
  nativeMutationRequestBytes,
} from './native-mutation-request';

describe('native mutation request identity', () => {
  it('sorts nested keys with fixed code-unit order, preserves array order and JSON omissions', () => {
    expect(
      canonicalNativeMutationRequest({ z: { ä: 1, a: 2, Z: 3 }, a: [2, 1], skip: undefined })
    ).toBe('{"a":[2,1],"z":{"Z":3,"a":2,"ä":1}}');
    expect(canonicalNativeMutationRequest({ a: [1, 2] })).not.toBe(
      canonicalNativeMutationRequest({ a: [2, 1] })
    );
  });
  it('keeps the exact legacy bytes and rejects unknown hash versions', () => {
    const value = { z: 1, a: 2 };
    expect(nativeMutationRequestBytes(value, undefined)).toBe(JSON.stringify(value));
    expect(nativeMutationRequestBytes(value, 'canonical-json-v1')).toBe('{"a":2,"z":1}');
    expect(() => nativeMutationRequestBytes(value, 'future')).toThrow(/version/);
    expect(() => nativeMutationRequestBytes(value, null)).toThrow(/version/);
  });
  it('canonicalizes the actual JSON representation of field values', () => {
    const date = new Date('2026-08-31T00:00:00Z');
    expect(
      canonicalNativeMutationRequest({ date, empty: Array(1), values: [undefined, null] })
    ).toBe('{"date":"2026-08-31T00:00:00.000Z","empty":[null],"values":[null,null]}');
  });
});
