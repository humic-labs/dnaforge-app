import { reverseComplement, translateSequence } from '@waypoint/sequence-utils';

import { motifToRegex } from './search';
import { isInvalidGenomeSequenceError, validateIupacSequencePayload } from './sequence-validation';
import type { GenomeDataSource, GenomeFeature, SearchHit } from './types';

export const REFERENCE_INTERVAL_MAX_INLINE_BP = 50_000;

export const REFERENCE_INTERVAL_MAX_SEARCH_RESULTS = 500;

export const REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP = 2_000_000;

export class ReferenceIntervalSourceUnavailableError extends Error {
  constructor(
    message = 'The indexed reference source is no longer available inside the open workspace.'
  ) {
    super(message);
    this.name = 'ReferenceIntervalSourceUnavailableError';
  }
}

export type ReferenceIntervalOperation =
  | 'read'
  | 'read_spliced'
  | 'reverse_complement'
  | 'translate'
  | 'translate_spliced'
  | 'search'
  | 'extract';

export type ReferenceIntervalStrand = '+' | '-';

export interface ReferenceIntervalSourceIdentity {
  sourceId: string;
  fastaPath?: string;
  assemblyId?: string;
  fingerprint?: string;
}

export interface ReferenceIntervalRequest {
  chrom: string;
  start0: number;
  end0: number;
  strand: ReferenceIntervalStrand;
  operation: ReferenceIntervalOperation;
  motif?: string;
  featureId?: string;
  maxResults?: number;
  wraps?: boolean;
  circular?: boolean;
  signal?: AbortSignal;
}

export type ReferenceIntervalErrorCode =
  | 'MISSING_SOURCE'
  | 'MISSING_CHROMOSOME'
  | 'EMPTY_INTERVAL'
  | 'REVERSED_INTERVAL'
  | 'OUT_OF_BOUNDS'
  | 'OVER_LIMIT'
  | 'INVALID_STRAND'
  | 'INVALID_OPERATION'
  | 'INVALID_MOTIF'
  | 'INVALID_SOURCE'
  | 'MISSING_FEATURE'
  | 'AMBIGUOUS_FEATURE'
  | 'NO_TRANSCRIPT_SEGMENTS'
  | 'NO_CODING_SEGMENTS'
  | 'WRAP_NOT_CIRCULAR'
  | 'WRAP_REQUIRES_ORIGIN_CROSSING'
  | 'WRAP_UNSUPPORTED_OPERATION'
  | 'CANCELLED';

export interface ReferenceIntervalFailure {
  ok: false;
  code: ReferenceIntervalErrorCode;
  error: string;
  details?: {
    chrom?: string;
    start0?: number;
    end0?: number;
    chromosomeLength?: number;
    requestedLength?: number;
    maxInlineBp?: number;
    maxWindowBp?: number;
    featureId?: string;
  };
}

export interface ReferenceIntervalCoordinates {
  chrom: string;
  start0: number;
  end0: number;
  strand: ReferenceIntervalStrand;
  length: number;
  wraps?: boolean;
}

export interface ReferenceIntervalProvenance {
  sourceId: string;
  fastaPath?: string;
  assemblyId?: string;
  sourceFingerprint?: string;
  chrom: string;
  start0: number;
  end0: number;
  strand: ReferenceIntervalStrand;
  chromosomeLength: number;
  requestedLength: number;
  sequenceFingerprint?: string;
  wraps?: boolean;
}

export interface ReferenceIntervalDerivedSequence {
  sequence: string;
  topology: 'linear' | 'circular-origin-span';
  wraps: boolean;
}

export interface ReferenceIntervalTranslation {
  strand: ReferenceIntervalStrand;
  frame: 0 | 1 | 2;
  protein: string;
  codonCount: number;
  incompleteCodon: boolean;
}

export interface ReferenceIntervalSplicedTranslation {
  protein: string;
  codingLength: number;
  frameOffset: number;
  incompleteCodon: boolean;
  hadTrailingStop: boolean;
  phaseSource: 'source' | 'derived';
  featureId?: string;
  segments: Array<{ start0: number; end0: number; strand: ReferenceIntervalStrand }>;
}

export interface ReferenceIntervalSplicedSequence {
  sequence: string;
  length: number;
  featureId: string;
  segments: Array<{ start0: number; end0: number; strand: ReferenceIntervalStrand }>;
}

export interface ReferenceIntervalSuccess {
  ok: true;
  operation: ReferenceIntervalOperation;
  interval: ReferenceIntervalCoordinates;
  provenance: ReferenceIntervalProvenance;
  sequence?: string;
  translations?: ReferenceIntervalTranslation[];
  splicedSequence?: ReferenceIntervalSplicedSequence;
  spliced?: ReferenceIntervalSplicedTranslation;
  searchMotif?: string;
  searchHits?: Array<Omit<SearchHit, 'chrom' | 'motif'>>;
  searchTruncated?: boolean;
  derived?: ReferenceIntervalDerivedSequence;
}

export type ReferenceIntervalResult = ReferenceIntervalSuccess | ReferenceIntervalFailure;

export function isReferenceIntervalFailure(
  value: ReferenceIntervalResult
): value is ReferenceIntervalFailure {
  return value.ok === false;
}

function rejectInvalidReferenceIntervalRequest(
  source: GenomeDataSource | null,
  request: ReferenceIntervalRequest,
  identity: ReferenceIntervalSourceIdentity
): ReferenceIntervalFailure | null {
  if (request.signal?.aborted) return cancelled();
  if (!source) {
    return fail('MISSING_SOURCE', 'No indexed reference source was resolved for this request.');
  }
  if (!identity.sourceId) {
    return fail('MISSING_SOURCE', 'Reference identity is missing a sourceId.');
  }
  if (request.strand !== '+' && request.strand !== '-') {
    return fail('INVALID_STRAND', `Strand must be '+' or '-', got ${String(request.strand)}.`);
  }
  if (!request.chrom) {
    return fail('MISSING_CHROMOSOME', 'Chromosome / contig id is required.');
  }

  const start0 = request.start0;
  const end0 = request.end0;
  if (!Number.isSafeInteger(start0) || !Number.isSafeInteger(end0)) {
    return fail('OUT_OF_BOUNDS', `Coordinates must be safe integers, got ${start0}-${end0}.`, {
      start0,
      end0,
    });
  }
  if (start0 < 0 || end0 < 0) {
    return fail('OUT_OF_BOUNDS', `Negative coordinates are invalid: ${start0}-${end0}.`, {
      start0,
      end0,
    });
  }
  if (request.wraps) {
    if (request.circular !== true) {
      return fail('WRAP_NOT_CIRCULAR', 'wraps: true is only valid for a circular chromosome.', {
        start0,
        end0,
      });
    }
    if (end0 >= start0) {
      return fail(
        'WRAP_REQUIRES_ORIGIN_CROSSING',
        `wraps: true requires start0 after end0 (got ${start0}-${end0}).`,
        { start0, end0 }
      );
    }
    if (
      request.operation === 'search' ||
      request.operation === 'read_spliced' ||
      request.operation === 'translate_spliced'
    ) {
      return fail(
        'WRAP_UNSUPPORTED_OPERATION',
        `wraps: true is not supported for ${request.operation}. Split the origin-crossing interval into two linear requests.`,
        { start0, end0 }
      );
    }
  } else if (end0 < start0) {
    return fail(
      'REVERSED_INTERVAL',
      `Interval is reversed (0-based half-open ${start0}-${end0}).`,
      { start0, end0 }
    );
  } else if (end0 === start0) {
    return fail('EMPTY_INTERVAL', `Interval ${start0}-${end0} is empty.`, { start0, end0 });
  }

  const linearLength = request.wraps ? null : end0 - start0;
  if (
    (request.operation === 'read_spliced' || request.operation === 'translate_spliced') &&
    linearLength !== null &&
    linearLength > REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP
  ) {
    return fail(
      'OVER_LIMIT',
      `Feature window is ${linearLength} bp; interactive ${request.operation} is capped at ${REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP} bp.`,
      {
        start0,
        end0,
        requestedLength: linearLength,
        maxWindowBp: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP,
      }
    );
  }
  if (
    needsInlineReferenceIntervalBases(request.operation) &&
    linearLength !== null &&
    linearLength > REFERENCE_INTERVAL_MAX_INLINE_BP
  ) {
    return fail(
      'OVER_LIMIT',
      `Interval is ${linearLength} bp; interactive ${request.operation} is capped at ${REFERENCE_INTERVAL_MAX_INLINE_BP} bp.`,
      {
        start0,
        end0,
        requestedLength: linearLength,
        maxInlineBp: REFERENCE_INTERVAL_MAX_INLINE_BP,
      }
    );
  }
  return null;
}

function needsInlineReferenceIntervalBases(operation: ReferenceIntervalOperation): boolean {
  return (
    operation === 'read' ||
    operation === 'reverse_complement' ||
    operation === 'translate' ||
    operation === 'extract'
  );
}

async function resolveReferenceIntervalChromosomeLength(args: {
  source: GenomeDataSource;
  request: ReferenceIntervalRequest;
  identity: ReferenceIntervalSourceIdentity;
  start0: number;
  end0: number;
}): Promise<
  { ok: true; chromosomeLength: number; requestedLength: number } | ReferenceIntervalFailure
> {
  const { source, request, identity, start0, end0 } = args;
  let chromosomeLength: number;
  try {
    throwIfAborted(request.signal);
    chromosomeLength = await source.getChromosomeLength(request.chrom);
    throwIfAborted(request.signal);
  } catch (err) {
    const cancelledResult = cancellationFrom(err, request.signal);
    if (cancelledResult) return cancelledResult;
    if (isInvalidGenomeSequenceError(err)) {
      return fail('INVALID_SOURCE', err.message);
    }
    if (err instanceof ReferenceIntervalSourceUnavailableError) {
      return fail('MISSING_SOURCE', err.message);
    }
    if (isMissingChromosomeError(err, request.chrom)) {
      return fail(
        'MISSING_CHROMOSOME',
        `Chromosome ${request.chrom} was not found in ${identity.sourceId}.`,
        { chrom: request.chrom }
      );
    }
    throw err;
  }

  if (!Number.isSafeInteger(chromosomeLength) || chromosomeLength < 0) {
    return fail(
      'INVALID_SOURCE',
      'Indexed reference reported an invalid chromosome length; expected a nonnegative safe integer.'
    );
  }

  if (start0 > chromosomeLength || end0 > chromosomeLength) {
    return fail(
      'OUT_OF_BOUNDS',
      `Interval ${start0}-${end0} exceeds chromosome ${request.chrom} length ${chromosomeLength}.`,
      { chrom: request.chrom, start0, end0, chromosomeLength }
    );
  }
  if (request.wraps && start0 >= chromosomeLength) {
    return fail(
      'OUT_OF_BOUNDS',
      `Wrap start ${start0} is not inside chromosome length ${chromosomeLength}.`,
      { chrom: request.chrom, start0, end0, chromosomeLength }
    );
  }

  const requestedLength = request.wraps ? chromosomeLength - start0 + end0 : end0 - start0;
  if (
    needsInlineReferenceIntervalBases(request.operation) &&
    requestedLength > REFERENCE_INTERVAL_MAX_INLINE_BP
  ) {
    return fail(
      'OVER_LIMIT',
      `Interval is ${requestedLength} bp; interactive ${request.operation} is capped at ${REFERENCE_INTERVAL_MAX_INLINE_BP} bp.`,
      {
        start0,
        end0,
        requestedLength,
        maxInlineBp: REFERENCE_INTERVAL_MAX_INLINE_BP,
      }
    );
  }
  return { ok: true, chromosomeLength, requestedLength };
}

export async function runReferenceIntervalAction(
  source: GenomeDataSource | null,
  request: ReferenceIntervalRequest,
  identity: ReferenceIntervalSourceIdentity
): Promise<ReferenceIntervalResult> {
  const rejected = rejectInvalidReferenceIntervalRequest(source, request, identity);
  if (rejected) return rejected;
  if (!source) {
    return fail('MISSING_SOURCE', 'No indexed reference source was resolved for this request.');
  }
  const start0 = request.start0;
  const end0 = request.end0;

  const chromosome = await resolveReferenceIntervalChromosomeLength({
    source,
    request,
    identity,
    start0,
    end0,
  });
  if (!chromosome.ok) return chromosome;
  const { chromosomeLength, requestedLength } = chromosome;

  const interval: ReferenceIntervalCoordinates = {
    chrom: request.chrom,
    start0,
    end0,
    strand: request.strand,
    length: requestedLength,
    ...(request.wraps ? { wraps: true } : {}),
  };
  const provenanceBase: ReferenceIntervalProvenance = {
    sourceId: identity.sourceId,
    ...(identity.fastaPath ? { fastaPath: identity.fastaPath } : {}),
    ...(identity.assemblyId ? { assemblyId: identity.assemblyId } : {}),
    ...(identity.fingerprint ? { sourceFingerprint: identity.fingerprint } : {}),
    chrom: request.chrom,
    start0,
    end0,
    strand: request.strand,
    chromosomeLength,
    requestedLength,
    ...(request.wraps ? { wraps: true } : {}),
  };

  try {
    switch (request.operation) {
      case 'read':
      case 'reverse_complement':
      case 'translate':
      case 'extract':
        return await runInlineSequence(source, request, interval, provenanceBase);
      case 'read_spliced':
        return await runSplicedSequence(source, request, interval, provenanceBase);
      case 'translate_spliced':
        return await runSplicedTranslation(source, request, interval, provenanceBase);
      case 'search':
        return await runSearch(source, request, interval, provenanceBase);
      default:
        return fail('INVALID_OPERATION', `Unsupported operation ${String(request.operation)}.`);
    }
  } catch (err) {
    const cancelledResult = cancellationFrom(err, request.signal);
    if (cancelledResult) return cancelledResult;
    if (isInvalidGenomeSequenceError(err)) {
      return fail('INVALID_SOURCE', err.message);
    }
    if (err instanceof ReferenceIntervalSourceUnavailableError) {
      return fail('MISSING_SOURCE', err.message);
    }
    if (isMissingChromosomeError(err, request.chrom)) {
      return fail(
        'MISSING_CHROMOSOME',
        `Chromosome ${request.chrom} was not found in ${identity.sourceId}.`,
        { chrom: request.chrom }
      );
    }
    throw err;
  }
}

async function fetchForwardSequence(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  chromosomeLength: number
): Promise<string> {
  if (request.wraps) {
    const tail = validateSequencePayload(
      await source.getSequence(request.chrom, request.start0, chromosomeLength, {
        signal: request.signal,
      }),
      chromosomeLength - request.start0
    );
    throwIfAborted(request.signal);
    const head = validateSequencePayload(
      await source.getSequence(request.chrom, 0, request.end0, {
        signal: request.signal,
      }),
      request.end0
    );
    throwIfAborted(request.signal);
    return tail + head;
  }
  const forward = validateSequencePayload(
    await source.getSequence(request.chrom, request.start0, request.end0, {
      signal: request.signal,
    }),
    request.end0 - request.start0
  );
  throwIfAborted(request.signal);
  return forward;
}

async function runInlineSequence(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  interval: ReferenceIntervalCoordinates,
  provenanceBase: ReferenceIntervalProvenance
): Promise<ReferenceIntervalResult> {
  const forward = await fetchForwardSequence(source, request, provenanceBase.chromosomeLength);
  const minus = request.strand === '-';
  const sequence =
    request.operation === 'reverse_complement' || (request.operation === 'extract' && minus)
      ? reverseComplement(forward)
      : forward;
  const provenance = {
    ...provenanceBase,
    sequenceFingerprint: fnv1a32(sequence),
  };

  if (request.operation === 'extract') {
    return {
      ok: true,
      operation: 'extract',
      interval,
      provenance,
      derived: {
        sequence,
        topology: request.wraps ? 'circular-origin-span' : 'linear',
        wraps: request.wraps === true,
      },
    };
  }

  if (request.operation === 'translate') {
    return {
      ok: true,
      operation: 'translate',
      interval,
      provenance,
      translations: sixFrameTranslations(forward),
    };
  }

  return {
    ok: true,
    operation: request.operation,
    interval,
    provenance,
    sequence,
  };
}

function sixFrameTranslations(forward: string): ReferenceIntervalTranslation[] {
  const reverse = reverseComplement(forward);
  const rows: ReferenceIntervalTranslation[] = [];
  for (const [strand, dna] of [
    ['+', forward],
    ['-', reverse],
  ] as const) {
    for (const frame of [0, 1, 2] as const) {
      const codons = translateSequence(dna, 1, frame);
      const protein = codons.map((codon) => codon.aminoAcid).join('');
      const remaining = Math.max(0, dna.length - frame);
      rows.push({
        strand,
        frame,
        protein,
        codonCount: codons.length,
        incompleteCodon: remaining % 3 !== 0,
      });
    }
  }
  return rows;
}

async function runSplicedSequence(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  interval: ReferenceIntervalCoordinates,
  provenanceBase: ReferenceIntervalProvenance
): Promise<ReferenceIntervalResult> {
  let featureId = request.featureId;
  if (!featureId) {
    const intervalFeatures = await source.getFeatures(
      request.chrom,
      request.start0,
      request.end0,
      1,
      { signal: request.signal }
    );
    throwIfAborted(request.signal);
    const candidates = intervalFeatures.filter(isTranscriptFeature);
    if (candidates.length === 0) {
      return fail(
        'NO_TRANSCRIPT_SEGMENTS',
        `No transcript feature overlaps ${request.chrom}:${request.start0}-${request.end0}.`,
        { chrom: request.chrom, start0: request.start0, end0: request.end0 }
      );
    }
    const candidateIds = [...new Set(candidates.flatMap((feature) => feature.attributes.ID ?? []))];
    if (candidateIds.length !== 1) {
      return fail(
        'AMBIGUOUS_FEATURE',
        'Multiple transcripts overlap this interval. Pass featureId to choose one.',
        { chrom: request.chrom, start0: request.start0, end0: request.end0 }
      );
    }
    featureId = candidateIds[0];
  }
  if (!featureId) {
    return fail('MISSING_FEATURE', 'The selected transcript has no stable feature identifier.');
  }
  const selectedFeatureId = featureId;

  const loaded = await loadFeatureClosure(source, request, selectedFeatureId);
  if (loaded.ok === false) return loaded;
  const primary = loaded.features.find(
    (feature) =>
      (feature.attributes.ID ?? []).includes(selectedFeatureId) && isTranscriptFeature(feature)
  );
  if (!primary) {
    return fail(
      'NO_TRANSCRIPT_SEGMENTS',
      `Feature ${selectedFeatureId} is not a transcript with extractable exon structure.`,
      { featureId: selectedFeatureId }
    );
  }

  const transcriptIds = new Set([selectedFeatureId, ...(primary.attributes.ID ?? [])]);
  const directChildren = loaded.features.filter(
    (feature) =>
      feature !== primary &&
      (feature.attributes.Parent ?? []).some((parent) => transcriptIds.has(parent))
  );
  const exons = directChildren.filter(isExonFeature);
  const inferredSegments = inferCompleteTranscriptSegments(primary, directChildren);
  const segments = exons.length > 0 ? exons : inferredSegments;
  if (segments.length === 0) {
    return fail(
      'NO_TRANSCRIPT_SEGMENTS',
      `Transcript ${selectedFeatureId} has no complete exon or CDS/UTR structure.`,
      { featureId: selectedFeatureId }
    );
  }
  return finishSplicedSequence(
    source,
    request,
    interval,
    provenanceBase,
    segments,
    selectedFeatureId,
    provenanceBase.chromosomeLength
  );
}

async function finishSplicedSequence(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  interval: ReferenceIntervalCoordinates,
  provenanceBase: ReferenceIntervalProvenance,
  segmentFeatures: GenomeFeature[],
  featureId: string,
  chromosomeLength: number
): Promise<ReferenceIntervalResult> {
  const sorted = segmentFeatures.slice().sort((left, right) => left.start - right.start);
  const invalidGeometry = invalidSplicedGeometry(
    sorted,
    request.chrom,
    chromosomeLength,
    'transcript'
  );
  if (invalidGeometry) return fail('INVALID_SOURCE', invalidGeometry, { featureId });
  const featureStrands = new Set(sorted.map((feature) => feature.strand));
  if (
    featureStrands.size !== 1 ||
    (sorted[0]?.strand !== '+' && sorted[0]?.strand !== '-') ||
    sorted[0].strand !== request.strand
  ) {
    return fail(
      'INVALID_STRAND',
      `Requested strand ${request.strand} does not match the selected transcript strand.`,
      { featureId }
    );
  }
  const length = sorted.reduce((sum, feature) => sum + (feature.end - feature.start), 0);
  if (!Number.isSafeInteger(length)) {
    return fail('INVALID_SOURCE', 'Selected transcript length is outside the safe integer range.', {
      featureId,
    });
  }
  if (length > REFERENCE_INTERVAL_MAX_INLINE_BP) {
    return fail(
      'OVER_LIMIT',
      `Spliced transcript is ${length} bp; interactive read_spliced is capped at ${REFERENCE_INTERVAL_MAX_INLINE_BP} bp.`,
      {
        requestedLength: length,
        maxInlineBp: REFERENCE_INTERVAL_MAX_INLINE_BP,
        featureId,
      }
    );
  }

  const strand: ReferenceIntervalStrand = sorted[0]?.strand === '-' ? '-' : '+';
  const ordered = strand === '-' ? sorted.slice().reverse() : sorted;
  const pieces: string[] = [];
  for (const feature of ordered) {
    throwIfAborted(request.signal);
    const piece = validateSequencePayload(
      await source.getSequence(feature.chrom, feature.start, feature.end, {
        signal: request.signal,
      }),
      feature.end - feature.start
    );
    pieces.push(strand === '-' ? reverseComplement(piece) : piece);
  }
  const sequence = pieces.join('');

  return {
    ok: true,
    operation: 'read_spliced',
    interval,
    provenance: {
      ...provenanceBase,
      sequenceFingerprint: fnv1a32(sequence),
    },
    splicedSequence: {
      sequence,
      length,
      featureId,
      segments: sorted.map((feature) => ({
        start0: feature.start,
        end0: feature.end,
        strand,
      })),
    },
  };
}

async function runSplicedTranslation(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  interval: ReferenceIntervalCoordinates,
  provenanceBase: ReferenceIntervalProvenance
): Promise<ReferenceIntervalResult> {
  const intervalFeatures = await source.getFeatures(
    request.chrom,
    request.start0,
    request.end0,
    1,
    { signal: request.signal }
  );
  throwIfAborted(request.signal);
  const intervalCds = intervalFeatures.filter((feature) => feature.type.toUpperCase() === 'CDS');

  if (request.featureId) {
    const overlapping = selectCdsForFeature(intervalFeatures, intervalCds, request.featureId);
    if (overlapping === 'missing') {
      return fail(
        'MISSING_FEATURE',
        `No feature ${request.featureId} was found in ${request.chrom}:${request.start0}-${request.end0}.`,
        {
          featureId: request.featureId,
          chrom: request.chrom,
          start0: request.start0,
          end0: request.end0,
        }
      );
    }
    if (overlapping === 'ambiguous') {
      return fail(
        'AMBIGUOUS_FEATURE',
        `CDS feature ${request.featureId} belongs to multiple transcripts. Pass one transcript ID instead.`,
        { featureId: request.featureId }
      );
    }
    if (overlapping.length === 0) {
      return fail(
        'NO_CODING_SEGMENTS',
        `Feature ${request.featureId} has no CDS segments in the requested interval.`,
        { featureId: request.featureId }
      );
    }
    const loaded = await loadFeatureClosure(source, request, request.featureId);
    if (loaded.ok === false) return loaded;
    const closureCds = loaded.features.filter((feature) => feature.type.toUpperCase() === 'CDS');
    const matching = selectCdsForFeature(loaded.features, closureCds, request.featureId);
    if (matching === 'ambiguous') {
      return fail(
        'AMBIGUOUS_FEATURE',
        `CDS feature ${request.featureId} belongs to multiple transcripts. Pass one transcript ID instead.`,
        { featureId: request.featureId }
      );
    }
    if (matching === 'missing' || matching.length === 0) {
      return fail(
        'NO_CODING_SEGMENTS',
        `Feature ${request.featureId} has no complete CDS closure.`,
        { featureId: request.featureId }
      );
    }
    return finishSpliced(
      source,
      request,
      interval,
      provenanceBase,
      matching,
      loaded.features,
      request.featureId,
      provenanceBase.chromosomeLength
    );
  }

  const groups = groupCds(intervalCds);
  if (groups.length === 0) {
    return fail(
      'NO_CODING_SEGMENTS',
      `No CDS features overlap ${request.chrom}:${request.start0}-${request.end0}.`,
      { chrom: request.chrom, start0: request.start0, end0: request.end0 }
    );
  }
  if (groups.length > 1) {
    return fail(
      'AMBIGUOUS_FEATURE',
      `Multiple CDS groups overlap this interval. Pass featureId to choose one.`,
      { chrom: request.chrom, start0: request.start0, end0: request.end0 }
    );
  }
  const selected = groups[0];
  const loaded = await loadFeatureClosure(source, request, selected.id);
  if (loaded.ok === false) return loaded;
  const closureCds = loaded.features.filter((feature) => feature.type.toUpperCase() === 'CDS');
  const matching = selectCdsForFeature(loaded.features, closureCds, selected.id);
  if (matching === 'ambiguous') {
    return fail(
      'AMBIGUOUS_FEATURE',
      `CDS feature ${selected.id} belongs to multiple transcripts. Pass one transcript ID instead.`,
      { featureId: selected.id }
    );
  }
  if (matching === 'missing' || matching.length === 0) {
    return fail('NO_CODING_SEGMENTS', `Feature ${selected.id} has no complete CDS closure.`, {
      featureId: selected.id,
    });
  }
  return finishSpliced(
    source,
    request,
    interval,
    provenanceBase,
    matching,
    loaded.features,
    selected.id,
    provenanceBase.chromosomeLength
  );
}

async function finishSpliced(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  interval: ReferenceIntervalCoordinates,
  provenanceBase: ReferenceIntervalProvenance,
  cdsFeatures: GenomeFeature[],
  closureFeatures: GenomeFeature[],
  featureId: string | undefined,
  chromosomeLength: number
): Promise<ReferenceIntervalResult> {
  const sorted = cdsFeatures.slice().sort((left, right) => left.start - right.start);
  const invalidGeometry = invalidCdsGeometry(sorted, request.chrom, chromosomeLength);
  if (invalidGeometry) {
    return fail('INVALID_SOURCE', invalidGeometry, featureId ? { featureId } : undefined);
  }
  const featureStrands = new Set(sorted.map((feature) => feature.strand));
  if (
    featureStrands.size !== 1 ||
    (sorted[0]?.strand !== '+' && sorted[0]?.strand !== '-') ||
    sorted[0].strand !== request.strand
  ) {
    return fail(
      'INVALID_STRAND',
      `Requested strand ${request.strand} does not match the selected CDS strand.`,
      featureId ? { featureId } : undefined
    );
  }
  const codingLength = sorted.reduce((sum, feature) => sum + (feature.end - feature.start), 0);
  if (!Number.isSafeInteger(codingLength)) {
    return fail(
      'INVALID_SOURCE',
      'Selected CDS has a coding length outside the safe integer range.',
      featureId ? { featureId } : undefined
    );
  }
  if (codingLength > REFERENCE_INTERVAL_MAX_INLINE_BP) {
    return fail(
      'OVER_LIMIT',
      `Spliced CDS is ${codingLength} bp; interactive translate_spliced is capped at ${REFERENCE_INTERVAL_MAX_INLINE_BP} bp.`,
      { requestedLength: codingLength, maxInlineBp: REFERENCE_INTERVAL_MAX_INLINE_BP }
    );
  }

  const strand: ReferenceIntervalStrand = sorted[0]?.strand === '-' ? '-' : '+';
  const ordered = strand === '-' ? sorted.slice().reverse() : sorted;
  const phases = ordered.map((feature) => parsePhase(feature.phase));
  const frameOffset = phases[0];
  if (frameOffset === undefined || frameOffset === null || phases.some((phase) => phase === null)) {
    return fail(
      'INVALID_SOURCE',
      'Selected CDS has a missing or invalid GFF phase; phase-aware translation requires 0, 1, or 2 on every CDS segment.',
      featureId ? { featureId } : undefined
    );
  }
  const phasesConsistent = phasesAreFrameConsistent(
    ordered,
    phases as Array<0 | 1 | 2>,
    frameOffset
  );
  const phaseSource: ReferenceIntervalSplicedTranslation['phaseSource'] = phasesConsistent
    ? 'source'
    : 'derived';
  if (!phasesConsistent && phases.some((phase) => phase !== 0)) {
    return fail(
      'INVALID_SOURCE',
      'Selected CDS has frame-inconsistent GFF phases across its coding segments.',
      featureId ? { featureId } : undefined
    );
  }
  if (hasUnsupportedTranslationException(cdsFeatures, closureFeatures)) {
    return fail(
      'INVALID_SOURCE',
      'Selected CDS declares transl_except; translate_spliced does not yet support codon-level translation exceptions.',
      featureId ? { featureId } : undefined
    );
  }
  const geneticCode = declaredGeneticCode(cdsFeatures, closureFeatures);
  if (geneticCode !== 1) {
    const reason =
      geneticCode === 'invalid' ? 'invalid or conflicting' : `unsupported table ${geneticCode}`;
    return fail(
      'INVALID_SOURCE',
      `Selected CDS has an ${reason} NCBI genetic-code declaration; translate_spliced currently supports only table 1.`,
      featureId ? { featureId } : undefined
    );
  }
  const pieces: string[] = [];
  for (const feature of ordered) {
    throwIfAborted(request.signal);
    const piece = validateSequencePayload(
      await source.getSequence(feature.chrom, feature.start, feature.end, {
        signal: request.signal,
      }),
      feature.end - feature.start
    );
    pieces.push(strand === '-' ? reverseComplement(piece) : piece);
  }

  const codingDna = pieces.join('');
  const framed = codingDna.slice(frameOffset);
  const remaining = framed.length;
  const codons = translateSequence(codingDna, 1, frameOffset);
  let protein = codons.map((codon) => codon.aminoAcid).join('');
  const hadTrailingStop = protein.endsWith('*');
  if (hadTrailingStop) protein = protein.slice(0, -1);
  if (phaseSource === 'derived' && protein.includes('*')) {
    return fail(
      'INVALID_SOURCE',
      'Selected CDS has no usable GFF phases in this annotation source, and reading it from its first coding base gives an internal stop codon, so its reading frame cannot be determined.',
      featureId ? { featureId } : undefined
    );
  }

  const spliced: ReferenceIntervalSplicedTranslation = {
    protein,
    codingLength,
    frameOffset,
    incompleteCodon: remaining % 3 !== 0,
    hadTrailingStop,
    phaseSource,
    ...(featureId ? { featureId } : {}),
    segments: sorted.map((feature) => ({
      start0: feature.start,
      end0: feature.end,
      strand: feature.strand === '-' ? '-' : '+',
    })),
  };

  return {
    ok: true,
    operation: 'translate_spliced',
    interval,
    provenance: {
      ...provenanceBase,
      sequenceFingerprint: fnv1a32(codingDna),
    },
    spliced,
  };
}

async function runSearch(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  interval: ReferenceIntervalCoordinates,
  provenanceBase: ReferenceIntervalProvenance
): Promise<ReferenceIntervalResult> {
  const motif = request.motif ?? '';
  if (!motifToRegex(motif)) {
    return fail('INVALID_MOTIF', `Motif ${JSON.stringify(motif)} is empty or not IUPAC DNA.`);
  }
  const maxResults = clampSearchLimit(request.maxResults);
  const searchHits: Array<Omit<SearchHit, 'chrom' | 'motif'>> = [];
  for await (const hit of source.searchSequence(request.chrom, motif, {
    start: request.start0,
    end: request.end0,
    maxResults,
    reverseComplement: true,
    validateIupacDna: true,
    signal: request.signal,
  })) {
    throwIfAborted(request.signal);
    if (searchHits.length < maxResults) {
      searchHits.push({ start: hit.start, end: hit.end, strand: hit.strand });
    }
  }
  const searchTruncated = await hasAdditionalSearchHit(source, request, motif, searchHits);
  return {
    ok: true,
    operation: 'search',
    interval,
    provenance: provenanceBase,
    searchMotif: motif,
    searchHits,
    searchTruncated,
  };
}

async function hasAdditionalSearchHit(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  motif: string,
  searchHits: Array<Omit<SearchHit, 'chrom' | 'motif'>>
): Promise<boolean> {
  const maxResults = clampSearchLimit(request.maxResults);
  if (searchHits.length < maxResults) return false;
  const lastHit = searchHits[searchHits.length - 1];
  if (!lastHit) return false;

  const probeStart = lastHit.start + 1;
  if (probeStart >= request.end0) return false;
  for await (const _hit of source.searchSequence(request.chrom, motif, {
    start: probeStart,
    end: request.end0,
    maxResults: 1,
    reverseComplement: true,
    signal: request.signal,
  })) {
    throwIfAborted(request.signal);
    return true;
  }
  return false;
}

async function loadFeatureClosure(
  source: GenomeDataSource,
  request: ReferenceIntervalRequest,
  featureId: string
): Promise<{ ok: true; features: GenomeFeature[] } | ReferenceIntervalFailure> {
  if (source.getFeatureDetails) {
    const details = await source.getFeatureDetails(
      {
        chrom: request.chrom,
        start: request.start0,
        end: request.end0,
        featureId,
        maxWindowBp: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP,
      },
      { signal: request.signal }
    );
    if (details.truncated) {
      return fail(
        'OVER_LIMIT',
        `Feature closure exceeds the ${REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP} bp spliced-action window.`,
        {
          start0: request.start0,
          end0: request.end0,
          maxWindowBp: REFERENCE_INTERVAL_MAX_FEATURE_WINDOW_BP,
          featureId,
        }
      );
    }
    const collected = [...details.relatedFeatures];
    if (details.feature) collected.push(details.feature);
    return { ok: true, features: dedupeFeatures(collected) };
  }
  return fail(
    'INVALID_SOURCE',
    'The indexed annotation source cannot provide a complete feature closure for spliced actions.',
    { featureId }
  );
}

function isTranscriptFeature(feature: GenomeFeature): boolean {
  const type = feature.type.trim().toLowerCase().replace(/-/g, '_');
  return (
    type === 'transcript' || type.endsWith('_transcript') || type === 'mrna' || type.endsWith('rna')
  );
}

function isExonFeature(feature: GenomeFeature): boolean {
  return feature.type.trim().toLowerCase().replace(/-/g, '_').endsWith('exon');
}

function isTranscriptCoverageFeature(feature: GenomeFeature): boolean {
  const type = feature.type.trim().toLowerCase().replace(/-/g, '_');
  return type === 'cds' || type === 'utr' || type.endsWith('_utr');
}

function inferCompleteTranscriptSegments(
  transcript: GenomeFeature,
  directChildren: GenomeFeature[]
): GenomeFeature[] {
  if (directChildren.length === 0) return [transcript];

  const coverage = directChildren
    .filter(isTranscriptCoverageFeature)
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (coverage.length === 0) return [];

  const merged: GenomeFeature[] = [];
  for (const feature of coverage) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      feature.chrom === previous.chrom &&
      feature.strand === previous.strand &&
      feature.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, feature.end);
      continue;
    }
    merged.push({ ...feature });
  }

  if (merged[0]?.start !== transcript.start || merged[merged.length - 1]?.end !== transcript.end) {
    return [];
  }
  return merged;
}

function invalidSplicedGeometry(
  sorted: GenomeFeature[],
  chrom: string,
  chromosomeLength: number,
  label: 'CDS' | 'transcript'
): string | null {
  if (sorted.length === 0) return `Selected ${label} has no segments.`;
  let previousEnd = -1;
  for (const feature of sorted) {
    if (
      feature.chrom !== chrom ||
      !Number.isSafeInteger(feature.start) ||
      !Number.isSafeInteger(feature.end) ||
      feature.start < 0 ||
      feature.end <= feature.start ||
      feature.end > chromosomeLength
    ) {
      return `Selected ${label} contains a malformed, foreign-chromosome, or out-of-bounds segment.`;
    }
    if (feature.start < previousEnd) {
      return `Selected ${label} contains overlapping ${label === 'CDS' ? 'coding' : 'exon'} segments.`;
    }
    previousEnd = feature.end;
  }
  return null;
}

function invalidCdsGeometry(
  sorted: GenomeFeature[],
  chrom: string,
  chromosomeLength: number
): string | null {
  const invalid = invalidSplicedGeometry(sorted, chrom, chromosomeLength, 'CDS');
  return invalid === 'Selected CDS has no segments.'
    ? 'Selected CDS has no coding segments.'
    : invalid;
}

function selectCdsForFeature(
  allFeatures: GenomeFeature[],
  cdsFeatures: GenomeFeature[],
  featureId: string
): GenomeFeature[] | 'missing' | 'ambiguous' {
  const idMatches = (feature: GenomeFeature): boolean =>
    (feature.attributes.ID ?? []).includes(featureId);
  const parentMatches = (feature: GenomeFeature): boolean =>
    (feature.attributes.Parent ?? []).includes(featureId);
  const primary = allFeatures.find(idMatches) ?? cdsFeatures.find(idMatches);
  const relatedIds = new Set<string>([featureId]);
  if (primary) {
    for (const id of primary.attributes.ID ?? []) relatedIds.add(id);
    if (primary.type.toUpperCase() === 'CDS') {
      const parentIds = [...new Set(primary.attributes.Parent ?? [])];
      if (parentIds.length > 1) return 'ambiguous';
      for (const parentId of parentIds) relatedIds.add(parentId);
    }
  }
  const selected = cdsFeatures.filter(
    (feature) =>
      idMatches(feature) ||
      parentMatches(feature) ||
      (feature.attributes.Parent ?? []).some((parent) => relatedIds.has(parent))
  );
  if (!primary && selected.length === 0) return 'missing';
  return selected;
}

function groupCds(cdsFeatures: GenomeFeature[]): Array<{ id: string; features: GenomeFeature[] }> {
  const groups = new Map<string, GenomeFeature[]>();
  for (const feature of cdsFeatures) {
    const parentIds = feature.attributes.Parent ?? [];
    const featureIds = feature.attributes.ID ?? [];
    const groupIds = parentIds.length > 0 ? parentIds : featureIds;
    const ids = groupIds.length > 0 ? groupIds : [`${feature.start}:${feature.end}`];
    for (const id of new Set(ids)) {
      const existing = groups.get(id);
      if (existing) existing.push(feature);
      else groups.set(id, [feature]);
    }
  }
  return [...groups.entries()].map(([id, features]) => ({ id, features }));
}

function parsePhase(phase: string | null | undefined): 0 | 1 | 2 | null {
  if (phase === '0') return 0;
  if (phase === '1') return 1;
  if (phase === '2') return 2;
  return null;
}

function phasesAreFrameConsistent(
  ordered: GenomeFeature[],
  phases: Array<0 | 1 | 2>,
  frameOffset: 0 | 1 | 2
): boolean {
  const first = ordered[0];
  if (!first) return false;
  let accumulatedCodingBp = first.end - first.start - frameOffset;
  if (accumulatedCodingBp < 0) return false;

  for (let index = 1; index < ordered.length; index += 1) {
    const expectedPhase = ((3 - (accumulatedCodingBp % 3)) % 3) as 0 | 1 | 2;
    if (phases[index] !== expectedPhase) return false;
    accumulatedCodingBp += ordered[index].end - ordered[index].start;
  }
  return true;
}

function selectedTranslationFeatures(
  cdsFeatures: GenomeFeature[],
  closureFeatures: GenomeFeature[]
): GenomeFeature[] {
  const transcriptIds = new Set(cdsFeatures.flatMap((feature) => feature.attributes.Parent ?? []));
  const transcriptFeatures = closureFeatures.filter((feature) =>
    (feature.attributes.ID ?? []).some((id) => transcriptIds.has(id))
  );
  return [...cdsFeatures, ...transcriptFeatures];
}

function hasUnsupportedTranslationException(
  cdsFeatures: GenomeFeature[],
  closureFeatures: GenomeFeature[]
): boolean {
  return selectedTranslationFeatures(cdsFeatures, closureFeatures).some((feature) =>
    (feature.attributes.transl_except ?? []).some((value) => value.trim().length > 0)
  );
}

function declaredGeneticCode(
  cdsFeatures: GenomeFeature[],
  closureFeatures: GenomeFeature[]
): 1 | number | 'invalid' {
  const declarations = selectedTranslationFeatures(cdsFeatures, closureFeatures)
    .flatMap((feature) => feature.attributes.transl_table ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (declarations.length === 0) return 1;
  if (declarations.some((value) => !/^[1-9]\d*$/.test(value))) return 'invalid';
  const codes = declarations.map(Number);
  if (codes.some((value) => !Number.isSafeInteger(value))) return 'invalid';
  const unique = [...new Set(codes)];
  return unique.length === 1 ? unique[0] : 'invalid';
}

function clampSearchLimit(requested: number | undefined): number {
  if (requested === undefined) return REFERENCE_INTERVAL_MAX_SEARCH_RESULTS;
  if (!Number.isFinite(requested) || requested <= 0) return REFERENCE_INTERVAL_MAX_SEARCH_RESULTS;
  return Math.min(Math.trunc(requested), REFERENCE_INTERVAL_MAX_SEARCH_RESULTS);
}

function fail(
  code: ReferenceIntervalErrorCode,
  error: string,
  details?: ReferenceIntervalFailure['details']
): ReferenceIntervalFailure {
  return details ? { ok: false, code, error, details } : { ok: false, code, error };
}

function cancelled(): ReferenceIntervalFailure {
  return fail('CANCELLED', 'The reference-interval request was cancelled.');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new DOMException('Genome data request aborted', 'AbortError');
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError'
  );
}

function cancellationFrom(
  err: unknown,
  signal: AbortSignal | undefined
): ReferenceIntervalFailure | null {
  if (isAbortError(err) || signal?.aborted) return cancelled();
  return null;
}

function isMissingChromosomeError(err: unknown, chrom: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(chrom) && /not found/i.test(message);
}

function dedupeFeatures(features: GenomeFeature[]): GenomeFeature[] {
  const seen = new Set<string>();
  const out: GenomeFeature[] = [];
  for (const feature of features) {
    const key = `${feature.chrom}:${feature.type}:${feature.start}:${feature.end}:${feature.attributes.ID?.[0] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(feature);
  }
  return out;
}

function validateSequencePayload(sequence: string, expectedLength: number): string {
  return validateIupacSequencePayload(sequence, expectedLength);
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
