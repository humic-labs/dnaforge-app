import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { configureSavedFileBlobRoot } from '../saved-file-sources';
import { verifyWorkspaceSyncBlob } from '../workspace-sync-blob-cache';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { collectPlasmidPackageGitFiles } from './convert-tree-to-packages';
import { importIntoManagedWorkspaceRepo } from './import';

type Capture = typeof import('../workspace-sync-blob-cache').captureWorkspaceSyncBlob;
type CaptureHook = (source: string, delegate: () => ReturnType<Capture>) => ReturnType<Capture>;
const captureControl = vi.hoisted(() => {
  let hook: CaptureHook | undefined;
  return {
    set(next: CaptureHook | undefined) {
      hook = next;
    },
    invoke(source: string, delegate: () => ReturnType<Capture>) {
      return hook ? hook(source, delegate) : delegate();
    },
  };
});
vi.mock('../workspace-sync-blob-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-sync-blob-cache')>();
  return {
    ...actual,
    captureWorkspaceSyncBlob: (...args: Parameters<Capture>) =>
      captureControl.invoke(args[0], () => actual.captureWorkspaceSyncBlob(...args)),
  };
});
vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

type Outcome =
  | { kind: 'fulfilled'; value: Awaited<ReturnType<typeof importIntoManagedWorkspaceRepo>> }
  | { kind: 'rejected'; reason: unknown };
type RetainedRow = {
  workspace_id: number;
  entity_id: string;
  source_path: string;
  manifest_json: string;
  created_at: number;
};
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function packageRoot(source: string) {
  const parent = dirname(source);
  return basename(parent) === '.forge' ? dirname(parent) : parent;
}
const packageName = (source: string) => basename(packageRoot(source));
const isMarker = (source: string) => basename(source) === 'plasmid.json';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(
  ids: string[],
  run: (context: {
    db: Database.Database;
    blobRoot: string;
    gate: () => ReturnType<typeof barrier>;
    start: () => { settled: Promise<Outcome>; finished: () => boolean };
    orderFor: (source: string) => Promise<string[]>;
    rows: () => RetainedRow[];
  }) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'import-retained-packages-'));
  const gates: ReturnType<typeof barrier>[] = [];
  let pending: Promise<Outcome> | undefined;
  let db: Database.Database | undefined;
  try {
    const database = createTestDb();
    db = database;
    ensureSchema(database, ':memory:');
    const blobRoot = join(root, 'blobs');
    configureSavedFileBlobRoot(database, blobRoot);
    const source = join(root, 'source');
    for (const [index, id] of ids.entries()) {
      const directory = join(source, `pkg-${index}`);
      await mkdir(join(directory, '.forge'), { recursive: true });
      const product = `LOCUS       SYNTHETIC  ${4 * (index + 1)} bp DNA linear SYN\nORIGIN\n        1 ${'acgt'.repeat(index + 1)}\n//\n`;
      const document = buildSequencePackageDocument({
        id,
        name: `fixture-${index}`,
        product: { file: 'product.gb', topology: 'linear' },
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await writeFile(join(directory, 'product.gb'), product);
      await writeFile(
        join(directory, '.forge', 'plasmid.json'),
        serializeSequencePackageDocument(document)
      );
    }
    let order: Promise<string[]> | undefined;
    await run({
      db: database,
      blobRoot,
      gate: () => {
        const value = barrier();
        gates.push(value);
        return value;
      },
      start: () => {
        if (pending) throw new Error('IMPORT_ALREADY_STARTED');
        let finished = false;
        pending = importIntoManagedWorkspaceRepo(source, {
          db: database,
          managedRootDir: join(root, 'managed'),
          commitAllIfDirty: async () => null,
        }).then(
          (value): Outcome => {
            finished = true;
            return { kind: 'fulfilled', value };
          },
          (reason): Outcome => {
            finished = true;
            return { kind: 'rejected', reason };
          }
        );
        return { settled: pending, finished: () => finished };
      },
      orderFor: (member) =>
        (order ??= collectPlasmidPackageGitFiles(dirname(packageRoot(member))).then((paths) =>
          paths
            .filter(
              (path) => basename(path) === 'plasmid.json' && basename(dirname(path)) === '.forge'
            )
            .map((path) => basename(dirname(dirname(path))))
        )),
      rows: () =>
        database
          .prepare<
            [],
            RetainedRow
          >("SELECT workspace_id,entity_id,source_path,manifest_json,created_at FROM retained_file_source_revisions WHERE status='committed' ORDER BY rowid")
          .all(),
    });
  } finally {
    for (const gate of gates) gate.release();
    if (pending) await pending;
    captureControl.set(undefined);
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function observed(condition: () => boolean, message: string) {
  await vi.waitFor(() => expect(condition(), message).toBe(true));
}

describe('fresh import retained package settlement', () => {
  it('overlaps bounded real captures and retains every required package before return', async () => {
    const ids = Array.from({ length: 6 }, (_, index) => `entity-${index}`);
    await fixture(ids, async (context) => {
      const held = context.gate();
      const entered = new Set<string>();
      let active = 0,
        peak = 0,
        calls = 0;
      captureControl.set(async (source, delegate) => {
        entered.add(packageName(source));
        calls++;
        active++;
        peak = Math.max(peak, active);
        try {
          await held.promise;
          return await delegate();
        } finally {
          active--;
        }
      });
      const operation = context.start();
      await observed(() => entered.size >= 2, 'RETAIN_CAPTURES_DID_NOT_OVERLAP');
      expect(peak).toBeLessThanOrEqual(4);
      expect(operation.finished()).toBe(false);
      expect(context.rows()).toEqual([]);
      held.release();
      const result = await operation.settled;
      expect(result.kind).toBe('fulfilled');
      if (result.kind !== 'fulfilled') throw result.reason;
      const owner = context.db
        .prepare<[string], { id: number }>('SELECT id FROM workspaces WHERE path=?')
        .get(result.value.repoPath);
      expect(owner).toBeDefined();
      const rows = context.rows();
      expect(rows.map((row) => row.entity_id).sort()).toEqual([...ids].sort());
      expect(rows.every((row) => row.workspace_id === owner?.id)).toBe(true);
      expect(calls).toBe(12);
      expect(active).toBe(0);
      expect(peak).toBeLessThanOrEqual(4);
      for (const row of rows) {
        const manifest = JSON.parse(row.manifest_json);
        const files = manifest.members.filter((member: { kind: string }) => member.kind === 'file');
        expect(files).toHaveLength(2);
        for (const file of files)
          await verifyWorkspaceSyncBlob(
            { sha256: file.sha256, sizeBytes: file.sizeBytes },
            { cacheRoot: context.blobRoot }
          );
      }
    });
  });

  it('publishes duplicate entity revisions in discovery order after reversed preparation', async () => {
    await fixture(['same-entity', 'same-entity'], async (context) => {
      const first = context.gate();
      let laterPrepared = false;
      let expected: string[] = [];
      captureControl.set(async (source, delegate) => {
        expected = await context.orderFor(source);
        const name = packageName(source);
        if (name === expected[0]) await first.promise;
        const identity = await delegate();
        if (name === expected[1] && !isMarker(source)) laterPrepared = true;
        return identity;
      });
      const operation = context.start();
      await observed(() => laterPrepared, 'LATER_PACKAGE_PREPARATION_DID_NOT_OVERLAP');
      await turn();
      expect(context.rows()).toEqual([]);
      expect(operation.finished()).toBe(false);
      first.release();
      const result = await operation.settled;
      expect(result.kind).toBe('fulfilled');
      const rows = context.rows();
      expect(rows.map((row) => basename(row.source_path))).toEqual(expected);
      expect(rows.map((row) => row.entity_id)).toEqual(['same-entity', 'same-entity']);
      expect(rows[1].created_at).toBeGreaterThan(rows[0].created_at);
    });
  });

  it('drains admitted captures and rejects the original reason without publishing a suffix or next batch', async () => {
    await fixture(
      Array.from({ length: 8 }, (_, index) => `failure-entity-${index}`),
      async (context) => {
        const fail = context.gate(),
          tail = context.gate();
        const admitted = new Set<string>();
        let active = 0,
          failureEntered = false,
          tailEntered = false,
          failureThrown = false;
        let expected: string[] = [];
        captureControl.set(async (source, delegate) => {
          expected = await context.orderFor(source);
          const name = packageName(source),
            index = expected.indexOf(name);
          admitted.add(name);
          active++;
          try {
            if (index === 1 && isMarker(source)) {
              failureEntered = true;
              await fail.promise;
              await delegate();
              failureThrown = true;
              throw undefined;
            }
            if (index >= 2) {
              tailEntered = true;
              await tail.promise;
            }
            return await delegate();
          } finally {
            active--;
          }
        });
        const operation = context.start();
        await observed(
          () => failureEntered && tailEntered,
          'FAILURE_HAS_NO_ADMITTED_CAPTURE_TO_DRAIN'
        );
        fail.release();
        await observed(() => failureThrown, 'CONTROLLED_CAPTURE_DID_NOT_REJECT');
        await turn();
        expect(operation.finished(), 'IMPORT_REJECTED_BEFORE_ADMITTED_CAPTURE_DRAIN').toBe(false);
        tail.release();
        const result = await operation.settled;
        expect(result).toEqual({ kind: 'rejected', reason: undefined });
        expect(active).toBe(0);
        expect([...admitted].every((name) => expected.indexOf(name) < 4)).toBe(true);
        expect(context.rows().map((row) => basename(row.source_path))).toEqual([expected[0]]);
        const count = admitted.size;
        await turn();
        expect(admitted.size).toBe(count);
      }
    );
  });
});
