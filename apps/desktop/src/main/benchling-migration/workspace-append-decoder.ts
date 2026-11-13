import path from 'node:path';

import type { ExternalZipEntryEvidence, SourceObject } from '../../shared/benchling-migration';
import {
  canonicalExportSuffixIdentity,
  filenameNamesExactlyOneCanonicalId,
} from './benchling-canonical-filename';
import type { ContentArchive } from './content-archive';
import type { VerifiedLocalBenchlingZipExport } from './local-export-bundle';
import {
  inspectNativeExportArchive,
  persistNativeExportArchiveEntries,
} from './native-export-archive';
import {
  verifiedStrainCompanionKeys,
  type DecodedLocalNativeExportEvidence,
  type DecodeLocalBenchlingNativeExportInput,
} from './native-export-decoder';
import { decodeLocalNativeExportInDedicatedWorker } from './native-export-decoder-worker-client';
import {
  scientificSourceObjectSha256,
  type LinkedItemRecoveryDecodedObject,
} from './linked-item-recovery-decoder';
import { migrationEvidenceId } from './evidence-id';
import {
  LocalBenchlingExportHierarchyError,
  planLocalBenchlingExportHierarchy,
  type LocalBenchlingExportCanonicalItem,
  type LocalBenchlingExportHierarchyPlan,
} from './local-export-hierarchy';
import type { WorkspaceAppendHierarchyCapture } from './store';
import { nativeRecordSourcePersistenceRequests } from './native-sequence-source-evidence';
import { attachStrainRelationships } from './strain-relationship-resolver';
import { captureNativeSourceFolderMemberships } from './native-source-memberships';
import { readLocalRegistryTableRows } from './registry-table-input';
import { readReviewedRegistryTableRows } from './registry-table-review';
import type { RegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';

export type WorkspaceAppendDecodeResult = Readonly<{
  snapshotId: string;
  archivePartId: string;
  artifact: VerifiedLocalBenchlingZipExport;
  matched: readonly LinkedItemRecoveryDecodedObject[];
  hierarchyCapture: WorkspaceAppendHierarchyCapture | null;
  ignoredCanonicalObjectCount: number;
}>;

type CanonicalAppendEntry = Readonly<{
  path: string;
  sourceId: string;
  sourceKind: LocalBenchlingExportCanonicalItem['sourceKind'];
  source:
    | Readonly<{ kind: 'canonical-file' }>
    | Readonly<{ kind: 'registry-row'; object: SourceObject }>;
}>;

export class WorkspaceAppendDecodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly sourceId?: string
  ) {
    super(message);
    this.name = 'WorkspaceAppendDecodeError';
  }
}

function assertUnambiguousIdentity(entryPath: string, sourceId: string): void {
  if (!filenameNamesExactlyOneCanonicalId(entryPath, sourceId)) {
    throw new WorkspaceAppendDecodeError(
      'workspace_append_filename_identity_ambiguous',
      `An appended export filename names more than one canonical object: ${path.posix.basename(entryPath)}`,
      sourceId
    );
  }
}

function plainSha256(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

export async function decodeWorkspaceAppendExport(input: {
  artifact: VerifiedLocalBenchlingZipExport;
  archive: ContentArchive;
  externalZipEntries?: readonly ExternalZipEntryEvidence[];
  capturedAt: string;
  runId: string;
  attemptId: string;
  artifactId: string;
  reviewedTables?: readonly RegistryTableMappingDecision[];
  excludedEntryPaths?: readonly string[];
  fallbackEntryPaths?: readonly string[];
  destinationFolderId: string | null;
  decodeNativeExport?: (
    input: DecodeLocalBenchlingNativeExportInput,
    onProgress?: (progress: Readonly<{ completed: number; total: number }>) => void
  ) => Promise<DecodedLocalNativeExportEvidence>;
  onProgress?: (progress: Readonly<{ completed: number; total: number }>) => void;
}): Promise<WorkspaceAppendDecodeResult> {
  const decodeNativeExport =
    input.decodeNativeExport ??
    ((decoderInput, onProgress) =>
      decodeLocalNativeExportInDedicatedWorker(decoderInput, undefined, onProgress));
  const inspected = await inspectNativeExportArchive(input.artifact.nativeExportDecoderSource);
  const excludedEntryPaths = new Set(input.excludedEntryPaths ?? []);
  const snapshotId = `workspace-append:${plainSha256(input.artifact.sha256)}`;
  const archivePartId = `supplemental-local-export:${plainSha256(input.artifact.sha256)}`;
  const canonicalCandidates: CanonicalAppendEntry[] = inspected.entries
    .filter((entry) => !entry.isDirectory)
    .flatMap((entry) => {
      const identity = canonicalExportSuffixIdentity(entry.path);
      return identity
        ? [
            {
              path: entry.path,
              sourceId: identity.sourceId,
              sourceKind: hierarchySourceKind(identity.sourceId),
              source: { kind: 'canonical-file' as const },
            },
          ]
        : [];
    })
    .sort((left, right) => compareText(left.path, right.path));
  const registryRows = [
    ...(await readLocalRegistryTableRows(inspected)),
    ...(await readReviewedRegistryTableRows({
      archive: inspected,
      decisions: input.reviewedTables ?? [],
      actionId: input.attemptId,
    })),
  ];
  const canonical: CanonicalAppendEntry[] = [
    ...preferStructuredBenchlingFileRepresentations(
      canonicalCandidates,
      await verifiedStrainCompanionKeys(inspected)
    ),
    ...registryRows.map(
      (row): CanonicalAppendEntry => ({
        path: row.entryPath,
        sourceId: row.sourceObject.stableId,
        sourceKind: 'registry_record',
        source: { kind: 'registry-row', object: row.sourceObject },
      })
    ),
  ].filter((entry) => !excludedEntryPaths.has(entry.path));
  if (excludedEntryPaths.size > 0) {
    const sourcePaths = new Set(
      inspected.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path)
    );
    if (
      canonical.length === 0 ||
      [...excludedEntryPaths].some((entryPath) => !sourcePaths.has(entryPath))
    ) {
      throw new WorkspaceAppendDecodeError(
        'workspace_append_invalid_exclusion',
        'The retry cannot omit these files from the verified ZIP.'
      );
    }
  }
  input.onProgress?.({ completed: 0, total: canonical.length });

  for (const entry of canonical) {
    if (entry.source.kind === 'canonical-file')
      assertUnambiguousIdentity(entry.path, entry.sourceId);
  }

  if (canonical.length === 0) {
    return {
      snapshotId,
      archivePartId,
      artifact: input.artifact,
      matched: [],
      hierarchyCapture: null,
      ignoredCanonicalObjectCount: 0,
    };
  }

  let hierarchyPlan;
  try {
    const hasFlatCanonicalPath = canonical.some((entry) => !entry.path.includes('/'));
    const topLevelFolderNames = new Set(
      canonical
        .filter((entry) => entry.path.includes('/'))
        .map((entry) => entry.path.slice(0, entry.path.indexOf('/')))
    );
    const needsSyntheticArchiveRoot = hasFlatCanonicalPath || topLevelFolderNames.size !== 1;
    const archiveBoundaryRootName = path.posix
      .basename(input.artifact.logicalFilename, '.zip')
      .normalize('NFC');
    hierarchyPlan = planLocalBenchlingExportHierarchy({
      scope: {
        version: 1,
        kind: 'folder_tree',
        acquisition: 'local_bundle',
        roots: [
          {
            id: input.destinationFolderId ?? 'workspace_append_file_scope',
            url: `urn:dnaforge:benchling-workspace-append:${encodeURIComponent(
              input.destinationFolderId ?? input.runId
            )}`,
            objectType: 'folder',
          },
        ],
        includeChildren: true,
        includeArchived: false,
      },
      canonicalItems: canonical.map(
        (entry) =>
          ({
            canonicalPath: needsSyntheticArchiveRoot
              ? `${archiveBoundaryRootName}/${entry.path}`
              : entry.path,
            sourceObjectId: entry.sourceId,
            sourceKind: entry.sourceKind,
          }) satisfies LocalBenchlingExportCanonicalItem
      ),
    });
  } catch (error) {
    if (!(error instanceof LocalBenchlingExportHierarchyError)) throw error;
    throw new WorkspaceAppendDecodeError(
      'workspace_append_folder_hierarchy_ambiguous',
      error.message
    );
  }
  const hierarchyCapture = input.destinationFolderId
    ? buildHierarchyCapture({
        plan: hierarchyPlan,
        runId: input.runId,
        attemptId: input.attemptId,
        artifactId: input.artifactId,
        artifactSha256: input.artifact.sha256,
        destinationRootSourceId: input.destinationFolderId,
        capturedAt: input.capturedAt,
      })
    : null;

  const decoded = await decodeNativeExport(
    {
      source: input.artifact.nativeExportDecoderSource,
      inspectedArchive: inspected,
      controlMetadata: { source: 'none' },
      context: {
        snapshotId,
        capturedAt: input.capturedAt,
        archivePartId,
        sourceUrlPrefix: null,
        localBundleAuthority: {
          schema: 'dnaforge.benchling.local-native-export-authority.v1',
          logicalFilename: input.artifact.logicalFilename,
          sha256: input.artifact.sha256,
        },
        selectedEntryPaths: [...new Set(canonical.map((entry) => entry.path))],
        ...(input.fallbackEntryPaths ? { fallbackEntryPaths: input.fallbackEntryPaths } : {}),
      },
    },
    input.onProgress
  );
  input.onProgress?.({ completed: canonical.length, total: canonical.length });

  const selectedByPath = new Map(
    canonical
      .filter((entry) => entry.source.kind === 'canonical-file')
      .map((entry) => [entry.path, entry])
  );
  const entryEvidenceByPath = new Map(decoded.entries.map((entry) => [entry.path, entry]));
  const decodedById = new Map<string, SourceObject[]>();
  for (const row of registryRows) {
    const list = decodedById.get(row.sourceObject.stableId) ?? [];
    list.push(row.sourceObject);
    decodedById.set(row.sourceObject.stableId, list);
  }
  for (const sourceObject of decoded.sourceObjects) {
    const selectedEntry = sourceObject.sourcePath
      ? selectedByPath.get(sourceObject.sourcePath)
      : undefined;
    if (!selectedEntry) continue;
    if (
      sourceObject.id !== selectedEntry.sourceId ||
      sourceObject.stableId !== selectedEntry.sourceId
    ) {
      throw new WorkspaceAppendDecodeError(
        'workspace_append_identity_mismatch',
        `An appended object does not match the stable ID in its filename: ${selectedEntry.sourceId}`,
        selectedEntry.sourceId
      );
    }
    const list = decodedById.get(sourceObject.stableId) ?? [];
    list.push(sourceObject);
    decodedById.set(sourceObject.stableId, list);
  }

  const persistedAttachments = input.externalZipEntries
    ? []
    : await persistNativeExportArchiveEntries(
        inspected,
        [
          ...decoded.attachments.map((attachment) => ({
            entryPath: attachment.entryPath,
            expectedSha256: attachment.sha256,
          })),
          ...nativeRecordSourcePersistenceRequests(decoded.sourceObjects),
        ],
        input.archive,
        { maxConcurrentWrites: 32 }
      );
  const persistedByPath = new Map(
    persistedAttachments.map((entry) => [entry.evidence.path, entry.blob] as const)
  );

  const matched: LinkedItemRecoveryDecodedObject[] = [];
  const sourceIds = [...new Set(canonical.map((entry) => entry.sourceId))].sort();
  for (const sourceId of sourceIds) {
    const sourceEntries = canonical.filter((entry) => entry.sourceId === sourceId);
    const candidates = decodedById.get(sourceId) ?? [];
    if (candidates.length === 0) {
      throw new WorkspaceAppendDecodeError(
        'workspace_append_object_missing',
        `The canonical file for ${sourceId} did not decode to that object.`,
        sourceId
      );
    }
    const memberships = input.destinationFolderId
      ? [
          ...new Set(
            hierarchyCapture?.memberships
              .filter((membership) => membership.sourceObjectId === sourceId)
              .map((membership) => membership.folderSourceId) ?? []
          ),
        ].sort()
      : [];
    const nativeMemberships =
      input.externalZipEntries && !input.destinationFolderId
        ? captureNativeSourceFolderMemberships(
            input.runId,
            sourceEntries.map((entry) => entry.path)
          )
        : undefined;
    const normalized = candidates.map((candidate) =>
      normalizeAppendedSourceObject(
        candidate,
        input.artifact,
        nativeMemberships?.map((membership) => membership.sourceFolderId) ?? memberships,
        nativeMemberships
      )
    );
    const fingerprints = new Set(normalized.map(scientificSourceObjectSha256));
    if (fingerprints.size !== 1) {
      throw new WorkspaceAppendDecodeError(
        'workspace_append_conflicting_representations',
        `The appended export contains conflicting representations for ${sourceId}.`,
        sourceId
      );
    }
    const [sourceObject] = normalized;
    const canonicalEntry = sourceEntries[0];
    const canonicalEvidence = canonicalEntry
      ? entryEvidenceByPath.get(canonicalEntry.path)
      : undefined;
    if (!sourceObject || !canonicalEvidence) {
      throw new WorkspaceAppendDecodeError(
        'workspace_append_entry_evidence_missing',
        `The appended export has no verified entry evidence for ${sourceId}.`,
        sourceId
      );
    }
    matched.push({
      sourceObject,
      sourceContentSha256: scientificSourceObjectSha256(sourceObject),
      canonicalEntryPath: canonicalEntry.path,
      canonicalEntrySha256: canonicalEvidence.sha256,
      attachments: decoded.attachments
        .filter((attachment) => attachment.sourceObjectId === sourceId)
        .map((evidence) => {
          if (input.externalZipEntries) {
            const entry = input.externalZipEntries.find(
              (candidate) =>
                candidate.entryPath === evidence.entryPath &&
                candidate.entrySha256 === `sha256:${plainSha256(evidence.sha256)}` &&
                candidate.sizeBytes === evidence.sizeBytes
            );
            if (!entry) {
              throw new WorkspaceAppendDecodeError(
                'workspace_append_attachment_missing',
                `A verified attachment for ${sourceId} has no exact external source evidence.`,
                sourceId
              );
            }
            return { kind: 'external' as const, evidence, entry };
          }
          const blob = persistedByPath.get(evidence.entryPath);
          if (!blob) {
            throw new WorkspaceAppendDecodeError(
              'workspace_append_attachment_missing',
              `A verified attachment for ${sourceId} was not persisted.`,
              sourceId
            );
          }
          return { kind: 'archived' as const, evidence, blob };
        }),
    });
  }

  const relatedSourceObjects = new Map(
    attachStrainRelationships(matched.map(({ sourceObject }) => sourceObject)).map(
      (sourceObject) => [sourceObject.id, sourceObject]
    )
  );
  return {
    snapshotId,
    archivePartId,
    artifact: input.artifact,
    matched: matched.map((entry) => ({
      ...entry,
      sourceObject: relatedSourceObjects.get(entry.sourceObject.id) ?? entry.sourceObject,
    })),
    hierarchyCapture,
    ignoredCanonicalObjectCount: canonical.length - sourceIds.length,
  };
}

function normalizeAppendedSourceObject(
  sourceObject: SourceObject,
  artifact: VerifiedLocalBenchlingZipExport,
  memberships: readonly string[],
  sourceFolderMemberships?: ReturnType<typeof captureNativeSourceFolderMemberships>
): SourceObject {
  return {
    ...sourceObject,
    memberships: [...memberships],
    metadata: {
      ...sourceObject.metadata,
      workspaceAppend: {
        schema: 'dnaforge.benchling.workspace-append-source.v1',
        appendedExportSha256: artifact.sha256,
        ...(sourceFolderMemberships ? { sourceFolderMemberships } : {}),
      },
    },
  };
}

function buildHierarchyCapture(input: {
  plan: LocalBenchlingExportHierarchyPlan;
  runId: string;
  attemptId: string;
  artifactId: string;
  artifactSha256: `sha256:${string}`;
  destinationRootSourceId: string;
  capturedAt: string;
}): WorkspaceAppendHierarchyCapture {
  const rootPrefix = `${input.plan.evidence.rootFolderName}/`;
  const folders = input.plan.evidence.folders
    .filter((folder) => folder.depth > 0)
    .map((folder) => ({
      sourceId: folder.id,
      name: folder.name,
      parentSourceId: folder.parentId ?? input.destinationRootSourceId,
      archiveRelativePath: folder.relativePath.slice(rootPrefix.length),
    }))
    .sort((left, right) => compareText(left.archiveRelativePath, right.archiveRelativePath));
  const memberships = [
    ...new Map(
      input.plan.items.map((item) => [
        `${item.sourceObjectId}\0${item.membershipFolderId}`,
        { sourceObjectId: item.sourceObjectId, folderSourceId: item.membershipFolderId },
      ])
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.sourceObjectId, right.sourceObjectId) ||
      compareText(left.folderSourceId, right.folderSourceId)
  );
  return Object.freeze({
    schema: 'dnaforge.benchling.workspace-append-hierarchy-capture.v1',
    id: migrationEvidenceId('workspace-append-hierarchy', `${input.runId}\0${input.artifactId}`),
    runId: input.runId,
    attemptId: input.attemptId,
    artifactId: input.artifactId,
    artifactSha256: input.artifactSha256,
    destinationRootSourceId: input.destinationRootSourceId,
    zipRootName: input.plan.evidence.rootFolderName,
    folders: Object.freeze(folders),
    memberships: Object.freeze(memberships),
    capturedAt: input.capturedAt,
  });
}

function hierarchySourceKind(sourceId: string): LocalBenchlingExportCanonicalItem['sourceKind'] {
  if (sourceId.startsWith('etr_') || sourceId.startsWith('bfi_')) return 'notebook_entry';
  if (sourceId.startsWith('seq_')) return 'sequence';
  if (sourceId.startsWith('prtn_')) return 'protein';
  if (sourceId.startsWith('prt_')) return 'protocol';
  throw new WorkspaceAppendDecodeError(
    'workspace_append_identity_unsupported',
    `The appended export identity ${sourceId} is not supported.`,
    sourceId
  );
}

function preferStructuredBenchlingFileRepresentations(
  entries: readonly CanonicalAppendEntry[],
  verifiedStrainKeys: ReadonlySet<string>
): CanonicalAppendEntry[] {
  const htmlKeys = new Set(
    entries
      .filter(
        (entry) =>
          entry.sourceId.startsWith('bfi_') &&
          ['.html', '.htm'].includes(path.posix.extname(entry.path).toLowerCase())
      )
      .map((entry) => `${entry.sourceId}\0${path.posix.dirname(entry.path)}`)
  );
  return entries.filter((entry) => {
    if (!entry.sourceId.startsWith('bfi_')) return true;
    const key = `${entry.sourceId}\0${path.posix.dirname(entry.path)}`;
    const extension = path.posix.extname(entry.path).toLowerCase();
    return verifiedStrainKeys.has(key)
      ? !['.html', '.htm'].includes(extension)
      : extension !== '.txt' || !htmlKeys.has(key);
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
