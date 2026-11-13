import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import type {
  BlobHash,
  OperationReceiptId,
  RecoveryCandidateId,
  ResourceRevisionId,
  ResourceStateHash,
  WorkspaceVersionId,
} from './identity';

export interface BlobRef {
  readonly hash: BlobHash;
  readonly byteLength: number;
}

type CanonicalRecordKind =
  | 'resource-state'
  | 'resource-revision'
  | 'workspace-version'
  | 'operation-receipt'
  | 'recovery-candidate';

interface CanonicalRecordIdByKind {
  readonly 'resource-state': ResourceStateHash;
  readonly 'resource-revision': ResourceRevisionId;
  readonly 'workspace-version': WorkspaceVersionId;
  readonly 'operation-receipt': OperationReceiptId;
  readonly 'recovery-candidate': RecoveryCandidateId;
}

const RECORD_HASH_DOMAIN: Readonly<
  Record<CanonicalRecordKind, { readonly domain: string; readonly prefix: string }>
> = {
  'resource-state': { domain: 'dnaforge:resource-state:v1\0', prefix: 'rs_' },
  'resource-revision': { domain: 'dnaforge:resource-revision:v1\0', prefix: 'rr_' },
  'workspace-version': { domain: 'dnaforge:workspace-version:v1\0', prefix: 'wv_' },
  'operation-receipt': { domain: 'dnaforge:operation-receipt:v1\0', prefix: 'or_' },
  'recovery-candidate': { domain: 'dnaforge:recovery-candidate:v1\0', prefix: 'rc_' },
};

export function defineBlob(bytes: Uint8Array): BlobRef {
  const digest = bytesToHex(sha256(bytes));
  return Object.freeze({
    hash: `sha256:${digest}` as BlobHash,
    byteLength: bytes.length,
  });
}

export function hashCanonicalRecord<Kind extends CanonicalRecordKind>(
  kind: Kind,
  canonicalJson: string
): CanonicalRecordIdByKind[Kind] {
  const definition = RECORD_HASH_DOMAIN[kind];
  const bytes = concatBytes(utf8ToBytes(definition.domain), utf8ToBytes(canonicalJson));
  return `${definition.prefix}${bytesToHex(sha256(bytes))}` as CanonicalRecordIdByKind[Kind];
}
