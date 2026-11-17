import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { defineBlob } from '@waypoint/workspace-revisions';

const harness = vi.hoisted(() => ({
  db: null as Database.Database | null,
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  barriers: [] as string[],
  beforeFlush: null as (() => void) | null,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  shell: { trashItem: async (path: string) => rmSync(path, { recursive: true, force: true }) },
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
vi.mock('./path-allowlist', () => ({
  assertSafePath: async (path: string) => path,
  withSafeWritablePath: async (path: string, operation: (path: string) => unknown) =>
    operation(path),
  withSafeWritablePaths: async (
    paths: { path: string }[],
    operation: (paths: string[]) => unknown
  ) => operation(paths.map(({ path }) => path)),
}));
vi.mock('../features/native-documents', () => ({
  nativeDocuments: {
    flushDirtyDocumentClients: async () => {
      harness.beforeFlush?.();
      harness.barriers.push('renderer-flushed');
    },
    fileDocuments: {
      withCleanPaths: async (_paths: string[], operation: () => unknown) => {
        harness.barriers.push('native-clean');
        expect(harness.barriers[0]).toBe('renderer-flushed');
        return operation();
      },
      assertClean: async () => undefined,
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
import { initManagedRepo, commitAllIfDirty } from '../workspace-git';
import { registerWorkspaceGitHandlers } from './workspace-git';
import { buildSequencePackageDocument } from '../../db/sequence-package';

const cleanup: (() => void)[] = [];
afterEach(() => {
  harness.db = null;
  harness.handlers.clear();
  harness.barriers.length = 0;
  harness.beforeFlush = null;
  for (const run of cleanup.splice(0).reverse()) run();
});

function git(root: string, args: string[]): string {
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function genbank(id: string): string {
  return serializeGenBank({
    id,
    name: id,
    sequence: 'ACGTACGTACGT',
    length: 12,
    circular: false,
    annotations: [],
  });
}

function nativeSequence(resourceId: string, name: string) {
  const text = genbank(name);
  return {
    resourceId,
    path: `${name}/${name}.gb`,
    representation: { format: 'genbank-v1' as const, text },
    sequencePackageText: JSON.stringify(
      buildSequencePackageDocument({
        id: resourceId,
        name,
        product: {
          file: `${name}.gb`,
          topology: 'linear',
          genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
        },
      })
    ),
  };
}

async function enrolledProject() {
  const f = createFileTestDb('enrolled-migration-ipc');
  cleanup.push(f.cleanup);
  harness.db = f.db;
  ensureSchema(f.db, f.dbPath);
  const root = join(f.tmpDir, 'project');
  mkdirSync(root);
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces (name,path,repo_uuid,created_at) VALUES (?,?,?,?)')
      .run('Mixed enrolled project', root, 'mixed-enrolled-project', 1).lastInsertRowid
  );
  const store = new ScientificObjectStore(f.db, workspaceId);
  const accepted = genbank('Accepted');
  const submit = (request: Parameters<typeof submitScientificWorkspace>[0]['request']) =>
    submitScientificWorkspace({ db: f.db, workspaceId, request });
  await submit({
    operationId: 'enroll-project',
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
  await submit({
    operationId: 'create-accepted',
    expectedHead: store.read().head,
    source: {
      kind: 'native-artifact',
      expectedRevisionId: null,
      entry: nativeSequence('accepted-sequence', 'Accepted'),
    },
  });
  await submit({
    operationId: 'create-tombstone-target',
    expectedHead: store.read().head,
    source: {
      kind: 'native-artifact',
      expectedRevisionId: null,
      entry: nativeSequence('deleted-sequence', 'Deleted'),
    },
  });
  await submit({
    operationId: 'tombstone-target',
    expectedHead: store.read().head,
    source: { kind: 'delete', sourcePath: 'Deleted' },
  });
  await initManagedRepo(root);
  writeFileSync(join(root, 'dirty.txt'), 'original dirty file\n');
  writeFileSync(join(root, 'staged.txt'), 'original staged file\n');
  await commitAllIfDirty(root, 'fixture baseline');
  const acceptedHead = store.read().head;
  const acceptedCatalog = store.catalog();
  writeFileSync(join(root, 'dirty.txt'), 'unsubmitted ordinary edit\n');
  writeFileSync(join(root, 'staged.txt'), 'staged ordinary edit\n');
  git(root, ['add', '--', 'staged.txt']);
  writeFileSync(join(root, 'staged.txt'), 'later unstaged edit\n');
  mkdirSync(join(root, 'Deleted'), { recursive: true });
  writeFileSync(join(root, 'Deleted', 'Deleted.gb'), genbank('Deleted'));
  const before = {
    acceptedHead,
    acceptedCatalog,
    accepted,
    stagedEntry: git(root, ['ls-files', '--stage', '--', 'staged.txt']),
    stagedBytes: git(root, ['show', ':staged.txt']),
    dirtyHead: git(root, ['show', 'HEAD:dirty.txt']),
    stagedHead: git(root, ['show', 'HEAD:staged.txt']),
  };
  registerWorkspaceGitHandlers();
  const handler = harness.handlers.get('indexManagedCatalogHead');
  if (!handler) throw new Error('Native catalog indexing handler was not registered.');
  const index = () => handler({ sender: { id: 5274 } }, { repoPath: root, preserveRelPaths: [] });
  return { ...f, root, store, before, index };
}

describe('automatic migration through the native catalog IPC handler', () => {
  it('indexes an existing readonly project without healing or changing any loose source', async () => {
    const f = await enrolledProject();
    f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE path=?").run(f.root);
    writeFileSync(join(f.root, 'Readonly.gb'), genbank('Readonly'));
    const result = await f.index();
    expect(result.headCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.files.map((file: { relPath: string }) => file.relPath)).toContain(
      'Accepted/Accepted.gb'
    );
    expect(result.healedFileCount).toBe(0);
    expect(readFileSync(join(f.root, 'Readonly.gb'), 'utf8')).toBe(genbank('Readonly'));
    expect(existsSync(join(f.root, 'Readonly/Readonly.gb'))).toBe(false);
    expect(f.store.read().head).toBe(f.before.acceptedHead);
  });

  it.each(['sequence', 'coordinates'] as const)(
    'packages new unowned %s in an enrolled project without accepting or committing other changes',
    async (kind) => {
      const f = await enrolledProject();
      const sourcePath = kind === 'sequence' ? 'New.gb' : 'New.pdb';
      const source =
        kind === 'sequence'
          ? genbank('New')
          : 'HEADER    NEW PROTEIN\nATOM      1  CA  ALA A   1\nEND\n';
      writeFileSync(join(f.root, sourcePath), source);
      harness.beforeFlush = () =>
        expect(readFileSync(join(f.root, sourcePath), 'utf8')).toBe(source);
      const result = await f.index();
      expect
        .soft(harness.barriers[0], 'renderer drafts flush before native clean admission')
        .toBe('renderer-flushed');
      expect.soft(harness.barriers).toContain('native-clean');
      harness.beforeFlush = null;
      const target = kind === 'sequence' ? 'New/New.gb' : 'New.dnaforge-molecular.json';

      expect
        .soft(existsSync(join(f.root, target)), 'new unowned source becomes a native package')
        .toBe(true);
      expect.soft(existsSync(join(f.root, sourcePath)), 'loose source is migrated').toBe(false);
      expect.soft(result.files.map((file: { relPath: string }) => file.relPath)).toContain(target);
      expect
        .soft(f.store.read().head, 'migration does not accept a scientific revision')
        .toBe(f.before.acceptedHead);
      expect
        .soft(f.store.catalog(), 'current resources and tombstones retain identity')
        .toEqual(f.before.acceptedCatalog);
      expect
        .soft(readFileSync(join(f.root, 'Accepted/Accepted.gb'), 'utf8'))
        .toBe(f.before.accepted);
      expect
        .soft(readFileSync(join(f.root, 'Deleted/Deleted.gb'), 'utf8'))
        .toBe(genbank('Deleted'));
      expect
        .soft(
          existsSync(join(f.root, 'Deleted/Deleted/Deleted.gb')),
          'tombstones cannot resurrect via conversion'
        )
        .toBe(false);
      expect
        .soft(git(f.root, ['ls-files', '--stage', '--', 'staged.txt']))
        .toBe(f.before.stagedEntry);
      expect.soft(git(f.root, ['show', ':staged.txt'])).toBe(f.before.stagedBytes);
      expect.soft(git(f.root, ['show', 'HEAD:staged.txt'])).toBe(f.before.stagedHead);
      expect.soft(git(f.root, ['show', 'HEAD:dirty.txt'])).toBe(f.before.dirtyHead);
      expect
        .soft(readFileSync(join(f.root, 'dirty.txt'), 'utf8'))
        .toBe('unsubmitted ordinary edit\n');
      expect.soft(readFileSync(join(f.root, 'staged.txt'), 'utf8')).toBe('later unstaged edit\n');
      const retry = await f.index();
      expect.soft(retry.healedFileCount, 'retry is idempotent').toBe(0);
      expect.soft(f.store.read().head).toBe(f.before.acceptedHead);
    }
  );
});
