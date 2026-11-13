import {
  createUcscTrackFingerprint,
  parseTrackAdmissionRequestV1,
  type ScientificTrackKind,
  type TrackAdmissionRequestV1,
  type UcscCatalogLeaf,
  type UcscTrackFormatId,
  type UcscTrackSource,
} from '@waypoint/genome-data';

import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { getBbiReaderWorkerClient } from './bbi-reader-runtime';
import { assertBbiReferencesCompatible, referenceSignature } from './bbi-reference-compatibility';
import { summarizeBbiQuantitativeSource } from './bbi-quantitative-source-summary';
import { recommendedTypesForScientificKind } from './indexed-track-admission';
import {
  ucscTrackTargetForAssembly,
  type HostedReferenceUcscTrackTargetV1,
} from './ucsc-assembly-alias';
import {
  admitUcscTrack,
  fetchUcscWholeTrack,
  UCSC_NATIVE_SNAPSHOT_MAX_ITEMS,
} from './ucsc-track-client';
import { classifyUcscCatalogTrackSupport } from './ucsc-track-support';

export async function admitUcscCatalogTrackSource(input: {
  readonly assemblyId: string;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly ucscTarget: HostedReferenceUcscTrackTargetV1;
  readonly track: UcscCatalogLeaf;
}): Promise<UcscTrackSource> {
  if (input.assemblyReferences.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this track.');
  }
  if (!input.ucscTarget.hubUrl) {
    const mappedTarget = ucscTrackTargetForAssembly(input.assemblyId);
    if (!mappedTarget) {
      throw new Error(`UCSC loading is not mapped for assembly ${input.assemblyId}.`);
    }
    if (
      mappedTarget.genomeId !== input.ucscTarget.genomeId ||
      mappedTarget.hubUrl !== input.ucscTarget.hubUrl
    ) {
      throw new Error(
        `DNAForge assembly ${input.assemblyId} maps to UCSC target ${mappedTarget.genomeId}, not ${input.ucscTarget.genomeId}.`
      );
    }
  }
  if (input.track.assembly.ucscGenome !== input.ucscTarget.genomeId) {
    throw new Error(
      `UCSC track ${input.track.track} belongs to ${input.track.assembly.ucscGenome}, not ${input.ucscTarget.genomeId}.`
    );
  }
  if (input.track.hubUrl !== input.ucscTarget.hubUrl) {
    throw new Error(`UCSC track ${input.track.track} belongs to a different catalog target.`);
  }
  const support = classifyUcscCatalogTrackSupport(input.track);
  if (!support.supported) throw new Error(support.reason);
  if (support.path === 'hub-reads' || support.path === 'hub-variants') {
    throw new Error(
      `UCSC track ${input.track.track} streams reads or calls; admit it through hubDataTrackAdmissionRequest.`
    );
  }

  const catalogFingerprint = createUcscTrackFingerprint({
    sourceKind: input.track.sourceKind,
    ucscGenome: input.ucscTarget.genomeId,
    track: input.track.track,
    hubUrl: input.ucscTarget.hubUrl,
  });
  if (support.path === 'native-table') {
    const scientificKind = input.track.scientificKind;
    const request = ucscAdmissionRequest(input, 'ucsc-native', scientificKind);
    const assemblySignature = await referenceSignature(input.assemblyReferences);
    const snapshot = await fetchUcscWholeTrack({
      genome: input.ucscTarget.genomeId,
      track: input.track.track,
      hubUrl: input.ucscTarget.hubUrl,
      maxItemsOutput: UCSC_NATIVE_SNAPSHOT_MAX_ITEMS,
    });
    if (!snapshot.complete) {
      throw new Error(
        `UCSC track ${input.track.track} has no exact content revision: its whole-track snapshot reached the ${snapshot.maxItemsOutput}-record response cap.`
      );
    }
    const contentFingerprint = await nativeUcscContentFingerprint({
      catalogFingerprint,
      catalogTrackType: input.track.type,
      snapshot,
    });
    const uri = `ucsc://${encodeURIComponent(input.ucscTarget.genomeId)}/${encodeURIComponent(input.track.track)}`;
    const admittedAt = new Date().toISOString();
    return {
      admissionVersion: 2,
      request,
      admittedAt,
      uri,
      input: { kind: 'url', url: uri },
      formatId: 'ucsc-native',
      recommendedTypes: recommendedTypesForScientificKind(scientificKind),
      fingerprint: contentFingerprint,
      readerKind: 'ucsc-rest',
      scientificKind,
      assemblyId: input.assemblyId,
      referenceReceipt: {
        assemblyId: input.assemblyId,
        referenceSignature: assemblySignature,
        sourceSignature: contentFingerprint,
        contigMap: Object.fromEntries(
          input.assemblyReferences.map((reference) => [reference.name, reference.name])
        ),
        checkedContigs: input.assemblyReferences.length,
        status: 'compatible',
        checkedAt: admittedAt,
      },
      provenance: {
        provider: 'ucsc',
        sourceKind: input.track.sourceKind,
        catalogId: input.track.catalogId,
        ucscGenome: input.ucscTarget.genomeId,
        track: input.track.track,
        label: input.track.shortLabel,
        hubUrl: input.ucscTarget.hubUrl,
      },
    };
  }

  const formatId = support.path === 'bigwig-quantitative' ? 'bigwig' : 'bigbed';
  const scientificKind = input.track.scientificKind;
  const request = ucscAdmissionRequest(input, formatId, scientificKind);
  const scale = input.track.signalScale;
  const publishedSignalScale =
    scale?.minimum !== undefined && scale.maximum !== undefined
      ? { minimum: scale.minimum, maximum: scale.maximum }
      : undefined;
  const grant = await admitUcscTrack({
    genome: input.ucscTarget.genomeId,
    track: input.track.track,
    formatId,
    probeChrom: input.assemblyReferences[0].name,
    hubUrl: input.ucscTarget.hubUrl,
  });
  const reader = getBbiReaderWorkerClient();
  const header = await reader.open(catalogFingerprint, formatId, grant);
  try {
    const formatName = formatId === 'bigwig' ? 'BigWig' : 'BigBed';
    if (header.fileType !== formatId) {
      throw new Error(`The admitted source is ${header.fileType}, not ${formatName}.`);
    }
    const referenceReceipt = await assertBbiReferencesCompatible({
      assemblyId: input.assemblyId,
      expected: input.assemblyReferences,
      actual: header.references,
      formatName,
      allowSourceSubset: true,
    });
    const quantitativeSummary =
      formatId === 'bigwig'
        ? await summarizeBbiQuantitativeSource({
            reader,
            sourceKey: catalogFingerprint,
            header,
          })
        : null;
    const fingerprint = `sha256:${grant.representationSha256}`;
    return {
      admissionVersion: 2,
      request,
      admittedAt: referenceReceipt.checkedAt,
      uri: grant.sourceUri,
      input: { kind: 'url', url: grant.sourceUri },
      formatId,
      recommendedTypes: recommendedTypesForScientificKind(scientificKind),
      fingerprint,
      readerKind: 'bbi',
      scientificKind,
      ...(scientificKind === 'quantitative'
        ? { quantitativeColumnSemantics: 'continuous-signal' as const }
        : {}),
      ...(scientificKind === 'quantitative' && publishedSignalScale
        ? { publishedSignalScale }
        : {}),
      ...(quantitativeSummary ? { quantitativeSummary } : {}),
      assemblyId: input.assemblyId,
      referenceReceipt,
      provenance: {
        provider: 'ucsc',
        sourceKind: input.track.sourceKind,
        catalogId: input.track.catalogId,
        ucscGenome: input.ucscTarget.genomeId,
        track: input.track.track,
        label: input.track.shortLabel,
        hubUrl: input.ucscTarget.hubUrl,
        remoteUrl: grant.sourceUri,
      },
      expectedValidators: {
        etag: grant.etag,
        lastModified: grant.lastModified,
        contentLength: grant.byteLength,
      },
    };
  } finally {
    await reader.closeSource(catalogFingerprint);
  }
}

export function ucscCatalogTargetForTrack(
  track: UcscCatalogLeaf,
  mappedTarget: HostedReferenceUcscTrackTargetV1 | null
): HostedReferenceUcscTrackTargetV1 | null {
  if (track.sourceKind === 'ucsc-hub' && track.hubUrl) {
    return { genomeId: track.assembly.ucscGenome, hubUrl: track.hubUrl };
  }
  return mappedTarget;
}

export function hubDataTrackAdmissionRequest(input: {
  readonly assemblyId: string;
  readonly ucscTarget: HostedReferenceUcscTrackTargetV1;
  readonly track: UcscCatalogLeaf;
}): TrackAdmissionRequestV1 {
  const support = classifyUcscCatalogTrackSupport(input.track);
  if (!support.supported) throw new Error(support.reason);
  if (support.path !== 'hub-reads' && support.path !== 'hub-variants') {
    throw new Error(`UCSC track ${input.track.track} is not a hub read or variant track.`);
  }
  if (!input.ucscTarget.hubUrl || !input.track.bigDataUrl) {
    throw new Error(`UCSC track ${input.track.track} publishes no hub file to stream.`);
  }
  const url = new URL(input.track.bigDataUrl, input.ucscTarget.hubUrl).toString();
  const formatId = hubDataFormat(url, support.path);
  const index = input.track.bigDataIndex
    ? new URL(input.track.bigDataIndex, input.ucscTarget.hubUrl).toString()
    : `${url}${CONVENTIONAL_INDEX_SUFFIX[formatId]}`;
  return parseTrackAdmissionRequestV1({
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId: input.assemblyId,
    source: { kind: 'http', url },
    index: { kind: 'http', url: index },
    formatId,
    scientificKind: support.path === 'hub-reads' ? 'reads' : 'variants',
    label: input.track.shortLabel,
    ingress: { kind: 'hub' },
  });
}

const CONVENTIONAL_INDEX_SUFFIX = {
  bam: '.bai',
  cram: '.crai',
  vcf: '.tbi',
  bcf: '.csi',
} as const;

function hubDataFormat(
  url: string,
  path: 'hub-reads' | 'hub-variants'
): keyof typeof CONVENTIONAL_INDEX_SUFFIX {
  const pathname = new URL(url).pathname.toLowerCase();
  if (path === 'hub-reads') return pathname.endsWith('.cram') ? 'cram' : 'bam';
  return pathname.endsWith('.bcf') ? 'bcf' : 'vcf';
}

function ucscAdmissionRequest(
  input: {
    readonly assemblyId: string;
    readonly ucscTarget: HostedReferenceUcscTrackTargetV1;
    readonly track: UcscCatalogLeaf;
  },
  formatId: UcscTrackFormatId,
  scientificKind: ScientificTrackKind
): TrackAdmissionRequestV1 {
  return parseTrackAdmissionRequestV1({
    contract: 'dnaforge.track-admission-request.v1',
    assemblyId: input.assemblyId,
    source: {
      kind: 'ucsc-track',
      sourceKind: input.track.sourceKind,
      genome: input.ucscTarget.genomeId,
      track: input.track.track,
      ...(input.ucscTarget.hubUrl ? { hubUrl: input.ucscTarget.hubUrl } : {}),
    },
    formatId,
    scientificKind,
    label: input.track.shortLabel,
    ingress: { kind: input.track.sourceKind === 'ucsc-hub' ? 'hub' : 'catalog' },
  });
}

async function nativeUcscContentFingerprint(input: {
  readonly catalogFingerprint: string;
  readonly catalogTrackType?: string;
  readonly snapshot: Awaited<ReturnType<typeof fetchUcscWholeTrack>>;
}): Promise<string> {
  const canonicalRecords = input.snapshot.records.map(canonicalJson).sort();
  const canonical = canonicalJson({
    contract: 'dnaforge.ucsc-rest-track-content.v1',
    catalogFingerprint: input.catalogFingerprint,
    catalogTrackType: input.catalogTrackType ?? null,
    returnedTrackType: input.snapshot.trackType ?? null,
    itemsReturned: input.snapshot.itemsReturned,
    records: canonicalRecords,
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('UCSC track content contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('UCSC track content contains a non-JSON object.');
    }
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new Error('UCSC track content contains a non-JSON value.');
}
