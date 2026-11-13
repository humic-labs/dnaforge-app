import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import {
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
} from '@waypoint/workspace-revisions';
vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
  shell: { trashItem: vi.fn(async (path: string) => rm(path, { recursive: true })) },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
import { ensureSchema } from './schema';
import { ScientificObjectStore } from './scientific-object-store';
import { materializeScientificWorkspace } from './scientific-object-materializer';
import { reconcileScientificProjections } from './scientific-projection-service';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const must = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }) => {
  if (!value.ok) throw Error(JSON.stringify(value.error));
  return value.value;
};
const id = (value: string) => must(parseResourceId(value));
const doc = {
  formatVersion: 1,
  kind: 'primer',
  name: 'PCR primer',
  molecule: 'DNA',
  bases: 'ACGT',
  modifications: [],
  fields: {},
};
async function fixture() {
  const file = createFileTestDb('scientific-materialization');
  cleanups.push(file.cleanup);
  ensureSchema(file.db, file.dbPath);
  const root = join(file.tmpDir, 'project');
  await mkdir(root);
  const workspaceId = Number(
    file.db
      .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?)')
      .run('Science', root, 'scientific-materialization', 1).lastInsertRowid
  );
  const store = new ScientificObjectStore(file.db, workspaceId);
  const first = defineScientificDocument(doc),
    second = defineScientificDocument({ ...doc, name: 'Second' });
  const result = store.submit({
    operationId: must(parseOperationId('initial')),
    expectedHead: null,
    mutations: [
      {
        kind: 'create-resource',
        resourceId: id('first'),
        path: must(parseWorkspacePath('primers/first.json')),
        state: first.state,
        origin: { kind: 'created' },
      },
      {
        kind: 'create-resource',
        resourceId: id('second'),
        path: must(parseWorkspacePath('primers/second.json')),
        state: second.state,
        origin: { kind: 'created' },
      },
    ],
    blobs: [new TextEncoder().encode(first.text), new TextEncoder().encode(second.text)],
  });
  if (result.kind !== 'changed') throw Error('Fixture acceptance');
  return { ...file, root, workspaceId, store, result, first, second };
}

describe('accepted scientific file completion', () => {
  it('writes accepted bytes durably and records completion without accepting another version', async () => {
    const f = await fixture(),
      head = f.store.read().head;
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({
      kind: 'complete',
      completedVersions: [f.result.version.id],
    });
    expect(await readFile(join(f.root, 'primers/first.json'), 'utf8')).toBe(f.first.text);
    expect(await readFile(join(f.root, 'primers/second.json'), 'utf8')).toBe(f.second.text);
    expect(f.store.pendingMaterializations()).toHaveLength(0);
    expect(f.store.read().head).toBe(head);
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({
      kind: 'complete',
      completedVersions: [],
    });
  });
  it('resumes an interrupted delivery after reopening without duplicating or losing the accepted state', async () => {
    const f = await fixture();
    let calls = 0;
    const interrupted = await materializeScientificWorkspace(f.store, {
      afterFile: () => {
        if (++calls === 1) throw Error('process interrupted');
      },
    });
    expect(interrupted).toMatchObject({ kind: 'blocked', error: 'process interrupted' });
    expect(f.store.read().head).toBe(f.result.version.id);
    expect(f.store.pendingMaterializations()[0]?.status).toBe('blocked');
    f.db.close();
    const db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    const reopened = new ScientificObjectStore(db, f.workspaceId);
    await reconcileScientificProjections({ db, workspaceId: f.workspaceId });
    expect(await readFile(join(f.root, 'primers/second.json'), 'utf8')).toBe(f.second.text);
    expect(reopened.pendingMaterializations()).toHaveLength(0);
  });
  it('preserves an unsubmitted working edit and reports accepted but blocked file completion', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'primers'));
    const working = 'unsubmitted scientific work';
    await writeFile(join(f.root, 'primers/first.json'), working);
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({ kind: 'blocked' });
    expect(await readFile(join(f.root, 'primers/first.json'), 'utf8')).toBe(working);
    expect(f.store.read().reader.current(id('first'))?.document).toEqual(doc);
    expect(f.store.read().head).toBe(f.result.version.id);
    await expect(
      reconcileScientificProjections({ db: f.db, workspaceId: f.workspaceId })
    ).rejects.toThrow('Accepted scientific file delivery is pending');
    expect(await readFile(join(f.root, 'primers/first.json'), 'utf8')).toBe(working);
  });
  it('refuses a symlink escape before writing any accepted payload outside the project', async () => {
    const f = await fixture(),
      outside = join(f.tmpDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(f.root, 'primers'));
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({ kind: 'blocked' });
    await expect(readFile(join(outside, 'first.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.store.pendingMaterializations()[0]?.status).toBe('blocked');
  });
  it('delivers successive accepted edits in order, then preserves an unrelated later working edit', async () => {
    const f = await fixture(),
      before = f.store.read().reader.current(id('first'))!;
    const edited = defineScientificDocument({ ...doc, bases: 'TTTT' });
    f.store.submit({
      operationId: must(parseOperationId('edit')),
      expectedHead: f.result.version.id,
      mutations: [
        {
          kind: 'edit-resource',
          resourceId: id('first'),
          expectedRevision: before.revisionId,
          state: edited.state,
        },
      ],
      blobs: [new TextEncoder().encode(edited.text)],
    });
    const delivered = await materializeScientificWorkspace(f.store);
    expect(delivered, JSON.stringify(delivered)).toMatchObject({ kind: 'complete' });
    expect(await readFile(join(f.root, 'primers/first.json'), 'utf8')).toBe(edited.text);
    await writeFile(join(f.root, 'primers/first.json'), 'later working change');
    await materializeScientificWorkspace(f.store);
    expect(await readFile(join(f.root, 'primers/first.json'), 'utf8')).toBe('later working change');
  });
  it('completes a readonly file left after interruption through an independently owned durable replacement', async () => {
    const f = await fixture();
    await materializeScientificWorkspace(f.store, {
      afterFile: () => {
        throw Error('interrupted before progress');
      },
    });
    await chmod(join(f.root, 'primers/first.json'), 0o444);
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({ kind: 'complete' });
    expect(await readFile(join(f.root, 'primers/first.json'), 'utf8')).toBe(f.first.text);
    expect(f.store.read().head).toBe(f.result.version.id);
  });
  it('delivers a move and removal while retaining exact historical scientific identity', async () => {
    const f = await fixture();
    await materializeScientificWorkspace(f.store);
    const before = f.store.read(),
      first = before.reader.current(id('first'))!,
      second = before.reader.current(id('second'))!;
    const result = f.store.submit({
      operationId: must(parseOperationId('move-remove')),
      expectedHead: before.head,
      mutations: [
        {
          kind: 'move-resource',
          resourceId: id('first'),
          expectedPath: must(parseWorkspacePath('primers/first.json')),
          destination: must(parseWorkspacePath('archive/first.json')),
        },
        {
          kind: 'remove-membership',
          resourceId: id('second'),
          expectedRevision: second.revisionId,
          expectedPath: must(parseWorkspacePath('primers/second.json')),
        },
      ],
      blobs: [],
    });
    expect(result.kind).toBe('changed');
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({ kind: 'complete' });
    expect(await readFile(join(f.root, 'archive/first.json'), 'utf8')).toBe(f.first.text);
    await expect(readFile(join(f.root, 'primers/first.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(f.root, 'primers/second.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(f.store.read().reader.current(id('first'))?.resourceId).toBe(first.resourceId);
    expect(f.store.read().reader.current(id('second'))).toBeNull();
    expect(f.store.read().reader.revision(second)?.document).toEqual(second.document);
  });
  it('blocks a modified outbox manifest before it can deliver an unaccepted path', async () => {
    const f = await fixture(),
      job = f.store.pendingMaterializations()[0]!;
    const manifest = JSON.parse(job.manifest_json);
    manifest.files[0].path = 'unaccepted.json';
    f.db
      .prepare(
        'UPDATE scientific_materialization_jobs SET manifest_json = ? WHERE workspace_id = ?'
      )
      .run(JSON.stringify(manifest), f.workspaceId);
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({
      kind: 'blocked',
      error: 'Scientific file delivery differs from its accepted version.',
    });
    await expect(readFile(join(f.root, 'unaccepted.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(f.store.read().head).toBe(f.result.version.id);
  });
});
