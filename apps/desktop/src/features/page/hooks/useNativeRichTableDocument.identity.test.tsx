import { createHash } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  richTableReference,
  type TableDocumentReference,
} from '../../../shared/table-document-reference';
import {
  serializeTablePackageHead,
  serializeTableSnapshot,
  type TableSnapshot,
} from '../../../shared/table-package';

const io = vi.hoisted(() => ({
  resolve: vi.fn(),
  client: null as any,
  listeners: new Set<(snapshot: any) => void>(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      tableDocument: io.resolve,
      subscribeFileDocuments: (listener: (snapshot: any) => void) => {
        io.listeners.add(listener);
        return () => io.listeners.delete(listener);
      },
    },
  }),
}));
vi.mock('../../../utils/environment', () => ({ isElectron: () => true }));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: any) => unknown) => select({ folders: [] }),
}));
vi.mock('../../../db/workspace-catalog', () => ({ findWorkspaceRootForPath: () => null }));
vi.mock('../../workspace/public/file-document-client', () => ({
  getFileDocumentClient: () => io.client,
}));

import { useNativeRichTableDocument } from './useNativeRichTableDocument';
const projectId = '187b6f56-e217-449c-bb60-dfaedda90936';
const tableId = '1e905709-515e-4fcf-88ba-c59a28219f8a';
const path = '/project/Results/.forge/table.json';
const snapshot: TableSnapshot = {
  schema: 'dnaforge.table-snapshot.v1',
  documentId: tableId,
  title: 'Results',
  data: { rows: 1, cols: 1, cells: [[{ value: 'retained data', type: 'text' }]] },
};
const sha = createHash('sha256').update(serializeTableSnapshot(snapshot)).digest('hex');
const content = serializeTablePackageHead({
  schema: 'dnaforge.table.v1',
  id: tableId,
  snapshot,
  snapshotSha256: sha,
  aliases: [],
  status: 'active',
});

beforeEach(() => {
  io.resolve.mockReset();
  io.listeners.clear();
  io.client = {
    content,
    error: null,
    viewRevision: 0,
    load: vi.fn(async () => {}),
    subscribe: () => () => {},
    snapshot: {
      ready: true,
      readOnly: false,
      documentId: 'native-table-owner',
      path,
      workspaceRoot: '/project',
      content,
      tableDocument: {
        id: tableId,
        status: 'active',
        snapshotSha256: sha,
        persistedSnapshotSha256: sha,
      },
    },
  };
  io.resolve.mockImplementation(async ({ reference }: { reference: TableDocumentReference }) => ({
    kind: 'resolved',
    table: {
      reference,
      projectId,
      tableId,
      readOnly: reference.binding.kind === 'saved-version',
      owner:
        reference.binding.kind === 'saved-version'
          ? { kind: 'saved-version', snapshotSha256: sha, snapshot }
          : { kind: 'file', documentId: 'native-table-owner', path, workspaceRoot: '/project' },
    },
  }));
});

it('retains the available native table across equal reference objects and changed lookup hints', async () => {
  const reference = richTableReference(projectId, tableId);
  const { result, rerender } = renderHook(
    ({ reference }) => useNativeRichTableDocument(reference, ''),
    { initialProps: { reference } }
  );
  await waitFor(() => expect(result.current.writable).toBe(true));
  expect(result.current.data?.cells?.[0]?.[0]?.value).toBe('retained data');
  expect(io.resolve).toHaveBeenCalledTimes(1);
  rerender({
    reference: richTableReference(
      projectId,
      tableId,
      { kind: 'current' },
      { pathHint: '/stale/Old/.forge/table.json', fileDocumentId: 'stale-profile' }
    ),
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.data?.cells?.[0]?.[0]?.value).toBe('retained data');
  await waitFor(() => expect(result.current.writable).toBe(true));
  expect(io.resolve).toHaveBeenCalledTimes(1);
  expect(io.client.load).not.toHaveBeenCalled();
});

it('resolves a changed saved-version binding while keeping that new view read-only', async () => {
  const reference = richTableReference(projectId, tableId);
  const { result, rerender } = renderHook(
    ({ reference }) => useNativeRichTableDocument(reference, ''),
    { initialProps: { reference } }
  );
  await waitFor(() => expect(result.current.writable).toBe(true));
  rerender({
    reference: richTableReference(projectId, tableId, {
      kind: 'saved-version',
      savedVersionId: sha,
      sha256: `sha256:${sha}`,
    }),
  });
  await waitFor(() => expect(result.current.resolved?.owner.kind).toBe('saved-version'));
  expect(result.current.loading).toBe(false);
  expect(result.current.writable).toBe(false);
  expect(result.current.client).toBe(null);
  expect(io.resolve).toHaveBeenCalledTimes(2);
});

it('recovers the same mounted reference after native activation without a remount or user click', async () => {
  io.resolve.mockRejectedValueOnce(
    new Error(
      'TABLE_DOCUMENT_UNAVAILABLE: The table is awaiting a recoverable ownership transition.'
    )
  );
  const { result } = renderHook(() =>
    useNativeRichTableDocument(richTableReference(projectId, tableId), '')
  );
  await waitFor(() => expect(result.current.error).toContain('ownership transition'));
  await act(async () => {
    for (const listener of io.listeners)
      listener({
        ...io.client.snapshot,
        tableDocument: { ...io.client.snapshot.tableDocument, id: 'unrelated-table' },
      });
  });
  expect(io.resolve).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (const listener of io.listeners) listener(io.client.snapshot);
  });
  await waitFor(() => expect(result.current.writable).toBe(true));
  expect(result.current.data?.cells?.[0]?.[0]?.value).toBe('retained data');
  expect(io.resolve).toHaveBeenCalledTimes(2);
  await act(async () => {
    for (const listener of io.listeners) listener(io.client.snapshot);
  });
  expect(io.resolve).toHaveBeenCalledTimes(2);
});

it('ignores an old pending rejection when activation arrived before that request finished', async () => {
  let rejectPending!: (error: Error) => void;
  io.resolve.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectPending = reject;
      })
  );
  const { result } = renderHook(() =>
    useNativeRichTableDocument(richTableReference(projectId, tableId), '')
  );
  await waitFor(() => expect(io.resolve).toHaveBeenCalledTimes(1));
  await act(async () => {
    for (const listener of io.listeners) listener(io.client.snapshot);
  });
  await waitFor(() => expect(result.current.writable).toBe(true));
  await act(async () => {
    rejectPending(new Error('The old pending ownership lookup failed.'));
  });
  expect(result.current.writable).toBe(true);
  expect(result.current.error).toBe(null);
  expect(io.resolve).toHaveBeenCalledTimes(2);
});

it('opens another view of an available native owner without reloading its working copy', async () => {
  const reference = richTableReference(projectId, tableId);
  io.client.load.mockRejectedValue(
    new Error('Reloading this working copy would interrupt its active editor.')
  );
  const first = renderHook(() => useNativeRichTableDocument(reference, ''));
  const second = renderHook(() => useNativeRichTableDocument(reference, ''));
  await waitFor(() => expect(first.result.current.resolved).not.toBe(null));
  await waitFor(() => expect(second.result.current.resolved).not.toBe(null));
  expect(io.client.load).not.toHaveBeenCalled();
  expect(first.result.current.writable).toBe(true);
  expect(second.result.current.writable).toBe(true);
});
