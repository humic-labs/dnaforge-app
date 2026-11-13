import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted<{
  db: Database.Database | undefined;
  readGate:
    | { path: string; reached(): void; release: Promise<void>; skipReads?: number }
    | undefined;
  ioGate:
    | { kind: 'write' | 'unlink'; prefix: string; reached(): void; release: Promise<void> }
    | undefined;
  afterLink: { path: string; run(): Promise<void> | void } | undefined;
  afterRename: { path: string; run(): void } | undefined;
  unlinkFailurePrefix: string | undefined;
  readFailure: { path: string; error: Error } | undefined;
  directoryFlushFailure: boolean;
}>(() => ({
  db: undefined,
  readGate: undefined,
  ioGate: undefined,
  afterLink: undefined,
  afterRename: undefined,
  unlinkFailurePrefix: undefined,
  readFailure: undefined,
  directoryFlushFailure: false,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const afterWrite = async (path: unknown) => {
    const gate = host.ioGate;
    if (gate?.kind === 'write' && typeof path === 'string' && path.startsWith(gate.prefix)) {
      host.ioGate = undefined;
      gate.reached();
      await gate.release;
    }
  };
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...content: Parameters<typeof handle.writeFile>) => {
        await writeFile(...content);
        await afterWrite(args[0]);
      };
      return handle;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const gate = host.readGate;
      if (gate && args[0] === gate.path) {
        if (gate.skipReads) gate.skipReads -= 1;
        else {
          host.readGate = undefined;
          gate.reached();
          await gate.release;
        }
      }
      if (host.readFailure?.path === args[0]) throw host.readFailure.error;
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      await afterWrite(args[0]);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      const action = host.afterLink;
      if (action && args[1] === action.path) {
        host.afterLink = undefined;
        await action.run();
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      const action = host.afterRename;
      if (action && args[1] === action.path) {
        host.afterRename = undefined;
        action.run();
      }
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const gate = host.ioGate;
      if (
        gate?.kind === 'unlink' &&
        typeof args[0] === 'string' &&
        args[0].startsWith(gate.prefix)
      ) {
        host.ioGate = undefined;
        gate.reached();
        await gate.release;
      }
      if (
        host.unlinkFailurePrefix &&
        typeof args[0] === 'string' &&
        args[0].startsWith(host.unlinkFailurePrefix)
      ) {
        host.unlinkFailurePrefix = undefined;
        throw new Error('injected temporary cleanup failure');
      }
      return actual.unlink(...args);
    },
  };
});
vi.mock('../fs-durability', async (original) => {
  const actual = await original<typeof import('../fs-durability')>();
  return {
    ...actual,
    syncDirectory: async (...args: Parameters<typeof actual.syncDirectory>) => {
      if (host.directoryFlushFailure) throw new Error('injected directory flush failure');
      return actual.syncDirectory(...args);
    },
  };
});
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return {
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    app: {
      getPath: (kind: string) =>
        kind === 'home' ? tmpdir() : join(tmpdir(), 'evidence-permission-unit-appdata'),
      getVersion: () => 'test',
      on: vi.fn(),
    },
    BrowserWindow: class extends EventEmitter {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
    },
    dialog: { showErrorBox: vi.fn() },
  };
});
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./database', () => ({ getDb: () => host.db }));

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { updateWorkspaceSyncAccessRecord } from '../workspace-sync-access-record';
import { registerFilesystemHandlers } from './filesystem';
import { nativeDocuments } from '../features/native-documents';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';

const sender = Object.assign(new BrowserWindow(), {
  webContents: Object.assign(new EventEmitter(), {
    id: 964,
    mainFrame: { url: 'file:///fixture/index.html' },
    getURL: () => 'file:///fixture/index.html',
    isDestroyed: () => false,
    send: vi.fn(),
  }),
}).webContents;
const event = () =>
  ({
    sender,
    senderFrame: sender.mainFrame,
    type: 'frame',
    frameId: 0,
    processId: 0,
    preventDefault: vi.fn(),
    defaultPrevented: false,
  }) satisfies IpcMainInvokeEvent;

import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';

let root: string;
let packageRoot: string;
let sourcePath: string;
let queryPath: string;
let nativeProfile: string;
const channels = {
  prepare: 'fs:prepareSequenceEvidenceRun',
  activate: 'fs:activateSequenceEvidenceRun',
  complete: 'fs:completeSequenceEvidenceRun',
  fail: 'fs:failSequenceEvidenceRun',
  state: 'fs:appendSequenceEvidenceState',
} as const;
type Command = keyof typeof channels;
function invoke(command: Command, input: unknown) {
  const handler = new Map(vi.mocked(ipcMain.handle).mock.calls).get(channels[command]);
  if (!handler) throw new Error(`Missing actual evidence handler ${command}`);
  return handler(event(), input);
}
function role(access: 'viewer' | 'editor') {
  host.db!.prepare('UPDATE workspace_sync_bindings SET access_role=?').run(access);
}
function request(runId = 'run-one') {
  return {
    workspaceRoot: root,
    packageRoot,
    packageId: 'evidence-document',
    sourcePath,
    sessionId: 'session-one',
    session: { name: 'Review', mode: 'one-per-clone' as const, createdAt: '2026-01-01T00:00:00Z' },
    runId,
    queries: [{ id: 'query-one', label: 'Read', path: queryPath }],
  };
}
async function snapshot() {
  const files: Record<string, string> = {};
  async function walk(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${relative}/`);
      else files[relative] = (await readFile(join(path, entry.name))).toString('base64');
    }
  }
  await walk(packageRoot, '');
  return files;
}
beforeAll(async () => {
  nativeProfile = await realpath(await mkdtemp(join(tmpdir(), 'shared-evidence-native-profile-')));
  nativeDocuments.bindProfile(nativeProfile);
  await nativeDocuments.fileDocuments.completeLegacyMigration([]);
});
afterAll(async () => {
  await nativeDocuments.closeServerAndRecovery();
  await rm(nativeProfile, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'shared-evidence-publication-')));
  await mkdir(join(root, '.git'));
  packageRoot = join(root, 'Sequence');
  const paths = sequencePackagePaths(packageRoot, { productFile: 'sequence.gb' });
  await mkdir(paths.metaDir, { recursive: true });
  await mkdir(paths.contentsDir, { recursive: true });
  sourcePath = paths.productPath;
  queryPath = join(root, 'query.fasta');
  await writeFile(
    sourcePath,
    serializeSequenceForInPlaceSave(
      {
        id: 'evidence-document',
        name: 'Sequence',
        sequence: 'AACC',
        length: 4,
        circular: false,
        annotations: [],
      },
      sourcePath
    )
  );
  await writeFile(queryPath, '>read\nAACC\n');
  await writeFile(
    paths.metaPath,
    serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'evidence-document',
        name: 'Sequence',
        product: { file: 'sequence.gb', topology: 'linear' },
      })
    )
  );
  host.db = createTestDb();
  ensureSchema(host.db, ':memory:');
  host.db
    .prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(7,'Evidence owner',?,'evidence-project',1)"
    )
    .run(root);
  host.db
    .prepare(
      `INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,remote_workspace_id,enabled,access_role,access_source,shared_with_others,created_at,updated_at)
    VALUES(7,'evidence-project','account','remote',0,'viewer','direct',1,1,1)`
    )
    .run();
  vi.mocked(ipcMain.handle).mockClear();
  registerFilesystemHandlers();
});
afterEach(async () => {
  host.readGate = undefined;
  host.ioGate = undefined;
  host.afterLink = undefined;
  host.afterRename = undefined;
  host.unlinkFailurePrefix = undefined;
  host.readFailure = undefined;
  host.directoryFlushFailure = false;
  host.db?.close();
  await rm(root, { recursive: true, force: true });
});

async function prepared() {
  role('editor');
  const value = await invoke('prepare', request());
  role('viewer');
  return value;
}
async function inputFor(command: Command) {
  if (command === 'prepare') return request();
  const preparation = await prepared();
  const base = {
    ...request(),
    managedOperationId: 'operation-one',
    inputRevision: `pairwise-session-alignment-v1:sha256:${'a'.repeat(64)}`,
  };
  if (command === 'activate') return base;
  if (command === 'fail') return { ...base, status: 'canceled' };
  const completion = {
    ...base,
    result: {
      inputRevision: base.inputRevision,
      referenceRevision: preparation.run.reference.sequenceRevision,
      results: [
        {
          queryId: 'query-one',
          queryRevision: `pairwise-query-v1:sha256:${createHash('sha256').update(JSON.stringify('AACC')).digest('hex')}`,
          alignment: {
            aligned_query: 'AACC',
            aligned_reference: 'AACC',
            identity: 100,
            mutations: [],
            alignment_length: 4,
          },
        },
      ],
    },
  };
  if (command === 'state') {
    role('editor');
    await invoke('complete', completion);
    role('viewer');
    return {
      ...base,
      stateId: 'state-one',
      session: { ...base.session, archived: false },
      classifier: 'mutation-impact-v1',
      tracks: [
        {
          queryId: 'query-one',
          label: 'Read',
          alignment: {
            alignedReference: 'AACC',
            alignedQuery: 'AACC',
            identity: 100,
            coverageStart: 0,
            coverageEnd: 4,
            algorithm: 'auto',
          },
          mutations: [],
          status: 'pass',
          alignedAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
  }
  return completion;
}

function deferredIo() {
  let reached = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release, entered, resumed };
}

function demoteFromServer() {
  expect(
    updateWorkspaceSyncAccessRecord(host.db!, {
      workspaceId: 7,
      role: 'viewer',
      source: 'direct',
      nowMs: 2,
    })
  ).toBe(true);
}

const assetCommands = ['prepare', 'complete', 'state'] as const;
function firstNewAsset(command: (typeof assetCommands)[number]) {
  return join(
    packageRoot,
    'contents',
    'evidence',
    'run-one',
    command === 'prepare'
      ? 'reference.gb'
      : command === 'complete'
        ? 'result.json'
        : 'state-state-one.json'
  );
}

describe('shared evidence authority through actual IPC and package publishers', () => {
  it.each(assetCommands)(
    'rechecks %s after the actual temporary binary write before its first link',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const before = await snapshot();
      const gate = deferredIo();
      host.ioGate = {
        kind: 'write',
        prefix: `${firstNewAsset(command)}.tmp-`,
        reached: gate.reached,
        release: gate.resumed,
      };
      const pending = Promise.resolve(invoke(command, input));
      const outcome = pending.catch((error: unknown) => error);
      try {
        await gate.entered;
        demoteFromServer();
        gate.release();
        await expect(pending).rejects.toThrow(/shared project is view only/i);
        expect(await snapshot()).toEqual(before);
      } finally {
        gate.release();
        await outcome;
      }
    }
  );

  it.each(assetCommands)(
    'finishes committed %s when demoted during actual post-link cleanup and refuses the next IPC',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      const gate = deferredIo();
      host.ioGate = {
        kind: 'unlink',
        prefix: `${firstNewAsset(command)}.tmp-`,
        reached: gate.reached,
        release: gate.resumed,
      };
      const pending = Promise.resolve(invoke(command, input));
      const outcome = pending.catch((error: unknown) => error);
      try {
        await gate.entered;
        expect((await readFile(firstNewAsset(command))).length).toBeGreaterThan(0);
        demoteFromServer();
        gate.release();
        const prepared = await pending;
        if (command === 'prepare') {
          expect(prepared).toMatchObject({
            sourceRetirement: { status: 'retained', reason: 'view-only' },
          });
          expect(await readFile(queryPath, 'utf8')).toBe('>read\nAACC\n');
        }
        expect(await readFile(marker, 'utf8')).not.toBe(before);
        await expect(invoke(command, input)).rejects.toThrow(/shared project is view only/i);
      } finally {
        gate.release();
        await outcome;
      }
    }
  );

  it.each(assetCommands)(
    'keeps the original %s cleanup-warning success after a canonical link',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      const asset = firstNewAsset(command);
      host.afterLink = {
        path: asset,
        run() {
          host.unlinkFailurePrefix = `${asset}.tmp-`;
          demoteFromServer();
        },
      };
      const prepared = await invoke(command, input);
      if (command === 'prepare') {
        expect(prepared).toMatchObject({
          sourceRetirement: { status: 'retained', reason: 'view-only' },
        });
        expect(await readFile(queryPath, 'utf8')).toBe('>read\nAACC\n');
      }
      expect(await readFile(marker, 'utf8')).not.toBe(before);
      const files = await snapshot();
      expect(
        Object.keys(files).some((path) => path.includes(`${asset.split('/').at(-1)}.tmp-`))
      ).toBe(true);
      await expect(invoke(command, input)).rejects.toThrow(/shared project is view only/i);
    }
  );

  it.each(assetCommands)(
    'preserves %s post-link verification failure instead of acknowledging or masking it',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      const asset = firstNewAsset(command);
      host.afterLink = {
        path: asset,
        run() {
          demoteFromServer();
          host.readFailure = {
            path: asset,
            error: new Error('injected final artifact verification failure'),
          };
        },
      };
      await expect(invoke(command, input)).rejects.toThrow(
        'injected final artifact verification failure'
      );
      host.readFailure = undefined;
      expect((await readFile(asset)).length).toBeGreaterThan(0);
      expect(await readFile(marker, 'utf8')).toBe(before);
    }
  );

  it.each(assetCommands)(
    'preserves %s marker CAS conflict after actual asset publication and demotion',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      host.afterLink = {
        path: firstNewAsset(command),
        async run() {
          await writeFile(marker, `${before}\n`);
          demoteFromServer();
        },
      };
      await expect(invoke(command, input)).rejects.toThrow(/artifact changed since it was opened/i);
      expect(await readFile(marker, 'utf8')).toBe(`${before}\n`);
      expect((await readFile(firstNewAsset(command))).length).toBeGreaterThan(0);
    }
  );

  it.each(assetCommands)(
    'does not admit %s from identical orphan assets when demoted before final marker CAS',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      host.afterLink = {
        path: firstNewAsset(command),
        async run() {
          await writeFile(marker, `${before}\n`);
        },
      };
      await expect(invoke(command, input)).rejects.toThrow(/artifact changed since it was opened/i);
      await writeFile(marker, before);
      const orphanSnapshot = await snapshot();
      const gate = deferredIo();
      host.readGate = { path: marker, skipReads: 2, reached: gate.reached, release: gate.resumed };
      const pending = Promise.resolve(invoke(command, input));
      const outcome = pending.catch((error: unknown) => error);
      try {
        await gate.entered;
        demoteFromServer();
        gate.release();
        await expect(pending).rejects.toThrow(/shared project is view only/i);
        expect(await snapshot()).toEqual(orphanSnapshot);
      } finally {
        gate.release();
        await outcome;
      }
    }
  );

  it.each(assetCommands)(
    'does not acknowledge %s when an identical artifact wins the first-link race',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      const asset = firstNewAsset(command);
      const gate = deferredIo();
      host.ioGate = {
        kind: 'write',
        prefix: `${asset}.tmp-`,
        reached: gate.reached,
        release: gate.resumed,
      };
      const pending = Promise.resolve(invoke(command, input));
      const outcome = pending.catch((error: unknown) => error);
      try {
        await gate.entered;
        const files = await snapshot();
        const staged = Object.entries(files).find(([path]) =>
          join(packageRoot, path).startsWith(`${asset}.tmp-`)
        );
        if (!staged) throw new Error('Actual first binary temporary file is unavailable');
        await writeFile(asset, Buffer.from(staged[1], 'base64'));
        gate.release();
        await expect(pending).rejects.toThrow(/artifact already exists/i);
        expect(await readFile(marker, 'utf8')).toBe(before);
      } finally {
        gate.release();
        await outcome;
      }
    }
  );

  it.each(['activate', 'fail'] as const)(
    'acknowledges %s after actual final marker rename despite a later demotion',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      host.afterRename = { path: marker, run: demoteFromServer };
      await invoke(command, input);
      expect(await readFile(marker, 'utf8')).not.toBe(before);
      await expect(invoke(command, input)).rejects.toThrow(/shared project is view only/i);
    }
  );

  it.each(['activate', 'fail'] as const)(
    'rechecks %s at the final durable marker publication barrier',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const before = await snapshot();
      const gate = deferredIo();
      host.readGate = {
        path: sequencePackagePaths(packageRoot).metaPath,
        skipReads: 2,
        reached: gate.reached,
        release: gate.resumed,
      };
      const pending = Promise.resolve(invoke(command, input));
      const outcome = pending.catch((error: unknown) => error);
      try {
        await gate.entered;
        demoteFromServer();
        gate.release();
        await expect(pending).rejects.toThrow(/shared project is view only/i);
        expect(await snapshot()).toEqual(before);
      } finally {
        gate.release();
        await outcome;
      }
    }
  );

  it.each(assetCommands)(
    'preserves %s temporary partial effects when refusal cleanup itself fails',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      const asset = firstNewAsset(command);
      const gate = deferredIo();
      host.ioGate = {
        kind: 'write',
        prefix: `${asset}.tmp-`,
        reached: gate.reached,
        release: gate.resumed,
      };
      const pending = Promise.resolve(invoke(command, input));
      const outcome = pending.catch((error: unknown) => error);
      try {
        await gate.entered;
        demoteFromServer();
        host.unlinkFailurePrefix = `${asset}.tmp-`;
        gate.release();
        expect(await outcome).toMatchObject({
          message: expect.stringContaining('This shared project is view only.'),
          partialEffects: [
            {
              kind: 'temporary-workspace-file',
              path: expect.stringContaining(`${asset}.tmp-`),
              cleanupError: 'injected temporary cleanup failure',
            },
          ],
        });
        expect(await readFile(marker, 'utf8')).toBe(before);
        const files = await snapshot();
        expect(files[asset.slice(packageRoot.length + 1)]).toBeUndefined();
        expect(
          Object.keys(files).some((path) => join(packageRoot, path).startsWith(`${asset}.tmp-`))
        ).toBe(true);
      } finally {
        gate.release();
        await outcome;
      }
    }
  );

  it.each(Object.keys(channels) as Command[])(
    'preserves %s committed-marker durability uncertainty after demotion',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const marker = sequencePackagePaths(packageRoot).metaPath;
      const before = await readFile(marker, 'utf8');
      host.afterRename = {
        path: marker,
        run() {
          demoteFromServer();
          host.directoryFlushFailure = true;
        },
      };
      await expect(invoke(command, input)).rejects.toThrow(
        /published, but its directory flush failed.*injected directory flush failure/
      );
      expect(await readFile(marker, 'utf8')).not.toBe(before);
    }
  );
  it.each(Object.keys(channels) as Command[])(
    'refuses %s when the canonical role changes during owner I/O before publication',
    async (command) => {
      const input = await inputFor(command);
      role('editor');
      const before = await snapshot();
      let reachedRead = () => {};
      let releaseRead = () => {};
      const reached = new Promise<void>((resolve) => {
        reachedRead = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      host.readGate = {
        path: sequencePackagePaths(packageRoot).metaPath,
        reached: reachedRead,
        release,
      };
      const outcome = Promise.resolve(invoke(command, input)).then(
        (value) => ({ kind: 'accepted', value }),
        (error) => ({ kind: 'refused', message: String(error) })
      );
      try {
        await reached;
        expect(
          updateWorkspaceSyncAccessRecord(host.db!, {
            workspaceId: 7,
            role: 'viewer',
            source: 'direct',
            nowMs: 2,
          })
        ).toBe(true);
        releaseRead();
        expect(await outcome).toMatchObject({
          kind: 'refused',
          message: expect.stringContaining('This shared project is view only.'),
        });
        expect(await snapshot()).toEqual(before);
      } finally {
        releaseRead();
        await outcome;
      }
    }
  );
  it.each(Object.keys(channels) as Command[])(
    'refuses viewer %s and permits the identical request after promotion',
    async (command) => {
      const input = await inputFor(command);
      const before = await snapshot();
      await expect(invoke(command, input)).rejects.toThrow(/shared project is view only/i);
      expect(await snapshot()).toEqual(before);
      role('editor');
      await invoke(command, input);
      expect(await snapshot()).not.toEqual(before);
    }
  );
  it('rechecks a demotion while evidence preparation waits for the workspace lease', async () => {
    role('editor');
    const before = await snapshot();
    const release = await acquireWorkspaceMutationShared(root);
    const pending = Promise.resolve(invoke('prepare', request())).then(
      (value) => ({ kind: 'accepted', value }),
      (error) => ({ kind: 'refused', message: String(error) })
    );
    try {
      await vi.waitFor(() => expect(workspaceMutationWaiterCountForTest(root)).toBe(1));
      role('viewer');
      release();
      expect(await pending).toMatchObject({
        kind: 'refused',
        message: expect.stringContaining('This shared project is view only.'),
      });
      expect(await snapshot()).toEqual(before);
    } finally {
      release();
      await pending;
    }
  });
});

describe('native alignment query attachments', () => {
  it('attaches both full-length same-basename SNP clones and retains independent frozen locators and query identities', async () => {
    const {
      sequencePackageAttachTwoClones,
      SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH,
      SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH,
      SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH,
    } = await import('../../test/scenarios/sequence-package-attach');
    const scenario = sequencePackageAttachTwoClones();
    const reference = scenario.files?.[SEQUENCE_PACKAGE_ATTACH_PRODUCT_PATH];
    const clones = [
      scenario.files?.[SEQUENCE_PACKAGE_ATTACH_DROP_A_PATH],
      scenario.files?.[SEQUENCE_PACKAGE_ATTACH_DROP_B_PATH],
    ];
    if (typeof reference !== 'string' || clones.some((clone) => typeof clone !== 'string'))
      throw new Error('The real clone scenario did not provide text sequences.');
    await writeFile(sourcePath, reference);
    const inputs = [
      join(root, 'drop-inbox', 'a', 'clone-1.fasta'),
      join(root, 'drop-inbox', 'b', 'clone-1.fasta'),
    ];
    for (const [index, path] of inputs.entries()) {
      await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      const bytes = clones[index];
      if (typeof bytes !== 'string') throw new Error('A real SNP clone is missing.');
      await writeFile(path, bytes);
    }
    role('editor');
    const input = {
      ...request('real-clones'),
      queries: inputs.map((path, index) => ({
        id: `clone-query-${index}`,
        label: `Clone ${index + 1}`,
        path,
      })),
    };
    const prepared = await invoke('prepare', input);
    const canonical = [
      join(packageRoot, 'contents', 'clone-1.fasta'),
      join(packageRoot, 'contents', 'clone-1-2.fasta'),
    ];
    expect(prepared.run.queries.map((query: { id: string }) => query.id)).toEqual([
      'clone-query-0',
      'clone-query-1',
    ]);
    for (const [index, path] of canonical.entries()) {
      const id = input.queries[index].id;
      expect(prepared.attachedQueryPaths[id]).toBe(path);
      expect(prepared.queryPaths[id]).not.toBe(path);
      expect(await readFile(path, 'utf8')).toBe(clones[index]);
      expect(await readFile(prepared.queryPaths[id], 'utf8')).toBe(clones[index]);
      await expect(readFile(inputs[index])).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const markerPath = sequencePackagePaths(packageRoot).metaPath;
    const document = parseSequencePackageDocument(await readFile(markerPath, 'utf8'));
    expect(document.id).toBe(input.packageId);
    expect(
      document.members
        .filter((member) => member.role === 'sequencing-read')
        .map((member) => member.path)
        .sort()
    ).toEqual(['contents/clone-1.fasta', 'contents/clone-1-2.fasta'].sort());
    expect(await readFile(sourcePath, 'utf8')).toBe(reference);
    const recovery = join(root, '.git', 'dnaforge-file-trash');
    const recovered = await Promise.all(
      (await readdir(recovery)).map((name) => readFile(join(recovery, name, 'payload'), 'utf8'))
    );
    expect(recovered.sort()).toEqual([...clones].sort());
    const repeated = await invoke('prepare', input);
    expect(repeated.attachedQueryPaths).toEqual(prepared.attachedQueryPaths);
    expect(repeated.run.queries).toEqual(prepared.run.queries);
    expect(parseSequencePackageDocument(await readFile(markerPath, 'utf8')).members).toEqual(
      document.members
    );
  });

  it('refuses a foreign project query before changing either owner or consuming its bytes', async () => {
    const foreignRoot = join(root, 'Foreign project');
    const foreignPath = join(foreignRoot, 'clone-1.fasta');
    await mkdir(foreignRoot);
    await writeFile(foreignPath, '>foreign\nAACC\n');
    host
      .db!.prepare('INSERT INTO workspaces(id,name,path,repo_uuid,created_at) VALUES(8,?,?,?,1)')
      .run('Foreign owner', foreignRoot, 'foreign-evidence-owner');
    role('editor');
    const before = await snapshot();
    await expect(
      invoke('prepare', {
        ...request('foreign-query'),
        queries: [{ id: 'foreign-query', label: 'Foreign clone', path: foreignPath }],
      })
    ).rejects.toThrow('belongs to another project');
    expect(await snapshot()).toEqual(before);
    expect(await readFile(foreignPath, 'utf8')).toBe('>foreign\nAACC\n');
  });
});
