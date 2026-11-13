import { utf8ToBytes } from '@noble/hashes/utils';

import type { ImmutableRecordKind } from './types';

export const CANONICAL_RECORD_BYTE_LIMITS: Readonly<Record<ImmutableRecordKind, number>> =
  Object.freeze({
    'resource-state': 256 * 1_024,
    'resource-revision': 512 * 1_024,
    'workspace-resource-map-node': 256 * 1_024,
    'workspace-path-map-node': 256 * 1_024,
    'workspace-version': 16 * 1_024,
    'operation-receipt': 1_024 * 1_024,
    'recovery-candidate': 256 * 1_024,
  });

export const MAX_WORKSPACE_INDEX_NODE_BYTES =
  CANONICAL_RECORD_BYTE_LIMITS['workspace-resource-map-node'];

export function canonicalRecordByteLength(canonicalJson: string): number {
  return utf8ToBytes(canonicalJson).length;
}

export function isCanonicalRecordWithinByteLimit(
  kind: ImmutableRecordKind,
  canonicalJson: string
): boolean {
  return canonicalRecordByteLength(canonicalJson) <= CANONICAL_RECORD_BYTE_LIMITS[kind];
}
