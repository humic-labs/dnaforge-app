import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastaKindAuthority, FastaKindReadAuthority } from '../../shared/fasta-kind';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: null as (EventEmitter & { id: number }) | null,
  probes: [] as string[],
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const checkedRealpath = (...args: unknown[]) => {
    state.probes.push(String(args[0]));
    return Reflect.apply(actual.realpathSync, actual, args);
  };
  return {
    ...actual,
    realpathSync: Object.assign(checkedRealpath, { native: actual.realpathSync.native }),
  };
});
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  app: { getPath: () => '/tmp', getVersion: () => 'test', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));

import { createFileTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerDatabaseHandlers } from '../ipc/database';
import { ensureWorkspaceOwnerInDb } from '../catalog-projection-commands';
import { registerWorkspaceFileInDb } from '../catalog-entity-registration';

let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
let ownerId: number;
function call<T>(name: string, ...args: unknown[]): Promise<T> {
  return Promise.resolve().then(() => {
    const handler = state.handlers.get(`db:${name}`);
    if (!handler) throw new Error(`Missing native handler: ${name}`);
    return handler({ sender: state.sender }, ...args) as T;
  });
}
function source(name = 'Legacy.faa', fileKind = 'fasta') {
  const path = join(root, name);
  writeFileSync(path, '>Legacy\nMKTW\n');
  const entity = registerWorkspaceFileInDb(fixture.db, {
    path,
    workspaceRoot: root,
    entityType: 'sequence',
    fileKind,
  });
  const binding = fixture.db
    .prepare('SELECT id,object_uuid FROM catalog_entity_files WHERE entity_id=?')
    .get(entity.id) as { id: string; object_uuid: string };
  return { path, entity, binding };
}
function snapshot() {
  return ['catalog_entities', 'catalog_entity_files', 'catalog_entity_events'].map((table) =>
    fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  );
}
beforeEach(() => {
  fixture = createFileTestDb('fasta-native-binding');
  mkdirSync(join(fixture.tmpDir, 'Project'));
  root = realpathSync(join(fixture.tmpDir, 'Project'));
  ensureSchema(fixture.db, fixture.dbPath);
  ownerId = ensureWorkspaceOwnerInDb(fixture.db, root);
  state.handlers.clear();
  state.sender = Object.assign(new EventEmitter(), { id: 366179 });
  registerDatabaseHandlers(() => fixture.db);
});
afterEach(() => {
  state.sender?.removeAllListeners();
  state.probes = [];
  fixture.cleanup();
});

describe('native FASTA binding representation and bounded authority lookup', () => {
  it.each(['inspect', 'classify'] as const)(
    'refuses a non-FASTA binding through direct native %s despite a .faa filename',
    async (method) => {
      const current = source('Mislabelled.faa', 'genbank');
      const before = snapshot();
      const input = { path: current.path, workspaceRoot: root };
      await expect(
        method === 'inspect'
          ? call('getFastaKindAuthority', input)
          : call('classifyFasta', { ...input, kind: 'protein', expectedRevision: '0'.repeat(64) })
      ).rejects.toThrow('FASTA_KIND_REPRESENTATION_MISMATCH');
      expect(snapshot()).toEqual(before);
      expect(readFileSync(current.path, 'utf8')).toBe('>Legacy\nMKTW\n');
    }
  );

  it('does not probe an unrelated current source while reading one FASTA presentation authority', async () => {
    const current = source();
    const unrelated = source('Unrelated.faa');
    state.probes = [];
    await expect(
      call('getFastaKindReadAuthority', { path: current.path, workspaceRoot: root })
    ).resolves.toMatchObject({ entityId: current.entity.id, status: 'needs-classification' });
    expect(state.probes).not.toContain(unrelated.path);
  });

  it('preserves checked physical project-root aliases without scanning other file paths', async () => {
    const current = source();
    const alias = join(fixture.tmpDir, 'Project alias');
    symlinkSync(root, alias);
    fixture.db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(alias, ownerId);
    fixture.db
      .prepare('UPDATE catalog_entity_files SET path=? WHERE id=?')
      .run(join(alias, 'Legacy.faa'), current.binding.id);
    const authority = await call<FastaKindReadAuthority>('getFastaKindReadAuthority', {
      path: current.path,
      workspaceRoot: root,
    });
    expect(authority).toMatchObject({
      entityId: current.entity.id,
      bindingId: current.binding.id,
      objectUuid: current.binding.object_uuid,
      workspaceRoot: alias,
      status: 'needs-classification',
    });
  });

  it('refuses duplicate native owners for one physical project root', async () => {
    const current = source();
    const alias = join(fixture.tmpDir, 'Project duplicate');
    symlinkSync(root, alias);
    fixture.db
      .prepare('INSERT INTO workspaces(name,path,created_at,access_mode) VALUES(?,?,1,?)')
      .run('Duplicate', alias, 'writable');
    await expect(
      call('getFastaKindReadAuthority', { path: current.path, workspaceRoot: root })
    ).rejects.toThrow('FASTA_KIND_OWNER_AMBIGUOUS');
  });

  it('repairs an old cached kind only through a matching checked canonical manifest and normal classification', async () => {
    const current = source();
    mkdirSync(join(root, '.forge'));
    writeFileSync(
      join(root, '.forge/catalog.json'),
      JSON.stringify({
        schema: 'dnaforge.native-workspace-manifest.v1',
        entities: [
          {
            id: current.entity.id,
            type: 'protein',
            name: 'Canonical protein',
            path: 'Legacy.faa',
            fileKind: 'fasta',
          },
        ],
        links: [],
      })
    );
    const before = snapshot();
    const inspected = await call<FastaKindAuthority>('getFastaKindAuthority', {
      path: current.path,
      workspaceRoot: root,
    });
    expect(inspected).toMatchObject({
      status: 'declared',
      kind: 'protein',
      authority: 'canonical-source',
    });
    expect(inspected.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot()).toEqual(before);
    await expect(
      call('classifyFasta', {
        path: current.path,
        workspaceRoot: root,
        kind: 'sequence',
        expectedRevision: inspected.revision,
      })
    ).rejects.toThrow('FASTA_KIND_SCHEMA_CONFLICT');
    expect(snapshot()).toEqual(before);
    await expect(
      call('classifyFasta', {
        path: current.path,
        workspaceRoot: root,
        kind: 'protein',
        expectedRevision: inspected.revision,
      })
    ).resolves.toMatchObject({
      status: 'declared',
      kind: 'protein',
      entityId: current.entity.id,
      bindingId: current.binding.id,
      objectUuid: current.binding.object_uuid,
    });
    expect(
      fixture.db.prepare('SELECT type FROM catalog_entities WHERE id=?').get(current.entity.id)
    ).toEqual({ type: 'protein' });
    expect(readFileSync(current.path, 'utf8')).toBe('>Legacy\nMKTW\n');
  });
});
