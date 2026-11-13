import type { CanonicalImportError, DecodedCanonicalRecord } from './codec-types';
import type { ResourceRevisionRecord } from './graph';
import type { BlobRef } from './hash';
import {
  parseBlobHash,
  parseMemberId,
  parseResourceId,
  parseResourceRevisionId,
  parseResourceStateHash,
  type ResourceRevisionId,
  type Result,
} from './identity';
import type {
  CanonicalMap,
  CanonicalValue,
  ImmutableRecordKind,
  ResourceMemberInput,
  ResourceOrigin,
} from './types';
import { parseResourcePath } from './path';
import { MAX_DERIVED_ORIGIN_SOURCES } from './records';
import {
  defineResourceState,
  getResourceStateRecord,
  type ResourceStateRecord,
} from './resource-state';

export function decodeResourceState(
  decoded: DecodedCanonicalRecord
): Result<ResourceStateRecord, CanonicalImportError> {
  const body = decoded.body;
  const metadata = decodeOptionalMetadata(body.materialMetadata);
  if (!metadata.ok) return invalidBody('resource-state');
  if (body.layout === 'file') {
    if (
      !hasExactKeys(body, [
        'formatVersion',
        'layout',
        'resourceKind',
        'mediaType',
        'blob',
        ...(body.materialMetadata === undefined ? [] : ['materialMetadata']),
      ]) ||
      typeof body.resourceKind !== 'string' ||
      typeof body.mediaType !== 'string'
    ) {
      return invalidBody('resource-state');
    }
    const blob = decodeBlob(body.blob);
    if (!blob) return invalidBody('resource-state');
    const state = defineResourceState({
      layout: 'file',
      resourceKind: body.resourceKind,
      mediaType: body.mediaType,
      blob,
      ...(metadata.value === undefined ? {} : { materialMetadata: metadata.value }),
    });
    if (!state.ok) return invalidBody('resource-state');
    return verifyDecodedState(decoded, state.value);
  }
  if (
    body.layout !== 'directory' ||
    typeof body.resourceKind !== 'string' ||
    typeof body.format !== 'string' ||
    !Array.isArray(body.members)
  ) {
    return invalidBody('resource-state');
  }
  if (
    !hasExactKeys(body, [
      'formatVersion',
      'layout',
      'resourceKind',
      'format',
      'members',
      ...(body.materialMetadata === undefined ? [] : ['materialMetadata']),
    ])
  ) {
    return invalidBody('resource-state');
  }
  const members: ResourceMemberInput[] = [];
  for (const candidate of body.members) {
    const member = decodeMember(candidate);
    if (!member) return invalidBody('resource-state');
    members.push(member);
  }
  const state = defineResourceState({
    layout: 'directory',
    resourceKind: body.resourceKind,
    format: body.format,
    members,
    ...(metadata.value === undefined ? {} : { materialMetadata: metadata.value }),
  });
  if (!state.ok) return invalidBody('resource-state');
  return verifyDecodedState(decoded, state.value);
}

function verifyDecodedState(
  decoded: DecodedCanonicalRecord,
  state: import('./types').ResourceState
): Result<ResourceStateRecord, CanonicalImportError> {
  const record = getResourceStateRecord(state);
  if (!record || record.hash !== decoded.id || record.canonicalJson !== decoded.canonicalJson) {
    return invalidBody('resource-state');
  }
  return { ok: true, value: record };
}

export function decodeResourceRevision(
  decoded: DecodedCanonicalRecord
): Result<ResourceRevisionRecord, CanonicalImportError> {
  const body = decoded.body;
  if (
    !hasExactKeys(body, [
      'formatVersion',
      'resourceId',
      'stateHash',
      'parentIds',
      'origin',
      'tombstone',
    ]) ||
    typeof body.resourceId !== 'string' ||
    (body.stateHash !== null && typeof body.stateHash !== 'string') ||
    !Array.isArray(body.parentIds) ||
    typeof body.tombstone !== 'boolean'
  ) {
    return invalidBody('resource-revision');
  }
  const resourceId = parseResourceId(body.resourceId);
  const stateHash =
    body.stateHash === null
      ? { ok: true as const, value: null }
      : parseResourceStateHash(body.stateHash);
  const parentIds = decodeResourceRevisionIds(body.parentIds);
  const origin = decodeOrigin(body.origin);
  const id = parseResourceRevisionId(decoded.id);
  if (!resourceId.ok || !stateHash.ok || !parentIds || !origin.ok || !id.ok) {
    return invalidBody('resource-revision');
  }
  if (body.tombstone !== (stateHash.value === null)) {
    return invalidBody('resource-revision');
  }
  return {
    ok: true,
    value: Object.freeze({
      canonicalJson: decoded.canonicalJson,
      view: Object.freeze({
        id: id.value,
        resourceId: resourceId.value,
        stateHash: stateHash.value,
        parentIds: Object.freeze(parentIds),
        origin: origin.value,
        tombstone: body.tombstone,
      }),
    }),
  };
}

function decodeMember(value: unknown): ResourceMemberInput | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'memberId',
      'relativePath',
      'mediaType',
      'blob',
      ...(value.materialMetadata === undefined ? [] : ['materialMetadata']),
    ]) ||
    typeof value.memberId !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.mediaType !== 'string'
  ) {
    return null;
  }
  const memberId = parseMemberId(value.memberId);
  const relativePath = parseResourcePath(value.relativePath);
  const blob = decodeBlob(value.blob);
  const metadata = decodeOptionalMetadata(value.materialMetadata);
  if (!memberId.ok || !relativePath.ok || !blob || !metadata.ok) return null;
  return Object.freeze({
    memberId: memberId.value,
    relativePath: relativePath.value,
    mediaType: value.mediaType,
    blob,
    ...(metadata.value === undefined ? {} : { materialMetadata: metadata.value }),
  });
}

function decodeBlob(value: unknown): BlobRef | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['hash', 'byteLength']) ||
    typeof value.hash !== 'string' ||
    typeof value.byteLength !== 'number' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0
  ) {
    return null;
  }
  const hash = parseBlobHash(value.hash);
  return hash.ok ? Object.freeze({ hash: hash.value, byteLength: value.byteLength }) : null;
}

function decodeOrigin(value: unknown): Result<ResourceOrigin | null, null> {
  if (value === null) return { ok: true, value: null };
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    return { ok: false, error: null };
  }
  if (value.kind === 'created' && hasExactKeys(value, ['kind'])) {
    return { ok: true, value: Object.freeze({ kind: 'created' }) };
  }
  if (
    value.kind !== 'derived' ||
    !hasExactKeys(value, ['kind', 'relation', 'sources']) ||
    !isOriginRelation(value.relation) ||
    !Array.isArray(value.sources) ||
    value.sources.length > MAX_DERIVED_ORIGIN_SOURCES
  ) {
    return { ok: false, error: null };
  }
  const sources = decodeResourceRevisionIds(value.sources);
  const first = sources?.[0];
  if (!sources || !first) return { ok: false, error: null };
  const nonEmptySources: Extract<ResourceOrigin, { kind: 'derived' }>['sources'] = [
    first,
    ...sources.slice(1),
  ];
  return {
    ok: true,
    value: Object.freeze({
      kind: 'derived',
      relation: value.relation,
      sources: Object.freeze(nonEmptySources),
    }),
  };
}

function decodeResourceRevisionIds(values: readonly unknown[]): ResourceRevisionId[] | null {
  const result: ResourceRevisionId[] = [];
  let prior: string | null = null;
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const parsed = parseResourceRevisionId(value);
    if (!parsed.ok || (prior !== null && deterministicCompare(prior, parsed.value) >= 0)) {
      return null;
    }
    prior = parsed.value;
    result.push(parsed.value);
  }
  return result;
}

function decodeOptionalMetadata(value: unknown): Result<CanonicalMap | undefined, null> {
  if (value === undefined) return { ok: true, value: undefined };
  return isCanonicalMap(value) ? { ok: true, value } : { ok: false, error: null };
}

function isCanonicalMap(value: unknown): value is CanonicalMap {
  return isPlainRecord(value) && Object.values(value).every(isCanonicalValue);
}

function isCanonicalValue(value: unknown): value is CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every(isCanonicalValue);
  return isPlainRecord(value) && Object.values(value).every(isCanonicalValue);
}

function invalidBody(recordKind: ImmutableRecordKind): Result<never, CanonicalImportError> {
  return { ok: false, error: { kind: 'invalid-record-body', recordKind } };
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort(deterministicCompare);
  const sortedExpected = [...expected].sort(deterministicCompare);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isOriginRelation(
  value: unknown
): value is Extract<ResourceOrigin, { kind: 'derived' }>['relation'] {
  return (
    value === 'copy' ||
    value === 'fork' ||
    value === 'template' ||
    value === 'split' ||
    value === 'merge' ||
    value === 'lossy-conversion'
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
