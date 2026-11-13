import type { Brand, CanonicalJson, Result } from './identity';

export const radixValueBrand: unique symbol = Symbol('radix-value');

export type RadixNodeId = Brand<`${string}_${string}`, 'RadixNodeId'>;

export interface RadixNodeWrite {
  readonly id: RadixNodeId;
  readonly canonicalJson: CanonicalJson;
}

export interface RadixDomain<Value> {
  readonly name: string;
  readonly hashDomain: string;
  readonly idPrefix: string;
  readonly encodeValue: (value: Value) => unknown;
  readonly decodeValue: (value: unknown) => Result<Value, RadixDecodeError>;
}

export interface MerkleRadixMap<Value> {
  readonly rootId: RadixNodeId | null;
  readonly size: number;
  readonly [radixValueBrand]: (value: Value) => void;
}

export interface RadixMutation<Value> {
  readonly map: MerkleRadixMap<Value>;
  readonly writes: readonly RadixNodeWrite[];
  readonly changed: boolean;
}

export interface RadixAccessCounter {
  nodeReads: number;
}

export type RadixDecodeError =
  | { readonly kind: 'record-too-large' }
  | { readonly kind: 'invalid-canonical-json' }
  | { readonly kind: 'record-id-mismatch' }
  | { readonly kind: 'invalid-node-shape' }
  | { readonly kind: 'invalid-node-value' }
  | { readonly kind: 'missing-node' }
  | { readonly kind: 'node-cycle' }
  | { readonly kind: 'noncanonical-node-structure' }
  | { readonly kind: 'entry-count-mismatch' };

export interface RadixChild<Value> {
  readonly edgeByte: number;
  readonly nodeId: RadixNodeId;
  readonly node: RadixNode<Value>;
}

export interface RadixNode<Value> {
  readonly id: RadixNodeId;
  readonly canonicalJson: CanonicalJson;
  readonly prefixHex: string;
  readonly value: Value | null;
  readonly children: readonly RadixChild<Value>[];
}

export interface DecodedNodeBody<Value> {
  readonly prefixHex: string;
  readonly value: Value | null;
  readonly children: readonly { readonly edgeByte: number; readonly nodeId: RadixNodeId }[];
}

export interface RadixStore<Value> {
  readonly root: RadixNode<Value> | null;
}
