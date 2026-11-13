import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: null as (EventEmitter & { id: number }) | null,
  leaseReached: null as (() => void) | null,
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      native.handlers.set(channel, handler),
  },
  app: { getPath: () => '/tmp', getVersion: () => 'test', on: vi.fn(), exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../ipc/workspace-mutation-authority', async (original) => {
  const actual = await original<typeof import('../ipc/workspace-mutation-authority')>();
  return {
    ...actual,
    withDeclaredRendererWorkspaceMutation: async (
      input: Parameters<typeof actual.withDeclaredRendererWorkspaceMutation>[0]
    ) => {
      native.leaseReached?.();
      return actual.withDeclaredRendererWorkspaceMutation(input);
    },
  };
});

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerDatabaseHandlers } from '../ipc/database';
import {
  ensureWorkspaceOwnerInDb,
  clearCatalogProjectionInDb,
} from '../catalog-projection-commands';
import { registerWorkspaceFileInDb } from '../catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import { acquireWorkspaceSyncMutationLease } from '../workspace-sync-mutation-lease';
import * as contentHash from '../content-hash';
import {
  FASTA_KIND_DECLARATION_EVENT,
  type FastaKind,
  type FastaKindAuthority,
  type FastaKindReadAuthority,
} from '../../shared/fasta-kind';

let db: Database.Database;
let root: string;
let workspaceId: number;
function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return Promise.resolve().then(() =>
    native.handlers.get(`db:${method}`)!({ sender: native.sender }, ...args)
  ) as Promise<T>;
}
function declarations(entityId: string) {
  return db
    .prepare(
      'SELECT * FROM catalog_entity_events WHERE entity_id=? AND event_type=? ORDER BY rowid'
    )
    .all(entityId, FASTA_KIND_DECLARATION_EVENT);
}
function generic(name = 'Legacy.faa', type: FastaKind = 'sequence') {
  const path = join(root, name);
  writeFileSync(path, '>legacy\nMKTW\n');
  const entity = registerWorkspaceFileInDb(db, {
    path,
    workspaceRoot: root,
    entityType: type,
    fileKind: 'fasta',
    metadata: { discoveredFrom: 'git-indexer', kindAuthority: 'declared', moleculeType: 'DNA' },
  });
  const file = db
    .prepare('SELECT * FROM catalog_entity_files WHERE entity_id=?')
    .get(entity.id) as { id: string; object_uuid: string };
  return { path, entity, file };
}
async function inspect(path: string) {
  return call<FastaKindAuthority>('getFastaKindAuthority', { path, workspaceRoot: root });
}
async function classify(path: string, kind: FastaKind, revision: string) {
  return call<FastaKindAuthority>('classifyFasta', {
    path,
    workspaceRoot: root,
    kind,
    expectedRevision: revision,
  });
}

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-fasta-kind-')));
  workspaceId = ensureWorkspaceOwnerInDb(db, root);
  native.sender = Object.assign(new EventEmitter(), { id: 99217 });
  native.handlers.clear();
  native.leaseReached = null;
  registerDatabaseHandlers(() => db);
});
afterEach(() => {
  vi.restoreAllMocks();
  native.leaseReached = null;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('native FASTA kind authority over actual SQLite and source files', () => {
  it('does not manufacture a declaration from new generic discovery or later generic metadata refresh', async () => {
    const source = generic();
    expect(await inspect(source.path)).toMatchObject({
      status: 'needs-classification',
      storedKind: 'sequence',
      legacyReadView: 'protein',
      readOnly: true,
      entityId: source.entity.id,
    });
    expect(await inspect(source.path)).not.toHaveProperty('kind');
    registerWorkspaceFileInDb(db, {
      path: source.path,
      workspaceRoot: root,
      fileKind: 'fasta',
      entityType: 'protein',
      metadata: {
        actor: 'native-catalog',
        authority: 'declared',
        discoveredFrom: 'workspace-main-projection',
      },
    });
    expect(await inspect(source.path)).toMatchObject({
      status: 'needs-classification',
      storedKind: 'sequence',
    });
    expect(declarations(source.entity.id)).toEqual([]);
  });

  it('refuses forging native provenance through the existing typed event writer', async () => {
    const source = generic();
    await expect(
      call('recordCatalogEvent', {
        entityId: source.entity.id,
        eventType: FASTA_KIND_DECLARATION_EVENT,
        actor: 'native-catalog',
        payload: {
          version: 1,
          operation: 'classification',
          entityId: source.entity.id,
          workspaceId,
          kind: 'sequence',
        },
      })
    ).rejects.toThrow('FASTA_KIND_HISTORY_PROTECTED');
    expect(declarations(source.entity.id)).toEqual([]);
  });

  it('refuses deleting a bound deliberate kind declaration through the generic creation rollback route', async () => {
    const path = join(root, 'DNA.faa');
    writeFileSync(path, '>dna\nACGTACGT\n');
    const entity = await call<{ id: string }>('registerCatalogEntity', {
      type: 'sequence',
      name: 'Explicit DNA',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    const file = bindCatalogEntityFileInDb(db, {
      entityId: entity.id,
      path,
      fileKind: 'fasta',
      workspaceRoot: root,
    });
    const before = declarations(entity.id);
    await expect(
      call('deleteCatalogEntityWithExactBinding', {
        entityId: entity.id,
        path,
        fileKind: file.file_kind,
      })
    ).rejects.toThrow('FASTA_KIND_HISTORY_PROTECTED');
    expect(declarations(entity.id)).toEqual(before);
    expect(await inspect(path)).toMatchObject({ status: 'declared', kind: 'sequence' });
  });

  it('still rolls back an unpublished initial registration that never acquired a file binding', async () => {
    const path = join(root, 'unpublished.faa');
    const entity = await call<{ id: string }>('registerCatalogEntity', {
      type: 'sequence',
      name: 'Unpublished DNA',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    expect(declarations(entity.id)).toHaveLength(1);
    await expect(call('deleteCatalogEntityIfUnbound', entity.id)).resolves.toBe(true);
    expect(db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(entity.id)).toBeUndefined();
    expect(declarations(entity.id)).toEqual([]);
  });

  it('retains a published declaration after native missing-path release leaves its entity unbound', async () => {
    const path = join(root, 'DNA.faa');
    writeFileSync(path, '>dna\nACGTACGT\n');
    const entity = await call<{ id: string }>('registerCatalogEntity', {
      type: 'sequence',
      name: 'Explicit DNA',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    bindCatalogEntityFileInDb(db, {
      entityId: entity.id,
      path,
      fileKind: 'fasta',
      workspaceRoot: root,
    });
    const moved = join(root, 'DNA moved.faa');
    renameSync(path, moved);
    const missing = await call('setCatalogFileState', path, 'missing', 'external move');
    const replacement = await call<{ id: string }>('registerCatalogEntity', {
      type: 'file',
      name: 'Replacement',
      locator: 'entity://file/replacement',
      storageType: 'file',
      workspaceRoot: root,
    });
    await call('releaseMissingCatalogFilePath', missing, replacement.id);
    const before = declarations(entity.id);
    expect(
      db.prepare('SELECT * FROM catalog_entity_files WHERE entity_id=?').all(entity.id)
    ).toEqual([]);
    await expect(call('deleteCatalogEntityIfUnbound', entity.id)).rejects.toThrow(
      'FASTA_KIND_HISTORY_PROTECTED'
    );
    expect(declarations(entity.id)).toEqual(before);
    expect(readFileSync(moved, 'utf8')).toBe('>dna\nACGTACGT\n');
  });

  it('records a new deliberate kind and preserves it through generic refresh and a real native move', async () => {
    const path = join(root, 'DNA.faa');
    writeFileSync(path, '>dna\nACGTACGT\n');
    const entity = await call<{ id: string }>('registerCatalogEntity', {
      type: 'sequence',
      name: 'Explicit DNA',
      locator: `file://${path}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    const file = bindCatalogEntityFileInDb(db, {
      entityId: entity.id,
      path,
      fileKind: 'fasta',
      workspaceRoot: root,
    });
    const history = declarations(entity.id);
    expect(history).toHaveLength(1);
    registerWorkspaceFileInDb(db, {
      path,
      workspaceRoot: root,
      fileKind: 'fasta',
      entityType: 'protein',
      metadata: { discoveredFrom: 'git-indexer' },
    });
    expect(await inspect(path)).toMatchObject({
      status: 'declared',
      kind: 'sequence',
      authority: 'native-declaration',
      bindingId: file.id,
      objectUuid: file.object_uuid,
    });
    const moved = join(root, 'DNA moved.faa');
    renameSync(path, moved);
    await call('rebindCatalogFiles', { oldPath: path, newPath: moved, workspaceRoot: root });
    expect(await inspect(moved)).toMatchObject({
      status: 'declared',
      kind: 'sequence',
      entityId: entity.id,
      bindingId: file.id,
      objectUuid: file.object_uuid,
    });
    expect(declarations(entity.id)).toEqual(history);
    expect(readFileSync(moved, 'utf8')).toBe('>dna\nACGTACGT\n');
  });

  it('classifies a loose FASTA either way while preserving original declarations, identity, object UUID and bytes', async () => {
    const source = generic();
    const bytes = readFileSync(source.path);
    const initial = await inspect(source.path);
    const classified = await classify(source.path, 'protein', initial.revision);
    expect(classified).toMatchObject({
      status: 'declared',
      kind: 'protein',
      entityId: source.entity.id,
      bindingId: source.file.id,
      objectUuid: source.file.object_uuid,
      sourceFingerprint: initial.sourceFingerprint,
    });
    const first = declarations(source.entity.id);
    expect(first).toHaveLength(1);
    const second = await classify(source.path, 'sequence', classified.revision);
    expect(second).toMatchObject({
      status: 'declared',
      kind: 'sequence',
      entityId: source.entity.id,
    });
    expect(declarations(source.entity.id)).toHaveLength(2);
    expect(declarations(source.entity.id)[0]).toEqual(first[0]);
    expect(readFileSync(source.path)).toEqual(bytes);
  });

  it('reads declared presentation authority without hashing full source bytes', async () => {
    const source = generic();
    const checked = await inspect(source.path);
    await classify(source.path, 'sequence', checked.revision);
    const hasher = vi.spyOn(contentHash, 'contentHashInMain');
    const read = await call<FastaKindReadAuthority>('getFastaKindReadAuthority', {
      path: source.path,
      workspaceRoot: root,
    });
    expect(read).toMatchObject({
      status: 'declared',
      kind: 'sequence',
      entityId: source.entity.id,
    });
    expect(read).not.toHaveProperty('revision');
    expect(read).not.toHaveProperty('sourceFingerprint');
    expect(hasher).not.toHaveBeenCalled();
    await inspect(source.path);
    expect(hasher).toHaveBeenCalledOnce();
  });

  it('rejects a changed actual source or binding after inspection before any semantic write', async () => {
    const source = generic();
    const first = await inspect(source.path);
    writeFileSync(source.path, '>legacy\nMKTA\n');
    await expect(classify(source.path, 'protein', first.revision)).rejects.toThrow(
      'FASTA_KIND_STALE'
    );
    const second = await inspect(source.path);
    db.prepare('UPDATE catalog_entity_files SET object_uuid=? WHERE id=?').run(
      'replaced-object',
      source.file.id
    );
    await expect(classify(source.path, 'protein', second.revision)).rejects.toThrow(
      'FASTA_KIND_STALE'
    );
    expect(declarations(source.entity.id)).toEqual([]);
  });

  it('allows reference inspection but refuses reference writes without changing rows or source', async () => {
    const source = generic();
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(workspaceId);
    const checked = await inspect(source.path);
    await expect(classify(source.path, 'protein', checked.revision)).rejects.toThrow(
      'WORKSPACE_READ_ONLY'
    );
    expect(declarations(source.entity.id)).toEqual([]);
    expect(readFileSync(source.path, 'utf8')).toBe('>legacy\nMKTW\n');
  });

  it.each(['archived_at', 'trashed_at'] as const)(
    'refuses an owner made inactive through %s',
    async (column) => {
      const source = generic();
      const checked = await inspect(source.path);
      db.prepare(`UPDATE workspaces SET ${column}=1 WHERE id=?`).run(workspaceId);
      await expect(classify(source.path, 'protein', checked.revision)).rejects.toThrow(
        'FASTA_KIND_OWNER_INACTIVE'
      );
      expect(declarations(source.entity.id)).toEqual([]);
    }
  );

  it('rechecks actual write admission after waiting behind the owning project lease', async () => {
    const source = generic();
    const checked = await inspect(source.path);
    const release = await acquireWorkspaceSyncMutationLease(root);
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    native.leaseReached = reached;
    const changing = classify(source.path, 'protein', checked.revision);
    const rejected = expect(changing).rejects.toThrow('WORKSPACE_READ_ONLY');
    try {
      await waiting;
      db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(workspaceId);
    } finally {
      release();
    }
    await rejected;
    expect(declarations(source.entity.id)).toEqual([]);
  });

  it.each(['source', 'binding'] as const)(
    'refuses a %s revision changed while classification waits for the native lease',
    async (race) => {
      const source = generic();
      const checked = await inspect(source.path);
      const release = await acquireWorkspaceSyncMutationLease(root);
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      native.leaseReached = reached;
      const changing = classify(source.path, 'protein', checked.revision);
      const rejected = expect(changing).rejects.toThrow('FASTA_KIND_STALE');
      try {
        await waiting;
        if (race === 'source') writeFileSync(source.path, '>legacy\nMKTA\n');
        else
          db.prepare('UPDATE catalog_entity_files SET object_uuid=? WHERE id=?').run(
            'queued-replacement-object',
            source.file.id
          );
      } finally {
        release();
      }
      await rejected;
      expect(declarations(source.entity.id)).toEqual([]);
      expect(
        db.prepare('SELECT type FROM catalog_entities WHERE id=?').get(source.entity.id)
      ).toEqual({
        type: 'sequence',
      });
    }
  );

  it('uses an exact independent canonical manifest witness and refuses a conflicting classification', async () => {
    const source = generic();
    mkdirSync(join(root, '.forge'));
    writeFileSync(
      join(root, '.forge/catalog.json'),
      JSON.stringify({
        schema: 'dnaforge.native-workspace-manifest.v1',
        entities: [
          {
            id: source.entity.id,
            type: 'sequence',
            name: 'DNA declaration',
            path: 'Legacy.faa',
            fileKind: 'fasta',
          },
        ],
        links: [],
      })
    );
    const checked = await inspect(source.path);
    expect(checked).toMatchObject({
      status: 'declared',
      kind: 'sequence',
      authority: 'canonical-source',
    });
    await expect(classify(source.path, 'protein', checked.revision)).rejects.toThrow(
      'FASTA_KIND_SCHEMA_CONFLICT'
    );
    expect(declarations(source.entity.id)).toEqual([]);
  });

  it('rolls back catalog kind and immutable history together when native history publication fails', async () => {
    const source = generic();
    const checked = await inspect(source.path);
    const before = db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(source.entity.id);
    db.exec(
      `CREATE TEMP TRIGGER fail_kind_history BEFORE INSERT ON catalog_entity_events WHEN NEW.event_type='${FASTA_KIND_DECLARATION_EVENT}' BEGIN SELECT RAISE(ABORT,'history write failed'); END`
    );
    await expect(classify(source.path, 'protein', checked.revision)).rejects.toThrow(
      'history write failed'
    );
    expect(db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(source.entity.id)).toEqual(
      before
    );
    expect(declarations(source.entity.id)).toEqual([]);
  });

  it('refuses a generic projection reset that would erase native kind history', async () => {
    const source = generic();
    const checked = await inspect(source.path);
    await classify(source.path, 'sequence', checked.revision);
    const history = declarations(source.entity.id);
    expect(() => clearCatalogProjectionInDb(db, root)).toThrow('FASTA_KIND_HISTORY_PROTECTED');
    expect(declarations(source.entity.id)).toEqual(history);
  });
});
