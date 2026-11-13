import {
  alignedReadReferenceGenerationsEqual,
  requireTrackAdmissionRequest,
  type AdmittedSourceValidators,
  type AdmittedTrackSource,
  type TrackAssetLocatorV1,
  type TrackSourceAddressV1,
} from '@waypoint/genome-data';

import { platform } from '../../platform';
import {
  readAlignmentHeader,
  requireExactAlignmentReferenceMatch,
  requireReadableAlignmentIndex,
  type AlignmentReferenceIdentity,
} from './alignment-header-client';
import {
  admitIndexedRangeSource,
  indexedRangeSourceFromTrackLocator,
  indexedRangeSourceResourceName,
  materializeIndexedRangeSource,
  nativeRangeProxyUrl,
  type IndexedRangeGrant,
} from './indexed-range-client';
import { captureAlignedReadReferenceGeneration } from './aligned-read-source-generation';
import type { PileupSource } from './pileup-source';
import { prepareHtsgetRuntime } from './htsget-client';

export interface OpenedAlignedReadSource {
  readonly source: PileupSource;
  readonly grantExpiresAtMs?: number;
}

export async function openAlignedReadSource(input: {
  readonly source: AdmittedTrackSource;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly assemblyDisplayName: string;
  readonly signal?: AbortSignal;
}): Promise<OpenedAlignedReadSource> {
  const durable = input.source;
  if (
    durable.readerKind !== 'bam' ||
    durable.scientificKind !== 'reads' ||
    (durable.formatId !== 'bam' && durable.formatId !== 'cram')
  ) {
    throw new Error('The admitted source is not a BAM/CRAM aligned-read source.');
  }
  const request = requireTrackAdmissionRequest(durable);
  if (request.source.kind === 'local-file') {
    if (
      durable.input?.kind !== 'path' ||
      durable.index?.kind !== 'path' ||
      !durable.alignedReadGeneration
    ) {
      throw new Error('The local aligned-read admission receipt is incomplete.');
    }
    return {
      source: {
        bamPath: durable.input.path,
        indexPath: durable.index.path,
        ...(durable.reference?.kind === 'path' ? { referencePath: durable.reference.path } : {}),
        generation: durable.alignedReadGeneration,
      },
    };
  }
  if (request.source.kind === 'htsget') {
    if (request.source.dataClass !== 'reads') {
      throw new Error('The saved htsget source does not contain aligned reads.');
    }
    const expectedFormat = durable.formatId === 'bam' ? 'BAM' : 'CRAM';
    let referencePath: string | undefined;
    if (durable.formatId === 'cram') {
      if (durable.reference?.kind !== 'path' || !durable.alignedReadReferenceGeneration) {
        throw new Error('The htsget CRAM admission receipt has no local reference generation.');
      }
      const currentReferenceGeneration = await captureAlignedReadReferenceGeneration(
        durable.reference.path,
        platform().fs.stat
      );
      if (
        !alignedReadReferenceGenerationsEqual(
          durable.alignedReadReferenceGeneration,
          currentReferenceGeneration
        )
      ) {
        throw new Error(
          'The local CRAM reference changed since this track was added. Remove it and add the current reference again.'
        );
      }
      referencePath = currentReferenceGeneration.reference.canonicalPath;
    } else if (
      durable.reference !== undefined ||
      durable.alignedReadReferenceGeneration !== undefined
    ) {
      throw new Error('The htsget BAM admission receipt contains an unexpected reference.');
    }
    const runtime = await prepareHtsgetRuntime(
      {
        endpoint: request.source.endpoint,
        resourceId: request.source.resourceId,
        dataClass: 'reads',
        format: expectedFormat,
        references: input.assemblyReferences,
        ...(request.source.authRef ? { authRef: request.source.authRef } : {}),
      },
      { signal: input.signal }
    );
    if (
      runtime.dataClass !== 'reads' ||
      runtime.format !== expectedFormat ||
      durable.uri !== `htsget:${runtime.sourceIdentity}`
    ) {
      throw new Error(
        'The htsget aligned-read source changed since it was added. Remove it and add the current source again.'
      );
    }
    requireExactAlignmentReferenceMatch({
      alignmentReferences: runtime.references,
      expectedReferences: input.assemblyReferences,
      genomeDisplayName: input.assemblyDisplayName,
      alignmentFormat: expectedFormat,
    });
    return {
      source: {
        bamPath: `htsget-runtime://${runtime.sourceIdentity}/source.${durable.formatId}`,
        ...(referencePath ? { referencePath } : {}),
        htsget: {
          sourceToken: runtime.sourceToken,
          sourceIdentity: runtime.sourceIdentity,
          format: expectedFormat,
        },
        grantExpiresAtMs: runtime.grantExpiresAtMs,
      },
      grantExpiresAtMs: runtime.grantExpiresAtMs,
    };
  }
  if (
    !isRemoteRangeLocator(request.source) ||
    !request.index ||
    !isRemoteRangeLocator(request.index)
  ) {
    throw new Error(`Aligned-read source kind ${request.source.kind} is not implemented.`);
  }
  if (durable.input?.kind !== 'url' || durable.index?.kind !== 'url') {
    throw new Error('The remote aligned-read admission receipt is incomplete.');
  }
  const sourceValidators = requireValidators(durable.expectedValidators, 'alignment');
  const indexValidators = requireValidators(durable.indexExpectedValidators, 'index');
  let referencePath: string | undefined;
  if (durable.formatId === 'cram') {
    if (durable.reference?.kind !== 'path' || !durable.alignedReadReferenceGeneration) {
      throw new Error('The remote CRAM admission receipt has no local reference generation.');
    }
    const currentReferenceGeneration = await captureAlignedReadReferenceGeneration(
      durable.reference.path,
      platform().fs.stat
    );
    if (
      !alignedReadReferenceGenerationsEqual(
        durable.alignedReadReferenceGeneration,
        currentReferenceGeneration
      )
    ) {
      throw new Error(
        'The local CRAM reference changed since this track was added. Remove it and add the current reference again.'
      );
    }
    referencePath = currentReferenceGeneration.reference.canonicalPath;
  } else if (
    durable.reference !== undefined ||
    durable.alignedReadReferenceGeneration !== undefined
  ) {
    throw new Error('The remote BAM admission receipt contains an unexpected reference.');
  }
  const indexFormat = remoteIndexFormat(request.index, durable.formatId);
  const provenanceBase = `${durable.fingerprint}:runtime`;
  const [sourceGrant, indexGrant] = await Promise.all([
    admitIndexedRangeSource(
      {
        source: indexedRangeSourceFromTrackLocator(request.source),
        formatId: durable.formatId,
        provenanceId: `${provenanceBase}:alignment`,
      },
      { signal: input.signal }
    ),
    admitIndexedRangeSource(
      {
        source: indexedRangeSourceFromTrackLocator(request.index),
        formatId: indexFormat,
        provenanceId: `${provenanceBase}:index`,
      },
      { signal: input.signal }
    ),
  ]);
  assertGrantMatches(sourceGrant, durable.input.url, sourceValidators, 'alignment');
  assertGrantMatches(indexGrant, durable.index.url, indexValidators, 'index');
  const materializedIndex = await materializeIndexedRangeSource(indexGrant, {
    signal: input.signal,
  });

  const grantExpiresAtMs = Math.min(sourceGrant.expiresAtMs, materializedIndex.expiresAtMs);
  const source: PileupSource = {
    bamPath: nativeRangeProxyUrl(
      sourceGrant,
      indexedRangeSourceResourceName(
        indexedRangeSourceFromTrackLocator(request.source),
        durable.formatId
      )
    ),
    indexPath: materializedIndex.sourcePath,
    ...(referencePath ? { referencePath } : {}),
    grantExpiresAtMs,
  };
  const header = await readAlignmentHeader(source);
  if (header.format !== durable.formatId) {
    throw new Error(
      `The admitted source is ${header.format.toUpperCase()}, not ${durable.formatId.toUpperCase()}.`
    );
  }
  requireReadableAlignmentIndex(header);
  requireExactAlignmentReferenceMatch({
    alignmentReferences: header.references,
    expectedReferences: input.assemblyReferences,
    genomeDisplayName: input.assemblyDisplayName,
    alignmentFormat: durable.formatId === 'cram' ? 'CRAM' : 'BAM',
  });
  return {
    source,
    grantExpiresAtMs,
  };
}

function assertGrantMatches(
  grant: IndexedRangeGrant,
  expectedUri: string,
  expected: AdmittedSourceValidators,
  label: 'alignment' | 'index'
): void {
  if (
    grant.sourceUri !== expectedUri ||
    (expected.contentLength !== undefined && grant.byteLength !== expected.contentLength) ||
    (expected.etag !== undefined && grant.etag !== expected.etag) ||
    (expected.lastModified !== undefined && grant.lastModified !== expected.lastModified)
  ) {
    throw new Error(
      `The remote aligned-read ${label} changed since it was added. Remove it and add the current source again.`
    );
  }
}

function requireValidators(
  value: AdmittedSourceValidators | undefined,
  label: 'alignment' | 'index'
): AdmittedSourceValidators {
  if (
    !value ||
    value.contentLength === undefined ||
    (value.etag === undefined && value.lastModified === undefined)
  ) {
    throw new Error(`The remote aligned-read ${label} has no stable admission validators.`);
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
  throw new Error(`The remote ${formatId.toUpperCase()} index source has an invalid suffix.`);
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
