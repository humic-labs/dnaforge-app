import { createHash } from 'node:crypto';

import type {
  ExternalZipEntryEvidence,
  LinkedItemRecoveryObjectType,
  SourceObject,
  ValidationLinkedItemRecoveryTargetEvidence,
} from '../../shared/benchling-migration';
import { ContentArchive, type ContentBlobReceipt } from './content-archive';
import type { VerifiedLocalBenchlingZipExport } from './local-export-bundle';
import {
  decodeBenchlingNativeExport,
  type NativeExportAttachmentEvidence,
} from './native-export-decoder';
import {
  inspectNativeExportArchive,
  persistNativeExportArchiveEntries,
} from './native-export-archive';
import {
  canonicalExportSuffixIdentity,
  filenameNamesExactlyOneCanonicalId,
} from './benchling-canonical-filename';
import { nativeRecordSourcePersistenceRequests } from './native-sequence-source-evidence';
import { dnaScientificFingerprint } from './native-exact-match';

export type LinkedItemRecoveryDecodedAttachment =
  | Readonly<{
      kind: 'archived';
      evidence: NativeExportAttachmentEvidence;
      blob: ContentBlobReceipt;
    }>
  | Readonly<{
      kind: 'external';
      evidence: NativeExportAttachmentEvidence;
      entry: ExternalZipEntryEvidence;
    }>;

export type LinkedItemRecoveryDecodedObject = Readonly<{
  sourceObject: SourceObject;
  sourceContentSha256: `sha256:${string}`;
  canonicalEntryPath: string;
  canonicalEntrySha256: string;
  attachments: readonly LinkedItemRecoveryDecodedAttachment[];
}>;

export type LinkedItemRecoveryDecodeResult = Readonly<{
  artifact: VerifiedLocalBenchlingZipExport;
  matched: readonly LinkedItemRecoveryDecodedObject[];
  ignoredCanonicalObjectCount: number;
}>;

export class LinkedItemRecoveryDecodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly sourceId?: string
  ) {
    super(message);
    this.name = 'LinkedItemRecoveryDecodeError';
  }
}

export async function decodeLinkedItemRecoveryExport(input: {
  artifact: VerifiedLocalBenchlingZipExport;
  archive: ContentArchive;
  capturedAt: string;
  requiredTargets: readonly ValidationLinkedItemRecoveryTargetEvidence[];
}): Promise<LinkedItemRecoveryDecodeResult> {
  const requiredById = new Map(input.requiredTargets.map((target) => [target.sourceId, target]));
  const inspected = await inspectNativeExportArchive(input.artifact.nativeExportDecoderSource);
  const canonical = inspected.entries
    .filter((entry) => !entry.isDirectory)
    .flatMap((entry) => {
      const identity = canonicalExportSuffixIdentity(entry.path);
      return identity ? [{ path: entry.path, ...identity }] : [];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const selected = canonical.filter((entry) => requiredById.has(entry.sourceId));
  for (const entry of selected) {
    assertUnambiguousSupplementaryIdentity(entry.path, entry.sourceId);
  }
  if (selected.length === 0) {
    return {
      artifact: input.artifact,
      matched: [],
      ignoredCanonicalObjectCount: canonical.length,
    };
  }

  const decoded = await decodeBenchlingNativeExport({
    source: input.artifact.nativeExportDecoderSource,
    controlMetadata: { source: 'none' },
    context: {
      snapshotId: `linked-item-recovery:${plainSha256(input.artifact.sha256)}`,
      capturedAt: normalizedTimestamp(input.capturedAt),
      archivePartId: `supplemental-local-export:${plainSha256(input.artifact.sha256)}`,
      sourceUrlPrefix: null,
      localBundleAuthority: {
        schema: 'dnaforge.benchling.local-native-export-authority.v1',
        logicalFilename: input.artifact.logicalFilename,
        sha256: input.artifact.sha256,
      },
      selectedEntryPaths: selected.map((entry) => entry.path),
    },
  });

  const selectedByPath = new Map(selected.map((entry) => [entry.path, entry]));
  const entryEvidenceByPath = new Map(decoded.entries.map((entry) => [entry.path, entry]));
  const decodedById = new Map<string, SourceObject[]>();
  for (const sourceObject of decoded.sourceObjects) {
    const selectedEntry = sourceObject.sourcePath
      ? selectedByPath.get(sourceObject.sourcePath)
      : undefined;
    if (
      !selectedEntry ||
      sourceObject.id !== selectedEntry.sourceId ||
      sourceObject.stableId !== selectedEntry.sourceId
    ) {
      throw new LinkedItemRecoveryDecodeError(
        'linked_item_recovery_identity_mismatch',
        'A supplementary export object does not match its exact requested stable ID.',
        selectedEntry?.sourceId
      );
    }
    const target = requiredById.get(selectedEntry.sourceId);
    if (!target || !sourceTypeMatchesRecoveryType(sourceObject.sourceType, target.objectType)) {
      throw new LinkedItemRecoveryDecodeError(
        'linked_item_recovery_type_mismatch',
        `Supplementary object ${selectedEntry.sourceId} does not match the type captured in the original export.`,
        selectedEntry.sourceId
      );
    }
    const list = decodedById.get(sourceObject.stableId) ?? [];
    list.push(sourceObject);
    decodedById.set(sourceObject.stableId, list);
  }

  const attachmentRequests = [
    ...decoded.attachments.map((attachment) => ({
      entryPath: attachment.entryPath,
      expectedSha256: attachment.sha256,
    })),
    ...nativeRecordSourcePersistenceRequests(decoded.sourceObjects),
  ];
  const persistedAttachments = await persistNativeExportArchiveEntries(
    inspected,
    attachmentRequests,
    input.archive
  );
  const persistedByPath = new Map(
    persistedAttachments.map((entry) => [entry.evidence.path, entry.blob] as const)
  );

  const matched: LinkedItemRecoveryDecodedObject[] = [];
  for (const selectedEntry of selected) {
    const target = requiredById.get(selectedEntry.sourceId);
    const candidates = decodedById.get(selectedEntry.sourceId) ?? [];
    if (!target || candidates.length === 0) {
      throw new LinkedItemRecoveryDecodeError(
        'linked_item_recovery_requested_object_missing',
        `The canonical file for ${selectedEntry.sourceId} did not decode to that object.`,
        selectedEntry.sourceId
      );
    }
    const normalized = candidates.map((candidate) =>
      normalizeRecoveredSourceObject(candidate, target, input.artifact)
    );
    const fingerprints = new Set(normalized.map(scientificSourceObjectSha256));
    if (fingerprints.size !== 1) {
      throw new LinkedItemRecoveryDecodeError(
        'linked_item_recovery_conflicting_representations',
        `The supplementary export contains conflicting representations for ${selectedEntry.sourceId}.`,
        selectedEntry.sourceId
      );
    }
    if (matched.some((candidate) => candidate.sourceObject.stableId === selectedEntry.sourceId)) {
      continue;
    }
    const [sourceObject] = normalized;
    if (!sourceObject) continue;
    const canonicalEvidence = entryEvidenceByPath.get(selectedEntry.path);
    if (!canonicalEvidence) {
      throw new LinkedItemRecoveryDecodeError(
        'linked_item_recovery_entry_evidence_missing',
        `The supplementary export has no verified entry evidence for ${selectedEntry.sourceId}.`,
        selectedEntry.sourceId
      );
    }
    const attachments = decoded.attachments
      .filter((attachment) => attachment.sourceObjectId === selectedEntry.sourceId)
      .map((evidence) => {
        const blob = persistedByPath.get(evidence.entryPath);
        if (!blob) {
          throw new LinkedItemRecoveryDecodeError(
            'linked_item_recovery_attachment_missing',
            `A verified attachment for ${selectedEntry.sourceId} was not persisted.`,
            selectedEntry.sourceId
          );
        }
        return { kind: 'archived' as const, evidence, blob };
      });
    matched.push({
      sourceObject,
      sourceContentSha256: scientificSourceObjectSha256(sourceObject),
      canonicalEntryPath: selectedEntry.path,
      canonicalEntrySha256: canonicalEvidence.sha256,
      attachments,
    });
  }

  return {
    artifact: input.artifact,
    matched: matched.sort((left, right) =>
      left.sourceObject.stableId.localeCompare(right.sourceObject.stableId)
    ),
    ignoredCanonicalObjectCount: canonical.length - selected.length,
  };
}

export function scientificSourceObjectSha256(sourceObject: SourceObject): `sha256:${string}` {
  const directDnaFingerprint = dnaScientificFingerprint(sourceObject);
  if (directDnaFingerprint) return directDnaFingerprint;
  const metadata = { ...sourceObject.metadata };
  delete metadata.nativeExport;
  delete metadata.linkedItemRecovery;
  delete metadata.workspaceAppend;
  const registry = metadata.benchlingRegistry;
  if (
    registry &&
    typeof registry === 'object' &&
    !Array.isArray(registry) &&
    'inputAuthority' in registry &&
    registry.inputAuthority === 'reviewed_local_table'
  ) {
    const science = { ...registry } as Record<string, unknown>;
    delete science.reviewedTable;
    metadata.benchlingRegistry = science;
  }
  if (
    metadata.nativeRecordClassification &&
    typeof metadata.nativeRecordClassification === 'object' &&
    !Array.isArray(metadata.nativeRecordClassification)
  ) {
    const scientificClassification = {
      ...(metadata.nativeRecordClassification as Record<string, unknown>),
    };
    delete scientificClassification.rawAccess;
    metadata.nativeRecordClassification = scientificClassification;
  }
  const content: unknown =
    sourceObject.content &&
    typeof sourceObject.content === 'object' &&
    !Array.isArray(sourceObject.content)
      ? { ...(sourceObject.content as Record<string, unknown>) }
      : sourceObject.content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const contentRecord = content as Record<string, unknown>;
    delete contentRecord.rawAccess;
    delete contentRecord.sha256;
    delete contentRecord.sizeBytes;
  }
  const scientific = {
    ...sourceObject,
    content,
    sourceUrl: '',
    sourcePath: undefined,
    memberships: [],
    relationships: [],
    metadata,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(scientific)).digest('hex')}`;
}

function normalizeRecoveredSourceObject(
  sourceObject: SourceObject,
  target: ValidationLinkedItemRecoveryTargetEvidence,
  artifact: VerifiedLocalBenchlingZipExport
): SourceObject {
  return {
    ...sourceObject,
    id: target.sourceId,
    stableId: target.sourceId,
    sourceUrl: target.sourceUrl,
    memberships: [],
    relationships: [],
    metadata: {
      ...sourceObject.metadata,
      linkedItemRecovery: {
        schema: 'dnaforge.benchling.linked-item-recovery-source.v1',
        originalZipObservedUrl: target.sourceUrl,
        supplementaryExportSha256: artifact.sha256,
      },
    },
  };
}

function assertUnambiguousSupplementaryIdentity(entryPath: string, sourceId: string): void {
  if (!filenameNamesExactlyOneCanonicalId(entryPath, sourceId)) {
    throw new LinkedItemRecoveryDecodeError(
      'linked_item_recovery_filename_identity_ambiguous',
      'A requested supplementary export filename contains ambiguous stable IDs.',
      sourceId
    );
  }
}

function sourceTypeMatchesRecoveryType(
  sourceType: string,
  expected: LinkedItemRecoveryObjectType
): boolean {
  if (expected === 'dna_rna_sequence') {
    return sourceType === 'dna_sequence' || sourceType === 'rna_sequence';
  }
  if (expected === 'protein') return sourceType === 'protein';
  if (expected === 'protocol') return sourceType === 'protocol';
  return true;
}

function normalizedTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new LinkedItemRecoveryDecodeError(
      'linked_item_recovery_timestamp_invalid',
      'Linked-item recovery timestamp is invalid.'
    );
  }
  return new Date(value).toISOString();
}

function plainSha256(value: string): string {
  const normalized = value.replace(/^sha256:/u, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new LinkedItemRecoveryDecodeError(
      'linked_item_recovery_artifact_hash_invalid',
      'Linked-item recovery artifact hash is invalid.'
    );
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
