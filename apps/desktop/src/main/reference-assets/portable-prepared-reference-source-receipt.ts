export const PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2 =
  'waypoint-reference-source-materialization.v2' as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_CONTRACT_TOKEN = /^[\x21-\x7e]{1,512}$/;

export interface PortablePreparedReferenceFileContinuityV2 {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface PortablePreparedReferenceOutputIdentityV2 {
  readonly sha256: string;
  readonly byteLength: number;
  readonly continuity: PortablePreparedReferenceFileContinuityV2;
}

export interface PortablePreparedReferenceSourceReceiptV2 {
  readonly contract: typeof PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2;
  readonly chrom: string;
  readonly pipelineRevision: number;
  readonly bundleFingerprint: string;
  readonly indexerContractToken: string;
  readonly source: Readonly<{
    fastaSha256: string;
    gffSha256: string;
  }>;
  readonly output: Readonly<{
    fasta: PortablePreparedReferenceOutputIdentityV2;
    fai: PortablePreparedReferenceOutputIdentityV2;
    gff: PortablePreparedReferenceOutputIdentityV2;
    tbi: PortablePreparedReferenceOutputIdentityV2;
  }>;
}

export function parsePortablePreparedReferenceSourceReceiptV2(
  value: unknown
): PortablePreparedReferenceSourceReceiptV2 | null {
  if (
    !recordWithExactKeys(value, [
      'contract',
      'chrom',
      'pipelineRevision',
      'bundleFingerprint',
      'indexerContractToken',
      'source',
      'output',
    ])
  ) {
    return null;
  }
  if (
    value.contract !== PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2 ||
    typeof value.chrom !== 'string' ||
    value.chrom.length === 0 ||
    !Number.isSafeInteger(value.pipelineRevision) ||
    Number(value.pipelineRevision) <= 0 ||
    typeof value.bundleFingerprint !== 'string' ||
    !SHA256.test(value.bundleFingerprint) ||
    typeof value.indexerContractToken !== 'string' ||
    !SAFE_CONTRACT_TOKEN.test(value.indexerContractToken) ||
    !recordWithExactKeys(value.source, ['fastaSha256', 'gffSha256']) ||
    typeof value.source.fastaSha256 !== 'string' ||
    !SHA256.test(value.source.fastaSha256) ||
    typeof value.source.gffSha256 !== 'string' ||
    !SHA256.test(value.source.gffSha256) ||
    !recordWithExactKeys(value.output, ['fasta', 'fai', 'gff', 'tbi'])
  ) {
    return null;
  }
  const output = {
    fasta: parseOutputIdentity(value.output.fasta),
    fai: parseOutputIdentity(value.output.fai),
    gff: parseOutputIdentity(value.output.gff),
    tbi: parseOutputIdentity(value.output.tbi),
  };
  if (Object.values(output).some((identity) => identity === null)) return null;
  return {
    contract: PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
    chrom: value.chrom,
    pipelineRevision: Number(value.pipelineRevision),
    bundleFingerprint: value.bundleFingerprint,
    indexerContractToken: value.indexerContractToken,
    source: {
      fastaSha256: value.source.fastaSha256,
      gffSha256: value.source.gffSha256,
    },
    output: output as PortablePreparedReferenceSourceReceiptV2['output'],
  };
}

function parseOutputIdentity(value: unknown): PortablePreparedReferenceOutputIdentityV2 | null {
  if (
    !recordWithExactKeys(value, ['sha256', 'byteLength', 'continuity']) ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    Number(value.byteLength) <= 0 ||
    !recordWithExactKeys(value.continuity, ['size', 'mtimeMs', 'ctimeMs'])
  ) {
    return null;
  }
  const continuity = value.continuity;
  if (
    !Number.isSafeInteger(continuity.size) ||
    Number(continuity.size) <= 0 ||
    Number(continuity.size) !== Number(value.byteLength) ||
    typeof continuity.mtimeMs !== 'number' ||
    !Number.isFinite(continuity.mtimeMs) ||
    continuity.mtimeMs < 0 ||
    typeof continuity.ctimeMs !== 'number' ||
    !Number.isFinite(continuity.ctimeMs) ||
    continuity.ctimeMs < 0
  ) {
    return null;
  }
  return {
    sha256: value.sha256,
    byteLength: Number(value.byteLength),
    continuity: {
      size: Number(continuity.size),
      mtimeMs: continuity.mtimeMs,
      ctimeMs: continuity.ctimeMs,
    },
  };
}

function recordWithExactKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
