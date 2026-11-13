import { z } from 'zod';
import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';

const operationIdSchema = z.string().trim().min(1).max(256);
const targetDocumentIdSchema = z.string().trim().min(1).max(1024);
const resultShaSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const targetRevisionSchema = z.string().regex(/^annotation-document-v1:sha256:[a-f0-9]{64}$/);

export const managedAnnotationInspectSchema = z
  .object({
    operationId: operationIdSchema,
    targetDocumentId: targetDocumentIdSchema,
  })
  .strict();

export const managedAnnotationApplySchema = managedAnnotationInspectSchema
  .extend({
    expectedOperationVersion: z.number().int().min(1),
    expectedResultSha256: resultShaSchema,
    expectedTargetDocumentRevision: targetRevisionSchema,
    selectedCandidateIds: z.array(z.string().min(1).max(512)).min(1).max(10_000),
  })
  .strict();

export type ManagedAnnotationInspectToolInput = z.infer<typeof managedAnnotationInspectSchema>;
export type ManagedAnnotationApplyToolInput = z.infer<typeof managedAnnotationApplySchema>;

export function createInspectManagedAnnotationOperationTool() {
  return resultTool({
    description:
      'Inspect one retained annotation operation against an explicit current sequence document. ' +
      'The native document owner validates the authorized result and current document.',
    inputSchema: managedAnnotationInspectSchema,
    execute: async () => nativeOwnerRequired(),
  });
}

export function createApplyManagedAnnotationOperationTool() {
  return resultTool({
    description:
      'Apply selected candidates from one inspected retained annotation operation. The native ' +
      'document owner revalidates the reviewed result and document, saves and records the outcome.',
    inputSchema: managedAnnotationApplySchema,
    execute: async () => nativeOwnerRequired(),
  });
}

function nativeOwnerRequired() {
  return toolFailure({
    code: 'NATIVE_DOCUMENT_OWNER_REQUIRED',
    error: 'This command must use the managed operation service and its native document owner.',
    retriable: false,
    stateChanged: false,
    partialEffects: [],
  });
}
