import { withUserMessage } from '@waypoint/user-messages';
import type { ReadHitPayload } from '@waypoint/genome-renderer';

import { resolveSidecarBaseUrl, sidecarFetch } from '../../services/sidecar-session';
import { alignedReadSourceGenerationKey } from './aligned-read-source-generation';
import { pileupSourceRequestFields, type PileupSource } from './pileup-source';

export interface AlignmentReadDetails {
  readonly readId: string;
  readonly chrom: string;
  readonly start: number;
  readonly end: number;
  readonly strand: '+' | '-';
  readonly mapq: number;
  readonly flag: number;
  readonly cigar: string;
  readonly seq: string;
  readonly baseQualities?: ReadonlyArray<number>;
  readonly pair?: ReadHitPayload['pair'];
  readonly tags: Readonly<Record<string, unknown>>;
}

export async function readAlignmentDetails(input: {
  readonly source: PileupSource;
  readonly hit: ReadHitPayload;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}): Promise<AlignmentReadDetails> {
  if (input.hit.flag === undefined) {
    throw new Error('This read has no alignment FLAG and cannot be resolved exactly.');
  }
  if (alignedReadSourceGenerationKey(input.source.generation) !== input.hit.sourceGenerationKey) {
    throw new Error('The alignment source changed after this read was presented.');
  }
  const baseUrl = (
    input.source.remote?.tileBaseUrl ?? (await resolveSidecarBaseUrl('alignment-read-details'))
  ).replace(/\/+$/, '');
  const response = await sidecarFetch(
    `${baseUrl}/tiles/alignment/read`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...pileupSourceRequestFields(input.source),
        chrom: input.hit.chrom,
        readId: input.hit.readId,
        referenceStart: input.hit.referenceStart,
        flag: input.hit.flag,
        ...(input.hit.pair?.readNumber ? { readNumber: input.hit.pair.readNumber } : {}),
      }),
      signal: input.signal,
    },
    input.fetchImpl
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw withUserMessage(
      new Error(errorDetail(body) ?? `Could not load read details (HTTP ${response.status}).`),
      response.status === 404 ? 'readDetails.notFound' : 'readDetails.failed'
    );
  }
  return parseAlignmentReadDetails(body);
}

function parseAlignmentReadDetails(value: unknown): AlignmentReadDetails {
  if (!isRecord(value)) throw new Error('The alignment service returned an invalid read.');
  const readId = requiredString(value, 'readId');
  const chrom = requiredString(value, 'chrom');
  const start = requiredInteger(value, 'start');
  const end = requiredInteger(value, 'end');
  const strand = value.strand;
  if (strand !== '+' && strand !== '-') {
    throw new Error('The alignment service returned an invalid read strand.');
  }
  const tagsValue = value.tags;
  if (!isRecord(tagsValue)) {
    throw new Error('The alignment service returned invalid read tags.');
  }
  const pair = parsePair(value.pair);
  const seq = requiredString(value, 'seq', true);
  const baseQualities = parseBaseQualities(value.baseQualities, seq.length);
  return {
    readId,
    chrom,
    start,
    end,
    strand,
    mapq: requiredInteger(value, 'mapq'),
    flag: requiredInteger(value, 'flag'),
    cigar: requiredString(value, 'cigar', true),
    seq,
    ...(baseQualities ? { baseQualities } : {}),
    ...(pair ? { pair } : {}),
    tags: tagsValue,
  };
}

function parseBaseQualities(
  value: unknown,
  sequenceLength: number
): ReadonlyArray<number> | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== sequenceLength ||
    value.some((score) => !Number.isSafeInteger(score) || Number(score) < 0 || Number(score) > 255)
  ) {
    throw withUserMessage(
      new Error('The alignment service returned invalid base qualities.'),
      'readDetails.invalidQualities'
    );
  }
  return value.map(Number);
}

function parsePair(value: unknown): ReadHitPayload['pair'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.paired !== true) {
    throw new Error('The alignment service returned invalid paired-read metadata.');
  }
  const readNumber = value.readNumber;
  if (readNumber !== undefined && readNumber !== 1 && readNumber !== 2) {
    throw new Error('The alignment service returned an invalid read number.');
  }
  return {
    paired: true,
    ...(typeof value.properPair === 'boolean' ? { properPair: value.properPair } : {}),
    ...(readNumber ? { readNumber } : {}),
    ...(typeof value.mateUnmapped === 'boolean' ? { mateUnmapped: value.mateUnmapped } : {}),
    ...(typeof value.mateReverse === 'boolean' ? { mateReverse: value.mateReverse } : {}),
    ...(Number.isSafeInteger(value.mateStart) ? { mateStart: Number(value.mateStart) } : {}),
    ...(Number.isSafeInteger(value.templateLength)
      ? { templateLength: Number(value.templateLength) }
      : {}),
  };
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  allowEmpty = false
): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || (!allowEmpty && candidate.length === 0)) {
    throw new Error(`The alignment service returned an invalid ${key}.`);
  }
  return candidate;
}

function requiredInteger(value: Readonly<Record<string, unknown>>, key: string): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate)) {
    throw new Error(`The alignment service returned an invalid ${key}.`);
  }
  return Number(candidate);
}

function errorDetail(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.detail === 'string' && value.detail.trim()) return value.detail.trim();
  if (isRecord(value.detail) && typeof value.detail.message === 'string') {
    return value.detail.message.trim() || null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
