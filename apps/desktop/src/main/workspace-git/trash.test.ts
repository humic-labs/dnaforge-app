import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { purgeExpiredTrashedWorkspaces, purgeTrashedWorkspaceByUuid } from './trash';
import { transitionManagedWorkspaceLifecycle } from './lifecycle';
import { acquireWorkspaceMutationShared } from '../workspace-sync-mutation-lease';
import {
  ORIGINAL_DEFAULT_PROJECT_SETTING,
  rememberOriginalDefaultProject,
} from '../original-default-project';

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 30 * DAY;

describe('trash purge', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wptrash-'));
    managedRoot = join(tmp, 'managed-workspaces');
    const originalPath = join(managedRoot, 'uuid-original', 'repo');
    mkdirSync(originalPath, { recursive: true });
    writeFileSync(join(originalPath, 'keep.txt'), 'Original project bytes');
    const original = db
      .prepare(
        `INSERT INTO workspaces (name,path,repo_uuid,created_at)
       VALUES ('My Project',?,'uuid-original',1)`
      )
      .run(originalPath);
    rememberOriginalDefaultProject(db, Number(original.lastInsertRowid));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedTrashed(uuid: string, trashedAt: number, root = managedRoot): string {
    const repoPath = join(root, uuid, 'repo');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'seq.gb'), 'LOCUS x 10 bp\n');
    db.prepare(
      `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, last_opened_at, trashed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid, repoPath, uuid, `/origin/${uuid}`, 1, 1, trashedAt);
    return repoPath;
  }

  function countRows(uuid: string): number {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE repo_uuid = ?`).get(uuid) as {
        n: number;
      }
    ).n;
  }

  function workspaceId(uuid: string): number {
    return (db.prepare('SELECT id FROM workspaces WHERE repo_uuid = ?').get(uuid) as { id: number })
      .id;
  }

  function retainedState(): string {
    return JSON.stringify(
      [
        'settings',
        'workspaces',
        'lims_entity',
        'lims_link',
        'lims_audit',
        'catalog_entities',
        'catalog_entity_files',
        'catalog_workspace_placements',
        'primers',
      ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
    );
  }

  function seedEntity(id: string, ownerId: number, archived = false): void {
    db.prepare(
      `INSERT OR IGNORE INTO lims_schema
      (id,kind,name,display_name,fields,current_revision_id,created_at,updated_at)
      VALUES ('retention-schema','entity','retention-specimen','Specimen','[]','retention-v1',1,1)`
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO lims_schema_revision
      (id,schema_id,version,fields,created_at)
      VALUES ('retention-v1','retention-schema',1,'[]',1)`
    ).run();
    db.prepare(
      `INSERT INTO lims_entity
      (id,kind,schema_id,schema_revision_id,name,fields,registration_status,
       workspace_id,tombstone,created_at,updated_at,archived_at)
      VALUES (?,'retention-specimen','retention-schema','retention-v1',?,'{}','registered',?,?,1,1,?)`
    ).run(id, id, ownerId, archived ? 1 : 0, archived ? 1 : null);
  }

  function seedCatalog(id: string, ownerId: number, status = 'archived'): void {
    db.prepare(
      `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
      VALUES (?,'record',?,?,'virtual',?,?,1,1)`
    ).run(id, id, `record:${id}`, status, ownerId);
  }

  it('refuses permanent deletion of the renamed original even when another project takes its name', async () => {
    db.prepare(
      `UPDATE workspaces SET name='Renamed original',trashed_at=1 WHERE repo_uuid='uuid-original'`
    ).run();
    seedTrashed('uuid-other', 1);
    db.prepare(`UPDATE workspaces SET name='My Project' WHERE repo_uuid='uuid-other'`).run();
    const before = retainedState();
    await expect(purgeTrashedWorkspaceByUuid(db, managedRoot, 'uuid-original')).rejects.toThrow(
      /original My Project.*cannot be permanently deleted/i
    );
    expect(retainedState()).toBe(before);
    expect(readFileSync(join(managedRoot, 'uuid-original', 'repo', 'keep.txt'), 'utf8')).toBe(
      'Original project bytes'
    );
  });

  it('refuses unknown original identity without creating or guessing it', async () => {
    seedTrashed('uuid-unknown', 1);
    db.prepare('DELETE FROM settings WHERE key = ?').run(ORIGINAL_DEFAULT_PROJECT_SETTING);
    const before = retainedState();
    await expect(purgeTrashedWorkspaceByUuid(db, managedRoot, 'uuid-unknown')).rejects.toThrow(
      /original My Project identity is unresolved/i
    );
    expect(await purgeExpiredTrashedWorkspaces(db, managedRoot, 100 * RETENTION)).toEqual({
      purged: [],
    });
    expect(retainedState()).toBe(before);
    expect(readFileSync(join(managedRoot, 'uuid-unknown', 'repo', 'seq.gb'), 'utf8')).toBe(
      'LOCUS x 10 bp\n'
    );
  });

  it.each([
    'archived Registry entity',
    'archived relationship',
    'retained audit history',
    'archived catalog record',
    'retired scientific file binding',
    'hidden scientific placement',
    'legacy primer',
  ])('refuses deletion with %s before removing any bytes or ownership', async (retained) => {
    const repoPath = seedTrashed('uuid-retained', 1);
    const ownerId = workspaceId('uuid-retained');
    const originalId = workspaceId('uuid-original');
    if (retained === 'archived Registry entity') {
      seedEntity('retained-entity', ownerId, true);
    } else if (retained === 'archived relationship') {
      seedEntity('link-from', originalId);
      seedEntity('link-to', originalId);
      db.prepare(
        `INSERT INTO lims_link
        (id,from_entity_id,to_entity_id,type,payload,workspace_id,tombstone,created_at,updated_at,archived_at)
        VALUES ('retained-link','link-from','link-to','derived-from','{}',?,1,1,1,1)`
      ).run(ownerId);
    } else if (retained === 'retained audit history') {
      db.prepare(
        `INSERT INTO lims_audit
        (id,event_seq,idempotency_key,event_type,workspace_id,tombstone,created_at)
        VALUES ('retained-history',(SELECT COALESCE(MAX(event_seq),0)+1 FROM lims_audit),'retained-history','entity_registered',?,1,1)`
      ).run(ownerId);
    } else if (retained === 'archived catalog record') {
      seedCatalog('retained-catalog', ownerId);
    } else if (retained === 'retired scientific file binding') {
      seedCatalog('retained-catalog', originalId);
      db.prepare(
        `INSERT INTO catalog_entity_files
        (id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at)
        VALUES ('retained-file','retained-catalog',?,?,'entity-artifact','missing',1,1)`
      ).run(ownerId, join(repoPath, 'retained.entity.json'));
    } else if (retained === 'hidden scientific placement') {
      seedCatalog('retained-catalog', originalId);
      db.prepare(
        `INSERT INTO catalog_workspace_placements
        (entity_id,workspace_id,parent_relative_path,display_name,normalized_sibling_name,
         presentation_kind,status,created_at,updated_at)
        VALUES ('retained-catalog',?,'','Retained','retained','record','hidden',1,1)`
      ).run(ownerId);
    } else {
      db.prepare(
        `INSERT INTO primers
        (id,name,sequence,length,workspace_id,status,created_at,updated_at)
        VALUES ('retained-primer','Retained primer','ACGT',4,?,'archived',1,1)`
      ).run(ownerId);
    }
    const before = retainedState();
    await expect(purgeTrashedWorkspaceByUuid(db, managedRoot, 'uuid-retained')).rejects.toThrow(
      /retained records or history/i
    );
    expect(retainedState()).toBe(before);
    expect(readFileSync(join(repoPath, 'seq.gb'), 'utf8')).toBe('LOCUS x 10 bp\n');
  });

  it('skips protected expired projects and continues deleting an eligible empty non-original project', async () => {
    const now = 100 * RETENTION;
    db.prepare(`UPDATE workspaces SET trashed_at=1 WHERE repo_uuid='uuid-original'`).run();
    seedTrashed('uuid-retained', 1);
    seedEntity('retained-entity', workspaceId('uuid-retained'), true);
    seedTrashed('uuid-empty', 1);
    await expect(purgeExpiredTrashedWorkspaces(db, managedRoot, now)).resolves.toEqual({
      purged: [{ repoUuid: 'uuid-empty', name: 'uuid-empty' }],
    });
    expect(countRows('uuid-original')).toBe(1);
    expect(countRows('uuid-retained')).toBe(1);
    expect(countRows('uuid-empty')).toBe(0);
    expect(existsSync(join(managedRoot, 'uuid-original', 'repo', 'keep.txt'))).toBe(true);
    expect(existsSync(join(managedRoot, 'uuid-retained', 'repo', 'seq.gb'))).toBe(true);
    expect(existsSync(join(managedRoot, 'uuid-empty'))).toBe(false);
    expect(
      db.prepare('SELECT workspace_id,tombstone FROM lims_entity WHERE id=?').get('retained-entity')
    ).toEqual({ workspace_id: workspaceId('uuid-retained'), tombstone: 1 });
  });

  it('purges a workspace trashed past the retention window (managed copy + row deleted)', async () => {
    const now = 100 * RETENTION;
    seedTrashed('uuid-old', now - RETENTION - DAY);
    const workspaceDir = join(managedRoot, 'uuid-old');
    expect(existsSync(workspaceDir)).toBe(true);

    const result = await purgeExpiredTrashedWorkspaces(db, managedRoot, now);

    expect(result.purged.map((p) => p.repoUuid)).toEqual(['uuid-old']);
    expect(existsSync(workspaceDir)).toBe(false);
    expect(countRows('uuid-old')).toBe(0);
  });

  it('keeps a workspace trashed within the retention window', async () => {
    const now = 100 * RETENTION;
    seedTrashed('uuid-fresh', now - DAY);
    const result = await purgeExpiredTrashedWorkspaces(db, managedRoot, now);
    expect(result.purged).toEqual([]);
    expect(existsSync(join(managedRoot, 'uuid-fresh'))).toBe(true);
    expect(countRows('uuid-fresh')).toBe(1);
  });

  it('never purges active or archived workspaces (only trashed ones)', async () => {
    const now = 100 * RETENTION;

    mkdirSync(join(managedRoot, 'uuid-active', 'repo'), { recursive: true });
    db.prepare(
      `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('active', join(managedRoot, 'uuid-active', 'repo'), 'uuid-active', '/o/a', 1, null);
    mkdirSync(join(managedRoot, 'uuid-arch', 'repo'), { recursive: true });
    db.prepare(
      `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('arch', join(managedRoot, 'uuid-arch', 'repo'), 'uuid-arch', '/o/b', 1, 1);

    const result = await purgeExpiredTrashedWorkspaces(db, managedRoot, now);
    expect(result.purged).toEqual([]);
    expect(existsSync(join(managedRoot, 'uuid-active'))).toBe(true);
    expect(existsSync(join(managedRoot, 'uuid-arch'))).toBe(true);
  });

  it('purgeTrashedWorkspaceByUuid deletes one trashed workspace now; false for unknown/non-trashed', async () => {
    seedTrashed('uuid-now', 1);
    expect(await purgeTrashedWorkspaceByUuid(db, managedRoot, 'uuid-now')).toBe(true);
    expect(existsSync(join(managedRoot, 'uuid-now'))).toBe(false);
    expect(countRows('uuid-now')).toBe(0);

    expect(await purgeTrashedWorkspaceByUuid(db, managedRoot, 'nope')).toBe(false);
  });

  it('refuses to delete files outside the managed container (path-safety)', async () => {
    const now = 100 * RETENTION;

    const outsideRepo = join(tmp, 'not-managed', 'repo');
    mkdirSync(outsideRepo, { recursive: true });
    writeFileSync(join(outsideRepo, 'x.gb'), 'x');
    db.prepare(
      `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, trashed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('evil', outsideRepo, 'uuid-evil', '/o', 1, now - RETENTION - DAY);

    await expect(purgeExpiredTrashedWorkspaces(db, managedRoot, now)).rejects.toThrow(
      /not under the managed container/
    );

    expect(existsSync(join(tmp, 'not-managed'))).toBe(true);
    expect(countRows('uuid-evil')).toBe(1);
  });

  it('refuses a managed-looking path that resolves through a symlink outside the container', async () => {
    const now = 100 * RETENTION;
    const outside = join(tmp, 'outside-target');
    const linkedWorkspace = join(managedRoot, 'uuid-link');
    mkdirSync(join(outside, 'repo'), { recursive: true });
    mkdirSync(managedRoot, { recursive: true });
    writeFileSync(join(outside, 'repo', 'keep.gb'), 'KEEP');
    symlinkSync(outside, linkedWorkspace);
    db.prepare(
      `INSERT INTO workspaces (name, path, repo_uuid, origin_path, created_at, trashed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('linked', join(linkedWorkspace, 'repo'), 'uuid-link', '/o', 1, now - RETENTION - DAY);

    await expect(purgeExpiredTrashedWorkspaces(db, managedRoot, now)).rejects.toThrow(
      /resolved path escapes/
    );
    expect(readFileSync(join(outside, 'repo', 'keep.gb'), 'utf8')).toBe('KEEP');
    expect(countRows('uuid-link')).toBe(1);
  });

  it('removes an expired row when its managed directory is already absent', async () => {
    const now = 100 * RETENTION;
    seedTrashed('uuid-absent', now - RETENTION - DAY);
    rmSync(join(managedRoot, 'uuid-absent'), { recursive: true, force: true });

    await expect(purgeExpiredTrashedWorkspaces(db, managedRoot, now)).resolves.toEqual({
      purged: [{ repoUuid: 'uuid-absent', name: 'uuid-absent' }],
    });
    expect(countRows('uuid-absent')).toBe(0);
  });

  it('waits for an active workspace mutation before permanently deleting bytes and row', async () => {
    seedTrashed('uuid-busy', 1);
    const repoPath = join(managedRoot, 'uuid-busy', 'repo');
    const releaseMutation = await acquireWorkspaceMutationShared(repoPath);
    let settled = false;
    const purge = purgeTrashedWorkspaceByUuid(db, managedRoot, 'uuid-busy').then((result) => {
      settled = true;
      return result;
    });

    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(existsSync(join(managedRoot, 'uuid-busy'))).toBe(true);
      expect(countRows('uuid-busy')).toBe(1);
    } finally {
      releaseMutation();
    }

    await expect(purge).resolves.toBe(true);
    expect(existsSync(join(managedRoot, 'uuid-busy'))).toBe(false);
    expect(countRows('uuid-busy')).toBe(0);
  });

  it('does not purge a workspace restored after the purge selected its stale row', async () => {
    const now = 100 * RETENTION;
    const repoPath = seedTrashed('uuid-restored', now - RETENTION - DAY);
    const releaseMutation = await acquireWorkspaceMutationShared(repoPath);
    const restore = transitionManagedWorkspaceLifecycle(db, {
      action: 'restore-trash-by-uuid',
      repoUuid: 'uuid-restored',
    });
    await Promise.resolve();
    const purge = purgeExpiredTrashedWorkspaces(db, managedRoot, now);
    await Promise.resolve();

    releaseMutation();

    await expect(restore).resolves.toEqual({ changed: 1 });
    await expect(purge).resolves.toEqual({ purged: [] });
    expect(existsSync(join(managedRoot, 'uuid-restored'))).toBe(true);
    expect(countRows('uuid-restored')).toBe(1);
    expect(
      db.prepare(`SELECT trashed_at FROM workspaces WHERE repo_uuid = ?`).get('uuid-restored')
    ).toEqual({ trashed_at: null });
  });
});
