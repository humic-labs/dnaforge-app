import { actOnAcceptedScientificEntity } from '../scientific-resource-lifecycle';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineBlob } from '@waypoint/workspace-revisions';
import { serializeGenBank } from '@waypoint/sequence-utils';
import type { NativeDocumentWorkspaces } from '../native-document-workspaces';
import type { NativeFileDocumentOwner } from '../file-document-owner';

const harness = vi.hoisted(() => ({
  db: null as Database.Database | null,
  workspaces: null as NativeDocumentWorkspaces | null,
  documents: null as NativeFileDocumentOwner | null,
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  barriers: [] as string[],
  beforeFlush: null as (() => void) | null,
}));
vi.mock('electron', () => ({
  shell: { trashItem: async (path: string) => rmSync(path, { recursive: true }) },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../shared/ipc-contract', () => ({
  handleGroup: (_contract: unknown, handlers: Record<string, (...args: any[]) => Promise<any>>) => {
    for (const [name, handler] of Object.entries(handlers)) harness.handlers.set(name, handler);
  },
  mainIpc: { handle: vi.fn(), on: vi.fn() },
  sendRendererIpc: vi.fn(),
}));
vi.mock('./database', () => ({ getDb: () => harness.db }));
vi.mock('../features/native-documents', () => ({
  nativeDocuments: {
    flushDirtyDocumentClients: async () => {
      harness.beforeFlush?.();
      harness.barriers.push('renderer-flushed');
    },
    workspaces: { capture: (root: string) => harness.workspaces!.capture(root) },
    fileDocuments: {
      withCleanPaths: (paths: string[], operation: () => Promise<unknown>) => {
        harness.barriers.push('native-clean');
        expect(harness.barriers[0]).toBe('renderer-flushed');
        return harness.documents!.withCleanPaths(paths, operation);
      },
      assertClean: (path: string) => harness.documents!.assertClean(path),
    },
  },
}));
vi.mock('../scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: async () => undefined,
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../auth/session-store', () => ({ getActiveStoredSession: async () => null }));

import { createFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { ScientificObjectStore } from '../scientific-object-store';
import { submitScientificWorkspace } from '../scientific-workspace-service';
import { buildSequencePackageDocument } from '../../db/sequence-package';
import { NativeDocumentWorkspaces as Workspaces } from '../native-document-workspaces';
import { createRegisteredProjectAuthority } from '../registered-project-authority';
import { createNativeFileDocuments } from '../native-file-documents';
import { resolveProjectRootInMain } from '../project-filesystem-authority';
import { registerWorkspaceGitHandlers } from './workspace-git';

const cleanup: (() => void)[] = [];
afterEach(() => {
  harness.db = null;
  harness.workspaces = null;
  harness.documents = null;
  harness.handlers.clear();
  harness.barriers.length = 0;
  harness.beforeFlush = null;
  for (const run of cleanup.splice(0).reverse()) run();
});
const genbank = (name: string) =>
  serializeGenBank({
    id: name,
    name,
    sequence: 'ACGTACGTACGT',
    length: 12,
    circular: false,
    annotations: [],
  });
const coordinates = 'HEADER    LOCAL STRUCTURE\nATOM      1  CA  ALA A   1\nEND\n';

async function fixture() {
  const f = createFileTestDb('local-project-migration');
  cleanup.push(f.cleanup);
  harness.db = f.db;
  ensureSchema(f.db, f.dbPath);
  const root = join(f.tmpDir, 'external-project');
  mkdirSync(root);
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces(name,path,created_at) VALUES(?,?,?)')
      .run('External project', root, 1).lastInsertRowid
  );
  await resolveProjectRootInMain(
    { path: root },
    {
      db: f.db,
      managedRootDir: join(f.tmpDir, 'managed'),
      protectedAppDataRoot: join(f.tmpDir, 'profile'),
    }
  );
  const store = new ScientificObjectStore(f.db, workspaceId);
  const submit = (request: Parameters<typeof submitScientificWorkspace>[0]['request']) =>
    submitScientificWorkspace({ db: f.db, workspaceId, request });
  await submit({
    operationId: 'enroll-local',
    expectedHead: null,
    source: {
      kind: 'documents',
      entries: [
        {
          resourceId: 'seed-primer',
          path: 'seed.json',
          document: {
            formatVersion: 1,
            kind: 'primer',
            name: 'Seed',
            molecule: 'DNA',
            bases: 'ACGT',
            modifications: [],
            fields: {},
          },
        },
      ],
    },
  });
  for (const name of ['Accepted', 'Deleted']) {
    const text = genbank(name);
    await submit({
      operationId: `create-${name}`,
      expectedHead: store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: `${name}-sequence`,
          path: `${name}/${name}.gb`,
          representation: { format: 'genbank-v1', text },
          sequencePackageText: JSON.stringify(
            buildSequencePackageDocument({
              id: `${name}-sequence`,
              name,
              product: {
                file: `${name}.gb`,
                topology: 'linear',
                genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
              },
            })
          ),
        },
      },
    });
  }
  expect(
    await actOnAcceptedScientificEntity({
      db: f.db,
      action: 'archive',
      input: { id: 'Deleted-sequence', operationId: 'delete-local' },
    })
  ).not.toBeNull();
  mkdirSync(join(root, 'Deleted'), { recursive: true });
  writeFileSync(join(root, 'Deleted/Deleted.gb'), genbank('Deleted'));
  writeFileSync(join(root, 'New.gb'), genbank('New'));
  writeFileSync(join(root, 'New.pdb'), coordinates);
  writeFileSync(join(root, 'dirty.txt'), 'unsubmitted ordinary edit');
  const workspaces = new Workspaces({
    authority: createRegisteredProjectAuthority({
      db: () => f.db,
      managedRootDir: () => join(f.tmpDir, 'managed'),
    }),
  });
  harness.workspaces = workspaces;
  harness.documents = createNativeFileDocuments({
    db: () => f.db,
    workspaceRoots: () => workspaces.readableRoots(),
    writableWorkspaceRoots: () => workspaces.roots(),
    captureWorkspace: (path, mutating) =>
      mutating ? workspaces.capture(path) : workspaces.captureReadable(path),
    profileDirectory: () => join(f.tmpDir, 'profile'),
  });
  registerWorkspaceGitHandlers();
  return { ...f, root, store, head: store.read().head, catalog: store.catalog() };
}

describe('automatic migration of a writable local project without Git', () => {
  it('packages newly arrived sequence and coordinates without initializing history or changing accepted state', async () => {
    const f = await fixture();
    const handler = harness.handlers.get('migrateLegacyProjectFiles');
    expect.soft(handler, 'native filesystem migration capability exists').toBeTypeOf('function');
    if (!handler) {
      expect(readFileSync(join(f.root, 'New.gb'), 'utf8')).toBe(genbank('New'));
      expect(readFileSync(join(f.root, 'New.pdb'), 'utf8')).toBe(coordinates);
      expect(existsSync(join(f.root, '.git'))).toBe(false);
      return;
    }
    const request = { repoPath: f.root };
    harness.beforeFlush = () => {
      expect(readFileSync(join(f.root, 'New.gb'), 'utf8')).toBe(genbank('New'));
      expect(readFileSync(join(f.root, 'New.pdb'), 'utf8')).toBe(coordinates);
    };
    const result = await handler({ sender: { id: 5274 } }, request);
    expect
      .soft(harness.barriers[0], 'renderer drafts flush before native clean admission')
      .toBe('renderer-flushed');
    expect.soft(harness.barriers).toContain('native-clean');
    harness.beforeFlush = null;
    expect.soft(result.healedFileCount).toBe(2);
    expect.soft(result.migrationIssues).toEqual([]);
    expect.soft(existsSync(join(f.root, 'New/New.gb'))).toBe(true);
    expect.soft(existsSync(join(f.root, 'New.dnaforge-molecular.json'))).toBe(true);
    expect.soft(existsSync(join(f.root, 'New.gb'))).toBe(false);
    expect.soft(existsSync(join(f.root, 'New.pdb'))).toBe(false);
    expect.soft(existsSync(join(f.root, '.git')), 'migration never initializes Git').toBe(false);
    expect.soft(f.store.read().head).toBe(f.head);
    expect.soft(f.store.catalog()).toEqual(f.catalog);
    expect
      .soft(readFileSync(join(f.root, 'Accepted/Accepted.gb'), 'utf8'))
      .toBe(genbank('Accepted'));
    expect.soft(readFileSync(join(f.root, 'Deleted/Deleted.gb'), 'utf8')).toBe(genbank('Deleted'));
    expect.soft(existsSync(join(f.root, 'Deleted/Deleted/Deleted.gb'))).toBe(false);
    expect.soft(readFileSync(join(f.root, 'dirty.txt'), 'utf8')).toBe('unsubmitted ordinary edit');
    expect.soft((await handler({ sender: { id: 5274 } }, request)).healedFileCount).toBe(0);
  });

  it('refuses a readonly local owner and preserves every source without reporting completion', async () => {
    const f = await fixture();
    f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE path=?").run(f.root);
    const handler = harness.handlers.get('migrateLegacyProjectFiles');
    if (handler)
      await expect(handler({ sender: { id: 5274 } }, { repoPath: f.root })).rejects.toThrow(
        /writ|access|read.?only|reference/i
      );
    expect(readFileSync(join(f.root, 'New.gb'), 'utf8')).toBe(genbank('New'));
    expect(readFileSync(join(f.root, 'New.pdb'), 'utf8')).toBe(coordinates);
    expect(existsSync(join(f.root, 'New'))).toBe(false);
    expect(existsSync(join(f.root, 'New.dnaforge-molecular.json'))).toBe(false);
    expect(existsSync(join(f.root, '.git'))).toBe(false);
    expect(f.store.read().head).toBe(f.head);
  });
});
