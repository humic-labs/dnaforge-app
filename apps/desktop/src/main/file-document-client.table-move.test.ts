// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileDocumentRequest, FileDocumentSnapshot } from '../shared/file-document';
import { tableCommandFixture, identityTestPaths } from './__tests__/table-command-fixture';
import { relocateWorkspaceFileRefsInDb } from './workspace-relocate';

const io = vi.hoisted(() => ({
  execute: undefined as
    | undefined
    | ((request: FileDocumentRequest) => Promise<FileDocumentSnapshot>),
  listeners: new Set<(snapshot: FileDocumentSnapshot) => void>(),
}));
vi.mock('electron', () => ({
  app: { getPath: (name: 'home' | 'userData') => identityTestPaths[name] },
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      fileDocument: (request: FileDocumentRequest) => io.execute!(request),
      subscribeFileDocuments: (listener: (snapshot: FileDocumentSnapshot) => void) => {
        io.listeners.add(listener);
        return () => io.listeners.delete(listener);
      },
    },
  }),
}));

import {
  getFileDocumentClient,
  ownsNativeFileDocument,
} from '../features/workspace/file-document-client';

const fixtures: Awaited<ReturnType<typeof tableCommandFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
  io.execute = undefined;
});
async function fixture() {
  const f = await tableCommandFixture();
  fixtures.push(f);
  io.execute = (request) => f.files.execute(request);
  f.files.subscribe((snapshot) => {
    for (const listener of io.listeners) listener(snapshot);
  });
  const location = {
    workspaceRoot: f.workspaceRoot,
    packageRoot: join(f.workspaceRoot, 'Original table'),
  };
  const create = () =>
    f.commands.execute({
      kind: 'create',
      requestId: randomUUID(),
      destination: location,
      title: 'Original table',
      rows: 2,
      columns: 2,
    });
  const result = await create();
  if (result.kind !== 'created' || result.table.owner.kind !== 'file')
    throw new Error('Expected a real table owner');
  const originalPath = result.table.owner.path;
  const client = getFileDocumentClient(originalPath);
  await client.load();
  const movedRoot = join(f.workspaceRoot, 'Moved table');
  const movedPath = join(movedRoot, '.forge', 'table.json');
  const relocate = async () => {
    await rename(location.packageRoot, movedRoot);
    relocateWorkspaceFileRefsInDb(f.db, {
      workspaceRoot: f.workspaceRoot,
      oldPath: location.packageRoot,
      newPath: movedRoot,
    });
    await f.files.relocate(location.packageRoot, movedRoot);
    return f.inspect(movedPath);
  };
  return { f, client, originalPath, movedPath, create, relocate };
}

describe('attached native table views after relocation', () => {
  it('routes a real relocation event by document identity and retires the old path mapping', async () => {
    const t = await fixture();
    const id = t.client.snapshot!.documentId;
    const moved = await t.relocate();
    expect(moved.documentId).toBe(id);
    expect(t.client.snapshot).toMatchObject({ documentId: id, path: t.movedPath });
    expect(getFileDocumentClient(t.movedPath)).toBe(t.client);
    expect(ownsNativeFileDocument(t.originalPath)).toBe(false);
    t.client.changeTable(
      {
        rows: 2,
        cols: 2,
        cells: [
          [
            { value: 'edit after move', type: 'text' },
            { value: '', type: 'text' },
          ],
          [
            { value: '', type: 'text' },
            { value: '', type: 'text' },
          ],
        ],
      },
      false
    );
    await t.client.save();
    expect((await t.f.inspect(t.movedPath)).content).toContain('edit after move');
  });

  it('reloads the relocated identity even when a different table occupies the original path', async () => {
    const t = await fixture();
    const id = t.client.snapshot!.documentId;
    const moved = await t.relocate();
    t.client.observe(moved);
    const other = await t.create();
    if (other.kind !== 'created' || other.table.owner.kind !== 'file')
      throw new Error('Expected an independent replacement table');
    expect(other.table.owner.documentId).not.toBe(id);
    await t.client.load();
    expect(t.client.snapshot).toMatchObject({ documentId: id, path: t.movedPath });
    const replacement = getFileDocumentClient(t.originalPath);
    await replacement.load();
    expect(replacement).not.toBe(t.client);
    expect(replacement.snapshot?.documentId).toBe(other.table.owner.documentId);
  });
});
