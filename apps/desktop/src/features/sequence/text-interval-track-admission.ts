import type { LocalAuthorityContext } from '../../shared/local-indexed-track-authority';
import {
  formatInputUri,
  parseTrackAdmissionRequestV1,
  trackAdmissionRequestLabel,
  type AdmittedTrackSource,
  type ScientificTrackKind,
  type TextIntervalScientificKind,
  type TextIntervalTrackFormatId,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import { platform } from '../../platform';
import type { FilesystemStat } from '../../shared/filesystem-stat';
import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { recommendedTypesForScientificKind } from './indexed-track-admission';
import { getTextIntervalReaderWorkerClient } from './text-interval-reader-runtime';
import { MAX_TEXT_INTERVAL_SOURCE_BYTES } from './text-interval-source-decoder';
import { assertTextIntervalReferencesCompatible } from './text-interval-reference-compatibility';

const TEXT_INTERVAL_FORMATS = new Set<TextIntervalTrackFormatId>([
  'bed',
  'gff3',
  'gtf',
  'genepred',
  'refflat',
  'narrowpeak',
  'broadpeak',
]);

export async function admitTextIntervalTrackRequest(input: {
  readonly request: TrackAdmissionRequestV1;
  readonly assemblyReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly signal?: AbortSignal;
  readonly localAuthorityContext?: LocalAuthorityContext;
}): Promise<AdmittedTrackSource> {
  const parsed = parseTrackAdmissionRequestV1(input.request);
  const formatId = requireTextIntervalFormat(parsed.formatId);
  const requestedScientificKind = requireTextIntervalScientificKind(parsed.scientificKind);
  if (parsed.source.kind !== 'local-file') {
    throw new Error(
      `Remote ${formatName(formatId)} requires a tabix index and is not handled by the local whole-file adapter.`
    );
  }
  if (parsed.index || parsed.reference) {
    throw new Error(
      `${formatName(formatId)} companion indexes are reserved for the tabix regional adapter.`
    );
  }
  if (input.assemblyReferences.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this track.');
  }

  const authority = await platform().dialog.authorizeLocalIndexedTrack({
    path: parsed.source.path,
    ...(input.localAuthorityContext === 'dev-scenario-fixture' ? { devScenarioFixture: true } : {}),
    ...(input.localAuthorityContext === 'workspace-grounded' ? { workspaceGrounded: true } : {}),
  });
  const initialStat = await platform().fs.stat(authority.canonicalPath);
  assertReadableSource(initialStat, formatId);
  const bytes = await platform().fs.readFileBounded(
    authority.canonicalPath,
    MAX_TEXT_INTERVAL_SOURCE_BYTES
  );
  const finalStat = await platform().fs.stat(authority.canonicalPath);
  if (!sameFileGeneration(initialStat, finalStat)) {
    throw new Error(
      `The ${formatName(formatId)} file changed while it was being admitted. Try adding it again.`
    );
  }

  const reader = getTextIntervalReaderWorkerClient();
  const temporarySourceKey = `text-interval-admission:${crypto.randomUUID()}`;
  const header = await reader.open(
    temporarySourceKey,
    formatId,
    bytes,
    requestedScientificKind,
    input.signal
  );
  try {
    if (header.sourceByteLength !== initialStat.size) {
      throw new Error(
        `The ${formatName(formatId)} source length changed while it was being admitted.`
      );
    }
    const checkedAt = new Date().toISOString();
    const referenceReceipt = await assertTextIntervalReferencesCompatible({
      assemblyId: parsed.assemblyId,
      expected: input.assemblyReferences,
      actual: header.referenceExtents,
      checkedAt,
      formatName: formatName(formatId),
    });
    const request = parseTrackAdmissionRequestV1({
      ...parsed,
      source: {
        ...parsed.source,
        path: authority.canonicalPath,
      },
      scientificKind: header.scientificKind,
    });
    const sourceInput = { kind: 'path' as const, path: authority.canonicalPath };
    return {
      admissionVersion: 2,
      request,
      admittedAt: checkedAt,
      uri: formatInputUri(sourceInput),
      input: sourceInput,
      formatId,
      recommendedTypes: recommendedTypesForScientificKind(header.scientificKind),
      fingerprint: `${formatId}:${header.contentSha256}`,
      readerKind: 'interval-text',
      scientificKind: header.scientificKind,
      assemblyId: parsed.assemblyId,
      referenceReceipt,
      provenance: {
        provider: 'local-file',
        sourceKind: 'local-file',
        label: trackAdmissionRequestLabel(request),
        ...(input.localAuthorityContext === 'dev-scenario-fixture'
          ? { devScenarioFixture: true as const }
          : {}),
      },
      expectedValidators: { contentLength: initialStat.size },
    };
  } finally {
    await reader.closeSource(temporarySourceKey);
  }
}

export function isTextIntervalFormatId(
  value: string | undefined
): value is TextIntervalTrackFormatId {
  return typeof value === 'string' && TEXT_INTERVAL_FORMATS.has(value as TextIntervalTrackFormatId);
}

function requireTextIntervalFormat(value: string | undefined): TextIntervalTrackFormatId {
  if (!isTextIntervalFormatId(value)) {
    throw new Error(`The local interval adapter cannot admit ${value ?? 'an unknown format'}.`);
  }
  return value;
}

function requireTextIntervalScientificKind(
  value: ScientificTrackKind | undefined
): TextIntervalScientificKind | undefined {
  if (value === undefined) return undefined;
  if (value === 'transcript' || value === 'interval' || value === 'peak' || value === 'repeat') {
    return value;
  }
  throw new Error(`Text interval sources cannot be admitted as ${value}.`);
}

function assertReadableSource(stat: FilesystemStat, formatId: TextIntervalTrackFormatId): void {
  if (!stat.isFile) throw new Error(`${formatName(formatId)} source is not a regular file.`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 1) {
    throw new Error(`${formatName(formatId)} source is empty or has an invalid size.`);
  }
  if (stat.size > MAX_TEXT_INTERVAL_SOURCE_BYTES) {
    throw new Error(
      `${formatName(formatId)} source is ${stat.size} bytes; local whole-file imports are limited to ${MAX_TEXT_INTERVAL_SOURCE_BYTES} bytes. Use a tabix-indexed source for larger files.`
    );
  }
}

function sameFileGeneration(left: FilesystemStat, right: FilesystemStat): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function formatName(formatId: TextIntervalTrackFormatId): string {
  switch (formatId) {
    case 'gff3':
      return 'GFF3';
    case 'gtf':
      return 'GTF';
    case 'genepred':
      return 'genePred';
    case 'refflat':
      return 'refFlat';
    case 'narrowpeak':
      return 'narrowPeak';
    case 'broadpeak':
      return 'broadPeak';
    case 'bed':
      return 'BED';
  }
}
