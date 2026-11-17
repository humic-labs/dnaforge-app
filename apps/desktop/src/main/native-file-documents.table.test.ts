// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeFileDocuments } from './native-file-documents';
import { NativeDocumentDispatcher } from './native-document-dispatcher';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import {
  parseTablePackageHead,
  parseTableSnapshot,
  serializeTablePackageHead,
  serializeTableSnapshot,
  tablePackagePaths,
  tablePackageRevisionPath,
} from '../shared/table-package';
import { publishTablePackageInMain, readTablePackageInMain } from './table-package';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const inspect = {
  kind: 'inspect' as const,
  offset: 0,
  limit: 2000,
  rowOffset: 0,
  rowLimit: 20,
  columnOffset: 0,
  columnLimit: 20,
};

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'table-file-admission-')));
  const root = join(directory, 'project');
  await mkdir(root);
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare(
    "INSERT INTO workspaces(id,name,path,created_at,access_mode) VALUES(7,?,?,1,'writable')"
  ).run('Project', root);
  const owner = createNativeFileDocuments({
    db: () => db,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => [root],
    profileDirectory: () => join(directory, 'profile'),
  });
  cleanups.push(async () => {
    await owner.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const dispatcher = new NativeDocumentDispatcher({ ordinary: owner, db: () => db, adapters: [] });
  async function make(packageRoot = join(root, 'Samples'), adversarial = false) {
    const id = randomUUID();
    const snapshot = parseTableSnapshot(
      JSON.stringify({
        schema: 'dnaforge.table-snapshot.v1',
        documentId: id,
        title: 'Samples',
        data: { rows: 1, cols: 1, cells: [[{ value: 'original', type: 'text' }]] },
      })
    );
    const head = parseTablePackageHead(
      JSON.stringify({
        schema: 'dnaforge.table.v1',
        id,
        snapshot,
        snapshotSha256: createHash('sha256').update(serializeTableSnapshot(snapshot)).digest('hex'),
        aliases: [],
        status: 'active',
      })
    );
    if (adversarial) {
      const paths = tablePackagePaths(packageRoot);
      await mkdir(paths.revisionsDirectory, { recursive: true });
      await writeFile(
        tablePackageRevisionPath(packageRoot, head.snapshotSha256),
        serializeTableSnapshot(snapshot)
      );
      await writeFile(paths.headPath, serializeTablePackageHead(head));
    } else {
      await publishTablePackageInMain(
        { workspaceRoot: root, packageRoot, head, mode: 'create' },
        { assertCurrent() {} }
      );
    }
    return { packageRoot, head, path: tablePackagePaths(packageRoot).headPath };
  }
  return { root, db, owner, dispatcher, make };
}

describe('native managed table admission', () => {
  it('opens a verified bound table through the ordinary dispatcher and saves a real immutable revision', async () => {
    const f = await fixture();
    const table = await f.make();
    const entity = registerCatalogEntityInDb(f.db, {
      type: 'report',
      name: 'Samples',
      locator: `file://${table.path}`,
      storageType: 'file',
      workspaceRoot: f.root,
    });
    bindCatalogEntityFileInDb(f.db, {
      entityId: entity.id,
      path: table.path,
      fileKind: 'dnaforge-table',
      workspaceRoot: f.root,
    });
    const initial = await f.dispatcher.execute({
      target: { path: table.path },
      projection: 'document',
      operation: inspect,
    });
    expect(initial).toMatchObject({
      type: 'table',
      kind: 'table',
      ready: true,
      readOnly: false,
      owner: { kind: 'table', runtime: 'native' },
      tableDocument: { id: table.head.id },
    });
    const changed = await f.dispatcher.execute({
      target: { documentId: initial.documentId },
      expectedRevision: initial.revision,
      operation: {
        kind: 'table',
        command: { kind: 'set-cell', row: 0, column: 0, value: 'registered table saved' },
      },
      projection: 'document',
    });
    await f.dispatcher.execute({
      target: { documentId: changed.documentId },
      expectedRevision: changed.revision,
      operation: { kind: 'save' },
      projection: 'document',
    });
    expect(
      (await readTablePackageInMain({ workspaceRoot: f.root, packageRoot: table.packageRoot })).head
        .snapshot.data.cells![0][0].value
    ).toBe('registered table saved');
    expect(
      await readFile(tablePackageRevisionPath(table.packageRoot, table.head.snapshotSha256), 'utf8')
    ).toBe(serializeTableSnapshot(table.head.snapshot));
  });

  it('keeps immutable revisions and project identity metadata outside ordinary file access', async () => {
    const f = await fixture();
    const table = await f.make();
    await mkdir(join(f.root, '.forge'));
    const projectMarker = join(f.root, '.forge', 'project.json');
    await writeFile(projectMarker, '{}');
    const revision = tablePackageRevisionPath(table.packageRoot, table.head.snapshotSha256);
    const original = await readFile(revision, 'utf8');
    for (const path of [revision, projectMarker])
      await expect(
        f.dispatcher.execute({ target: { path }, operation: inspect })
      ).rejects.toThrow();
    expect(await readFile(revision, 'utf8')).toBe(original);
    expect(await readFile(projectMarker, 'utf8')).toBe('{}');
  });

  it('refuses exact-looking table heads underneath protected ancestors', async () => {
    const f = await fixture();
    for (const prefix of ['.git', '.GIT', '.forge', '.dnaforge', '.waypoint']) {
      const table = await f.make(join(f.root, prefix, 'Hidden table'), true);
      const before = await readFile(table.path, 'utf8');
      await expect(
        f.dispatcher.execute({ target: { path: table.path }, operation: inspect })
      ).rejects.toThrow();
      expect(await readFile(table.path, 'utf8')).toBe(before);
    }
  });

  it('refuses a linked table head without changing the outside table', async () => {
    const f = await fixture();
    const table = await f.make();
    const linked = join(f.root, 'Linked table');
    await mkdir(linked);
    await symlink(join(table.packageRoot, '.forge'), join(linked, '.forge'), 'dir');
    const before = await readFile(table.path, 'utf8');
    await expect(
      f.dispatcher.execute({
        target: { path: join(linked, '.forge', 'table.json') },
        operation: inspect,
      })
    ).rejects.toThrow();
    expect(await readFile(table.path, 'utf8')).toBe(before);
  });

  it('rejects damaged snapshots without making the head writable as ordinary JSON', async () => {
    const f = await fixture();
    const table = await f.make();
    const before = await readFile(table.path, 'utf8');
    await rm(tablePackageRevisionPath(table.packageRoot, table.head.snapshotSha256));
    const result = await f.dispatcher
      .execute({ target: { path: table.path }, operation: inspect })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
    if ('value' in result) {
      expect(result.value.readOnly).toBe(true);
      expect(result.value.ready).toBe(false);
      expect(result.value.type).not.toBe('text');
    }
    expect(await readFile(table.path, 'utf8')).toBe(before);
  });
});
