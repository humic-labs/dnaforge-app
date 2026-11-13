import type { AnnotationFeature, AnnotationResult } from '@waypoint/api-client';
import {
  serializeSequenceForInPlaceSave,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';

import { platform } from '../../platform';
import {
  findContainingPathBoundary,
  isAbsolutePathLike,
  isSafeWorkspaceRelativePath,
  normalizePathForBoundary,
} from '../../shared/path-boundary';
import { SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { readStableWorkspaceGeneration } from '../../services/workspace-sync-renderer-generation';
import { assertWorkspaceEditorInputAllowed } from '../../services/workspace-editor-mutation-state';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { getUserFolders, resolveMultiRootPath } from '../workspace/public/path-resolve';
import {
  completeSequenceDocumentSave,
  saveSequenceDocumentWithCompletion,
} from './complete-sequence-document-save';
import { hasAnnotationResultShape } from './annotation-result';
import { createDraftAnnotations, draftsToCommittedAnnotations } from './annotation-review-utils';
import { parseSequenceFileAsDocument } from './parse-sequence-file';
import type { ResolvedSequenceDocument } from './sequence-document-repository';
import { resolveSequenceDocumentById } from './sequence-document-repository';
import { useSequenceStore, type SequenceSaveCapture } from './store';
import { annotationTargetDocumentRevision } from './annotation-target-document-revision';
export { annotationTargetDocumentRevision } from './annotation-target-document-revision';

const MAX_ANNOTATION_OUTPUT_BYTES = 16 * 1024 * 1024;
const OUTPUT_HASH_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/;

export type AnnotationOutputFormat = 'json' | 'gff3';

export type AnnotationOutputSource =
  | { kind: 'workspace-relative'; path: string }
  | {
      kind: 'granted-file';
      absolutePath: string;
      grantedFiles: readonly string[];
    };

export interface ParsedAnnotationOutput {
  output_sha256: string;
  result: AnnotationResult;
}

export type AnnotationOutputParser = (
  content: string,
  format: AnnotationOutputFormat
) => Promise<ParsedAnnotationOutput>;

export interface AnnotationOutputImportDependencies {
  parse: AnnotationOutputParser;
  parentActionId?: string;
}

export interface InspectAnnotationOutputInput {
  source: AnnotationOutputSource;
  format: AnnotationOutputFormat;
  targetDocumentId: string;
  folders: readonly WorkspaceFolder[];
}

export interface AnnotationOutputCandidate {
  id: string;
  index: number;
  feature: AnnotationFeature;
}

export interface AnnotationOutputInspection {
  targetDocumentId: string;
  targetDocumentRevision: string;
  outputSha256: string;
  analyzedInputRevision: null;
  result: AnnotationResult;
  candidates: readonly AnnotationOutputCandidate[];
}

export interface ApplyAnnotationOutputInput extends InspectAnnotationOutputInput {
  expectedOutputSha256: string;
  expectedTargetDocumentRevision: string;
  selectedCandidateIds: readonly string[];
}

export type AnnotationOutputApplyResult =
  | { status: 'saved' | 'already-applied'; targetDocumentRevision: string }
  | { status: 'blocked'; reason: string; targetDocumentRevision?: string }
  | { status: 'save-failed'; reason: string; retryTargetDocumentRevision: string };

export type AnnotationOutputImportErrorCode =
  | 'NO_WORKSPACE'
  | 'INVALID_OUTPUT_PATH'
  | 'OUTPUT_UNAVAILABLE'
  | 'OUTPUT_INVALID'
  | 'TARGET_OUTSIDE_WORKSPACE'
  | 'TARGET_UNAVAILABLE'
  | 'TARGET_NOT_WRITABLE';

export class AnnotationOutputImportError extends Error {
  constructor(
    readonly code: AnnotationOutputImportErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AnnotationOutputImportError';
  }
}

interface PreparedOutput {
  outputSha256: string;
  result: AnnotationResult;
  candidates: AnnotationOutputCandidate[];
}

interface PreparedTarget {
  document: ResolvedSequenceDocument;
  capture: SequenceSaveCapture;
  revision: string;
}

const activeApplies = new Map<string, Promise<AnnotationOutputApplyResult>>();

export async function inspectAnnotationOutput(
  input: InspectAnnotationOutputInput,
  dependencies: AnnotationOutputImportDependencies
): Promise<AnnotationOutputInspection> {
  const folders = requireUserFolders(input.folders);
  const output = await prepareOutput(input.source, input.format, folders, dependencies.parse);
  const target = await prepareTarget(input.targetDocumentId, folders);
  assertSequenceLengthMatches(output.result, target.capture.sequence);
  return {
    targetDocumentId: target.document.documentId,
    targetDocumentRevision: target.revision,
    outputSha256: output.outputSha256,
    analyzedInputRevision: null,
    result: output.result,
    candidates: output.candidates,
  };
}

export async function applyAnnotationOutput(
  input: ApplyAnnotationOutputInput,
  dependencies: AnnotationOutputImportDependencies
): Promise<AnnotationOutputApplyResult> {
  let authorizedFolders: WorkspaceFolder[];
  try {
    authorizedFolders = requireUserFolders(input.folders);
  } catch (error) {
    return { status: 'blocked', reason: importErrorMessage(error) };
  }
  const key = applyKey(input, authorizedFolders);
  const active = activeApplies.get(key);
  if (active) return active;

  const execution = applyAnnotationOutputOnce(input, dependencies);
  activeApplies.set(key, execution);
  try {
    return await execution;
  } finally {
    if (activeApplies.get(key) === execution) activeApplies.delete(key);
  }
}

async function applyAnnotationOutputOnce(
  input: ApplyAnnotationOutputInput,
  dependencies: AnnotationOutputImportDependencies
): Promise<AnnotationOutputApplyResult> {
  let folders: WorkspaceFolder[];
  let output: PreparedOutput;
  try {
    folders = requireUserFolders(input.folders);
    output = await prepareOutput(input.source, input.format, folders, dependencies.parse);
  } catch (error) {
    return { status: 'blocked', reason: importErrorMessage(error) };
  }
  if (output.outputSha256 !== normalizeSha256(input.expectedOutputSha256)) {
    return {
      status: 'blocked',
      reason: 'The annotation output changed after it was inspected. Inspect it again.',
    };
  }

  const selected = selectedCandidates(output.candidates, input.selectedCandidateIds);
  if (!selected.ok) return { status: 'blocked', reason: selected.reason };

  let target: PreparedTarget;
  try {
    target = await prepareTarget(input.targetDocumentId, folders);
    assertSequenceLengthMatches(output.result, target.capture.sequence);
  } catch (error) {
    return { status: 'blocked', reason: importErrorMessage(error) };
  }

  const savedSequence = useSequenceStore.getState().savedSequences[target.document.documentId];
  if (
    savedSequence &&
    selected.candidates.every((candidate) =>
      hasImportedCandidate(savedSequence.annotations, output.outputSha256, candidate.id)
    )
  ) {
    return { status: 'already-applied', targetDocumentRevision: target.revision };
  }

  if (target.revision !== input.expectedTargetDocumentRevision) {
    return {
      status: 'blocked',
      reason: 'The target document changed after the annotation output was inspected.',
      targetDocumentRevision: target.revision,
    };
  }
  if (
    useSequenceStore.getState().getVersion(target.document.documentId) !== target.capture.revision
  ) {
    return {
      status: 'blocked',
      reason: 'The target document changed while the annotation import was being checked.',
    };
  }

  try {
    assertWorkspaceEditorInputAllowed(target.document.documentId);
  } catch (error) {
    return { status: 'blocked', reason: importErrorMessage(error) };
  }
  const current = target.capture.sequence;
  const additions = committedCandidates(
    selected.candidates.filter(
      (candidate) => !hasImportedCandidate(current.annotations, output.outputSha256, candidate.id)
    ),
    output.result,
    current,
    output.outputSha256,
    input.format
  );
  if (additions.length > 0) {
    useSequenceStore.getState().mergeAnnotations(target.document.documentId, additions);
  }
  const requiredCapture = useSequenceStore.getState().captureForSave(target.document.documentId);
  if (!requiredCapture) {
    return {
      status: 'blocked',
      reason: 'The target document changed before its imported annotations could be captured.',
    };
  }
  const postMergeRevision = await annotationTargetDocumentRevision(requiredCapture.sequence);

  const { persistence, publication } = await saveSequenceDocumentWithCompletion({
    kind: 'annotation-apply',
    document: target.document,
    requiredCapture,
    observation: { kind: 'annotation', parentActionId: dependencies.parentActionId },
    complete: () =>
      completeSequenceDocumentSave(
        { documentId: target.document.documentId, sourcePath: target.document.sourcePath },
        'Apply imported annotations'
      ),
  });
  if (!(persistence.ok && persistence.outcome === 'saved' && persistence.wrote)) {
    const retryCapture = useSequenceStore.getState().captureForSave(target.document.documentId);
    if (
      !retryCapture ||
      retryCapture.revision !== requiredCapture.revision ||
      (await annotationTargetDocumentRevision(retryCapture.sequence)) !== postMergeRevision
    ) {
      return {
        status: 'blocked',
        reason: 'The target document changed while its imported annotations were being saved.',
      };
    }
    return {
      status: 'save-failed',
      reason: 'The imported annotations remain in the unsaved document. Apply again to retry.',
      retryTargetDocumentRevision: postMergeRevision,
    };
  }

  if (publication.status === 'projection-failed' || publication.status === 'unconfirmed')
    throw publication.error;
  return { status: 'saved', targetDocumentRevision: postMergeRevision };
}

function applyKey(
  input: ApplyAnnotationOutputInput,
  authorizedFolders: readonly WorkspaceFolder[]
): string {
  return JSON.stringify([
    input.targetDocumentId,
    input.format,
    input.source.kind,
    input.source.kind === 'workspace-relative' ? input.source.path : input.source.absolutePath,
    input.expectedOutputSha256,
    input.expectedTargetDocumentRevision,
    [...input.selectedCandidateIds].sort(),
    authorizedFolders.map((folder) => normalizePathForBoundary(folder.path)),
    input.source.kind === 'granted-file'
      ? input.source.grantedFiles.map((path) => normalizePathForBoundary(path)).sort()
      : [],
  ]);
}

function requireUserFolders(folders: readonly WorkspaceFolder[]): WorkspaceFolder[] {
  const userFolders = getUserFolders([...folders]);
  if (userFolders.length === 0) {
    throw new AnnotationOutputImportError(
      'NO_WORKSPACE',
      'A writable mounted workspace is required to import annotation output.'
    );
  }
  return userFolders;
}

async function prepareOutput(
  source: AnnotationOutputSource,
  format: AnnotationOutputFormat,
  folders: WorkspaceFolder[],
  parse: AnnotationOutputParser
): Promise<PreparedOutput> {
  const absolutePath = resolveOutputPath(source, folders);
  let content: string;
  try {
    content = await platform().fs.readAdmittedTextFile({
      path: absolutePath,
      projectRoots: folders.map((folder) => folder.path),
      grantedFiles: source.kind === 'granted-file' ? [...source.grantedFiles] : [],
      maxBytes: MAX_ANNOTATION_OUTPUT_BYTES,
    });
  } catch (error) {
    throw new AnnotationOutputImportError(
      'OUTPUT_UNAVAILABLE',
      'The annotation output could not be read through its granted file authority.',
      error
    );
  }

  const localHash = await sha256Text(content);
  let parsed: ParsedAnnotationOutput;
  try {
    parsed = await parse(content, format);
  } catch (error) {
    throw new AnnotationOutputImportError(
      'OUTPUT_INVALID',
      'The file does not contain valid annotation output.',
      error
    );
  }
  if (
    !hasAnnotationResultShape(parsed.result) ||
    parsed.result.error ||
    normalizeSha256(parsed.output_sha256) !== localHash
  ) {
    throw new AnnotationOutputImportError(
      'OUTPUT_INVALID',
      'The parsed annotation result did not match the exact imported file content.'
    );
  }
  const digest = localHash.slice('sha256:'.length);
  return {
    outputSha256: localHash,
    result: parsed.result,
    candidates: parsed.result.features.map((feature, index) => ({
      id: `annotation-output:${digest}:${index}`,
      index,
      feature,
    })),
  };
}

function resolveOutputPath(source: AnnotationOutputSource, folders: WorkspaceFolder[]): string {
  if (source.kind === 'workspace-relative') {
    if (!isSafeWorkspaceRelativePath(source.path)) {
      throw new AnnotationOutputImportError(
        'INVALID_OUTPUT_PATH',
        'Agent annotation output paths must be relative to the mounted workspace.'
      );
    }
    return resolveMultiRootPath(folders, source.path).absolutePath;
  }
  if (
    !isAbsolutePathLike(source.absolutePath) ||
    source.grantedFiles.length !== 1 ||
    normalizePathForBoundary(source.grantedFiles[0] ?? '') !==
      normalizePathForBoundary(source.absolutePath)
  ) {
    throw new AnnotationOutputImportError(
      'INVALID_OUTPUT_PATH',
      'A selected annotation output requires one exact native file grant.'
    );
  }
  return source.absolutePath;
}

async function prepareTarget(
  targetDocumentId: string,
  folders: WorkspaceFolder[]
): Promise<PreparedTarget> {
  let document: ResolvedSequenceDocument;
  try {
    document = await resolveSequenceDocumentById(
      targetDocumentId,
      folders.map((folder) => folder.path)
    );
  } catch (error) {
    throw new AnnotationOutputImportError(
      'TARGET_UNAVAILABLE',
      'The target sequence document could not be resolved.',
      error
    );
  }
  const containingFolder = findContainingPathBoundary(folders, document.sourcePath);
  if (!containingFolder) {
    throw new AnnotationOutputImportError(
      'TARGET_OUTSIDE_WORKSPACE',
      'The target sequence document is outside the writable mounted workspace.'
    );
  }

  const store = useSequenceStore.getState();
  if (!store.getSequence(document.documentId)) {
    try {
      const file = await platform().fs.stat(document.sourcePath);
      if (!file.isFile || file.size >= SOFT_WARN_BYTES) {
        throw new Error('The target requires the existing large-file workflow.');
      }
      const content = await readStableWorkspaceGeneration(containingFolder.path, () =>
        platform().fs.readAdmittedTextFile({
          path: document.sourcePath,
          projectRoots: folders.map((folder) => folder.path),
          grantedFiles: [],
        })
      );
      const parsed = parseSequenceFileAsDocument(content, document.sourcePath);
      if (!useSequenceStore.getState().getSequence(document.documentId)) {
        useSequenceStore.getState().setSequence(document.documentId, parsed.sequence);
      }
    } catch (error) {
      throw new AnnotationOutputImportError(
        'TARGET_UNAVAILABLE',
        'The target sequence document could not be loaded.',
        error
      );
    }
  }

  const capture = useSequenceStore.getState().captureForSave(document.documentId);
  if (!capture) {
    throw new AnnotationOutputImportError(
      'TARGET_UNAVAILABLE',
      'The target sequence document has no current editable revision.'
    );
  }
  if (capture.pendingPrimerBindings.length > 0) {
    throw new AnnotationOutputImportError(
      'TARGET_NOT_WRITABLE',
      'Save or discard pending primer bindings before importing annotations.'
    );
  }
  try {
    serializeSequenceForInPlaceSave(capture.sequence, document.sourcePath);
  } catch (error) {
    throw new AnnotationOutputImportError(
      'TARGET_NOT_WRITABLE',
      'The target format cannot preserve imported annotations in place.',
      error
    );
  }
  return {
    document,
    capture,
    revision: await annotationTargetDocumentRevision(capture.sequence),
  };
}

function selectedCandidates(
  candidates: readonly AnnotationOutputCandidate[],
  selectedIds: readonly string[]
): { ok: true; candidates: AnnotationOutputCandidate[] } | { ok: false; reason: string } {
  const unique = new Set(selectedIds);
  if (unique.size === 0) {
    return { ok: false, reason: 'Select at least one annotation candidate to apply.' };
  }
  if (unique.size !== selectedIds.length) {
    return { ok: false, reason: 'Selected annotation candidate IDs must be unique.' };
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected: AnnotationOutputCandidate[] = [];
  for (const id of unique) {
    const candidate = byId.get(id);
    if (!candidate) {
      return {
        ok: false,
        reason: 'A selected annotation candidate is not present in the inspected output.',
      };
    }
    selected.push(candidate);
  }
  return { ok: true, candidates: selected };
}

function committedCandidates(
  candidates: readonly AnnotationOutputCandidate[],
  result: AnnotationResult,
  target: AnnotatedSequence,
  outputSha256: string,
  format: AnnotationOutputFormat
): Annotation[] {
  const existing = target.annotations.map(({ name, type, start, end }) => ({
    name,
    type,
    start,
    end,
  }));
  const drafts = createDraftAnnotations(result.features, existing);
  return candidates.map((candidate) => {
    const draft = drafts[candidate.index];
    if (!draft) throw new Error('The selected annotation candidate could not be materialized.');
    const annotation = draftsToCommittedAnnotations(
      [{ ...draft, id: candidate.id, accepted: true }],
      target.sequence.length
    )[0];
    return {
      ...annotation,
      qualifiers: {
        ...annotation.qualifiers,
        dnaforge_annotation_output_sha256: [outputSha256],
        dnaforge_annotation_candidate_id: [candidate.id],
        dnaforge_annotation_import_format: [format],
      },
    };
  });
}

function hasImportedCandidate(
  annotations: readonly Annotation[],
  outputSha256: string,
  candidateId: string
): boolean {
  return annotations.some(
    (annotation) =>
      annotation.qualifiers?.dnaforge_annotation_output_sha256?.includes(outputSha256) &&
      annotation.qualifiers?.dnaforge_annotation_candidate_id?.includes(candidateId)
  );
}

function assertSequenceLengthMatches(result: AnnotationResult, target: AnnotatedSequence): void {
  if (result.sequence_length !== target.sequence.length) {
    throw new AnnotationOutputImportError(
      'OUTPUT_INVALID',
      'The annotation output sequence length does not match the selected target document.'
    );
  }
}

function normalizeSha256(value: string): string {
  const match = OUTPUT_HASH_PATTERN.exec(value);
  return match ? `sha256:${match[1]}` : '';
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

function importErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The annotation output import was refused.';
}
