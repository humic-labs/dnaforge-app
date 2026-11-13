import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type {
  BenchlingSourceRef,
  DirectFolderExportAuthority,
  ExportJob,
  FolderTreeExportAuthority,
  SourceObject,
  SourceRelationship,
} from '../../shared/benchling-migration';
import { isExactProviderStableId } from '../../shared/provider-object-reference';
import { canonicalExportSuffixSourceId } from './benchling-canonical-filename';
import type { NativeExportDownload } from './migration-capture-contracts';
import {
  inspectNativeExportArchive,
  readNativeExportArchiveEntries,
  walkNativeExportArchive,
  type NativeExportArchiveEntry,
  type NativeExportArchiveEntryEvidence,
  type NativeExportArchiveLimits,
  type NativeExportArchiveSource,
  type ValidatedNativeExportArchive,
} from './native-export-archive';
import {
  classifyNativeRecord,
  hasVerifiedStrainLayout,
  type NativeRecordClassification,
} from './native-record-classifier';
import { traceNativeExportStage } from './native-export-stage-trace';
import { extractOligoClassificationEvidence } from './oligo-classification-evidence';
import { buildProtocolRunProjection, type ProtocolRunDocument } from './protocol-run-projection';
import { EMBEDDED_ENTRY_REFERENCE_RELATION_TYPE } from './relationship-resolver';
import { restrictScopedNotebookArchiveSourceObjects } from './scoped-notebook-archive';
import {
  isUrlWithinBenchlingOrganization,
  parseExactlyOneBenchlingObjectUrl,
} from './source-identity';

export const BENCHLING_NATIVE_EXPORT_DECODER_VERSION = 'benchling-native-export-decoder.v3';
const MANIFEST_SCHEMA = 'benchling.native-export-manifest.v1';
const REGISTRY_SCHEMA = 'benchling.registry-schema.v1';
const REGISTRY_METADATA_KEY = 'benchlingRegistry';
const CONTROL_ENTRY_LIMIT = 8 * 1024 * 1024;
const CONTROL_TOTAL_LIMIT = 32 * 1024 * 1024;
const STRUCTURED_ENTRY_LIMIT = 16 * 1024 * 1024;
const GENERIC_PREVIEW_LIMIT = 2_000;
const FILE_LOCAL_DECODE_FAILURES = new Set([
  'native_export_text_not_utf8',
  'native_export_protocol_execution_too_large',
  'native_export_protocol_execution_format_unsupported',
  'native_export_protocol_execution_json_malformed',
  'native_export_protocol_execution_invalid',
]);
const BENCHLING_ID = /\b(?:seq|etr|prt|prtn|ent|lib|bfi|efl|run)_[A-Za-z0-9]+\b/;
const BENCHLING_FOLDER_ID_PREFIXES = new Set(['lib']);
const BENCHLING_INTERNAL_LINK_ATTRIBUTE = 'data-internal-link';
const BENCHLING_INTERNAL_LINK_LIMIT = 4_096;
const BENCHLING_INTERNAL_LINK_TARGET_ID = /^(?:seq|etr|prt|prtn)_[A-Za-z0-9]{3,64}$/u;

export const BENCHLING_NATIVE_EXPORT_UNSUPPORTED_SUBSET = [
  'Encrypted or multi-disk archives, symlinks, special files, and compression methods other than stored or deflate are rejected; safe ZIP64 is accepted.',
  'XLSX registry tables are preserved as generic artifacts; CSV, TSV, JSON, and JSONL are the supported registry table subset.',
  'Multi-record GenBank files are not split; the first parsed record is imported and the immutable source file remains archived.',
  'Registry tables without a normalized benchling.registry-schema.v1 sidecar are preserved as generic artifacts, not claimed as native registry records.',
  'Protocol execution records require canonical ProtocolRun input JSON; malformed, non-JSON, and oversized execution payloads fail closed instead of becoming generic artifacts.',
  'Benchling-specific widget runtimes are not interpreted; their files and inline HTML are preserved as generic artifacts.',
] as const;

export async function verifiedStrainCompanionKeys(
  archive: ValidatedNativeExportArchive
): Promise<ReadonlySet<string>> {
  const htmlKeys = new Set(
    archive.entries.flatMap((entry) => {
      const sourceId = canonicalExportSuffixSourceId(entry.path);
      return !entry.isDirectory && sourceId?.startsWith('bfi_') && /\.html?$/iu.test(entry.path)
        ? [`${sourceId}\0${path.posix.dirname(entry.path)}`]
        : [];
    })
  );
  const candidates = new Map(
    archive.entries.flatMap((entry) => {
      const sourceId = canonicalExportSuffixSourceId(entry.path);
      if (
        entry.isDirectory ||
        !sourceId?.startsWith('bfi_') ||
        !isExactProviderStableId(sourceId) ||
        !/\.txt$/iu.test(entry.path)
      )
        return [];
      const key = `${sourceId}\0${path.posix.dirname(entry.path)}`;
      return htmlKeys.has(key) && entry.uncompressedSize <= STRUCTURED_ENTRY_LIMIT
        ? [[entry.path, key] as const]
        : [];
    })
  );
  const verifiedKeys = new Set<string>();
  if (candidates.size === 0) return verifiedKeys;
  await walkNativeExportArchive(
    archive,
    (entry) =>
      candidates.has(entry.path)
        ? { kind: 'full', maxBytes: STRUCTURED_ENTRY_LIMIT }
        : { kind: 'none' },
    (entry, bytes) => {
      const key = candidates.get(entry.path);
      if (!key || !bytes) return;
      let text: string;
      try {
        text = decodeUtf8(bytes, entry.path, false);
      } catch (error) {
        if (
          error instanceof NativeExportDecodeError &&
          error.code === 'native_export_text_not_utf8'
        )
          return;
        throw error;
      }
      if (hasVerifiedStrainLayout(text)) verifiedKeys.add(key);
    }
  );
  return verifiedKeys;
}

export type NativeExportDecodeJob = Pick<
  ExportJob,
  | 'id'
  | 'contentFamily'
  | 'sourceRoots'
  | 'matchSignature'
  | 'receiptId'
  | 'receiptSource'
  | 'receiptConfirmationId'
  | 'downloadUrlHash'
  | 'directFolderAuthority'
  | 'folderTreeAuthority'
>;

export type NativeExportDirectFolderItemAuthority = {
  authority: DirectFolderExportAuthority;
  itemSourceUrl: string;
  membershipAuthorityUrl: string;
};

export type NativeExportFolderTreeItemAuthority = {
  authority: FolderTreeExportAuthority;
  itemSourceUrl: string;
  rootAuthorityUrl: string;
};

type NativeExportDecodeContextBase = {
  snapshotId: string;
  capturedAt: string;
  archivePartId: string;
};

export type NativeExportDecodeContext = NativeExportDecodeContextBase & {
  sourceUrlPrefix: string;
  defaultMemberships?: readonly string[];
  selectedFileRoot?: BenchlingSourceRef;
  directFolderItemAuthority?: NativeExportDirectFolderItemAuthority;
  folderTreeItemAuthority?: NativeExportFolderTreeItemAuthority;
};

export type LocalNativeExportBundleAuthority = Readonly<{
  schema: 'dnaforge.benchling.local-native-export-authority.v1';
  logicalFilename: string;
  sha256: `sha256:${string}`;
}>;

export type LocalNativeExportDecodeContext = NativeExportDecodeContextBase & {
  sourceUrlPrefix: null;
  localBundleAuthority: LocalNativeExportBundleAuthority;
  selectedEntryPaths?: readonly string[];
  fallbackEntryPaths?: readonly string[];
  defaultMemberships?: never;
  selectedFileRoot?: never;
  directFolderItemAuthority?: never;
  folderTreeItemAuthority?: never;
};

type AnyNativeExportDecodeContext = NativeExportDecodeContext | LocalNativeExportDecodeContext;

export type NativeExportAttachmentEvidence = {
  sourceObjectId: string;
  sourceRef: string;
  entryPath: string;
  logicalFilename: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
};

export type NativeExportUnsupportedEvidence = {
  entryPath: string;
  reason: string;
  preservedSourceObjectId: string;
};

export type NativeExportControlMetadata =
  | { source: 'none' }
  | { source: 'archive'; trust: 'synthetic_replay_fixture' };

type DecodedNativeExportEvidenceBase = Omit<NativeExportDownload, 'rawParts' | 'result'> & {
  archive: {
    logicalFilename: string;
    sha256: string;
    sizeBytes: number;
    totalCompressedEntryBytes: number;
    totalUncompressedEntryBytes: number;
  };
  entries: NativeExportArchiveEntryEvidence[];
  attachments: NativeExportAttachmentEvidence[];
  unsupported: NativeExportUnsupportedEvidence[];
  decoderVersion: typeof BENCHLING_NATIVE_EXPORT_DECODER_VERSION;
};

export type DecodedProviderExportEvidence = DecodedNativeExportEvidenceBase & {
  result: NativeExportDownload['result'];
};

export type DecodedLocalNativeExportEvidence = DecodedNativeExportEvidenceBase & {
  localBundleAuthority: LocalNativeExportBundleAuthority;
};

export type DecodeBenchlingNativeExportInput = {
  source: NativeExportArchiveSource;
  job: NativeExportDecodeJob;
  context: NativeExportDecodeContext;
  controlMetadata: NativeExportControlMetadata;
  archiveLimits?: Partial<NativeExportArchiveLimits>;
};

export type DecodeLocalBenchlingNativeExportInput = {
  source: NativeExportArchiveSource;
  inspectedArchive?: ValidatedNativeExportArchive;
  context: LocalNativeExportDecodeContext;
  controlMetadata: { source: 'none' };
  archiveLimits?: Partial<NativeExportArchiveLimits>;
};

export type NativeExportDecodeProgress = Readonly<{
  completed: number;
  total: number;
}>;

export type NativeExportDecodeProgressListener = (progress: NativeExportDecodeProgress) => void;

type AnyDecodeBenchlingNativeExportInput =
  | DecodeBenchlingNativeExportInput
  | DecodeLocalBenchlingNativeExportInput;

type NativeExportPackageLinkEvidence = {
  archiveEntryPaths: ReadonlySet<string>;
  attachmentReferences: ReadonlySet<string>;
};

type ManifestObject = {
  id: string;
  type: string;
  name: string;
  path: string;
  sourceUrl?: string;
  schemaId?: string;
  registryId?: string;
  aliases: string[];
  memberships: string[];
  createdAt?: string;
  modifiedAt?: string;
  versionId?: string;
  metadata: Record<string, unknown>;
  attachments: Array<{ path: string; sourceRef: string; mediaType?: string }>;
  relationships: SourceRelationship[];
};

type RegistrySchemaSidecar = {
  sourceSchemaId: string;
  sourceRevisionId: string;
  sourceRevisionNumber?: number | string;
  name: string;
  displayName: string;
  description?: string | null;
  fields: Array<{
    sourceFieldId: string;
    definition: Record<string, unknown>;
    rules?: Record<string, unknown>;
  }>;
  rules?: Record<string, unknown>;
  recordPaths: string[];
};

type AttachmentOwner = {
  ownerPath: string;
  sourceRef: string;
  mediaType?: string;
};

export class NativeExportDecodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly entryPath?: string
  ) {
    super(message);
    this.name = 'NativeExportDecodeError';
  }
}

export function decodeBenchlingNativeExport(
  input: DecodeLocalBenchlingNativeExportInput,
  onProgress?: NativeExportDecodeProgressListener
): Promise<DecodedLocalNativeExportEvidence>;
export function decodeBenchlingNativeExport(
  input: DecodeBenchlingNativeExportInput,
  onProgress?: NativeExportDecodeProgressListener
): Promise<DecodedProviderExportEvidence>;
export async function decodeBenchlingNativeExport(
  input: AnyDecodeBenchlingNativeExportInput,
  onProgress?: NativeExportDecodeProgressListener
): Promise<DecodedProviderExportEvidence | DecodedLocalNativeExportEvidence> {
  const context: AnyNativeExportDecodeContext =
    input.context.sourceUrlPrefix === null
      ? validateContext(input.context)
      : validateContext(input.context);
  const localBundleAuthority = isLocalDecodeContext(context) ? context.localBundleAuthority : null;
  const job = 'job' in input ? validateJob(input.job) : null;
  const controlMetadata = validateControlMetadata(input.controlMetadata);
  if (job && isLocalDecodeContext(context)) {
    throw new NativeExportDecodeError(
      'native_export_local_bundle_authority_invalid',
      'Local export decode cannot carry provider job evidence.'
    );
  }
  if (job && !isLocalDecodeContext(context)) assertSelectedAuthorityMatchesJob(job, context);
  const contentFamily = job?.contentFamily ?? 'notebook';
  traceNativeExportStage('decode_first_inspect_start');
  const archive =
    'inspectedArchive' in input && input.inspectedArchive
      ? matchingInspectedLocalArchive(input.source, input.inspectedArchive, input.archiveLimits)
      : await inspectNativeExportArchive(input.source, input.archiveLimits);
  traceNativeExportStage('decode_first_inspect_complete', { count: archive.entries.length });
  if (
    localBundleAuthority &&
    (archive.logicalFilename !== localBundleAuthority.logicalFilename ||
      archive.sha256 !== localBundleAuthority.sha256)
  ) {
    throw new NativeExportDecodeError(
      'native_export_local_bundle_authority_invalid',
      'Local export authority does not match the verified archive.'
    );
  }
  const catalogByPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const archiveControlPaths = archive.entries
    .filter((entry) => !entry.isDirectory && isControlPath(entry.path))
    .map((entry) => entry.path);
  const archiveControlPathSet = new Set(archiveControlPaths);
  const trustedControlPaths = controlMetadata.source === 'archive' ? archiveControlPaths : [];
  traceNativeExportStage('decode_control_read_start', {
    count: trustedControlPaths.length,
    empty: trustedControlPaths.length === 0,
  });
  const controlBytes = await readNativeExportArchiveEntries(
    archive,
    trustedControlPaths,
    CONTROL_ENTRY_LIMIT,
    CONTROL_TOTAL_LIMIT
  );
  traceNativeExportStage('decode_control_read_complete', {
    count: controlBytes.size,
    empty: trustedControlPaths.length === 0,
  });
  const manifest = parseManifest(controlBytes, catalogByPath);
  const manifestByPath = new Map(manifest.map((object) => [object.path, object]));
  const registrySchemas = parseRegistrySchemas(controlBytes, catalogByPath);
  const schemaByRecordPath = indexRegistrySchemas(registrySchemas);
  const attachmentOwners = planAttachmentOwners(archive.entries, manifest, manifestByPath);
  const selectedLocalEntryPaths =
    localBundleAuthority && isLocalDecodeContext(context) && context.selectedEntryPaths
      ? new Set(context.selectedEntryPaths)
      : null;
  const fallbackEntryPaths =
    isLocalDecodeContext(context) && context.fallbackEntryPaths
      ? new Set(context.fallbackEntryPaths)
      : new Set<string>();
  if (
    fallbackEntryPaths.size !==
      (isLocalDecodeContext(context) ? (context.fallbackEntryPaths?.length ?? 0) : 0) ||
    [...fallbackEntryPaths].some(
      (entryPath) =>
        !selectedLocalEntryPaths?.has(entryPath) ||
        !catalogByPath.get(entryPath) ||
        catalogByPath.get(entryPath)?.isDirectory
    )
  ) {
    throw new NativeExportDecodeError(
      'native_export_fallback_selection_invalid',
      'Fallback entries must be distinct selected files in the verified ZIP.'
    );
  }
  const progressTotal = selectedLocalEntryPaths?.size ?? 0;
  const progressedEntryPaths = new Set<string>();
  let progressCompleted = 0;
  if (progressTotal > 0) onProgress?.({ completed: 0, total: progressTotal });
  if (selectedLocalEntryPaths) {
    planLocalFlatSiblingAttachments(archive.entries, selectedLocalEntryPaths, attachmentOwners);
  }
  if (!isLocalDecodeContext(context)) {
    planSelectedNotebookOrphanHtmlAttachments(
      archive.entries,
      manifestByPath,
      attachmentOwners,
      context
    );
  }
  const attachmentPaths = new Set(
    [...attachmentOwners]
      .filter(
        ([, owners]) =>
          !selectedLocalEntryPaths ||
          owners.some((owner) => selectedLocalEntryPaths.has(owner.ownerPath))
      )
      .map(([entryPath]) => entryPath)
  );
  const packageLinkEvidence: NativeExportPackageLinkEvidence = {
    archiveEntryPaths: new Set(
      archive.entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => normalizePackageLinkPath(entry.path))
        .filter((entryPath): entryPath is string => entryPath !== null)
    ),
    attachmentReferences: new Set(
      [...attachmentOwners.values()]
        .flatMap((owners) => owners.map((owner) => normalizePackageLinkPath(owner.sourceRef)))
        .filter((sourceRef): sourceRef is string => sourceRef !== null)
    ),
  };
  const sourceObjects: SourceObject[] = [];
  const sourceObjectByEntry = new Map<string, SourceObject[]>();
  const entryEvidence: NativeExportArchiveEntryEvidence[] = [];
  const attachmentEvidence: NativeExportAttachmentEvidence[] = [];
  const unsupported: NativeExportUnsupportedEvidence[] = [];

  traceNativeExportStage('decode_walk_start', { count: archive.entries.length });
  await walkNativeExportArchive(
    archive,
    (entry) =>
      archiveControlPathSet.has(entry.path)
        ? { kind: 'none' }
        : selectedLocalEntryPaths &&
            !selectedLocalEntryPaths.has(entry.path) &&
            !attachmentPaths.has(entry.path)
          ? { kind: 'none' }
          : capturePolicy(
              entry,
              contentFamily,
              manifestByPath.has(entry.path),
              schemaByRecordPath.has(entry.path),
              attachmentPaths.has(entry.path)
            ),
    (evidence, captured) => {
      entryEvidence.push(evidence);
      if (selectedLocalEntryPaths?.has(evidence.path) && !progressedEntryPaths.has(evidence.path)) {
        progressedEntryPaths.add(evidence.path);
        progressCompleted += 1;
        if (progressCompleted === progressTotal || progressCompleted % 64 === 0) {
          onProgress?.({ completed: progressCompleted, total: progressTotal });
        }
      }
      if (archiveControlPathSet.has(evidence.path)) return;
      const owners = (attachmentOwners.get(evidence.path) ?? []).filter(
        (owner) => !selectedLocalEntryPaths || selectedLocalEntryPaths.has(owner.ownerPath)
      );
      if (owners.length > 0) {
        for (const owner of owners) {
          attachmentEvidence.push({
            sourceObjectId: owner.ownerPath,
            sourceRef: owner.sourceRef,
            entryPath: evidence.path,
            logicalFilename: path.posix.basename(evidence.path),
            mediaType: owner.mediaType ?? mediaTypeForPath(evidence.path),
            sha256: evidence.sha256,
            sizeBytes: evidence.actualSize,
          });
        }
        return;
      }
      if (selectedLocalEntryPaths && !selectedLocalEntryPaths.has(evidence.path)) return;

      const spec = manifestByPath.get(evidence.path);
      const schema = schemaByRecordPath.get(evidence.path);
      const decodeInput = {
        evidence,
        captured,
        spec,
        schema,
        family: contentFamily,
        context,
        archiveSha256: archive.sha256,
        packageLinkEvidence,
      };
      let decoded: ReturnType<typeof decodeEntry>;
      if (fallbackEntryPaths.has(evidence.path)) {
        decoded = forcedFileFallback(decodeInput, 'best_effort_fallback');
      } else {
        try {
          decoded = decodeEntry(decodeInput);
        } catch (error) {
          if (
            !isLocalDecodeContext(context) ||
            !(error instanceof NativeExportDecodeError) ||
            error.entryPath !== evidence.path ||
            !FILE_LOCAL_DECODE_FAILURES.has(error.code)
          ) {
            throw error;
          }
          decoded = forcedFileFallback(decodeInput, error.code);
        }
      }
      sourceObjects.push(...decoded.objects);
      sourceObjectByEntry.set(evidence.path, decoded.objects);
      unsupported.push(...decoded.unsupported);
    }
  );
  traceNativeExportStage('decode_walk_complete', { count: entryEvidence.length });
  if (progressTotal > 0 && progressCompleted !== progressTotal) {
    onProgress?.({ completed: progressCompleted, total: progressTotal });
  }

  const selectedIdentity =
    job && !isLocalDecodeContext(context)
      ? (bindSelectedNotebookIdentity(sourceObjects, job, context) ??
        bindSelectedSequenceIdentity(sourceObjects, job, context))
      : null;
  if (selectedIdentity) {
    const weakCollisionIdByPath = new Map(
      selectedIdentity.weakCollisionRemaps.map((entry) => [entry.entryPath, entry.nextId])
    );
    for (const evidence of unsupported) {
      const reboundWeakCollisionId = weakCollisionIdByPath.get(evidence.entryPath);
      if (reboundWeakCollisionId) {
        evidence.preservedSourceObjectId = reboundWeakCollisionId;
      } else if (evidence.preservedSourceObjectId === selectedIdentity.previousId) {
        evidence.preservedSourceObjectId = selectedIdentity.selectedId;
      }
    }
  }
  if (!selectedLocalEntryPaths) assertUniqueSourceObjects(sourceObjects);
  const scopedSourceObjects = restrictDecodedScopedNotebookArchive(sourceObjects, context);
  const scopedObjectIds = new Set(scopedSourceObjects.map((sourceObject) => sourceObject.id));
  const scopedSourceObjectByEntry = selectedLocalEntryPaths
    ? new Map(
        [...sourceObjectByEntry].filter(
          ([entryPath, objects]) => selectedLocalEntryPaths.has(entryPath) && objects.length > 0
        )
      )
    : scopedSourceObjectsByEntry(sourceObjectByEntry, scopedSourceObjects);
  const scopedAttachmentEvidence = attachmentEvidence.filter(
    (attachment) => (scopedSourceObjectByEntry.get(attachment.sourceObjectId)?.length ?? 0) > 0
  );
  const scopedUnsupported = unsupported.filter((entry) =>
    scopedObjectIds.has(entry.preservedSourceObjectId)
  );
  bindAttachments(scopedSourceObjectByEntry, scopedAttachmentEvidence);
  const sortedObjects = scopedSourceObjects.sort(compareSourceObjects);
  const sortedAttachments = scopedAttachmentEvidence
    .map((attachment) => ({
      ...attachment,
      sourceObjectId:
        sourceObjectByEntry.get(attachment.sourceObjectId)?.[0]?.id ?? attachment.sourceObjectId,
    }))
    .sort(compareAttachments);
  const sourceObjectIds = sortedObjects.map((object) => object.id);
  const evidence: DecodedNativeExportEvidenceBase = {
    snapshotId: context.snapshotId,
    capturedAt: context.capturedAt,
    sourceObjects: sortedObjects,
    manifest: {
      sourceObjectIds,
      attachmentReferences: sortedAttachments.map((attachment) => ({
        sourceObjectId: attachment.sourceObjectId,
        sha256: attachment.sha256,
      })),
      membershipReferences: sortedObjects.flatMap((sourceObject) =>
        sourceObject.memberships.map((collectionId) => ({
          sourceObjectId: sourceObject.id,
          collectionId,
        }))
      ),
    },
    archive: {
      logicalFilename: archive.logicalFilename,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      totalCompressedEntryBytes: archive.totalCompressedEntryBytes,
      totalUncompressedEntryBytes: archive.totalUncompressedEntryBytes,
    },
    entries: entryEvidence.sort((left, right) => left.path.localeCompare(right.path)),
    attachments: sortedAttachments,
    unsupported: scopedUnsupported.sort((left, right) =>
      left.entryPath.localeCompare(right.entryPath)
    ),
    decoderVersion: BENCHLING_NATIVE_EXPORT_DECODER_VERSION,
  };
  if (localBundleAuthority) {
    return { ...evidence, localBundleAuthority };
  }
  if (!job) {
    throw new NativeExportDecodeError(
      'native_export_job_invalid',
      'Provider native export decode is missing its export job.'
    );
  }
  return {
    ...evidence,
    result: {
      jobId: job.id,
      matchSignature: job.matchSignature,
      receiptId: job.receiptId,
      downloadUrlHash: job.downloadUrlHash,
      rawPartId: context.archivePartId,
    },
  };
}

function forcedFileFallback(
  input: Parameters<typeof decodeEntry>[0],
  reasonCode: string
): { objects: SourceObject[]; unsupported: NativeExportUnsupportedEvidence[] } {
  const reason =
    reasonCode === 'best_effort_fallback'
      ? 'The editable record did not pass import validation.'
      : `This file could not become an editable record (${reasonCode}).`;
  const object = genericObject(input, null, reason, true);
  return {
    objects: [object],
    unsupported: [unsupportedEvidence(object, input.evidence.path, reasonCode)],
  };
}

function matchingInspectedLocalArchive(
  source: NativeExportArchiveSource,
  inspected: ValidatedNativeExportArchive,
  archiveLimits?: Partial<NativeExportArchiveLimits>
): ValidatedNativeExportArchive {
  if (
    archiveLimits !== undefined ||
    source.kind !== 'local_path' ||
    inspected.source.kind !== 'local_path' ||
    path.resolve(source.localPath) !== path.resolve(inspected.source.localPath) ||
    source.logicalFilename !== inspected.logicalFilename ||
    source.expectedSha256 !== inspected.sha256 ||
    source.expectedSizeBytes !== inspected.sizeBytes ||
    source.duplicateSupportEntryPolicy !== inspected.source.duplicateSupportEntryPolicy
  ) {
    throw new NativeExportDecodeError(
      'native_export_local_bundle_authority_invalid',
      'The inspected local archive does not match the requested decoder source.'
    );
  }
  return inspected;
}

function scopedSourceObjectsByEntry(
  sourceObjectByEntry: ReadonlyMap<string, SourceObject[]>,
  scopedSourceObjects: readonly SourceObject[]
): Map<string, SourceObject[]> {
  const scopedObjectById = new Map(
    scopedSourceObjects.map((sourceObject) => [sourceObject.id, sourceObject] as const)
  );
  return new Map(
    [...sourceObjectByEntry]
      .map(
        ([entryPath, objects]) =>
          [
            entryPath,
            objects
              .map((sourceObject) => scopedObjectById.get(sourceObject.id))
              .filter((sourceObject): sourceObject is SourceObject => sourceObject !== undefined),
          ] as const
      )
      .filter(([, objects]) => objects.length > 0)
  );
}

function decodeEntry(input: {
  evidence: NativeExportArchiveEntryEvidence;
  captured: Uint8Array | null;
  spec?: ManifestObject;
  schema?: RegistrySchemaSidecar;
  family: string;
  context: AnyNativeExportDecodeContext;
  archiveSha256: string;
  packageLinkEvidence: NativeExportPackageLinkEvidence;
}): { objects: SourceObject[]; unsupported: NativeExportUnsupportedEvidence[] } {
  const { evidence, spec, schema } = input;
  const extension = path.posix.extname(evidence.path).toLowerCase();
  const sourceType = normalizeType(spec?.type ?? input.family);
  if (!input.captured) {
    if (isProtocolExecutionSourceType(sourceType)) {
      throw new NativeExportDecodeError(
        'native_export_protocol_execution_too_large',
        `Protocol execution ${evidence.path} exceeds the bounded canonical decoder limit.`,
        evidence.path
      );
    }
    const generic = genericObject(input, null, 'Entry exceeded the structured parser subset.');
    return {
      objects: [generic],
      unsupported: [unsupportedEvidence(generic, evidence.path, 'structured_entry_too_large')],
    };
  }
  const text = decodeUtf8(input.captured, evidence.path, false);
  if (isProtocolExecutionSourceType(sourceType)) {
    if (extension !== '.json') {
      throw new NativeExportDecodeError(
        'native_export_protocol_execution_format_unsupported',
        `Protocol execution ${evidence.path} must use the canonical JSON representation.`,
        evidence.path
      );
    }
    return { objects: [decodeProtocolExecution(input, text)], unsupported: [] };
  }
  const classifierBase = sourceObjectBase(
    input,
    input.spec?.name ?? path.posix.basename(input.evidence.path, extension)
  );
  const classification = classifyNativeRecord({
    sourceObject: classifierBase,
    rawText: text,
    rawSha256: input.evidence.sha256,
    rawSizeBytes: input.evidence.actualSize,
    rawAccess: {
      archivePartId: input.context.archivePartId,
      entryPath: input.evidence.path,
    },
  });
  if (classification.classification === 'benchling_strain') {
    return {
      objects: [classifiedNativeRecord(classifierBase, classification)],
      unsupported: [],
    };
  }
  if (classification.classification === 'dna_sequence_needs_sequence') {
    const native = classifiedNativeRecord(classifierBase, classification);
    const metadata = classification.parsedContent.genbankMetadata;
    return {
      objects: [
        {
          ...native,
          name: humanReadableSequenceName(
            input.evidence.path,
            metadata.locus.name,
            metadata.definition
          ),
        },
      ],
      unsupported: [],
    };
  }
  if (classification.classification === 'unsupported') {
    const generic = genericObject(input, text, classification.reason);
    return {
      objects: [generic],
      unsupported: [
        unsupportedEvidence(
          generic,
          evidence.path,
          `native_record_classifier:${classification.reason}`
        ),
      ],
    };
  }
  try {
    if (extension === '.gb' || extension === '.gbk' || extension === '.genbank') {
      return { objects: [decodeGenBank(input, text, sourceType)], unsupported: [] };
    }
    if (['.fa', '.fasta', '.fna', '.ffn', '.faa'].includes(extension)) {
      return { objects: decodeFasta(input, text, sourceType, extension), unsupported: [] };
    }
    if (extension === '.html' || extension === '.htm') {
      return { objects: [decodeHtml(input, text, sourceType)], unsupported: [] };
    }
    if (schema && ['.csv', '.tsv', '.json', '.jsonl'].includes(extension)) {
      return { objects: decodeRegistryTable(input, text, schema, extension), unsupported: [] };
    }
    if (isRegistryFamily(sourceType) && ['.csv', '.tsv', '.json', '.jsonl'].includes(extension)) {
      const generic = genericObject(
        input,
        text,
        'Registry table has no supported normalized schema sidecar.'
      );
      return {
        objects: [generic],
        unsupported: [unsupportedEvidence(generic, evidence.path, 'registry_schema_missing')],
      };
    }
    const generic = genericObject(input, text, 'No supported native parser matched this entry.');
    return {
      objects: [generic],
      unsupported: [unsupportedEvidence(generic, evidence.path, 'unsupported_native_entry')],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const generic = genericObject(input, text, `Native parse exception: ${reason}`);
    return {
      objects: [generic],
      unsupported: [unsupportedEvidence(generic, evidence.path, `parse_exception:${reason}`)],
    };
  }
}

function classifiedNativeRecord(
  base: SourceObject,
  classification: Extract<
    NativeRecordClassification,
    { classification: 'benchling_strain' | 'dna_sequence_needs_sequence' }
  >
): SourceObject {
  return {
    ...base,
    sourceType: classification.classification === 'benchling_strain' ? 'strain' : 'dna_sequence',
    name:
      classification.classification === 'benchling_strain'
        ? classification.parsedContent.displayName
        : base.name,
    metadata: {
      ...base.metadata,
      nativeRecordClassification: {
        classifierVersion: classification.converterVersion,
        converterId: classification.converterId,
        originalSourceType: classification.originalSourceType,
        providerObjectClass: classification.providerObjectClass,
        normalizedNativeKind: classification.normalizedNativeKind,
        rawSha256: classification.rawSha256,
        rawSizeBytes: classification.rawSizeBytes,
        rawAccess: classification.rawAccess,
      },
    },
    content: classification.parsedContent,
  };
}

function decodeProtocolExecution(
  input: Parameters<typeof decodeEntry>[0],
  text: string
): SourceObject {
  let content: unknown;
  try {
    content = JSON.parse(text);
  } catch {
    throw new NativeExportDecodeError(
      'native_export_protocol_execution_json_malformed',
      `Protocol execution ${input.evidence.path} is not valid JSON.`,
      input.evidence.path
    );
  }

  const base = sourceObjectBase(
    input,
    input.spec?.name ?? path.posix.basename(input.evidence.path, '.json')
  );
  const candidate: SourceObject = {
    ...base,
    sourceType: 'protocol_execution',
    content,
  };
  let document: ProtocolRunDocument;
  try {
    document = buildProtocolRunProjection(candidate, {
      capturedAt: input.context.capturedAt,
      converterVersion: BENCHLING_NATIVE_EXPORT_DECODER_VERSION,
    }).document;
  } catch {
    throw new NativeExportDecodeError(
      'native_export_protocol_execution_invalid',
      `Protocol execution ${input.evidence.path} failed canonical validation.`,
      input.evidence.path
    );
  }

  return {
    ...candidate,
    content: protocolExecutionContent(document),
  };
}

function protocolExecutionContent(document: ProtocolRunDocument): Record<string, unknown> {
  return {
    status: document.status,
    protocol: {
      sourceId: document.protocol.sourceId,
      destinationId: document.protocol.destinationId,
      name: document.protocol.name,
      versionId: document.protocol.pinnedVersionId,
      versionHash: document.protocol.pinnedVersionHash,
    },
    inputs: document.inputs,
    outputs: document.outputs,
    measurements: document.measurements,
    tables: document.tables.map((table) => ({
      id: table.id,
      name: table.name,
      cells: table.cells,
    })),
    links: document.links,
    startedAt: document.startedAt,
    completedAt: document.completedAt,
  };
}

function decodeGenBank(
  input: Parameters<typeof decodeEntry>[0],
  text: string,
  sourceType: string
): SourceObject {
  const parsed = parseGenBankFull(text, { featurePolicy: 'preserve' });
  if (!parsed.sequence) throw new Error('GenBank record has no sequence.');
  const moleculeType =
    isExplicitRnaSourceType(sourceType) || /^LOCUS\s+.*\bbp\s+RNA\b/im.test(text) ? 'RNA' : 'DNA';
  const base = sourceObjectBase(
    input,
    humanReadableSequenceName(input.evidence.path, parsed.name, parsed.description)
  );
  return {
    ...base,
    sourceType: moleculeType === 'RNA' ? 'rna_sequence' : 'dna_sequence',
    content: {
      moleculeType,
      bases: parsed.sequence.toUpperCase(),
      topology: parsed.circular ? 'circular' : 'linear',
      description: parsed.description,
      sizeBytes: input.evidence.actualSize,
      sha256: input.evidence.sha256,
      rawAccess: {
        archivePartId: input.context.archivePartId,
        entryPath: input.evidence.path,
      },
      annotations: parsed.annotations.map((annotation) => ({
        type: annotation.type,
        label: annotation.label ?? annotation.name,
        start: annotation.start,
        end: annotation.end,
        strand: annotation.direction,
        color: annotation.color,
        qualifiers: annotation.qualifiers ?? {},
        translations: annotation.qualifiers?.translation ?? [],
        ...(annotation.segments ? { segments: annotation.segments } : {}),
      })),
    },
  };
}

function humanReadableSequenceName(
  entryPath: string,
  parsedName: string,
  parsedDescription: string | undefined
): string {
  const extension = path.posix.extname(entryPath);
  const stem = path.posix.basename(entryPath, extension).trim();
  const withoutSuffix = stem
    .replace(new RegExp(`\\s*\\(${BENCHLING_ID.source}\\)\\s*$`, 'u'), '')
    .trim();
  if (withoutSuffix && !new RegExp(`^${BENCHLING_ID.source}$`, 'u').test(withoutSuffix)) {
    return withoutSuffix;
  }
  const description = parsedDescription?.trim().replace(/\.$/u, '').trim();
  if (description && !new RegExp(`^${BENCHLING_ID.source}$`, 'u').test(description)) {
    return description;
  }
  return parsedName;
}

function decodeFasta(
  input: Parameters<typeof decodeEntry>[0],
  text: string,
  sourceType: string,
  extension: string
): SourceObject[] {
  const records = parseFasta(text);
  if (input.spec && records.length !== 1) {
    throw new Error('Manifest-mapped FASTA must contain exactly one record.');
  }
  return records.map((record, index) => {
    const recordInput =
      index === 0
        ? input
        : {
            ...input,
            spec: undefined,
            evidence: { ...input.evidence, path: `${input.evidence.path}#${index + 1}` },
          };
    const base = sourceObjectBase(recordInput, record.name);
    const benchlingProteinIdentity = /^(?:prt|prtn)_[A-Za-z0-9]+$/u.test(base.stableId);
    const protein =
      extension === '.faa' || sourceType.includes('protein') || benchlingProteinIdentity;
    if (protein) {
      return {
        ...base,
        id:
          input.spec || benchlingProteinIdentity
            ? base.id
            : stableIdFrom(record.id, recordInput.evidence.path, input.evidence.sha256),
        stableId:
          input.spec || benchlingProteinIdentity
            ? base.stableId
            : stableIdFrom(record.id, recordInput.evidence.path, input.evidence.sha256),
        sourceType: 'protein',
        content: { aminoAcids: record.sequence.toUpperCase(), description: record.description },
      };
    }
    const rna = isExplicitRnaSourceType(sourceType) || /U/i.test(record.sequence);
    return {
      ...base,
      id: input.spec
        ? base.id
        : stableIdFrom(record.id, recordInput.evidence.path, input.evidence.sha256),
      stableId: input.spec
        ? base.stableId
        : stableIdFrom(record.id, recordInput.evidence.path, input.evidence.sha256),
      sourceType: rna ? 'rna_sequence' : 'dna_sequence',
      content: {
        moleculeType: rna ? 'RNA' : 'DNA',
        bases: record.sequence.toUpperCase(),
        topology: 'linear',
        description: record.description,
        annotations: [],
      },
    };
  });
}

function isExplicitRnaSourceType(sourceType: string): boolean {
  return ['rna', 'rna_oligo', 'rna_sequence'].includes(sourceType);
}

function decodeHtml(
  input: Parameters<typeof decodeEntry>[0],
  html: string,
  sourceType: string
): SourceObject {
  const name =
    input.spec?.name ?? firstHtmlHeading(html) ?? path.posix.basename(input.evidence.path);
  const base = sourceObjectBase(input, name);
  base.metadata.classificationEvidence = extractOligoClassificationEvidence({
    html,
    sourceObjectId: base.id,
    sourceEntryPath: input.evidence.path,
    sourceEntrySha256: input.evidence.sha256,
  });
  const relationships = mergeRelationships(
    base.relationships,
    relationshipsFromHtml(base.id, html, {
      entryPath: input.evidence.path,
      sourceUrlPrefix: input.context.sourceUrlPrefix,
      packageLinkEvidence: input.packageLinkEvidence,
    })
  );
  if (sourceType.includes('protocol') || /^prt_/.test(base.id)) {
    const steps = protocolStepsFromHtml(html, input.evidence.sha256);
    return {
      ...base,
      sourceType: 'protocol',
      relationships,
      content: {
        versionId: input.spec?.versionId ?? `native-export:${input.evidence.sha256}`,
        overviewHtml: protocolOverviewFromHtml(html),
        steps,
        inputs: [],
        outputs: [],
        attachments: [],
      },
    };
  }
  return {
    ...base,
    sourceType: 'notebook_entry',
    relationships,
    content: { html, attachments: [] },
  };
}

function decodeRegistryTable(
  input: Parameters<typeof decodeEntry>[0],
  text: string,
  schema: RegistrySchemaSidecar,
  extension: string
): SourceObject[] {
  const rows =
    extension === '.csv' || extension === '.tsv'
      ? parseDelimited(text, extension === '.tsv' ? '\t' : ',')
      : parseJsonRows(text, extension);
  return rows.map((row, index) => {
    const idValue = firstRowValue(row, ['objectid', 'benchlingid', 'entityid', 'id']);
    const registryId = firstRowValue(row, ['registryid', 'registryidentifier']);
    const name = firstRowValue(row, ['name', 'displayname', 'label']) ?? registryId ?? idValue;
    const stableId = stableIdFrom(
      idValue,
      `${input.evidence.path}#row-${index + 1}`,
      input.evidence.sha256
    );
    const fieldValues = Object.fromEntries(
      schema.fields.map((field) => {
        const key = requiredText(field.definition.key, 'registry field key');
        const value = rowValueForField(row, field, key);
        return [key, value];
      })
    );
    const base = sourceObjectBase(
      {
        ...input,
        spec: undefined,
        evidence: { ...input.evidence, path: `${input.evidence.path}#row-${index + 1}` },
      },
      name ?? stableId
    );
    return {
      ...base,
      id: stableId,
      stableId,
      sourceType: 'registry_record',
      schemaId: schema.sourceSchemaId,
      ...(registryId ? { registryId } : {}),
      metadata: {
        ...base.metadata,
        [REGISTRY_METADATA_KEY]: {
          version: 1,
          schemaRevision: {
            sourceSchemaId: schema.sourceSchemaId,
            sourceRevisionId: schema.sourceRevisionId,
            ...(schema.sourceRevisionNumber === undefined
              ? {}
              : { sourceRevisionNumber: schema.sourceRevisionNumber }),
            name: schema.name,
            displayName: schema.displayName,
            ...(schema.description === undefined ? {} : { description: schema.description }),
            fields: schema.fields,
            ...(schema.rules === undefined ? {} : { rules: schema.rules }),
          },
          fieldValues,
          relationshipFields: [],
        },
      },
      content: { fieldValues, originalRow: sortJson(row) },
    };
  });
}

function genericObject(
  input: Parameters<typeof decodeEntry>[0],
  text: string | null,
  reason: string,
  forceFallback = false
): SourceObject {
  const base = sourceObjectBase(
    input,
    input.spec?.name ?? path.posix.basename(input.evidence.path)
  );
  return {
    ...base,
    sourceType: forceFallback
      ? 'unsupported_object'
      : normalizeType(input.spec?.type ?? 'unsupported_object'),
    metadata: {
      ...base.metadata,
      nativeParseException: reason,
    },
    content: {
      preview: text?.slice(0, GENERIC_PREVIEW_LIMIT) ?? '',
      mediaType: mediaTypeForPath(input.evidence.path),
      sizeBytes: input.evidence.actualSize,
      sha256: input.evidence.sha256,
      rawAccess: {
        archivePartId: input.context.archivePartId,
        entryPath: input.evidence.path,
      },
    },
  };
}

function sourceObjectBase(
  input: Parameters<typeof decodeEntry>[0],
  inferredName: string
): SourceObject {
  const spec = input.spec;
  const stableId = stableIdFrom(spec?.id, input.evidence.path, input.evidence.sha256);
  const memberships = sortedUnique(
    spec?.memberships?.length ? spec.memberships : (input.context.defaultMemberships ?? [])
  );
  const localBundleAuthority = isLocalDecodeContext(input.context)
    ? input.context.localBundleAuthority
    : null;
  return {
    id: stableId,
    stableId,
    sourceType: normalizeType((spec?.type ?? input.family) || 'unsupported_object'),
    ...(spec?.schemaId ? { schemaId: spec.schemaId } : {}),
    name: spec?.name ?? inferredName,
    ...(spec?.registryId ? { registryId: spec.registryId } : {}),
    aliases: sortedUnique(spec?.aliases ?? []),
    sourceUrl: decodedSourceUrl(input.context, stableId, spec?.sourceUrl),
    sourcePath: input.evidence.path,
    attachmentHashes: [],
    memberships,
    ...(spec?.createdAt ? { createdAt: spec.createdAt } : {}),
    ...(spec?.modifiedAt ? { modifiedAt: spec.modifiedAt } : {}),
    metadata: {
      ...(spec?.metadata ?? {}),
      nativeExport: {
        decoderVersion: BENCHLING_NATIVE_EXPORT_DECODER_VERSION,
        contentFamily: input.family,
        archiveSha256: input.archiveSha256,
        entryPath: input.evidence.path,
        entrySha256: input.evidence.sha256,
        entrySizeBytes: input.evidence.actualSize,
        identityMethod: spec ? 'manifest' : 'entry_evidence',
        sourceUrlMethod: spec?.sourceUrl
          ? 'manifest'
          : localBundleAuthority
            ? 'local_export_provenance_urn'
            : 'generated',
        ...(localBundleAuthority
          ? {
              localBundleProvenance: {
                schema: localBundleAuthority.schema,
                logicalFilename: localBundleAuthority.logicalFilename,
                sha256: localBundleAuthority.sha256,
              },
            }
          : {}),
      },
    },
    content: null,
    relationships: spec?.relationships ?? [],
  };
}

type SelectedNotebookAuthority =
  | { kind: 'file'; root: BenchlingSourceRef }
  | {
      kind: 'direct_folder';
      root: BenchlingSourceRef;
      directFolder: NativeExportDirectFolderItemAuthority;
    }
  | {
      kind: 'folder_tree';
      root: BenchlingSourceRef;
      folderTree: NativeExportFolderTreeItemAuthority;
    };

function selectedNotebookAuthority(
  context: NativeExportDecodeContext
): SelectedNotebookAuthority | null {
  if (context.selectedFileRoot) return { kind: 'file', root: context.selectedFileRoot };
  if (context.directFolderItemAuthority?.authority.sourceItemType === 'entry') {
    return {
      kind: 'direct_folder',
      root: {
        id: context.directFolderItemAuthority.authority.sourceItemId,
        url: context.directFolderItemAuthority.itemSourceUrl,
        objectType: 'notebook_entry',
      },
      directFolder: context.directFolderItemAuthority,
    };
  }
  if (!context.folderTreeItemAuthority) return null;
  return {
    kind: 'folder_tree',
    root: {
      id: context.folderTreeItemAuthority.authority.sourceItemId,
      url: context.folderTreeItemAuthority.itemSourceUrl,
      objectType: 'notebook_entry',
    },
    folderTree: context.folderTreeItemAuthority,
  };
}

type SelectedSequenceAuthority =
  | {
      kind: 'direct_folder';
      root: BenchlingSourceRef;
      directFolder: NativeExportDirectFolderItemAuthority;
    }
  | {
      kind: 'folder_tree';
      root: BenchlingSourceRef;
      folderTree: NativeExportFolderTreeItemAuthority;
    };

function selectedSequenceAuthority(
  context: NativeExportDecodeContext
): SelectedSequenceAuthority | null {
  const directFolder = context.directFolderItemAuthority;
  if (directFolder?.authority.sourceItemType === 'sequence') {
    return {
      kind: 'direct_folder',
      root: {
        id: directFolder.authority.sourceItemId,
        url: directFolder.itemSourceUrl,
        objectType: 'sequence',
      },
      directFolder,
    };
  }
  const folderTree = context.folderTreeItemAuthority;
  if (folderTree?.authority.sourceItemType !== 'sequence') return null;
  return {
    kind: 'folder_tree',
    root: {
      id: folderTree.authority.sourceItemId,
      url: folderTree.itemSourceUrl,
      objectType: 'sequence',
    },
    folderTree,
  };
}

function restrictDecodedScopedNotebookArchive(
  sourceObjects: readonly SourceObject[],
  context: AnyNativeExportDecodeContext
): SourceObject[] {
  if (isLocalDecodeContext(context)) return [...sourceObjects];
  if (context.directFolderItemAuthority) {
    return restrictScopedNotebookArchiveSourceObjects({
      sourceObjects,
      authority: {
        scopeKind: 'folder',
        sourceItemId: context.directFolderItemAuthority.authority.sourceItemId,
        sourceItemUrl: context.directFolderItemAuthority.itemSourceUrl,
        sourceFolderIds: context.directFolderItemAuthority.authority.sourceFolderIds,
        organizationBaseUrl: context.sourceUrlPrefix,
      },
    });
  }
  if (context.folderTreeItemAuthority) {
    return restrictScopedNotebookArchiveSourceObjects({
      sourceObjects,
      authority: {
        scopeKind: 'folder_tree',
        sourceItemId: context.folderTreeItemAuthority.authority.sourceItemId,
        sourceItemUrl: context.folderTreeItemAuthority.itemSourceUrl,
        sourceFolderIds: context.folderTreeItemAuthority.authority.sourceFolderIds,
        organizationBaseUrl: context.sourceUrlPrefix,
      },
    });
  }
  return [...sourceObjects];
}

function bindSelectedNotebookIdentity(
  sourceObjects: SourceObject[],
  job: NativeExportDecodeJob,
  context: NativeExportDecodeContext
): {
  previousId: string;
  selectedId: string;
  weakCollisionRemaps: Array<{ entryPath: string; nextId: string }>;
} | null {
  const selection = selectedNotebookAuthority(context);
  if (!selection) return null;
  const selected = selection.root;

  const explicitArchiveIdentityMatches = sourceObjects.filter(
    (sourceObject) =>
      nativeExportMetadata(sourceObject).identityMethod === 'manifest' &&
      (sourceObject.id === selected.id || sourceObject.stableId === selected.id)
  );
  if (explicitArchiveIdentityMatches.length > 1) {
    throw new NativeExportDecodeError(
      'native_export_selected_file_identity_ambiguous',
      `Selected File identity ${selected.id} appears on more than one decoded source object.`
    );
  }
  if (
    explicitArchiveIdentityMatches[0] &&
    !isDecodedNotebookHtmlPrimary(explicitArchiveIdentityMatches[0])
  ) {
    throw new NativeExportDecodeError(
      'native_export_selected_notebook_html_missing',
      `Selected notebook identity ${selected.id} has no decoded HTML primary.`
    );
  }

  const sourceObjectsByExtension = new Map<string, SourceObject[]>();
  for (const sourceObject of sourceObjects) {
    const extension = path.posix.extname(sourceObject.sourcePath ?? '').toLowerCase();
    const matches = sourceObjectsByExtension.get(extension) ?? [];
    matches.push(sourceObject);
    sourceObjectsByExtension.set(extension, matches);
  }
  const notebookHtmlCandidates = [
    ...(sourceObjectsByExtension.get('.html') ?? []),
    ...(sourceObjectsByExtension.get('.htm') ?? []),
  ].filter((sourceObject) => sourceObject.sourceType === 'notebook_entry');
  const attachmentLikeNotebookHtmlCandidates = notebookHtmlCandidates.filter((sourceObject) =>
    hasAttachmentPathSegment(sourceObject.sourcePath ?? '')
  );
  const fixedCategoryCount =
    notebookHtmlCandidates.length +
    (sourceObjectsByExtension.get('.pdf')?.length ?? 0) +
    (sourceObjectsByExtension.get('.docx')?.length ?? 0) +
    (sourceObjectsByExtension.get('.txt')?.length ?? 0) +
    (sourceObjectsByExtension.get('.md')?.length ?? 0) +
    (sourceObjectsByExtension.get('.markdown')?.length ?? 0);
  traceNativeExportStage('selected_source_object_candidates', { count: sourceObjects.length });
  traceNativeExportStage('selected_notebook_html_candidates', {
    count: notebookHtmlCandidates.length,
  });
  traceNativeExportStage('selected_notebook_attachment_like_html_candidates', {
    count: attachmentLikeNotebookHtmlCandidates.length,
  });
  traceNativeExportStage('selected_notebook_pdf_candidates', {
    count: sourceObjectsByExtension.get('.pdf')?.length ?? 0,
  });
  traceNativeExportStage('selected_notebook_docx_candidates', {
    count: sourceObjectsByExtension.get('.docx')?.length ?? 0,
  });
  traceNativeExportStage('selected_notebook_text_candidates', {
    count:
      (sourceObjectsByExtension.get('.txt')?.length ?? 0) +
      (sourceObjectsByExtension.get('.md')?.length ?? 0) +
      (sourceObjectsByExtension.get('.markdown')?.length ?? 0),
  });
  traceNativeExportStage('selected_notebook_other_candidates', {
    count: sourceObjects.length - fixedCategoryCount,
  });

  const notebookPrimaries = notebookHtmlCandidates.filter(isDecodedNotebookHtmlPrimary);
  traceNativeExportStage('selected_notebook_primary_candidates', {
    count: notebookPrimaries.length,
  });
  if (notebookPrimaries.length > 1) {
    throw new NativeExportDecodeError(
      'native_export_selected_file_identity_ambiguous',
      `The single-entry notebook export must contain exactly one decoded notebook HTML primary; found ${notebookPrimaries.length}.`
    );
  }
  if (notebookPrimaries.length === 0) {
    throw new NativeExportDecodeError(
      'native_export_selected_notebook_html_missing',
      'The notebook export must contain one decoded HTML notebook primary.'
    );
  }
  const sourceObject = notebookPrimaries[0];
  const nativeExport = nativeExportMetadata(sourceObject);
  const exactArchiveIdentity =
    nativeExport.identityMethod === 'manifest' &&
    sourceObject.id === selected.id &&
    sourceObject.stableId === selected.id;
  const weakPathIdentity =
    sourceObject.id === sourceObject.stableId && nativeExport.identityMethod === 'entry_evidence';
  if (nativeExport.identityMethod === 'manifest' && !exactArchiveIdentity) {
    throw new NativeExportDecodeError(
      'native_export_selected_file_identity_conflict',
      `Selected File identity ${selected.id} conflicts with the explicit archive manifest identity ${sourceObject.id}.`
    );
  }
  if (!exactArchiveIdentity && !weakPathIdentity) {
    traceNativeExportStage('selected_notebook_weak_identity_missing');
    throw new NativeExportDecodeError(
      'native_export_selected_file_identity_missing',
      `Selected File identity ${selected.id} is absent from the decoded notebook export.`
    );
  }
  if (weakPathIdentity && !hasSelectedItemReceiptAuthority(job)) {
    throw new NativeExportDecodeError(
      'native_export_selected_file_authority_missing',
      `Manifestless selected identity ${selected.id} requires a successful provider task or an explicitly confirmed Gmail receipt.`
    );
  }

  const archiveSourceUrl = sanitizeSourceObjectUrl(sourceObject.sourceUrl);
  if (!isUrlWithinBenchlingOrganization(archiveSourceUrl, context.sourceUrlPrefix)) {
    throw new NativeExportDecodeError(
      'native_export_selected_file_identity_conflict',
      `Selected File identity ${selected.id} has a source URL outside the confirmed tenant.`
    );
  }
  if (
    nativeExport.sourceUrlMethod === 'manifest' &&
    archiveSourceUrl !== sanitizeSourceObjectUrl(selected.url)
  ) {
    throw new NativeExportDecodeError(
      'native_export_selected_file_identity_conflict',
      `Selected notebook identity ${selected.id} has a conflicting explicit archive URL.`
    );
  }

  const weakCollisionRemaps = rekeyWeakSelectedIdentityCollisions(
    sourceObjects,
    sourceObject,
    selected.id,
    context.sourceUrlPrefix
  );
  const previousId = sourceObject.id;
  const previousStableId = sourceObject.stableId;
  const resolvedSourceUrl = selected.url;
  sourceObject.id = selected.id;
  sourceObject.stableId = selected.id;
  sourceObject.sourceUrl = resolvedSourceUrl;
  const commonEvidence = {
    version: 1,
    sourceId: selected.id,
    sourceUrl: resolvedSourceUrl,
    objectType: 'notebook_entry',
    jobId: job.id,
    matchSignature: job.matchSignature,
    receiptSource: job.receiptSource ?? null,
    evidence: exactArchiveIdentity
      ? ('archive_identity' as const)
      : ('provider_single_entry_primary_mapping' as const),
    previousId,
    previousStableId,
    archiveIdentityMethod:
      typeof nativeExport.identityMethod === 'string' ? nativeExport.identityMethod : 'unknown',
  };
  sourceObject.metadata = {
    ...sourceObject.metadata,
    nativeExport: {
      ...nativeExport,
      ...(selection.kind === 'file'
        ? {
            identityMethod: 'selected_file_export_root',
            selectedFileRootEvidence: commonEvidence,
          }
        : selection.kind === 'direct_folder'
          ? {
              identityMethod: 'direct_folder_export_item',
              directFolderItemEvidence: {
                ...commonEvidence,
                selectedRootId: selection.directFolder.authority.selectedRootId,
                sourceItemType: selection.directFolder.authority.sourceItemType,
                sourceFolderIds: [...selection.directFolder.authority.sourceFolderIds],
                membershipAuthorityUrl: selection.directFolder.membershipAuthorityUrl,
                capturePlanDigest: selection.directFolder.authority.capturePlanDigest,
                traversalJournalDigest: selection.directFolder.authority.traversalJournalDigest,
                requestCapabilityId: selection.directFolder.authority.requestCapabilityId,
                sourceUrlMethod:
                  nativeExport.sourceUrlMethod === 'manifest'
                    ? 'explicit_manifest_exact_item_route'
                    : 'inherited_observed_item_authority',
              },
            }
          : {
              identityMethod: 'folder_tree_export_item',
              folderTreeItemEvidence: {
                ...commonEvidence,
                selectedRootId: selection.folderTree.authority.selectedRootId,
                sourceItemType: selection.folderTree.authority.sourceItemType,
                sourceFolderIds: [...selection.folderTree.authority.sourceFolderIds],
                rootAuthorityUrl: selection.folderTree.rootAuthorityUrl,
                capturePlanDigest: selection.folderTree.authority.capturePlanDigest,
                traversalJournalDigest: selection.folderTree.authority.traversalJournalDigest,
                maximumFolderDepth: selection.folderTree.authority.maximumFolderDepth,
                requestCapabilityId: selection.folderTree.authority.requestCapabilityId,
                sourceUrlMethod:
                  nativeExport.sourceUrlMethod === 'manifest'
                    ? 'explicit_manifest_exact_item_route'
                    : 'inherited_observed_item_authority',
              },
            }),
    },
  };

  for (const candidate of sourceObjects) {
    candidate.relationships = candidate.relationships.map((relationship) => {
      const sourceObjectId =
        relationship.sourceObjectId === previousId ? selected.id : relationship.sourceObjectId;
      const targetSourceId =
        relationship.targetSourceId === previousId ? selected.id : relationship.targetSourceId;
      if (
        sourceObjectId === relationship.sourceObjectId &&
        targetSourceId === relationship.targetSourceId
      ) {
        return relationship;
      }
      const rebound = {
        ...relationship,
        sourceObjectId,
        ...(targetSourceId === undefined ? {} : { targetSourceId }),
      };
      return { ...rebound, id: reboundRelationshipId(rebound) };
    });
  }
  return { previousId, selectedId: selected.id, weakCollisionRemaps };
}

function bindSelectedSequenceIdentity(
  sourceObjects: SourceObject[],
  job: NativeExportDecodeJob,
  context: NativeExportDecodeContext
): {
  previousId: string;
  selectedId: string;
  weakCollisionRemaps: Array<{ entryPath: string; nextId: string }>;
} | null {
  const selection = selectedSequenceAuthority(context);
  if (!selection) return null;
  const selected = selection.root;
  const sequenceCandidates = sourceObjects.filter((sourceObject) =>
    ['dna_sequence', 'rna_sequence'].includes(sourceObject.sourceType)
  );
  const dnaSequenceCandidates = sequenceCandidates.filter(
    (sourceObject) => sourceObject.sourceType === 'dna_sequence'
  );
  const explicitMatches = sequenceCandidates.filter(
    (sourceObject) =>
      nativeExportMetadata(sourceObject).identityMethod === 'manifest' &&
      (sourceObject.id === selected.id || sourceObject.stableId === selected.id)
  );
  if (explicitMatches.length > 1) {
    throw new NativeExportDecodeError(
      'native_export_selected_sequence_identity_ambiguous',
      `Selected sequence identity ${selected.id} appears on more than one decoded source object.`
    );
  }

  let sourceObject: SourceObject;
  let exactArchiveIdentity = false;
  if (explicitMatches.length === 1) {
    sourceObject = explicitMatches[0];
    if (sourceObject.sourceType !== 'dna_sequence') {
      throw new NativeExportDecodeError(
        'native_export_selected_sequence_identity_conflict',
        `Selected canonical DNA sequence ${selected.id} resolved to an RNA archive primary.`
      );
    }
    exactArchiveIdentity = sourceObject.id === selected.id && sourceObject.stableId === selected.id;
    if (!exactArchiveIdentity) {
      throw new NativeExportDecodeError(
        'native_export_selected_sequence_identity_conflict',
        `Selected sequence identity ${selected.id} conflicts with its explicit archive identity.`
      );
    }
  } else {
    const weakCandidates = dnaSequenceCandidates.filter((candidate) => {
      const metadata = nativeExportMetadata(candidate);
      return metadata.identityMethod === 'entry_evidence' && candidate.id === candidate.stableId;
    });
    if (sequenceCandidates.length === 1 && sequenceCandidates[0]?.sourceType === 'rna_sequence') {
      throw new NativeExportDecodeError(
        'native_export_selected_sequence_identity_conflict',
        `Selected canonical DNA sequence ${selected.id} resolved to an RNA archive primary.`
      );
    }
    if (sequenceCandidates.length !== 1 || weakCandidates.length !== 1) {
      throw new NativeExportDecodeError(
        sequenceCandidates.length > 1
          ? 'native_export_selected_sequence_identity_ambiguous'
          : 'native_export_selected_sequence_identity_missing',
        `The single-sequence export must contain exactly one deterministic DNA or RNA primary; found ${sequenceCandidates.length}.`
      );
    }
    sourceObject = weakCandidates[0];
    if (!hasSelectedItemReceiptAuthority(job)) {
      throw new NativeExportDecodeError(
        'native_export_selected_sequence_authority_missing',
        `Manifestless selected sequence ${selected.id} requires a successful provider task or an explicitly confirmed Gmail receipt.`
      );
    }
  }

  const nativeExport = nativeExportMetadata(sourceObject);
  const archiveSourceUrl = sanitizeSourceObjectUrl(sourceObject.sourceUrl);
  if (!isUrlWithinBenchlingOrganization(archiveSourceUrl, context.sourceUrlPrefix)) {
    throw new NativeExportDecodeError(
      'native_export_selected_sequence_identity_conflict',
      `Selected sequence identity ${selected.id} has a source URL outside the confirmed tenant.`
    );
  }
  if (
    nativeExport.sourceUrlMethod === 'manifest' &&
    archiveSourceUrl !== sanitizeSourceObjectUrl(selected.url)
  ) {
    throw new NativeExportDecodeError(
      'native_export_selected_sequence_identity_conflict',
      `Selected sequence identity ${selected.id} has a conflicting explicit archive URL.`
    );
  }

  const weakCollisionRemaps = rekeyWeakSelectedIdentityCollisions(
    sourceObjects,
    sourceObject,
    selected.id,
    context.sourceUrlPrefix
  );
  const previousId = sourceObject.id;
  const previousStableId = sourceObject.stableId;
  const resolvedSourceUrl = selected.url;
  sourceObject.id = selected.id;
  sourceObject.stableId = selected.id;
  sourceObject.sourceUrl = resolvedSourceUrl;
  sourceObject.metadata = {
    ...sourceObject.metadata,
    nativeExport: {
      ...nativeExport,
      ...(selection.kind === 'direct_folder'
        ? {
            identityMethod: 'direct_folder_export_item',
            directFolderItemEvidence: {
              version: 1,
              sourceId: selected.id,
              sourceUrl: resolvedSourceUrl,
              objectType: sourceObject.sourceType,
              jobId: job.id,
              matchSignature: job.matchSignature,
              receiptSource: job.receiptSource ?? null,
              evidence: exactArchiveIdentity
                ? 'archive_identity'
                : 'provider_single_sequence_primary_mapping',
              previousId,
              previousStableId,
              archiveIdentityMethod:
                typeof nativeExport.identityMethod === 'string'
                  ? nativeExport.identityMethod
                  : 'unknown',
              selectedRootId: selection.directFolder.authority.selectedRootId,
              sourceItemType: selection.directFolder.authority.sourceItemType,
              sourceFolderIds: [...selection.directFolder.authority.sourceFolderIds],
              membershipAuthorityUrl: selection.directFolder.membershipAuthorityUrl,
              capturePlanDigest: selection.directFolder.authority.capturePlanDigest,
              traversalJournalDigest: selection.directFolder.authority.traversalJournalDigest,
              requestCapabilityId: selection.directFolder.authority.requestCapabilityId,
              sourceUrlMethod:
                nativeExport.sourceUrlMethod === 'manifest'
                  ? 'explicit_manifest_exact_item_route'
                  : 'inherited_observed_item_authority',
            },
          }
        : {
            identityMethod: 'folder_tree_export_item',
            folderTreeItemEvidence: {
              version: 1,
              sourceId: selected.id,
              sourceUrl: resolvedSourceUrl,
              objectType: sourceObject.sourceType,
              jobId: job.id,
              matchSignature: job.matchSignature,
              receiptSource: job.receiptSource ?? null,
              evidence: exactArchiveIdentity
                ? 'archive_identity'
                : 'provider_single_sequence_primary_mapping',
              previousId,
              previousStableId,
              archiveIdentityMethod:
                typeof nativeExport.identityMethod === 'string'
                  ? nativeExport.identityMethod
                  : 'unknown',
              selectedRootId: selection.folderTree.authority.selectedRootId,
              sourceItemType: selection.folderTree.authority.sourceItemType,
              sourceFolderIds: [...selection.folderTree.authority.sourceFolderIds],
              rootAuthorityUrl: selection.folderTree.rootAuthorityUrl,
              capturePlanDigest: selection.folderTree.authority.capturePlanDigest,
              traversalJournalDigest: selection.folderTree.authority.traversalJournalDigest,
              maximumFolderDepth: selection.folderTree.authority.maximumFolderDepth,
              requestCapabilityId: selection.folderTree.authority.requestCapabilityId,
              sourceUrlMethod:
                nativeExport.sourceUrlMethod === 'manifest'
                  ? 'explicit_manifest_exact_item_route'
                  : 'inherited_observed_item_authority',
            },
          }),
    },
  };

  for (const candidate of sourceObjects) {
    candidate.relationships = candidate.relationships.map((relationship) => {
      const sourceObjectId =
        relationship.sourceObjectId === previousId ? selected.id : relationship.sourceObjectId;
      const targetSourceId =
        relationship.targetSourceId === previousId ? selected.id : relationship.targetSourceId;
      if (
        sourceObjectId === relationship.sourceObjectId &&
        targetSourceId === relationship.targetSourceId
      ) {
        return relationship;
      }
      const rebound = {
        ...relationship,
        sourceObjectId,
        ...(targetSourceId === undefined ? {} : { targetSourceId }),
      };
      return { ...rebound, id: reboundRelationshipId(rebound) };
    });
  }
  return { previousId, selectedId: selected.id, weakCollisionRemaps };
}

function rekeyWeakSelectedIdentityCollisions(
  sourceObjects: SourceObject[],
  primary: SourceObject,
  selectedId: string,
  sourceUrlPrefix: string
): Array<{ entryPath: string; nextId: string }> {
  const remaps: Array<{ entryPath: string; nextId: string }> = [];
  for (const candidate of sourceObjects) {
    if (
      candidate === primary ||
      nativeExportMetadata(candidate).identityMethod !== 'entry_evidence' ||
      (candidate.id !== selectedId && candidate.stableId !== selectedId)
    ) {
      continue;
    }
    const entryPath = requiredText(candidate.sourcePath, 'weak identity collision entry path');
    const entrySha256 = requiredSha256(
      String(nativeExportMetadata(candidate).entrySha256 ?? ''),
      'weak identity collision entry hash'
    );
    const previousId = candidate.id;
    const nextId = artifactIdentity(entryPath, entrySha256);
    candidate.id = nextId;
    candidate.stableId = nextId;
    candidate.sourceUrl = sourceUrl(sourceUrlPrefix, nextId);
    candidate.metadata = {
      ...candidate.metadata,
      nativeExport: {
        ...nativeExportMetadata(candidate),
        weakIdentityCollision: {
          version: 1,
          selectedSourceId: selectedId,
          previousId,
          reboundId: nextId,
        },
      },
    };
    candidate.relationships = candidate.relationships.map((relationship) => {
      if (relationship.sourceObjectId !== previousId) return relationship;
      const rebound = { ...relationship, sourceObjectId: nextId };
      return { ...rebound, id: reboundRelationshipId(rebound) };
    });
    remaps.push({ entryPath, nextId });
  }
  return remaps.sort((left, right) => left.entryPath.localeCompare(right.entryPath));
}

function isDecodedNotebookHtmlPrimary(sourceObject: SourceObject): boolean {
  const extension = path.posix.extname(sourceObject.sourcePath ?? '').toLowerCase();
  if (sourceObject.sourceType !== 'notebook_entry' || !['.html', '.htm'].includes(extension)) {
    return false;
  }
  const nativeExport = nativeExportMetadata(sourceObject);
  return !(
    nativeExport.identityMethod === 'entry_evidence' &&
    hasAttachmentPathSegment(sourceObject.sourcePath ?? '')
  );
}

function hasAttachmentPathSegment(sourcePath: string): boolean {
  const attachmentSegments = new Set(['attachments', 'assets', 'files']);
  return sourcePath
    .split('/')
    .slice(0, -1)
    .some((segment) => attachmentSegments.has(segment.toLowerCase()));
}

function nativeExportMetadata(sourceObject: SourceObject): Record<string, unknown> {
  return isRecord(sourceObject.metadata.nativeExport) ? sourceObject.metadata.nativeExport : {};
}

function reboundRelationshipId(relationship: SourceRelationship): string {
  const evidence = [...relationship.evidence]
    .map((entry) => `${entry.kind}\0${entry.value}`)
    .sort();
  return `rel_${sha256(
    JSON.stringify({
      sourceObjectId: relationship.sourceObjectId,
      targetSourceId: relationship.targetSourceId ?? null,
      targetUrl: relationship.targetUrl ?? null,
      relationType: relationship.relationType ?? null,
      direction: relationship.direction,
      sourceBroken: relationship.sourceBroken ?? false,
      evidence,
    })
  ).slice(0, 20)}`;
}

function bindAttachments(
  objectByEntry: Map<string, SourceObject[]>,
  attachments: NativeExportAttachmentEvidence[]
): void {
  const byOwner = new Map<string, NativeExportAttachmentEvidence[]>();
  for (const attachment of attachments) {
    const list = byOwner.get(attachment.sourceObjectId) ?? [];
    list.push(attachment);
    byOwner.set(attachment.sourceObjectId, list);
  }
  for (const [ownerPath, values] of byOwner) {
    const owner = objectByEntry.get(ownerPath)?.[0];
    if (!owner) continue;
    const sorted = values.sort(compareAttachments);
    owner.attachmentHashes = sortedUnique(sorted.map((entry) => entry.sha256));
    if (isRecord(owner.content)) {
      owner.content.attachments = sorted.map((entry) => ({
        sourceRef: entry.sourceRef,
        sha256: entry.sha256,
        fileName: entry.logicalFilename,
        mediaType: entry.mediaType,
      }));
    }
  }
}

function parseManifest(
  controls: ReadonlyMap<string, Uint8Array>,
  catalog: ReadonlyMap<string, NativeExportArchiveEntry>
): ManifestObject[] {
  const paths = [...controls.keys()].filter((entryPath) =>
    /(^|\/)benchling-export-manifest\.json$/i.test(entryPath)
  );
  if (paths.length === 0) return [];
  if (paths.length > 1) {
    throw new NativeExportDecodeError(
      'native_export_manifest_ambiguous',
      'Archive contains more than one Benchling export manifest.'
    );
  }
  const raw = parseJsonObject(controls.get(paths[0]), paths[0]);
  if (raw.schema !== MANIFEST_SCHEMA || !Array.isArray(raw.objects)) {
    throw new NativeExportDecodeError(
      'native_export_manifest_unsupported',
      `Manifest must use ${MANIFEST_SCHEMA}.`,
      paths[0]
    );
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  return raw.objects.map((value, index) => {
    const object = requireRecord(value, `manifest object ${index + 1}`);
    const id = requiredText(object.id, `manifest object ${index + 1} ID`);
    const entryPath = requiredText(object.path, `manifest object ${index + 1} path`);
    if (!catalog.has(entryPath)) {
      throw new NativeExportDecodeError(
        'native_export_manifest_path_missing',
        `Manifest object ${id} references missing ${entryPath}.`,
        entryPath
      );
    }
    if (seenIds.has(id) || seenPaths.has(entryPath)) {
      throw new NativeExportDecodeError(
        'native_export_manifest_duplicate',
        `Manifest object ID or path is duplicated: ${id}.`,
        entryPath
      );
    }
    seenIds.add(id);
    seenPaths.add(entryPath);
    const attachments = parseManifestAttachments(object.attachments, catalog, id);
    return {
      id,
      type: requiredText(object.type, `manifest object ${id} type`),
      name: requiredText(object.name, `manifest object ${id} name`),
      path: entryPath,
      ...optionalTextProperty(object.sourceUrl, 'sourceUrl'),
      ...optionalTextProperty(object.schemaId, 'schemaId'),
      ...optionalTextProperty(object.registryId, 'registryId'),
      aliases: textArray(object.aliases, `manifest object ${id} aliases`),
      memberships: textArray(object.memberships, `manifest object ${id} memberships`),
      ...optionalTimestampProperty(object.createdAt, 'createdAt'),
      ...optionalTimestampProperty(object.modifiedAt, 'modifiedAt'),
      ...optionalTextProperty(object.versionId, 'versionId'),
      metadata: object.metadata === undefined ? {} : requireRecord(object.metadata, 'metadata'),
      attachments,
      relationships: parseManifestRelationships(object.relationships, id),
    };
  });
}

function parseRegistrySchemas(
  controls: ReadonlyMap<string, Uint8Array>,
  catalog: ReadonlyMap<string, NativeExportArchiveEntry>
): RegistrySchemaSidecar[] {
  const result: RegistrySchemaSidecar[] = [];
  for (const [entryPath, bytes] of controls) {
    if (!/(^|\/)(?:schema|[^/]+\.schema)\.json$/i.test(entryPath)) continue;
    const raw = parseJsonObject(bytes, entryPath);
    if (raw.schema !== REGISTRY_SCHEMA) continue;
    const fields = Array.isArray(raw.fields)
      ? raw.fields.map((value, index) => {
          const field = requireRecord(value, `registry schema field ${index + 1}`);
          return {
            sourceFieldId: requiredText(field.sourceFieldId, 'registry source field ID'),
            definition: requireRecord(field.definition, 'registry field definition'),
            ...(field.rules === undefined
              ? {}
              : { rules: requireRecord(field.rules, 'registry field rules') }),
          };
        })
      : [];
    if (fields.length === 0) {
      throw new NativeExportDecodeError(
        'native_export_registry_schema_empty',
        `Registry schema ${entryPath} has no fields.`,
        entryPath
      );
    }
    const recordPaths = textArray(raw.recordPaths, 'registry schema recordPaths');
    if (recordPaths.length === 0 || recordPaths.some((recordPath) => !catalog.has(recordPath))) {
      throw new NativeExportDecodeError(
        'native_export_registry_table_missing',
        `Registry schema ${entryPath} must reference existing record paths.`,
        entryPath
      );
    }
    result.push({
      sourceSchemaId: requiredText(raw.sourceSchemaId, 'registry source schema ID'),
      sourceRevisionId: requiredText(raw.sourceRevisionId, 'registry source revision ID'),
      ...(typeof raw.sourceRevisionNumber === 'number' ||
      typeof raw.sourceRevisionNumber === 'string'
        ? { sourceRevisionNumber: raw.sourceRevisionNumber }
        : {}),
      name: requiredText(raw.name, 'registry schema name'),
      displayName: requiredText(raw.displayName, 'registry schema display name'),
      ...(raw.description === undefined || raw.description === null
        ? {}
        : { description: requiredText(raw.description, 'registry schema description') }),
      fields,
      ...(raw.rules === undefined ? {} : { rules: requireRecord(raw.rules, 'registry rules') }),
      recordPaths,
    });
  }
  return result;
}

function indexRegistrySchemas(
  schemas: RegistrySchemaSidecar[]
): Map<string, RegistrySchemaSidecar> {
  const result = new Map<string, RegistrySchemaSidecar>();
  for (const schema of schemas) {
    for (const recordPath of schema.recordPaths) {
      if (result.has(recordPath)) {
        throw new NativeExportDecodeError(
          'native_export_registry_schema_ambiguous',
          `Registry table ${recordPath} is claimed by multiple schema revisions.`,
          recordPath
        );
      }
      result.set(recordPath, schema);
    }
  }
  return result;
}

function planAttachmentOwners(
  entries: NativeExportArchiveEntry[],
  manifest: ManifestObject[],
  manifestByPath: ReadonlyMap<string, ManifestObject>
): Map<string, AttachmentOwner[]> {
  const result = new Map<string, AttachmentOwner[]>();
  for (const object of manifest) {
    for (const attachment of object.attachments) {
      if (manifestByPath.has(attachment.path)) {
        throw new NativeExportDecodeError(
          'native_export_manifest_path_conflict',
          `Manifest path ${attachment.path} cannot be both an object and an attachment.`,
          attachment.path
        );
      }
      addAttachmentOwner(result, attachment.path, {
        ownerPath: object.path,
        sourceRef: attachment.sourceRef,
        ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
      });
    }
  }
  const htmlEntries = entries.filter((entry) => !entry.isDirectory && /\.html?$/i.test(entry.path));
  for (const html of htmlEntries) {
    const directory = path.posix.dirname(html.path);
    const stem = path.posix.basename(html.path, path.posix.extname(html.path));
    const prefixes = [`${directory}/attachments/`, `${directory}/${stem}_attachments/`];
    for (const entry of entries) {
      if (entry.isDirectory || manifestByPath.has(entry.path)) continue;
      if (prefixes.some((prefix) => entry.path.startsWith(prefix))) {
        addAttachmentOwner(result, entry.path, {
          ownerPath: html.path,
          sourceRef: path.posix.relative(directory, entry.path),
        });
      }
    }
  }
  const siblingImageOwners = new Map<string, AttachmentOwner[]>();
  for (const html of htmlEntries) {
    if (hasAttachmentPathSegment(html.path) || result.has(html.path)) continue;
    const directory = path.posix.dirname(html.path);
    const stem = path.posix.basename(html.path, path.posix.extname(html.path));
    const exportedSiblingPrefix = `${stem} `;
    for (const entry of entries) {
      if (
        entry.isDirectory ||
        manifestByPath.has(entry.path) ||
        result.has(entry.path) ||
        path.posix.dirname(entry.path) !== directory ||
        !isInlineNotebookImagePath(entry.path) ||
        !path.posix.basename(entry.path).startsWith(exportedSiblingPrefix)
      ) {
        continue;
      }
      const owners = siblingImageOwners.get(entry.path) ?? [];
      owners.push({
        ownerPath: html.path,
        sourceRef: path.posix.basename(entry.path),
        mediaType: mediaTypeForPath(entry.path),
      });
      siblingImageOwners.set(entry.path, owners);
    }
  }
  for (const [entryPath, owners] of siblingImageOwners) {
    if (owners.length !== 1) {
      throw new NativeExportDecodeError(
        'native_export_sibling_image_owner_ambiguous',
        `Notebook sibling image ${entryPath} matches ${owners.length} HTML owners.`,
        entryPath
      );
    }
    addAttachmentOwner(result, entryPath, owners[0]);
  }
  return result;
}

function planLocalFlatSiblingAttachments(
  entries: readonly NativeExportArchiveEntry[],
  selectedEntryPaths: ReadonlySet<string>,
  target: Map<string, AttachmentOwner[]>
): void {
  const owners = [...selectedEntryPaths].sort().map((ownerPath) => ({
    ownerPath,
    directory: path.posix.dirname(ownerPath),
    siblingPrefix: `${path.posix.basename(ownerPath, path.posix.extname(ownerPath))} `,
  }));
  for (const entry of entries) {
    if (entry.isDirectory || selectedEntryPaths.has(entry.path)) continue;
    const directory = path.posix.dirname(entry.path);
    const basename = path.posix.basename(entry.path);
    const matchingOwners = owners.filter(
      (owner) => owner.directory === directory && basename.startsWith(owner.siblingPrefix)
    );
    if (matchingOwners.length === 0) continue;
    if (matchingOwners.length !== 1) {
      throw new NativeExportDecodeError(
        'native_export_local_sibling_attachment_owner_ambiguous',
        `Local Folder sibling attachment ${entry.path} matches ${matchingOwners.length} canonical owners.`,
        entry.path
      );
    }
    const owner = matchingOwners[0];
    const existingOwners = target.get(entry.path) ?? [];
    const ownerSourceId = canonicalExportSuffixSourceId(owner.ownerPath);
    if (
      existingOwners.some(
        (candidate) =>
          candidate.ownerPath !== owner.ownerPath &&
          (!ownerSourceId || canonicalExportSuffixSourceId(candidate.ownerPath) !== ownerSourceId)
      )
    ) {
      throw new NativeExportDecodeError(
        'native_export_local_sibling_attachment_owner_conflict',
        `Local Folder sibling attachment ${entry.path} conflicts with existing ownership evidence.`,
        entry.path
      );
    }
    addAttachmentOwner(target, entry.path, {
      ownerPath: owner.ownerPath,
      sourceRef: basename,
      mediaType: mediaTypeForPath(entry.path),
    });
  }
}

function isInlineNotebookImagePath(entryPath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(entryPath);
}

function planSelectedNotebookOrphanHtmlAttachments(
  entries: NativeExportArchiveEntry[],
  manifestByPath: ReadonlyMap<string, ManifestObject>,
  attachmentOwners: Map<string, AttachmentOwner[]>,
  context: NativeExportDecodeContext
): void {
  const selected = selectedNotebookAuthority(context)?.root;
  if (!selected) return;

  const orphanAttachmentHtml = entries.filter(
    (entry) =>
      !entry.isDirectory &&
      /\.html?$/iu.test(entry.path) &&
      !manifestByPath.has(entry.path) &&
      !attachmentOwners.has(entry.path) &&
      hasAttachmentPathSegment(entry.path)
  );
  if (orphanAttachmentHtml.length === 0) return;

  const primaryPaths = entries
    .filter((entry) => {
      if (entry.isDirectory || !/\.html?$/iu.test(entry.path) || attachmentOwners.has(entry.path)) {
        return false;
      }
      const spec = manifestByPath.get(entry.path);
      if (spec) {
        return spec.id === selected.id && normalizeType(spec.type) === 'notebook_entry';
      }
      return !hasAttachmentPathSegment(entry.path);
    })
    .map((entry) => entry.path)
    .sort();
  if (primaryPaths.length !== 1) {
    throw new NativeExportDecodeError(
      'native_export_selected_file_attachment_owner_ambiguous',
      `Manifestless attachment-like HTML requires exactly one deterministic notebook primary; found ${primaryPaths.length}.`
    );
  }

  const ownerPath = primaryPaths[0];
  for (const attachment of orphanAttachmentHtml.sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    for (const owners of attachmentOwners.values()) {
      for (const owner of owners) {
        if (owner.ownerPath === attachment.path) owner.ownerPath = ownerPath;
      }
    }
    addAttachmentOwner(attachmentOwners, attachment.path, {
      ownerPath,
      sourceRef: attachment.path,
      mediaType: 'text/html',
    });
  }
}

function addAttachmentOwner(
  target: Map<string, AttachmentOwner[]>,
  entryPath: string,
  owner: AttachmentOwner
): void {
  const owners = target.get(entryPath) ?? [];
  if (!owners.some((candidate) => candidate.ownerPath === owner.ownerPath)) owners.push(owner);
  target.set(entryPath, owners);
}

function capturePolicy(
  entry: NativeExportArchiveEntry,
  family: string,
  manifestMapped: boolean,
  registryMapped: boolean,
  attachment: boolean
): { kind: 'none' } | { kind: 'prefix' | 'full'; maxBytes: number } {
  if (attachment) return { kind: 'none' };
  const extension = path.posix.extname(entry.path).toLowerCase();
  const structured =
    manifestMapped ||
    registryMapped ||
    ['.gb', '.gbk', '.genbank', '.fa', '.fasta', '.fna', '.ffn', '.faa', '.html', '.htm'].includes(
      extension
    ) ||
    (isProtocolExecutionSourceType(normalizeType(family)) && extension === '.json') ||
    (isRegistryFamily(normalizeType(family)) &&
      ['.csv', '.tsv', '.json', '.jsonl'].includes(extension));
  if (structured) {
    return entry.uncompressedSize <= STRUCTURED_ENTRY_LIMIT
      ? { kind: 'full', maxBytes: STRUCTURED_ENTRY_LIMIT }
      : { kind: 'none' };
  }
  if (isTextPath(entry.path)) return { kind: 'prefix', maxBytes: GENERIC_PREVIEW_LIMIT };
  return { kind: 'none' };
}

function protocolStepsFromHtml(
  html: string,
  entryHash: string
): Array<{ sourceStepId: string; title: string; html: string }> {
  const sections = [
    ...html.matchAll(
      /<section\b([^>]*\bdata-benchling-step-id=(?:"([^"]+)"|'([^']+)')[^>]*)>([\s\S]*?)<\/section\s*>/gi
    ),
  ];
  if (sections.length === 0) {
    return [
      {
        sourceStepId: `step-${entryHash.slice(-12)}`,
        title: firstHtmlHeading(html) ?? 'Imported protocol',
        html,
      },
    ];
  }
  return sections.map((match, index) => ({
    sourceStepId: match[2] ?? match[3] ?? `step-${index + 1}`,
    title: firstHtmlHeading(match[4]) ?? `Step ${index + 1}`,
    html: match[4],
  }));
}

function protocolOverviewFromHtml(html: string): string {
  const match = html.match(
    /<section\b[^>]*\bdata-benchling-overview\b[^>]*>([\s\S]*?)<\/section\s*>/i
  );
  return match?.[1] ?? '<p>Imported from Benchling native HTML.</p>';
}

function relationshipsFromHtml(
  sourceObjectId: string,
  html: string,
  context: {
    entryPath: string;
    sourceUrlPrefix: string | null;
    packageLinkEvidence: NativeExportPackageLinkEvidence;
  }
): SourceRelationship[] {
  const result: SourceRelationship[] = [];
  const seen = new Set<string>();
  const relationshipEvidence = relationshipEvidenceFromHtml(html);
  for (const anchor of relationshipEvidence.anchors) {
    const classified = anchor.href === null ? null : classifyHtmlAnchorTarget(anchor.href, context);
    const captured = capturedAnchorTarget(classified, anchor.internalLinkTargetId);
    if (!captured) continue;
    const { targetSourceIds, targetUrl, relationType } = captured;
    const identity = `${targetSourceIds.join(',')}\0${targetUrl ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({
      id: `rel_${sha256(`${sourceObjectId}:${identity}`).slice(0, 20)}`,
      sourceObjectId,
      ...(targetSourceIds.length === 1 ? { targetSourceId: targetSourceIds[0] } : {}),
      ...(targetUrl ? { targetUrl } : {}),
      relationType,
      direction: 'outbound',
      evidence: [
        ...targetSourceIds.map((value) => ({ kind: 'stable_id' as const, value })),
        ...(targetUrl ? [{ kind: 'url' as const, value: targetUrl }] : []),
      ],
    });
  }
  for (const title of relationshipEvidence.embeddedEntryCardTitles) {
    const normalizedTitle = normalizeEmbeddedEntryTitle(title);
    const identity = `${EMBEDDED_ENTRY_REFERENCE_RELATION_TYPE}\0${normalizedTitle}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({
      id: `rel_${sha256(`${sourceObjectId}:${identity}`).slice(0, 20)}`,
      sourceObjectId,
      relationType: EMBEDDED_ENTRY_REFERENCE_RELATION_TYPE,
      direction: 'outbound',
      evidence: [{ kind: 'name', value: title }],
    });
  }
  return result;
}

export function relationshipsFromStandaloneBenchlingHtml(
  sourceObjectId: string,
  html: string,
  entryPath: string
): SourceRelationship[] {
  return relationshipsFromHtml(sourceObjectId, html, {
    entryPath,
    sourceUrlPrefix: null,
    packageLinkEvidence: {
      archiveEntryPaths: new Set<string>(),
      attachmentReferences: new Set<string>(),
    },
  }).filter(
    (relationship) =>
      (relationship.relationType === 'references' &&
        relationship.targetSourceId !== sourceObjectId) ||
      relationship.relationType === EMBEDDED_ENTRY_REFERENCE_RELATION_TYPE
  );
}

type NativeExportAnchorEvidence = {
  href: string | null;
  internalLinkTargetId: string | null;
};

function relationshipEvidenceFromHtml(html: string): {
  anchors: NativeExportAnchorEvidence[];
  embeddedEntryCardTitles: string[];
} {
  const titles: string[] = [];
  const anchors: NativeExportAnchorEvidence[] = [];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;
  let divDepth = 0;
  let cardDepth: number | null = null;
  let titleDepth: number | null = null;
  let titleText = '';
  let cardTitle: string | null = null;
  let cardHasLinkEvidence = false;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    const textEnd = tagStart < 0 ? html.length : tagStart;
    if (titleDepth !== null && textEnd > cursor) titleText += html.slice(cursor, textEnd);
    if (tagStart < 0) break;
    if (lowerHtml.startsWith('<!--', tagStart)) {
      const commentEnd = lowerHtml.indexOf('-->', tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, tagStart + 1);
    if (tagEnd < 0) break;
    const body = html.slice(tagStart + 1, tagEnd);
    let bodyCursor = 0;
    while (/\s/u.test(body[bodyCursor] ?? '')) bodyCursor += 1;
    const closing = body[bodyCursor] === '/';
    if (closing) bodyCursor += 1;
    while (/\s/u.test(body[bodyCursor] ?? '')) bodyCursor += 1;
    const tagNameMatch = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(body.slice(bodyCursor));
    if (!tagNameMatch) {
      cursor = tagEnd + 1;
      continue;
    }
    const tagName = tagNameMatch[0].toLowerCase();
    const attributes = body.slice(bodyCursor + tagNameMatch[0].length);
    if (!closing && tagName === 'a') {
      const href = htmlAttributeValue(attributes, 'href');
      const internalLinkTargetId = internalLinkTargetIdFromAttributes(attributes);
      if (href !== null || internalLinkTargetId !== null) {
        anchors.push({ href, internalLinkTargetId });
        if (cardDepth !== null && (href?.trim() || internalLinkTargetId)) {
          cardHasLinkEvidence = true;
        }
      }
    }
    if (!closing && HTML_TEXT_ONLY_ELEMENTS.has(tagName)) {
      const rawTextEnd = findRawTextElementEnd(html, lowerHtml, tagName, tagEnd + 1);
      cursor = rawTextEnd < 0 ? html.length : rawTextEnd;
      continue;
    }
    if (tagName !== 'div') {
      cursor = tagEnd + 1;
      continue;
    }

    if (closing) {
      if (titleDepth === divDepth) {
        const title = decodeHtmlEntities(titleText).trim().replace(/\s+/gu, ' ');
        if (title) cardTitle = title;
        titleDepth = null;
        titleText = '';
      }
      if (cardDepth === divDepth) {
        if (cardTitle && !cardHasLinkEvidence) titles.push(cardTitle);
        cardDepth = null;
        titleDepth = null;
        titleText = '';
        cardTitle = null;
        cardHasLinkEvidence = false;
      }
      divDepth = Math.max(0, divDepth - 1);
      cursor = tagEnd + 1;
      continue;
    }

    divDepth += 1;
    const className = htmlAttributeValue(attributes, 'class') ?? '';
    const testComponent = htmlAttributeValue(attributes, 'data-test-component') ?? '';
    const testElement = htmlAttributeValue(attributes, 'data-test-element') ?? '';
    if (
      cardDepth === null &&
      hasHtmlClassToken(className, 'note-entry') &&
      testComponent.toLowerCase() === 'notedroptarget' &&
      testElement.toLowerCase() === 'notelinkedfilepreview'
    ) {
      cardDepth = divDepth;
      cardTitle = null;
      cardHasLinkEvidence = false;
    } else if (
      cardDepth !== null &&
      titleDepth === null &&
      testElement.toLowerCase() === 'previewitemname'
    ) {
      titleDepth = divDepth;
      titleText = '';
    }
    cursor = tagEnd + 1;
  }
  return { anchors, embeddedEntryCardTitles: titles };
}

function internalLinkTargetIdFromAttributes(attributes: string): string | null {
  return benchlingInternalLinkTargetId(
    htmlAttributeValue(attributes, BENCHLING_INTERNAL_LINK_ATTRIBUTE)
  );
}

export function benchlingInternalLinkTargetId(raw: string | null | undefined): string | null {
  if (!raw || raw.length > BENCHLING_INTERNAL_LINK_LIMIT) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decodeHtmlEntities(raw));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const id = (payload as { id?: unknown }).id;
  if (typeof id !== 'string') return null;
  const targetSourceId = id.trim();
  return BENCHLING_INTERNAL_LINK_TARGET_ID.test(targetSourceId) ? targetSourceId : null;
}

function capturedAnchorTarget(
  classified: ReturnType<typeof classifyHtmlAnchorTarget>,
  internalLinkTargetId: string | null
): {
  targetSourceIds: string[];
  targetUrl?: string;
  relationType: 'references' | 'external_reference';
} | null {
  if (classified && 'targetSourceId' in classified) {
    const hrefTargetId = classified.targetSourceId;
    return {
      targetSourceIds:
        internalLinkTargetId && internalLinkTargetId !== hrefTargetId
          ? sortedUnique([hrefTargetId, internalLinkTargetId])
          : [hrefTargetId],
      targetUrl: classified.targetUrl,
      relationType: 'references',
    };
  }
  if (!internalLinkTargetId) {
    if (!classified) return null;
    return {
      targetSourceIds: [],
      targetUrl: classified.targetUrl,
      relationType: classified.relationType,
    };
  }
  if (classified?.relationType === 'external_reference' && !classified.withinBenchlingAuthority) {
    return {
      targetSourceIds: [],
      targetUrl: classified.targetUrl,
      relationType: classified.relationType,
    };
  }
  return { targetSourceIds: [internalLinkTargetId], relationType: 'references' };
}

function hasHtmlClassToken(className: string, expected: string): boolean {
  const normalized = expected.toLowerCase();
  return className.split(/\s+/u).some((token) => token.toLowerCase() === normalized);
}

function normalizeEmbeddedEntryTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function classifyHtmlAnchorTarget(
  rawHref: string,
  context: {
    entryPath: string;
    sourceUrlPrefix: string | null;
    packageLinkEvidence: NativeExportPackageLinkEvidence;
  }
):
  | { targetUrl: string; targetSourceId: string; relationType: 'references' }
  | {
      targetUrl: string;
      relationType: 'external_reference';
      withinBenchlingAuthority: boolean;
    }
  | null {
  const targetUrl = decodeHtmlEntities(rawHref).trim();
  if (!targetUrl || targetUrl.startsWith('#')) return null;

  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(targetUrl);
  const protocolRelative = targetUrl.startsWith('//');
  if (!hasScheme && !protocolRelative) {
    if (matchesPackageLocalPath(targetUrl, context.entryPath, context.packageLinkEvidence, true)) {
      return null;
    }
    if (!targetUrl.startsWith('/')) return null;
  }

  let parsed: URL;
  try {
    parsed = context.sourceUrlPrefix
      ? new URL(targetUrl, context.sourceUrlPrefix)
      : new URL(targetUrl);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }

  parsed.search = '';
  parsed.hash = '';
  const durableTargetUrl = parsed.toString();

  if (
    context.sourceUrlPrefix &&
    !isUrlWithinBenchlingOrganization(targetUrl, context.sourceUrlPrefix)
  ) {
    return {
      targetUrl: durableTargetUrl,
      relationType: 'external_reference',
      withinBenchlingAuthority: false,
    };
  }
  if (!context.sourceUrlPrefix) {
    const targetSourceId = exactBenchlingIdFromPath(parsed.pathname);
    const withinBenchlingAuthority = isBenchlingWebHost(parsed.hostname);
    if (targetSourceId && withinBenchlingAuthority) {
      return { targetUrl: durableTargetUrl, targetSourceId, relationType: 'references' };
    }
    return {
      targetUrl: durableTargetUrl,
      relationType: 'external_reference',
      withinBenchlingAuthority,
    };
  }

  if (
    matchesPackageLocalPath(parsed.pathname, context.entryPath, context.packageLinkEvidence, false)
  ) {
    return null;
  }
  const targetSourceId = exactBenchlingIdFromPath(parsed.pathname);
  if (!targetSourceId) return null;
  return { targetUrl: durableTargetUrl, targetSourceId, relationType: 'references' };
}

function matchesPackageLocalPath(
  value: string,
  entryPath: string,
  evidence: NativeExportPackageLinkEvidence,
  includeEntryRelative: boolean
): boolean {
  const pathOnly = value.split(/[?#]/u, 1)[0];
  if (!pathOnly) return true;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    decodedPath = pathOnly;
  }
  const candidates = [normalizePackageLinkPath(decodedPath)];
  if (includeEntryRelative) {
    candidates.push(
      normalizePackageLinkPath(path.posix.join(path.posix.dirname(entryPath), decodedPath))
    );
  }
  return candidates.some(
    (candidate) =>
      candidate !== null &&
      (evidence.archiveEntryPaths.has(candidate) || evidence.attachmentReferences.has(candidate))
  );
}

function normalizePackageLinkPath(value: string): string | null {
  const normalized = path.posix
    .normalize(value.replace(/\\/gu, '/'))
    .replace(/^\/+|^(?:\.\/)+/gu, '')
    .toLowerCase();
  return !normalized || normalized === '.' || normalized.startsWith('../') ? null : normalized;
}

function exactBenchlingIdFromPath(value: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(value);
  } catch {
    decodedPath = value;
  }
  const matches = decodedPath.match(new RegExp(BENCHLING_ID.source, 'gu')) ?? [];
  const unique = sortedUnique(matches);
  const nonFolder = unique.filter(
    (candidate) => !BENCHLING_FOLDER_ID_PREFIXES.has(candidate.split('_', 1)[0])
  );
  const candidates = nonFolder.length > 0 ? nonFolder : unique;
  return candidates.length === 1 ? candidates[0] : null;
}

function isBenchlingWebHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '');
  return normalized === 'benchling.com' || normalized.endsWith('.benchling.com');
}

function findHtmlTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function findRawTextElementEnd(
  html: string,
  lowerHtml: string,
  tagName: string,
  start: number
): number {
  let cursor = start;
  while (cursor < html.length) {
    const closingStart = lowerHtml.indexOf(`</${tagName}`, cursor);
    if (closingStart < 0) return -1;
    const boundary = lowerHtml[closingStart + tagName.length + 2];
    if (boundary === '>' || /\s/u.test(boundary ?? '')) {
      const closingEnd = findHtmlTagEnd(html, closingStart + 2 + tagName.length);
      return closingEnd < 0 ? -1 : closingEnd + 1;
    }
    cursor = closingStart + tagName.length + 2;
  }
  return -1;
}

const HTML_TEXT_ONLY_ELEMENTS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
]);

function htmlAttributeValue(attributes: string, desiredName: string): string | null {
  let cursor = 0;
  while (cursor < attributes.length) {
    while (/\s|\//u.test(attributes[cursor] ?? '')) cursor += 1;
    const nameStart = cursor;
    while (cursor < attributes.length && !/[\s=/>]/u.test(attributes[cursor])) cursor += 1;
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = attributes.slice(nameStart, cursor).toLowerCase();
    while (/\s/u.test(attributes[cursor] ?? '')) cursor += 1;
    if (attributes[cursor] !== '=') continue;
    cursor += 1;
    while (/\s/u.test(attributes[cursor] ?? '')) cursor += 1;
    const quote =
      attributes[cursor] === '"' || attributes[cursor] === "'" ? attributes[cursor] : null;
    if (quote) cursor += 1;
    const valueStart = cursor;
    if (quote) {
      while (cursor < attributes.length && attributes[cursor] !== quote) cursor += 1;
    } else {
      while (cursor < attributes.length && !/[\s>]/u.test(attributes[cursor])) cursor += 1;
    }
    const value = attributes.slice(valueStart, cursor);
    if (quote && attributes[cursor] === quote) cursor += 1;
    if (name === desiredName) return value;
  }
  return null;
}

function parseFasta(text: string): Array<{
  id: string | null;
  name: string;
  description: string;
  sequence: string;
}> {
  const records: Array<{ id: string | null; name: string; description: string; sequence: string }> =
    [];
  let current: { id: string | null; name: string; description: string; sequence: string } | null =
    null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('>')) {
      if (current) records.push(current);
      const header = line.slice(1).trim();
      if (!header) throw new Error('FASTA header is empty.');
      const [first, ...rest] = header.split(/\s+/);
      const benchlingId = first.match(BENCHLING_ID)?.[0] ?? null;
      current = {
        id: benchlingId ?? first,
        name: benchlingId && rest.length > 0 ? rest.join(' ') : header,
        description: rest.join(' '),
        sequence: '',
      };
    } else if (line.trim()) {
      if (!current) throw new Error('FASTA sequence precedes its header.');
      if (!/^[A-Za-z*.-]+$/.test(line.replace(/\s+/g, '')))
        throw new Error('FASTA contains unsupported characters.');
      current.sequence += line.replace(/[\s.-]+/g, '');
    }
  }
  if (current) records.push(current);
  if (records.length === 0 || records.some((record) => !record.sequence)) {
    throw new Error('FASTA has no complete records.');
  }
  return records;
}

function parseDelimited(text: string, delimiter: string): Record<string, unknown>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) {
      record.push(field);
      field = '';
    } else if (character === '\n') {
      record.push(field.replace(/\r$/, ''));
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('Delimited registry table has an unterminated quote.');
  if (field || record.length > 0) {
    record.push(field.replace(/\r$/, ''));
    if (record.some((value) => value.trim())) records.push(record);
  }
  const headers = records.shift()?.map((header) => header.replace(/^\uFEFF/, '').trim()) ?? [];
  if (headers.length === 0 || headers.every((header) => !header))
    throw new Error('Registry table has no header.');
  return records.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
  );
}

function parseJsonRows(text: string, extension: string): Record<string, unknown>[] {
  if (extension === '.jsonl') {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => requireRecord(JSON.parse(line), `JSONL row ${index + 1}`));
  }
  const parsed: unknown = JSON.parse(text);
  const values = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.records)
      ? ((parsed as Record<string, unknown>).records as unknown[])
      : [parsed];
  return values.map((value, index) => requireRecord(value, `JSON row ${index + 1}`));
}

function parseManifestAttachments(
  value: unknown,
  catalog: ReadonlyMap<string, NativeExportArchiveEntry>,
  objectId: string
): ManifestObject['attachments'] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new NativeExportDecodeError(
      'native_export_manifest_invalid',
      `Attachments for ${objectId} must be an array.`
    );
  return value.map((entry, index) => {
    const attachment = requireRecord(entry, `attachment ${index + 1}`);
    const entryPath = requiredText(attachment.path, `attachment ${index + 1} path`);
    if (!catalog.has(entryPath))
      throw new NativeExportDecodeError(
        'native_export_manifest_path_missing',
        `Attachment ${entryPath} is absent.`,
        entryPath
      );
    return {
      path: entryPath,
      sourceRef: requiredText(
        attachment.sourceRef ?? attachment.path,
        'attachment source reference'
      ),
      ...optionalTextProperty(attachment.mediaType, 'mediaType'),
    };
  });
}

function parseManifestRelationships(value: unknown, sourceObjectId: string): SourceRelationship[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new NativeExportDecodeError(
      'native_export_manifest_invalid',
      'Manifest relationships must be an array.'
    );
  return value.map((entry, index) => {
    const relationship = requireRecord(entry, `relationship ${index + 1}`);
    const targetSourceId =
      typeof relationship.targetSourceId === 'string' && relationship.targetSourceId.trim()
        ? relationship.targetSourceId.trim()
        : undefined;
    const targetUrl =
      typeof relationship.targetUrl === 'string' && relationship.targetUrl.trim()
        ? relationship.targetUrl.trim()
        : undefined;
    if (!targetSourceId && !targetUrl)
      throw new NativeExportDecodeError(
        'native_export_manifest_invalid',
        'Relationship requires a target.'
      );
    return {
      id: requiredText(relationship.id, 'relationship ID'),
      sourceObjectId,
      ...(targetSourceId ? { targetSourceId } : {}),
      ...(targetUrl ? { targetUrl } : {}),
      ...(typeof relationship.relationType === 'string' && relationship.relationType.trim()
        ? { relationType: relationship.relationType.trim() }
        : {}),
      direction: 'outbound',
      ...(relationship.sourceBroken === true ? { sourceBroken: true } : {}),
      evidence: targetSourceId
        ? [{ kind: 'stable_id', value: targetSourceId }]
        : [{ kind: 'url', value: requiredText(targetUrl, 'relationship target URL') }],
    };
  });
}

function validateControlMetadata(value: unknown): NativeExportControlMetadata {
  if (!isRecord(value)) {
    throw new NativeExportDecodeError(
      'native_export_control_metadata_invalid',
      'Native export control-metadata policy is required.'
    );
  }
  if (value.source === 'none') return { source: 'none' };
  if (value.source === 'archive' && value.trust === 'synthetic_replay_fixture') {
    return { source: 'archive', trust: 'synthetic_replay_fixture' };
  }
  throw new NativeExportDecodeError(
    'native_export_control_metadata_invalid',
    'Archive control metadata is permitted only for explicitly trusted synthetic replay fixtures.'
  );
}

function validateJob(
  job: NativeExportDecodeJob
): NativeExportDecodeJob & { receiptId: string; downloadUrlHash: string } {
  if (
    !job ||
    !requiredText(job.id, 'export job ID') ||
    !requiredText(job.contentFamily, 'content family')
  )
    throw new NativeExportDecodeError('native_export_job_invalid', 'Export job is invalid.');
  if (!job.receiptId || !job.downloadUrlHash)
    throw new NativeExportDecodeError(
      'native_export_receipt_missing',
      'Matched receipt evidence is required before decode.'
    );
  return {
    ...job,
    receiptId: requiredText(job.receiptId, 'receipt ID'),
    downloadUrlHash: requiredSha256(job.downloadUrlHash, 'download URL hash'),
  };
}

function validateContext(context: NativeExportDecodeContext): NativeExportDecodeContext;
function validateContext(context: LocalNativeExportDecodeContext): LocalNativeExportDecodeContext;
function validateContext(context: AnyNativeExportDecodeContext): AnyNativeExportDecodeContext {
  requiredText(context.snapshotId, 'snapshot ID');
  requiredText(context.archivePartId, 'archive part ID');
  requiredTimestamp(context.capturedAt, 'capture time');
  if (isLocalDecodeContext(context)) {
    if (context.sourceUrlPrefix !== null) {
      throw new NativeExportDecodeError(
        'native_export_local_bundle_authority_invalid',
        'Local export decode cannot carry a provider source URL prefix.'
      );
    }
    const authority = context.localBundleAuthority;
    if (
      authority?.schema !== 'dnaforge.benchling.local-native-export-authority.v1' ||
      !requiredText(authority.logicalFilename, 'local export filename') ||
      !/^sha256:[a-f0-9]{64}$/u.test(authority.sha256)
    ) {
      throw new NativeExportDecodeError(
        'native_export_local_bundle_authority_invalid',
        'Local export authority is invalid.'
      );
    }
    const selectedEntryPaths = validateLocalSelectedEntryPaths(context.selectedEntryPaths);
    const fallbackEntryPaths = validateLocalSelectedEntryPaths(context.fallbackEntryPaths);
    return {
      snapshotId: context.snapshotId,
      capturedAt: context.capturedAt,
      archivePartId: context.archivePartId,
      sourceUrlPrefix: null,
      localBundleAuthority: {
        schema: authority.schema,
        logicalFilename: authority.logicalFilename,
        sha256: authority.sha256,
      },
      ...(selectedEntryPaths ? { selectedEntryPaths } : {}),
      ...(fallbackEntryPaths ? { fallbackEntryPaths } : {}),
    };
  }
  sourceUrl(context.sourceUrlPrefix, 'probe');
  const selectedFileRoot = context.selectedFileRoot
    ? {
        id: requiredText(context.selectedFileRoot.id, 'selected File source ID'),
        url: sanitizeSourceObjectUrl(context.selectedFileRoot.url),
        ...(context.selectedFileRoot.objectType
          ? {
              objectType: requiredText(
                context.selectedFileRoot.objectType,
                'selected File object type'
              ),
            }
          : {}),
      }
    : undefined;
  const selectedAuthorityCount = [
    selectedFileRoot,
    context.directFolderItemAuthority,
    context.folderTreeItemAuthority,
  ].filter(Boolean).length;
  if (selectedAuthorityCount > 1) {
    throw new NativeExportDecodeError(
      'native_export_selected_authority_ambiguous',
      'Native export decode cannot carry more than one selected-scope item authority.'
    );
  }
  const directFolderItemAuthority = context.directFolderItemAuthority
    ? validateDirectFolderDecodeAuthority(context.directFolderItemAuthority)
    : undefined;
  const folderTreeItemAuthority = context.folderTreeItemAuthority
    ? validateFolderTreeDecodeAuthority(context.folderTreeItemAuthority)
    : undefined;
  return {
    ...context,
    defaultMemberships: sortedUnique(context.defaultMemberships ?? []),
    ...(selectedFileRoot ? { selectedFileRoot } : {}),
    ...(directFolderItemAuthority ? { directFolderItemAuthority } : {}),
    ...(folderTreeItemAuthority ? { folderTreeItemAuthority } : {}),
  };
}

function validateLocalSelectedEntryPaths(value: readonly string[] | undefined): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new NativeExportDecodeError(
      'native_export_local_bundle_authority_invalid',
      'Local export selected entry paths must be a non-empty array.'
    );
  }
  const paths = value.map((entryPath) => {
    const candidate = requiredText(entryPath, 'local export selected entry path');
    if (
      candidate.includes('\\') ||
      candidate.startsWith('/') ||
      path.posix.normalize(candidate) !== candidate
    ) {
      throw new NativeExportDecodeError(
        'native_export_local_bundle_authority_invalid',
        'Local export selected entry paths must be normalized archive-relative paths.'
      );
    }
    return candidate;
  });
  if (new Set(paths).size !== paths.length) {
    throw new NativeExportDecodeError(
      'native_export_local_bundle_authority_invalid',
      'Local export selected entry paths must be unique.'
    );
  }
  return paths.sort();
}

function isLocalDecodeContext(
  context: AnyNativeExportDecodeContext
): context is LocalNativeExportDecodeContext {
  return context.sourceUrlPrefix === null && 'localBundleAuthority' in context;
}

function assertSelectedAuthorityMatchesJob(
  job: NativeExportDecodeJob,
  context: NativeExportDecodeContext
): void {
  const selectedFileRoot = context.selectedFileRoot;
  if (selectedFileRoot) {
    if (
      job.contentFamily !== 'notebook' ||
      job.sourceRoots.length !== 1 ||
      job.directFolderAuthority !== undefined ||
      job.folderTreeAuthority !== undefined ||
      !/^(?:etr|entry)_[A-Za-z0-9]+$/u.test(selectedFileRoot.id) ||
      (selectedFileRoot.objectType !== undefined &&
        normalizeType(selectedFileRoot.objectType) !== 'notebook_entry')
    ) {
      throw new NativeExportDecodeError(
        'native_export_selected_file_job_mismatch',
        'Selected File native decode is restricted to one documented notebook-entry export job.'
      );
    }
    const jobRoot = job.sourceRoots[0];
    const jobRootUrl = sanitizeSourceObjectUrl(jobRoot.url);
    const objectTypesConflict =
      selectedFileRoot.objectType !== undefined &&
      jobRoot.objectType !== undefined &&
      normalizeType(selectedFileRoot.objectType) !== normalizeType(jobRoot.objectType);
    if (
      requiredText(jobRoot.id, 'export job source root ID') !== selectedFileRoot.id ||
      jobRootUrl !== selectedFileRoot.url ||
      !isUrlWithinBenchlingOrganization(selectedFileRoot.url, context.sourceUrlPrefix) ||
      !isUrlWithinBenchlingOrganization(jobRootUrl, context.sourceUrlPrefix) ||
      objectTypesConflict
    ) {
      throw new NativeExportDecodeError(
        'native_export_selected_file_job_mismatch',
        `Selected File identity ${selectedFileRoot.id} does not match the persisted export-job root.`
      );
    }
    return;
  }

  const direct = context.directFolderItemAuthority;
  const tree = context.folderTreeItemAuthority;
  if (!direct && !tree) return;
  if (tree) {
    const authority = tree.authority;
    const jobRoot = job.sourceRoots[0];
    const mismatches = [
      ...(job.contentFamily === folderTreeContentFamily(authority) ? [] : ['family']),
      ...(job.sourceRoots.length === 1 ? [] : ['root_count']),
      ...(hasSelectedItemReceiptAuthority(job) ? [] : ['receipt_source']),
      ...(sameFolderTreeAuthority(job.folderTreeAuthority, authority) ? [] : ['authority']),
      ...(job.directFolderAuthority === undefined ? [] : ['wrong_authority']),
      ...(jobRoot?.id === authority.sourceItemId ? [] : ['item_id']),
      ...(jobRoot?.objectType === authority.sourceItemType ? [] : ['item_type']),
      ...(sanitizeSourceObjectUrl(jobRoot.url) === authority.sourceItemUrl ? [] : ['item_url']),
      ...(tree.itemSourceUrl === authority.sourceItemUrl ? [] : ['decode_item_url']),
      ...(JSON.stringify(context.defaultMemberships) === JSON.stringify(authority.sourceFolderIds)
        ? []
        : ['memberships']),
      ...(isUrlWithinBenchlingOrganization(tree.itemSourceUrl, context.sourceUrlPrefix)
        ? []
        : ['item_route']),
      ...(urlPathContainsStableId(tree.itemSourceUrl, authority.sourceItemId)
        ? []
        : ['item_route_id']),
      ...(urlPathContainsStableId(tree.rootAuthorityUrl, authority.selectedRootId)
        ? []
        : ['root_route_id']),
    ];
    if (mismatches.length > 0) {
      throw new NativeExportDecodeError(
        'native_export_folder_tree_job_mismatch',
        `Folder Tree item ${authority.sourceItemId} conflicts with its immutable plan authority (${mismatches.join(',')}).`
      );
    }
    return;
  }
  if (!direct) return;
  const authority = direct.authority;
  const jobRoot = job.sourceRoots[0];
  const mismatches = [
    ...(job.contentFamily === directFolderContentFamily(authority) ? [] : ['family']),
    ...(job.sourceRoots.length === 1 ? [] : ['root_count']),
    ...(hasSelectedItemReceiptAuthority(job) ? [] : ['receipt_source']),
    ...(sameDirectFolderAuthority(job.directFolderAuthority, authority) ? [] : ['authority']),
    ...(job.folderTreeAuthority === undefined ? [] : ['wrong_authority']),
    ...(jobRoot?.id === authority.sourceItemId ? [] : ['item_id']),
    ...(jobRoot?.objectType === authority.sourceItemType ? [] : ['item_type']),
    ...(sanitizeSourceObjectUrl(jobRoot.url) === authority.sourceItemUrl ? [] : ['item_url']),
    ...(direct.itemSourceUrl === authority.sourceItemUrl ? [] : ['decode_item_url']),
    ...(context.defaultMemberships?.length === 1 ? [] : ['membership_count']),
    ...(context.defaultMemberships?.[0] === authority.selectedRootId ? [] : ['membership_root']),
    ...(isUrlWithinBenchlingOrganization(direct.itemSourceUrl, context.sourceUrlPrefix)
      ? []
      : ['item_route']),
    ...(isUrlWithinBenchlingOrganization(direct.membershipAuthorityUrl, context.sourceUrlPrefix)
      ? []
      : ['membership_route']),
    ...(urlPathContainsStableId(direct.itemSourceUrl, authority.sourceItemId)
      ? []
      : ['item_route_id']),
    ...(urlPathContainsStableId(direct.membershipAuthorityUrl, authority.selectedRootId)
      ? []
      : ['membership_route_id']),
  ];
  if (mismatches.length > 0) {
    throw new NativeExportDecodeError(
      'native_export_direct_folder_job_mismatch',
      `Direct Folder item ${authority.sourceItemId} does not match its persisted one-item export authority (${mismatches.join(',')}).`
    );
  }
}

function hasSelectedItemReceiptAuthority(job: NativeExportDecodeJob): boolean {
  return (
    job.receiptSource === 'provider_task' ||
    (job.receiptSource === 'gmail' &&
      typeof job.receiptConfirmationId === 'string' &&
      job.receiptConfirmationId.trim().length > 0)
  );
}

function validateDirectFolderDecodeAuthority(
  input: NativeExportDirectFolderItemAuthority
): NativeExportDirectFolderItemAuthority {
  const record = requireRecord(input, 'Direct Folder decode authority');
  const keys = Object.keys(record).sort();
  if (
    keys.join('\0') !== ['authority', 'itemSourceUrl', 'membershipAuthorityUrl'].sort().join('\0')
  ) {
    throw new NativeExportDecodeError(
      'native_export_direct_folder_authority_invalid',
      'Direct Folder decode authority fields are invalid.'
    );
  }
  const authorityRecord = requireRecord(record.authority, 'Direct Folder export authority');
  const authorityKeys = [
    'schema',
    'capturePlanDigest',
    'traversalJournalDigest',
    'selectedRootId',
    'sourceItemId',
    'sourceItemUrl',
    'sourceItemType',
    'sourceFolderIds',
    'requestCapabilityId',
  ].sort();
  if (Object.keys(authorityRecord).sort().join('\0') !== authorityKeys.join('\0')) {
    throw new NativeExportDecodeError(
      'native_export_direct_folder_authority_invalid',
      'Direct Folder export authority fields are invalid.'
    );
  }
  const sourceItemId = requiredText(authorityRecord.sourceItemId, 'Direct Folder source item ID');
  const sourceItemUrl = sanitizeSourceObjectUrl(
    requiredText(authorityRecord.sourceItemUrl, 'Direct Folder source item URL')
  );
  const selectedRootId = requiredText(
    authorityRecord.selectedRootId,
    'Direct Folder selected root ID'
  );
  if (
    authorityRecord.schema !== 'dnaforge.benchling.direct-folder-export-authority.v1' ||
    !isExactDirectFolderDecodeTarget(authorityRecord, sourceItemId) ||
    !Array.isArray(authorityRecord.sourceFolderIds) ||
    authorityRecord.sourceFolderIds.length !== 1 ||
    Object.keys(authorityRecord.sourceFolderIds).length !== 1 ||
    authorityRecord.sourceFolderIds[0] !== selectedRootId
  ) {
    throw new NativeExportDecodeError(
      'native_export_direct_folder_authority_invalid',
      'Direct Folder export authority is not an exact supported item authority.'
    );
  }
  const commonAuthority = {
    schema: 'dnaforge.benchling.direct-folder-export-authority.v1',
    capturePlanDigest: requiredSha256(
      authorityRecord.capturePlanDigest,
      'Direct Folder capture-plan digest'
    ),
    traversalJournalDigest: requiredSha256(
      authorityRecord.traversalJournalDigest,
      'Direct Folder traversal-journal digest'
    ),
    selectedRootId,
    sourceItemId,
    sourceItemUrl,
    sourceFolderIds: [selectedRootId] as [string],
  } as const;
  const authority: DirectFolderExportAuthority =
    authorityRecord.sourceItemType === 'entry'
      ? {
          ...commonAuthority,
          sourceItemType: 'entry',
          requestCapabilityId: 'benchling.notebook-entry-html-export.v1',
        }
      : {
          ...commonAuthority,
          sourceItemType: 'sequence',
          requestCapabilityId: 'benchling.sequence-single-file-export.v1',
        };
  const itemSourceUrl = sanitizeSourceObjectUrl(
    requiredText(record.itemSourceUrl, 'Direct Folder item source URL')
  );
  if (itemSourceUrl !== sourceItemUrl || !urlPathContainsStableId(sourceItemUrl, sourceItemId)) {
    throw new NativeExportDecodeError(
      'native_export_direct_folder_authority_invalid',
      'Direct Folder item URL does not match its observed export authority.'
    );
  }
  return {
    authority,
    itemSourceUrl,
    membershipAuthorityUrl: sanitizeSourceObjectUrl(
      requiredText(record.membershipAuthorityUrl, 'Direct Folder membership authority URL')
    ),
  };
}

function isExactDirectFolderDecodeTarget(
  authority: Record<string, unknown>,
  sourceItemId: string
): boolean {
  return (
    (authority.sourceItemType === 'entry' &&
      /^(?:etr|entry)_[A-Za-z0-9]+$/u.test(sourceItemId) &&
      authority.requestCapabilityId === 'benchling.notebook-entry-html-export.v1') ||
    (authority.sourceItemType === 'sequence' &&
      /^seq_[A-Za-z0-9]+$/u.test(sourceItemId) &&
      authority.requestCapabilityId === 'benchling.sequence-single-file-export.v1')
  );
}

function directFolderContentFamily(authority: DirectFolderExportAuthority): 'notebook' | 'dna_rna' {
  return authority.sourceItemType === 'entry' ? 'notebook' : 'dna_rna';
}

function folderTreeContentFamily(authority: FolderTreeExportAuthority): 'notebook' | 'dna_rna' {
  return authority.sourceItemType === 'entry' ? 'notebook' : 'dna_rna';
}

function validateFolderTreeDecodeAuthority(
  input: NativeExportFolderTreeItemAuthority
): NativeExportFolderTreeItemAuthority {
  const record = requireRecord(input, 'Folder Tree decode authority');
  if (
    Object.keys(record).sort().join('\0') !==
    ['authority', 'itemSourceUrl', 'rootAuthorityUrl'].sort().join('\0')
  ) {
    throw new NativeExportDecodeError(
      'native_export_folder_tree_authority_invalid',
      'Folder Tree decode authority fields are invalid.'
    );
  }
  const authorityRecord = requireRecord(record.authority, 'Folder Tree export authority');
  const exactKeys = [
    'schema',
    'capturePlanDigest',
    'traversalJournalDigest',
    'selectedRootId',
    'sourceItemId',
    'sourceItemUrl',
    'sourceItemType',
    'sourceFolderIds',
    'maximumFolderDepth',
    'requestCapabilityId',
  ];
  if (Object.keys(authorityRecord).sort().join('\0') !== exactKeys.sort().join('\0')) {
    throw new NativeExportDecodeError(
      'native_export_folder_tree_authority_invalid',
      'Folder Tree export authority fields are invalid.'
    );
  }
  const sourceItemId = requiredText(authorityRecord.sourceItemId, 'Tree source item ID');
  const sourceItemUrl = sanitizeSourceObjectUrl(
    requiredText(authorityRecord.sourceItemUrl, 'Tree source item URL')
  );
  const selectedRootId = requiredText(authorityRecord.selectedRootId, 'Tree selected root ID');
  const maximumFolderDepth = authorityRecord.maximumFolderDepth;
  if (
    authorityRecord.schema !== 'dnaforge.benchling.folder-tree-export-authority.v1' ||
    !isExactFolderTreeDecodeTarget(authorityRecord, sourceItemId) ||
    !Array.isArray(authorityRecord.sourceFolderIds) ||
    authorityRecord.sourceFolderIds.length === 0 ||
    authorityRecord.sourceFolderIds.some(
      (id) => typeof id !== 'string' || !/^(?:fld|lib|src)_[A-Za-z0-9]+$/u.test(id)
    ) ||
    new Set(authorityRecord.sourceFolderIds).size !== authorityRecord.sourceFolderIds.length ||
    JSON.stringify(authorityRecord.sourceFolderIds) !==
      JSON.stringify([...authorityRecord.sourceFolderIds].sort()) ||
    typeof maximumFolderDepth !== 'number' ||
    !Number.isSafeInteger(maximumFolderDepth) ||
    maximumFolderDepth < 0 ||
    maximumFolderDepth > 100_000
  ) {
    throw new NativeExportDecodeError(
      'native_export_folder_tree_authority_invalid',
      'Folder Tree authority is not an exact terminal-plan export item.'
    );
  }
  const commonAuthority = {
    schema: 'dnaforge.benchling.folder-tree-export-authority.v1',
    capturePlanDigest: requiredSha256(authorityRecord.capturePlanDigest, 'Tree plan digest'),
    traversalJournalDigest: requiredSha256(
      authorityRecord.traversalJournalDigest,
      'Tree journal digest'
    ),
    selectedRootId,
    sourceItemId,
    sourceItemUrl,
    sourceFolderIds: [...authorityRecord.sourceFolderIds] as string[],
    maximumFolderDepth,
  } as const;
  const authority: FolderTreeExportAuthority =
    authorityRecord.sourceItemType === 'sequence'
      ? {
          ...commonAuthority,
          sourceItemType: 'sequence',
          requestCapabilityId: 'benchling.sequence-single-file-export.v1',
        }
      : {
          ...commonAuthority,
          sourceItemType: 'entry',
          requestCapabilityId: 'benchling.notebook-entry-html-export.v1',
        };
  const itemSourceUrl = sanitizeSourceObjectUrl(
    requiredText(record.itemSourceUrl, 'Folder Tree item source URL')
  );
  if (itemSourceUrl !== sourceItemUrl || !urlPathContainsStableId(sourceItemUrl, sourceItemId)) {
    throw new NativeExportDecodeError(
      'native_export_folder_tree_authority_invalid',
      'Folder Tree item URL does not match its observed export authority.'
    );
  }
  return {
    authority,
    itemSourceUrl,
    rootAuthorityUrl: sanitizeSourceObjectUrl(
      requiredText(record.rootAuthorityUrl, 'Folder Tree root authority URL')
    ),
  };
}

function isExactFolderTreeDecodeTarget(
  authority: Record<string, unknown>,
  sourceItemId: string
): boolean {
  return (
    (authority.sourceItemType === 'entry' &&
      /^(?:etr|entry)_[A-Za-z0-9]+$/u.test(sourceItemId) &&
      authority.requestCapabilityId === 'benchling.notebook-entry-html-export.v1') ||
    (authority.sourceItemType === 'sequence' &&
      /^seq_[A-Za-z0-9]+$/u.test(sourceItemId) &&
      authority.requestCapabilityId === 'benchling.sequence-single-file-export.v1')
  );
}

function sameDirectFolderAuthority(
  left: DirectFolderExportAuthority | undefined,
  right: DirectFolderExportAuthority
): boolean {
  return Boolean(
    left &&
    left.schema === right.schema &&
    left.capturePlanDigest === right.capturePlanDigest &&
    left.traversalJournalDigest === right.traversalJournalDigest &&
    left.selectedRootId === right.selectedRootId &&
    left.sourceItemId === right.sourceItemId &&
    left.sourceItemType === right.sourceItemType &&
    left.sourceFolderIds.length === 1 &&
    left.sourceFolderIds[0] === right.sourceFolderIds[0] &&
    left.requestCapabilityId === right.requestCapabilityId
  );
}

function sameFolderTreeAuthority(
  left: FolderTreeExportAuthority | undefined,
  right: FolderTreeExportAuthority
): boolean {
  return Boolean(
    left &&
    left.schema === right.schema &&
    left.capturePlanDigest === right.capturePlanDigest &&
    left.traversalJournalDigest === right.traversalJournalDigest &&
    left.selectedRootId === right.selectedRootId &&
    left.sourceItemId === right.sourceItemId &&
    left.sourceItemType === right.sourceItemType &&
    JSON.stringify(left.sourceFolderIds) === JSON.stringify(right.sourceFolderIds) &&
    left.maximumFolderDepth === right.maximumFolderDepth &&
    left.requestCapabilityId === right.requestCapabilityId
  );
}

function urlPathContainsStableId(value: string, stableId: string): boolean {
  try {
    return parseExactlyOneBenchlingObjectUrl(value).objectId === stableId;
  } catch {
    return false;
  }
}

function isControlPath(entryPath: string): boolean {
  return (
    /(^|\/)benchling-export-manifest\.json$/i.test(entryPath) ||
    /(^|\/)(?:schema|[^/]+\.schema)\.json$/i.test(entryPath)
  );
}

function isRegistryFamily(value: string): boolean {
  return value.includes('registry') || value.includes('entity');
}

function isProtocolExecutionSourceType(value: string): boolean {
  return ['protocol_execution', 'protocol_run', 'execution'].includes(value);
}

function isTextPath(entryPath: string): boolean {
  return /\.(?:txt|csv|tsv|json|jsonl|html?|gbk?|genbank|fa|fasta|fna|ffn|faa|md|xml)$/i.test(
    entryPath
  );
}

function stableIdFrom(
  value: string | null | undefined,
  entryPath: string,
  entryHash: string
): string {
  const explicit = value?.match(BENCHLING_ID)?.[0] ?? value?.trim();
  if (explicit) return explicit;
  const canonicalSuffixId = canonicalExportSuffixSourceId(entryPath);
  if (canonicalSuffixId) return canonicalSuffixId;
  const pathId = entryPath.match(BENCHLING_ID)?.[0];
  return pathId ?? artifactIdentity(entryPath, entryHash);
}

function artifactIdentity(entryPath: string, entryHash: string): string {
  return `artifact_${sha256(`${entryPath}\0${entryHash}`).slice(0, 24)}`;
}

function decodedSourceUrl(
  context: AnyNativeExportDecodeContext,
  stableId: string,
  explicitSourceUrl: string | undefined
): string {
  if (explicitSourceUrl) return sanitizeSourceObjectUrl(explicitSourceUrl);
  if (isLocalDecodeContext(context)) {
    return localBundleProvenanceUrn(context.localBundleAuthority.sha256, stableId);
  }
  return sourceUrl(context.sourceUrlPrefix, stableId);
}

export function localBundleProvenanceUrn(sha256: string, sourceObjectId: string): string {
  const digest = requiredSha256(sha256, 'local export SHA-256').slice('sha256:'.length);
  const objectId = requiredText(sourceObjectId, 'local source object ID');
  return `urn:dnaforge:benchling-local-export:sha256:${digest}#${encodeURIComponent(objectId)}`;
}

function sourceUrl(prefix: string, stableId: string): string {
  let parsed: URL;
  try {
    parsed = new URL(prefix);
  } catch {
    throw new NativeExportDecodeError(
      'native_export_source_url_invalid',
      'Source URL prefix is invalid.'
    );
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new NativeExportDecodeError(
      'native_export_source_url_invalid',
      'Source URL prefix must use credential-free HTTPS.'
    );
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/${encodeURIComponent(stableId)}`;
  return parsed.toString();
}

function sanitizeSourceObjectUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new NativeExportDecodeError(
      'native_export_source_url_invalid',
      'Manifest source URL is invalid.'
    );
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new NativeExportDecodeError(
      'native_export_source_url_invalid',
      'Manifest source URL must use credential-free HTTPS.'
    );
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function firstHtmlHeading(html: string): string | null {
  const match = html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/i);
  const text = match ? stripTags(match[1]).trim() : '';
  return text || null;
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#([0-9]{1,7})|#x([0-9a-f]{1,6}));/giu,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal ?? '', decimal ? 10 : 16);
        return codePoint > 0 &&
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : '\uFFFD';
      }
      return (
        {
          '&amp;': '&',
          '&quot;': '"',
          '&apos;': "'",
          '&lt;': '<',
          '&gt;': '>',
        }[entity.toLowerCase()] ?? entity
      );
    }
  );
}

function mergeRelationships(
  left: SourceRelationship[],
  right: SourceRelationship[]
): SourceRelationship[] {
  const byId = new Map([...left, ...right].map((relationship) => [relationship.id, relationship]));
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mediaTypeForPath(entryPath: string): string {
  const extension = path.posix.extname(entryPath).toLowerCase();
  return (
    (
      {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.html': 'text/html',
        '.csv': 'text/csv',
        '.json': 'application/json',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  );
}

function firstRowValue(row: Record<string, unknown>, keys: string[]): string | null {
  const desired = new Set(keys);
  for (const [key, value] of Object.entries(row)) {
    if (desired.has(normalizeColumn(key)) && String(value ?? '').trim())
      return String(value).trim();
  }
  return null;
}

function rowValueForField(
  row: Record<string, unknown>,
  field: RegistrySchemaSidecar['fields'][number],
  key: string
): unknown {
  const candidates = new Set([
    normalizeColumn(key),
    normalizeColumn(field.sourceFieldId),
    normalizeColumn(String(field.definition.label ?? '')),
  ]);
  for (const [column, value] of Object.entries(row))
    if (candidates.has(normalizeColumn(column))) return value;
  return null;
}

function normalizeColumn(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function normalizeType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}
function compareSourceObjects(left: SourceObject, right: SourceObject): number {
  return (
    left.stableId.localeCompare(right.stableId) ||
    (left.sourcePath ?? '').localeCompare(right.sourcePath ?? '')
  );
}
function compareAttachments(
  left: NativeExportAttachmentEvidence,
  right: NativeExportAttachmentEvidence
): number {
  return (
    left.sourceObjectId.localeCompare(right.sourceObjectId) ||
    left.entryPath.localeCompare(right.entryPath)
  );
}
function unsupportedEvidence(
  object: SourceObject,
  entryPath: string,
  reason: string
): NativeExportUnsupportedEvidence {
  return { entryPath, reason, preservedSourceObjectId: object.id };
}
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => requiredText(value, 'text value')))].sort();
}
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function decodeUtf8(value: Uint8Array | undefined, entryPath: string, optional: boolean): string {
  if (!value) {
    if (optional) return '';
    throw new NativeExportDecodeError(
      'native_export_entry_missing_bytes',
      `Entry ${entryPath} was not captured.`,
      entryPath
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value).replace(/^\uFEFF/, '');
  } catch {
    throw new NativeExportDecodeError(
      'native_export_text_not_utf8',
      `Entry ${entryPath} is not valid UTF-8.`,
      entryPath
    );
  }
}

function parseJsonObject(
  value: Uint8Array | undefined,
  entryPath: string
): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(decodeUtf8(value, entryPath, false)), entryPath);
  } catch (error) {
    if (error instanceof NativeExportDecodeError) throw error;
    throw new NativeExportDecodeError(
      'native_export_json_malformed',
      `Entry ${entryPath} is malformed JSON.`,
      entryPath
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new NativeExportDecodeError(
      'native_export_record_invalid',
      `${label} must be an object.`
    );
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new NativeExportDecodeError('native_export_text_invalid', `${label} is required.`);
  return value.trim();
}
function requiredTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!Number.isFinite(Date.parse(text)))
    throw new NativeExportDecodeError(
      'native_export_timestamp_invalid',
      `${label} must be an ISO timestamp.`
    );
  return new Date(text).toISOString();
}
function requiredSha256(value: unknown, label: string): string {
  const text = requiredText(value, label).toLowerCase();
  const normalized = text.startsWith('sha256:') ? text : `sha256:${text}`;
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized))
    throw new NativeExportDecodeError('native_export_hash_invalid', `${label} must be SHA-256.`);
  return normalized;
}
function textArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new NativeExportDecodeError('native_export_array_invalid', `${label} must be an array.`);
  return sortedUnique(value.map((entry) => requiredText(entry, label)));
}
function optionalTextProperty(value: unknown, key: string): Record<string, string> {
  return value === undefined || value === null || value === ''
    ? {}
    : { [key]: requiredText(value, key) };
}
function optionalTimestampProperty(value: unknown, key: string): Record<string, string> {
  return value === undefined || value === null || value === ''
    ? {}
    : { [key]: requiredTimestamp(value, key) };
}

function assertUniqueSourceObjects(objects: SourceObject[]): void {
  const ids = new Set<string>();
  for (const object of objects) {
    if (ids.has(object.id))
      throw new NativeExportDecodeError(
        'native_export_source_identity_duplicate',
        `Decoded source identity ${object.id} is duplicated.`
      );
    ids.add(object.id);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)])
  );
}
