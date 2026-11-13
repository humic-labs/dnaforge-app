import {
  radixValueBrand,
  type MerkleRadixMap,
  type RadixNode,
  type RadixStore,
} from './radix-types';

const stores = new WeakMap<Readonly<object>, RadixStore<unknown>>();

export function makeRadixMap<Value>(
  root: RadixNode<Value> | null,
  size: number
): MerkleRadixMap<Value> {
  const map = Object.freeze({
    rootId: root?.id ?? null,
    size,
    [radixValueBrand]: (_value: Value): void => undefined,
  });
  stores.set(map, { root } as RadixStore<unknown>);
  return map;
}

export function requireRadixStore<Value>(map: MerkleRadixMap<Value>): RadixStore<Value> {
  const store = stores.get(map) as RadixStore<Value> | undefined;
  if (!store) throw new TypeError('MerkleRadixMap was not created by this package.');
  return store;
}
