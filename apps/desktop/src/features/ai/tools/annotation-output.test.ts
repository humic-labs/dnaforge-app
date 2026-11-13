import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { execTool } from './test-helpers';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  apply: vi.fn(),
}));

vi.mock('../../sequence/annotation-output-import', () => ({
  inspectAnnotationOutput: mocks.inspect,
  applyAnnotationOutput: mocks.apply,
}));

import {
  annotationOutputApplySchema,
  annotationOutputInspectSchema,
  createApplyAnnotationOutputTool as originalCreateApplyAnnotationOutputTool,
  createInspectAnnotationOutputTool as originalCreateInspectAnnotationOutputTool,
} from './annotation-output';
import { checkedSequenceToolFactory as checkedToolFactory } from '../../../test-utils/sequence-output-test-helper';
import {
  inspectAnnotationOutputOutputSchema,
  applyAnnotationOutputOutputSchema,
} from './operation-output-schemas';
const createInspectAnnotationOutputTool = checkedToolFactory(
  originalCreateInspectAnnotationOutputTool,
  inspectAnnotationOutputOutputSchema
);
const createApplyAnnotationOutputTool = checkedToolFactory(
  originalCreateApplyAnnotationOutputTool,
  applyAnnotationOutputOutputSchema
);

const FOLDERS: WorkspaceFolder[] = [{ path: '/workspace', name: 'Workspace', addedAt: 1 }];
const OUTPUT_SHA = `sha256:${'a'.repeat(64)}`;
const TARGET_REVISION = `annotation-document-v1:sha256:${'b'.repeat(64)}`;
const CANDIDATE_ID = `annotation-output:${'a'.repeat(64)}:0`;
const parse = vi.fn();

const inspectInput = {
  outputPath: 'runs/result.json',
  format: 'json' as const,
  targetDocumentId: 'sequence-1',
};

const applyInput = {
  ...inspectInput,
  expectedOutputSha256: OUTPUT_SHA,
  expectedTargetDocumentRevision: TARGET_REVISION,
  selectedCandidateIds: [CANDIDATE_ID],
};

describe('annotation output agent tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('admits only workspace-relative output paths and never exposes a native-file grant', () => {
    expect(annotationOutputInspectSchema.safeParse(inspectInput).success).toBe(true);
    expect(
      annotationOutputInspectSchema.safeParse({
        ...inspectInput,
        outputPath: '/outside/result.json',
      }).success
    ).toBe(false);
    expect(
      annotationOutputInspectSchema.safeParse({ ...inspectInput, outputPath: '../result.json' })
        .success
    ).toBe(false);
    expect(
      annotationOutputInspectSchema.safeParse({
        ...inspectInput,
        source: {
          kind: 'granted-file',
          absolutePath: '/outside/result.json',
          grantedFiles: ['/outside/result.json'],
        },
      }).success
    ).toBe(false);
  });

  it('inspects through the feature command with only the caller folders and relative source', async () => {
    mocks.inspect.mockResolvedValue({
      targetDocumentId: 'sequence-1',
      targetDocumentRevision: TARGET_REVISION,
      outputSha256: OUTPUT_SHA,
      analyzedInputRevision: null,
      result: { sequence_length: 8, features: [] },
      candidates: [],
    });

    const result = await execTool<Record<string, unknown>>(
      createInspectAnnotationOutputTool(FOLDERS, { parse }),
      inspectInput
    );

    expect(result).toMatchObject({
      ok: true,
      outputSha256: OUTPUT_SHA,
      targetDocumentRevision: TARGET_REVISION,
      analyzedInputRevision: null,
    });
    expect(mocks.inspect).toHaveBeenCalledWith(
      {
        source: { kind: 'workspace-relative', path: inspectInput.outputPath },
        format: 'json',
        targetDocumentId: 'sequence-1',
        folders: FOLDERS,
      },
      { parse }
    );
  });

  it.each([
    ['saved', { status: 'saved', targetDocumentRevision: TARGET_REVISION }],
    ['already-applied', { status: 'already-applied', targetDocumentRevision: TARGET_REVISION }],
  ])('reports %s as explicit success', async (_label, outcome) => {
    mocks.apply.mockResolvedValue(outcome);

    const result = await execTool<Record<string, unknown>>(
      createApplyAnnotationOutputTool(FOLDERS, { parse }),
      applyInput
    );

    expect(result).toEqual({ ok: true, ...outcome });
    expect(mocks.apply).toHaveBeenCalledWith(
      {
        source: { kind: 'workspace-relative', path: applyInput.outputPath },
        format: 'json',
        targetDocumentId: 'sequence-1',
        folders: FOLDERS,
        expectedOutputSha256: OUTPUT_SHA,
        expectedTargetDocumentRevision: TARGET_REVISION,
        selectedCandidateIds: [CANDIDATE_ID],
      },
      { parse }
    );
  });

  it('reports a failed required save with its safe retry revision and partial effect', async () => {
    const retryRevision = `annotation-document-v1:sha256:${'c'.repeat(64)}`;
    mocks.apply.mockResolvedValue({
      status: 'save-failed',
      reason: 'The imported annotations remain unsaved.',
      retryTargetDocumentRevision: retryRevision,
    });

    const result = await execTool<Record<string, unknown>>(
      createApplyAnnotationOutputTool(FOLDERS, { parse }),
      applyInput
    );

    expect(result).toEqual({
      ok: false,
      code: 'ANNOTATION_OUTPUT_SAVE_FAILED',
      error: 'The imported annotations remain unsaved.',
      retriable: true,
      stateChanged: true,
      partialEffects: [
        {
          kind: 'annotation-output-applied-unsaved',
          targetDocumentId: 'sequence-1',
          outputSha256: OUTPUT_SHA,
          selectedCandidateIds: [CANDIDATE_ID],
        },
      ],
      details: { retryTargetDocumentRevision: retryRevision },
    });
  });

  it('reports blocked and thrown Apply outcomes without claiming unchanged state', async () => {
    mocks.apply.mockResolvedValueOnce({ status: 'blocked', reason: 'Target changed.' });
    const blocked = await execTool<Record<string, unknown>>(
      createApplyAnnotationOutputTool(FOLDERS, { parse }),
      applyInput
    );
    expect(blocked).toMatchObject({
      ok: false,
      code: 'ANNOTATION_OUTPUT_APPLY_BLOCKED',
      stateChanged: 'unknown',
    });

    mocks.apply.mockRejectedValueOnce(new Error('post-write completion failed'));
    const failed = await execTool<Record<string, unknown>>(
      createApplyAnnotationOutputTool(FOLDERS, { parse }),
      applyInput
    );
    expect(failed).toMatchObject({
      ok: false,
      code: 'ANNOTATION_OUTPUT_APPLY_FAILED',
      stateChanged: 'unknown',
    });
  });
});
