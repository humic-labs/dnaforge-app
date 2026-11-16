import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { NativeFileDocumentOwner, type NativeFileDocumentRecord } from '../file-document-owner';
import {
  NativeTableDocumentCommands,
  type NativeTableDocumentCommandsOptions,
} from '../table-document-commands';
import { parseTablePackageHead, tablePackagePaths } from '../../shared/table-package';
import { readProjectResourceIdentityInMain } from '../project-filesystem-authority';
import { publishTablePackageInMain, readTablePackageInMain } from '../table-package';
import type { FileDocumentSnapshot } from '../../shared/file-document';
import { registerCatalogEntityInDb } from '../catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';

export const identityTestPaths = { home: '', userData: '' };
export async function tableCommandFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-table-commands-')));
  const home = join(root, 'home');
  const userData = join(root, 'user-data');
  const managedRootDir = join(userData, 'managed-workspaces');
  const workspaceRoot = join(home, 'Project');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(managedRootDir, { recursive: true });
  identityTestPaths.home = home;
  identityTestPaths.userData = userData;
  const db = createTestDb();
  ensureSchema(db, ':memory:');
  db.prepare(
    "INSERT INTO workspaces(name,path,created_at,access_mode) VALUES(?,?,1,'writable')"
  ).run('Project', workspaceRoot);
  const roots = [workspaceRoot];
  const records = new Map<string, NativeFileDocumentRecord>();
  let failReconcile = false;
  const captureWorkspace = (path: string, mutating: boolean) => {
    const initial = db.prepare('SELECT * FROM workspaces WHERE path=?').get(path) as
      | { id: number; access_mode: string; archived_at: unknown; trashed_at: unknown }
      | undefined;
    const check = () => {
      const row = db.prepare('SELECT * FROM workspaces WHERE path=?').get(path) as typeof initial;
      if (
        !initial ||
        !row ||
        row.id !== initial.id ||
        row.archived_at !== null ||
        row.trashed_at !== null ||
        (mutating && row.access_mode !== 'writable')
      )
        throw new Error('The registered project authority changed or is not writable');
    };
    check();
    return check;
  };
  const files = new NativeFileDocumentOwner({
    admit: async (path, _root, mutating) => {
      const ownerRoot = roots.find((root) => {
        const member = relative(root, path);
        return (
          !isAbsolute(member) &&
          member !== '..' &&
          !member.startsWith('../') &&
          !member.startsWith('..\\')
        );
      });
      if (!ownerRoot) throw new Error('No admitted project owns this file');
      const row = db.prepare('SELECT access_mode FROM workspaces WHERE path=?').get(ownerRoot) as {
        access_mode: string;
      };
      return {
        path,
        workspaceRoot: ownerRoot,
        readOnly: row.access_mode !== 'writable',
        assertCurrent: captureWorkspace(ownerRoot, mutating),
      };
    },
    identityForPath: async (path) => {
      const bound = db
        .prepare("SELECT entity_id FROM catalog_entity_files WHERE path=? AND status='current'")
        .get(path) as { entity_id: string } | undefined;
      return bound?.entity_id ?? `file:${createHash('sha256').update(path).digest('hex')}`;
    },
    read: async (path) => readFile(path),
    verifyTablePackage: async (admission, content) => {
      const actual = await readTablePackageInMain({
        workspaceRoot: admission.workspaceRoot,
        packageRoot: dirname(dirname(admission.path)),
      });
      if (actual.headText !== content)
        throw new Error('The current table head changed while opening');
    },
    write: async (input, admission) => {
      if (!input.expectedContentHash) throw new Error('Expected rich head hash is required');
      await publishTablePackageInMain(
        {
          workspaceRoot: admission.workspaceRoot,
          packageRoot: dirname(dirname(input.path)),
          head: parseTablePackageHead(input.content),
          mode: 'replace',
          expectedContentHash: input.expectedContentHash.replace(/^sha256:/, ''),
        },
        { assertCurrent: admission.assertCurrent }
      );
    },
    loadRecord: async (path) => records.get(path),
    storeRecord: async (record) => {
      records.set(record.path, structuredClone(record));
    },
  });
  const inspect = (path: string): Promise<FileDocumentSnapshot> =>
    files.execute({
      target: { path },
      projection: 'document',
      operation: {
        kind: 'inspect',
        offset: 0,
        limit: 2000,
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 20,
      },
    });
  const options: NativeTableDocumentCommandsOptions = {
    db: () => db,
    workspaceRoots: () => roots,
    writableWorkspaceRoots: () =>
      roots.filter(
        (path) =>
          (
            db.prepare('SELECT access_mode FROM workspaces WHERE path=?').get(path) as {
              access_mode: string;
            }
          )?.access_mode === 'writable'
      ),
    managedRootDir: () => managedRootDir,
    captureWorkspace,
    files,
    notebookTables: {
      withSource: async () => {
        throw new Error('No source notebook in this file-command fixture');
      },
      inspectSource: async () => {
        throw new Error('No source notebook in this file-command fixture');
      },
    },
    reconcileTablePackage: async (location) => {
      if (failReconcile) throw new Error('Controlled catalog reconciliation failure');
      const actual = await readTablePackageInMain(location);
      const identity = await readProjectResourceIdentityInMain(
        { workspaceRoot: location.workspaceRoot },
        { db, managedRootDir }
      );
      if (!identity) throw new Error('The project has no portable identity');
      const headPath = tablePackagePaths(location.packageRoot).headPath;
      const entity = registerCatalogEntityInDb(db, {
        id: actual.head.id,
        type: 'report',
        name: actual.head.snapshot.title,
        locator: `file://${headPath}`,
        storageType: 'file',
        workspaceRoot: location.workspaceRoot,
      });
      bindCatalogEntityFileInDb(db, {
        entityId: entity.id,
        path: headPath,
        fileKind: 'dnaforge-table',
        workspaceRoot: location.workspaceRoot,
      });
      const copy = await inspect(headPath);
      if (!copy.ready || copy.tableDocument?.id !== actual.head.id)
        throw new Error('The native owner did not verify this table');
      if (copy.documentId !== entity.id)
        throw new Error('The catalog and native owner disagree about this table binding');
      return {
        tableId: actual.head.id,
        fileDocumentId: copy.documentId,
        headPath: tablePackagePaths(location.packageRoot).headPath,
        projectId: identity.projectId,
      };
    },
  };
  return {
    root,
    home,
    userData,
    managedRootDir,
    workspaceRoot,
    db,
    roots,
    files,
    inspect,
    options,
    commands: new NativeTableDocumentCommands(options),
    failReconcile: (value: boolean) => {
      failReconcile = value;
    },
    close: async () => {
      await files.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
