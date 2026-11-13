import type { RadixDomain, RadixNodeWrite } from './radix-map';
import {
  emptyMerkleRadixMap,
  getRadixValue,
  listRadixEntries,
  setRadixValue,
  type MerkleRadixMap,
} from './radix-map';

export interface PersistentIndexUpdate<Key extends string, Value> {
  readonly index: PersistentIndex<Key, Value>;
  readonly writes: readonly RadixNodeWrite[];
}

export class PersistentIndex<Key extends string, Value> implements ReadonlyMap<Key, Value> {
  readonly #map: MerkleRadixMap<Value>;
  readonly #domain: RadixDomain<Value>;
  readonly [Symbol.toStringTag] = 'PersistentIndex';

  private constructor(map: MerkleRadixMap<Value>, domain: RadixDomain<Value>) {
    this.#map = map;
    this.#domain = domain;
    Object.freeze(this);
  }

  static empty<Key extends string, Value>(
    domainName: string,
    valueIdentity: (value: Value) => string
  ): PersistentIndex<Key, Value> {
    const domain: RadixDomain<Value> = Object.freeze({
      name: domainName,
      hashDomain: `dnaforge:workspace-revision-history:${domainName}:v1\0`,
      idPrefix: 'ghi',
      encodeValue: valueIdentity,
      decodeValue: () => ({ ok: false as const, error: { kind: 'invalid-node-value' as const } }),
    });
    return new PersistentIndex(emptyMerkleRadixMap(), domain);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: Key): Value | undefined {
    return getRadixValue(this.#map, key);
  }

  has(key: Key): boolean {
    return this.get(key) !== undefined;
  }

  entries(): MapIterator<[Key, Value]> {
    return this.snapshotEntries()[Symbol.iterator]();
  }

  keys(): MapIterator<Key> {
    return this.snapshotEntries()
      .map(([key]) => key)
      [Symbol.iterator]();
  }

  values(): MapIterator<Value> {
    return this.snapshotEntries()
      .map(([, value]) => value)
      [Symbol.iterator]();
  }

  forEach(
    callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this.snapshotEntries()) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  set(key: Key, value: Value): PersistentIndexUpdate<Key, Value> {
    const update = setRadixValue(this.#map, key, value, this.#domain);
    return Object.freeze({
      index: update.changed ? new PersistentIndex<Key, Value>(update.map, this.#domain) : this,
      writes: update.writes,
    });
  }

  private snapshotEntries(): Array<[Key, Value]> {
    return listRadixEntries(this.#map).map(([key, value]) => [key as Key, value]);
  }
}

export function persistentIndexFrom<Key extends string, Value>(input: {
  readonly domainName: string;
  readonly valueIdentity: (value: Value) => string;
  readonly entries: Iterable<readonly [Key, Value]>;
}): PersistentIndex<Key, Value> {
  let index = PersistentIndex.empty<Key, Value>(input.domainName, input.valueIdentity);
  for (const [key, value] of input.entries) index = index.set(key, value).index;
  return index;
}
