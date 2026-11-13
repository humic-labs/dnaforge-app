import {
  alignedReadReferenceGenerationKey,
  alignedReadSourceGenerationKey,
  formatInputUri,
  parseTrackAdmissionRequestV1,
  trackAdmissionRequestLabel,
  type AdmittedTrackSource,
  type LocalFileTrackSourceV1,
  type ReferenceCompatibilityReceipt,
  type TrackAssetLocatorV1,
  type TrackAdmissionRequestV1,
  type TrackSourceAddressV1,
} from '@waypoint/genome-data';
import { computeChecksum } from '@waypoint/sequence-utils';

import { platform } from '../../platform';
import {
  readAlignmentHeader,
  requireExactAlignmentReferenceMatch,
  requireReadableAlignmentIndex,
  type AlignmentReferenceIdentity,
} from './alignment-header-client';
import {
  startAlignmentIndexOperation,
  waitForAlignmentIndexResult,
} from './alignment-index-operation-client';
import {
  captureAlignedReadReferenceGeneration,
  captureAlignedReadSourceGeneration,
} from './aligned-read-source-generation';
import { referenceSignature } from './bbi-reference-compatibility';
import {
  admitIndexedRangeSource,
  indexedRangeSourceFromTrackLocator,
  indexedRangeSourceResourceName,
  materializeIndexedRangeSource,
  nativeRangeProxyUrl,
  type IndexedRangeGrant,
} from './indexed-range-client';
import type { PileupSource } from './pileup-source';
import { prepareHtsgetRuntime } from './htsget-client';

export interface AlignedReadAdmissionProgress {
  readonly phase: 'checking-index' | 'validating-assembly' | 'validating-reference';
  readonly label: string;
  readonly stepNumber: 1 | 2 | 3;
}

export interface AlignedReadRuntimeAdmission {
  readonly source: PileupSource;
  readonly grantExpiresAtMs: number;
}

export async function admitAlignedReadTrackRequest(input: {
  readonly request: TrackAdmissionRequestV1;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly assemblyDisplayName?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AlignedReadAdmissionProgress) => void;
  readonly onRuntimeReady?: (runtime: AlignedReadRuntimeAdmission) => void;
  readonly resolveLocalCramReference?: (
    request: TrackAdmissionRequestV1
  ) => Promise<LocalFileTrackSourceV1 | null>;
}): Promise<AdmittedTrackSource> {
  const parsed = parseTrackAdmissionRequestV1(input.request);
  const formatId = requireAlignedReadFormat(parsed.formatId);
  if (parsed.scientificKind !== undefined && parsed.scientificKind !== 'reads') {
    throw new Error(`${formatName(formatId)} cannot be admitted as ${parsed.scientificKind}.`);
  }
  if (input.assemblyReferences.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this track.');
  }
  if (
    parsed.source.kind === 'http' ||
    parsed.source.kind === 's3' ||
    parsed.source.kind === 'gcs'
  ) {
    return admitRemoteAlignedReadTrack({ ...input, request: parsed }, formatId);
  }
  if (parsed.source.kind === 'htsget') {
    return admitHtsgetAlignedReadTrack({ ...input, request: parsed }, formatId);
  }
  if (parsed.source.kind !== 'local-file') {
    throw new Error(
      `${formatName(formatId)} source kind ${parsed.source.kind} is not implemented.`
    );
  }
  const indexLocator = requireOptionalLocalCompanion(parsed.index, 'index');
  let referenceLocator = requireOptionalLocalCompanion(parsed.reference, 'reference');
  if (formatId === 'bam' && referenceLocator) {
    throw new Error('BAM does not accept a reference FASTA companion.');
  }

  input.onProgress?.({ phase: 'checking-index', label: 'Checking index', stepNumber: 1 });
  const indexResult = indexLocator
    ? { path: indexLocator.path, state: 'present' as const }
    : await prepareLocalIndex(parsed.source.path, input.signal);
  const indexPath = indexResult.path;

  input.onProgress?.({
    phase: 'validating-assembly',
    label: 'Validating assembly',
    stepNumber: 2,
  });
  const initialHeader = await readAlignmentHeader({
    bamPath: parsed.source.path,
    indexPath,
    ...(referenceLocator ? { referencePath: referenceLocator.path } : {}),
  });
  assertHeaderFormat(initialHeader.format, formatId);
  requireReadableAlignmentIndex(initialHeader);
  requireExactAlignmentReferenceMatch({
    alignmentReferences: initialHeader.references,
    expectedReferences: input.assemblyReferences,
    genomeDisplayName: input.assemblyDisplayName ?? parsed.assemblyId,
    alignmentFormat: formatName(formatId),
  });
  if (formatId === 'cram' && !referenceLocator) {
    input.onProgress?.({
      phase: 'validating-reference',
      label: 'Validating CRAM reference',
      stepNumber: 3,
    });
    referenceLocator = (await input.resolveLocalCramReference?.(parsed)) ?? undefined;
    if (!referenceLocator) {
      throw new Error(
        'CRAM requires a matching indexed reference FASTA before it can be admitted.'
      );
    }
  }

  const generation = await captureAlignedReadSourceGeneration(
    {
      bamPath: parsed.source.path,
      indexPath,
      ...(referenceLocator ? { referencePath: referenceLocator.path } : {}),
    },
    platform().fs.stat
  );
  const bamPath = generation.alignment.canonicalPath;
  const canonicalIndexPath = generation.index.canonicalPath;
  const referencePath = generation.reference?.canonicalPath;
  const admittedHeader = await readAlignmentHeader({
    bamPath,
    indexPath: canonicalIndexPath,
    ...(referencePath ? { referencePath } : {}),
    generation,
  });
  assertHeaderFormat(admittedHeader.format, formatId);
  requireReadableAlignmentIndex(admittedHeader);
  const checkedAt = new Date().toISOString();
  const referenceReceipt = await alignmentReferenceReceipt({
    assemblyId: parsed.assemblyId,
    expected: input.assemblyReferences,
    actual: admittedHeader.references,
    formatId,
    checkedAt,
    assemblyDisplayName: input.assemblyDisplayName,
  });
  const request = parseTrackAdmissionRequestV1({
    ...parsed,
    source: { kind: 'local-file', path: bamPath },
    index: { kind: 'local-file', path: canonicalIndexPath },
    ...(referencePath ? { reference: { kind: 'local-file', path: referencePath } } : {}),
    scientificKind: 'reads',
  });
  const sourceInput = { kind: 'path' as const, path: bamPath };
  const indexInput = { kind: 'path' as const, path: canonicalIndexPath };
  const referenceInput = referencePath
    ? ({ kind: 'path' as const, path: referencePath } as const)
    : undefined;
  const fingerprint = await computeChecksum(
    `dnaforge:aligned-read-source:v1\u0000${formatId}\u0000${alignedReadSourceGenerationKey(generation)}`
  );

  return {
    admissionVersion: 2,
    request,
    admittedAt: checkedAt,
    uri: formatInputUri(sourceInput),
    input: sourceInput,
    index: indexInput,
    ...(referenceInput ? { reference: referenceInput } : {}),
    formatId,
    recommendedTypes: ['pileup'],
    fingerprint,
    readerKind: 'bam',
    scientificKind: 'reads',
    assemblyId: parsed.assemblyId,
    referenceReceipt,
    provenance: {
      provider: 'local-file',
      sourceKind: 'local-file',
      label: trackAdmissionRequestLabel(request),
    },
    expectedValidators: { contentLength: generation.alignment.size },
    alignedReadGeneration: generation,
    alignedReadIndexState: indexResult.state,
  };
}

async function admitHtsgetAlignedReadTrack(
  input: {
    readonly request: TrackAdmissionRequestV1;
    readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
    readonly assemblyDisplayName?: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: AlignedReadAdmissionProgress) => void;
    readonly onRuntimeReady?: (runtime: AlignedReadRuntimeAdmission) => void;
    readonly resolveLocalCramReference?: (
      request: TrackAdmissionRequestV1
    ) => Promise<LocalFileTrackSourceV1 | null>;
  },
  formatId: 'bam' | 'cram'
): Promise<AdmittedTrackSource> {
  const source = input.request.source;
  if (source.kind !== 'htsget' || source.dataClass !== 'reads') {
    throw new Error('htsget aligned-read admission requires a reads resource.');
  }
  const sourceFormat = source.format ?? formatName(formatId);
  if (sourceFormat.toLowerCase() !== formatId) {
    throw new Error(
      `The htsget source format ${sourceFormat} does not match ${formatName(formatId)}.`
    );
  }
  if (input.request.index !== undefined) {
    throw new Error(
      'htsget read sources select regions server-side and do not accept a file index.'
    );
  }

  let reference = input.request.reference;
  if (formatId === 'bam' && reference !== undefined) {
    throw new Error('BAM does not accept a reference FASTA companion.');
  }
  if (reference && reference.kind !== 'local-file') {
    throw new Error('htsget CRAM currently requires a local indexed reference FASTA.');
  }
  let referenceGeneration:
    | Awaited<ReturnType<typeof captureAlignedReadReferenceGeneration>>
    | undefined;
  if (formatId === 'cram') {
    if (!reference) {
      input.onProgress?.({
        phase: 'validating-reference',
        label: 'Validating CRAM reference',
        stepNumber: 1,
      });
      reference = (await input.resolveLocalCramReference?.(input.request)) ?? undefined;
    }
    if (!reference) {
      throw new Error('htsget CRAM requires a matching indexed reference FASTA.');
    }
    referenceGeneration = await captureAlignedReadReferenceGeneration(
      reference.path,
      platform().fs.stat
    );
    reference = { kind: 'local-file', path: referenceGeneration.reference.canonicalPath };
  }

  input.onProgress?.({
    phase: 'validating-assembly',
    label: 'Validating assembly',
    stepNumber: formatId === 'cram' ? 2 : 1,
  });
  const prepared = await prepareHtsgetRuntime(
    {
      endpoint: source.endpoint,
      resourceId: source.resourceId,
      dataClass: 'reads',
      format: sourceFormat as 'BAM' | 'CRAM',
      references: input.assemblyReferences,
      ...(source.authRef ? { authRef: source.authRef } : {}),
    },
    { signal: input.signal }
  );
  if (prepared.dataClass !== 'reads' || prepared.format.toLowerCase() !== formatId) {
    throw new Error('htsget preparation returned the wrong aligned-read format.');
  }
  const checkedAt = new Date().toISOString();
  const referenceReceipt = await alignmentReferenceReceipt({
    assemblyId: input.request.assemblyId,
    expected: input.assemblyReferences,
    actual: prepared.references,
    formatId,
    checkedAt,
    assemblyDisplayName: input.assemblyDisplayName,
  });
  const request = parseTrackAdmissionRequestV1({
    ...input.request,
    source: { ...source, format: sourceFormat },
    ...(reference ? { reference } : {}),
    scientificKind: 'reads',
  });
  const fingerprint = await computeChecksum(
    [
      'dnaforge:htsget-aligned-read-source:v1',
      formatId,
      prepared.sourceIdentity,
      prepared.assemblyRevision,
      alignedReadReferenceGenerationKey(referenceGeneration),
    ].join('\u0000')
  );
  const runtimeSource: PileupSource = {
    bamPath: `htsget-runtime://${prepared.sourceIdentity}/source.${formatId}`,
    ...(reference ? { referencePath: reference.path } : {}),
    grantExpiresAtMs: prepared.grantExpiresAtMs,
    htsget: {
      sourceToken: prepared.sourceToken,
      sourceIdentity: prepared.sourceIdentity,
      format: prepared.format as 'BAM' | 'CRAM',
    },
  };
  input.onRuntimeReady?.({
    source: runtimeSource,
    grantExpiresAtMs: prepared.grantExpiresAtMs,
  });
  return {
    admissionVersion: 2,
    request,
    admittedAt: checkedAt,
    uri: `htsget:${prepared.sourceIdentity}`,
    formatId,
    recommendedTypes: ['pileup'],
    fingerprint,
    readerKind: 'bam',
    scientificKind: 'reads',
    assemblyId: input.request.assemblyId,
    referenceReceipt,
    provenance: {
      provider: 'htsget',
      sourceKind: 'htsget',
      label: trackAdmissionRequestLabel(request),
    },
    ...(reference ? { reference: { kind: 'path', path: reference.path } as const } : {}),
    ...(referenceGeneration ? { alignedReadReferenceGeneration: referenceGeneration } : {}),
    alignedReadIndexState: 'present',
  };
}

async function admitRemoteAlignedReadTrack(
  input: {
    readonly request: TrackAdmissionRequestV1;
    readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
    readonly assemblyDisplayName?: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: AlignedReadAdmissionProgress) => void;
    readonly onRuntimeReady?: (runtime: AlignedReadRuntimeAdmission) => void;
    readonly resolveLocalCramReference?: (
      request: TrackAdmissionRequestV1
    ) => Promise<LocalFileTrackSourceV1 | null>;
  },
  formatId: 'bam' | 'cram'
): Promise<AdmittedTrackSource> {
  const source = input.request.source;
  if (!isRemoteRangeLocator(source)) {
    throw new Error('Remote aligned-read admission requires HTTP, S3, or GCS.');
  }
  const index = requireRemoteIndex(input.request.index, formatId, source.kind);
  let reference = input.request.reference;
  if (formatId === 'bam' && reference) {
    throw new Error('BAM does not accept a reference FASTA companion.');
  }
  if (reference && reference.kind !== 'local-file') {
    throw new Error('Remote CRAM currently requires a local indexed reference FASTA.');
  }

  input.onProgress?.({ phase: 'checking-index', label: 'Checking index', stepNumber: 1 });
  const indexFormat = remoteIndexFormat(index, formatId);
  const provenanceBase = `${input.request.assemblyId}:${formatId}`;
  const [sourceGrant, indexGrant] = await Promise.all([
    admitIndexedRangeSource(
      {
        source: indexedRangeSourceFromTrackLocator(source),
        formatId,
        provenanceId: `alignment:${provenanceBase}`,
      },
      { signal: input.signal }
    ),
    admitIndexedRangeSource(
      {
        source: indexedRangeSourceFromTrackLocator(index),
        formatId: indexFormat,
        provenanceId: `index:${provenanceBase}`,
      },
      { signal: input.signal }
    ),
  ]);

  let referenceGeneration:
    | Awaited<ReturnType<typeof captureAlignedReadReferenceGeneration>>
    | undefined;
  if (formatId === 'cram') {
    if (!reference) {
      input.onProgress?.({
        phase: 'validating-reference',
        label: 'Validating CRAM reference',
        stepNumber: 2,
      });
      reference = (await input.resolveLocalCramReference?.(input.request)) ?? undefined;
    }
    if (!reference) {
      throw new Error('Remote CRAM requires a matching indexed reference FASTA.');
    }
    referenceGeneration = await captureAlignedReadReferenceGeneration(
      reference.path,
      platform().fs.stat
    );
    reference = {
      kind: 'local-file',
      path: referenceGeneration.reference.canonicalPath,
    };
  }

  input.onProgress?.({
    phase: 'validating-assembly',
    label: 'Validating assembly',
    stepNumber: formatId === 'cram' ? 3 : 2,
  });
  const runtimeSource = nativeRangeProxyUrl(
    sourceGrant,
    indexedRangeSourceResourceName(indexedRangeSourceFromTrackLocator(source), formatId)
  );
  const materializedIndex = await materializeIndexedRangeSource(indexGrant, {
    signal: input.signal,
  });
  const grantExpiresAtMs = Math.min(sourceGrant.expiresAtMs, materializedIndex.expiresAtMs);
  const runtime: PileupSource = {
    bamPath: runtimeSource,
    indexPath: materializedIndex.sourcePath,
    ...(reference ? { referencePath: reference.path } : {}),
    grantExpiresAtMs,
  };
  const header = await readAlignmentHeader(runtime);
  assertHeaderFormat(header.format, formatId);
  requireReadableAlignmentIndex(header);
  const checkedAt = new Date().toISOString();
  const referenceReceipt = await alignmentReferenceReceipt({
    assemblyId: input.request.assemblyId,
    expected: input.assemblyReferences,
    actual: header.references,
    formatId,
    checkedAt,
    assemblyDisplayName: input.assemblyDisplayName,
  });
  const request = parseTrackAdmissionRequestV1({
    ...input.request,
    ...(reference ? { reference } : {}),
    scientificKind: 'reads',
  });
  const fingerprint = await computeChecksum(
    [
      'dnaforge:remote-aligned-read-source:v1',
      formatId,
      sourceGrant.canonicalUrlHash,
      validatorIdentity(sourceGrant),
      indexFormat,
      indexGrant.canonicalUrlHash,
      validatorIdentity(indexGrant),
      alignedReadReferenceGenerationKey(referenceGeneration),
    ].join('\u0000')
  );
  input.onRuntimeReady?.({ source: runtime, grantExpiresAtMs });

  return {
    admissionVersion: 2,
    request,
    admittedAt: checkedAt,
    uri: sourceGrant.sourceUri,
    input: { kind: 'url', url: sourceGrant.sourceUri },
    index: { kind: 'url', url: indexGrant.sourceUri },
    ...(reference ? { reference: { kind: 'path', path: reference.path } as const } : {}),
    formatId,
    recommendedTypes: ['pileup'],
    fingerprint,
    readerKind: 'bam',
    scientificKind: 'reads',
    assemblyId: input.request.assemblyId,
    referenceReceipt,
    provenance: {
      provider: source.kind,
      sourceKind: source.kind,
      ...(source.kind === 'http' ? { remoteUrl: source.url } : {}),
      label: trackAdmissionRequestLabel(request),
    },
    expectedValidators: grantValidators(sourceGrant),
    indexExpectedValidators: grantValidators(indexGrant),
    ...(referenceGeneration ? { alignedReadReferenceGeneration: referenceGeneration } : {}),
    alignedReadIndexState: 'present',
  };
}

function requireRemoteIndex(
  value: TrackAdmissionRequestV1['index'],
  formatId: 'bam' | 'cram',
  sourceKind: 'http' | 's3' | 'gcs'
): Extract<NonNullable<TrackAdmissionRequestV1['index']>, { kind: 'http' | 's3' | 'gcs' }> {
  if (!value || !isRemoteRangeLocator(value)) {
    const suffixes = formatId === 'bam' ? '.bai or .csi' : '.crai or .csi';
    throw new Error(
      `Remote ${formatName(formatId)} requires an explicit ${suffixes} index ${sourceKind === 'http' ? 'URL' : 'object'}.`
    );
  }
  return value;
}

function remoteIndexFormat(
  source: Extract<TrackAssetLocatorV1, { kind: 'http' | 's3' | 'gcs' }>,
  formatId: 'bam' | 'cram'
): 'bai' | 'crai' | 'csi' {
  const path = trackAssetName(source).toLowerCase();
  if (path.endsWith('.csi')) return 'csi';
  if (formatId === 'bam' && path.endsWith('.bai')) return 'bai';
  if (formatId === 'cram' && path.endsWith('.crai')) return 'crai';
  const suffixes = formatId === 'bam' ? '.bai or .csi' : '.crai or .csi';
  throw new Error(
    `Remote ${formatName(formatId)} index ${source.kind === 'http' ? 'URL' : 'object'} must end in ${suffixes}.`
  );
}

function isRemoteRangeLocator(
  value: TrackSourceAddressV1
): value is Extract<TrackAssetLocatorV1, { kind: 'http' | 's3' | 'gcs' }> {
  return value.kind === 'http' || value.kind === 's3' || value.kind === 'gcs';
}

function trackAssetName(
  source: Extract<TrackAssetLocatorV1, { kind: 'http' | 's3' | 'gcs' }>
): string {
  const locator =
    source.kind === 'http'
      ? new URL(source.url).pathname
      : source.kind === 's3'
        ? source.key
        : source.object;
  return locator.split('/').filter(Boolean).pop() ?? '';
}

function grantValidators(
  grant: IndexedRangeGrant
): NonNullable<AdmittedTrackSource['expectedValidators']> {
  return {
    contentLength: grant.byteLength,
    ...(grant.etag ? { etag: grant.etag } : {}),
    ...(grant.lastModified ? { lastModified: grant.lastModified } : {}),
  };
}

function validatorIdentity(grant: IndexedRangeGrant): string {
  return `${grant.byteLength}:${grant.etag ?? ''}:${grant.lastModified ?? ''}`;
}

async function prepareLocalIndex(
  bamPath: string,
  signal?: AbortSignal
): Promise<{ readonly path: string; readonly state: 'present' | 'created' }> {
  const operation = await startAlignmentIndexOperation({ bamPath });
  const result = await waitForAlignmentIndexResult(operation.id, { signal });
  return { path: result.indexPath, state: result.state };
}

async function alignmentReferenceReceipt(input: {
  readonly assemblyId: string;
  readonly expected: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly actual: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly formatId: 'bam' | 'cram';
  readonly checkedAt: string;
  readonly assemblyDisplayName?: string;
}): Promise<ReferenceCompatibilityReceipt> {
  requireExactAlignmentReferenceMatch({
    alignmentReferences: input.actual,
    expectedReferences: input.expected,
    genomeDisplayName: input.assemblyDisplayName ?? input.assemblyId,
    alignmentFormat: formatName(input.formatId),
  });
  return {
    assemblyId: input.assemblyId,
    referenceSignature: await referenceSignature(input.expected),
    sourceSignature: await referenceSignature(input.actual),
    contigMap: Object.fromEntries(
      input.expected.map((reference) => [reference.name, reference.name])
    ),
    checkedContigs: input.expected.length,
    status: 'compatible',
    checkedAt: input.checkedAt,
  };
}

function requireAlignedReadFormat(value: string | undefined): 'bam' | 'cram' {
  if (value === 'bam' || value === 'cram') return value;
  throw new Error(`Aligned-read admission cannot admit ${value ?? 'an unknown format'}.`);
}

function requireOptionalLocalCompanion(
  value: TrackAdmissionRequestV1['index'] | TrackAdmissionRequestV1['reference'],
  label: 'index' | 'reference'
): Extract<NonNullable<TrackAdmissionRequestV1['index']>, { kind: 'local-file' }> | undefined {
  if (value === undefined) return undefined;
  if (value.kind !== 'local-file') {
    throw new Error(`A local aligned-read source requires a local ${label} companion.`);
  }
  return value;
}

function assertHeaderFormat(actual: 'bam' | 'cram', expected: 'bam' | 'cram'): void {
  if (actual !== expected) {
    throw new Error(
      `The selected source is ${formatName(actual)}, not the expected ${formatName(expected)}.`
    );
  }
}

function formatName(formatId: 'bam' | 'cram'): 'BAM' | 'CRAM' {
  return formatId === 'bam' ? 'BAM' : 'CRAM';
}
