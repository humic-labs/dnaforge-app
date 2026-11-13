import { z } from 'zod';

import {
  parseSequencePackageDocument,
  type SequencePackageDocument,
} from '../../../db/sequence-package';
import type { SequencePackageHistoryIndex } from '../../../db/sequence-package-history-io';
import {
  prepareSequenceUserAttachmentMutation,
  type UserAttachmentMutation,
} from '../../../db/sequence-package-user-attachment-mutation';
import { platform } from '../../../platform';
import type { FilesystemStat } from '../../../shared/filesystem-stat';
import {
  findContainingPathBoundary,
  isPathInsideBoundary,
  isSafeWorkspaceRelativePath,
} from '../../../shared/path-boundary';
import type {
  SequenceUserAttachmentMutationRequest,
  SequenceUserAttachmentMutationResult,
} from '../../../shared/sequence-package-revision';
import { MAX_WORKSPACE_BINARY_WRITE_BYTES } from '../../../shared/workspace-file-atomic';
import { assertWorkspaceEditorsSettled } from '../../../services/workspace-editor-mutation-state';
import { withRendererWorkspaceMutation } from '../../../services/workspace-mutation-transaction';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { useCanvasStore } from '../../canvas/public/store';
import { useSequenceStore } from '../../sequence/public/store';
import { getUserFolders, resolveMultiRootPath } from '../../workspace/public/path-resolve';
import { normalizeSequenceDocumentId } from './path-utils';
import {
  resolveHistoryIndex,
  type ResolvedSequencePackageHistory,
} from './sequence-package-history';

const digestField = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uuidField = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const documentIdField = z.string().trim().min(1).max(1024).describe(
  'Stable managed sequence package ID or waypoint://sequence/{documentId} URI, not a path.'
);
const sourcePathField = z.string().min(1).max(2048).describe(
  'Project-relative path to a file in an open writable workspace. Prefix the project name when several are open.'
);
const kindField = z.enum(['attach', 'replace', 'detach']);

export const previewSequenceUserAttachmentMutationSchema = z.object({
  documentId: documentIdField,
  kind: kindField,
  attachmentId: z.string().min(1).max(256).optional().describe(
    'Existing logical attachment ID for replace/detach; optional for a new attach.'
  ),
  sourcePath: sourcePathField.optional().describe('Required for attach or replace; omit for detach.'),
}).strict();

export const applySequenceUserAttachmentMutationSchema = previewSequenceUserAttachmentMutationSchema.extend({
  attachmentId: z.string().min(1).max(256),
  operationId: z.string().regex(/^user-attachment:[a-f0-9-]{36}$/).max(256),
  memberId: uuidField.optional(),
  createdAt: z.string().datetime({ offset: true }),
  fileName: z.string().min(1).max(180).optional(),
  sourceSha256: digestField.optional(),
  sourceSizeBytes: z.number().int().min(0).max(MAX_WORKSPACE_BINARY_WRITE_BYTES).optional(),
  previousMemberId: z.string().min(1).max(256).optional(),
  previousSha256: digestField.optional(),
  currentHeadId: z.string().min(1).max(256),
  expectedMarkerSha256: digestField,
  expectedProductSha256: digestField,
  previewFingerprint: digestField,
}).strict();

export type PreviewSequenceUserAttachmentMutationInput = z.infer<
  typeof previewSequenceUserAttachmentMutationSchema
>;
export type ApplySequenceUserAttachmentMutationInput = z.infer<
  typeof applySequenceUserAttachmentMutationSchema
>;

interface PackageBaseline {
  markerSha256: string;
  productSha256: string;
}

export interface SequenceUserAttachmentToolDependencies {
  resolveIndex(documentId: string, folders: WorkspaceFolder[]): Promise<ResolvedSequencePackageHistory>;
  captureBaseline(index: SequencePackageHistoryIndex): Promise<PackageBaseline>;
  stat(path: string): Promise<FilesystemStat>;
  validateWorkspacePath(input: {
    workspaceRoot: string;
    path: string;
    artifactNoun?: string;
  }): Promise<boolean>;
  readFileBounded(path: string, maxBytes: number): Promise<Uint8Array>;
  assertEditorsSettled(index: SequencePackageHistoryIndex): void;
  withMutation(
    workspaceRoot: string,
    work: (mutationToken?: string) => Promise<SequenceUserAttachmentMutationResult>
  ): Promise<SequenceUserAttachmentMutationResult>;
  publish(request: SequenceUserAttachmentMutationRequest): Promise<SequenceUserAttachmentMutationResult>;
  uuid(): string;
  now(): string;
}

const defaultDependencies: SequenceUserAttachmentToolDependencies = {
  resolveIndex: resolveHistoryIndex,
  captureBaseline: captureCurrentBaseline,
  stat: (path) => platform().fs.stat(path),
  validateWorkspacePath: (input) => platform().fs.validateWorkspacePath(input),
  readFileBounded: (path, maxBytes) => platform().fs.readFileBounded(path, maxBytes),
  assertEditorsSettled: assertPackageEditorsSettled,
  withMutation: (root, work) => withRendererWorkspaceMutation(root, work, undefined, {
    waitForAvailability: true,
  }),
  publish: (request) => platform().fs.publishSequenceUserAttachmentMutation(request),
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
};

type Intent = Omit<ApplySequenceUserAttachmentMutationInput, 'previewFingerprint'>;

class AttachmentToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function fail(code: string, error: string, stateChanged: false | 'unknown' = false) {
  return toolFailure({
    code,
    error,
    retriable: false,
    stateChanged,
    partialEffects: [],
  });
}

function classifyBeforePublication(error: unknown) {
  if (error instanceof AttachmentToolError) return fail(error.code, error.message);
  return fail(
    'ATTACHMENT_PREVIEW_UNAVAILABLE',
    'The package, source file or reviewed attachment intent could not be verified. Refresh History and preview again.'
  );
}

function requireWritablePackage(
  folders: WorkspaceFolder[],
  resolved: ResolvedSequencePackageHistory
): void {
  const writableFolders = getUserFolders(folders);
  const owningFolder = findContainingPathBoundary(writableFolders, resolved.index.packageRoot);
  if (!owningFolder || owningFolder.path !== resolved.workspaceRoot ||
      resolved.index.currentProductStatus !== 'verified' ||
      !resolved.index.document.versionHistory.headId) {
    throw new AttachmentToolError(
      'ATTACHMENT_PACKAGE_UNAVAILABLE',
      'Open a writable managed package with a verified current version before changing attachments.'
    );
  }
}

async function resolvePackage(
  documentId: string,
  folders: WorkspaceFolder[],
  deps: SequenceUserAttachmentToolDependencies
): Promise<ResolvedSequencePackageHistory> {
  if (getUserFolders(folders).length === 0) {
    throw new AttachmentToolError('ATTACHMENT_PACKAGE_UNAVAILABLE', 'Open a writable project first.');
  }
  try {
    const resolved = await deps.resolveIndex(documentId, getUserFolders(folders));
    requireWritablePackage(folders, resolved);
    return resolved;
  } catch (error) {
    if (error instanceof AttachmentToolError) throw error;
    throw new AttachmentToolError(
      'ATTACHMENT_PACKAGE_UNAVAILABLE',
      'No verified managed package with this stable identity is in an open writable project.'
    );
  }
}

function assertEditors(
  index: SequencePackageHistoryIndex,
  deps: SequenceUserAttachmentToolDependencies
): void {
  try {
    deps.assertEditorsSettled(index);
  } catch {
    throw new AttachmentToolError(
      'ATTACHMENT_DIRTY_EDITOR',
      'Save or discard unfinished package edits before changing attachments.'
    );
  }
}

function fileNameFromRelativePath(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? '';
}

interface SourceRead {
  bytes: Uint8Array;
  sha256: string;
  sizeBytes: number;
  fileName: string;
}

async function readWorkspaceSource(
  folders: WorkspaceFolder[],
  inputPath: string,
  deps: SequenceUserAttachmentToolDependencies
): Promise<SourceRead> {
  if (!isSafeWorkspaceRelativePath(inputPath)) {
    throw new AttachmentToolError(
      'ATTACHMENT_SOURCE_UNAVAILABLE',
      'Choose a project-relative file inside an open writable workspace.'
    );
  }
  try {
    const writableFolders = getUserFolders(folders);
    if (writableFolders.length === 0) throw new Error('No writable project is open.');
    const resolved = resolveMultiRootPath(writableFolders, inputPath);
    const [rootBefore, fileBefore] = await Promise.all([
      deps.stat(resolved.folder.path),
      deps.stat(resolved.absolutePath),
    ]);
    if (!rootBefore.isDirectory || !fileBefore.isFile ||
        fileBefore.size > MAX_WORKSPACE_BINARY_WRITE_BYTES ||
        !isPathInsideBoundary(fileBefore.canonicalPath, rootBefore.canonicalPath) ||
        !(await deps.validateWorkspacePath({
          workspaceRoot: resolved.folder.path,
          path: resolved.absolutePath,
          artifactNoun: 'user attachment',
        }))) {
      throw new Error('Source failed workspace, type or size validation.');
    }
    const bytes = await deps.readFileBounded(
      resolved.absolutePath,
      MAX_WORKSPACE_BINARY_WRITE_BYTES
    );
    const fileAfter = await deps.stat(resolved.absolutePath);
    if (!fileAfter.isFile || !sameFileStat(fileBefore, fileAfter) ||
        !(await deps.validateWorkspacePath({
          workspaceRoot: resolved.folder.path,
          path: resolved.absolutePath,
          artifactNoun: 'user attachment',
        })) || bytes.byteLength !== fileAfter.size) {
      throw new Error('Source changed during bounded read.');
    }
    return {
      bytes,
      sha256: await sha256Bytes(bytes),
      sizeBytes: bytes.byteLength,
      fileName: fileNameFromRelativePath(resolved.relativePath),
    };
  } catch {
    throw new AttachmentToolError(
      'ATTACHMENT_SOURCE_UNAVAILABLE',
      'The source must be a stable file of at most 25 MiB inside an open writable project, without a symbolic-link escape.'
    );
  }
}

function sameFileStat(left: FilesystemStat, right: FilesystemStat): boolean {
  return left.canonicalPath === right.canonicalPath && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.device === right.device && left.inode === right.inode;
}

function currentAttachment(
  document: SequencePackageDocument,
  kind: Intent['kind'],
  attachmentId: string
): { previousMemberId?: string; previousSha256?: string } {
  const entry = document.userAttachments[attachmentId];
  if (kind === 'attach') {
    if (entry) throw new AttachmentToolError(
      'ATTACHMENT_MUTATION_INVALID',
      'This logical attachment already exists. Preview a replacement instead.'
    );
    return {};
  }
  const member = document.members.find((candidate) => candidate.id === entry?.memberId);
  if (!entry || !entry.sha256 || !member || member.role !== 'user' || member.replaceable) {
    throw new AttachmentToolError(
      'ATTACHMENT_MUTATION_INVALID',
      'This attachment has no verified current bytes and cannot be replaced or detached.'
    );
  }
  return { previousMemberId: entry.memberId, previousSha256: entry.sha256 };
}

function mutationFromIntent(intent: Intent, bytes?: Uint8Array): UserAttachmentMutation {
  if (intent.kind === 'detach') {
    if (intent.sourcePath || intent.memberId || intent.fileName || intent.sourceSha256 ||
        intent.sourceSizeBytes !== undefined) {
      throw new AttachmentToolError('ATTACHMENT_MUTATION_INVALID', 'Detach must not include a source file.');
    }
    return { kind: 'detach', attachmentId: intent.attachmentId, createdAt: intent.createdAt };
  }
  if (!intent.sourcePath || !intent.memberId || !intent.fileName || !intent.sourceSha256 ||
      intent.sourceSizeBytes === undefined || !bytes) {
    throw new AttachmentToolError(
      'ATTACHMENT_MUTATION_INVALID',
      'Attach and replace require one complete, byte-pinned source file.'
    );
  }
  return {
    kind: intent.kind,
    attachmentId: intent.attachmentId,
    memberId: intent.memberId,
    fileName: intent.fileName,
    content: bytes,
    createdAt: intent.createdAt,
  };
}

async function fingerprint(
  resolved: ResolvedSequencePackageHistory,
  intent: Intent
): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(JSON.stringify({
    schema: 'sequence-user-attachment-review.v1',
    workspaceRoot: resolved.workspaceRoot,
    packageRoot: resolved.index.packageRoot,
    documentId: intent.documentId,
    kind: intent.kind,
    attachmentId: intent.attachmentId,
    previousMemberId: intent.previousMemberId ?? null,
    previousSha256: intent.previousSha256 ?? null,
    memberId: intent.memberId ?? null,
    createdAt: intent.createdAt,
    sourcePath: intent.sourcePath ?? null,
    fileName: intent.fileName ?? null,
    sourceSha256: intent.sourceSha256 ?? null,
    sourceSizeBytes: intent.sourceSizeBytes ?? null,
    currentHeadId: intent.currentHeadId,
    expectedMarkerSha256: intent.expectedMarkerSha256,
    expectedProductSha256: intent.expectedProductSha256,
    operationId: intent.operationId,
  })));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

export function createPreviewSequenceUserAttachmentMutationTool(
  folders: WorkspaceFolder[],
  deps: SequenceUserAttachmentToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Preview attaching, replacing or detaching one user file in a saved managed sequence package. ' +
      'Read-only: returns exact current package and source pins, a stable operation identity, and ' +
      'a fingerprint for the separate Apply action. This preview is not a permission grant.',
    inputSchema: previewSequenceUserAttachmentMutationSchema,
    execute: async (input: PreviewSequenceUserAttachmentMutationInput) => {
      try {
        const documentId = normalizeSequenceDocumentId(input.documentId);
        const resolved = await resolvePackage(documentId, folders, deps);
        assertEditors(resolved.index, deps);
        const attachmentId = input.attachmentId ?? (input.kind === 'attach' ? deps.uuid() : '');
        if (!attachmentId) throw new AttachmentToolError(
          'ATTACHMENT_MUTATION_INVALID',
          'Replace and detach require an existing logical attachment ID.'
        );
        const previous = currentAttachment(resolved.index.document, input.kind, attachmentId);
        const baseline = await deps.captureBaseline(resolved.index);
        const source = input.kind === 'detach'
          ? null
          : input.sourcePath
            ? await readWorkspaceSource(folders, input.sourcePath, deps)
            : null;
        if (input.kind !== 'detach' && !source) throw new AttachmentToolError(
          'ATTACHMENT_MUTATION_INVALID', 'Attach and replace require a sourcePath.'
        );
        if (input.kind === 'detach' && input.sourcePath) throw new AttachmentToolError(
          'ATTACHMENT_MUTATION_INVALID', 'Detach must not include a sourcePath.'
        );
        const intent: Intent = {
          documentId,
          kind: input.kind,
          attachmentId,
          ...previous,
          ...(source ? {
            sourcePath: input.sourcePath,
            memberId: deps.uuid(),
            fileName: source.fileName,
            sourceSha256: source.sha256,
            sourceSizeBytes: source.sizeBytes,
          } : {}),
          createdAt: deps.now(),
          operationId: `user-attachment:${deps.uuid()}`,
          currentHeadId: resolved.index.document.versionHistory.headId!,
          expectedMarkerSha256: baseline.markerSha256,
          expectedProductSha256: baseline.productSha256,
        };
        await prepareSequenceUserAttachmentMutation(
          resolved.index.document,
          mutationFromIntent(intent, source?.bytes)
        );
        assertEditors(resolved.index, deps);
        const after = await deps.captureBaseline(resolved.index);
        if (after.markerSha256 !== baseline.markerSha256 ||
            after.productSha256 !== baseline.productSha256) {
          throw new AttachmentToolError(
            'ATTACHMENT_STALE_PREVIEW', 'The package changed while preparing this attachment. Preview again.'
          );
        }
        const previewFingerprint = await fingerprint(resolved, intent);
        const { sourcePath: _privateSourcePath, ...publicIntent } = intent;
        return toolSuccess({ ...publicIntent, previewFingerprint });
      } catch (error) {
        return classifyBeforePublication(error);
      }
    },
  });
}

export function createApplySequenceUserAttachmentMutationTool(
  folders: WorkspaceFolder[],
  deps: SequenceUserAttachmentToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Apply one explicitly approved attachment Preview as a new version of the same managed ' +
      'sequence package. Rechecks workspace authority, source bytes, current package baseline ' +
      'and the entire fingerprint. An exact retry reuses its operation ID and member identity.',
    inputSchema: applySequenceUserAttachmentMutationSchema,
    execute: async (input: ApplySequenceUserAttachmentMutationInput) => {
      let publicationAttempted = false;
      let priorOperationObserved = false;
      try {
        const documentId = normalizeSequenceDocumentId(input.documentId);
        const first = await resolvePackage(documentId, folders, deps);
        priorOperationObserved = hasPublishedOperation(first.index, input.operationId);
        assertEditors(first.index, deps);
        const receipt = await deps.withMutation(first.workspaceRoot, async (mutationToken) => {
          const resolved = await resolvePackage(documentId, folders, deps);
          priorOperationObserved ||= hasPublishedOperation(resolved.index, input.operationId);
          if (resolved.workspaceRoot !== first.workspaceRoot ||
              resolved.index.packageRoot !== first.index.packageRoot) {
            throw new AttachmentToolError(
              'ATTACHMENT_STALE_PREVIEW', 'The managed package moved after Preview. Preview again.'
            );
          }
          assertEditors(resolved.index, deps);
          const source = input.kind === 'detach'
            ? null
            : input.sourcePath
              ? await readWorkspaceSource(folders, input.sourcePath, deps)
              : null;
          if (input.kind !== 'detach' && !source) throw new AttachmentToolError(
            'ATTACHMENT_MUTATION_INVALID', 'Attach and replace require a sourcePath.'
          );
          if (source && (source.sha256 !== input.sourceSha256 ||
              source.sizeBytes !== input.sourceSizeBytes ||
              source.fileName !== input.fileName)) {
            throw new AttachmentToolError(
              'ATTACHMENT_SOURCE_CHANGED', 'The source file changed after Preview. Preview again.'
            );
          }
          const intent: Intent = {
            documentId,
            kind: input.kind,
            attachmentId: input.attachmentId,
            ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
            ...(input.memberId ? { memberId: input.memberId } : {}),
            ...(input.fileName ? { fileName: input.fileName } : {}),
            ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
            ...(input.sourceSizeBytes !== undefined
              ? { sourceSizeBytes: input.sourceSizeBytes } : {}),
            ...(input.previousMemberId ? { previousMemberId: input.previousMemberId } : {}),
            ...(input.previousSha256 ? { previousSha256: input.previousSha256 } : {}),
            createdAt: input.createdAt,
            operationId: input.operationId,
            currentHeadId: input.currentHeadId,
            expectedMarkerSha256: input.expectedMarkerSha256,
            expectedProductSha256: input.expectedProductSha256,
          };
          const mutation = mutationFromIntent(intent, source?.bytes);
          if ((await fingerprint(resolved, intent)) !== input.previewFingerprint) {
            throw new AttachmentToolError(
              'ATTACHMENT_REVIEW_MISMATCH', 'The Apply request differs from its reviewed Preview.'
            );
          }
          const baseline = await deps.captureBaseline(resolved.index);
          const unchanged = baseline.markerSha256 === intent.expectedMarkerSha256 &&
            baseline.productSha256 === intent.expectedProductSha256 &&
            resolved.index.document.versionHistory.headId === intent.currentHeadId;
          if (unchanged) {
            const previous = currentAttachment(
              resolved.index.document, intent.kind, intent.attachmentId
            );
            if (previous.previousMemberId !== intent.previousMemberId ||
                previous.previousSha256 !== intent.previousSha256) {
              throw new AttachmentToolError(
                'ATTACHMENT_STALE_PREVIEW', 'The attachment state changed after Preview.'
              );
            }
            await prepareSequenceUserAttachmentMutation(resolved.index.document, mutation);
          } else if (!hasPublishedOperation(resolved.index, intent.operationId)) {
            throw new AttachmentToolError(
              'ATTACHMENT_STALE_PREVIEW',
              'The package changed after Preview. Refresh History and preview again.'
            );
          }
          assertEditors(resolved.index, deps);
          publicationAttempted = true;
          return deps.publish({
            workspaceRoot: resolved.workspaceRoot,
            packageRoot: resolved.index.packageRoot,
            packageId: resolved.index.document.id,
            expectedMarkerSha256: intent.expectedMarkerSha256,
            expectedProductSha256: intent.expectedProductSha256,
            operationId: intent.operationId,
            mutation,
            mutationToken,
          });
        });
        return toolSuccess({
          documentId,
          kind: input.kind,
          attachmentId: input.attachmentId,
          revisionId: receipt.revisionId,
          alreadyPublished: receipt.alreadyPublished,
          sourceSha256: input.sourceSha256 ?? null,
          durableStage: 'package-revision-published',
        });
      } catch (error) {
        if (publicationAttempted) {
          return fail(
            'ATTACHMENT_OUTCOME_UNCONFIRMED',
            'The package publisher did not return a confirmed result. Inspect History, then retry only the identical reviewed request if its source bytes are still available.',
            'unknown'
          );
        }
        if (priorOperationObserved) {
          return fail(
            'ATTACHMENT_RETRY_UNVERIFIED',
            'History contains this operation, but the exact retry could not be verified. Inspect the saved version and retry only if the original source bytes are available.',
            'unknown'
          );
        }
        return classifyBeforePublication(error);
      }
    },
  });
}

function hasPublishedOperation(index: SequencePackageHistoryIndex, operationId: string): boolean {
  return index.document.versionHistory.revisions.some(
    (revision) => revision.operationId === operationId && revision.kind === 'member-update'
  );
}

async function captureCurrentBaseline(index: SequencePackageHistoryIndex): Promise<PackageBaseline> {
  const fs = platform().fs;
  const marker = await fs.readTextFile(index.markerPath);
  const raw = JSON.parse(marker) as { formatVersion?: unknown };
  if (raw.formatVersion !== index.document.formatVersion) {
    throw new AttachmentToolError(
      'ATTACHMENT_PACKAGE_UNAVAILABLE',
      'This package needs controlled migration before attachments can change.'
    );
  }
  const current = parseSequencePackageDocument(marker);
  if (current.id !== index.document.id || JSON.stringify(current) !== JSON.stringify(index.document)) {
    throw new AttachmentToolError(
      'ATTACHMENT_STALE_PREVIEW', 'The package changed since History loaded. Refresh and preview again.'
    );
  }
  const productSha256 = await fs.sha256File(index.productPath);
  const head = current.versionHistory.revisions.find(
    (revision) => revision.id === current.versionHistory.headId
  );
  if (!head || productSha256 !== head.productSnapshot.sha256) {
    throw new AttachmentToolError(
      'ATTACHMENT_PACKAGE_UNAVAILABLE',
      'The current sequence is not the verified saved version.'
    );
  }
  const markerSha256 = await sha256Bytes(new TextEncoder().encode(marker));
  if ((await fs.readTextFile(index.markerPath)) !== marker ||
      (await fs.sha256File(index.productPath)) !== productSha256) {
    throw new AttachmentToolError(
      'ATTACHMENT_STALE_PREVIEW', 'The package changed while being checked. Preview again.'
    );
  }
  return { markerSha256, productSha256 };
}

function assertPackageEditorsSettled(index: SequencePackageHistoryIndex): void {
  const sequenceTabIds = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
    panel.tabs.flatMap((tab) =>
      tab.type === 'sequence' &&
      ((tab.sequenceDocument?.kind === 'managed-sequence' &&
        tab.sequenceDocument.packageId === index.document.id) ||
        tab.entityId === index.document.id)
        ? [tab.entityId]
        : []
    )
  );
  const ids = [index.document.id, ...sequenceTabIds];
  assertWorkspaceEditorsSettled({ workspaceRoot: index.packageRoot, affectedEntityIds: ids });
  if (ids.some((id) => useSequenceStore.getState().isDirty(id))) {
    throw new Error('Save or discard current sequence edits before changing attachments.');
  }
}
