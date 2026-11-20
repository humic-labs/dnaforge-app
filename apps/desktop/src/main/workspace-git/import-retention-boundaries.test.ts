import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { configureSavedFileBlobRoot } from '../saved-file-sources';
import { retainSequencePackage } from '../retain-sequence-package';
import {
  captureWorkspaceSyncBlob,
  verifyWorkspaceSyncBlob,
  workspaceSyncBlobPath,
} from '../workspace-sync-blob-cache';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { collectPlasmidPackageGitFiles } from './convert-tree-to-packages';
import { importIntoManagedWorkspaceRepo } from './import';

type Capture = typeof import('../workspace-sync-blob-cache').captureWorkspaceSyncBlob;
type Rename = typeof import('node:fs/promises').rename;
type CaptureHook = (source: string, delegate: () => ReturnType<Capture>) => ReturnType<Capture>;
type RenameHook = (
  source: Parameters<Rename>[0],
  destination: Parameters<Rename>[1],
  delegate: () => ReturnType<Rename>
) => ReturnType<Rename>;
const seams = vi.hoisted(() => {
  let capture: CaptureHook | undefined;
  let move: RenameHook | undefined;
  const active = new Set<ReturnType<Capture>>();
  return {
    setCapture(hook: CaptureHook | undefined) {
      capture = hook;
    },
    setRename(hook: RenameHook | undefined) {
      move = hook;
    },
    capture(source: string, delegate: () => ReturnType<Capture>) {
      const pending = capture ? capture(source, delegate) : delegate();
      active.add(pending);
      void pending.then(
        () => active.delete(pending),
        () => active.delete(pending)
      );
      return pending;
    },
    rename(
      source: Parameters<Rename>[0],
      destination: Parameters<Rename>[1],
      delegate: () => ReturnType<Rename>
    ) {
      return move ? move(source, destination, delegate) : delegate();
    },
    async drain() {
      while (active.size) await Promise.allSettled([...active]);
    },
  };
});
vi.mock('../workspace-sync-blob-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-sync-blob-cache')>();
  return {
    ...actual,
    captureWorkspaceSyncBlob: (...args: Parameters<Capture>) =>
      seams.capture(args[0], () => actual.captureWorkspaceSyncBlob(...args)),
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (...args: Parameters<Rename>) =>
      seams.rename(args[0], args[1], () => actual.rename(...args)),
  };
});
vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

type ImportOutcome =
  | { kind: 'fulfilled'; value: Awaited<ReturnType<typeof importIntoManagedWorkspaceRepo>> }
  | { kind: 'rejected'; reason: unknown };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const packageRoot = (member: string) =>
  basename(dirname(member)) === '.forge' ? dirname(dirname(member)) : dirname(member);
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(
  run: (context: {
    root: string;
    source: string;
    blobRoot: string;
    db: Database.Database;
    gate: () => ReturnType<typeof gate>;
    start: () => Promise<ImportOutcome>;
    order: (member: string) => Promise<string[]>;
    retainedCount: () => number;
  }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'import-retention-boundaries-'));
  const gates: ReturnType<typeof gate>[] = [];
  let db: Database.Database | undefined, pending: Promise<ImportOutcome> | undefined;
  try {
    const database = createTestDb();
    db = database;
    ensureSchema(database, ':memory:');
    const source = join(root, 'source'),
      blobRoot = join(root, 'blobs');
    configureSavedFileBlobRoot(database, blobRoot);
    for (let index = 0; index < 2; index++) {
      const directory = join(source, `pkg-${index}`);
      await mkdir(join(directory, '.forge'), { recursive: true });
      const doc = buildSequencePackageDocument({
        id: `boundary-${index}`,
        name: `fixture-${index}`,
        product: { file: 'product.gb', topology: 'linear' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await writeFile(
        join(directory, '.forge', 'plasmid.json'),
        serializeSequencePackageDocument(doc)
      );
      await writeFile(
        join(directory, 'product.gb'),
        `LOCUS       SYNTHETIC  4 bp DNA linear SYN\nORIGIN\n        1 acgt\n//\n`
      );
    }
    let order: Promise<string[]> | undefined;
    await run({
      root,
      source,
      blobRoot,
      db: database,
      gate: () => {
        const value = gate();
        gates.push(value);
        return value;
      },
      start: () => {
        if (pending) throw new Error('IMPORT_ALREADY_STARTED');
        pending = importIntoManagedWorkspaceRepo(source, {
          db: database,
          managedRootDir: join(root, 'managed'),
          commitAllIfDirty: async () => null,
        }).then(
          (value): ImportOutcome => ({ kind: 'fulfilled', value }),
          (reason): ImportOutcome => ({ kind: 'rejected', reason })
        );
        return pending;
      },
      order: (member) =>
        (order ??= collectPlasmidPackageGitFiles(dirname(packageRoot(member))).then((paths) =>
          paths
            .filter(
              (path) => basename(path) === 'plasmid.json' && basename(dirname(path)) === '.forge'
            )
            .map((path) => dirname(dirname(path)))
        )),
      retainedCount: () =>
        database
          .prepare<
            [],
            { count: number }
          >("SELECT COUNT(*) AS count FROM retained_file_source_revisions WHERE status='committed'")
          .get()?.count ?? 0,
    });
  } finally {
    for (const gate of gates) gate.release();
    if (pending) await pending;
    await seams.drain();
    await turn();
    seams.setCapture(undefined);
    seams.setRename(undefined);
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function delayed(context: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const blocker = context.gate();
  let firstReady = false,
    blockerEntered = false,
    roots: string[] = [];
  seams.setCapture(async (member, delegate) => {
    roots = await context.order(member);
    const index = roots.indexOf(packageRoot(member));
    if (index === 1 && basename(member) === 'product.gb') {
      blockerEntered = true;
      await blocker.promise;
    }
    const identity = await delegate();
    if (index === 0 && basename(member) === 'product.gb') firstReady = true;
    return identity;
  });
  const outcome = context.start();
  await vi.waitFor(() =>
    expect(firstReady && blockerEntered, 'PUBLICATION_FENCE_CONTROL_NOT_READY').toBe(true)
  );
  await turn();
  expect(context.retainedCount()).toBe(0);
  const physicalWorkspace = await realpath(dirname(roots[0]));
  const matches: string[] = [];
  const owners = context.db.prepare<[], { path: string }>('SELECT path FROM workspaces').all();
  for (const owner of owners) {
    if ((await realpath(owner.path)) === physicalWorkspace) matches.push(owner.path);
  }
  const [workspace, ...otherOwners] = matches;
  if (workspace === undefined || otherOwners.length) {
    throw new Error('FIXTURE_PHYSICAL_OWNER_NOT_UNIQUE');
  }
  return { blocker, roots, outcome, workspace };
}

describe('import retention publication boundaries', () => {
  it('refuses a replaced member after preparation and before delayed publication', async () => {
    await fixture(async (context) => {
      const control = await delayed(context);
      const replacement = join(context.root, 'replacement');
      await writeFile(replacement, 'changed synthetic bytes');
      await rename(replacement, join(control.roots[0], 'product.gb'));
      control.blocker.release();
      expect((await control.outcome).kind).toBe('rejected');
      expect(context.retainedCount()).toBe(0);
    });
  });

  for (const change of ['ambiguous-owner', 'new-owner'] as const) {
    it(`refuses ${change} before delayed publication`, async () => {
      await fixture(async (context) => {
        const control = await delayed(context);
        const owner = context.db
          .prepare<[string], { id: number }>('SELECT id FROM workspaces WHERE path=?')
          .get(control.workspace);
        if (!owner) throw new Error('FIXTURE_OWNER_MISSING');
        if (change === 'ambiguous-owner') {
          const alias = join(context.root, 'alias');
          await symlink(
            control.workspace,
            alias,
            process.platform === 'win32' ? 'junction' : 'dir'
          );
          context.db
            .prepare(
              'INSERT INTO workspaces(name,path,repo_uuid,created_at,last_opened_at) VALUES(?,?,?,?,?)'
            )
            .run('alias', alias, 'alias-owner', 1, 1);
        } else {
          context.db.prepare('DELETE FROM workspaces WHERE id=?').run(owner.id);
          context.db
            .prepare(
              'INSERT INTO workspaces(id,name,path,repo_uuid,created_at,last_opened_at) VALUES(?,?,?,?,?,?)'
            )
            .run(owner.id + 1000, 'replacement', control.workspace, 'replacement-owner', 1, 1);
        }
        control.blocker.release();
        expect((await control.outcome).kind).toBe('rejected');
        expect(context.retainedCount()).toBe(0);
      });
    });
  }

  it('preserves singular expected identity and early and final current-state refusals', async () => {
    await fixture(async (context) => {
      context.db
        .prepare(
          'INSERT INTO workspaces(name,path,repo_uuid,created_at,last_opened_at) VALUES(?,?,?,?,?)'
        )
        .run('singular', context.source, 'singular-owner', 1, 1);
      const input = { workspaceRoot: context.source, packageRoot: join(context.source, 'pkg-0') };
      let returned = 0;
      seams.setCapture(async (_source, delegate) => {
        const value = await delegate();
        returned++;
        return value;
      });
      await expect(retainSequencePackage(context.db, input, 'different-identity')).rejects.toThrow(
        /identity/i
      );
      expect(returned).toBe(0);
      const refused = new Error('controlled current-state refusal');
      await expect(
        retainSequencePackage(context.db, input, 'boundary-0', () => {
          throw refused;
        })
      ).rejects.toBe(refused);
      expect(returned).toBe(0);
      await expect(
        retainSequencePackage(context.db, input, 'boundary-0', () => {
          if (returned === 2) throw refused;
        })
      ).rejects.toBe(refused);
      expect(returned).toBe(2);
      expect(context.retainedCount()).toBe(0);
    });
  });

  it('captures the same digest concurrently as independent verified durable bytes', async () => {
    await fixture(async (context) => {
      const bytes = Buffer.from('fixed shared bytes\n'),
        first = join(context.root, 'first'),
        second = join(context.root, 'second');
      await writeFile(first, bytes);
      await writeFile(second, bytes);
      const identity = {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      };
      const results = await Promise.allSettled(
        [first, second].map((source) =>
          captureWorkspaceSyncBlob(source, { cacheRoot: context.blobRoot, maxBytes: bytes.length })
        )
      );
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') expect(result.value).toEqual(identity);
      }
      await verifyWorkspaceSyncBlob(identity, { cacheRoot: context.blobRoot });
      await writeFile(first, 'source changed');
      expect(
        await readFile(await workspaceSyncBlobPath(identity.sha256, context.blobRoot))
      ).toEqual(bytes);
      expect(
        (await readdir(context.blobRoot)).filter((name) => name.startsWith('.capture-'))
      ).toEqual([]);
    });
  });

  it('preserves valid cache bytes and repairs corrupt cache bytes after refused replacement', async () => {
    for (const corrupt of [false, true]) {
      await fixture(async (context) => {
        const bytes = Buffer.from('fixed refusal bytes\n'),
          source = join(context.root, 'capture-source');
        await writeFile(source, bytes);
        const identity = await captureWorkspaceSyncBlob(source, {
          cacheRoot: context.blobRoot,
          maxBytes: bytes.length,
        });
        const destination = await workspaceSyncBlobPath(identity.sha256, context.blobRoot);
        if (corrupt) {
          await chmod(destination, 0o600);
          await writeFile(destination, 'damaged');
          await expect(
            verifyWorkspaceSyncBlob(identity, { cacheRoot: context.blobRoot })
          ).rejects.toThrow();
        }
        let refusals = 0;
        seams.setRename(async (from, to, delegate) => {
          if (
            to === destination &&
            typeof from === 'string' &&
            basename(from).startsWith('.capture-') &&
            refusals === 0
          ) {
            refusals++;
            throw Object.assign(new Error('controlled replace refusal'), { code: 'EEXIST' });
          }
          return delegate();
        });
        expect(
          await captureWorkspaceSyncBlob(source, {
            cacheRoot: context.blobRoot,
            maxBytes: bytes.length,
          })
        ).toEqual(identity);
        expect(refusals).toBe(1);
        await verifyWorkspaceSyncBlob(identity, { cacheRoot: context.blobRoot });
        expect(await readFile(destination)).toEqual(bytes);
        expect(
          (await readdir(context.blobRoot)).filter((name) => name.startsWith('.capture-'))
        ).toEqual([]);
      });
    }
  });
});
