import { expect, it, vi } from 'vitest';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../../shared/file-document';

const io = vi.hoisted(() => ({
  fileDocument: vi.fn<(request: FileDocumentRequest) => Promise<FileDocumentSnapshot>>(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      fileDocument: io.fileDocument,
      subscribeFileDocuments: () => () => undefined,
    },
  }),
}));

import { getFileDocumentClient } from './file-document-client';

it('shows a file without a native working copy as its read-only text instead of reloading it', async () => {
  const path = '/lab/project/alignments/pUC19-vs-variant.aln';
  const text = 'CLUSTAL W\n\npUC19     ATGCATGC\nvariant   ATGCATGT\n';
  io.fileDocument.mockImplementation(async (request) => {
    if (request.operation.kind !== 'inspect')
      throw new Error('DOCUMENT_ADMISSION_FAILED: Invalid native file identity.');
    return {
      documentId: `path:${path}`,
      path,
      workspaceRoot: '/lab/project',
      type: 'scientific',
      kind: 'scientific',
      owner: { kind: 'scientific', runtime: 'unsupported' },
      revision: 'unsupported',
      persistedRevision: 'unsupported',
      ready: true,
      readOnly: true,
      dirty: false,
      saving: false,
      canUndo: false,
      canRedo: false,
      capabilities: ['inspect'],
      content: null,
      persistedContent: null,
      diskContent: null,
      reason: 'This document kind has no connected native working-copy adapter.',
    };
  });

  const client = getFileDocumentClient(path);
  await client.load(text);

  expect(io.fileDocument.mock.calls.map(([request]) => request.operation.kind)).toEqual([
    'inspect',
  ]);
  expect(client.content).toBe(text);
  expect(client.persistedContent).toBe(text);
  expect(client.snapshot).toMatchObject({ documentId: `path:${path}`, readOnly: true });
});
