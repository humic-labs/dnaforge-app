// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto';
import { access, cp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreSavedFileSource, listSavedFileVersions } from './saved-file-sources';
import { tableCommandFixture, identityTestPaths } from './__tests__/table-command-fixture';
import { NativeTableDocumentCommands } from './table-document-commands';
import { publishTablePackageInMain, readTablePackageInMain } from './table-package';
import {
  parseTablePackageHead,
  parseTableSnapshot,
  serializeTableSnapshot,
} from '../shared/table-package';
import { richTableReference } from '../shared/table-document-reference';
import type { TableDocumentReference } from '../shared/table-document-reference';

vi.mock('electron', () => ({
  app: { getPath: (name: 'home' | 'userData') => identityTestPaths[name] },
}));
const fixtures: Awaited<ReturnType<typeof tableCommandFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
async function fixture() {
  const f = await tableCommandFixture();
  fixtures.push(f);
  return f;
}
function create(f: Awaited<ReturnType<typeof fixture>>, requestId = randomUUID()) {
  return {
    kind: 'create' as const,
    requestId,
    destination: { workspaceRoot: f.workspaceRoot, packageRoot: join(f.workspaceRoot, 'Samples') },
    title: 'Samples',
    rows: 2,
    columns: 2,
  };
}
async function created(f: Awaited<ReturnType<typeof fixture>>) {
  const request = create(f);
  const result = await f.commands.execute(request);
  if (result.kind !== 'created' || result.table.owner.kind !== 'file')
    throw new Error('Native create did not produce a real file owner');
  return { request, table: result.table, owner: result.table.owner };
}
async function resolve(f: Awaited<ReturnType<typeof fixture>>, reference: TableDocumentReference) {
  const result = await f.commands.execute({ kind: 'resolve', reference });
  if (result.kind !== 'resolved') throw new Error('Expected a resolved native table');
  return result.table;
}

describe('native table document commands', () => {
  it('opens a verified package through the same portable resolver and permits reference-only viewing', async () => {
    const f = await fixture();
    const made = await created(f);
    const before = await readTablePackageInMain(made.request.destination);
    f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE path=?").run(f.workspaceRoot);
    const opened = await f.commands.execute({ kind: 'open', location: made.request.destination });
    if (opened.kind !== 'resolved') throw new Error('Expected a resolved read-only table');
    expect(opened.table.reference.documentId).toBe(made.table.reference.documentId);
    expect(opened.table.readOnly).toBe(true);
    expect((await readTablePackageInMain(made.request.destination)).headText).toBe(before.headText);
  });

  it('does not silently adopt a directly opened table in an unmarked project', async () => {
    const f = await fixture();
    const id = randomUUID();
    const snapshot = parseTableSnapshot(
      JSON.stringify({
        schema: 'dnaforge.table-snapshot.v1',
        documentId: id,
        title: 'External table',
        data: { rows: 1, cols: 1, cells: [] },
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
    const location = {
      workspaceRoot: f.workspaceRoot,
      packageRoot: join(f.workspaceRoot, 'External table'),
    };
    await publishTablePackageInMain({ ...location, head, mode: 'create' }, { assertCurrent() {} });
    const before = await readTablePackageInMain(location);
    await expect(f.commands.execute({ kind: 'open', location })).rejects.toThrow();
    await expect(access(join(f.workspaceRoot, '.forge', 'project.json'))).rejects.toThrow();
    expect((await readTablePackageInMain(location)).headText).toBe(before.headText);
  });

  it('refuses an explicit path open when the project contains duplicate table UUID claims', async () => {
    const f = await fixture();
    const made = await created(f);
    await cp(made.request.destination.packageRoot, join(f.workspaceRoot, 'Duplicate table'), {
      recursive: true,
    });
    await expect(
      f.commands.execute({ kind: 'open', location: made.request.destination })
    ).rejects.toThrow();
  });

  it('recovers the first acknowledged table after loss of its entire package directory', async () => {
    const f = await fixture();
    const made = await created(f);
    const destination = made.request.destination;
    const original = await readTablePackageInMain(destination);
    const workspaceId = f.db
      .prepare('SELECT id FROM workspaces WHERE path=?')
      .pluck()
      .get(f.workspaceRoot) as number;
    const owner = { workspaceId, entityId: made.table.tableId };
    const receipts = listSavedFileVersions(f.db, { ...owner, offset: 0, limit: 10 }).versions;
    expect(receipts).toHaveLength(1);
    await rm(destination.packageRoot, { recursive: true });
    await restoreSavedFileSource(f.db, {
      ...owner,
      destination: destination.packageRoot,
      revisionId: receipts[0].id,
    });
    const restored = await readTablePackageInMain({
      ...destination,
      expectedDocumentId: owner.entityId,
    });
    expect(restored.headText).toBe(original.headText);
    expect(restored.snapshotText).toBe(original.snapshotText);
  });

  it('creates a real package once and reuses its durable identity after command-service restart', async () => {
    const f = await fixture();
    const made = await created(f);
    const before = await readTablePackageInMain(made.request.destination);
    const restarted = new NativeTableDocumentCommands(f.options);
    const again = await restarted.execute(made.request);
    expect(again.kind).toBe('created');
    if (again.kind !== 'created') throw new Error('The exact create retry was not acknowledged');
    expect(again.table.reference).toEqual(made.table.reference);
    expect((await readTablePackageInMain(made.request.destination)).headText).toBe(before.headText);
    await expect(
      restarted.execute({ ...made.request, title: 'Changed arguments' })
    ).rejects.toThrow();
    expect((await readTablePackageInMain(made.request.destination)).headText).toBe(before.headText);
  });

  it('resolves the same portable table after a clean folder move despite stale profile and path hints', async () => {
    const f = await fixture();
    const made = await created(f);
    const moved = join(f.workspaceRoot, 'Renamed');
    await rename(made.request.destination.packageRoot, moved);
    const ref = made.table.reference;
    if (ref.backing.kind !== 'rich-file')
      throw new Error('Expected a portable rich table reference');
    const hinted = richTableReference(ref.backing.projectId, ref.backing.tableId, ref.binding, {
      fileDocumentId: 'stale-profile-file',
      pathHint: 'missing/Old name',
    });
    const actual = await resolve(f, hinted);
    expect(actual.tableId).toBe(made.table.tableId);
    expect(actual.owner.kind).toBe('file');
    if (actual.owner.kind === 'file') expect(actual.owner.path).toContain('Renamed');
  });

  it('pins a verified saved snapshot and keeps it frozen after later edits and Save', async () => {
    const f = await fixture();
    const made = await created(f);
    const initial = await f.inspect(made.owner.path);
    const pinned = await f.commands.execute({
      kind: 'pin',
      requestId: randomUUID(),
      reference: made.table.reference,
      expectedRevision: initial.revision,
    });
    if (pinned.kind !== 'pinned') throw new Error('Expected a saved-version reference');
    const before = await resolve(f, pinned.reference);
    expect(before).toMatchObject({ readOnly: true, owner: { kind: 'saved-version' } });
    const changed = await f.files.execute({
      target: { documentId: initial.documentId },
      expectedRevision: initial.revision,
      operation: {
        kind: 'table',
        command: { kind: 'set-cell', row: 0, column: 0, value: 'later value' },
      },
    });
    await expect(
      f.commands.execute({
        kind: 'pin',
        requestId: randomUUID(),
        reference: made.table.reference,
        expectedRevision: changed.revision,
      })
    ).rejects.toThrow();
    await f.files.execute({
      target: { documentId: changed.documentId },
      expectedRevision: changed.revision,
      operation: { kind: 'save' },
    });
    const after = await resolve(f, pinned.reference);
    expect(after.owner).toEqual(before.owner);
    expect(after.readOnly).toBe(true);
  });

  it('copies a verified table under a new identity without copying its aliases or changing the original', async () => {
    const f = await fixture();
    const made = await created(f);
    const old = await readTablePackageInMain(made.request.destination);
    const copy = await f.commands.execute({
      kind: 'copy',
      requestId: randomUUID(),
      source: made.table.reference,
      expectedRevision: (await f.inspect(made.owner.path)).revision,
      destination: {
        workspaceRoot: f.workspaceRoot,
        packageRoot: join(f.workspaceRoot, 'Independent copy'),
      },
    });
    if (copy.kind !== 'created') throw new Error('Expected an independent copied table');
    const actual = await readTablePackageInMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: join(f.workspaceRoot, 'Independent copy'),
    });
    expect(actual.head.id).not.toBe(old.head.id);
    expect(actual.head.aliases).toEqual([]);
    expect(actual.head.snapshot.data).toEqual(old.head.snapshot.data);
    expect(actual.head.origin).toMatchObject({
      tableId: old.head.id,
      snapshotSha256: old.head.snapshotSha256,
    });
    expect((await readTablePackageInMain(made.request.destination)).headText).toBe(old.headText);
  });

  it('refuses duplicate package identity claims instead of choosing a first match', async () => {
    const f = await fixture();
    const made = await created(f);
    const original = await readTablePackageInMain(made.request.destination);
    await cp(made.request.destination.packageRoot, join(f.workspaceRoot, 'Unannounced duplicate'), {
      recursive: true,
    });
    await expect(
      f.commands.execute({ kind: 'resolve', reference: made.table.reference })
    ).rejects.toThrow();
    expect((await readTablePackageInMain(made.request.destination)).headText).toBe(
      original.headText
    );
  });

  it('refuses read-only mutation without creating a package or Git identity', async () => {
    const f = await fixture();
    const request = create(f);
    f.db.prepare("UPDATE workspaces SET access_mode='reference' WHERE path=?").run(f.workspaceRoot);
    await expect(f.commands.execute(request)).rejects.toThrow();
    await expect(access(request.destination.packageRoot)).rejects.toThrow();
    await expect(access(join(f.workspaceRoot, '.git'))).rejects.toThrow();
  });

  it('retains a published package through catalog failure and settles the same create request', async () => {
    const f = await fixture();
    const request = create(f);
    f.failReconcile(true);
    const attempt = await f.commands.execute(request).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    if ('result' in attempt) expect(attempt.result.kind).not.toBe('created');
    const published = await readTablePackageInMain(request.destination);
    f.failReconcile(false);
    const result = await new NativeTableDocumentCommands(f.options).execute(request);
    if (result.kind !== 'created')
      throw new Error('Expected exact retry to finish catalog reconciliation');
    expect(result.table.tableId).toBe(published.head.id);
    expect((await readTablePackageInMain(request.destination)).headText).toBe(published.headText);
  });
});
