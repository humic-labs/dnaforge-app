import { utf8ToBytes } from '@noble/hashes/utils';

import { isUnicodeScalarString } from './unicode';

declare const domainBrand: unique symbol;

export type Brand<Value, Name extends string> = Value & {
  readonly [domainBrand]: Name;
};

export function brandValidated<Value, Name extends string>(value: Value): Brand<Value, Name> {
  return value as Brand<Value, Name>;
}

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ResourceId = Brand<string, 'ResourceId'>;
export type MemberId = Brand<string, 'MemberId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type RefName = Brand<string, 'RefName'>;
export type WorkspacePath = Brand<string, 'WorkspacePath'>;
export type ResourcePath = Brand<string, 'ResourcePath'>;
export type BlobHash = Brand<`sha256:${string}`, 'BlobHash'>;
export type ResourceStateHash = Brand<`rs_${string}`, 'ResourceStateHash'>;
export type ResourceRevisionId = Brand<`rr_${string}`, 'ResourceRevisionId'>;
export type WorkspaceVersionId = Brand<`wv_${string}`, 'WorkspaceVersionId'>;
export type RecoveryCandidateId = Brand<`rc_${string}`, 'RecoveryCandidateId'>;
export type OperationReceiptId = Brand<`or_${string}`, 'OperationReceiptId'>;
export type WorkspaceResourceRootId = Brand<`wrn_${string}`, 'WorkspaceResourceRootId'>;
export type WorkspacePathRootId = Brand<`wpn_${string}`, 'WorkspacePathRootId'>;
export type CanonicalJson = Brand<string, 'CanonicalJson'>;

export type Result<Value, ErrorValue> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: ErrorValue };

export type IdentityError =
  | { readonly kind: 'empty' }
  | { readonly kind: 'control-character' }
  | { readonly kind: 'invalid-unicode' }
  | { readonly kind: 'not-nfc' }
  | { readonly kind: 'too-long' };

export type HashIdentityError = { readonly kind: 'invalid-hash-identity' };

export function parseWorkspaceId(value: string): Result<WorkspaceId, IdentityError> {
  return parseIdentity(value);
}

export function parseResourceId(value: string): Result<ResourceId, IdentityError> {
  return parseIdentity(value);
}

export function parseMemberId(value: string): Result<MemberId, IdentityError> {
  return parseIdentity(value);
}

export function parseOperationId(value: string): Result<OperationId, IdentityError> {
  return parseIdentity(value);
}

export function parseRefName(value: string): Result<RefName, IdentityError> {
  return parseIdentity(value);
}

export function parseBlobHash(value: string): Result<BlobHash, HashIdentityError> {
  return parseHashIdentity(value, 'sha256:');
}

export function parseResourceStateHash(
  value: string
): Result<ResourceStateHash, HashIdentityError> {
  return parseHashIdentity(value, 'rs_');
}

export function parseResourceRevisionId(
  value: string
): Result<ResourceRevisionId, HashIdentityError> {
  return parseHashIdentity(value, 'rr_');
}

export function parseWorkspaceVersionId(
  value: string
): Result<WorkspaceVersionId, HashIdentityError> {
  return parseHashIdentity(value, 'wv_');
}

export function parseRecoveryCandidateId(
  value: string
): Result<RecoveryCandidateId, HashIdentityError> {
  return parseHashIdentity(value, 'rc_');
}

export function parseWorkspaceResourceRootId(
  value: string
): Result<WorkspaceResourceRootId, HashIdentityError> {
  return parseHashIdentity(value, 'wrn_');
}

export function parseWorkspacePathRootId(
  value: string
): Result<WorkspacePathRootId, HashIdentityError> {
  return parseHashIdentity(value, 'wpn_');
}

function parseIdentity<Identity extends Brand<string, string>>(
  value: string
): Result<Identity, IdentityError> {
  if (value.length === 0) return { ok: false, error: { kind: 'empty' } };
  if (/\p{Cc}/u.test(value)) return { ok: false, error: { kind: 'control-character' } };
  if (!isUnicodeScalarString(value)) return { ok: false, error: { kind: 'invalid-unicode' } };
  if (value !== value.normalize('NFC')) return { ok: false, error: { kind: 'not-nfc' } };
  if (utf8ToBytes(value).length > 256) return { ok: false, error: { kind: 'too-long' } };
  return { ok: true, value: value as Identity };
}

function parseHashIdentity<Identity extends Brand<string, string>>(
  value: string,
  prefix: string
): Result<Identity, HashIdentityError> {
  if (!value.startsWith(prefix) || !/^[0-9a-f]{64}$/u.test(value.slice(prefix.length))) {
    return { ok: false, error: { kind: 'invalid-hash-identity' } };
  }
  return { ok: true, value: value as Identity };
}
