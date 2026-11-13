import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execTool } from './test-helpers';

import {
  createApplyManagedAnnotationOperationTool,
  createInspectManagedAnnotationOperationTool,
  managedAnnotationApplySchema,
  managedAnnotationInspectSchema,
} from './managed-annotation-operation';
import { callRendererTool } from '../../agent-bridge/renderer-bridge';

const FOLDERS: WorkspaceFolder[] = [{ path: '/workspace', name: 'Workspace', addedAt: 1 }];
const RESULT_SHA = `sha256:${'a'.repeat(64)}`;
const TARGET_REVISION = `annotation-document-v1:sha256:${'b'.repeat(64)}`;
const OPERATION_ID = 'operation-1';
const trustedContext = {
  schema: 'dnaforge.managed-annotation-authority.v1' as const,
  operation: {
    id: OPERATION_ID,
    kind: 'annotation',
    state: 'succeeded',
    result_status: 'available',
    version: 4,
    subject: {
      subject_id: 'sequence-1',
      scope_id: 'workspace-1',
      input_revision: `annotation-input-v1:sha256:${'c'.repeat(64)}`,
    },
  },
  resultSha256: RESULT_SHA,
  result: { sequence_length: 4, features: [] },
};

describe('managed annotation operation tools', () => {
  it('keeps strict public schemas free of result bytes and trusted authority', () => {
    expect(
      managedAnnotationInspectSchema.safeParse({
        operationId: OPERATION_ID,
        targetDocumentId: 'sequence-1',
      }).success
    ).toBe(true);
    expect(
      managedAnnotationInspectSchema.safeParse({
        operationId: OPERATION_ID,
        targetDocumentId: 'sequence-1',
        result: trustedContext.result,
      }).success
    ).toBe(false);
    expect(
      managedAnnotationApplySchema.safeParse({
        operationId: OPERATION_ID,
        targetDocumentId: 'sequence-1',
        expectedOperationVersion: 4,
        expectedResultSha256: RESULT_SHA,
        expectedTargetDocumentRevision: TARGET_REVISION,
        selectedCandidateIds: [`${OPERATION_ID}:0`],
      }).success
    ).toBe(true);
  });

  it('refuses direct renderer execution without side effects', async () => {
    const inspect = await execTool<Record<string, unknown>>(
      createInspectManagedAnnotationOperationTool(),
      { operationId: OPERATION_ID, targetDocumentId: 'sequence-1' }
    );
    const apply = await execTool<Record<string, unknown>>(
      createApplyManagedAnnotationOperationTool(),
      {
        operationId: OPERATION_ID,
        targetDocumentId: 'sequence-1',
        expectedOperationVersion: 4,
        expectedResultSha256: RESULT_SHA,
        expectedTargetDocumentRevision: TARGET_REVISION,
        selectedCandidateIds: [`${OPERATION_ID}:0`],
      }
    );

    for (const result of [inspect, apply]) {
      expect(result).toMatchObject({
        ok: false,
        code: 'NATIVE_DOCUMENT_OWNER_REQUIRED',
        retriable: false,
        stateChanged: false,
        partialEffects: [],
      });
    }
  });

  it.each([undefined, trustedContext])(
    'refuses the canonical renderer call with context %j',
    async (context) => {
      const response = await callRendererTool(
        {
          tool_name: 'operations.annotation.apply',
          args: {
            operationId: OPERATION_ID,
            targetDocumentId: 'sequence-1',
            expectedOperationVersion: 4,
            expectedResultSha256: RESULT_SHA,
            expectedTargetDocumentRevision: TARGET_REVISION,
            selectedCandidateIds: [`${OPERATION_ID}:0`],
          },
          agent_identity: 'agent-1',
          action_id: 'action-1',
        },
        {
          folders: FOLDERS,
          trustedContext: context,
          boundWorkspaceId: 'workspace-1',
          currentWorkspaceId: 'workspace-1',
          agentCapabilities: [
            'operations.read',
            'read-workspace',
            'read-sequences',
            'write-workspace',
          ],
          auditSink: { write: vi.fn().mockResolvedValue('audit-1') },
        }
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: 'NATIVE_DOCUMENT_OWNER_REQUIRED', retriable: false },
      });
    }
  );
});
