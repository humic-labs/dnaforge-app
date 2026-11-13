import { userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  importContentIntoWorkspaceRoot,
  importFileIntoWorkspaceRoot,
  type ImportFileIntoWorkspaceDeps,
} from './workspace-git/import';
import { applyLimsImportBatchInDb, buildImportSourceMetadata } from './lims-import';
import {
  buildFileSequenceRef,
  parseSequenceContent,
  sourceFormatForPath,
} from './lims-sequence-io';
import type {
  RegisterableSequenceKind,
  RegisterImportedSequenceFromContentRequest,
  RegisterImportedSequenceRequest,
  RegisterImportedSequenceResult,
} from '../shared/workspace-git-types';
import { deriveImportedSequenceName } from '../shared/lims';
import type { LimsApplyImportBatchInput, LimsImportRecord } from '../shared/lims';
import {
  parseSequencePackageDocument,
  sequencePackageMetaPaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
} from '../db/sequence-package';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../shared/managed-sequence-document';
import { existingPlasmidPackageRootForProduct } from './workspace-git/sequence-package-import';
import { commitPathsIfDirty, resolveHeadCommit, restoreManagedHeadAndIndex } from './workspace-git';
import { findKnownWorkspaceRoot } from './workspace-git/known-workspace-scope';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';
import { isBinarySequenceFilePath } from '@waypoint/sequence-utils/sequence-file-types';

export type {
  RegisterableSequenceKind,
  RegisterImportedSequenceFromContentRequest,
  RegisterImportedSequenceRequest,
  RegisterImportedSequenceResult,
} from '../shared/workspace-git-types';

export const REGISTERABLE_SEQUENCE_KINDS = [
  'sequence',
] as const satisfies readonly RegisterableSequenceKind[];

const DEFAULT_SEQUENCE_KIND: RegisterableSequenceKind = 'sequence';

interface ImportedSequenceSourceIdentity {
  fileContentHash: string;

  recordCount: number;
}

type RegisterImportedSequenceDeps = ImportFileIntoWorkspaceDeps & {
  commitPathsIfDirty?: typeof commitPathsIfDirty;
};

function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sourceIdentityForUtf8Bytes(bytes: Buffer): { rawSha256: string; textSha256: string } {
  const text = bytes.toString('utf8').replace(/^\uFEFF/u, '');
  return {
    rawSha256: createHash('sha256').update(bytes).digest('hex'),

    textSha256: sha256Text(text),
  };
}

function validatePreviewedSourceHash(
  actual: string,
  expected: string | undefined,
  normalizedText?: string
): void {
  if (
    expected !== undefined &&
    actual !== expected.toLowerCase() &&
    normalizedText !== expected.toLowerCase()
  ) {
    throw new Error(
      'The selected sequence changed after preview. Re-open the import and try again.'
    );
  }
}

export function coerceRegisterableSequenceKind(kind: unknown): RegisterableSequenceKind {
  return REGISTERABLE_SEQUENCE_KINDS.includes(kind as RegisterableSequenceKind)
    ? (kind as RegisterableSequenceKind)
    : DEFAULT_SEQUENCE_KIND;
}

export function countSequenceRecords(content: string): number {
  const locusMatches = content.match(/^LOCUS\s/gm);
  if (locusMatches) return locusMatches.length;
  const fastaMatches = content.match(/^>/gm);
  if (fastaMatches) return fastaMatches.length;
  return content.trim() ? 1 : 0;
}

function sequenceEntityName(parsedName: string | undefined, sourceOrFileName: string): string {
  return deriveImportedSequenceName(parsedName, basename(sourceOrFileName));
}

function sourceKindForPath(filePath: string): 'genbank' | 'fasta' {
  const format = sourceFormatForPath(filePath);
  return format === 'gb' || format === 'genbank' ? 'genbank' : 'fasta';
}

export async function registerImportedSequenceFile(
  request: RegisterImportedSequenceRequest,
  deps: RegisterImportedSequenceDeps
): Promise<RegisterImportedSequenceResult> {
  const sourceIdentity = sourceIdentityForUtf8Bytes(readFileSync(request.sourcePath));

  validatePreviewedSourceHash(
    sourceIdentity.rawSha256,
    request.expectedSourceSha256,
    isBinarySequenceFilePath(request.sourcePath) ? undefined : sourceIdentity.textSha256
  );
  validatePreviewedSourceHash(sourceIdentity.rawSha256, request.confirmedDnaSourceSha256);

  const copy = await importFileIntoWorkspaceRoot(
    {
      targetRoot: request.targetRoot,
      sourcePath: request.sourcePath,
      dedup: request.dedup,

      expectedSourceSha256: sourceIdentity.rawSha256,
      confirmedDnaSourceSha256: request.confirmedDnaSourceSha256,
      confirmedNucleicAcid: request.confirmedNucleicAcid,
    },
    deps
  );

  const base = baseResult(copy);

  const productPaths = await managedPackageProductsForCopy(copy);
  if (productPaths.length) {
    return registerPackagedImport({
      productPaths,
      copy,
      deps,
      displayName: basename(request.sourcePath),
      kind: request.kind,
      actor: request.actor,
      batchId: request.batchId,
      sourceIdentity: {
        fileContentHash: `sha256:${sourceIdentity.rawSha256}`,
        recordCount: productPaths.length,
      },
    });
  }

  return packageRequiredResult(base);
}

async function registerPackagedImport(input: {
  productPaths: readonly string[];
  copy: Awaited<ReturnType<typeof importFileIntoWorkspaceRoot>>;
  deps: RegisterImportedSequenceDeps;
  displayName: string;
  kind?: RegisterImportedSequenceRequest['kind'];
  actor?: RegisterImportedSequenceRequest['actor'];
  batchId?: string | null;
  sourceIdentity: ImportedSequenceSourceIdentity;
}): Promise<RegisterImportedSequenceResult> {
  const base = baseResult(input.copy);
  const failures: string[] = [];
  const records: LimsImportRecord[] = [];
  const packages: Array<{
    metaPath: string;
    document: SequencePackageDocument;
    originalContent: string;
  }> = [];

  for (const [index, productPath] of input.productPaths.entries()) {
    let recordContent: string;
    let packageDocument: SequencePackageDocument;
    let packageRoot: string;
    let metaPath: string;
    let originalContent: string;
    let workspaceId: number;
    try {
      recordContent = readFileSync(productPath, 'utf8');
      packageRoot =
        (await existingPlasmidPackageRootForProduct(productPath)) ??
        (() => {
          throw new Error('Product is not owned by a managed sequence package.');
        })();
      const locatedMetaPath = sequencePackageMetaPaths(packageRoot).find((path) =>
        existsSync(path)
      );
      if (!locatedMetaPath) throw new Error('Managed sequence package metadata is missing.');
      metaPath = locatedMetaPath;
      originalContent = readFileSync(metaPath, 'utf8');
      packageDocument = parseSequencePackageDocument(originalContent);
      const ownerRoot = await findKnownWorkspaceRoot(productPath, input.deps);
      const owner = input.deps.db
        .prepare('SELECT id FROM workspaces WHERE path = ?')
        .get(ownerRoot) as { id: number } | undefined;
      if (!owner) throw new Error('The imported sequence requires its registered owning project.');
      workspaceId = owner.id;
    } catch (err) {
      failures.push(
        `${basename(productPath)}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const prepared = buildManagedSequenceRecord(
      {
        content: recordContent,
        destPath: productPath,
        displayName: basename(productPath),
        kind: input.kind,
        actor: input.actor,
        packageDocument,
        packageRoot,
        sourceIdentity: {
          ...input.sourceIdentity,
          recordIndex: index,
        },
      },
      `sequence-file-${index + 1}`
    );
    if ('reason' in prepared) {
      failures.push(`${basename(productPath)}: ${prepared.reason}`);
      continue;
    }
    prepared.record.entity.workspaceId = workspaceId;
    records.push(prepared.record);
    packages.push({ metaPath, document: packageDocument, originalContent });
  }

  if (failures.length > 0 || records.length !== input.productPaths.length) {
    return {
      ...base,
      registered: false,
      batchId: null,
      entityIds: [],
      userMessagePayload: userMessagePayload('registry.receipt.sequencesNotRegistered', {
        count: userMessageValue(input.productPaths.length),
        failed: userMessageValue(failures.length),
      }),
      reason:
        `Imported ${input.productPaths.length} sequences from "${input.displayName}"; ` +
        `${failures.length} could not be registered: ${failures.join('; ')}`,
    };
  }

  const applyInput: LimsApplyImportBatchInput = {
    batchId: input.batchId ?? undefined,

    sourceName: basename(input.productPaths[0]),
    sourceKind: 'genbank',
    records,
    actor: input.actor,
  };

  try {
    const packageUpdates: PackageMetadataUpdate[] = [];
    applyInput.records = records.map((record, index) => {
      const sourceMetadata = buildImportSourceMetadata(record, applyInput);
      const pkg = packages[index];
      const nextDocument: SequencePackageDocument = {
        ...pkg.document,
        entity: {
          ...pkg.document.entity,
          fields: {
            ...pkg.document.entity.fields,
            sourceMetadata,
          },
        },
        updatedAt: new Date().toISOString(),
      };
      packageUpdates.push({
        path: pkg.metaPath,
        originalContent: pkg.originalContent,
        nextContent: serializeSequencePackageDocument(nextDocument),
      });
      return {
        ...record,
        entity: {
          ...record.entity,
          fields: {
            ...record.entity.fields,
            sourceMetadata,
          },
        },
      };
    });
    const workspaceRoot = await findKnownWorkspaceRoot(packages[0].metaPath, input.deps);
    if (!workspaceRoot) {
      throw new Error('The managed workspace root could not be resolved for provenance write.');
    }
    await replacePackageMetadataBatch(workspaceRoot, packageUpdates);
    if (input.copy.committed) {
      const metaPaths = packages.map((pkg) => pkg.metaPath);
      const headBeforeProvenance = await resolveHeadCommit(workspaceRoot);
      if (!headBeforeProvenance) {
        throw new Error('The managed workspace has no commit to attach import provenance to.');
      }
      try {
        await (input.deps.commitPathsIfDirty ?? commitPathsIfDirty)(
          workspaceRoot,
          `Record import provenance for ${input.displayName}`,
          {
            paths: metaPaths,
            forceInclude: metaPaths,
          }
        );
      } catch (commitError) {
        const rollbackFailures: string[] = [];
        try {
          await replacePackageMetadataBatch(
            workspaceRoot,
            packageUpdates.map((update) => ({
              path: update.path,
              originalContent: update.nextContent,
              nextContent: update.originalContent,
            }))
          );
        } catch (rollbackError) {
          rollbackFailures.push(
            `file rollback failed: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`
          );
        }
        try {
          const currentHead = await resolveHeadCommit(workspaceRoot);
          if (!currentHead) throw new Error('managed HEAD disappeared during rollback');
          await restoreManagedHeadAndIndex(workspaceRoot, {
            restoreHead: headBeforeProvenance,
            expectedCurrentHead: currentHead,
            paths: metaPaths,
          });
        } catch (rollbackError) {
          rollbackFailures.push(
            `Git rollback failed: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`
          );
        }
        if (rollbackFailures.length > 0) {
          throw new Error(
            `${commitError instanceof Error ? commitError.message : String(commitError)}; ${rollbackFailures.join('; ')}`
          );
        }
        throw commitError;
      }
    }
  } catch (error) {
    return registrationFailureResult(base, error);
  }

  let applied: ReturnType<typeof applyLimsImportBatchInDb>;
  try {
    applied = applyLimsImportBatchInDb(input.deps.db, applyInput);
  } catch (error) {
    return registrationFailureResult(base, error);
  }
  const entityIds = applied.insertedEntityIds.map((entry) => entry.entityId);

  return {
    ...base,
    registered: entityIds.length === records.length,
    batchId: applied.batchId,
    entityIds,
    ...(entityIds.length !== records.length
      ? {
          userMessagePayload: userMessagePayload('registry.receipt.sequenceCountMismatch', {
            count: userMessageValue(input.productPaths.length),
            registered: userMessageValue(entityIds.length),
          }),
          reason:
            `Imported ${input.productPaths.length} sequences from "${input.displayName}", but ` +
            `the atomic registry batch inserted ${entityIds.length}.`,
        }
      : {}),
  };
}

interface PackageMetadataUpdate {
  path: string;
  originalContent: string;
  nextContent: string;
}

async function replacePackageMetadataBatch(
  workspaceRoot: string,
  updates: readonly PackageMetadataUpdate[]
): Promise<void> {
  const completed: PackageMetadataUpdate[] = [];
  try {
    for (const update of updates) {
      await writeWorkspaceTextFileAtomicInMain({
        workspaceRoot,
        path: update.path,
        content: update.nextContent,
        mode: 'replace',
        expectedContentHash: sha256Text(update.originalContent),
        artifactNoun: 'sequence package metadata',
      });
      completed.push(update);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const update of completed.reverse()) {
      try {
        await writeWorkspaceTextFileAtomicInMain({
          workspaceRoot,
          path: update.path,
          content: update.originalContent,
          mode: 'replace',
          expectedContentHash: sha256Text(update.nextContent),
          artifactNoun: 'sequence package metadata',
        });
      } catch (rollbackError) {
        rollbackFailures.push(
          `${update.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `Sequence package provenance write failed and rollback was incomplete: ${rollbackFailures.join('; ')}`,
        { cause: error }
      );
    }
    throw error;
  }
}

function buildManagedSequenceRecord(
  params: {
    content: string;
    destPath: string;
    displayName: string;
    kind?: RegisterableSequenceKind;
    actor?: string | null;
    packageDocument?: SequencePackageDocument;
    packageRoot?: string;
    sourceIdentity: ImportedSequenceSourceIdentity & { recordIndex: number };
  },
  recordId: string
): { record: LimsImportRecord } | { reason: string } {
  const recordCount = countSequenceRecords(params.content);
  if (recordCount > 1) {
    const formatLabel = sourceKindForPath(params.destPath) === 'genbank' ? 'GenBank' : 'FASTA';
    return {
      reason:
        `"${params.displayName}" contains ${recordCount} sequences. Multi-record ` +
        `${formatLabel} registration isn't supported yet.`,
    };
  }

  try {
    const parsed = parseSequenceContent(params.content, params.destPath);
    const topology = parsed.circular ? 'circular' : 'linear';
    const sequence = buildFileSequenceRef(params.destPath, params.content, {
      documentId: params.packageDocument?.id ?? recordId,
      length: parsed.length,
      topology,
      sourceFormat: sourceFormatForPath(params.destPath),
    });
    const kind: RegisterableSequenceKind = coerceRegisterableSequenceKind(params.kind);
    const managedDocument =
      params.packageDocument && params.packageRoot
        ? {
            kind: 'managed-sequence' as const,
            packageId: params.packageDocument.id,
            packageRoot: params.packageRoot,
          }
        : null;
    return {
      record: {
        id: recordId,
        action: 'register_entity',
        accepted: true,
        entity: {
          ...(params.packageDocument ? { id: params.packageDocument.id } : {}),
          kind: params.packageDocument?.entity.schema.name ?? kind,
          name: params.packageDocument?.name ?? sequenceEntityName(parsed.name, params.displayName),
          fields: {
            ...(params.packageDocument?.entity.fields ?? {}),
            sequence,
            ...(params.packageDocument
              ? {
                  schemaId: params.packageDocument.entity.schema.schemaId,
                  schemaRevisionId: params.packageDocument.entity.schema.schemaRevisionId,
                  packageKind: 'sequence',
                }
              : parsed.description
                ? { notes: parsed.description }
                : {}),
            ...(managedDocument ? { [MANAGED_SEQUENCE_DOCUMENT_FIELD]: managedDocument } : {}),
          },
          registrationStatus: params.packageDocument?.entity.registrationStatus ?? 'registered',
          domainStatus: params.packageDocument?.entity.domainStatus ?? null,
          ...(params.packageDocument
            ? {
                schemaRevisionId: params.packageDocument.entity.schema.schemaRevisionId,
                schemaSnapshot: params.packageDocument.entity.schema,
              }
            : {}),
          actor: params.actor ?? 'local-user',
        },
        source: {
          fileName: params.displayName,
          managedRelPath: params.destPath,
          length: parsed.length,
          circular: parsed.circular,
          fileContentHash: sequence.fileContentHash,
          normalizedSequenceHash: sequence.normalizedSequenceHash,
          sourceFileContentHash: params.sourceIdentity.fileContentHash,
          sourceRecordIndex: params.sourceIdentity.recordIndex,
          sourceRecordCount: params.sourceIdentity.recordCount,
          recordCount: 1,
        },
      },
    };
  } catch (err) {
    return {
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerImportedSequenceFromContent(
  request: RegisterImportedSequenceFromContentRequest,
  deps: RegisterImportedSequenceDeps
): Promise<RegisterImportedSequenceResult> {
  const sourceSha256 = sha256Text(request.content);
  validatePreviewedSourceHash(sourceSha256, request.expectedSourceSha256);

  const copy = await importContentIntoWorkspaceRoot(
    {
      targetRoot: request.targetRoot,
      fileName: request.fileName,
      content: request.content,
      dedup: request.dedup,
    },
    deps
  );

  const productPaths = await managedPackageProductsForCopy(copy);
  if (productPaths.length) {
    return registerPackagedImport({
      productPaths,
      copy,
      deps,
      displayName: request.fileName,
      kind: request.kind,
      actor: request.actor,
      batchId: request.batchId,
      sourceIdentity: {
        fileContentHash: `sha256:${sourceSha256}`,
        recordCount: productPaths.length,
      },
    });
  }

  return packageRequiredResult(baseResult(copy));
}

async function managedPackageProductsForCopy(
  copy: import('../shared/workspace-git-types').ImportFileResult
): Promise<string[]> {
  if (copy.packageProductPaths?.length) return [...copy.packageProductPaths];
  return (await existingPlasmidPackageRootForProduct(copy.destPath)) ? [copy.destPath] : [];
}

function baseResult(
  copy: import('../shared/workspace-git-types').ImportFileResult
): Omit<RegisterImportedSequenceResult, 'registered' | 'batchId' | 'entityIds' | 'reason'> {
  return {
    destPath: copy.destPath,
    ...(copy.packageProductPaths ? { packageProductPaths: copy.packageProductPaths } : {}),
    relPath: copy.relPath,
    committed: copy.committed,
    copySkipped: copy.skipped ?? false,
  };
}

function registrationFailureResult(
  base: ReturnType<typeof baseResult>,
  error: unknown
): RegisterImportedSequenceResult {
  return {
    ...base,
    registered: false,
    batchId: null,
    entityIds: [],
    userMessagePayload: userMessagePayload('registry.receipt.registrationFailed'),
    reason: `The file was imported, but registry registration failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

function packageRequiredResult(
  base: ReturnType<typeof baseResult>
): RegisterImportedSequenceResult {
  return {
    ...base,
    registered: false,
    batchId: null,
    entityIds: [],
    userMessagePayload: userMessagePayload('registry.receipt.sequencePackageMissing'),
    reason:
      'The file was imported, but no managed sequence package was produced. ' +
      'The Registry was not changed.',
  };
}
