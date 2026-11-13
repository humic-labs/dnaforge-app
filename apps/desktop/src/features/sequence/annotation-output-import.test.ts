import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseGenBankFull,
  serializeSequenceForInPlaceSave,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import type { AnnotationResult } from '@waypoint/api-client';

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  readAdmittedTextFile: vi.fn(),
  saveSequenceDocument: vi.fn(),
  writeTextFile: vi.fn(),
  resolveSequenceDocumentById: vi.fn(),
  completeSequenceDocumentSave: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      exists: vi.fn().mockResolvedValue(false),
      stat: mocks.stat,
      readAdmittedTextFile: mocks.readAdmittedTextFile,
      saveSequenceDocument: mocks.saveSequenceDocument,
      writeTextFile: mocks.writeTextFile,
    },
  }),
}));

vi.mock('./sequence-document-repository', () => ({
  resolveSequenceDocumentById: mocks.resolveSequenceDocumentById,
}));

vi.mock('../../services/workspace-sync-renderer-generation', () => ({
  readStableWorkspaceGeneration: async <T>(_root: string, read: () => Promise<T>) => read(),
}));

vi.mock('./complete-sequence-document-save', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./complete-sequence-document-save')>()),
  completeSequenceDocumentSave: mocks.completeSequenceDocumentSave,
}));

import type { WorkspaceFolder } from '../../stores/workspaceStore';
import {
  annotationTargetDocumentRevision,
  applyAnnotationOutput,
  inspectAnnotationOutput,
  type AnnotationOutputParser,
} from './annotation-output-import';
import { useSequenceStore } from './store';
import { freezeWorkspaceEditorWrites } from '../../services/workspace-editor-mutation-state';

const WORKSPACE = '/workspace';
const OUTPUT_PATH = `${WORKSPACE}/runs/annotations.json`;
const TARGET_PATH = `${WORKSPACE}/sequences/target.gb`;
const TARGET_ID = 'target-document';
const FOLDERS: WorkspaceFolder[] = [
  { path: WORKSPACE, name: 'Workspace', addedAt: 1 },
  { path: '/reference-cache', name: 'References', addedAt: 1, pinned: true },
];
const OUTPUT_CONTENT = '{"ordinary":"annotation-output"}';

function sequence(annotations: AnnotatedSequence['annotations'] = []): AnnotatedSequence {
  return {
    id: TARGET_ID,
    name: 'Target',
    sequence: 'ATGCATGC',
    length: 8,
    circular: false,
    annotations,
    metadata: { sequenceDocument: { format: 'genbank' } },
  };
}

const RESULT: AnnotationResult = {
  sequence_length: 8,
  features: [
    {
      name: 'First',
      type: 'promoter',
      start: 1,
      end: 3,
      strand: 1,
      identity: 99,
      coverage: 100,
      fragment: false,
      ref_start: 1,
      ref_end: 3,
      ref_length: 3,
      db_source: 'nucleotide',
    },
    {
      name: 'Second',
      type: 'misc_feature',
      start: 5,
      end: 8,
      strand: -1,
      identity: 95,
      coverage: 90,
      fragment: false,
      ref_start: 1,
      ref_end: 4,
      ref_length: 4,
      db_source: 'protein',
    },
  ],
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parser(result: AnnotationResult = RESULT): AnnotationOutputParser {
  return vi.fn(async (content) => ({ output_sha256: await sha256Hex(content), result }));
}

function source() {
  return { kind: 'workspace-relative' as const, path: 'runs/annotations.json' };
}

function readFixture(path: string): string {
  if (path === OUTPUT_PATH) return OUTPUT_CONTENT;
  if (path === TARGET_PATH) return serializeSequenceForInPlaceSave(sequence(), TARGET_PATH);
  throw new Error(`Unexpected read: ${path}`);
}

describe('receipt-free annotation output import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSequenceStore.getState().clearAll();
    mocks.resolveSequenceDocumentById.mockResolvedValue({
      ref: { kind: 'catalog-sequence', entityId: TARGET_ID },
      documentId: TARGET_ID,
      sourcePath: TARGET_PATH,
    });
    mocks.stat.mockResolvedValue({ isFile: true, size: 1024 });
    mocks.readAdmittedTextFile.mockImplementation(async ({ path }: { path: string }) =>
      readFixture(path)
    );
    mocks.saveSequenceDocument.mockResolvedValue({ status: 'unbound' });
    mocks.writeTextFile.mockResolvedValue(undefined);
    mocks.completeSequenceDocumentSave.mockResolvedValue({ status: 'not-a-repository' });
  });

  it('inspects a workspace-relative output and a closed target through explicit roots', async () => {
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse: parser() }
    );

    expect(inspected).toMatchObject({
      targetDocumentId: TARGET_ID,
      analyzedInputRevision: null,
      outputSha256: `sha256:${await sha256Hex(OUTPUT_CONTENT)}`,
      result: RESULT,
    });
    expect(inspected.targetDocumentRevision).toMatch(
      /^annotation-document-v1:sha256:[a-f0-9]{64}$/
    );
    expect(inspected.candidates.map((candidate) => candidate.id)).toEqual([
      `annotation-output:${await sha256Hex(OUTPUT_CONTENT)}:0`,
      `annotation-output:${await sha256Hex(OUTPUT_CONTENT)}:1`,
    ]);
    expect(mocks.readAdmittedTextFile).toHaveBeenCalledWith({
      path: OUTPUT_PATH,
      projectRoots: [WORKSPACE],
      grantedFiles: [],
      maxBytes: 16 * 1024 * 1024,
    });
    expect(mocks.readAdmittedTextFile).toHaveBeenCalledWith({
      path: TARGET_PATH,
      projectRoots: [WORKSPACE],
      grantedFiles: [],
    });
  });

  it('accepts one exact human-selected output grant without widening the target roots', async () => {
    const selectedPath = '/outside ordinary folder/result.gff3';
    mocks.stat.mockImplementation(async (path: string) => {
      if (path === selectedPath) throw new Error(`Path access denied: ${path}`);
      return { isFile: true, size: 1024 };
    });
    mocks.readAdmittedTextFile.mockImplementation(async ({ path }: { path: string }) =>
      path === selectedPath ? OUTPUT_CONTENT : readFixture(path)
    );

    await inspectAnnotationOutput(
      {
        source: {
          kind: 'granted-file',
          absolutePath: selectedPath,
          grantedFiles: [selectedPath],
        },
        format: 'gff3',
        targetDocumentId: TARGET_ID,
        folders: FOLDERS,
      },
      { parse: parser() }
    );

    expect(mocks.readAdmittedTextFile).toHaveBeenCalledWith({
      path: selectedPath,
      projectRoots: [WORKSPACE],
      grantedFiles: [selectedPath],
      maxBytes: 16 * 1024 * 1024,
    });
    expect(mocks.stat).not.toHaveBeenCalledWith(selectedPath);
  });

  it('rejects empty roots, absolute and traversing agent paths, and catalog fallback outside roots', async () => {
    const parse = parser();
    await expect(
      inspectAnnotationOutput(
        { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: [] },
        { parse }
      )
    ).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
    await expect(
      inspectAnnotationOutput(
        {
          source: { kind: 'workspace-relative', path: OUTPUT_PATH },
          format: 'json',
          targetDocumentId: TARGET_ID,
          folders: FOLDERS,
        },
        { parse }
      )
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT_PATH' });
    await expect(
      inspectAnnotationOutput(
        {
          source: { kind: 'workspace-relative', path: '../annotations.json' },
          format: 'json',
          targetDocumentId: TARGET_ID,
          folders: FOLDERS,
        },
        { parse }
      )
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT_PATH' });

    mocks.resolveSequenceDocumentById.mockResolvedValueOnce({
      ref: { kind: 'catalog-sequence', entityId: TARGET_ID },
      documentId: TARGET_ID,
      sourcePath: '/other-workspace/target.gb',
    });
    await expect(
      inspectAnnotationOutput(
        { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
        { parse }
      )
    ).rejects.toMatchObject({ code: 'TARGET_OUTSIDE_WORKSPACE' });
    expect(useSequenceStore.getState().getSequence(TARGET_ID)).toBeNull();
  });

  it('blocks Apply when the inspected output content or full target document changes', async () => {
    const parse = parser();
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse }
    );
    mocks.readAdmittedTextFile.mockImplementation(async ({ path }: { path: string }) =>
      path === OUTPUT_PATH ? '{"changed":true}' : readFixture(path)
    );

    await expect(
      applyAnnotationOutput(
        {
          source: source(),
          format: 'json',
          targetDocumentId: TARGET_ID,
          folders: FOLDERS,
          expectedOutputSha256: inspected.outputSha256,
          expectedTargetDocumentRevision: inspected.targetDocumentRevision,
          selectedCandidateIds: [inspected.candidates[0].id],
        },
        { parse }
      )
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/output changed/i),
    });
    expect(mocks.writeTextFile).not.toHaveBeenCalled();

    mocks.readAdmittedTextFile.mockImplementation(async ({ path }: { path: string }) =>
      readFixture(path)
    );
    useSequenceStore.getState().addAnnotation(TARGET_ID, {
      name: 'Unrelated edit',
      type: 'misc_feature',
      start: 2,
      end: 2,
      direction: 1,
    });
    await expect(
      applyAnnotationOutput(
        {
          source: source(),
          format: 'json',
          targetDocumentId: TARGET_ID,
          folders: FOLDERS,
          expectedOutputSha256: inspected.outputSha256,
          expectedTargetDocumentRevision: inspected.targetDocumentRevision,
          selectedCandidateIds: [inspected.candidates[0].id],
        },
        { parse }
      )
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/target document changed/i),
    });
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('keeps the same full document revision across the writer LOCUS date rollover', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 9, 23, 59, 59));
      const beforeMidnight = await annotationTargetDocumentRevision(sequence());
      const serializedBeforeMidnight = serializeSequenceForInPlaceSave(sequence(), TARGET_PATH);

      vi.setSystemTime(new Date(2026, 8, 10, 0, 0, 1));
      const afterMidnight = await annotationTargetDocumentRevision(sequence());
      const serializedAfterMidnight = serializeSequenceForInPlaceSave(sequence(), TARGET_PATH);

      expect(afterMidnight).toBe(beforeMidnight);
      expect(serializedAfterMidnight).not.toBe(serializedBeforeMidnight);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies only chosen candidates to a closed document and completes the native save', async () => {
    const parse = parser();
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse }
    );
    useSequenceStore.getState().clearAll();

    const applied = await applyAnnotationOutput(
      {
        source: source(),
        format: 'json',
        targetDocumentId: TARGET_ID,
        folders: FOLDERS,
        expectedOutputSha256: inspected.outputSha256,
        expectedTargetDocumentRevision: inspected.targetDocumentRevision,
        selectedCandidateIds: [inspected.candidates[1].id],
      },
      { parse }
    );

    expect(applied).toMatchObject({ status: 'saved' });
    expect(mocks.writeTextFile).toHaveBeenCalledOnce();
    const reparsed = parseGenBankFull(mocks.writeTextFile.mock.calls[0][1]);
    expect(reparsed.annotations.map((annotation) => annotation.name)).toEqual(['Second']);
    expect(reparsed.annotations[0].qualifiers).toMatchObject({
      dnaforge_annotation_output_sha256: [inspected.outputSha256],
      dnaforge_annotation_candidate_id: [inspected.candidates[1].id],
      dnaforge_annotation_import_format: ['json'],
    });
    expect(reparsed.annotations[0].qualifiers).not.toHaveProperty('dnaforge_operation_id');
    expect(reparsed.annotations[0].qualifiers).not.toHaveProperty('dnaforge_input_revision');
    expect(mocks.completeSequenceDocumentSave).toHaveBeenCalledWith(
      { documentId: TARGET_ID, sourcePath: TARGET_PATH },
      'Apply imported annotations'
    );
  });
  it('returns a structured refusal when a native mutation freezes the import target', async () => {
    const parse = parser();
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse }
    );
    const release = freezeWorkspaceEditorWrites({
      workspaceRoot: WORKSPACE,
      affectedEntityIds: [TARGET_ID],
    });
    try {
      await expect(
        applyAnnotationOutput(
          {
            source: source(),
            format: 'json',
            targetDocumentId: TARGET_ID,
            folders: FOLDERS,
            expectedOutputSha256: inspected.outputSha256,
            expectedTargetDocumentRevision: inspected.targetDocumentRevision,
            selectedCandidateIds: [inspected.candidates[0].id],
          },
          { parse }
        )
      ).resolves.toMatchObject({
        status: 'blocked',
        reason: expect.stringMatching(/workspace update/),
      });
      expect(useSequenceStore.getState().getSequence(TARGET_ID)?.annotations).toEqual([]);
      expect(mocks.writeTextFile).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('returns an exact post-merge retry revision and retries a failed save without duplicates', async () => {
    const parse = parser();
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse }
    );
    mocks.writeTextFile.mockRejectedValueOnce(new Error('disk refused write'));
    const input = {
      source: source(),
      format: 'json' as const,
      targetDocumentId: TARGET_ID,
      folders: FOLDERS,
      expectedOutputSha256: inspected.outputSha256,
      expectedTargetDocumentRevision: inspected.targetDocumentRevision,
      selectedCandidateIds: [inspected.candidates[0].id],
    };

    const failed = await applyAnnotationOutput(input, { parse });
    expect(mocks.completeSequenceDocumentSave).not.toHaveBeenCalled();
    expect(failed).toMatchObject({
      status: 'save-failed',
      retryTargetDocumentRevision: expect.stringMatching(
        /^annotation-document-v1:sha256:[a-f0-9]{64}$/
      ),
    });
    if (failed.status !== 'save-failed') throw new Error('Expected a retryable save failure.');
    expect(useSequenceStore.getState().getSequence(TARGET_ID)?.annotations).toHaveLength(1);

    const retried = await applyAnnotationOutput(
      { ...input, expectedTargetDocumentRevision: failed.retryTargetDocumentRevision },
      { parse }
    );
    expect(retried.status).toBe('saved');
    expect(mocks.completeSequenceDocumentSave).toHaveBeenCalledOnce();
    expect(useSequenceStore.getState().getSequence(TARGET_ID)?.annotations).toHaveLength(1);
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent identical Apply calls into one write and one annotation', async () => {
    const parse = parser();
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse }
    );
    let finishWrite: (() => void) | undefined;
    mocks.writeTextFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    const input = {
      source: source(),
      format: 'json' as const,
      targetDocumentId: TARGET_ID,
      folders: FOLDERS,
      expectedOutputSha256: inspected.outputSha256,
      expectedTargetDocumentRevision: inspected.targetDocumentRevision,
      selectedCandidateIds: [inspected.candidates[0].id],
    };

    const first = applyAnnotationOutput(input, { parse });
    const second = applyAnnotationOutput(input, { parse });
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    finishWrite?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'saved' }),
      expect.objectContaining({ status: 'saved' }),
    ]);
    expect(mocks.writeTextFile).toHaveBeenCalledOnce();
    expect(useSequenceStore.getState().getSequence(TARGET_ID)?.annotations).toHaveLength(1);
  });

  it('refuses an unauthorized concurrent caller before it can join an admitted Apply', async () => {
    const parse = parser();
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse }
    );
    let finishWrite: (() => void) | undefined;
    mocks.writeTextFile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    const admittedInput = {
      source: source(),
      format: 'json' as const,
      targetDocumentId: TARGET_ID,
      folders: FOLDERS,
      expectedOutputSha256: inspected.outputSha256,
      expectedTargetDocumentRevision: inspected.targetDocumentRevision,
      selectedCandidateIds: [inspected.candidates[0].id],
    };

    const admitted = applyAnnotationOutput(admittedInput, { parse });
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    await expect(
      applyAnnotationOutput({ ...admittedInput, folders: [] }, { parse })
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/workspace/i),
    });
    finishWrite?.();

    await expect(admitted).resolves.toMatchObject({ status: 'saved' });
    expect(mocks.writeTextFile).toHaveBeenCalledOnce();
  });

  it('does not offer a retry revision when another edit races a failed write', async () => {
    const parse = parser();
    const inspected = await inspectAnnotationOutput(
      { source: source(), format: 'json', targetDocumentId: TARGET_ID, folders: FOLDERS },
      { parse }
    );
    mocks.writeTextFile.mockImplementationOnce(async () => {
      useSequenceStore.getState().addAnnotation(TARGET_ID, {
        name: 'Racing edit',
        type: 'misc_feature',
        start: 7,
        end: 7,
        direction: 1,
      });
      throw new Error('disk refused write');
    });

    const result = await applyAnnotationOutput(
      {
        source: source(),
        format: 'json',
        targetDocumentId: TARGET_ID,
        folders: FOLDERS,
        expectedOutputSha256: inspected.outputSha256,
        expectedTargetDocumentRevision: inspected.targetDocumentRevision,
        selectedCandidateIds: [inspected.candidates[0].id],
      },
      { parse }
    );

    expect(result).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/changed while.*saved/i),
    });
    expect(result).not.toHaveProperty('retryTargetDocumentRevision');
  });
});
