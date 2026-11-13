import { createHash } from 'node:crypto';

import type { SourceObject } from '../../shared/benchling-migration';

const MATERIALIZATION_SEQUENCE_SCHEMA =
  'dnaforge.benchling.native-materialization-sequence.v1' as const;

export type NativeSequenceMaterializationFacts =
  | Readonly<{
      kind: 'nucleotide';
      length: number;
      normalizedSequenceHash: `sha256:${string}`;
      topology: 'circular' | 'linear';
    }>
  | Readonly<{
      kind: 'protein';
      length: number;
      normalizedSequenceHash: `sha256:${string}`;
    }>;

export function sourceObjectMaterializationView(source: SourceObject): SourceObject {
  const content = record(source.content);
  if (!content) {
    return source.sourceType === 'strain' ? source : { ...source, content: source.content };
  }
  if (
    source.sourceType === 'strain' ||
    content.kind === 'benchling_strain' ||
    content.kind === 'dna_sequence_needs_sequence'
  ) {
    return source;
  }

  if (
    (source.sourceType === 'dna_sequence' || source.sourceType === 'rna_sequence') &&
    typeof content.bases === 'string' &&
    content.bases.length > 0
  ) {
    return {
      ...source,
      content: materializationContent({
        kind: 'nucleotide',
        sequence: content.bases,
        topology: content.topology === 'circular' ? 'circular' : 'linear',
      }),
    };
  }

  if (
    source.sourceType === 'protein' &&
    typeof content.aminoAcids === 'string' &&
    content.aminoAcids.length > 0
  ) {
    return {
      ...source,
      content: materializationContent({ kind: 'protein', sequence: content.aminoAcids }),
    };
  }

  return { ...source, content: {} };
}

export function nativeSequenceMaterializationFacts(
  content: unknown
): NativeSequenceMaterializationFacts | null {
  const container = record(content);
  if (!container || container.materializationSequence === undefined) return null;
  const candidate = record(container.materializationSequence);
  if (
    !candidate ||
    candidate.schema !== MATERIALIZATION_SEQUENCE_SCHEMA ||
    (candidate.kind !== 'nucleotide' && candidate.kind !== 'protein') ||
    !Number.isSafeInteger(candidate.length) ||
    (candidate.length as number) <= 0 ||
    typeof candidate.normalizedSequenceHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.normalizedSequenceHash)
  ) {
    throw new Error('Native sequence materialization facts are invalid.');
  }
  if (
    candidate.kind === 'nucleotide' &&
    candidate.topology !== 'circular' &&
    candidate.topology !== 'linear'
  ) {
    throw new Error('Native nucleotide materialization topology is invalid.');
  }
  return candidate.kind === 'nucleotide'
    ? {
        kind: candidate.kind,
        length: candidate.length as number,
        normalizedSequenceHash: candidate.normalizedSequenceHash as `sha256:${string}`,
        topology: candidate.topology as 'circular' | 'linear',
      }
    : {
        kind: candidate.kind,
        length: candidate.length as number,
        normalizedSequenceHash: candidate.normalizedSequenceHash as `sha256:${string}`,
      };
}

function materializationContent(
  input:
    | Readonly<{ kind: 'nucleotide'; sequence: string; topology: 'circular' | 'linear' }>
    | Readonly<{ kind: 'protein'; sequence: string }>
): Record<string, unknown> {
  const normalizedSequence = input.sequence.toUpperCase();
  return {
    materializationSequence: {
      schema: MATERIALIZATION_SEQUENCE_SCHEMA,
      kind: input.kind,
      length: input.sequence.length,
      normalizedSequenceHash: `sha256:${createHash('sha256')
        .update(normalizedSequence)
        .digest('hex')}`,
      ...(input.kind === 'nucleotide' ? { topology: input.topology } : {}),
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
