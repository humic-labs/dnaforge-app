import { z } from 'zod';

import { isSafeWorkspaceRelativePath } from '../../../shared/path-boundary';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { parseAnnotationOutputFile } from '../../sequence/public/annotation-output-client';
import {
  applyAnnotationOutput,
  inspectAnnotationOutput,
  type AnnotationOutputImportDependencies,
} from '../../sequence/public/annotation-output-import';

const outputPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(isSafeWorkspaceRelativePath, 'outputPath must be relative to the mounted workspace.');
const formatSchema = z.enum(['json', 'gff3']);
const targetDocumentIdSchema = z.string().min(1).max(500);
const outputHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const targetRevisionSchema = z.string().regex(/^annotation-document-v1:sha256:[a-f0-9]{64}$/);
const candidateIdSchema = z.string().regex(/^annotation-output:[a-f0-9]{64}:\d+$/);

export const annotationOutputInspectSchema = z
  .object({
    outputPath: outputPathSchema.describe(
      'Workspace-relative path to ordinary dnaforge-annotate JSON or GFF3 output.'
    ),
    format: formatSchema,
    targetDocumentId: targetDocumentIdSchema,
  })
  .strict();

export const annotationOutputApplySchema = annotationOutputInspectSchema
  .extend({
    expectedOutputSha256: outputHashSchema,
    expectedTargetDocumentRevision: targetRevisionSchema,
    selectedCandidateIds: z.array(candidateIdSchema).min(1).max(10_000),
  })
  .strict();

export type AnnotationOutputInspectToolInput = z.infer<typeof annotationOutputInspectSchema>;
export type AnnotationOutputApplyToolInput = z.infer<typeof annotationOutputApplySchema>;

const defaultDependencies: AnnotationOutputImportDependencies = {
  parse: parseAnnotationOutputFile,
};

export function createInspectAnnotationOutputTool(
  folders: WorkspaceFolder[],
  dependencies: AnnotationOutputImportDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Inspect ordinary dnaforge-annotate JSON or GFF3 output from the mounted workspace ' +
      'against one explicit sequence document. Returns stable candidate IDs, the exact output ' +
      'hash, and the current full-document revision required by apply_annotation_output.',
    inputSchema: annotationOutputInspectSchema,
    execute: async (input: AnnotationOutputInspectToolInput) => {
      try {
        const inspection = await inspectAnnotationOutput(
          {
            source: { kind: 'workspace-relative', path: input.outputPath },
            format: input.format,
            targetDocumentId: input.targetDocumentId,
            folders,
          },
          dependencies
        );
        return toolSuccess({ ...inspection });
      } catch (error) {
        return toolFailure({
          code: 'ANNOTATION_OUTPUT_INSPECT_FAILED',
          error: describeError(error, 'The annotation output could not be inspected.'),
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}

export function createApplyAnnotationOutputTool(
  folders: WorkspaceFolder[],
  dependencies: AnnotationOutputImportDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Apply explicitly selected candidates from previously inspected annotation output to one ' +
      'sequence document. Requires the exact inspected output hash and full target-document ' +
      'revision, then performs the same native save and post-save actions as a manual save.',
    inputSchema: annotationOutputApplySchema,
    execute: async (input: AnnotationOutputApplyToolInput) => {
      try {
        const outcome = await applyAnnotationOutput(
          {
            source: { kind: 'workspace-relative', path: input.outputPath },
            format: input.format,
            targetDocumentId: input.targetDocumentId,
            folders,
            expectedOutputSha256: input.expectedOutputSha256,
            expectedTargetDocumentRevision: input.expectedTargetDocumentRevision,
            selectedCandidateIds: input.selectedCandidateIds,
          },
          dependencies
        );
        if (outcome.status === 'saved' || outcome.status === 'already-applied') {
          return toolSuccess({ ...outcome });
        }
        if (outcome.status === 'save-failed') {
          return toolFailure({
            code: 'ANNOTATION_OUTPUT_SAVE_FAILED',
            error: outcome.reason,
            retriable: true,
            stateChanged: true,
            partialEffects: [
              {
                kind: 'annotation-output-applied-unsaved',
                targetDocumentId: input.targetDocumentId,
                outputSha256: input.expectedOutputSha256,
                selectedCandidateIds: input.selectedCandidateIds,
              },
            ],
            details: { retryTargetDocumentRevision: outcome.retryTargetDocumentRevision },
          });
        }
        if (outcome.status === 'blocked') {
          return toolFailure({
            code: 'ANNOTATION_OUTPUT_APPLY_BLOCKED',
            error: outcome.reason,
            retriable: true,
            stateChanged: 'unknown',
            partialEffects: [],
            ...(outcome.targetDocumentRevision
              ? { details: { targetDocumentRevision: outcome.targetDocumentRevision } }
              : {}),
          });
        }
        throw new Error('Annotation output Apply returned an unknown status.');
      } catch (error) {
        return toolFailure({
          code: 'ANNOTATION_OUTPUT_APPLY_FAILED',
          error: describeError(error, 'The annotation output could not be applied.'),
          retriable: true,
          stateChanged: 'unknown',
          partialEffects: [],
        });
      }
    },
  });
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
