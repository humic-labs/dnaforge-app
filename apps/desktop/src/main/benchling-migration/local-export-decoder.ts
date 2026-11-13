import { createHash } from 'node:crypto';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  ExternalZipEntryEvidence,
  ExternalZipSource,
  LocalNativeFolderZipAttachmentClass,
  LocalNativeFolderZipCanonicalClass,
  LocalNativeFolderZipInventory,
  MigrationScope,
  SourceObject,
} from '../../shared/benchling-migration';
import { ContentArchive } from './content-archive';
import { verifyExternalZipSource } from './external-zip-source';
import {
  LocalBenchlingExportHierarchyError,
  planLocalBenchlingExportHierarchy,
  type LocalBenchlingExportCanonicalItem,
  type LocalBenchlingExportHierarchyEvidence,
  type LocalBenchlingExportHierarchyItem,
  type LocalBenchlingExportHierarchyPlan,
} from './local-export-hierarchy';
import type { VerifiedLocalBenchlingExportArtifact } from './local-export-bundle';
import {
  inspectNativeExportArchive,
  persistNativeExportArchiveEntries,
} from './native-export-archive';
import {
  BENCHLING_NATIVE_EXPORT_DECODER_VERSION,
  localBundleProvenanceUrn,
  verifiedStrainCompanionKeys,
  relationshipsFromStandaloneBenchlingHtml,
  type DecodedLocalNativeExportEvidence,
  type LocalNativeExportBundleAuthority,
  type NativeExportAttachmentEvidence,
} from './native-export-decoder';
import { decodeLocalNativeExportInDedicatedWorker } from './native-export-decoder-worker-client';
import { NOTEBOOK_HTML_PROJECTION_LIMITS } from './notebook-html-projection';
import { nativeRecordSourcePersistenceRequests } from './native-sequence-source-evidence';
import { attachStrainRelationships } from './strain-relationship-resolver';
import { resolveOfflineRelationships } from './relationship-resolver';
import { benchlingOrganizationBaseUrlFromSourceRef } from './source-identity';
import { decodeWorkspaceAppendExport } from './workspace-append-decoder';

const LOCAL_EXPORT_CAPTURE_SCHEMA = 'dnaforge.benchling.local-export-capture.v1' as const;
const LOCAL_HTML_DECODER_VERSION = 'benchling-local-html-decoder.v1' as const;
const BENCHLING_ENTRY_ID = /\b(?:etr|entry)_[A-Za-z0-9]+\b/gu;
const FOLDER_CANONICAL_OBJECT_ID = /\b(?:bfi|etr|prt|prtn|seq)_[A-Za-z0-9]+\b/gu;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/iu;

export type LocalBenchlingExportRawPart = Readonly<{
  id: string;
  kind: 'local_export' | 'attachment' | 'source_record';
  logicalFilename: string;
  sourceArchivePath: string;
  sourceObjectId: string | null;
  capturedAt: string;
  localPath: string;
  expectedSha256: string;
  expectedSizeBytes: number;
}>;

export type LocalBenchlingExportCapture = Readonly<{
  schema: typeof LOCAL_EXPORT_CAPTURE_SCHEMA;
  snapshotId: string;
  capturedAt: string;
  localArtifact: Readonly<{
    logicalFilename: string;
    sha256: `sha256:${string}`;
    sizeBytes: number;
    format: 'zip' | 'html';
  }>;
  sourceObjects: SourceObject[];
  rawParts: LocalBenchlingExportRawPart[];
  manifest: Readonly<{
    sourceObjectIds: string[];
    attachmentReferences: Array<{ sourceObjectId: string; sha256: string }>;
    membershipReferences: Array<{ sourceObjectId: string; collectionId: string }>;
  }>;
  hierarchy: LocalBenchlingExportHierarchyEvidence | null;
  nativeFolderZipInventory: LocalNativeFolderZipInventory | null;
  warnings: string[];
}>;

export type { LocalBenchlingExportHierarchyEvidence } from './local-export-hierarchy';

export type DecodeLocalBenchlingExportBundleInput = Readonly<{
  artifact: VerifiedLocalBenchlingExportArtifact;
  archive: ContentArchive;
  externalZipSource?: ExternalZipSource;
  externalZipEntries?: readonly ExternalZipEntryEvidence[];
  nativeWorkspaceRunId?: string;
  excludedEntryPaths?: readonly string[];
  fallbackEntryPaths?: readonly string[];
  reviewedTables?: readonly RegistryTableMappingDecision[];
  capturedAt: string;
  scope?: MigrationScope;
  preparedZip?: PreparedLocalBenchlingExportZip;
}>;

const PREPARED_LOCAL_ZIP_SCHEMA = 'dnaforge.benchling.prepared-local-export-zip.v1' as const;

export type PreparedLocalBenchlingExportZip = Readonly<{
  schema: typeof PREPARED_LOCAL_ZIP_SCHEMA;
  artifactIdentity: Readonly<{
    logicalFilename: string;
    sha256: `sha256:${string}`;
    sizeBytes: number;
    immutableLocalPath: string;
  }>;
  capturedAt: string;
  scopeFingerprint: string;
  inspected: Awaited<ReturnType<typeof inspectNativeExportArchive>>;
  snapshotId: string;
  archivePartId: string;
  sourceObjects: readonly SourceObject[];
  selectedAttachments: readonly NativeExportAttachmentEvidence[];
  selectedAttachmentEntrySha256: Readonly<Record<string, string>>;
  hierarchy: LocalBenchlingExportHierarchyEvidence | null;
  nativeFolderZipInventory: LocalNativeFolderZipInventory | null;
  warnings: readonly string[];
}>;

export type LocalBenchlingExportDecodeErrorCode =
  | 'local_export_capture_time_invalid'
  | 'local_export_notebook_html_missing'
  | 'local_export_notebook_html_ambiguous'
  | 'local_export_notebook_object_missing'
  | 'local_export_canonical_object_missing'
  | 'local_export_folder_zip_required'
  | 'local_export_folder_hierarchy_ambiguous'
  | 'local_export_artifact_mismatch'
  | 'local_export_html_too_large';

export class LocalBenchlingExportDecodeError extends Error {
  constructor(
    readonly code: LocalBenchlingExportDecodeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LocalBenchlingExportDecodeError';
  }
}

export async function decodeLocalBenchlingExportBundle(
  input: DecodeLocalBenchlingExportBundleInput
): Promise<LocalBenchlingExportCapture> {
  const verified = await verifyLocalDecodeInput(input);
  if (input.nativeWorkspaceRunId) {
    if (
      !input.externalZipSource ||
      !input.externalZipEntries ||
      input.artifact.format !== 'zip' ||
      input.scope?.kind !== 'file' ||
      input.preparedZip
    )
      throw new LocalBenchlingExportDecodeError(
        'local_export_artifact_mismatch',
        'A native workspace import requires one verified external ZIP and its file scope.'
      );
    const decoded = await decodeWorkspaceAppendExport({
      artifact: input.artifact,
      archive: input.archive,
      externalZipEntries: input.externalZipEntries,
      capturedAt: verified.capturedAt,
      runId: input.nativeWorkspaceRunId,
      attemptId: input.nativeWorkspaceRunId,
      artifactId: input.artifact.sha256,
      destinationFolderId: null,
      reviewedTables: input.reviewedTables,
      excludedEntryPaths: input.excludedEntryPaths,
      fallbackEntryPaths: input.fallbackEntryPaths,
    });
    return capture({
      artifact: input.artifact,
      capturedAt: verified.capturedAt,
      snapshotId: decoded.snapshotId,
      sourceObjects: decoded.matched.map((entry) => entry.sourceObject),
      rawParts: [
        exportRawPart(
          input.artifact,
          verified.immutableLocalPath,
          decoded.archivePartId,
          verified.capturedAt
        ),
        ...decoded.matched.flatMap(({ sourceObject, attachments }) =>
          attachments.map(({ evidence }) =>
            attachmentRawPart({
              artifactSha256: input.artifact.sha256,
              sourceObjectId: sourceObject.id,
              logicalFilename: evidence.logicalFilename,
              sourceArchivePath: evidence.entryPath,
              capturedAt: verified.capturedAt,
              localPath: verified.immutableLocalPath,
              sha256: unprefixedSha256(evidence.sha256),
              sizeBytes: evidence.sizeBytes,
            })
          )
        ),
        ...decoded.matched.flatMap(({ sourceObject }) =>
          nativeRecordSourcePersistenceRequests([sourceObject]).map((request) => {
            const entry = input.externalZipEntries?.find(
              (entry) =>
                entry.entryPath === request.entryPath &&
                unprefixedSha256(entry.entrySha256) === unprefixedSha256(request.expectedSha256)
            );
            if (!entry)
              throw new LocalBenchlingExportDecodeError(
                'local_export_artifact_mismatch',
                'A source record has no exact external ZIP evidence.'
              );
            return sourceRecordRawPart({
              artifactSha256: input.artifact.sha256,
              sourceObjectId: sourceObject.id,
              sourceArchivePath: entry.entryPath,
              capturedAt: verified.capturedAt,
              localPath: verified.immutableLocalPath,
              sha256: unprefixedSha256(entry.entrySha256),
              sizeBytes: entry.sizeBytes,
            });
          })
        ),
      ],
      hierarchy: null,
      nativeFolderZipInventory: null,
      warnings: decoded.matched.flatMap(({ sourceObject }) => [
        ...preservedAsFileWarnings(sourceObject),
        ...unresolvedImageWarnings(sourceObject),
      ]),
    });
  }
  if (input.artifact.format === 'html') {
    if (input.preparedZip) {
      throw new LocalBenchlingExportDecodeError(
        'local_export_artifact_mismatch',
        'A prepared ZIP review cannot be used for an HTML artifact.'
      );
    }
    return decodeLocalHtml(
      input.artifact,
      input.archive,
      verified.immutableLocalPath,
      verified.capturedAt
    );
  }
  if (input.preparedZip && input.fallbackEntryPaths?.length) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_artifact_mismatch',
      'A prepared ZIP review cannot be reused with new fallback files.'
    );
  }
  const prepared =
    input.preparedZip ??
    (await prepareLocalZip(
      input.artifact,
      verified.immutableLocalPath,
      verified.capturedAt,
      input.scope,
      input.fallbackEntryPaths
    ));
  assertPreparedLocalZipMatchesInput(prepared, input, verified);
  return materializePreparedLocalZip(
    prepared,
    input.artifact,
    input.archive,
    input.externalZipSource ? input.externalZipEntries : undefined
  );
}

export async function prepareLocalBenchlingExportZip(
  input: Omit<DecodeLocalBenchlingExportBundleInput, 'preparedZip'>
): Promise<PreparedLocalBenchlingExportZip> {
  const verified = await verifyLocalDecodeInput(input);
  if (input.artifact.format !== 'zip') {
    throw new LocalBenchlingExportDecodeError(
      'local_export_folder_zip_required',
      'A read-only folder review requires the downloaded Benchling ZIP.'
    );
  }
  return prepareLocalZip(
    input.artifact,
    verified.immutableLocalPath,
    verified.capturedAt,
    input.scope
  );
}

async function verifyLocalDecodeInput(
  input:
    | Omit<DecodeLocalBenchlingExportBundleInput, 'preparedZip'>
    | DecodeLocalBenchlingExportBundleInput
): Promise<{ capturedAt: string; immutableLocalPath: string }> {
  const capturedAt = captureTimestamp(input.capturedAt);
  if (
    input.externalZipSource &&
    (!input.externalZipEntries ||
      input.externalZipEntries.some(
        (entry) => entry.sourceId !== input.externalZipSource?.sourceId
      ))
  ) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_artifact_mismatch',
      'The external ZIP entry catalog is missing or belongs to another source.'
    );
  }
  const immutableLocalPath = input.externalZipSource
    ? await verifyExternalZipSource(input.externalZipSource)
    : (
        await input.archive.verifyBlob(
          unprefixedSha256(input.artifact.sha256),
          input.artifact.sizeBytes
        )
      ).path;
  if (path.resolve(immutableLocalPath) !== path.resolve(input.artifact.immutableLocalPath)) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_artifact_mismatch',
      'The verified local export does not belong to the selected immutable archive.'
    );
  }
  if (
    input.artifact.format === 'html' &&
    input.scope &&
    (input.scope.kind === 'folder' || input.scope.kind === 'folder_tree')
  ) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_folder_zip_required',
      'Folder and Folder Tree imports require the downloaded Benchling ZIP, not one HTML file.'
    );
  }
  return { capturedAt, immutableLocalPath };
}

async function prepareLocalZip(
  artifact: Extract<VerifiedLocalBenchlingExportArtifact, { format: 'zip' }>,
  immutableLocalPath: string,
  capturedAt: string,
  scope?: MigrationScope,
  fallbackEntryPaths?: readonly string[]
): Promise<PreparedLocalBenchlingExportZip> {
  const inspected = await inspectNativeExportArchive(artifact.nativeExportDecoderSource);
  const folderScope = scope && scope.kind !== 'file' ? scope : null;
  const primaryHtmlPaths = inspected.entries
    .filter(
      (entry) =>
        !entry.isDirectory && /\.html?$/iu.test(entry.path) && !hasAttachmentPathSegment(entry.path)
    )
    .map((entry) => entry.path)
    .sort(compareText);
  if (!folderScope && primaryHtmlPaths.length === 0) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_notebook_html_missing',
      'The local Benchling ZIP does not contain a notebook HTML primary.'
    );
  }
  if (!folderScope && primaryHtmlPaths.length !== 1) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_notebook_html_ambiguous',
      `The local Benchling ZIP contains ${primaryHtmlPaths.length} possible notebook HTML primaries; select a single-file export.`
    );
  }
  let hierarchyPlan: LocalBenchlingExportHierarchyPlan | null = null;
  if (folderScope) {
    try {
      const canonicalItems = discoverCanonicalFolderObjects(
        inspected.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path),
        await verifiedStrainCompanionKeys(inspected)
      );
      hierarchyPlan = planLocalBenchlingExportHierarchy({
        scope: folderScope,
        canonicalItems,
      });
    } catch (error) {
      if (!(error instanceof LocalBenchlingExportHierarchyError)) throw error;
      throw new LocalBenchlingExportDecodeError(
        'local_export_folder_hierarchy_ambiguous',
        error.message
      );
    }
  }

  const plannedItems = hierarchyPlan?.items ?? [
    {
      canonicalPath: primaryHtmlPaths[0],
      sourceObjectId: null,
      sourceKind: 'notebook_entry' as const,
      membershipFolderId: null,
      included: true,
    },
  ];
  const includedItems = plannedItems.filter((item) => item.included);

  const identity = localCaptureIdentity(
    artifact.sha256,
    artifact.logicalFilename,
    artifact.format,
    capturedAt
  );
  const archivePartId = `local-export-part-${identity}`;
  const authority = localAuthority(artifact.logicalFilename, artifact.sha256);
  if (hierarchyPlan && includedItems.length === 0) {
    const hierarchy = hierarchyPlan.evidence;
    return preparedLocalZip({
      artifact,
      immutableLocalPath,
      scope,
      capturedAt,
      snapshotId: `local-snapshot-${identity}`,
      archivePartId,
      inspected,
      sourceObjects: [],
      selectedAttachments: [],
      selectedAttachmentEntrySha256: {},
      hierarchy,
      nativeFolderZipInventory: folderZipInventory({
        inspected,
        plan: hierarchyPlan,
        hierarchy,
        sourceObjects: [],
        skipped: [],
        selectedAttachments: [],
        admittedDependencyIds: new Set(),
      }),
      warnings: hierarchyExclusionWarnings(hierarchy),
    });
  }
  const decodedItems =
    folderScope?.kind === 'folder' && hierarchyPlan ? hierarchyPlan.items : includedItems;
  const decoded = await decodeLocalNativeExportInDedicatedWorker({
    source: artifact.nativeExportDecoderSource,
    inspectedArchive: inspected,
    controlMetadata: { source: 'none' },
    context: {
      snapshotId: `local-snapshot-${identity}`,
      capturedAt,
      archivePartId,
      sourceUrlPrefix: null,
      localBundleAuthority: authority,
      ...(hierarchyPlan
        ? { selectedEntryPaths: decodedItems.map((item) => item.canonicalPath) }
        : fallbackEntryPaths?.length
          ? { selectedEntryPaths: decodedItems.map((item) => item.canonicalPath) }
          : {}),
      ...(fallbackEntryPaths ? { fallbackEntryPaths } : {}),
    },
  });
  const allDecodedCandidates = localHierarchyDecodeCandidates(decodedItems, decoded, hierarchyPlan);
  let decodedCandidates = allDecodedCandidates.filter((candidate) => candidate.item.included);
  let admittedDependencyIds = new Set<string>();

  if (folderScope?.kind === 'folder' && hierarchyPlan) {
    const directObjects = consolidateHierarchySourceObjects(
      decodedCandidates,
      'folder'
    ).sourceObjects;
    const potentialDependencyIds = new Set(
      hierarchyPlan.items.filter((item) => !item.included).map((item) => item.sourceObjectId)
    );
    const dependencyProbeObjects = new Map<string, SourceObject>();
    for (const candidate of allDecodedCandidates) {
      if (!candidate.item.included && !dependencyProbeObjects.has(candidate.item.sourceObjectId)) {
        dependencyProbeObjects.set(candidate.item.sourceObjectId, candidate.sourceObject);
      }
    }
    const resolution = resolveOfflineRelationships({
      sourceObjects: [...directObjects, ...dependencyProbeObjects.values()],
      relationships: directObjects.flatMap((sourceObject) => sourceObject.relationships),
      benchlingOrigin: benchlingOrganizationBaseUrlFromSourceRef(folderScope.folder) ?? undefined,
      selectedSnapshotStableIdsAreAuthoritative: true,
    });
    admittedDependencyIds = new Set(
      resolution.resolutions.flatMap((entry) =>
        entry.classification === 'exact' &&
        entry.targetSourceId &&
        potentialDependencyIds.has(entry.targetSourceId)
          ? [entry.targetSourceId]
          : []
      )
    );
    decodedCandidates = allDecodedCandidates.filter(
      (candidate) =>
        candidate.item.included || admittedDependencyIds.has(candidate.item.sourceObjectId)
    );
  }
  const consolidated = hierarchyPlan
    ? consolidateHierarchySourceObjects(
        decodedCandidates as LocalHierarchyDecodeCandidate[],
        hierarchyPlan.evidence.scopeKind,
        admittedDependencyIds
      )
    : {
        sourceObjects: decodedCandidates.map(({ sourceObject }) => sourceObject),
        warnings: [] as string[],
        skipped: [] as LocalNativeFolderZipInventory['canonicalObjects']['skipped'],
      };
  const sourceObjects = attachStrainRelationships(consolidated.sourceObjects);
  sourceObjects.sort(compareCapturedSourceObjects);
  const selectedSourceObjectIds = new Set(sourceObjects.map((sourceObject) => sourceObject.id));
  const selectedAttachments = uniqueSelectedAttachments(
    decoded.attachments.filter((attachment) =>
      selectedSourceObjectIds.has(attachment.sourceObjectId)
    )
  );
  const decodedEntryByPath = new Map(decoded.entries.map((entry) => [entry.path, entry]));
  const selectedAttachmentEntrySha256: Record<string, string> = {};
  for (const attachment of selectedAttachments) {
    const evidence = decodedEntryByPath.get(attachment.entryPath);
    if (!evidence) {
      throw new LocalBenchlingExportDecodeError(
        'local_export_artifact_mismatch',
        'A decoded notebook attachment is missing its archive evidence.'
      );
    }
    const prior = selectedAttachmentEntrySha256[attachment.entryPath];
    if (prior && prior !== evidence.sha256) {
      throw new LocalBenchlingExportDecodeError(
        'local_export_artifact_mismatch',
        'A selected attachment has conflicting archive evidence.'
      );
    }
    selectedAttachmentEntrySha256[attachment.entryPath] = evidence.sha256;
  }
  const hierarchy = hierarchyPlan
    ? finalizedHierarchyEvidence(hierarchyPlan, sourceObjects, admittedDependencyIds)
    : null;
  const nativeFolderZipInventory = hierarchyPlan
    ? folderZipInventory({
        inspected,
        plan: hierarchyPlan,
        hierarchy: hierarchy ?? hierarchyPlan.evidence,
        sourceObjects,
        skipped: consolidated.skipped,
        selectedAttachments,
        admittedDependencyIds,
      })
    : null;
  const warnings = [
    ...sourceObjects.flatMap(unresolvedImageWarnings),
    ...hierarchyExclusionWarnings(hierarchy),
    ...consolidated.warnings,
  ];
  return preparedLocalZip({
    artifact,
    immutableLocalPath,
    scope,
    capturedAt,
    snapshotId: decoded.snapshotId,
    archivePartId,
    inspected,
    sourceObjects,
    selectedAttachments,
    selectedAttachmentEntrySha256,
    hierarchy,
    nativeFolderZipInventory,
    warnings,
  });
}

function preservedAsFileWarnings(sourceObject: SourceObject): string[] {
  if (
    sourceObject.sourceType !== 'unsupported_object' ||
    typeof sourceObject.metadata.nativeParseException !== 'string'
  ) {
    return [];
  }
  const fileName = path.posix.basename(
    sourceObject.sourcePath?.replaceAll('\\', '/') ?? sourceObject.name
  );
  return [`${fileName} was preserved as a file because it could not become an editable record.`];
}

function preparedLocalZip(input: {
  artifact: Extract<VerifiedLocalBenchlingExportArtifact, { format: 'zip' }>;
  immutableLocalPath: string;
  scope?: MigrationScope;
  capturedAt: string;
  snapshotId: string;
  archivePartId: string;
  inspected: Awaited<ReturnType<typeof inspectNativeExportArchive>>;
  sourceObjects: readonly SourceObject[];
  selectedAttachments: readonly NativeExportAttachmentEvidence[];
  selectedAttachmentEntrySha256: Readonly<Record<string, string>>;
  hierarchy: LocalBenchlingExportHierarchyEvidence | null;
  nativeFolderZipInventory: LocalNativeFolderZipInventory | null;
  warnings: readonly string[];
}): PreparedLocalBenchlingExportZip {
  return Object.freeze({
    schema: PREPARED_LOCAL_ZIP_SCHEMA,
    artifactIdentity: Object.freeze({
      logicalFilename: input.artifact.logicalFilename,
      sha256: input.artifact.sha256,
      sizeBytes: input.artifact.sizeBytes,
      immutableLocalPath: path.resolve(input.immutableLocalPath),
    }),
    capturedAt: input.capturedAt,
    scopeFingerprint: canonicalJson(input.scope ?? null),
    inspected: input.inspected,
    snapshotId: input.snapshotId,
    archivePartId: input.archivePartId,
    sourceObjects: Object.freeze(structuredClone(input.sourceObjects)),
    selectedAttachments: Object.freeze(structuredClone(input.selectedAttachments)),
    selectedAttachmentEntrySha256: Object.freeze({
      ...input.selectedAttachmentEntrySha256,
    }),
    hierarchy: input.hierarchy,
    nativeFolderZipInventory: input.nativeFolderZipInventory,
    warnings: Object.freeze([...new Set(input.warnings)].sort(compareText)),
  });
}

function assertPreparedLocalZipMatchesInput(
  prepared: PreparedLocalBenchlingExportZip,
  input: DecodeLocalBenchlingExportBundleInput,
  verified: { capturedAt: string; immutableLocalPath: string }
): void {
  if (
    prepared.schema !== PREPARED_LOCAL_ZIP_SCHEMA ||
    input.artifact.format !== 'zip' ||
    prepared.artifactIdentity.logicalFilename !== input.artifact.logicalFilename ||
    prepared.artifactIdentity.sha256 !== input.artifact.sha256 ||
    prepared.artifactIdentity.sizeBytes !== input.artifact.sizeBytes ||
    path.resolve(prepared.artifactIdentity.immutableLocalPath) !==
      path.resolve(verified.immutableLocalPath) ||
    prepared.capturedAt !== verified.capturedAt ||
    prepared.scopeFingerprint !== canonicalJson(input.scope ?? null)
  ) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_artifact_mismatch',
      'The prepared local ZIP review does not match this immutable migration input.'
    );
  }
}

async function materializePreparedLocalZip(
  prepared: PreparedLocalBenchlingExportZip,
  artifact: Extract<VerifiedLocalBenchlingExportArtifact, { format: 'zip' }>,
  archive: ContentArchive,
  externalZipEntries?: readonly ExternalZipEntryEvidence[]
): Promise<LocalBenchlingExportCapture> {
  const sourceRecordRequests = nativeRecordSourcePersistenceRequests(prepared.sourceObjects);
  const persistedByPath = externalZipEntries
    ? new Map<string, Awaited<ReturnType<typeof persistNativeExportArchiveEntries>>[number]>()
    : new Map(
        (
          await persistNativeExportArchiveEntries(
            prepared.inspected,
            [
              ...Object.entries(prepared.selectedAttachmentEntrySha256).map(
                ([entryPath, expectedSha256]) => ({ entryPath, expectedSha256 })
              ),
              ...sourceRecordRequests,
            ],
            archive,
            { sourceAlreadyVerified: true }
          )
        ).map((entry) => [entry.evidence.path, entry] as const)
      );
  const externalByPath = new Map(
    (externalZipEntries ?? []).map((entry) => [entry.entryPath, entry] as const)
  );
  const attachmentParts = prepared.selectedAttachments.map((attachment) => {
    const persisted = persistedByPath.get(attachment.entryPath);
    const external = externalByPath.get(attachment.entryPath);
    if (!persisted && !external) {
      throw new LocalBenchlingExportDecodeError(
        'local_export_artifact_mismatch',
        'A decoded notebook attachment has no exact source evidence.'
      );
    }
    const sha256 = persisted
      ? persisted.blob.sha256
      : unprefixedSha256(requireExternalEntry(external).entrySha256);
    const sizeBytes = persisted ? persisted.blob.size : requireExternalEntry(external).sizeBytes;
    return attachmentRawPart({
      artifactSha256: artifact.sha256,
      sourceObjectId: attachment.sourceObjectId,
      logicalFilename: attachment.logicalFilename,
      sourceArchivePath: attachment.entryPath,
      capturedAt: prepared.capturedAt,
      localPath: persisted?.blob.path ?? prepared.artifactIdentity.immutableLocalPath,
      sha256,
      sizeBytes,
    });
  });
  const sourceObjectsByPath = new Map<string, SourceObject[]>();
  for (const sourceObject of prepared.sourceObjects) {
    if (!sourceObject.sourcePath) continue;
    const entries = sourceObjectsByPath.get(sourceObject.sourcePath) ?? [];
    entries.push(sourceObject);
    sourceObjectsByPath.set(sourceObject.sourcePath, entries);
  }
  const sourceRecordParts = sourceRecordRequests.map((request) => {
    const persisted = persistedByPath.get(request.entryPath);
    const external = externalByPath.get(request.entryPath);
    const owners = sourceObjectsByPath.get(request.entryPath) ?? [];
    if ((!persisted && !external) || owners.length !== 1) {
      throw new LocalBenchlingExportDecodeError(
        'local_export_artifact_mismatch',
        'A source record has no exact evidence or does not have one decoded owner.'
      );
    }
    const sha256 = persisted
      ? persisted.blob.sha256
      : unprefixedSha256(requireExternalEntry(external).entrySha256);
    const sizeBytes = persisted ? persisted.blob.size : requireExternalEntry(external).sizeBytes;
    return sourceRecordRawPart({
      artifactSha256: artifact.sha256,
      sourceObjectId: owners[0].id,
      sourceArchivePath: request.entryPath,
      capturedAt: prepared.capturedAt,
      localPath: persisted?.blob.path ?? prepared.artifactIdentity.immutableLocalPath,
      sha256,
      sizeBytes,
    });
  });
  return capture({
    artifact,
    capturedAt: prepared.capturedAt,
    snapshotId: prepared.snapshotId,
    sourceObjects: structuredClone([...prepared.sourceObjects]),
    rawParts: [
      exportRawPart(
        artifact,
        prepared.artifactIdentity.immutableLocalPath,
        prepared.archivePartId,
        prepared.capturedAt
      ),
      ...attachmentParts,
      ...sourceRecordParts,
    ],
    hierarchy: prepared.hierarchy,
    nativeFolderZipInventory: prepared.nativeFolderZipInventory,
    warnings: [...prepared.warnings],
  });
}

type LocalHierarchyDecodeCandidate = Readonly<{
  item: LocalBenchlingExportHierarchyItem;
  sourceObject: SourceObject;
  supported: boolean;
  skipReasonCode: 'empty_sequence' | 'unsupported_content' | null;
  skipReason: string | null;
}>;

type LocalDecodedEntryItem =
  | LocalBenchlingExportHierarchyItem
  | Readonly<{
      canonicalPath: string;
      sourceObjectId: null;
      sourceKind: 'notebook_entry';
      membershipFolderId: null;
      included: true;
    }>;

function localHierarchyDecodeCandidates(
  items: readonly LocalDecodedEntryItem[],
  decoded: DecodedLocalNativeExportEvidence,
  hierarchyPlan: LocalBenchlingExportHierarchyPlan | null
): LocalHierarchyDecodeCandidate[] {
  return items.map((item) => {
    const primaryMatches = decoded.sourceObjects.filter(
      (sourceObject) =>
        sourceObject.sourcePath === item.canonicalPath &&
        (item.sourceObjectId === null || sourceObject.id === item.sourceObjectId) &&
        sourceTypeMatchesCanonicalKind(sourceObject.sourceType, item.sourceKind)
    );
    if (primaryMatches.length !== 1) {
      const unsupportedMatches = decoded.sourceObjects.filter(
        (sourceObject) =>
          sourceObject.sourcePath === item.canonicalPath &&
          (item.sourceObjectId === null || sourceObject.id === item.sourceObjectId) &&
          sourceObject.sourceType === 'unsupported_object'
      );
      if (hierarchyPlan && unsupportedMatches.length === 1 && item.sourceObjectId) {
        const unsupportedEvidence = decoded.unsupported.find(
          (entry) => entry.entryPath === item.canonicalPath
        );
        const emptySequence = unsupportedEvidence?.reason.includes(
          'GenBank record has no sequence'
        );
        const reason = emptySequence
          ? 'its canonical sequence is empty'
          : 'its canonical content is unsupported';
        return {
          item: item as LocalBenchlingExportHierarchyItem,
          sourceObject: unsupportedMatches[0],
          supported: false,
          skipReasonCode: emptySequence
            ? ('empty_sequence' as const)
            : ('unsupported_content' as const),
          skipReason: reason,
        };
      }
      throw new LocalBenchlingExportDecodeError(
        hierarchyPlan
          ? 'local_export_canonical_object_missing'
          : 'local_export_notebook_object_missing',
        hierarchyPlan
          ? 'A canonical Benchling Folder object did not decode to exactly one supported object.'
          : 'The local Benchling ZIP HTML primary did not decode to exactly one notebook.'
      );
    }
    return {
      item: item as LocalBenchlingExportHierarchyItem,
      sourceObject: primaryMatches[0],
      supported: true,
      skipReasonCode: null,
      skipReason: null,
    };
  });
}

function consolidateHierarchySourceObjects(
  candidates: readonly LocalHierarchyDecodeCandidate[],
  scopeKind: 'folder' | 'folder_tree',
  dependencyIds: ReadonlySet<string> = new Set()
): {
  sourceObjects: SourceObject[];
  warnings: string[];
  skipped: LocalNativeFolderZipInventory['canonicalObjects']['skipped'];
} {
  const candidatesById = new Map<string, LocalHierarchyDecodeCandidate[]>();
  for (const candidate of candidates) {
    const grouped = candidatesById.get(candidate.item.sourceObjectId) ?? [];
    grouped.push(candidate);
    candidatesById.set(candidate.item.sourceObjectId, grouped);
  }

  const sourceObjects: SourceObject[] = [];
  const warnings: string[] = [];
  const skipped: Array<LocalNativeFolderZipInventory['canonicalObjects']['skipped'][number]> = [];
  for (const [sourceObjectId, grouped] of [...candidatesById].sort(([left], [right]) =>
    compareText(left, right)
  )) {
    const ordered = [...grouped].sort((left, right) =>
      compareText(left.item.canonicalPath, right.item.canonicalPath)
    );
    const oneHopDependency = scopeKind === 'folder' && dependencyIds.has(sourceObjectId);
    const memberships = oneHopDependency
      ? []
      : [...new Set(ordered.map((candidate) => candidate.item.membershipFolderId))].sort(
          compareText
        );
    if (
      (!oneHopDependency && memberships.length === 0) ||
      (scopeKind === 'folder' && !oneHopDependency && memberships.length !== 1)
    ) {
      throw hierarchyConflict(
        sourceObjectId,
        scopeKind === 'folder'
          ? 'Direct Folder requires exactly one root membership.'
          : 'Folder Tree requires at least one included membership.'
      );
    }

    const supportStates = new Set(ordered.map((candidate) => candidate.supported));
    if (supportStates.size !== 1) {
      throw hierarchyConflict(
        sourceObjectId,
        'one membership decoded as supported while another did not.'
      );
    }
    if (!ordered[0].supported) {
      const entryHashes = new Set(ordered.map(({ sourceObject }) => nativeEntryHash(sourceObject)));
      const skipReasons = new Set(ordered.map(({ skipReason }) => skipReason));
      const sourceTypes = new Set(ordered.map(({ sourceObject }) => sourceObject.sourceType));
      if (entryHashes.size !== 1 || skipReasons.size !== 1 || sourceTypes.size !== 1) {
        throw hierarchyConflict(
          sourceObjectId,
          'unsupported membership representations do not agree.'
        );
      }
      const reason = ordered[0].skipReason ?? 'its canonical content is unsupported';
      warnings.push(
        `${path.posix.basename(ordered[0].item.canonicalPath)} was preserved as a file because ${reason}.`
      );
    }

    if (ordered.length > 1) {
      const representationFingerprints = new Set(
        ordered.map(({ sourceObject }) => comparableSourceObjectJson(sourceObject))
      );
      if (representationFingerprints.size !== 1) {
        throw hierarchyConflict(sourceObjectId, 'membership representations are not identical.');
      }
    }
    sourceObjects.push({
      ...ordered[0].sourceObject,
      attachmentHashes: [...ordered[0].sourceObject.attachmentHashes].sort(compareText),
      memberships,
      relationships: oneHopDependency ? [] : ordered[0].sourceObject.relationships,
    });
  }
  return { sourceObjects, warnings, skipped: Object.freeze(skipped) };
}

function hierarchyConflict(
  sourceObjectId: string,
  detail: string
): LocalBenchlingExportDecodeError {
  return new LocalBenchlingExportDecodeError(
    'local_export_folder_hierarchy_ambiguous',
    `Benchling object ${sourceObjectId} has conflicting Folder ZIP evidence: ${detail}`
  );
}

function nativeEntryHash(sourceObject: SourceObject): unknown {
  const nativeExport = isRecord(sourceObject.metadata.nativeExport)
    ? sourceObject.metadata.nativeExport
    : null;
  return nativeExport?.entrySha256 ?? null;
}

function comparableSourceObjectJson(sourceObject: SourceObject): string {
  const {
    sourcePath: _sourcePath,
    memberships: _memberships,
    metadata,
    content,
    ...rest
  } = sourceObject;
  const nativeExport = isRecord(metadata.nativeExport) ? metadata.nativeExport : null;
  const nativeRecordClassification = isRecord(metadata.nativeRecordClassification)
    ? metadata.nativeRecordClassification
    : null;
  const comparableMetadata = {
    ...metadata,
    ...(nativeExport
      ? {
          nativeExport: Object.fromEntries(
            Object.entries(nativeExport).filter(([key]) => key !== 'entryPath')
          ),
        }
      : {}),
    ...(nativeRecordClassification
      ? {
          nativeRecordClassification: Object.fromEntries(
            Object.entries(nativeRecordClassification).filter(([key]) => key !== 'rawAccess')
          ),
        }
      : {}),
  };
  const comparableContent = isRecord(content)
    ? Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'rawAccess'))
    : content;
  return canonicalJson({
    ...rest,
    content: comparableContent,
    aliases: [...rest.aliases].sort(compareText),
    attachmentHashes: [...rest.attachmentHashes].sort(compareText),
    metadata: comparableMetadata,
  });
}

function finalizedHierarchyEvidence(
  plan: LocalBenchlingExportHierarchyPlan,
  sourceObjects: readonly SourceObject[],
  admittedDependencyIds: ReadonlySet<string>
): LocalBenchlingExportHierarchyEvidence {
  const admittedIds = new Set([
    ...sourceObjects.map((sourceObject) => sourceObject.id),
    ...admittedDependencyIds,
  ]);
  const excludedIds = new Set(
    plan.items
      .filter((item) => !item.included && !admittedIds.has(item.sourceObjectId))
      .map((item) => item.sourceObjectId)
  );
  const excludedChildFolders = plan.evidence.excludedChildFolders.map((folder) => {
    const prefix = `${folder.relativePath}/`;
    const sourceObjectCount = new Set(
      plan.items
        .filter(
          (item) =>
            !item.included &&
            !admittedIds.has(item.sourceObjectId) &&
            item.canonicalPath.startsWith(prefix)
        )
        .map((item) => item.sourceObjectId)
    ).size;
    return Object.freeze({ ...folder, sourceObjectCount });
  });
  return Object.freeze({
    ...plan.evidence,
    excludedChildFolders: Object.freeze(excludedChildFolders),
    selectedSourceObjectCount: sourceObjects.length,
    excludedSourceObjectCount: excludedIds.size,
  });
}

function uniqueSelectedAttachments(
  attachments: readonly NativeExportAttachmentEvidence[]
): NativeExportAttachmentEvidence[] {
  const selected = new Map<string, NativeExportAttachmentEvidence>();
  for (const attachment of [...attachments].sort((left, right) =>
    compareText(left.entryPath, right.entryPath)
  )) {
    const key = canonicalJson({
      entryPath: attachment.entryPath,
      sourceObjectId: attachment.sourceObjectId,
      sourceRef: attachment.sourceRef,
      logicalFilename: attachment.logicalFilename,
      mediaType: attachment.mediaType,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
    });
    if (!selected.has(key)) selected.set(key, attachment);
  }
  return [...selected.values()];
}

function folderZipInventory(input: {
  inspected: Awaited<ReturnType<typeof inspectNativeExportArchive>>;
  plan: LocalBenchlingExportHierarchyPlan;
  hierarchy: LocalBenchlingExportHierarchyEvidence;
  sourceObjects: readonly SourceObject[];
  skipped: LocalNativeFolderZipInventory['canonicalObjects']['skipped'];
  selectedAttachments: readonly NativeExportAttachmentEvidence[];
  admittedDependencyIds: ReadonlySet<string>;
}): LocalNativeFolderZipInventory {
  const archiveIdentities = canonicalIdentityClasses(input.plan.items);
  const selectedIdentities = canonicalIdentityClasses(
    input.plan.items.filter(
      (item) => item.included || input.admittedDependencyIds.has(item.sourceObjectId)
    )
  );
  const importedByClass = emptyCanonicalCounts();
  for (const sourceObject of input.sourceObjects) {
    const canonicalClass = selectedIdentities.get(sourceObject.stableId);
    if (!canonicalClass) {
      throw new LocalBenchlingExportDecodeError(
        'local_export_canonical_object_missing',
        'An imported Folder ZIP object is not present in the selected archive inventory.'
      );
    }
    importedByClass[canonicalClass] += 1;
  }
  const selectedAttachmentCounts = emptyAttachmentCounts();
  for (const attachment of input.selectedAttachments) {
    selectedAttachmentCounts[attachmentClass(attachment.logicalFilename)] += 1;
  }
  const uniqueOwnerContentAttachmentCount = new Set(
    input.selectedAttachments.map(
      (attachment) => `${attachment.sourceObjectId}\0${attachment.sha256}`
    )
  ).size;
  const alternateByClass = {
    sequence_txt: 0,
    sequence_html: 0,
    protein_txt: 0,
    protein_gp: 0,
    protein_html: 0,
  };
  const supportByClass = { benchling_css: 0 };
  for (const entry of input.inspected.entries) {
    if (entry.isDirectory) continue;
    const filename = path.posix.basename(entry.path);
    if (/\(seq_[A-Za-z0-9]+\)\.txt$/iu.test(filename)) alternateByClass.sequence_txt += 1;
    else if (/\(seq_[A-Za-z0-9]+\)\.html?$/iu.test(filename)) {
      alternateByClass.sequence_html += 1;
    } else if (/\(prtn_[A-Za-z0-9]+\)\.txt$/iu.test(filename)) {
      alternateByClass.protein_txt += 1;
    } else if (/\(prtn_[A-Za-z0-9]+\)\.gp$/iu.test(filename)) {
      alternateByClass.protein_gp += 1;
    } else if (/\(prtn_[A-Za-z0-9]+\)\.html?$/iu.test(filename)) {
      alternateByClass.protein_html += 1;
    } else if (entry.path.toLowerCase() === 'benchling.css') {
      supportByClass.benchling_css += 1;
    }
  }
  const explicitDirectoryEntryCount = input.inspected.entries.filter(
    (entry) => entry.isDirectory
  ).length;
  const selectedStableFolderId = input.hierarchy.rootFolderId;
  const selectedFolderIdPattern = new RegExp(
    '(?:^|[^A-Za-z0-9])' + escapeRegExp(selectedStableFolderId) + '(?:$|[^A-Za-z0-9])',
    'u'
  );
  const archiveContainsSelectedStableFolderId = input.inspected.entries.some((entry) =>
    selectedFolderIdPattern.test(entry.path)
  );
  const archiveByClass = canonicalClassCounts(archiveIdentities);
  const selectedByClass = canonicalClassCounts(selectedIdentities);
  const alternateTotal = sumCounts(alternateByClass);
  const supportTotal = sumCounts(supportByClass);
  return Object.freeze({
    schema: 'dnaforge.benchling.local-native-folder-zip-inventory.v1',
    catalog: Object.freeze({
      physicalEntryCount: input.inspected.inventory.physicalCentralDirectoryEntryCount,
      uniqueEntryCount: input.inspected.inventory.canonicalUniqueEntryCount,
    }),
    canonicalObjects: Object.freeze({
      archiveTotal: archiveIdentities.size,
      archiveByClass: Object.freeze(archiveByClass),
      selectedTotal: selectedIdentities.size,
      selectedByClass: Object.freeze(selectedByClass),
      importedTotal: input.sourceObjects.length,
      importedByClass: Object.freeze(importedByClass),
      excludedByScopeTotal: archiveIdentities.size - selectedIdentities.size,
      archiveMembershipTotal: input.plan.items.length,
      selectedMembershipTotal: input.plan.items.filter((item) => item.included).length,
      importedMembershipTotal: input.sourceObjects.reduce(
        (total, sourceObject) => total + sourceObject.memberships.length,
        0
      ),
      skipped: Object.freeze(
        [...input.skipped].sort((left, right) =>
          compareText(left.sourceObjectId, right.sourceObjectId)
        )
      ),
    }),
    selectedAttachments: Object.freeze({
      total: input.selectedAttachments.length,
      uniqueOwnerContentTotal: uniqueOwnerContentAttachmentCount,
      byClass: Object.freeze(selectedAttachmentCounts),
    }),
    archiveRepresentations: Object.freeze({
      alternateTotal,
      alternateByClass: Object.freeze(alternateByClass),
      supportTotal,
      supportByClass: Object.freeze(supportByClass),
      collapsedIdenticalSupportDuplicateCount:
        input.inspected.inventory.collapsedIdenticalDuplicateEntryCount,
    }),
    folders: Object.freeze({
      inferredCount: input.hierarchy.folders.length,
      explicitDirectoryEntryCount,
      emptyFoldersNotPreservableBecauseArchiveOmitsDirectoryEntries:
        explicitDirectoryEntryCount === 0,
    }),
    rootBinding: Object.freeze({
      archiveDisplayRoot: safeInventoryLabel(input.hierarchy.rootFolderName),
      selectedStableFolderId,
      selectedStableFolderIdSource: 'pasted_projects_route_or_user_selection',
      archiveContainsSelectedStableFolderId,
      associationVerification: 'user_asserted_not_archive_verified',
    }),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function canonicalIdentityClasses(
  items: readonly LocalBenchlingExportHierarchyItem[]
): Map<string, LocalNativeFolderZipCanonicalClass> {
  const result = new Map<string, LocalNativeFolderZipCanonicalClass>();
  for (const item of items) {
    const canonicalClass = canonicalClassFromKind(item.sourceKind);
    const existing = result.get(item.sourceObjectId);
    if (existing && existing !== canonicalClass) {
      throw hierarchyConflict(item.sourceObjectId, 'canonical representations disagree on class.');
    }
    result.set(item.sourceObjectId, canonicalClass);
  }
  return result;
}

function emptyCanonicalCounts(): Record<LocalNativeFolderZipCanonicalClass, number> {
  return { notebook: 0, dna_rna: 0, protein: 0 };
}

function canonicalClassCounts(
  identities: ReadonlyMap<string, LocalNativeFolderZipCanonicalClass>
): Record<LocalNativeFolderZipCanonicalClass, number> {
  const result = emptyCanonicalCounts();
  for (const canonicalClass of identities.values()) result[canonicalClass] += 1;
  return result;
}

function canonicalClassFromKind(
  sourceKind: LocalBenchlingExportHierarchyItem['sourceKind']
): LocalNativeFolderZipCanonicalClass {
  return sourceKind === 'notebook_entry'
    ? 'notebook'
    : sourceKind === 'sequence'
      ? 'dna_rna'
      : 'protein';
}

function emptyAttachmentCounts(): Record<LocalNativeFolderZipAttachmentClass, number> {
  return { png: 0, jpg: 0, pdf: 0, ab1: 0, gbk: 0, seq: 0, other: 0 };
}

function attachmentClass(logicalFilename: string): LocalNativeFolderZipAttachmentClass {
  const extension = path.posix.extname(logicalFilename).slice(1).toLowerCase();
  if (extension === 'jpeg') return 'jpg';
  if (
    extension === 'png' ||
    extension === 'jpg' ||
    extension === 'pdf' ||
    extension === 'ab1' ||
    extension === 'gbk' ||
    extension === 'seq'
  ) {
    return extension;
  }
  return 'other';
}

function sumCounts(value: Readonly<Record<string, number>>): number {
  return Object.values(value).reduce((total, count) => total + count, 0);
}

function safeInventoryLabel(value: string): string {
  const printable = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim();
  if (!printable || printable.length > 256 || /[\\/]/u.test(printable)) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_folder_hierarchy_ambiguous',
      'The Folder ZIP display root is not safe to include in validation evidence.'
    );
  }
  return printable;
}

async function decodeLocalHtml(
  artifact: Extract<VerifiedLocalBenchlingExportArtifact, { format: 'html' }>,
  archive: ContentArchive,
  immutableLocalPath: string,
  capturedAt: string
): Promise<LocalBenchlingExportCapture> {
  if (artifact.sizeBytes > NOTEBOOK_HTML_PROJECTION_LIMITS.maximumHtmlBytes) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_html_too_large',
      `Notebook HTML exceeds ${NOTEBOOK_HTML_PROJECTION_LIMITS.maximumHtmlBytes} bytes.`
    );
  }
  const html = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(immutableLocalPath));
  const stableId = localHtmlStableId(artifact.logicalFilename, html, artifact.sha256);
  const identity = localCaptureIdentity(
    artifact.sha256,
    artifact.logicalFilename,
    artifact.format,
    capturedAt
  );
  const archivePartId = `local-export-part-${identity}`;
  const resources = await Promise.all(
    [...artifact.resources]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map(async (resource) => {
        const digest = unprefixedSha256(resource.sha256);
        const blob = await archive.verifyBlob(digest, resource.sizeBytes);
        if (path.resolve(blob.path) !== path.resolve(resource.immutableLocalPath)) {
          throw new LocalBenchlingExportDecodeError(
            'local_export_artifact_mismatch',
            'A local HTML resource does not belong to the selected immutable archive.'
          );
        }
        return { resource, blob };
      })
  );
  const attachments = resources.map(({ resource }) => ({
    sourceRef: resource.sourceRef,
    sha256: resource.sha256,
    fileName: resource.logicalFilename,
    mediaType: resource.mediaType,
  }));
  const uniqueResources = [
    ...new Map(resources.map((entry) => [entry.resource.relativePath, entry] as const)).values(),
  ];
  const sourceObject: SourceObject = {
    id: stableId,
    stableId,
    sourceType: 'notebook_entry',
    name:
      htmlTitle(html) ??
      path.basename(artifact.logicalFilename, path.extname(artifact.logicalFilename)),
    aliases: [],
    sourceUrl: localBundleProvenanceUrn(artifact.sha256, stableId),
    sourcePath: artifact.logicalFilename,
    attachmentHashes: [...new Set(resources.map(({ resource }) => resource.sha256))].sort(),
    memberships: [],
    metadata: {
      nativeExport: {
        decoderVersion: LOCAL_HTML_DECODER_VERSION,
        contentFamily: 'notebook',
        archiveSha256: artifact.sha256,
        entryPath: artifact.logicalFilename,
        entrySha256: artifact.sha256,
        entrySizeBytes: artifact.sizeBytes,
        identityMethod:
          stableId.startsWith('etr_') || stableId.startsWith('entry_')
            ? 'local_filename_or_html_evidence'
            : 'local_artifact_evidence',
        sourceUrlMethod: 'local_export_provenance_urn',
        localBundleProvenance: {
          schema: 'dnaforge.benchling.local-native-export-authority.v1',
          logicalFilename: artifact.logicalFilename,
          sha256: artifact.sha256,
        },
      },
    },
    content: { html, attachments },
    relationships: relationshipsFromStandaloneBenchlingHtml(
      stableId,
      html,
      artifact.logicalFilename
    ),
  };
  const attachmentParts = uniqueResources.map(({ resource, blob }) =>
    attachmentRawPart({
      artifactSha256: artifact.sha256,
      sourceObjectId: stableId,
      logicalFilename: resource.logicalFilename,
      sourceArchivePath: resource.relativePath,
      capturedAt,
      localPath: blob.path,
      sha256: blob.sha256,
      sizeBytes: blob.size,
    })
  );
  return capture({
    artifact,
    capturedAt,
    snapshotId: `local-snapshot-${identity}`,
    sourceObjects: [sourceObject],
    rawParts: [
      exportRawPart(artifact, immutableLocalPath, archivePartId, capturedAt),
      ...attachmentParts,
    ],
    hierarchy: null,
    nativeFolderZipInventory: null,
    warnings: unresolvedImageWarnings(sourceObject),
  });
}

function capture(input: {
  artifact: VerifiedLocalBenchlingExportArtifact;
  capturedAt: string;
  snapshotId: string;
  sourceObjects: SourceObject[];
  rawParts: LocalBenchlingExportRawPart[];
  hierarchy: LocalBenchlingExportHierarchyEvidence | null;
  nativeFolderZipInventory: LocalNativeFolderZipInventory | null;
  warnings: string[];
}): LocalBenchlingExportCapture {
  const sourceObjectIds = input.sourceObjects.map((sourceObject) => sourceObject.id);
  return {
    schema: LOCAL_EXPORT_CAPTURE_SCHEMA,
    snapshotId: input.snapshotId,
    capturedAt: input.capturedAt,
    localArtifact: {
      logicalFilename: input.artifact.logicalFilename,
      sha256: input.artifact.sha256,
      sizeBytes: input.artifact.sizeBytes,
      format: input.artifact.format,
    },
    sourceObjects: input.sourceObjects,
    rawParts: input.rawParts,
    manifest: {
      sourceObjectIds,
      attachmentReferences: input.sourceObjects.flatMap((sourceObject) =>
        sourceObject.attachmentHashes.map((sha256) => ({
          sourceObjectId: sourceObject.id,
          sha256,
        }))
      ),
      membershipReferences: input.sourceObjects.flatMap((sourceObject) =>
        sourceObject.memberships.map((collectionId) => ({
          sourceObjectId: sourceObject.id,
          collectionId,
        }))
      ),
    },
    hierarchy: input.hierarchy,
    nativeFolderZipInventory: input.nativeFolderZipInventory,
    warnings: [...new Set(input.warnings)].sort(),
  };
}

function exportRawPart(
  artifact: VerifiedLocalBenchlingExportArtifact,
  immutableLocalPath: string,
  archivePartId: string,
  capturedAt: string
): LocalBenchlingExportRawPart {
  return {
    id: archivePartId,
    kind: 'local_export',
    logicalFilename: artifact.logicalFilename,
    sourceArchivePath: artifact.logicalFilename,
    sourceObjectId: null,
    capturedAt,
    localPath: immutableLocalPath,
    expectedSha256: unprefixedSha256(artifact.sha256),
    expectedSizeBytes: artifact.sizeBytes,
  };
}

function attachmentRawPart(input: {
  artifactSha256: string;
  sourceObjectId: string;
  logicalFilename: string;
  sourceArchivePath: string;
  capturedAt: string;
  localPath: string;
  sha256: string;
  sizeBytes: number;
}): LocalBenchlingExportRawPart {
  return {
    id: `local-attachment-${stableDigest(`${input.artifactSha256}\0${input.sourceArchivePath}\0${input.sha256}\0${input.capturedAt}`).slice(0, 32)}`,
    kind: 'attachment',
    logicalFilename: input.logicalFilename,
    sourceArchivePath: input.sourceArchivePath,
    sourceObjectId: input.sourceObjectId,
    capturedAt: input.capturedAt,
    localPath: input.localPath,
    expectedSha256: unprefixedSha256(input.sha256),
    expectedSizeBytes: input.sizeBytes,
  };
}

function sourceRecordRawPart(input: {
  artifactSha256: string;
  sourceObjectId: string;
  sourceArchivePath: string;
  capturedAt: string;
  localPath: string;
  sha256: string;
  sizeBytes: number;
}): LocalBenchlingExportRawPart {
  return {
    id: `local-source-record-${stableDigest(`${input.artifactSha256}\0${input.sourceArchivePath}\0${input.sha256}\0${input.capturedAt}`).slice(0, 32)}`,
    kind: 'source_record',
    logicalFilename: path.posix.basename(input.sourceArchivePath),
    sourceArchivePath: input.sourceArchivePath,
    sourceObjectId: input.sourceObjectId,
    capturedAt: input.capturedAt,
    localPath: input.localPath,
    expectedSha256: unprefixedSha256(input.sha256),
    expectedSizeBytes: input.sizeBytes,
  };
}

function localAuthority(
  logicalFilename: string,
  sha256: `sha256:${string}`
): LocalNativeExportBundleAuthority {
  return {
    schema: 'dnaforge.benchling.local-native-export-authority.v1',
    logicalFilename,
    sha256,
  };
}

function localHtmlStableId(logicalFilename: string, _html: string, sha256: string): string {
  const filenameIds = uniqueBenchlingEntryIds(logicalFilename);
  if (filenameIds.length === 1) return filenameIds[0];
  return `artifact_${stableDigest(`${logicalFilename}\0${sha256}`).slice(0, 24)}`;
}

function uniqueBenchlingEntryIds(value: string): string[] {
  return [...new Set(value.match(BENCHLING_ENTRY_ID) ?? [])].sort();
}

function htmlTitle(html: string): string | null {
  const match = /<(?:h1|title)\b[^>]*>([\s\S]{1,4096}?)<\/(?:h1|title)\s*>/iu.exec(html);
  if (!match) return null;
  const text = match[1]
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
  return text || null;
}

function unresolvedImageWarnings(sourceObject: SourceObject): string[] {
  const content = sourceObject.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const html = (content as { html?: unknown }).html;
  const attachments = (content as { attachments?: unknown }).attachments;
  if (typeof html !== 'string' || !Array.isArray(attachments)) return [];
  const capturedNameCounts = new Map<string, number>();
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) continue;
    const value = (attachment as { fileName?: unknown }).fileName;
    if (typeof value !== 'string') continue;
    const normalizedName = normalizeImageName(value, sourceObject.name, sourceObject.stableId);
    capturedNameCounts.set(normalizedName, (capturedNameCounts.get(normalizedName) ?? 0) + 1);
  }
  const previewNames = linkedPreviewNames(html);
  const warnings: string[] = [];
  let unresolvedPreviewCount = 0;
  for (const name of previewNames) {
    const normalizedName = normalizeImageName(name, sourceObject.name, sourceObject.stableId);
    const remainingCapturedFiles = capturedNameCounts.get(normalizedName) ?? 0;
    if (remainingCapturedFiles === 0) {
      unresolvedPreviewCount += 1;
      warnings.push(
        `Notebook image "${safeWarningName(name)}" has no captured full-resolution file.`
      );
    } else {
      capturedNameCounts.set(normalizedName, remainingCapturedFiles - 1);
    }
  }
  const inlineDataImageCount = inlineDataImageSourceCount(
    html,
    unresolvedPreviewCount > 0 ? 1 : previewNames.length + 1
  );
  if (
    inlineDataImageCount &&
    (inlineDataImageCount > previewNames.length || unresolvedPreviewCount > 0)
  ) {
    warnings.push('Inline data-URI thumbnails were not imported as notebook attachments.');
  }
  return warnings;
}

function inlineDataImageSourceCount(html: string, stopAfter: number): number {
  if (stopAfter <= 0) return 0;
  const lowerHtml = html.toLowerCase();
  const marker = 'data:image/';
  let count = 0;
  let cursor = 0;
  while (cursor < lowerHtml.length && count < stopAfter) {
    const markerIndex = lowerHtml.indexOf(marker, cursor);
    if (markerIndex < 0) break;
    const tagStart = lowerHtml.lastIndexOf('<', markerIndex);
    const priorTagEnd = lowerHtml.lastIndexOf('>', markerIndex);
    if (tagStart > priorTagEnd) {
      const attributePrefix = lowerHtml.slice(Math.max(tagStart, markerIndex - 96), markerIndex);
      if (/\bsrc\s*=\s*["']?$/u.test(attributePrefix)) count += 1;
    }
    cursor = markerIndex + marker.length;
  }
  return count;
}

function hierarchyExclusionWarnings(
  hierarchy: LocalBenchlingExportHierarchyEvidence | null
): string[] {
  if (!hierarchy || hierarchy.scopeKind !== 'folder' || hierarchy.excludedSourceObjectCount === 0) {
    return [];
  }
  const names = hierarchy.excludedChildFolders
    .map((folder) => `"${safeWarningName(folder.name)}"`)
    .join(', ');
  return [
    `Direct Folder excluded ${hierarchy.excludedSourceObjectCount} descendant object${hierarchy.excludedSourceObjectCount === 1 ? '' : 's'} under ${hierarchy.excludedChildFolderCount} child folder${hierarchy.excludedChildFolderCount === 1 ? '' : 's'}${names ? `: ${names}` : ''}.`,
  ];
}

function discoverCanonicalFolderObjects(
  entryPaths: readonly string[],
  verifiedStrainKeys: ReadonlySet<string>
): LocalBenchlingExportCanonicalItem[] {
  const result = new Map<string, LocalBenchlingExportCanonicalItem>();
  for (const canonicalPath of [...entryPaths].sort(compareText)) {
    const filename = path.posix.basename(canonicalPath);
    const notebookMatch = /\((etr_[A-Za-z0-9]+)\)\.html?$/iu.exec(filename);
    const sequenceMatch = /\((seq_[A-Za-z0-9]+)\)\.(?:gb|gbk|genbank)$/iu.exec(filename);
    const proteinMatch = /\((prtn_[A-Za-z0-9]+)\)\.fasta$/iu.exec(filename);
    const protocolMatch = /\((prt_[A-Za-z0-9]+)\)\.html?$/iu.exec(filename);
    const registryMatch = /\((bfi_[A-Za-z0-9]+)\)\.(?:html?|txt)$/iu.exec(filename);
    const match = notebookMatch ?? sequenceMatch ?? proteinMatch ?? protocolMatch ?? registryMatch;
    if (!match) continue;
    const sourceObjectId = match[1];
    const identities = [...new Set(filename.match(FOLDER_CANONICAL_OBJECT_ID) ?? [])];
    if (identities.length !== 1 || identities[0] !== sourceObjectId) {
      throw new LocalBenchlingExportHierarchyError(
        'A canonical Benchling Folder filename contains ambiguous object identities.'
      );
    }
    const sourceKind: LocalBenchlingExportCanonicalItem['sourceKind'] = notebookMatch
      ? 'notebook_entry'
      : sequenceMatch
        ? 'sequence'
        : proteinMatch
          ? 'protein'
          : protocolMatch
            ? 'protocol'
            : 'notebook_entry';
    const membershipKey = `${sourceObjectId}\0${path.posix.dirname(canonicalPath)}`;
    if (verifiedStrainKeys.has(membershipKey) && /\.html?$/iu.test(canonicalPath)) continue;
    const existing = result.get(membershipKey);
    if (
      existing &&
      sourceObjectId.startsWith('bfi_') &&
      /\.html?$/iu.test(existing.canonicalPath)
    ) {
      continue;
    }
    result.set(membershipKey, {
      canonicalPath,
      sourceObjectId,
      sourceKind,
    });
  }
  return [...result.values()].sort((left, right) =>
    compareText(left.canonicalPath, right.canonicalPath)
  );
}

function sourceTypeMatchesCanonicalKind(
  sourceType: string,
  sourceKind: LocalBenchlingExportCanonicalItem['sourceKind']
): boolean {
  if (sourceKind === 'notebook_entry') {
    return sourceType === 'notebook_entry' || sourceType === 'strain';
  }
  if (sourceKind === 'protein') return sourceType === 'protein';
  if (sourceKind === 'protocol') return sourceType === 'protocol';
  return sourceType === 'dna_sequence' || sourceType === 'rna_sequence';
}

function compareCapturedSourceObjects(left: SourceObject, right: SourceObject): number {
  return (
    compareText(left.sourcePath ?? '', right.sourcePath ?? '') || compareText(left.id, right.id)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function linkedPreviewNames(html: string): string[] {
  const result: string[] = [];
  const openingDiv = /<div\b([^>]*)>/giu;
  for (const match of html.matchAll(openingDiv)) {
    const attributes = match[1] ?? '';
    if (
      htmlAttribute(attributes, 'data-test-component').toLowerCase() !== 'notedroptarget' ||
      htmlAttribute(attributes, 'data-test-element').toLowerCase() !== 'notelinkedfilepreview' ||
      hasAttributeToken(attributes, 'class', 'note-entry')
    ) {
      continue;
    }

    const start = (match.index ?? 0) + match[0].length;
    const end = matchingDivEnd(html, start);
    if (end === null) continue;
    const previewHtml = html.slice(start, end);
    if (!containsLinkedImagePreview(previewHtml)) continue;
    result.push(...rawLinkedPreviewNames(previewHtml));
  }
  return result;
}

function rawLinkedPreviewNames(html: string): string[] {
  const result: string[] = [];
  const pattern =
    /<[^>]*\b(?:data-test-element\s*=\s*["']previewItemName["']|class\s*=\s*["'][^"']*\bnote-itemName\b[^"']*["'])[^>]*>([\s\S]{0,4096}?)<\/[^>]+>/giu;
  for (const match of html.matchAll(pattern)) {
    const text = match[1]
      .replace(/<[^>]*>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (text && (IMAGE_EXTENSION.test(text) || path.extname(text) === '')) result.push(text);
  }
  return result;
}

function containsLinkedImagePreview(html: string): boolean {
  const image = /<img\b([^>]*)>/giu;
  for (const match of html.matchAll(image)) {
    const attributes = match[1] ?? '';
    if (
      hasAttributeToken(attributes, 'class', 'noteLinkedFilePreviewImg') ||
      htmlAttribute(attributes, 'data-test-component').toLowerCase() === 'notelinkedfilepreview' ||
      htmlAttribute(attributes, 'src').toLowerCase().startsWith('data:image/')
    ) {
      return true;
    }
  }
  return false;
}

function matchingDivEnd(html: string, start: number): number | null {
  const divTag = /<\/?div\b[^>]*>/giu;
  divTag.lastIndex = start;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = divTag.exec(html))) {
    if (/^<\/div\b/iu.test(match[0])) depth -= 1;
    else if (!/\/\s*>$/u.test(match[0])) depth += 1;
    if (depth === 0) return match.index;
  }
  return null;
}

function htmlAttribute(attributes: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*(["'])(.*?)\\1`, 'iu').exec(attributes);
  return match?.[2]?.trim() ?? '';
}

function hasAttributeToken(attributes: string, name: string, token: string): boolean {
  const normalized = token.toLowerCase();
  return htmlAttribute(attributes, name)
    .split(/\s+/u)
    .some((candidate) => candidate.toLowerCase() === normalized);
}

function normalizeImageName(value: string, sourceName: string, stableSourceId: string): string {
  const candidate = value.normalize('NFC').trim();
  const stableMarker = `(${stableSourceId})`;
  const stableMarkerIndex = candidate.toLowerCase().lastIndexOf(stableMarker.toLowerCase());
  const marker = sourceName.trim().toLowerCase();
  let normalized =
    stableMarkerIndex >= 0
      ? candidate
          .slice(stableMarkerIndex + stableMarker.length)
          .trim()
          .toLowerCase()
      : candidate.toLowerCase();
  if (stableMarkerIndex < 0 && marker && normalized.startsWith(`${marker} `)) {
    normalized = normalized.slice(marker.length + 1);
  }
  return normalized
    .replace(IMAGE_EXTENSION, '')
    .replace(/[\\/]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/\s+\d+$/u, '')
    .trim();
}

function safeWarningName(value: string): string {
  const printable = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('');
  return printable.slice(0, 256) || 'image';
}

function hasAttachmentPathSegment(sourcePath: string): boolean {
  return sourcePath
    .split('/')
    .slice(0, -1)
    .some((segment) => {
      const normalized = segment.toLowerCase();
      return (
        normalized === 'attachments' ||
        normalized === 'assets' ||
        normalized === 'files' ||
        normalized.endsWith('_files')
      );
    });
}

function captureTimestamp(value: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_capture_time_invalid',
      'Local export capture time must be an ISO timestamp.'
    );
  }
  return new Date(value).toISOString();
}

function unprefixedSha256(value: string): string {
  const normalized = value.toLowerCase().replace(/^sha256:/u, '');
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_artifact_mismatch',
      'Local export evidence requires a valid SHA-256 digest.'
    );
  }
  return normalized;
}

function requireExternalEntry(
  entry: ExternalZipEntryEvidence | undefined
): ExternalZipEntryEvidence {
  if (!entry) {
    throw new LocalBenchlingExportDecodeError(
      'local_export_artifact_mismatch',
      'Exact external ZIP entry evidence is missing.'
    );
  }
  return entry;
}

function localCaptureIdentity(
  sha256: string,
  logicalFilename: string,
  format: 'zip' | 'html',
  capturedAt: string
): string {
  return stableDigest(`${format}\0${sha256}\0${logicalFilename}\0${capturedAt}`).slice(0, 32);
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const LOCAL_BENCHLING_EXPORT_DECODER_VERSIONS = Object.freeze({
  zip: BENCHLING_NATIVE_EXPORT_DECODER_VERSION,
  html: LOCAL_HTML_DECODER_VERSION,
});
