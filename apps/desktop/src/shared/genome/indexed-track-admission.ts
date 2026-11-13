import type { LocalAuthorityContext } from '../local-indexed-track-authority';
import {
  parseBigBedAutoSqlFieldNames,
  parseTrackAdmissionRequestV1,
  trackAdmissionRequestIdentity,
  trackAdmissionRequestLabel,
  type IndexedBbiTrackSource,
  type ScientificTrackKind,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import type { ReferenceIdentity as AlignmentReferenceIdentity } from './bbi-reference-compatibility';
import type {
  BbiRangeGrant,
  BbiHeaderSummary,
  BbiQueryRegion,
  BbiQuantitativeRegion,
} from './bbi-reader-worker-protocol';
import { assertBbiReferencesCompatible } from './bbi-reference-compatibility';
import { summarizeBbiQuantitativeSource } from './bbi-quantitative-source-summary';
import { indexedRangeSourceFromTrackLocator } from './indexed-range-source';

export interface BbiAdmissionRuntime {
  admit(
    input: {
      source: ReturnType<typeof indexedRangeSourceFromTrackLocator>;
      formatId: 'bigwig' | 'bigbed';
      provenanceId: string;
    },
    options: { signal?: AbortSignal; localAuthorityContext?: LocalAuthorityContext }
  ): Promise<BbiRangeGrant>;
  reader: {
    open(
      sourceKey: string,
      format: 'bigwig' | 'bigbed',
      grant: BbiRangeGrant,
      signal?: AbortSignal
    ): Promise<BbiHeaderSummary>;
    closeSource(sourceKey: string): Promise<unknown>;
    queryQuantitative(
      sourceKey: string,
      regions: ReadonlyArray<BbiQueryRegion>,
      basesPerSpan: number,
      signal?: AbortSignal
    ): Promise<ReadonlyArray<BbiQuantitativeRegion>>;
  };
}

export interface IndexedBbiRequestAdmissionInput {
  readonly request: TrackAdmissionRequestV1;
  readonly runtime: BbiAdmissionRuntime;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly signal?: AbortSignal;
  readonly localAuthorityContext?: LocalAuthorityContext;
}

export async function admitIndexedBigWigRequest(
  input: IndexedBbiRequestAdmissionInput
): Promise<IndexedBbiTrackSource> {
  const request = parseTrackAdmissionRequestV1(input.request);
  if (request.formatId !== 'bigwig')
    throw new Error(`Indexed BigWig admission cannot admit ${request.formatId ?? 'unknown'}.`);
  return admitIndexedBbiRequest(input, 'bigwig');
}

export async function admitIndexedBigBedRequest(
  input: IndexedBbiRequestAdmissionInput
): Promise<IndexedBbiTrackSource> {
  const request = parseTrackAdmissionRequestV1(input.request);
  if (request.formatId !== 'bigbed')
    throw new Error(`Indexed BigBed admission cannot admit ${request.formatId ?? 'unknown'}.`);
  return admitIndexedBbiRequest(input, 'bigbed');
}

async function admitIndexedBbiRequest(
  input: IndexedBbiRequestAdmissionInput,
  formatId: 'bigwig' | 'bigbed'
): Promise<IndexedBbiTrackSource> {
  const parsed = parseTrackAdmissionRequestV1(input.request);
  assertScientificKindAllowedForBbi(formatId, parsed.scientificKind);
  if (parsed.source.kind === 'htsget' || parsed.source.kind === 'ucsc-track') {
    throw new Error(`${formatId.toUpperCase()} cannot use ${parsed.source.kind} admission.`);
  }
  const rangeSource = indexedRangeSourceFromTrackLocator(parsed.source);
  if (input.assemblyReferences.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this track.');
  }
  const provenanceId = trackAdmissionRequestIdentity(parsed);
  const grant = await input.runtime.admit(
    {
      source: rangeSource,
      formatId,
      provenanceId,
    },
    { signal: input.signal, localAuthorityContext: input.localAuthorityContext }
  );
  const fingerprint = [
    provenanceId,
    grant.canonicalUrlHash,
    grant.etag ?? '',
    grant.lastModified ?? '',
    grant.byteLength,
  ].join('\u0000');
  const reader = input.runtime.reader;
  const header = await reader.open(fingerprint, formatId, grant, input.signal);
  try {
    if (header.fileType !== formatId) {
      throw new Error(
        `The admitted source is ${header.fileType}, not ${formatId === 'bigwig' ? 'BigWig' : 'BigBed'}.`
      );
    }
    const scientificKind = scientificKindForBbi(formatId, parsed.scientificKind, header.autoSql);
    const request = parseTrackAdmissionRequestV1({ ...parsed, scientificKind });
    const referenceReceipt = await assertBbiReferencesCompatible({
      assemblyId: request.assemblyId,
      expected: input.assemblyReferences,
      actual: header.references,
      formatName: formatId === 'bigwig' ? 'BigWig' : 'BigBed',
      allowSourceSubset: true,
    });
    const quantitativeSummary =
      formatId === 'bigwig'
        ? await summarizeBbiQuantitativeSource({
            reader,
            sourceKey: fingerprint,
            header,
            signal: input.signal,
          })
        : null;
    const label = trackAdmissionRequestLabel(request);
    const source =
      rangeSource.kind === 'path'
        ? ({ kind: 'path' as const, path: rangeSource.path } as const)
        : ({ kind: 'url' as const, url: grant.sourceUri } as const);
    const provenance = bbiSourceProvenance(request.source.kind);
    return {
      admissionVersion: 2,
      request,
      admittedAt: referenceReceipt.checkedAt,
      uri: grant.sourceUri,
      input: source,
      formatId,
      recommendedTypes: recommendedTypesForScientificKind(scientificKind),
      fingerprint,
      readerKind: 'bbi',
      scientificKind,
      ...(formatId === 'bigwig'
        ? { quantitativeColumnSemantics: 'continuous-signal' as const }
        : {}),
      ...(quantitativeSummary ? { quantitativeSummary } : {}),
      assemblyId: request.assemblyId,
      referenceReceipt,
      provenance: {
        ...provenance,
        label,
        ...(input.localAuthorityContext === 'dev-scenario-fixture'
          ? { devScenarioFixture: true as const }
          : {}),
      },
      expectedValidators: {
        etag: grant.etag,
        lastModified: grant.lastModified,
        contentLength: grant.byteLength,
      },
    };
  } finally {
    await reader.closeSource(fingerprint);
  }
}

function bbiSourceProvenance(
  kind: 'local-file' | 'http' | 's3' | 'gcs' | 'htsget' | 'ucsc-track'
): {
  readonly provider: 'local-file' | 'direct-url' | 's3' | 'gcs';
  readonly sourceKind: 'local-file' | 'remote-url' | 's3' | 'gcs';
} {
  switch (kind) {
    case 'local-file':
      return { provider: 'local-file', sourceKind: 'local-file' };
    case 'http':
      return { provider: 'direct-url', sourceKind: 'remote-url' };
    case 's3':
      return { provider: 's3', sourceKind: 's3' };
    case 'gcs':
      return { provider: 'gcs', sourceKind: 'gcs' };
    case 'htsget':
    case 'ucsc-track':
      throw new Error(`${kind} cannot be admitted by the BBI source adapter.`);
  }
}

function scientificKindForBbi(
  formatId: 'bigwig' | 'bigbed',
  requested: ScientificTrackKind | undefined,
  autoSql?: string
): ScientificTrackKind {
  assertScientificKindAllowedForBbi(formatId, requested);
  if (formatId === 'bigwig') {
    return 'quantitative';
  }
  if (requested) return requested;

  const fields = new Set(
    parseBigBedAutoSqlFieldNames(autoSql).map((fieldName) => fieldName.toLowerCase())
  );
  if (
    fields.has('blockcount') &&
    fields.has('blocksizes') &&
    (fields.has('blockstarts') || fields.has('chromstarts'))
  ) {
    return 'transcript';
  }
  if (fields.has('signalvalue') && (fields.has('pvalue') || fields.has('qvalue'))) {
    return 'peak';
  }
  if (
    fields.has('repclass') ||
    fields.has('repeatclass') ||
    fields.has('repfamily') ||
    fields.has('repeatfamily')
  ) {
    return 'repeat';
  }
  return 'interval';
}

function assertScientificKindAllowedForBbi(
  formatId: 'bigwig' | 'bigbed',
  requested: ScientificTrackKind | undefined
): void {
  if (formatId === 'bigwig') {
    if (requested && requested !== 'quantitative') {
      throw new Error(`BigWig cannot be admitted as ${requested}.`);
    }
    return;
  }
  if (requested && !['transcript', 'interval', 'peak', 'repeat'].includes(requested)) {
    throw new Error(`BigBed cannot be admitted as ${requested}.`);
  }
}

export function recommendedTypesForScientificKind(
  scientificKind: ScientificTrackKind
): ReadonlyArray<string> {
  switch (scientificKind) {
    case 'transcript':
      return ['imported-transcript'];
    case 'interval':
      return ['generic-interval'];
    case 'peak':
      return ['peak'];
    case 'repeat':
      return ['repeat'];
    case 'quantitative':
      return ['quantitative'];
    default:
      return [];
  }
}
