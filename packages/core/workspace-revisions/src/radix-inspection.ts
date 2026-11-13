import { bytesToUtf8, concatBytes, hexToBytes } from '@noble/hashes/utils';

import { parseRadixKey, sharedPrefixLength } from './radix-key';
import { requireRadixStore } from './radix-store';
import type {
  MerkleRadixMap,
  RadixAccessCounter,
  RadixChild,
  RadixNode,
  RadixNodeId,
  RadixNodeWrite,
} from './radix-types';

export function listRadixEntries<Value>(
  map: MerkleRadixMap<Value>
): readonly (readonly [string, Value])[] {
  if (map.rootId === null) return Object.freeze([]);
  const store = requireRadixStore(map);
  const entries: Array<readonly [string, Value]> = [];
  if (!store.root) throw new Error('Nonempty Merkle radix map has no root node.');
  walkNode(store.root, new Uint8Array(), entries);
  return Object.freeze(entries);
}

export function firstRadixEntryWithPrefix<Value>(
  map: MerkleRadixMap<Value>,
  prefix: string,
  access?: RadixAccessCounter
): readonly [string, Value] | undefined {
  const prefixBytes = parseRadixKey(prefix);
  const root = requireRadixStore(map).root;
  return root ? findFirstWithPrefix(root, new Uint8Array(), prefixBytes, access) : undefined;
}

export function diffRadixWrites<Value>(
  before: MerkleRadixMap<Value>,
  after: MerkleRadixMap<Value>
): readonly RadixNodeWrite[] {
  const beforeNodes = new Map<RadixNodeId, RadixNode<Value>>();
  const beforeRoot = requireRadixStore(before).root;
  if (beforeRoot) collectReachableNodes(beforeRoot, beforeNodes);
  return Object.freeze(inspectRadixWrites(after).filter((write) => !beforeNodes.has(write.id)));
}

export function inspectRadixWrites<Value>(map: MerkleRadixMap<Value>): readonly RadixNodeWrite[] {
  const store = requireRadixStore(map);
  const reachable = new Map<RadixNodeId, RadixNode<Value>>();
  if (store.root) collectReachableNodes(store.root, reachable);
  return Object.freeze(
    [...reachable.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map((node) => Object.freeze({ id: node.id, canonicalJson: node.canonicalJson }))
  );
}

function walkNode<Value>(
  node: RadixNode<Value>,
  preceding: Uint8Array,
  output: Array<readonly [string, Value]>
): void {
  const key = concatBytes(preceding, hexToBytes(node.prefixHex));
  if (node.value !== null) output.push(Object.freeze([bytesToUtf8(key), node.value]));
  for (const entry of node.children) {
    walkNode(entry.node, concatBytes(key, Uint8Array.of(entry.edgeByte)), output);
  }
}

function collectReachableNodes<Value>(
  node: RadixNode<Value>,
  output: Map<RadixNodeId, RadixNode<Value>>
): void {
  if (output.has(node.id)) return;
  output.set(node.id, node);
  for (const entry of node.children) collectReachableNodes(entry.node, output);
}

function findFirstWithPrefix<Value>(
  node: RadixNode<Value>,
  preceding: Uint8Array,
  prefix: Uint8Array,
  access?: RadixAccessCounter
): readonly [string, Value] | undefined {
  if (access) access.nodeReads += 1;
  const nodeKey = concatBytes(preceding, hexToBytes(node.prefixHex));
  const shared = sharedPrefixLength(nodeKey, prefix);
  if (shared < Math.min(nodeKey.length, prefix.length)) return undefined;
  if (prefix.length <= nodeKey.length) return firstEntry(node, preceding);
  const edgeByte = prefix[nodeKey.length];
  const next = findChild(node.children, edgeByte);
  return next
    ? findFirstWithPrefix(
        next.node,
        concatBytes(nodeKey, Uint8Array.of(next.edgeByte)),
        prefix,
        access
      )
    : undefined;
}

function firstEntry<Value>(
  node: RadixNode<Value>,
  preceding: Uint8Array
): readonly [string, Value] | undefined {
  const key = concatBytes(preceding, hexToBytes(node.prefixHex));
  if (node.value !== null) return Object.freeze([bytesToUtf8(key), node.value]);
  const next = node.children[0];
  return next ? firstEntry(next.node, concatBytes(key, Uint8Array.of(next.edgeByte))) : undefined;
}

function findChild<Value>(
  children: readonly RadixChild<Value>[],
  edgeByte: number | undefined
): RadixChild<Value> | undefined {
  return edgeByte === undefined
    ? undefined
    : children.find((candidate) => candidate.edgeByte === edgeByte);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
