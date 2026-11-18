import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineBlob, parseResourceId } from '@waypoint/workspace-revisions';
import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { ScientificObjectStore } from './scientific-object-store';
import { submitScientificObjectInMain } from './scientific-object-commands';
import { submitScientificWorkspace } from './scientific-workspace-service';
import * as recovery from './scientific-migration-recovery';
import { scientificRecoveryDirectory } from './scientific-recovery-checkpoint';
import { readdir } from 'node:fs/promises';
import { buildSequencePackageDocument } from '../db/sequence-package';
import { scientificDesignSetupRequestSchema } from '../shared/scientific-design-setup';
import { submitScientificChangesSchema } from '../shared/scientific-file-submission';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
  shell: { trashItem: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./dirty-state-cache', () => ({
  getDirtyState: () => ({ hasDirtyWork: false, details: '' }),
}));

const originalCheckpoint = recovery.ensureScientificEnrollmentCheckpoint;
const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.spyOn(recovery, 'ensureScientificEnrollmentCheckpoint').mockImplementation((db, id) =>
    originalCheckpoint(db, id, { openDatabase: openFileTestDb })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

async function fixture() {
  const file = createFileTestDb('scientific-setup');
  cleanup.push(file.cleanup);
  ensureSchema(file.db, file.dbPath);
  const root = join(await realpath(file.tmpDir), 'project');
  await mkdir(root);
  await writeFile(join(root, 'old.txt'), 'Keep the existing project bytes.\n');
  const project = '1bd8e99d-c5ed-46e7-a8ec-bf56b54e5de8';
  const workspaceId = Number(
    file.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,?)')
      .run('Science', root, project, 1).lastInsertRowid
  );
  const store = new ScientificObjectStore(file.db, workspaceId);
  const request = scientificDesignSetupRequestSchema.parse({
    workspaceRoot: root,
    request: {
      workspace: parseWorkspaceIdentity(project),
      operationId: 'initialize-once',
      expectedHead: null,
      source: { kind: 'initialize-empty-namespace' },
    },
  });
  const submit = (input = request, options?: Parameters<typeof submitScientificObjectInMain>[2]) =>
    submitScientificObjectInMain(file.db, input, options);
  return { ...file, root, project, workspaceId, store, request, submit };
}

it('retains a real empty checkpoint and original setup after full native DNA publication and reopen', async () => {
  const f = await fixture();
  const first = await f.submit();
  expect(first).toMatchObject({
    replayed: false,
    receipt: { outcome: 'changed' },
    delivery: { kind: 'complete' },
  });
  expect(f.store.read().reader.listCurrent()).toEqual([]);
  const mapPath = join(f.root, scientificIdentityPath);
  expect(JSON.parse(await readFile(mapPath, 'utf8'))).toMatchObject({
    formatVersion: 1,
    entries: [],
  });
  const checkpoints = (await readdir(scientificRecoveryDirectory(f.db))).filter(
    (name) => !name.endsWith('.pending')
  );
  expect(checkpoints).toHaveLength(1);
  const checkpoint = await recovery.listScientificRecoveryCheckpoints(f.db, f.workspaceId, {
    openDatabase: openFileTestDb,
  });
  expect(checkpoint).toHaveLength(1);
  expect(checkpoint[0]).toMatchObject({ kind: 'pre-enrollment', acceptedHead: null });
  const text = serializeGenBank({
    id: 'new-design',
    name: 'New design',
    sequence: 'ACGT',
    length: 4,
    circular: false,
    annotations: [],
  });
  const metadata = buildSequencePackageDocument({
    id: 'new-design',
    name: 'New design',
    product: {
      file: 'product.gb',
      genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
    },
  });
  const design = await submitScientificWorkspace({
    db: f.db,
    workspaceId: f.workspaceId,
    request: {
      operationId: 'create-complete-package',
      expectedHead: f.store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: metadata.id,
          path: 'New design/product.gb',
          representation: { format: 'genbank-v1', text },
          sequencePackageText: JSON.stringify(metadata),
        },
      },
    },
  });
  expect(design.delivery?.kind).toBe('complete');
  const latest = f.store.read().head;
  const map = await readFile(mapPath, 'utf8');
  expect(JSON.parse(map)).toMatchObject({
    formatVersion: 2,
    entries: [{ resourceId: 'new-design', format: 'genbank-v1' }],
  });
  const replay = await f.submit();
  expect(replay).toMatchObject({
    replayed: true,
    receipt: first.receipt,
    currentHead: latest,
    delivery: { kind: 'complete' },
  });
  expect(await readFile(mapPath, 'utf8')).toBe(map);
  expect(await readFile(join(f.root, 'New design/.forge/plasmid.json'), 'utf8')).toBe(
    JSON.stringify(metadata)
  );
  expect(await readFile(join(f.root, 'old.txt'), 'utf8')).toBe(
    'Keep the existing project bytes.\n'
  );
  const reopened = openFileTestDb(f.dbPath);
  cleanup.push(() => reopened.close());
  const resourceId = parseResourceId('new-design');
  if (!resourceId.ok) throw Error('Invalid fixture ID.');
  expect(
    new ScientificObjectStore(reopened, f.workspaceId).read().reader.current(resourceId.value)
      ?.representation?.text
  ).toBe(text);
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='inventory_journal'").get()
  ).toEqual({ n: 0 });
});

it('refuses authored maps and strict-purpose extras before acceptance and distinguishes old document operations', async () => {
  const f = await fixture();
  await mkdir(join(f.root, '.dnaforge'));
  const path = join(f.root, scientificIdentityPath);
  await writeFile(path, '{"authored":"preserve"}\n');
  await expect(f.submit()).rejects.toThrow(/identity map|namespace/u);
  expect(f.store.read().head).toBeNull();
  expect(await readFile(path, 'utf8')).toBe('{"authored":"preserve"}\n');
  expect(recovery.ensureScientificEnrollmentCheckpoint).not.toHaveBeenCalled();
  expect(
    scientificDesignSetupRequestSchema.safeParse({
      ...f.request,
      request: {
        ...f.request.request,
        source: { kind: 'initialize-empty-namespace', entries: [] },
      },
    }).success
  ).toBe(false);
  expect(
    submitScientificChangesSchema.safeParse({
      expectedHead: null,
      initializeEmptyNamespace: true,
      gitCommit: 'a'.repeat(40),
    }).success
  ).toBe(false);
  const g = await fixture();
  await submitScientificWorkspace({
    db: g.db,
    workspaceId: g.workspaceId,
    request: {
      operationId: g.request.request.operationId,
      expectedHead: null,
      source: { kind: 'documents', entries: [] },
    },
  });
  const before = g.store.exportHistory();
  const incompatible = await g.submit();
  expect(incompatible).toMatchObject({
    replayed: false,
    receipt: { outcome: 'rejected', error: { kind: 'operation-id-reused' } },
    delivery: null,
  });
  expect(g.store.exportHistory()).toEqual(before);
});

it('keeps accepted delivery pending across a post-acceptance file race and resumes the exact original', async () => {
  const f = await fixture();
  const map = join(f.root, scientificIdentityPath);
  let raced = false;
  const result = await f.submit(f.request, {
    beforePublish: () => {
      if (f.db.inTransaction || raced || f.store.read().head === null) return;
      raced = true;
      const fs = require('node:fs') as typeof import('node:fs');
      fs.writeFileSync(map, 'External authored map.\n');
    },
  });
  expect(result).toMatchObject({ receipt: { outcome: 'changed' }, delivery: { kind: 'blocked' } });
  expect(await readFile(map, 'utf8')).toBe('External authored map.\n');
  const head = f.store.read().head;
  const fs = await import('node:fs/promises');
  await fs.unlink(map);
  const replay = await f.submit();
  expect(replay).toMatchObject({
    replayed: true,
    receipt: result.receipt,
    currentHead: head,
    delivery: { kind: 'complete' },
  });
});

it('refuses changed write scope and symlink parents and conflicts rather than clearing a newer head', async () => {
  const f = await fixture();
  await expect(
    f.submit(f.request, {
      beforeAccept: () => {
        f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(f.workspaceId);
      },
    })
  ).rejects.toThrow(/read-only|authority/u);
  expect(f.store.read().head).toBeNull();
  f.db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=?").run(f.workspaceId);
  await f.submit();
  const head = f.store.read().head;
  const fresh = await f.submit({
    ...f.request,
    request: { ...f.request.request, operationId: 'fresh-null-request' },
  });
  expect(fresh).toMatchObject({ receipt: { outcome: 'conflict' }, currentHead: head });
  const g = await fixture();
  await mkdir(join(g.root, 'elsewhere'));
  await symlink(join(g.root, 'elsewhere'), join(g.root, '.dnaforge'));
  await expect(g.submit()).rejects.toThrow(/symbolic|directory/u);
  expect(g.store.read().head).toBeNull();
});
