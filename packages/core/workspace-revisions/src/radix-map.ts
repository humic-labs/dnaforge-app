import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { canonicalize, parseStrictCanonicalJson } from './canonical-json';
import type { CanonicalJson, Result } from './identity';
import { brandValidated } from './identity';
import { MAX_WORKSPACE_INDEX_NODE_BYTES } from './record-budgets';
import { listRadixEntries } from './radix-inspection';
import { matchesBytesAt, parseRadixKey, sharedPrefixLength } from './radix-key';
import { makeRadixMap, requireRadixStore } from './radix-store';
import type {
  DecodedNodeBody,
  MerkleRadixMap,
  RadixAccessCounter,
  RadixChild,
  RadixDecodeError,
  RadixDomain,
  RadixMutation,
  RadixNode,
  RadixNodeId,
  RadixNodeWrite,
  RadixStore,
} from './radix-types';

export {
  diffRadixWrites,
  firstRadixEntryWithPrefix,
  inspectRadixWrites,
  listRadixEntries,
} from './radix-inspection';
export type {
  MerkleRadixMap,
  RadixAccessCounter,
  RadixDecodeError,
  RadixDomain,
  RadixMutation,
  RadixNodeId,
  RadixNodeWrite,
} from './radix-types';

interface MutableOperation<Value> {
  readonly domain: RadixDomain<Value>;
  readonly source: RadixStore<Value>;
  readonly access: RadixAccessCounter;
  readonly created: Map<RadixNodeId, RadixNode<Value>>;
  readonly writes: RadixNodeWrite[];
}

export function emptyMerkleRadixMap<Value>(): MerkleRadixMap<Value> {
  return makeRadixMap<Value>(null, 0);
}

export function getRadixValue<Value>(
  map: MerkleRadixMap<Value>,
  key: string,
  access?: RadixAccessCounter
): Value | undefined {
  const keyBytes = parseRadixKey(key);
  const store = requireRadixStore(map);
  let node = store.root ?? undefined;
  let offset = 0;
  while (node) {
    countNodeRead(access);
    const prefix = hexToBytes(node.prefixHex);
    if (!matchesBytesAt(keyBytes, offset, prefix)) return undefined;
    offset += prefix.length;
    if (offset === keyBytes.length) return node.value ?? undefined;
    const child = findChild(node.children, keyBytes[offset]);
    if (!child) return undefined;
    offset += 1;
    node = child.node;
  }
  return undefined;
}

export function setRadixValue<Value>(
  map: MerkleRadixMap<Value>,
  key: string,
  value: Value,
  domain: RadixDomain<Value>,
  access?: RadixAccessCounter
): RadixMutation<Value> {
  const source = requireRadixStore(map);
  const operation = createOperation(domain, source, access);
  const keyBytes = parseRadixKey(key);
  const root = source.root ?? undefined;
  const next = insertNode(operation, root, keyBytes, value);
  if (root?.id === next.id) {
    return Object.freeze({ map, writes: Object.freeze([]), changed: false });
  }
  const size = root && getRadixValue(map, key, access) !== undefined ? map.size : map.size + 1;
  return finishOperation(operation, next.id, size, true);
}

export function deleteRadixValue<Value>(
  map: MerkleRadixMap<Value>,
  key: string,
  domain: RadixDomain<Value>,
  access?: RadixAccessCounter
): RadixMutation<Value> {
  if (map.rootId === null || getRadixValue(map, key, access) === undefined) {
    return Object.freeze({ map, writes: Object.freeze([]), changed: false });
  }
  const source = requireRadixStore(map);
  const operation = createOperation(domain, source, access);
  const root = source.root;
  if (!root) throw new Error('Nonempty Merkle radix map has no root node.');
  const next = deleteNode(operation, root, parseRadixKey(key));
  return finishOperation(operation, next?.id ?? null, map.size - 1, true);
}

export function decodeRadixNode<Value>(
  id: string,
  canonicalJson: string,
  domain: RadixDomain<Value>
): Result<RadixNodeWrite, RadixDecodeError> {
  if (utf8ToBytes(canonicalJson).length > MAX_WORKSPACE_INDEX_NODE_BYTES) {
    return { ok: false, error: { kind: 'record-too-large' } };
  }
  const parsed = parseStrictCanonicalJson(canonicalJson);
  if (!parsed.ok) return { ok: false, error: { kind: 'invalid-canonical-json' } };
  const expected = hashNode(domain, parsed.value);
  if (expected !== id) return { ok: false, error: { kind: 'record-id-mismatch' } };
  const decoded: unknown = JSON.parse(canonicalJson);
  const body = decodeBody(decoded, domain);
  if (!body.ok) return body;
  return {
    ok: true,
    value: Object.freeze({ id: expected, canonicalJson: parsed.value }),
  };
}

export function importMerkleRadixMap<Value>(input: {
  readonly rootId: string | null;
  readonly size: number;
  readonly records: readonly RadixNodeWrite[];
  readonly domain: RadixDomain<Value>;
}): Result<MerkleRadixMap<Value>, RadixDecodeError> {
  return createMerkleRadixMapImporter(input)(input);
}

export function createMerkleRadixMapImporter<Value>(input: {
  readonly records: readonly RadixNodeWrite[];
  readonly domain: RadixDomain<Value>;
}): (root: {
  readonly rootId: string | null;
  readonly size: number;
}) => Result<MerkleRadixMap<Value>, RadixDecodeError> {
  const domain = input.domain;
  const records = input.records.map((record) =>
    Object.freeze({ id: record.id, canonicalJson: record.canonicalJson })
  );
  type Bodies = Map<
    RadixNodeId,
    { readonly write: RadixNodeWrite; readonly body: DecodedNodeBody<Value> }
  >;
  let bodies: Bodies | undefined;
  return (root) => {
    if (!Number.isSafeInteger(root.size) || root.size < 0) return invalidShape();
    if (root.rootId === null)
      return root.size === 0
        ? { ok: true, value: emptyMerkleRadixMap() }
        : { ok: false, error: { kind: 'entry-count-mismatch' } };
    if (!isDomainNodeId(root.rootId, domain)) return invalidShape();
    if (!bodies) {
      const decodedRecords: Bodies = new Map();
      for (const record of records) {
        const validated = decodeRadixNode(record.id, record.canonicalJson, domain);
        if (!validated.ok) return validated;
        const decoded: unknown = JSON.parse(record.canonicalJson);
        const body = decodeBody(decoded, domain);
        if (!body.ok) return body;
        decodedRecords.set(record.id, { write: validated.value, body: body.value });
      }

      bodies = decodedRecords;
    }
    return importDecodedRadixRoot({ rootId: root.rootId, size: root.size }, bodies);
  };
}

function importDecodedRadixRoot<Value>(
  input: { readonly rootId: string; readonly size: number },
  bodies: ReadonlyMap<
    RadixNodeId,
    { readonly write: RadixNodeWrite; readonly body: DecodedNodeBody<Value> }
  >
): Result<MerkleRadixMap<Value>, RadixDecodeError> {
  const built = new Map<RadixNodeId, RadixNode<Value>>();
  const active = new Set<RadixNodeId>();
  const build = (id: RadixNodeId, isRoot: boolean): Result<RadixNode<Value>, RadixDecodeError> => {
    const existing = built.get(id);
    if (existing) return { ok: true, value: existing };
    if (active.has(id)) return { ok: false, error: { kind: 'node-cycle' } };
    const decoded = bodies.get(id);
    if (!decoded) return { ok: false, error: { kind: 'missing-node' } };
    if (!isRoot && decoded.body.value === null && decoded.body.children.length < 2) {
      return { ok: false, error: { kind: 'noncanonical-node-structure' } };
    }
    active.add(id);
    const children: RadixChild<Value>[] = [];
    for (const entry of decoded.body.children) {
      const descendant = build(entry.nodeId, false);
      if (!descendant.ok) return descendant;
      children.push(child(entry.edgeByte, descendant.value));
    }
    active.delete(id);
    const node = Object.freeze({
      id,
      canonicalJson: decoded.write.canonicalJson,
      prefixHex: decoded.body.prefixHex,
      value: decoded.body.value,
      children: Object.freeze(children),
    });
    built.set(id, node);
    return { ok: true, value: node };
  };
  const parsedRoot = brandValidated<string, 'RadixNodeId'>(input.rootId) as RadixNodeId;
  const root = build(parsedRoot, true);
  if (!root.ok) return root;
  const map = makeRadixMap(root.value, input.size);
  if (listRadixEntries(map).length !== input.size) {
    return { ok: false, error: { kind: 'entry-count-mismatch' } };
  }
  return { ok: true, value: map };
}

function insertNode<Value>(
  operation: MutableOperation<Value>,
  existing: RadixNode<Value> | undefined,
  key: Uint8Array,
  value: Value
): RadixNode<Value> {
  if (!existing) return createNode(operation, key, value, []);
  countNodeRead(operation.access);
  const prefix = hexToBytes(existing.prefixHex);
  const shared = sharedPrefixLength(prefix, key);
  if (shared < prefix.length) {
    const existingEdge = prefix[shared];
    if (existingEdge === undefined) throw new Error('Radix split lost the existing edge.');
    const existingChild = createNode(
      operation,
      prefix.slice(shared + 1),
      existing.value,
      existing.children
    );
    const children: RadixChild<Value>[] = [child(existingEdge, existingChild)];
    let parentValue: Value | null = null;
    if (shared === key.length) {
      parentValue = value;
    } else {
      const newEdge = key[shared];
      if (newEdge === undefined) throw new Error('Radix split lost the inserted edge.');
      const newChild = createNode(operation, key.slice(shared + 1), value, []);
      children.push(child(newEdge, newChild));
    }
    return createNode(operation, prefix.slice(0, shared), parentValue, children);
  }
  if (shared === key.length) {
    const before = encodeValue(operation.domain, existing.value);
    const after = encodeValue(operation.domain, value);
    return before === after ? existing : createNode(operation, prefix, value, existing.children);
  }
  const edgeByte = key[shared];
  if (edgeByte === undefined) throw new Error('Radix insert lost its child edge.');
  const existingChild = findChild(existing.children, edgeByte);
  const childNode = existingChild?.node;
  const nextChild = insertNode(operation, childNode, key.slice(shared + 1), value);
  if (childNode?.id === nextChild.id) return existing;
  const children = existing.children.filter((candidate) => candidate.edgeByte !== edgeByte);
  children.push(child(edgeByte, nextChild));
  return createNode(operation, prefix, existing.value, children);
}

function deleteNode<Value>(
  operation: MutableOperation<Value>,
  existing: RadixNode<Value>,
  key: Uint8Array
): RadixNode<Value> | null {
  countNodeRead(operation.access);
  const prefix = hexToBytes(existing.prefixHex);
  if (!matchesBytesAt(key, 0, prefix)) return existing;
  if (prefix.length === key.length) {
    return normalizeNode(operation, prefix, null, existing.children);
  }
  const edgeByte = key[prefix.length];
  if (edgeByte === undefined) return existing;
  const existingChild = findChild(existing.children, edgeByte);
  if (!existingChild) return existing;
  const nextChild = deleteNode(operation, existingChild.node, key.slice(prefix.length + 1));
  const children = existing.children.filter((candidate) => candidate.edgeByte !== edgeByte);
  if (nextChild) children.push(child(edgeByte, nextChild));
  return normalizeNode(operation, prefix, existing.value, children);
}

function normalizeNode<Value>(
  operation: MutableOperation<Value>,
  prefix: Uint8Array,
  value: Value | null,
  children: readonly RadixChild<Value>[]
): RadixNode<Value> | null {
  if (value === null && children.length === 0) return null;
  if (value === null && children.length === 1) {
    const only = children[0];
    if (!only) throw new Error('Radix collapse lost its only child.');
    const descendant = only.node;
    return createNode(
      operation,
      concatBytes(prefix, Uint8Array.of(only.edgeByte), hexToBytes(descendant.prefixHex)),
      descendant.value,
      descendant.children
    );
  }
  return createNode(operation, prefix, value, children);
}

function createNode<Value>(
  operation: MutableOperation<Value>,
  prefix: Uint8Array,
  value: Value | null,
  childrenInput: readonly RadixChild<Value>[]
): RadixNode<Value> {
  const children = Object.freeze(
    [...childrenInput]
      .sort((left, right) => left.edgeByte - right.edgeByte)
      .map((entry) => Object.freeze({ ...entry }))
  );
  for (let index = 1; index < children.length; index += 1) {
    if (children[index]?.edgeByte === children[index - 1]?.edgeByte) {
      throw new Error('Radix node contains a duplicate child edge.');
    }
  }
  const canonicalJson = mustCanonicalize({
    formatVersion: 1,
    prefixHex: bytesToHex(prefix),
    value: value === null ? null : operation.domain.encodeValue(value),
    children: children.map(({ edgeByte, nodeId }) => ({ edgeByte, nodeId })),
  });
  const id = hashNode(operation.domain, canonicalJson);
  const existing = operation.created.get(id);
  if (existing) return existing;
  const node = Object.freeze({ id, canonicalJson, prefixHex: bytesToHex(prefix), value, children });
  operation.created.set(id, node);
  operation.writes.push(Object.freeze({ id, canonicalJson }));
  return node;
}

function finishOperation<Value>(
  operation: MutableOperation<Value>,
  rootId: RadixNodeId | null,
  size: number,
  changed: boolean
): RadixMutation<Value> {
  return Object.freeze({
    map: makeRadixMap(
      rootId === null ? null : (operation.created.get(rootId) ?? operation.source.root),
      size
    ),
    writes: Object.freeze([...operation.writes]),
    changed,
  });
}

function createOperation<Value>(
  domain: RadixDomain<Value>,
  source: RadixStore<Value>,
  access?: RadixAccessCounter
): MutableOperation<Value> {
  return { domain, source, access: access ?? { nodeReads: 0 }, created: new Map(), writes: [] };
}

function countNodeRead(access: RadixAccessCounter | undefined): void {
  if (access) access.nodeReads += 1;
}

function decodeBody<Value>(
  value: unknown,
  domain: RadixDomain<Value>
): Result<DecodedNodeBody<Value>, RadixDecodeError> {
  if (!isRecord(value)) return invalidShape();
  if (
    value.formatVersion !== 1 ||
    typeof value.prefixHex !== 'string' ||
    !/^(?:[0-9a-f]{2})*$/u.test(value.prefixHex) ||
    !Array.isArray(value.children)
  ) {
    return invalidShape();
  }
  let decodedValue: Value | null = null;
  if (value.value !== null) {
    const decoded = domain.decodeValue(value.value);
    if (!decoded.ok) return { ok: false, error: { kind: 'invalid-node-value' } };
    decodedValue = decoded.value;
  }
  const children: Array<{ readonly edgeByte: number; readonly nodeId: RadixNodeId }> = [];
  let previous = -1;
  for (const candidate of value.children) {
    if (!isRecord(candidate)) return invalidShape();
    if (
      !Number.isInteger(candidate.edgeByte) ||
      (candidate.edgeByte as number) < 0 ||
      (candidate.edgeByte as number) > 255 ||
      (candidate.edgeByte as number) <= previous ||
      typeof candidate.nodeId !== 'string' ||
      !isDomainNodeId(candidate.nodeId, domain)
    ) {
      return invalidShape();
    }
    previous = candidate.edgeByte as number;
    children.push({
      edgeByte: candidate.edgeByte as number,
      nodeId: brandValidated<string, 'RadixNodeId'>(candidate.nodeId) as RadixNodeId,
    });
  }
  return {
    ok: true,
    value: Object.freeze({
      prefixHex: value.prefixHex,
      value: decodedValue,
      children: Object.freeze(children.map((entry) => Object.freeze(entry))),
    }),
  };
}

function hashNode<Value>(domain: RadixDomain<Value>, canonicalJson: string): RadixNodeId {
  const digest = bytesToHex(
    sha256(concatBytes(utf8ToBytes(domain.hashDomain), utf8ToBytes(canonicalJson)))
  );
  return brandValidated(`${domain.idPrefix}_${digest}` as `${string}_${string}`);
}

function encodeValue<Value>(domain: RadixDomain<Value>, value: Value | null): string {
  if (value === null) return 'null';
  return mustCanonicalize(domain.encodeValue(value));
}

function mustCanonicalize(value: unknown): CanonicalJson {
  const result = canonicalize(value);
  if (!result.ok)
    throw new Error(`Internal radix node failed canonicalization: ${result.error.kind}`);
  return result.value;
}

function isDomainNodeId(value: string, domain: { readonly idPrefix: string }): boolean {
  return (
    value.startsWith(`${domain.idPrefix}_`) &&
    /^[0-9a-f]{64}$/u.test(value.slice(domain.idPrefix.length + 1))
  );
}

function findChild<Value>(
  children: readonly RadixChild<Value>[],
  edgeByte: number | undefined
): RadixChild<Value> | undefined {
  return edgeByte === undefined
    ? undefined
    : children.find((candidate) => candidate.edgeByte === edgeByte);
}

function child<Value>(edgeByte: number, node: RadixNode<Value>): RadixChild<Value> {
  return Object.freeze({ edgeByte, nodeId: node.id, node });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidShape(): Result<never, RadixDecodeError> {
  return { ok: false, error: { kind: 'invalid-node-shape' } };
}
