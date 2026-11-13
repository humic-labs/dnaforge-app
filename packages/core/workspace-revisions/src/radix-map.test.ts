import { describe, expect, it } from 'vitest';

import type { Result } from './identity';
import {
  decodeRadixNode,
  deleteRadixValue,
  emptyMerkleRadixMap,
  getRadixValue,
  inspectRadixWrites,
  listRadixEntries,
  setRadixValue,
  type RadixDecodeError,
  type RadixDomain,
} from './radix-map';

interface TestValue {
  readonly value: string;
}

const DOMAIN: RadixDomain<TestValue> = Object.freeze({
  name: 'test',
  hashDomain: 'dnaforge:test-radix:v1\0',
  idPrefix: 'trn',
  encodeValue: (value: TestValue) => ({ value: value.value }),
  decodeValue: (value: unknown): Result<TestValue, RadixDecodeError> => {
    const decodedValue =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Reflect.get(value, 'value')
        : undefined;
    if (typeof decodedValue !== 'string') {
      return { ok: false, error: { kind: 'invalid-node-value' } };
    }
    return { ok: true, value: Object.freeze({ value: decodedValue }) };
  },
});

function item(value: string): TestValue {
  return Object.freeze({ value });
}

describe('Merkle radix map', () => {
  it('looks up misses and hits through compressed UTF-8 paths', () => {
    let map = emptyMerkleRadixMap<TestValue>();
    map = setRadixValue(map, 'resource-a', item('A'), DOMAIN).map;
    map = setRadixValue(map, 'resource-b', item('B'), DOMAIN).map;
    map = setRadixValue(map, 'résource-c', item('C'), DOMAIN).map;

    expect(getRadixValue(map, 'resource-a')).toEqual(item('A'));
    expect(getRadixValue(map, 'resource-b')).toEqual(item('B'));
    expect(getRadixValue(map, 'résource-c')).toEqual(item('C'));
    expect(getRadixValue(map, 'resource-z')).toBeUndefined();
  });

  it('has a canonical root independent of insertion order', () => {
    const entries = [
      ['aa', item('one')],
      ['ab', item('two')],
      ['a', item('three')],
      ['z', item('four')],
    ] as const;
    let forward = emptyMerkleRadixMap<TestValue>();
    let reverse = emptyMerkleRadixMap<TestValue>();
    for (const [key, value] of entries) {
      forward = setRadixValue(forward, key, value, DOMAIN).map;
    }
    for (const [key, value] of [...entries].reverse()) {
      reverse = setRadixValue(reverse, key, value, DOMAIN).map;
    }

    expect(forward.rootId).toBe(reverse.rootId);
    expect(inspectRadixWrites(forward)).toEqual(inspectRadixWrites(reverse));
    expect(listRadixEntries(forward)).toEqual([
      ['a', item('three')],
      ['aa', item('one')],
      ['ab', item('two')],
      ['z', item('four')],
    ]);
  });

  it('path-copies only the changed key path and reuses unchanged values', () => {
    let map = emptyMerkleRadixMap<TestValue>();
    for (let index = 0; index < 1_000; index += 1) {
      map = setRadixValue(
        map,
        `resource-${index.toString().padStart(4, '0')}`,
        item(`${index}`),
        DOMAIN
      ).map;
    }

    const mutation = setRadixValue(map, 'resource-0500', item('changed'), DOMAIN);
    expect(mutation.changed).toBe(true);
    expect(mutation.writes.length).toBeLessThan(32);
    expect(mutation.map.size).toBe(1_000);
    expect(getRadixValue(mutation.map, 'resource-0499')).toEqual(item('499'));
    expect(getRadixValue(mutation.map, 'resource-0500')).toEqual(item('changed'));
  });

  it('treats an identical replacement as no change', () => {
    const first = setRadixValue(emptyMerkleRadixMap<TestValue>(), 'a', item('A'), DOMAIN).map;
    const repeated = setRadixValue(first, 'a', item('A'), DOMAIN);
    expect(repeated.changed).toBe(false);
    expect(repeated.map).toBe(first);
    expect(repeated.writes).toEqual([]);
  });

  it('deletes leaves and collapses unary branches back to the canonical root', () => {
    let map = emptyMerkleRadixMap<TestValue>();
    map = setRadixValue(map, 'abc', item('A'), DOMAIN).map;
    const singleRoot = map.rootId;
    map = setRadixValue(map, 'abd', item('B'), DOMAIN).map;
    map = deleteRadixValue(map, 'abd', DOMAIN).map;

    expect(map.rootId).toBe(singleRoot);
    expect(map.size).toBe(1);
    expect(listRadixEntries(map)).toEqual([['abc', item('A')]]);

    const empty = deleteRadixValue(map, 'abc', DOMAIN);
    expect(empty.map.rootId).toBeNull();
    expect(empty.map.size).toBe(0);
  });

  it('rejects noncanonical, mismatched, malformed, and oversized records', () => {
    const mutation = setRadixValue(emptyMerkleRadixMap<TestValue>(), 'abc', item('A'), DOMAIN);
    const write = mutation.writes.at(-1);
    expect(write).toBeDefined();
    if (!write) return;

    expect(decodeRadixNode(write.id, write.canonicalJson, DOMAIN)).toEqual({
      ok: true,
      value: write,
    });
    expect(decodeRadixNode(write.id, `${write.canonicalJson} `, DOMAIN)).toEqual({
      ok: false,
      error: { kind: 'invalid-canonical-json' },
    });
    expect(decodeRadixNode(`trn_${'0'.repeat(64)}`, write.canonicalJson, DOMAIN)).toEqual({
      ok: false,
      error: { kind: 'record-id-mismatch' },
    });
    expect(decodeRadixNode(write.id, `"${'x'.repeat(300_000)}"`, DOMAIN)).toEqual({
      ok: false,
      error: { kind: 'record-too-large' },
    });
  });
});
