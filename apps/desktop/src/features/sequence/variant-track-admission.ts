import {
  formatInputUri,
  parseTrackAdmissionRequestV1,
  trackAdmissionRequestLabel,
  type AdmittedTrackSource,
  type ReferenceCompatibilityReceipt,
  type TrackAssetLocatorV1,
  type TrackAdmissionRequestV1,
  type TrackSourceAddressV1,
} from '@waypoint/genome-data';
import { computeChecksum } from '@waypoint/sequence-utils';

import { referenceSignature } from './bbi-reference-compatibility';
import {
  admitIndexedRangeSource,
  indexedRangeSourceFromTrackLocator,
  type IndexedRangeGrant,
} from './indexed-range-client';
import { prepareRemoteVariantRuntime, type RemoteVariantRuntime } from './remote-variant-client';
import { prepareHtsgetRuntime, type HtsgetRuntime } from './htsget-client';
import {
  recallPreparedVariantSource,
  rememberPreparedVariantSource,
} from './prepared-variant-source-cache';
import {
  prepareVariantSource,
  type PreparedVariantSource,
  type VariantReferenceIdentity,
} from './variant-client';

export interface LocalVariantRuntime {
  readonly kind: 'local';
  readonly prepared: PreparedVariantSource;
  readonly sourceIdentity: string;
  readonly assemblyRevision: string;
  readonly matchedReferences: ReadonlyArray<string>;
  readonly samples: ReadonlyArray<string>;
}

export type VariantTrackRuntime = LocalVariantRuntime | RemoteVariantRuntime | HtsgetRuntime;

export interface VariantRuntimeAdmission {
  readonly runtime: VariantTrackRuntime;
}

export async function admitVariantTrackRequest(input: {
  readonly request: TrackAdmissionRequestV1;
  readonly assemblyReferences: ReadonlyArray<VariantReferenceIdentity>;
  readonly signal?: AbortSignal;
  readonly onRuntimeReady?: (runtime: VariantRuntimeAdmission) => void;
  readonly reuseRememberedPreparation?: boolean;
}): Promise<AdmittedTrackSource> {
  const parsed = parseTrackAdmissionRequestV1(input.request);
  const formatId = requireVariantFormat(parsed.formatId);
  if (parsed.scientificKind !== undefined && parsed.scientificKind !== 'variants') {
    throw new Error(`${formatName(formatId)} cannot be admitted as ${parsed.scientificKind}.`);
  }
  if (parsed.source.kind === 'htsget') {
    return admitHtsgetVariantTrackRequest({ ...input, request: parsed }, formatId);
  }
  if (parsed.source.kind === 'local-file') {
    return admitLocalVariantTrackRequest({ ...input, request: parsed }, formatId);
  }
  if (!isRemoteRangeLocator(parsed.source)) {
    throw new Error(
      `${formatName(formatId)} source kind ${parsed.source.kind} is not implemented by remote admission.`
    );
  }
  if (input.assemblyReferences.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this source.');
  }
  const index = requireRemoteVariantIndex(parsed.index, formatId, parsed.source.kind);
  const indexFormat = remoteVariantIndexFormat(index, formatId);
  const provenanceBase = `${parsed.assemblyId}:${formatId}`;
  const [sourceGrant, indexGrant] = await Promise.all([
    admitIndexedRangeSource(
      {
        source: indexedRangeSourceFromTrackLocator(parsed.source),
        formatId,
        provenanceId: `variant:${provenanceBase}`,
      },
      { signal: input.signal }
    ),
    admitIndexedRangeSource(
      {
        source: indexedRangeSourceFromTrackLocator(index),
        formatId: indexFormat,
        provenanceId: `variant-index:${provenanceBase}`,
      },
      { signal: input.signal }
    ),
  ]);
  const runtime = await prepareRemoteVariantRuntime(
    {
      sourceGrant,
      indexGrant,
      references: input.assemblyReferences,
    },
    { signal: input.signal }
  );
  const checkedAt = new Date().toISOString();
  const referenceReceipt = await variantReferenceReceipt({
    assemblyId: parsed.assemblyId,
    expected: input.assemblyReferences,
    matchedReferences: runtime.matchedReferences,
    checkedAt,
  });
  const request = parseTrackAdmissionRequestV1({
    ...parsed,
    scientificKind: 'variants',
  });
  const fingerprint = await computeChecksum(
    [
      'dnaforge:remote-variant-source:v1',
      formatId,
      sourceGrant.canonicalUrlHash,
      validatorIdentity(sourceGrant),
      indexFormat,
      indexGrant.canonicalUrlHash,
      validatorIdentity(indexGrant),
      runtime.sourceIdentity,
      runtime.assemblyRevision,
    ].join('\u0000')
  );
  input.onRuntimeReady?.({ runtime });

  const sourceInput = { kind: 'url' as const, url: sourceGrant.sourceUri };
  return {
    admissionVersion: 2,
    request,
    admittedAt: checkedAt,
    uri: formatInputUri(sourceInput),
    input: sourceInput,
    index: { kind: 'url', url: indexGrant.sourceUri },
    formatId,
    recommendedTypes: ['variant'],
    fingerprint,
    readerKind: 'variant',
    scientificKind: 'variants',
    assemblyId: parsed.assemblyId,
    referenceReceipt,
    provenance: {
      provider: parsed.source.kind,
      sourceKind: parsed.source.kind,
      ...(parsed.source.kind === 'http' ? { remoteUrl: parsed.source.url } : {}),
      label: trackAdmissionRequestLabel(request),
    },
    expectedValidators: grantValidators(sourceGrant),
    indexExpectedValidators: grantValidators(indexGrant),
  };
}

async function admitLocalVariantTrackRequest(
  input: {
    readonly request: TrackAdmissionRequestV1;
    readonly assemblyReferences: ReadonlyArray<VariantReferenceIdentity>;
    readonly signal?: AbortSignal;
    readonly onRuntimeReady?: (runtime: VariantRuntimeAdmission) => void;
    readonly reuseRememberedPreparation?: boolean;
  },
  formatId: 'vcf' | 'bcf'
): Promise<AdmittedTrackSource> {
  const source = input.request.source;
  if (source.kind !== 'local-file') {
    throw new Error('Local variant admission requires a selected file.');
  }
  if (input.request.index !== undefined && input.request.index.kind !== 'local-file') {
    throw new Error('A local variant source cannot use a remote index.');
  }
  if (input.assemblyReferences.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this source.');
  }
  const remembered = input.reuseRememberedPreparation
    ? recallPreparedVariantSource(source.path, input.assemblyReferences)
    : null;
  const prepared =
    remembered ??
    (await prepareVariantSource(
      { variantPath: source.path, references: input.assemblyReferences },
      { signal: input.signal }
    ));
  if (!remembered) {
    rememberPreparedVariantSource(prepared, input.assemblyReferences, source.path);
  }
  if (prepared.format !== formatId) {
    throw new Error(
      `The selected source is ${formatName(prepared.format)}, not ${formatName(formatId)}.`
    );
  }
  const checkedAt = new Date().toISOString();
  const referenceReceipt = await variantReferenceReceipt({
    assemblyId: input.request.assemblyId,
    expected: input.assemblyReferences,
    matchedReferences: prepared.matchedReferences,
    checkedAt,
  });
  const request = parseTrackAdmissionRequestV1({
    ...input.request,
    source: { ...source, path: prepared.sourcePath },
    scientificKind: 'variants',
  });
  const fingerprint = await computeChecksum(
    [
      'dnaforge:local-variant-source:v1',
      formatId,
      prepared.sourceIdentity,
      prepared.assemblyRevision,
    ].join('\u0000')
  );
  const runtime: LocalVariantRuntime = {
    kind: 'local',
    prepared,
    sourceIdentity: prepared.sourceIdentity,
    assemblyRevision: prepared.assemblyRevision,
    matchedReferences: [...prepared.matchedReferences],
    samples: [...prepared.samples],
  };
  input.onRuntimeReady?.({ runtime });
  const sourceInput = { kind: 'path' as const, path: prepared.sourcePath };
  return {
    admissionVersion: 2,
    request,
    admittedAt: checkedAt,
    uri: formatInputUri(sourceInput),
    input: sourceInput,
    formatId,
    recommendedTypes: ['variant'],
    fingerprint,
    readerKind: 'variant',
    scientificKind: 'variants',
    assemblyId: input.request.assemblyId,
    referenceReceipt,
    provenance: {
      provider: 'local-file',
      sourceKind: 'local-file',
      label: trackAdmissionRequestLabel(request),
    },
    expectedValidators: { contentLength: prepared.sourceSizeBytes },
  };
}

async function admitHtsgetVariantTrackRequest(
  input: {
    readonly request: TrackAdmissionRequestV1;
    readonly assemblyReferences: ReadonlyArray<VariantReferenceIdentity>;
    readonly signal?: AbortSignal;
    readonly onRuntimeReady?: (runtime: VariantRuntimeAdmission) => void;
  },
  formatId: 'vcf' | 'bcf'
): Promise<AdmittedTrackSource> {
  const source = input.request.source;
  if (source.kind !== 'htsget' || source.dataClass !== 'variants') {
    throw new Error('htsget variant admission requires a variants resource.');
  }
  if (input.request.index !== undefined) {
    throw new Error(
      'htsget variant sources select regions server-side and do not accept an index.'
    );
  }
  const sourceFormat = source.format ?? formatName(formatId);
  if (sourceFormat.toLowerCase() !== formatId) {
    throw new Error(
      `The htsget source format ${sourceFormat} does not match ${formatName(formatId)}.`
    );
  }
  const runtime = await prepareHtsgetRuntime(
    {
      endpoint: source.endpoint,
      resourceId: source.resourceId,
      dataClass: 'variants',
      format: sourceFormat as 'VCF' | 'BCF',
      references: input.assemblyReferences,
      ...(source.authRef ? { authRef: source.authRef } : {}),
    },
    { signal: input.signal }
  );
  if (runtime.dataClass !== 'variants' || runtime.format.toLowerCase() !== formatId) {
    throw new Error('htsget preparation returned the wrong variant format.');
  }
  const checkedAt = new Date().toISOString();
  const referenceReceipt = await variantReferenceReceipt({
    assemblyId: input.request.assemblyId,
    expected: input.assemblyReferences,
    matchedReferences: runtime.matchedReferences,
    checkedAt,
  });
  const request = parseTrackAdmissionRequestV1({
    ...input.request,
    source: { ...source, format: sourceFormat },
    scientificKind: 'variants',
  });
  const fingerprint = await computeChecksum(
    [
      'dnaforge:htsget-variant-source:v1',
      formatId,
      runtime.sourceIdentity,
      runtime.assemblyRevision,
    ].join('\u0000')
  );
  input.onRuntimeReady?.({ runtime });
  return {
    admissionVersion: 2,
    request,
    admittedAt: checkedAt,
    uri: `htsget:${runtime.sourceIdentity}`,
    formatId,
    recommendedTypes: ['variant'],
    fingerprint,
    readerKind: 'variant',
    scientificKind: 'variants',
    assemblyId: input.request.assemblyId,
    referenceReceipt,
    provenance: {
      provider: 'htsget',
      sourceKind: 'htsget',
      label: trackAdmissionRequestLabel(request),
    },
  };
}

async function variantReferenceReceipt(input: {
  readonly assemblyId: string;
  readonly expected: ReadonlyArray<VariantReferenceIdentity>;
  readonly matchedReferences: ReadonlyArray<string>;
  readonly checkedAt: string;
}): Promise<ReferenceCompatibilityReceipt> {
  const expectedByName = new Map(input.expected.map((reference) => [reference.name, reference]));
  const matched = input.matchedReferences.map((name) => {
    const reference = expectedByName.get(name);
    if (!reference) {
      throw new Error(`The variant source returned an unknown reference ${name}.`);
    }
    return reference;
  });
  if (
    matched.length === 0 ||
    new Set(matched.map((reference) => reference.name)).size !== matched.length
  ) {
    throw new Error('The variant source returned an invalid reference receipt.');
  }
  return {
    assemblyId: input.assemblyId,
    referenceSignature: await referenceSignature(input.expected),
    sourceSignature: await referenceSignature(matched),
    contigMap: Object.fromEntries(matched.map((reference) => [reference.name, reference.name])),
    checkedContigs: matched.length,
    status: 'compatible',
    checkedAt: input.checkedAt,
  };
}

function requireRemoteVariantIndex(
  value: TrackAdmissionRequestV1['index'],
  formatId: 'vcf' | 'bcf',
  sourceKind: 'http' | 's3' | 'gcs'
): Extract<NonNullable<TrackAdmissionRequestV1['index']>, { kind: 'http' | 's3' | 'gcs' }> {
  if (!value || !isRemoteRangeLocator(value)) {
    const suffixes = formatId === 'vcf' ? '.tbi or .csi' : '.csi';
    throw new Error(
      `Remote ${formatName(formatId)} requires an explicit ${suffixes} index ${sourceKind === 'http' ? 'URL' : 'object'}.`
    );
  }
  return value;
}

function remoteVariantIndexFormat(
  source: Extract<TrackAssetLocatorV1, { kind: 'http' | 's3' | 'gcs' }>,
  formatId: 'vcf' | 'bcf'
): 'tbi' | 'csi' {
  const path = trackAssetName(source).toLowerCase();
  if (path.endsWith('.csi')) return 'csi';
  if (formatId === 'vcf' && path.endsWith('.tbi')) return 'tbi';
  const suffixes = formatId === 'vcf' ? '.tbi or .csi' : '.csi';
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

function requireVariantFormat(value: string | undefined): 'vcf' | 'bcf' {
  if (value === 'vcf' || value === 'bcf') return value;
  throw new Error(`Variant admission cannot admit ${value ?? 'an unknown format'}.`);
}

function formatName(formatId: 'vcf' | 'bcf'): 'VCF' | 'BCF' {
  return formatId === 'vcf' ? 'VCF' : 'BCF';
}
