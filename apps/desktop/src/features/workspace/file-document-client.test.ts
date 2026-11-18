import { beforeEach, expect, it, vi } from 'vitest';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../../shared/file-document';
import type { FileDocumentClientFlush } from '../../shared/file-document-client-sync';

const io = vi.hoisted(() => ({
  fileDocument: vi.fn<(request: FileDocumentRequest) => Promise<FileDocumentSnapshot>>(),
  flushListener: null as null | ((request: FileDocumentClientFlush) => void),
  acknowledge: vi.fn(async () => true),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      fileDocument: io.fileDocument,
      subscribeFileDocuments: () => () => undefined,
      onFileDocumentFlush: (listener: (request: FileDocumentClientFlush) => void) => {
        io.flushListener = listener;
        return () => {
          if (io.flushListener === listener) io.flushListener = null;
        };
      },
      acknowledgeFileDocumentFlush: io.acknowledge,
    },
  }),
}));

import {
  getFileDocumentClient,
  flushFileDocumentClients,
  installFileDocumentClientSync,
  registerNativeDocumentClientFlush,
  setNativeFileDocumentReadiness,
  FileDocumentClient,
} from './file-document-client';

beforeEach(() => {
  io.fileDocument.mockReset();
});

it.each(['change', 'load', 'execute', 'save', 'discard'] as const)(
  'refuses a fresh file-client %s after retirement without another native command',
  async (operation) => {
    const path = `/retired/${operation}.txt`;
    io.fileDocument.mockImplementation(async () => ({
      documentId: path,
      path,
      workspaceRoot: '/retired',
      type: 'text',
      kind: 'text',
      revision: 'original',
      persistedRevision: 'original',
      ready: true,
      readOnly: false,
      dirty: false,
      saving: false,
      canUndo: false,
      canRedo: false,
      capabilities: ['inspect', 'edit', 'save'],
      content: 'Original',
      persistedContent: 'Original',
      diskContent: 'Original',
      saveCaptureId: 'capture',
    }));
    const client = new FileDocumentClient(path);
    await client.load();
    await client.flush('retire');
    io.fileDocument.mockClear();
    try {
      const attempts = {
        change: () => client.change('Late'),
        load: () => client.load(),
        execute: () => client.execute({ kind: 'undo' }),
        save: () => client.save(async () => {}),
        discard: () => client.discard(),
      };
      await expect(
        Promise.resolve().then(async () => {
          await attempts[operation]();
        })
      ).rejects.toThrow('FILE_DOCUMENT_CLIENT_RETIRED');
      expect(io.fileDocument).not.toHaveBeenCalled();
      expect(client.content).toBe('Original');
    } finally {
      await client.flush('discard');
    }
  }
);

it.each(['load', 'save'] as const)(
  'finishes an admitted file %s while refusing new retirement admission',
  async (operation) => {
    const path = `/admitted/${operation}.txt`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = operation === 'load';
    let closed = false;
    io.fileDocument.mockImplementation(async (request) => {
      if (closed) throw new Error('Unexpected native command after owner close');
      if (
        hold &&
        (operation === 'load'
          ? request.operation.kind === 'inspect'
          : request.operation.kind === 'await-save')
      ) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return {
        documentId: path,
        path,
        workspaceRoot: '/admitted',
        type: 'text',
        kind: 'text',
        revision: 'original',
        persistedRevision: 'original',
        ready: true,
        readOnly: false,
        dirty: false,
        saving: false,
        canUndo: false,
        canRedo: false,
        capabilities: ['inspect', 'edit', 'save'],
        content: 'Original',
        persistedContent: 'Original',
        diskContent: 'Original',
        saveCaptureId: 'capture',
      };
    });
    const client = new FileDocumentClient(path);
    if (operation === 'save') await client.load();
    hold = true;
    const admitted = operation === 'load' ? client.load() : client.save(async () => {});
    await entered.promise;
    let retired = false;
    const retirement = client.flush('retire').then(() => {
      retired = true;
      closed = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(retired).toBe(false);
      release.resolve();
      await admitted;
      await retirement;
      const calls = io.fileDocument.mock.calls.length;
      await expect(client.load()).rejects.toThrow('FILE_DOCUMENT_CLIENT_RETIRED');
      expect(io.fileDocument).toHaveBeenCalledTimes(calls);
      expect(client.content).toBe('Original');
    } finally {
      release.resolve();
      await Promise.allSettled([admitted, retirement]);
    }
  }
);

it('retires existing autosave admission before waiting for native client readiness', async () => {
  const ready = Promise.withResolvers<void>();
  const dispose = installFileDocumentClientSync('loading-retirement');
  setNativeFileDocumentReadiness(ready.promise);
  const retire = vi.fn(async () => {});
  const unregister = registerNativeDocumentClientFlush(retire);
  const pending = flushFileDocumentClients('retire');
  try {
    expect(retire).toHaveBeenCalledWith('retire');
  } finally {
    ready.resolve();
    await pending;
    unregister();
    dispose();
    setNativeFileDocumentReadiness(Promise.resolve());
    installFileDocumentClientSync('fresh-after-loading-retirement')();
  }
});

it('acknowledges retirement only after current-load clients drain and retires late registrations', async () => {
  io.acknowledge.mockClear();
  const drain = Promise.withResolvers<void>();
  const retire = vi.fn(() => drain.promise);
  const unregister = registerNativeDocumentClientFlush(retire);
  const dispose = installFileDocumentClientSync('retirement-load');
  const request = {
    loadId: 'retirement-load',
    requestId: 'retire-request',
    purpose: 'retire',
  } as const;
  let unregisterLate = () => {};
  try {
    io.flushListener!({ ...request, loadId: 'stale-load' });
    expect(retire).not.toHaveBeenCalled();
    io.flushListener!(request);
    await vi.waitFor(() => expect(retire).toHaveBeenCalledWith('retire'));
    expect(io.acknowledge).not.toHaveBeenCalled();
    const late = vi.fn(async () => {});
    unregisterLate = registerNativeDocumentClientFlush(late);
    expect(late).toHaveBeenCalledWith('retire');
    drain.resolve();
    await vi.waitFor(() =>
      expect(io.acknowledge).toHaveBeenCalledExactlyOnceWith({ ...request, success: true })
    );
    dispose();
    const sameLoad = installFileDocumentClientSync('retirement-load');
    const later = vi.fn(async () => {});
    const unregisterLater = registerNativeDocumentClientFlush(later);
    expect(later).toHaveBeenCalledWith('retire');
    unregisterLater();
    sameLoad();
  } finally {
    drain.resolve();
    unregisterLate();
    unregister();
    dispose();
    installFileDocumentClientSync('fresh-test-load')();
  }
});

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
