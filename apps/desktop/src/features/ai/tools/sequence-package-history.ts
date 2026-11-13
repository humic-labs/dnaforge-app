import { z } from 'zod';
import {
  isSequencePackageMetaPath,
  sequencePackageRootForMetaPath,
  type SequencePackageRevision,
} from '../../../db/sequence-package';
import { isSequencePackageFileKind } from '../../../db/sequence-package-contract';
import {
  readSequencePackageHistoryIndex,
  readSequencePackageEvidenceRun,
  readSequencePackageUserAttachment,
  readSequencePackageRevision,
  type SequencePackageHistoryIndex,
  type SequencePackageRevisionRead,
  type SequencePackageEvidenceRead,
  type SequencePackageUserAttachmentRead,
} from '../../../db/sequence-package-history-io';
import {
  annotationIdForRestoreItem,
  sequenceRestoreItemCatalog,
  sourceValueForRestoreItem,
  RESTORE_PRODUCT_ITEM,
  userAttachmentIdForRestoreItem,
} from '../../../db/sequence-package-restore';
import { getCurrentSequenceFileForDocumentId } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import { findContainingPathBoundary, isAbsolutePathLike } from '../../../shared/path-boundary';
import type {
  SequenceRestoreApplyRequest,
  SequenceRestorePreviewRequest,
  SequenceRestorePreviewResult,
} from '../../../shared/sequence-package-revision';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  applySequencePackageRestoreWithDelivery,
  type SequenceRestoreDeliveredResult,
} from '../../sequence/public/apply-sequence-package-restore';
import { parseSequenceFileAsDocument } from '../../../shared/parse-sequence-file';
import {
  listManagedGenBankAnnotations,
  managedGenBankAnnotationValueDigest,
  parseGenBankFull,
} from '@waypoint/sequence-utils';
import { normalizeSequenceDocumentId } from './path-utils';

const documentIdField = z.string().trim().min(1).max(1024).describe(
  'Stable managed sequence package ID or waypoint://sequence/{documentId} URI; never a path.'
);
const revisionIdField = z.string().trim().min(1).max(256);
const itemIdField = z.string().trim().min(1).max(512);
const selectionSchema = z.object({ itemId: itemIdField, revisionId: revisionIdField }).strict();

export const getSequencePackageHistorySchema = z.object({
  documentId: documentIdField,
  revisionOffset: z.number().int().min(0).max(1_000_000).optional(),
  revisionLimit: z.number().int().min(1).max(50).optional(),
  itemOffset: z.number().int().min(0).max(1_000_000).optional(),
  itemLimit: z.number().int().min(1).max(50).optional(),
  evidenceOffset: z.number().int().min(0).max(1_000_000).optional(),
  evidenceLimit: z.number().int().min(1).max(50).optional(),
}).strict();

export const readSequencePackageEvidenceRunSchema = z.object({
  documentId: documentIdField,
  runId: z.string().trim().min(1).max(256),
  queryId: z.string().trim().min(1).max(256).optional(),
}).strict();

export const readSequencePackageHistoryItemSchema = z.object({
  documentId: documentIdField,
  revisionId: revisionIdField,
  itemId: itemIdField,
  start: z.number().int().min(1).optional(),
  end: z.number().int().min(1).optional(),
}).strict();

export const previewSequencePackageRestoreSchema = z.object({
  documentId: documentIdField,
  selections: z.array(selectionSchema).min(1).max(256),
}).strict();

export const applySequencePackageRestoreSchema = previewSequencePackageRestoreSchema.extend({
  previewFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  operationId: z.string().trim().min(1).max(256),
}).strict();

export interface ResolvedSequencePackageHistory {
  index: SequencePackageHistoryIndex;
  workspaceRoot: string;
}

export interface SequencePackageHistoryToolDependencies {
  resolveIndex(documentId: string, folders: WorkspaceFolder[]): Promise<ResolvedSequencePackageHistory>;
  readRevision(input: Omit<Parameters<typeof readSequencePackageRevision>[0], 'fs'>): Promise<SequencePackageRevisionRead>;
  readEvidence(input: Omit<Parameters<typeof readSequencePackageEvidenceRun>[0], 'fs'>): Promise<SequencePackageEvidenceRead>;
  readUserAttachment?(input: Omit<Parameters<typeof readSequencePackageUserAttachment>[0], 'fs'>): Promise<SequencePackageUserAttachmentRead>;
  previewRestore(request: SequenceRestorePreviewRequest): Promise<SequenceRestorePreviewResult>;
  applyRestore?(request: SequenceRestoreApplyRequest): Promise<SequenceRestoreDeliveredResult>;
}

const defaultDependencies: SequencePackageHistoryToolDependencies = {
  resolveIndex: resolveHistoryIndex,
  readRevision: (input) => readSequencePackageRevision({ ...input, fs: platform().fs }),
  readEvidence: (input) => readSequencePackageEvidenceRun({ ...input, fs: platform().fs }),
  readUserAttachment: (input) => readSequencePackageUserAttachment({ ...input, fs: platform().fs }),
  previewRestore: (request) => platform().fs.previewSequenceRestore(request),
  applyRestore: applySequencePackageRestoreWithDelivery,
};

export async function resolveHistoryIndex(
  documentId: string,
  folders: WorkspaceFolder[]
): Promise<ResolvedSequencePackageHistory> {
  const binding = await getCurrentSequenceFileForDocumentId(documentId);
  if (binding) {
    if (!isSequencePackageFileKind(binding.file_kind)) {
      throw new Error('This sequence is not a managed sequence package.');
    }
    const folder = findContainingPathBoundary(folders, binding.path);
    if (!folder) throw new Error('The sequence package is not in an open workspace.');
    return {
      index: await readSequencePackageHistoryIndex({
        packageRoot: binding.path,
        workspaceRoot: folder.path,
        expectedPackageId: binding.entity_id,
        fs: platform().fs,
      }),
      workspaceRoot: folder.path,
    };
  }

  let found: ResolvedSequencePackageHistory | null = null;
  let incompleteDiscovery = false;
  for (const folder of folders) {
    const discovered = await platform().workspace.discoverArtifacts({
      rootPath: folder.path,
      knownFiles: [],
    });
    if (discovered.errors.length > 0) incompleteDiscovery = true;
    for (const metaPath of discovered.entityArtifactPaths) {
      if (!isSequencePackageMetaPath(metaPath)) continue;
      const packageRoot = sequencePackageRootForMetaPath(metaPath);
      if (!packageRoot) continue;
      let candidate: SequencePackageHistoryIndex;
      try {
        candidate = await readSequencePackageHistoryIndex({
          packageRoot,
          workspaceRoot: folder.path,
          fs: platform().fs,
        });
      } catch {
        incompleteDiscovery = true;
        continue;
      }
      if (candidate.document.id !== documentId) continue;
      if (found) throw new Error('More than one package has this sequence identity.');
      found = { index: candidate, workspaceRoot: folder.path };
    }
  }
  if (found && !incompleteDiscovery) return found;
  throw new Error(
    incompleteDiscovery
      ? 'Sequence package discovery was incomplete; its identity cannot be verified.'
      : 'No managed sequence package has this document identity.'
  );
}

function historyFailure(code: string, error: string, retriable = false) {
  return toolFailure({ code, error, retriable, stateChanged: false, partialEffects: [] });
}

function packageRequest(
  resolved: ResolvedSequencePackageHistory,
  selections: z.infer<typeof selectionSchema>[]
): SequenceRestorePreviewRequest {
  return {
    workspaceRoot: resolved.workspaceRoot,
    packageRoot: resolved.index.packageRoot,
    packageId: resolved.index.document.id,
    selections,
  };
}

function resolveDocumentId(input: string): string {
  return normalizeSequenceDocumentId(input);
}

export function createGetSequencePackageHistoryTool(
  folders: WorkspaceFolder[],
  deps: SequencePackageHistoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Discover saved sequence-package revisions and individually selectable historical items ' +
      'by stable document ID. Returns bounded pages of identities and summaries, not raw files or paths.',
    inputSchema: getSequencePackageHistorySchema,
    execute: async (input: z.infer<typeof getSequencePackageHistorySchema>) => {
      try {
        const documentId = resolveDocumentId(input.documentId);
        const { index } = await deps.resolveIndex(documentId, folders);
        const allRevisions = index.document.versionHistory.revisions;
        const revisionOffset = input.revisionOffset ?? 0;
        const revisionLimit = input.revisionLimit ?? 20;
        const itemOffset = input.itemOffset ?? 0;
        const itemLimit = input.itemLimit ?? 50;
        const allItems = sequenceRestoreItemCatalog(index.document);
        const allEvidence = index.document.evidenceRuns ?? [];
        const evidenceOffset = input.evidenceOffset ?? 0;
        const evidenceLimit = input.evidenceLimit ?? 20;
        const evidenceRuns = [...allEvidence].reverse()
          .slice(evidenceOffset, evidenceOffset + evidenceLimit)
          .map((run) => ({
            runId: run.id,
            sessionId: run.sessionId,
            status: run.status,
            createdAt: run.createdAt,
            checkpointId: run.reference.checkpointId,
            referenceSha256: run.reference.artifact.sha256,
            readCount: run.queries.length,
            reviewCount: run.states?.length ?? 0,
          }));
        const revisions = [...allRevisions].reverse()
          .slice(revisionOffset, revisionOffset + revisionLimit)
          .map((revision) => ({
            revisionId: revision.id,
            parentId: revision.parentId,
            kind: revision.kind,
            createdAt: revision.createdAt,
            name: revision.state.name,
            referenceSha256: revision.productSnapshot.sha256,
            topology: revision.state.product.topology ?? null,
            sourceItemIds: Object.keys(revision.sources ?? {}),
          }));
        const items = allItems.slice(itemOffset, itemOffset + itemLimit)
          .map((item) => ({
            itemId: item.id,
            label: item.label,
            sourceRevisionIds: item.sourceRevisionIds,
          }));
        return toolSuccess({
          documentId: index.document.id,
          currentHeadId: index.document.versionHistory.headId,
          currentProductStatus: index.currentProductStatus,
          legacyCurrentHasNoSnapshot: index.legacyCurrentHasNoSnapshot,
          totalRevisionCount: allRevisions.length,
          revisionOffset,
          revisions,
          nextRevisionOffset:
            revisionOffset + revisions.length < allRevisions.length
              ? revisionOffset + revisions.length : null,
          totalItemCount: allItems.length,
          itemOffset,
          items,
          nextItemOffset:
            itemOffset + items.length < allItems.length ? itemOffset + items.length : null,
          totalEvidenceCount: allEvidence.length,
          evidenceOffset,
          evidenceRuns,
          nextEvidenceOffset:
            evidenceOffset + evidenceRuns.length < allEvidence.length
              ? evidenceOffset + evidenceRuns.length : null,
        });
      } catch {
        return historyFailure(
          'SEQUENCE_HISTORY_UNAVAILABLE',
          'No readable managed sequence package History matches this stable document identity.'
        );
      }
    },
  });
}

export function createReadSequencePackageEvidenceRunTool(
  folders: WorkspaceFolder[],
  deps: SequencePackageHistoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Inspect one package-retained sequencing run against its exact frozen reference and reads. ' +
      'Verifies every artifact and returns bounded review data without machine-local paths.',
    inputSchema: readSequencePackageEvidenceRunSchema,
    execute: async (input: z.infer<typeof readSequencePackageEvidenceRunSchema>) => {
      try {
        const documentId = resolveDocumentId(input.documentId);
        const { index, workspaceRoot } = await deps.resolveIndex(documentId, folders);
        const run = index.document.evidenceRuns?.find((candidate) => candidate.id === input.runId);
        if (!run) return historyFailure('EVIDENCE_RUN_UNKNOWN', 'No retained sequencing run has this identity.');
        if (input.queryId && !run.queries.some((query) => query.id === input.queryId)) {
          return historyFailure('EVIDENCE_QUERY_UNKNOWN', 'No frozen read has this query identity.');
        }
        const read = await deps.readEvidence({ index, runId: run.id, workspaceRoot });
        const shared = {
          documentId: index.document.id,
          runId: run.id,
          sessionId: run.sessionId,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt ?? null,
          testedReference: {
            sha256: run.reference.artifact.sha256,
            sequenceRevision: run.reference.sequenceRevision,
            topology: run.reference.topology,
            checkpointId: run.reference.checkpointId,
          },
          producer: run.producer ?? null,
          queries: run.queries.map((query) => ({
            queryId: query.id, label: query.label, sha256: query.artifact.sha256,
          })),
          resultSha256: run.result?.sha256 ?? null,
          reviewCount: run.states?.length ?? 0,
        };
        if (read.status === 'unavailable') {
          return toolSuccess({ ...shared, artifactStatus: 'unavailable', reason: read.reason });
        }
        const latest = read.states[read.states.length - 1];
        const tracks = latest && typeof latest === 'object' && 'tracks' in latest &&
          Array.isArray((latest as { tracks: unknown }).tracks)
          ? (latest as { tracks: unknown[] }).tracks : [];
        const selectedTracks = input.queryId
          ? tracks.filter((track) => track && typeof track === 'object' &&
              (track as { queryId?: unknown }).queryId === input.queryId)
          : tracks;
        return toolSuccess({
          ...shared,
          artifactStatus: 'verified',
          latestReview: selectedTracks.slice(0, 50).map((track) => {
            const row = track as Record<string, unknown>;
            const mutations = Array.isArray(row.mutations) ? row.mutations : [];
            return {
              queryId: row.queryId,
              status: row.status,
              userStatus: row.userStatus ?? null,
              userOverrideReason: row.userOverrideReason ?? null,
              mutationCount: mutations.length,
              mutations: input.queryId ? mutations.slice(0, 50).map(redactPrivateLocators) : undefined,
              mutationsTruncated: Boolean(input.queryId && mutations.length > 50),
            };
          }),
        });
      } catch {
        return historyFailure('EVIDENCE_READ_FAILED', 'The requested package evidence could not be verified.');
      }
    },
  });
}

export function createReadSequencePackageHistoryItemTool(
  folders: WorkspaceFolder[],
  deps: SequencePackageHistoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Read one recorded item at one saved sequence-package revision. Historical product bytes ' +
      'must pass their snapshot integrity check; base windows are bounded to 1000 positions.',
    inputSchema: readSequencePackageHistoryItemSchema,
    execute: async (input: z.infer<typeof readSequencePackageHistoryItemSchema>) => {
      try {
        const documentId = resolveDocumentId(input.documentId);
        const { index, workspaceRoot } = await deps.resolveIndex(documentId, folders);
        const item = sequenceRestoreItemCatalog(index.document)
          .find((candidate) => candidate.id === input.itemId);
        if (!item) return historyFailure('HISTORY_ITEM_UNKNOWN', 'This item has no stable historical identity.');
        const revision = index.document.versionHistory.revisions.find(
          (candidate) => candidate.id === input.revisionId
        );
        if (!revision) return historyFailure('HISTORY_REVISION_UNKNOWN', 'No saved revision has this identity.');
        if (input.itemId !== RESTORE_PRODUCT_ITEM &&
            (input.start !== undefined || input.end !== undefined)) {
          return historyFailure('HISTORY_WINDOW_INVALID', 'Base windows apply only to the product item.');
        }
        if (input.itemId !== RESTORE_PRODUCT_ITEM) {
          const annotationId = annotationIdForRestoreItem(input.itemId);
          if (annotationId !== null) {
            const source = sourceValueForRestoreItem(revision, input.itemId);
            const read = await deps.readRevision({
              index,
              revisionId: revision.id,
              workspaceRoot,
            });
            if (read.status === 'unavailable') {
              return historyFailure(
                'HISTORICAL_SNAPSHOT_UNAVAILABLE',
                'This historical annotation snapshot is missing or failed its integrity check.'
              );
            }
            const recorded = listManagedGenBankAnnotations(read.content).find(
              (annotation) => annotation.id === annotationId
            );
            if (Boolean(recorded) !== source.present) {
              return historyFailure(
                'HISTORICAL_ANNOTATION_UNAVAILABLE',
                'The saved annotation identity does not match its verified product snapshot.'
              );
            }
            const digest = await managedGenBankAnnotationValueDigest(read.content, annotationId);
            const parsed = source.present
              ? parseGenBankFull(read.content).annotations.find(
                  (annotation) => annotation.qualifiers?.dnaforge_ann_id?.includes(annotationId)
                )
              : undefined;
            if (source.present && (!recorded || !parsed)) {
              return historyFailure(
                'HISTORICAL_ANNOTATION_UNAVAILABLE',
                'The saved annotation cannot be resolved from its verified product snapshot.'
              );
            }
            return toolSuccess({
              documentId: index.document.id,
              revisionId: revision.id,
              itemId: input.itemId,
              present: source.present,
              valueSha256: digest.valueSha256,
              ...(parsed ? boundedPublicValue(parsed) : {}),
            });
          }
          const attachmentId = userAttachmentIdForRestoreItem(input.itemId);
          if (attachmentId !== null) {
            const read = await (deps.readUserAttachment ?? ((request) =>
              readSequencePackageUserAttachment({ ...request, fs: platform().fs })))({
              index,
              revisionId: revision.id,
              attachmentId,
              workspaceRoot,
            });
            if (read.status === 'unavailable') {
              return historyFailure('HISTORICAL_ATTACHMENT_UNAVAILABLE', read.reason);
            }
            return toolSuccess({
              documentId: index.document.id,
              revisionId: revision.id,
              itemId: input.itemId,
              present: read.present,
              ...(read.present ? { sha256: read.sha256, sizeBytes: read.sizeBytes } : {}),
            });
          }
          const source = sourceValueForRestoreItem(revision, input.itemId);
          return toolSuccess({
            documentId: index.document.id,
            revisionId: revision.id,
            itemId: input.itemId,
            present: source.present,
            ...(source.present ? boundedPublicValue(source.value) : {}),
          });
        }
        const read = await deps.readRevision({
          index,
          revisionId: revision.id,
          workspaceRoot,
        });
        if (read.status === 'unavailable') {
          return historyFailure(
            'HISTORICAL_SNAPSHOT_UNAVAILABLE',
            'This historical product snapshot is missing or failed its integrity check.'
          );
        }
        const sequence = parseSequenceFileAsDocument(read.content, index.productPath).sequence;
        const bases = sequence.sequence ?? '';
        let window: { start: number; end: number; bases: string } | null = null;
        if (input.start !== undefined || input.end !== undefined) {
          if (input.start === undefined || input.end === undefined ||
              input.start > input.end || input.end > bases.length ||
              input.end - input.start + 1 > 1000) {
            return historyFailure(
              'HISTORY_WINDOW_INVALID',
              'Pass an in-range, 1-indexed inclusive start/end window of at most 1000 bases.'
            );
          }
          window = {
            start: input.start,
            end: input.end,
            bases: bases.slice(input.start - 1, input.end),
          };
        }
        return toolSuccess({
          documentId: index.document.id,
          revisionId: revision.id,
          itemId: RESTORE_PRODUCT_ITEM,
          present: true,
          referenceSha256: revision.productSnapshot.sha256,
          topology: sequence.circular ? 'circular' : 'linear',
          lengthBp: bases.length,
          window,
        });
      } catch {
        return historyFailure('HISTORY_ITEM_READ_FAILED', 'The requested historical item could not be verified.');
      }
    },
  });
}

export function createPreviewSequencePackageRestoreTool(
  folders: WorkspaceFolder[],
  deps: SequencePackageHistoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Preview one exact selection of historical package items against the CURRENT package. ' +
      'Returns its fingerprint, sources, changes and dependency blockers without writing.',
    inputSchema: previewSequencePackageRestoreSchema,
    execute: async (input: z.infer<typeof previewSequencePackageRestoreSchema>) => {
      try {
        const documentId = resolveDocumentId(input.documentId);
        const resolved = await deps.resolveIndex(documentId, folders);
        const preview = await deps.previewRestore(packageRequest(resolved, input.selections));
        return toolSuccess({ documentId: resolved.index.document.id, ...preview });
      } catch {
        return historyFailure(
          'RESTORE_PREVIEW_UNAVAILABLE',
          'The package or selected history could not be verified for a read-only Restore preview.'
        );
      }
    },
  });
}

export function createApplySequencePackageRestoreTool(
  folders: WorkspaceFolder[],
  deps: SequencePackageHistoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Apply exactly one reviewed selective Restore preview as a new package revision. ' +
      'The shared UI/agent operation checks dirty editors, publication, Registry and Git delivery. ' +
      'It does not open or activate a tab.',
    inputSchema: applySequencePackageRestoreSchema,
    execute: async (input: z.infer<typeof applySequencePackageRestoreSchema>) => {
      let publicationAttempted = false;
      try {
        const documentId = resolveDocumentId(input.documentId);
        const resolved = await deps.resolveIndex(documentId, folders);
        const apply = deps.applyRestore ?? applySequencePackageRestoreWithDelivery;
        publicationAttempted = true;
        const result = await apply({
          ...packageRequest(resolved, input.selections),
          operationId: input.operationId,
          previewFingerprint: input.previewFingerprint,
        });
        if (result.delivery.git === 'failed' || result.delivery.git === 'unverified-replay') {
          return toolFailure({
            code: result.delivery.git === 'failed'
              ? 'RESTORE_GIT_DELIVERY_FAILED' : 'RESTORE_GIT_RECEIPT_UNVERIFIED',
            error: result.delivery.git === 'failed'
              ? 'Restore was published and Registry reconciled, but its Git receipt failed. Inspect History and Git before retrying.'
              : 'The previous Restore publication was found and Registry reconciled, but its Git receipt cannot be verified from this replay.',
            retriable: false,
            stateChanged: result.alreadyPublished ? 'unknown' : true,
            partialEffects: result.alreadyPublished
              ? ['prior-package-revision-confirmed', 'registry-reconciled']
              : ['package-revision-published', 'registry-reconciled'],
            details: {
              revisionId: result.revisionId,
              alreadyPublished: result.alreadyPublished,
              gitDelivery: result.delivery.git,
            },
          });
        }
        return toolSuccess({
          documentId: resolved.index.document.id,
          revisionId: result.revisionId,
          alreadyPublished: result.alreadyPublished,
          durableStage: 'package-revision-published',
          delivery: result.delivery,
        });
      } catch (error) {
        return classifyRestoreApplyFailure(error, publicationAttempted);
      }
    },
  });
}

function classifyRestoreApplyFailure(error: unknown, publicationAttempted: boolean) {
  if (!publicationAttempted) {
    return historyFailure('RESTORE_TARGET_UNAVAILABLE',
      'The managed sequence package could not be verified for Restore.');
  }
  const message = error instanceof Error ? error.message : '';
  if (/save or discard current sequence edits|an editor has unsaved changes|an editor is still saving/i.test(message)) {
    return historyFailure('RESTORE_DIRTY_EDITOR',
      'Save or discard current edits, then obtain a fresh Restore preview.');
  }
  if (/restore preview is stale/i.test(message)) {
    return historyFailure('RESTORE_STALE_PREVIEW',
      'The reviewed preview no longer matches the current package. Preview again.');
  }
  if (/restore operation id was already used/i.test(message)) {
    return historyFailure('RESTORE_OPERATION_CONFLICT',
      'This operation ID belongs to another reviewed request. Inspect History before a new preview.');
  }
  if (/restore is blocked:/i.test(message)) {
    return historyFailure('RESTORE_DEPENDENCY_BLOCKED',
      'Selected historical items are incompatible. Review the blockers and preview again.');
  }
  return toolFailure({
    code: 'RESTORE_OUTCOME_UNCONFIRMED',
    error:
      'Restore did not return a confirmed publication receipt. Inspect History before retrying the identical operation.',
    retriable: false,
    stateChanged: 'unknown',
    partialEffects: [],
  });
}

const MAX_INLINE_VALUE_CHARS = 4096;

function boundedPublicValue(value: unknown): Record<string, unknown> {
  const projected = redactPrivateLocators(value);
  const serialized = JSON.stringify(projected);
  if (serialized === undefined) return { value: null };
  if (serialized.length <= MAX_INLINE_VALUE_CHARS) return { value: projected };
  return {
    value: null,
    valuePreview: serialized.slice(0, MAX_INLINE_VALUE_CHARS),
    valueTruncated: true,
    serializedLength: serialized.length,
  };
}

function redactPrivateLocators(value: unknown): unknown {
  if (typeof value === 'string') {
    return isAbsolutePathLike(value) || value.startsWith('file://') ? '[private path]' : value;
  }
  if (Array.isArray(value)) return value.map(redactPrivateLocators);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:path|root|locator)$/i.test(key)) continue;
    output[key] = redactPrivateLocators(part);
  }
  return output;
}
