export const LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V1 =
  'waypoint-reference-source-materialization-v1' as const;
export const LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V2 =
  'waypoint-reference-source-materialization-v2' as const;
export const LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE =
  'reference-source-materialization.v1.json' as const;

export interface PreparedSourceFileIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface PreparedSourceIdentitySet {
  readonly fasta: PreparedSourceFileIdentity;
  readonly gff?: PreparedSourceFileIdentity;
}

export interface PreparedOutputIdentitySet {
  readonly fasta: PreparedSourceFileIdentity;
  readonly fai: PreparedSourceFileIdentity;
  readonly gff?: PreparedSourceFileIdentity;
  readonly tbi?: PreparedSourceFileIdentity;
}

export type LocalPreparedSourceReceipt =
  | Readonly<{
      contract: typeof LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V1;
      chrom: string;
      indexerVersion: string;
      source: Required<PreparedSourceIdentitySet>;
      output: Required<PreparedOutputIdentitySet>;
    }>
  | Readonly<{
      contract: typeof LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V2;
      variant: 'sequence-only';
      chrom: string;
      indexerVersion: string;
      source: Pick<PreparedSourceIdentitySet, 'fasta'>;
      output: Pick<PreparedOutputIdentitySet, 'fasta' | 'fai'>;
    }>;

export function createLocalPreparedSourceReceipt(input: {
  readonly chrom: string;
  readonly indexerVersion: string;
  readonly source: PreparedSourceIdentitySet;
  readonly output: PreparedOutputIdentitySet;
}): LocalPreparedSourceReceipt {
  const variant = preparedSourceVariant(input.source, input.output);
  if (variant === 'annotated') {
    return {
      contract: LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V1,
      chrom: input.chrom,
      indexerVersion: input.indexerVersion,
      source: {
        fasta: input.source.fasta,
        gff: requireIdentity(input.source.gff, 'annotated source GFF'),
      },
      output: {
        fasta: input.output.fasta,
        fai: input.output.fai,
        gff: requireIdentity(input.output.gff, 'prepared GFF'),
        tbi: requireIdentity(input.output.tbi, 'prepared GFF index'),
      },
    };
  }
  return {
    contract: LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
    variant: 'sequence-only',
    chrom: input.chrom,
    indexerVersion: input.indexerVersion,
    source: { fasta: input.source.fasta },
    output: {
      fasta: input.output.fasta,
      fai: input.output.fai,
    },
  };
}

export function localPreparedSourceReceiptMatches(input: {
  readonly value: unknown;
  readonly chrom: string;
  readonly source: PreparedSourceIdentitySet | null;
  readonly output: PreparedOutputIdentitySet;
}): boolean {
  const variant = preparedSourceVariant(input.source, input.output);
  if (!isRecord(input.value)) return false;
  if (variant === 'annotated') {
    if (
      input.value.contract !== LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V1 ||
      input.value.chrom !== input.chrom ||
      !validIndexerVersion(input.value.indexerVersion) ||
      !isRecord(input.value.source) ||
      !isRecord(input.value.output)
    ) {
      return false;
    }
    const expectedSourceGff = input.source?.gff;
    return (
      (input.source
        ? Boolean(
            expectedSourceGff &&
            samePreparedSourceFileIdentity(input.value.source.fasta, input.source.fasta) &&
            samePreparedSourceFileIdentity(input.value.source.gff, expectedSourceGff)
          )
        : validPreparedSourceFileIdentity(input.value.source.fasta) &&
          validPreparedSourceFileIdentity(input.value.source.gff)) &&
      samePreparedSourceFileIdentity(input.value.output.fasta, input.output.fasta) &&
      samePreparedSourceFileIdentity(input.value.output.fai, input.output.fai) &&
      samePreparedSourceFileIdentity(input.value.output.gff, input.output.gff) &&
      samePreparedSourceFileIdentity(input.value.output.tbi, input.output.tbi)
    );
  }

  if (
    input.value.contract !== LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_V2 ||
    input.value.variant !== 'sequence-only' ||
    input.value.chrom !== input.chrom ||
    !validIndexerVersion(input.value.indexerVersion) ||
    !isRecord(input.value.source) ||
    !isRecord(input.value.output)
  ) {
    return false;
  }
  return (
    (input.source
      ? samePreparedSourceFileIdentity(input.value.source.fasta, input.source.fasta)
      : validPreparedSourceFileIdentity(input.value.source.fasta)) &&
    samePreparedSourceFileIdentity(input.value.output.fasta, input.output.fasta) &&
    samePreparedSourceFileIdentity(input.value.output.fai, input.output.fai)
  );
}

export function samePreparedSourceFileIdentity(
  left: unknown,
  right: PreparedSourceFileIdentity | undefined
): boolean {
  if (!right || !validPreparedSourceFileIdentity(left)) return false;
  return (
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
  );
}

export function validPreparedSourceFileIdentity(
  value: unknown
): value is PreparedSourceFileIdentity {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.size) &&
    Number(value.size) > 0 &&
    typeof value.mtimeMs === 'number' &&
    Number.isFinite(value.mtimeMs) &&
    value.mtimeMs >= 0 &&
    typeof value.ctimeMs === 'number' &&
    Number.isFinite(value.ctimeMs) &&
    value.ctimeMs >= 0
  );
}

function preparedSourceVariant(
  source: PreparedSourceIdentitySet | null,
  output: PreparedOutputIdentitySet
): 'annotated' | 'sequence-only' {
  const hasSourceGff = Boolean(source?.gff);
  const hasOutputGff = Boolean(output.gff);
  const hasOutputTbi = Boolean(output.tbi);
  if (hasOutputGff !== hasOutputTbi || (source && hasSourceGff !== hasOutputGff)) {
    throw new Error('Prepared source receipt has a mismatched annotation variant.');
  }
  return hasOutputGff ? 'annotated' : 'sequence-only';
}

function requireIdentity(
  value: PreparedSourceFileIdentity | undefined,
  label: string
): PreparedSourceFileIdentity {
  if (!value) throw new Error(`Prepared source receipt is missing ${label}.`);
  return value;
}

function validIndexerVersion(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
