import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => tmpdir(), getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { notebookPackagePaths, parseNotebookPackageDocument } from '../db/notebook-package';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { contentFingerprint } from '../shared/content-fingerprint';

let directory: string, root: string, db: Database.Database;
vi.mock('./ipc/database', () => ({ getDb: () => db }));

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'dnaforge-auto-notebook-')));
  root = join(directory, 'project');
  await mkdir(root);
  db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces(id,name,path,created_at)VALUES(7,?,?,1)').run(
    'Notebook migration',
    root
  );
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

const owner = (writable = true) =>
  createNativeNotebookWorkingCopies({
    db: () => db,
    workspaceRoots: () => [root],
    writableWorkspaceRoots: () => (writable ? [root] : []),
    profileDirectory: () => join(directory, 'profile'),
    captureWorkspace: () => () => {},
    relocateEntityFile: async () => {
      throw new Error('Relocation is not part of notebook migration.');
    },
  });

async function seed(kind: 'flat' | 'v1') {
  const fixtures = new URL('../db/__fixtures__/notebook-packages/', import.meta.url);
  const path = join(root, kind === 'flat' ? 'legacy-flat.wpnote.json' : 'v1-rich-notebook');
  await cp(
    new URL(kind === 'flat' ? 'legacy-flat.wpnote.json' : 'v1-rich-notebook', fixtures),
    path,
    {
      recursive: kind === 'v1',
    }
  );
  const sourcePath = kind === 'flat' ? path : notebookPackagePaths(path).metaPath;
  const original = await readFile(sourcePath, 'utf8');
  const document = parseNotebookPackageDocument(original);
  const id = 'ws7::' + document.id;
  db.prepare(
    'INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(id, 'notebook', document.title, 'entity://page/' + id, 'database', 'active', 7, 1, 1);
  db.prepare('INSERT INTO pages(id,title,content,created_at,updated_at)VALUES(?,?,?,?,?)').run(
    id,
    document.title,
    JSON.stringify(document.content),
    1,
    1
  );
  bindCatalogEntityFileInDb(db, {
    entityId: id,
    path,
    workspaceRoot: root,
    fileKind: 'waypoint-notebook',
    status: 'current',
  });
  return { id, path, sourcePath, original, document };
}

describe('native notebook automatic legacy migration', () => {
  it.each(['flat', 'v1'] as const)(
    'opens a writable legacy %s notebook in the current format before authoring',
    async (kind) => {
      const fixture = await seed(kind);
      const native = owner();
      const opened = await native.execute({
        documentId: fixture.id,
        operation: { kind: 'inspect-copy' },
      });
      const expected = new NotebookDocumentModel(fixture.document.content, fixture.document.title);

      expect(opened.documentId).toBe(fixture.id);
      expect(opened.dirty).toBe(false);
      expect(canonicalNotebookJson(opened.copy.content)).toBe(
        canonicalNotebookJson(expected.content)
      );
      const disk = await readCanonicalNotebookPackage(
        {
          readTextFile: (path) => readFile(path, 'utf8'),
          exists: async (path) => {
            try {
              await access(path);
              return true;
            } catch {
              return false;
            }
          },
        },
        opened.path
      );
      expect(disk.metadata.formatVersion).toBe(2);
      expect(disk.metadata.id).toBe(fixture.document.id);
      expect(canonicalNotebookJson(disk.parsed.content)).toBe(
        canonicalNotebookJson(expected.content)
      );
      if (kind === 'flat') {
        expect(opened.path).not.toBe(fixture.path);
        expect(await readFile(fixture.path + '.legacy', 'utf8')).toBe(fixture.original);
      } else {
        expect(await readFile(join(opened.path, 'assets', 'model.pdb'), 'utf8')).toBe(
          await readFile(
            new URL(
              '../db/__fixtures__/notebook-packages/v1-rich-notebook/assets/model.pdb',
              import.meta.url
            ),
            'utf8'
          )
        );
      }
      await native.close();
      const restarted = owner();
      const reopened = await restarted.execute({
        documentId: fixture.id,
        operation: { kind: 'inspect-copy' },
      });
      expect(reopened.path).toBe(opened.path);
      expect(reopened.copy.content).toEqual(opened.copy.content);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM catalog_entities WHERE type='notebook'").get()
      ).toEqual({ count: 1 });
      await restarted.close();
    }
  );

  it('preserves legacy source bytes when its project is read-only', async () => {
    const fixture = await seed('flat');
    const native = owner(false);
    const opened = await native.execute({
      documentId: fixture.id,
      operation: { kind: 'inspect-copy' },
    });
    expect(opened.readOnly).toBe(true);
    expect(opened.path).toBe(fixture.path);
    expect(await readFile(fixture.sourcePath, 'utf8')).toBe(fixture.original);
    await expect(access(fixture.path + '.legacy')).rejects.toMatchObject({ code: 'ENOENT' });
    await native.close();
  });

  it('preserves an earlier archive while automatically converting the current flat notebook', async () => {
    const fixture = await seed('flat');
    const archive = fixture.path + '.legacy';
    const older = 'An earlier retained version must never be replaced.\n';
    await writeFile(archive, older);
    const native = owner();
    const opened = await native.execute({
      documentId: fixture.id,
      operation: { kind: 'inspect-copy' },
    });

    expect(opened.path).not.toBe(fixture.path);
    expect(opened.documentId).toBe(fixture.id);
    expect(await readFile(archive, 'utf8')).toBe(older);
    const retained: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collect(path);
        else if (entry.isFile()) retained.push(await readFile(path, 'utf8'));
      }
    };
    await collect(root);
    expect(retained).toContain(fixture.original);
    await native.close();
  });

  it('resumes a cutover interrupted after source retirement and preserves an earlier native draft', async () => {
    const fixture = await seed('flat');
    db.exec("CREATE TRIGGER interrupt_notebook_rebinding BEFORE INSERT ON catalog_entity_files BEGIN SELECT RAISE(ABORT, 'Interrupted notebook rebinding'); END");
    const native = owner();
    await expect(native.execute({ documentId: fixture.id, operation: { kind: 'inspect-copy' } })).rejects.toThrow('Interrupted notebook rebinding');
    await native.close();
    await expect(access(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(fixture.path + '.legacy', 'utf8')).toBe(fixture.original);
    db.exec('DROP TRIGGER interrupt_notebook_rebinding');
    const draft = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unsaved work from before interruption.' }] }] };
    const records = join(directory, 'profile', 'notebook-working-copies');
    await mkdir(records, { recursive: true });
    await writeFile(join(records, createHash('sha256').update(fixture.id).digest('hex') + '.json'), JSON.stringify({
      version: 1,
      documentId: fixture.id,
      path: fixture.path,
      baselineFingerprint: contentFingerprint(fixture.original),
      baselineContent: fixture.document.content,
      content: draft,
      title: fixture.document.title,
      dirty: true,
    }));
    const restarted = owner();
    const reopened = await restarted.execute({ documentId: fixture.id, operation: { kind: 'inspect-copy' } });
    expect(reopened.documentId).toBe(fixture.id);
    expect(reopened.path).not.toBe(fixture.path);
    expect(reopened.recovery?.content).toEqual(draft);
    expect(await readFile(fixture.path + '.legacy', 'utf8')).toBe(fixture.original);
    expect(db.prepare("SELECT COUNT(*) AS count FROM catalog_entities WHERE type='notebook'").get()).toEqual({ count: 1 });
    await restarted.close();
  });
});
