import { createHash } from 'node:crypto';

import type {
  NativeExportDownloadAcceptanceEvidence,
  ProviderActivityBundle,
} from '../../shared/benchling-migration';

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const NATIVE_EXPORT_LEDGER_EPOCH = /^native-ledger-epoch:[a-f0-9]{32}$/u;
const ACCEPTANCE_SCHEMA = 'dnaforge.benchling.native-export-download-acceptance.v1' as const;
const ACCEPTANCE_ID_PREFIX = 'native-download-acceptance:';
const MAX_PROTECTED_EXPORT_REDIRECTS = 3;

type NativeExportDownloadAcceptanceInput = Omit<
  NativeExportDownloadAcceptanceEvidence,
  'schema' | 'id' | 'evidenceSha256'
>;

export function createNativeExportDownloadAcceptanceEvidence(
  input: NativeExportDownloadAcceptanceInput
): NativeExportDownloadAcceptanceEvidence {
  const body = {
    schema: ACCEPTANCE_SCHEMA,
    runId: input.runId,
    exportJobId: input.exportJobId,
    matchSignature: input.matchSignature,
    receiptId: input.receiptId,
    downloadUrlHash: input.downloadUrlHash,
    nativeExportLedgerEpoch: input.nativeExportLedgerEpoch,
    downloadCommandRequestId: input.downloadCommandRequestId,
    acceptedAt: input.acceptedAt,
  };
  const evidenceSha256 = digest(body);
  return validateNativeExportDownloadAcceptanceEvidence({
    ...body,
    id: `${ACCEPTANCE_ID_PREFIX}${evidenceSha256.slice('sha256:'.length)}`,
    evidenceSha256,
  });
}

export function validateNativeExportDownloadAcceptanceEvidence(
  input: unknown,
  expectedRunId?: string
): NativeExportDownloadAcceptanceEvidence {
  const record = requireRecord(input, 'Native export download acceptance');
  const exactKeys = [
    'schema',
    'id',
    'runId',
    'exportJobId',
    'matchSignature',
    'receiptId',
    'downloadUrlHash',
    'nativeExportLedgerEpoch',
    'downloadCommandRequestId',
    'acceptedAt',
    'evidenceSha256',
  ];
  if (
    Object.keys(record).length !== exactKeys.length ||
    exactKeys.some((key) => !Object.hasOwn(record, key)) ||
    record.schema !== ACCEPTANCE_SCHEMA
  ) {
    throw new Error('Native export download acceptance is malformed.');
  }
  const runId = requireOpaqueId(record.runId, 'acceptance run ID');
  const exportJobId = requireOpaqueId(record.exportJobId, 'acceptance export job ID');
  const receiptId = requireOpaqueId(record.receiptId, 'acceptance receipt ID');
  const downloadCommandRequestId = requireOpaqueId(
    record.downloadCommandRequestId,
    'acceptance download command request ID'
  );
  const matchSignature = requireStableString(record.matchSignature, 'acceptance match signature');
  if (
    (expectedRunId !== undefined && runId !== expectedRunId) ||
    typeof record.downloadUrlHash !== 'string' ||
    !SHA256_REF.test(record.downloadUrlHash) ||
    typeof record.nativeExportLedgerEpoch !== 'string' ||
    !NATIVE_EXPORT_LEDGER_EPOCH.test(record.nativeExportLedgerEpoch) ||
    typeof record.evidenceSha256 !== 'string' ||
    !SHA256_REF.test(record.evidenceSha256)
  ) {
    throw new Error('Native export download acceptance has invalid correlation.');
  }
  const acceptedAt = requireCanonicalUtcTimestamp(record.acceptedAt, 'acceptance time');
  const normalized = {
    schema: ACCEPTANCE_SCHEMA,
    id: requireOpaqueId(record.id, 'acceptance ID'),
    runId,
    exportJobId,
    matchSignature,
    receiptId,
    downloadUrlHash: record.downloadUrlHash,
    nativeExportLedgerEpoch: record.nativeExportLedgerEpoch,
    downloadCommandRequestId,
    acceptedAt,
    evidenceSha256: record.evidenceSha256,
  } satisfies NativeExportDownloadAcceptanceEvidence;
  const expectedDigest = digest({
    schema: normalized.schema,
    runId: normalized.runId,
    exportJobId: normalized.exportJobId,
    matchSignature: normalized.matchSignature,
    receiptId: normalized.receiptId,
    downloadUrlHash: normalized.downloadUrlHash,
    nativeExportLedgerEpoch: normalized.nativeExportLedgerEpoch,
    downloadCommandRequestId: normalized.downloadCommandRequestId,
    acceptedAt: normalized.acceptedAt,
  });
  if (
    normalized.evidenceSha256 !== expectedDigest ||
    normalized.id !== `${ACCEPTANCE_ID_PREFIX}${expectedDigest.slice('sha256:'.length)}`
  ) {
    throw new Error('Native export download acceptance digest is invalid.');
  }
  return Object.freeze(normalized);
}

export function isExactSuccessfulNativeExportDownloadActivity(
  activity: ProviderActivityBundle
): boolean {
  if (
    activity.operationKind !== 'download_export' ||
    activity.complete !== true ||
    activity.observations.length < 1 ||
    activity.observations.length > MAX_PROTECTED_EXPORT_REDIRECTS + 1
  ) {
    return false;
  }
  return activity.observations.every((observation, index) => {
    if (
      observation.ordinal !== index ||
      observation.kind !== 'network_request' ||
      observation.requestClass !== 'export_archive_download' ||
      observation.method !== 'GET' ||
      observation.result !== 'response'
    ) {
      return false;
    }
    const terminal = index === activity.observations.length - 1;
    if (!terminal) {
      return (
        observation.providerSurface === 'benchling_tenant' && observation.statusClass === '3xx'
      );
    }
    return (
      (observation.providerSurface === 'benchling_tenant' ||
        observation.providerSurface === 'benchling_temp_storage') &&
      observation.statusClass === '2xx'
    );
  });
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Native export download evidence is non-canonical.');
  return encoded;
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} is malformed.`);
  }
  return input as Record<string, unknown>;
}

function requireOpaqueId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !OPAQUE_ID.test(input)) {
    throw new Error(`${label} is invalid.`);
  }
  return input;
}

function requireStableString(input: unknown, label: string): string {
  if (
    typeof input !== 'string' ||
    input.length < 1 ||
    input.length > 4_096 ||
    input.trim() !== input ||
    input.includes('\0')
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return input;
}

function requireCanonicalUtcTimestamp(input: unknown, label: string): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input)) {
    throw new Error(`${label} is invalid.`);
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input) {
    throw new Error(`${label} is invalid.`);
  }
  return input;
}
