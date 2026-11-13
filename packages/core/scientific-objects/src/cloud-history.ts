import {
  defineBlob,
  parseBlobHash,
  parseWorkspaceId,
  parseWorkspaceVersionId,
  type BlobRef,
  type WorkspaceId,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  decodeScientificHistory,
  serializeScientificHistory,
  ScientificHistoryInvalidError,
  type ScientificHistoryReader,
  type ScientificHistoryV1,
} from './history';

export const SCIENTIFIC_CLOUD_REPRESENTATION = 'scientific_manifest_v1' as const;

export interface ScientificCloudHistoryV1 {
  readonly formatVersion: 1;
  readonly logicalWorkspaceId: WorkspaceId;
  readonly acceptedHead: WorkspaceVersionId | null;
  readonly archive: BlobRef;
}

export function describeScientificCloudHistory(
  history: ScientificHistoryV1
): ScientificCloudHistoryV1 {
  const identity = parseWorkspaceId(history.graph.workspaceId);
  const head = history.graph.refs.find((ref) => ref.name === 'accepted');
  const parsed = head?.head == null ? null : parseWorkspaceVersionId(head.head);
  if (!identity.ok || !head || (parsed !== null && !parsed.ok))
    throw new ScientificHistoryInvalidError(
      'Scientific cloud history identity or accepted head is invalid.'
    );
  return Object.freeze({
    formatVersion: 1,
    logicalWorkspaceId: identity.value,
    acceptedHead: parsed?.ok ? parsed.value : null,
    archive: defineBlob(serializeScientificHistory(history)),
  });
}

export function parseScientificCloudHistory(value: unknown): ScientificCloudHistoryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ScientificHistoryInvalidError('Scientific cloud history descriptor is malformed.');
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(',') !==
      'acceptedHead,archive,formatVersion,logicalWorkspaceId' ||
    data.formatVersion !== 1 ||
    typeof data.logicalWorkspaceId !== 'string'
  )
    throw new ScientificHistoryInvalidError('Unsupported scientific cloud history descriptor.');
  const identity = parseWorkspaceId(data.logicalWorkspaceId);
  const head =
    data.acceptedHead === null
      ? null
      : typeof data.acceptedHead === 'string'
        ? parseWorkspaceVersionId(data.acceptedHead)
        : undefined;
  if (
    !identity.ok ||
    head === undefined ||
    (head !== null && !head.ok) ||
    !data.archive ||
    typeof data.archive !== 'object' ||
    Array.isArray(data.archive)
  )
    throw new ScientificHistoryInvalidError('Scientific cloud history identity is invalid.');
  const archive = data.archive as Record<string, unknown>;
  const digest = typeof archive.hash === 'string' ? parseBlobHash(archive.hash) : null;
  if (
    Object.keys(archive).sort().join(',') !== 'byteLength,hash' ||
    !digest?.ok ||
    typeof archive.byteLength !== 'number' ||
    !Number.isSafeInteger(archive.byteLength) ||
    archive.byteLength <= 0
  )
    throw new ScientificHistoryInvalidError('Scientific cloud history archive is invalid.');
  return Object.freeze({
    formatVersion: 1,
    logicalWorkspaceId: identity.value,
    acceptedHead: head?.ok ? head.value : null,
    archive: Object.freeze({ hash: digest.value, byteLength: archive.byteLength }),
  });
}

export function validateScientificCloudHistory(
  value: unknown,
  archiveBytes: Uint8Array,
  input: ScientificHistoryReader
) {
  const descriptor = parseScientificCloudHistory(value);
  const validated = decodeScientificHistory(archiveBytes, descriptor.archive, input);
  if (
    validated.envelope.graph.workspaceId !== descriptor.logicalWorkspaceId ||
    validated.head !== descriptor.acceptedHead
  )
    throw new ScientificHistoryInvalidError(
      'Scientific cloud descriptor differs from its verified authority.'
    );
  return { descriptor, ...validated };
}

export function scientificCloudVersionHashInput(
  manifestSha256: string,
  history: ScientificCloudHistoryV1
): string {
  if (!/^[0-9a-f]{64}$/u.test(manifestSha256))
    throw new ScientificHistoryInvalidError('Scientific cloud manifest digest is invalid.');
  const descriptor = parseScientificCloudHistory(history);
  const hex = [...new TextEncoder().encode(descriptor.logicalWorkspaceId)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return [
    'dnaforge.scientific-workspace-version/v1',
    manifestSha256,
    descriptor.archive.hash.slice('sha256:'.length),
    String(descriptor.archive.byteLength),
    hex,
    descriptor.acceptedHead ?? '',
    '',
  ].join('\n');
}

export function scientificCloudRequestHashInput(
  baseVersionId: string | null,
  manifestSha256: string,
  history: ScientificCloudHistoryV1
): string {
  if (
    baseVersionId !== null &&
    (typeof baseVersionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(baseVersionId))
  )
    throw new ScientificHistoryInvalidError(
      'Scientific cloud conditional base must be a UUID or null.'
    );
  const version = defineBlob(
    new TextEncoder().encode(scientificCloudVersionHashInput(manifestSha256, history))
  ).hash;

  const base = baseVersionId?.toLowerCase() ?? '';
  return [
    'dnaforge.scientific-workspace-request/v1',
    `${new TextEncoder().encode(base).byteLength}:${base}`,
    version.slice('sha256:'.length),
    '',
  ].join('\n');
}
