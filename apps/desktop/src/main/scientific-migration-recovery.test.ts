import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import {
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
} from '@waypoint/workspace-revisions';

const dirty = vi.hoisted(() => ({ hasDirtyWork: false }));
vi.mock('./dirty-state-cache', () => ({ getDirtyState: () => ({ ...dirty, details: '' }) }));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from './schema';
import { ScientificObjectStore } from './scientific-object-store';
import {
  insertAuditEvent,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
} from './lims-engine-core';
import { rebuildLimsProjectionInDb, verifyLimsAuditHashChainInDb } from './lims-projection-rebuild';
import { revertLimsEntityInsideTx } from './lims-entity-lifecycle';
import type { ComputeJobRegistry } from './compute/jobs';
import { parseCoordinateInventory } from './molecular-catalog/coordinate-inventory';
import * as coordinateWorker from './molecular-catalog/inventory-worker';
import { MolecularCatalogService } from './molecular-catalog/service';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import {
  createScientificLegacyRecovery,
  ensureScientificEnrollmentCheckpoint,
  listScientificRecoveryCheckpoints,
  prepareScientificLegacyDatabase,
} from './scientific-migration-recovery';
import {
  hashScientificRecoveryFile,
  inventoryScientificRecoveryTree,
  scientificRecoveryDirectory,
  verifyScientificRecoveryCheckpoint,
  type ScientificRecoveryDependencies,
} from './scientific-recovery-checkpoint';

import { captureSavedFileSource, restoreSavedFileSource } from './saved-file-sources';
import { listSavedEntityRowVersions } from './saved-entity-row-recovery';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  dirty.hasDirtyWork = false;
});
afterEach(() => {
  dirty.hasDirtyWork = false;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const deps = { openDatabase: openFileTestDb };
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const must = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!value.ok) throw new Error(JSON.stringify(value.error));
  return value.value;
};

async function fixture() {
  const allocated = createFileTestDb('scientific-legacy-pressure');
  const tmpDir = await realpath(allocated.tmpDir);
  allocated.db.close();
  const file = {
    ...allocated,
    tmpDir,
    dbPath: join(tmpDir, 'dnaforge.db'),
    db: openFileTestDb(join(tmpDir, 'dnaforge.db')),
  };
  file.db.pragma('journal_mode = WAL');
  file.db.pragma('foreign_keys = ON');
  cleanups.push(() => {
    if (file.db.open) file.db.close();
    allocated.cleanup();
  });
  ensureSchema(file.db, file.dbPath);
  const root = join(file.tmpDir, 'project'),
    otherRoot = join(file.tmpDir, 'unrelated-project');
  await mkdir(join(root, 'contents'), { recursive: true });
  await mkdir(otherRoot);
  await writeFile(join(root, 'contents', 'template.fasta'), '>baseline\nACGTACGT\n');
  await writeFile(join(otherRoot, 'untouched.txt'), 'unrelated original');
  execFileSync('git', ['init', '--quiet', root], { env: gitEnvironment });
  execFileSync('git', ['-C', root, 'add', '.'], { env: gitEnvironment });
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Recovery Test',
      '-c',
      'user.email=recovery@example.test',
      'commit',
      '--quiet',
      '-m',
      'Legacy baseline',
    ],
    { env: gitEnvironment }
  );
  const insert = file.db.prepare(
    'INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES (?,?,?,1)'
  );
  const workspaceId = Number(
    insert.run('Recovery pressure', root, 'legacy-pressure-owner').lastInsertRowid
  );
  const otherId = Number(
    insert.run('Unrelated project', otherRoot, 'unrelated-owner').lastInsertRowid
  );
  const store = new ScientificObjectStore(file.db, workspaceId);
  const ensure = async (faults: ScientificRecoveryDependencies = {}) => {
    const releaseWorkspace = await acquireWorkspaceSyncMutationLease(root);
    try {
      const releaseDatabase = await acquireWorkspaceSyncDatabaseFence(file.db);
      try {
        await ensureScientificEnrollmentCheckpoint(file.db, workspaceId, { ...deps, ...faults });
      } finally {
        releaseDatabase();
      }
    } finally {
      releaseWorkspace();
    }
  };
  return { ...file, root, otherRoot, workspaceId, otherId, store, ensure };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const checkpoints = (f: Fixture) => listScientificRecoveryCheckpoints(f.db, f.workspaceId, deps);
const recover = (f: Fixture, faults: ScientificRecoveryDependencies = {}) =>
  createScientificLegacyRecovery({
    db: f.db,
    workspaceId: f.workspaceId,
    deps: { ...deps, ...faults },
  });
async function outputs(f: Fixture) {
  return (await readdir(scientificRecoveryDirectory(f.db)).catch(() => [])).filter((name) =>
    /^legacy-[0-9a-f-]{36}$/u.test(name)
  );
}
function accept(f: Fixture) {
  const document = defineScientificDocument({
    formatVersion: 1,
    kind: 'primer',
    name: 'Post-migration primer',
    molecule: 'DNA',
    bases: 'GCTAGCTAGCTA',
    modifications: [],
    fields: {},
  });
  const result = f.store.submit({
    operationId: must(parseOperationId('newer-scientific-work')),
    expectedHead: null,
    mutations: [
      {
        kind: 'create-resource',
        resourceId: must(parseResourceId('newer-primer')),
        path: must(parseWorkspacePath('newer-primer.json')),
        state: document.state,
        origin: { kind: 'created' },
      },
    ],
    blobs: [new TextEncoder().encode(document.text)],
  });
  if (result.kind !== 'changed') throw new Error('Fixture acceptance failed');
  return result;
}
function seedComputeJob(f: Fixture) {
  f.db
    .prepare(
      'INSERT INTO compute_jobs(id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,provider_state,workspace_root,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,1)'
    )
    .run(
      'real-provider-job',
      'cloud-compute',
      'scientific-tool',
      'b'.repeat(64),
      '{}',
      'active-remote-job-reference',
      'running',
      'queued',
      f.otherRoot
    );
}
function seedRemoteAndPathState(f: Fixture) {
  seedComputeJob(f);
  f.db
    .prepare(
      'INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,enabled,created_at,updated_at) VALUES (?,?,?,1,1,1)'
    )
    .run(f.otherId, 'unrelated-owner', 'real-account');
  f.db
    .prepare(
      'INSERT INTO workspace_sync_device(id,device_id,created_at,updated_at) VALUES (1,?,1,1)'
    )
    .run('real-device');
  f.db
    .prepare(
      "INSERT INTO workspace_sync_queue(id,workspace_id,operation,status,created_at,updated_at) VALUES (?,?, 'upload','pending',1,1)"
    )
    .run('real-upload', f.otherId);
  f.db
    .prepare(
      'INSERT INTO org_registry_sync_state(org_id,account_id,client_id,created_at,updated_at) VALUES (?,?,?,1,1)'
    )
    .run('org', 'real-account', 'real-client');
  f.db
    .prepare(
      "INSERT INTO org_registry_outbox(mutation_id,org_id,account_id,client_id,operation,payload_json,request_fingerprint,created_at,updated_at) VALUES (?,?,?,?,'entity.update','{}',?,1,1)"
    )
    .run('real-org-mutation', 'org', 'real-account', 'real-client', 'a'.repeat(64));
  f.db
    .prepare(
      'INSERT INTO native_catalog_publication_outbox(operation_id,workspace_id) VALUES (?,?)'
    )
    .run('pending-native-publication', f.otherId);
  f.db
    .prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,1)')
    .run('original-navigation', JSON.stringify({ root: f.root, unrelated: f.otherRoot }));
  f.db.prepare('UPDATE workspaces SET origin_path=? WHERE id=?').run(f.otherRoot, f.otherId);
  for (const [id, root] of [
    [f.workspaceId, f.root],
    [f.otherId, f.otherRoot],
  ] as const) {
    f.db
      .prepare(
        'INSERT INTO indexed_files(workspace_id,path,name,extension,indexed_at) VALUES (?,?,?,?,1)'
      )
      .run(id, join(root, 'file.fasta'), 'file.fasta', '.fasta');
    f.db
      .prepare(
        'INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)'
      )
      .run(
        `entity-${id}`,
        'sequence',
        `Entity ${id}`,
        `file://${join(root, 'file.fasta')}`,
        'file',
        id,
        JSON.stringify({ path: join(root, 'file.fasta'), nested: [root] })
      );
    f.db
      .prepare(
        'INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)'
      )
      .run(`file-${id}`, `entity-${id}`, id, join(root, 'file.fasta'), 'file.fasta', 'sequence');
  }
}

describe('scientific enrollment and isolated legacy recovery pressure', { timeout: 30_000 }, () => {
  it('qualifies the current native schema and clears retained administration actions only in its independent recovery copy', async () => {
    const f = await fixture();
    expect(f.db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    f.db
      .prepare('INSERT INTO administration_actions VALUES (?, ?, ?)')
      .run(
        'retained-action',
        JSON.stringify({ kind: 'organization-change', status: 'pending' }),
        1
      );
    f.db
      .prepare('INSERT INTO administration_preferences VALUES (?, ?, ?)')
      .run('active-account', JSON.stringify({ accountId: 'original-account' }), 1);
    f.db
      .prepare(
        `INSERT INTO agent_sessions (
          id, provider, authority_profile_id, authority_class, release_mode, status, cwd,
          provider_versions_json, authority_json, started_at, updated_at, completed_at
        ) VALUES ('stopped-session', 'codex-sdk', 'codex-sdk:app-supervised',
          'app-supervised', 'read_only', 'stop_unconfirmed', ?, '{}', '{}', 1, 2, 2)`
      )
      .run(f.root);
    await f.ensure();
    const [baseline] = await checkpoints(f);
    expect(baseline.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    accept(f);
    const before = Buffer.from(f.db.serialize());
    const result = await recover(f);
    expect(Buffer.from(f.db.serialize())).toEqual(before);
    const recovered = openFileTestDb(join(result.profilePath, 'dnaforge.db'));
    try {
      expect(recovered.pragma('user_version', { simple: true })).toBe(41);
      expect(recovered.prepare('SELECT * FROM administration_actions').all()).toEqual([]);
      expect(recovered.prepare('SELECT * FROM administration_preferences').all()).toEqual([]);
      expect(recovered.prepare('SELECT * FROM agent_sessions').all()).toEqual([]);
      expect(recovered.pragma('foreign_key_check')).toEqual([]);
      expect(await readFile(join(result.projectPath, 'contents/template.fasta'), 'utf8')).toBe(
        '>baseline\nACGTACGT\n'
      );
    } finally {
      recovered.close();
    }
  });

  it.each([47, 48])(
    'refuses a schema %s label without the qualified native tables',
    async (version) => {
      const f = await fixture();
      f.db.pragma(`user_version = ${version}`);
      f.db.exec('DROP TABLE administration_actions');
      const before = Buffer.from(f.db.serialize());
      await expect(f.ensure()).rejects.toThrow(`schema ${version} is incomplete or inconsistent`);
      expect(f.store.read().head).toBeNull();
      expect(Buffer.from(f.db.serialize())).toEqual(before);
    }
  );

  it('qualifies the schema 51 enrollment and 41 copy without rewriting predecessor row bytes or file revisions', async () => {
    const f = await fixture();
    const sourcePath = join(f.root, 'contents', 'template.fasta');
    const owner = { workspaceId: f.workspaceId, entityId: 'saved-template' };
    const receipt = await captureSavedFileSource(f.db, { ...owner, path: sourcePath });
    const [savedRow] = listSavedEntityRowVersions(f.db, {
      source: 'workspaces',
      identity: [String(f.workspaceId)],
    });
    expect(savedRow).toBeDefined();
    await f.ensure();
    const [checkpoint] = await checkpoints(f);
    expect(checkpoint.schemaVersion).toBe(51);
    accept(f);
    const recovered = await recover(f);
    const predecessor = openFileTestDb(
      join(scientificRecoveryDirectory(f.db), checkpoint.id, 'database.db')
    );
    const legacy = openFileTestDb(join(recovered.profilePath, 'dnaforge.db'));
    try {
      expect(legacy.pragma('user_version', { simple: true })).toBe(41);
      expect(legacy.pragma('foreign_key_check')).toEqual([]);
      expect(
        legacy
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('saved_entity_row_versions','retained_file_publication_witnesses','retained_file_source_revisions','notebook_saved_reference_retention','notebook_reference_occurrences','notebook_reference_projections','retain_workspaces_update','retain_saved_reference_for_notebook')"
          )
          .all()
      ).toEqual([]);
      for (const db of [predecessor, f.db]) {
        expect(
          listSavedEntityRowVersions(db, {
            source: 'workspaces',
            identity: [String(f.workspaceId)],
          })
        ).toContainEqual(savedRow);
        expect(
          db
            .prepare('SELECT source_path FROM retained_file_source_revisions WHERE id=?')
            .get(receipt.id)
        ).toEqual({ source_path: sourcePath });
      }
      const restored = join(f.tmpDir, 'recovered-source.fasta');
      await restoreSavedFileSource(f.db, {
        ...owner,
        revisionId: receipt.id,
        destination: restored,
      });
      expect(await readFile(restored)).toEqual(await readFile(sourcePath));
    } finally {
      legacy.close();
      predecessor.close();
    }
  });

  it('refuses a partial schema 51 retention owner before enrollment', async () => {
    const f = await fixture();
    f.db.exec('DROP TABLE retained_file_publication_witnesses');
    await expect(f.ensure()).rejects.toThrow('schema 51 is incomplete or inconsistent');
    expect(f.store.read().head).toBeNull();
  });

  it('retains qualified schema 47 recovery after the agent-stop schema migration', async () => {
    const f = await fixture();
    f.db.pragma('user_version = 47');
    await f.ensure();
    const [baseline] = await checkpoints(f);
    expect(baseline.schemaVersion).toBe(47);
    accept(f);
    const before = Buffer.from(f.db.serialize());
    const result = await recover(f);
    expect(Buffer.from(f.db.serialize())).toEqual(before);
    const recovered = openFileTestDb(join(result.profilePath, 'dnaforge.db'));
    try {
      expect(recovered.pragma('user_version', { simple: true })).toBe(41);
      expect(recovered.pragma('foreign_key_check')).toEqual([]);
      expect(await readFile(join(result.projectPath, 'contents/template.fasta'), 'utf8')).toBe(
        '>baseline\nACGTACGT\n'
      );
    } finally {
      recovered.close();
    }
  });

  it('creates one complete baseline before enrollment, then retains it without recapturing newer work', async () => {
    const f = await fixture();
    await f.ensure();
    const initial = await checkpoints(f);
    expect(initial).toHaveLength(1);
    expect(initial[0].acceptedHead).toBeNull();
    await writeFile(join(f.root, 'contents', 'template.fasta'), '>working edit\nTTTT\n');

    insertAuditEvent(f.db, {
      eventType: 'entity_updated',
      subjectTable: 'lims_entity',
      subjectId: 'newer-history',
      workspaceId: f.workspaceId,
      before: { fields: { packagePath: join(f.root, 'newer-package') } },
    });
    await f.ensure();
    expect((await checkpoints(f)).map((checkpoint) => checkpoint.id)).toEqual([initial[0].id]);
    accept(f);
    await f.ensure();
    expect((await checkpoints(f)).map((checkpoint) => checkpoint.id)).toEqual([initial[0].id]);
    expect(
      await readFile(
        join(
          scientificRecoveryDirectory(f.db),
          initial[0].id,
          'project',
          'contents',
          'template.fasta'
        ),
        'utf8'
      )
    ).toBe('>baseline\nACGTACGT\n');
  });

  it('does not enroll if capture fails, and can retry without treating pending output as a checkpoint', async () => {
    const f = await fixture();
    await expect(
      f.ensure({
        afterStep: (step) => {
          if (step === 'database-copied') throw new Error('Capture interrupted');
        },
      })
    ).rejects.toThrow('Capture interrupted');
    expect(await checkpoints(f)).toEqual([]);
    expect(f.store.read().head).toBeNull();
    await f.ensure();
    expect(await checkpoints(f)).toHaveLength(1);
  });

  it('refuses enrollment during an unrelated background compute update and succeeds on a quiet retry', async () => {
    const f = await fixture();
    seedComputeJob(f);
    const enroll = async (faults: ScientificRecoveryDependencies = {}) => {
      await f.ensure(faults);
      return accept(f);
    };
    await expect(
      enroll({
        afterStep: (step) => {
          if (step === 'database-copied')
            f.db
              .prepare(
                "UPDATE compute_jobs SET provider_state='running',poll_count=poll_count+1,updated_at=2 WHERE id=?"
              )
              .run('real-provider-job');
        },
      })
    ).rejects.toThrow('Recovery source changed');
    expect(await checkpoints(f)).toEqual([]);
    expect(f.store.read().head).toBeNull();
    expect((await enroll()).kind).toBe('changed');
    expect(f.store.read().head).not.toBeNull();
    const [baseline] = await checkpoints(f);
    expect(baseline.acceptedHead).toBeNull();
    const archived = openFileTestDb(
      join(scientificRecoveryDirectory(f.db), baseline.id, 'database.db')
    );
    try {
      expect(
        archived
          .prepare('SELECT provider_state,poll_count FROM compute_jobs WHERE id=?')
          .get('real-provider-job')
      ).toEqual({ provider_state: 'running', poll_count: 1 });
    } finally {
      archived.close();
    }
  });

  it('captures legacy disk state while the initiating Save is dirty and still refuses retained cloud bindings', async () => {
    const f = await fixture();
    dirty.hasDirtyWork = true;
    await f.ensure();
    const [baseline] = await checkpoints(f);
    expect(baseline.acceptedHead).toBeNull();
    expect(
      await readFile(
        join(
          scientificRecoveryDirectory(f.db),
          baseline.id,
          'project',
          'contents',
          'template.fasta'
        ),
        'utf8'
      )
    ).toBe('>baseline\nACGTACGT\n');
    expect(dirty.hasDirtyWork).toBe(true);
    dirty.hasDirtyWork = false;
    f.db
      .prepare(
        'INSERT INTO workspace_sync_bindings(workspace_id,workspace_uuid,owner_account_id,enabled,created_at,updated_at) VALUES (?,?,?,0,1,1)'
      )
      .run(f.workspaceId, 'legacy-pressure-owner', 'real-account');
    await expect(f.ensure()).rejects.toThrow('cloud-sync binding');
    expect(await checkpoints(f)).toHaveLength(1);
  });

  it('allows the initiating Save to remain dirty throughout capture without changing the accepted head', async () => {
    const f = await fixture();
    await f.ensure({
      afterStep: (step) => {
        if (step === 'checkpoint-renamed') dirty.hasDirtyWork = true;
      },
    });
    expect(dirty.hasDirtyWork).toBe(true);
    expect(f.store.read().head).toBeNull();
    expect((await checkpoints(f))[0].acceptedHead).toBeNull();
  });

  it('preserves current accepted state, pending delivery, external edits and Git while producing an independent schema41 baseline', async () => {
    const f = await fixture();
    await f.ensure();
    const accepted = accept(f);
    await writeFile(
      join(f.root, 'newer-primer.json'),
      'external working bytes conflicting with accepted delivery'
    );
    await writeFile(join(f.root, 'contents', 'template.fasta'), '>newer working template\nGGGG\n');
    await writeFile(join(f.root, 'newer-untracked.bin'), Buffer.from([1, 0, 255]));
    const beforeFiles = await inventoryScientificRecoveryTree(f.root),
      beforeDb = Buffer.from(f.db.serialize());
    const result = await recover(f);

    expect(result.projectPath).toBe(join(result.profilePath, 'project'));
    expect(await inventoryScientificRecoveryTree(f.root)).toEqual(beforeFiles);
    expect(Buffer.from(f.db.serialize())).toEqual(beforeDb);
    const preserved = await verifyScientificRecoveryCheckpoint(
      join(scientificRecoveryDirectory(f.db), result.preservedCurrentCheckpointId),
      { db: f.db, workspaceId: f.workspaceId, deps }
    );
    expect(preserved.kind).toBe('pre-recovery');
    expect(preserved.acceptedHead).toBe(accepted.version.id);
    const preservedDb = openFileTestDb(
      join(scientificRecoveryDirectory(f.db), preserved.id, 'database.db')
    );
    try {
      expect(
        preservedDb
          .prepare('SELECT status FROM scientific_materialization_jobs WHERE workspace_id=?')
          .get(f.workspaceId)
      ).toEqual({ status: 'pending' });
      expect(
        preservedDb
          .prepare('SELECT COUNT(*) AS n FROM scientific_revision_blobs WHERE workspace_id=?')
          .get(f.workspaceId)
      ).toMatchObject({ n: expect.any(Number) });
    } finally {
      preservedDb.close();
    }
    expect(
      await readFile(
        join(scientificRecoveryDirectory(f.db), preserved.id, 'project', 'newer-primer.json'),
        'utf8'
      )
    ).toContain('external working bytes');
    expect(await readFile(join(result.projectPath, 'contents', 'template.fasta'), 'utf8')).toBe(
      '>baseline\nACGTACGT\n'
    );
    const legacy = openFileTestDb(join(result.profilePath, 'dnaforge.db'));
    try {
      expect(legacy.pragma('user_version', { simple: true })).toBe(41);
      expect(legacy.pragma('quick_check', { simple: true })).toBe('ok');
      expect(legacy.pragma('foreign_key_check')).toEqual([]);
      expect(
        legacy.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'scientific_%'").all()
      ).toEqual([]);
      expect(legacy.prepare('SELECT path FROM workspaces WHERE id=?').get(f.workspaceId)).toEqual({
        path: result.projectPath,
      });
    } finally {
      legacy.close();
    }
    const [original, independent] = await Promise.all([
      lstat(join(f.root, 'contents', 'template.fasta')),
      lstat(join(result.projectPath, 'contents', 'template.fasta')),
    ]);
    expect(`${original.dev}:${original.ino}`).not.toBe(`${independent.dev}:${independent.ino}`);
    await writeFile(
      join(result.projectPath, 'contents', 'template.fasta'),
      '>edited recovery\nCCCC\n'
    );
    expect(await inventoryScientificRecoveryTree(f.root)).toEqual(beforeFiles);
    const gitTop = execFileSync('git', ['-C', result.projectPath, 'rev-parse', '--show-toplevel'], {
      env: gitEnvironment,
    })
      .toString()
      .trim();
    expect(gitTop).toBe(result.projectPath);
  });

  it('preserves the real Registry audit hash chain and original bytes through legacy conversion', async () => {
    const f = await fixture();

    const transport = vi
      .spyOn(coordinateWorker, 'inventoryCoordinatesInWorker')
      .mockImplementation(parseCoordinateInventory);
    cleanups.push(() => transport.mockRestore());
    const pdb = [
      'HEADER    RECOVERY PROVENANCE',
      'ATOM      1  N   ALA A   1      11.104  13.207   7.216  1.00 20.00           N',
      'ATOM      2  CA  ALA A   1      12.560  13.207   7.216  1.00 20.00           C',
      'ATOM      3  C   ALA A   1      13.000  14.620   7.216  1.00 20.00           C',
      'ATOM      4  O   ALA A   1      12.220  15.560   7.216  1.00 20.00           O',
      'TER',
      'END',
      '',
    ].join('\n');
    await writeFile(join(f.root, 'structure.pdb'), pdb);

    const jobs = {} as ComputeJobRegistry;
    const observation = await new MolecularCatalogService(() => f.db, jobs).register({
      workspaceRoot: f.root,
      filePath: 'structure.pdb',
      source: { kind: 'import' },
    });
    const molecular = f.db
      .prepare('SELECT * FROM molecular_catalog_observations WHERE id=?')
      .get(observation.observation.id) as { id: string; source_key: string };
    expect(createHash('sha256').update(molecular.source_key).digest('hex')).toBe(molecular.id);
    const commit = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], {
      env: gitEnvironment,
    })
      .toString()
      .trim();
    const blob = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD:contents/template.fasta'], {
      env: gitEnvironment,
    })
      .toString()
      .trim();
    const pin = {
      entityId: 'legacy-sequence',
      field: 'sequence',
      relPath: 'contents/template.fasta',
      contentHash: `git:${blob}`,
      commit,
      ref: 'refs/dnaforge/lims-pins/legacy-sequence/1',
      repoPath: f.root,
    };
    execFileSync('git', ['-C', f.root, 'update-ref', pin.ref, commit], {
      env: gitEnvironment,
    });
    insertAuditEvent(f.db, {
      eventType: 'entity_registered',
      subjectTable: 'lims_entity',
      subjectId: pin.entityId,
      workspaceId: f.workspaceId,
      payload: { contentPins: [pin] },
    });
    insertAuditEvent(f.db, {
      eventType: 'entity_updated',
      subjectTable: 'lims_entity',
      subjectId: pin.entityId,
      workspaceId: f.workspaceId,
      payload: { change: 'reviewed scientific registration' },
    });
    const audit = f.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
    expect(verifyLimsAuditHashChainInDb(f.db).ok).toBe(true);
    await f.ensure();
    const originalDb = Buffer.from(f.db.serialize()),
      originalFiles = await inventoryScientificRecoveryTree(f.root);
    const result = await recover(f),
      legacy = openFileTestDb(join(result.profilePath, 'dnaforge.db'));
    try {
      expect(verifyLimsAuditHashChainInDb(legacy)).toMatchObject({ ok: true, failures: [] });
      expect(legacy.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(audit);
      expect(
        legacy.prepare('SELECT * FROM molecular_catalog_observations WHERE id=?').get(molecular.id)
      ).toEqual(molecular);
      const recoveredService = new MolecularCatalogService(() => legacy, jobs);
      const newObservation = await recoveredService.register({
        workspaceRoot: result.projectPath,
        filePath: 'structure.pdb',
        source: { kind: 'import' },
      });
      expect(newObservation.observation.id).not.toBe(molecular.id);
      expect(newObservation.observation.coordinateId).toBe(observation.observation.coordinateId);
      expect(newObservation.observation.origin.workspaceRoot).toBe(result.projectPath);
      expect(
        legacy.prepare('SELECT * FROM molecular_catalog_observations WHERE id=?').get(molecular.id)
      ).toEqual(molecular);
    } finally {
      legacy.close();
    }
    expect(Buffer.from(f.db.serialize())).toEqual(originalDb);
    expect(await inventoryScientificRecoveryTree(f.root)).toEqual(originalFiles);
  });

  it.each([
    'owned',
    'other-project',
    'missing-binding',
    'wrong-owner',
    'outside-root',
    'edited-history',
    'changed-history-path',
  ])(
    'preserves safely bound notebook registrations through enrollment and recovery: %s',
    async (variant) => {
      const f = await fixture(),
        entityId = 'legacy-notebook',
        workspaceId = variant === 'owned' ? f.workspaceId : f.otherId,
        packageRoot = join(
          variant === 'owned' || variant === 'wrong-owner'
            ? f.root
            : variant === 'outside-root'
              ? f.tmpDir
              : f.otherRoot,
          'notebooks',
          entityId
        );
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'entry.md'), 'Original planning notes\n');
      seedLimsBuiltinsInDb(f.db);
      const entity = f.db.transaction(() =>
        registerLimsEntityInsideTx(f.db, {
          id: entityId,
          kind: 'notebook',
          name: 'Recovery planning notebook',
          workspaceId,
          fields: { packagePath: packageRoot },
        })
      )();
      f.db
        .prepare(
          `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
           VALUES (?, 'notebook', ?, ?, 'filesystem', ?, 1, 1)`
        )
        .run(entityId, entity.name, `file://${packageRoot}`, workspaceId);
      if (variant !== 'missing-binding')
        f.db
          .prepare(
            `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at)
             VALUES (?, ?, ?, ?, ?, 'waypoint-notebook', 'current', 1, 1)`
          )
          .run(
            'notebook-current-binding',
            entityId,
            variant === 'wrong-owner' ? f.workspaceId : workspaceId,
            packageRoot,
            `notebooks/${entityId}`
          );
      if (variant === 'edited-history' || variant === 'changed-history-path')
        insertAuditEvent(f.db, {
          eventType: 'entity_updated',
          subjectTable: 'lims_entity',
          subjectId: entityId,
          workspaceId,
          before:
            variant === 'changed-history-path'
              ? {
                  ...entity,
                  fields: { ...entity.fields, packagePath: join(f.tmpDir, 'unbound-notebook') },
                }
              : entity,
          after: entity,
        });
      const audit = f.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
        originalDb = Buffer.from(f.db.serialize()),
        originalFiles = await inventoryScientificRecoveryTree(f.root),
        otherFiles = await inventoryScientificRecoveryTree(f.otherRoot);
      if (variant === 'owned' || variant === 'other-project' || variant === 'edited-history') {
        await f.ensure();
        const result = await recover(f),
          legacy = openFileTestDb(join(result.profilePath, 'dnaforge.db')),
          recoveredRoot =
            variant === 'owned'
              ? result.projectPath
              : join(result.directory, 'unavailable-projects', String(f.otherId));
        try {
          rebuildLimsProjectionInDb(legacy);
          const row = legacy.prepare('SELECT fields FROM lims_entity WHERE id=?').get(entityId) as {
            fields: string;
          };
          expect(JSON.parse(row.fields).packagePath).toBe(
            join(recoveredRoot, 'notebooks', entityId)
          );
          if (variant !== 'edited-history')
            expect(
              legacy.transaction(() => revertLimsEntityInsideTx(legacy, { id: entityId }))()
            ).toMatchObject({ reverted: false, reason: 'no-prior-edit' });
          expect(verifyLimsAuditHashChainInDb(legacy)).toMatchObject({ ok: true, failures: [] });
          expect(legacy.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(
            audit
          );
          if (variant === 'owned')
            expect(
              await readFile(join(recoveredRoot, 'notebooks', entityId, 'entry.md'), 'utf8')
            ).toBe('Original planning notes\n');
        } finally {
          legacy.close();
        }
      } else {
        await expect(f.ensure()).rejects.toThrow(/histor|locator|relocate/iu);
        expect(f.store.read().head).toBeNull();
        await expect(recover(f)).rejects.toThrow(/histor|locator|relocate/iu);
        expect(await outputs(f)).toEqual([]);
      }
      expect(Buffer.from(f.db.serialize())).toEqual(originalDb);
      expect(await inventoryScientificRecoveryTree(f.root)).toEqual(originalFiles);
      expect(await inventoryScientificRecoveryTree(f.otherRoot)).toEqual(otherFiles);
    }
  );

  it.each(['bound', 'mismatched-package-id', 'missing-binding'])(
    'recovers only identity-bound managed registration history: %s',
    async (variant) => {
      const f = await fixture(),
        entityId = 'managed-recovery-sequence',
        packageRoot = join(f.root, 'imports', entityId);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'sequence.fasta'), '>legacy package\nACGTACGT\n');
      seedLimsBuiltinsInDb(f.db);
      const entity = f.db.transaction(() =>
        registerLimsEntityInsideTx(f.db, {
          id: entityId,
          kind: 'dna_sequence',
          name: 'Managed recovery sequence',
          workspaceId: f.workspaceId,
          fields: {
            _managedSequenceDocument: {
              kind: 'managed-sequence',
              packageId: variant === 'mismatched-package-id' ? 'another-package' : entityId,
              packageRoot,
            },
          },
        })
      )();
      f.db
        .prepare(
          `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
         VALUES (?, 'dna_sequence', ?, ?, 'filesystem', ?, 1, 1)`
        )
        .run(entityId, entity.name, `file://${packageRoot}`, f.workspaceId);
      if (variant !== 'missing-binding') {
        f.db
          .prepare(
            `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,relative_path,file_kind,status,created_at,updated_at)
           VALUES (?, ?, ?, ?, ?, 'managed-sequence', 'current', 1, 1)`
          )
          .run(
            'managed-current-binding',
            entityId,
            f.workspaceId,
            packageRoot,
            `imports/${entityId}`
          );
      }
      const audit = f.db.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all();
      expect(verifyLimsAuditHashChainInDb(f.db).ok).toBe(true);
      const originalDb = Buffer.from(f.db.serialize()),
        originalFiles = await inventoryScientificRecoveryTree(f.root);
      if (variant !== 'bound') {
        await expect(f.ensure()).rejects.toThrow(/histor|locator|relocate/iu);
        expect(f.store.read().head).toBeNull();
        await expect(recover(f)).rejects.toThrow(/histor|locator|relocate/iu);
        expect(await outputs(f)).toEqual([]);
      } else {
        await f.ensure();
        const result = await recover(f),
          legacy = openFileTestDb(join(result.profilePath, 'dnaforge.db')),
          recoveredPackage = join(result.projectPath, 'imports', entityId);
        try {
          const managedRoot = () => {
            const row = legacy
              .prepare('SELECT fields FROM lims_entity WHERE id=?')
              .get(entityId) as { fields: string };
            return JSON.parse(row.fields)._managedSequenceDocument.packageRoot;
          };
          expect(managedRoot()).toBe(recoveredPackage);
          expect(
            legacy
              .prepare(
                "SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'"
              )
              .get(entityId)
          ).toEqual({ path: recoveredPackage });
          rebuildLimsProjectionInDb(legacy);
          expect(managedRoot()).toBe(recoveredPackage);
          expect(
            legacy.transaction(() => revertLimsEntityInsideTx(legacy, { id: entityId }))()
          ).toMatchObject({ reverted: false, reason: 'no-prior-edit' });
          expect(verifyLimsAuditHashChainInDb(legacy).ok).toBe(true);
          expect(legacy.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all()).toEqual(
            audit
          );
        } finally {
          legacy.close();
        }
      }
      expect(Buffer.from(f.db.serialize())).toEqual(originalDb);
      expect(await inventoryScientificRecoveryTree(f.root)).toEqual(originalFiles);
    }
  );

  it.each(['original', 'case-and-parent-alias', 'file-uri', 'relative-parent'])(
    'refuses %s historical runtime locators before enrollment or recovery without mutating the original project',
    async (variant) => {
      const f = await fixture();
      const historical = {
        id: 'legacy-sequence-with-absolute-history',
        kind: 'dna_sequence',
        fields: {
          sequence: {
            mode: 'file',
            documentId: 'legacy-sequence-with-absolute-history',
            relPath:
              variant === 'relative-parent'
                ? '../../original-project/contents/template.fasta'
                : variant === 'file-uri'
                  ? `file://${join(f.root, 'contents', 'template.fasta')}`
                  : variant === 'original'
                    ? join(f.root, 'contents', 'template.fasta')
                    : `${f.root.toUpperCase()}/contents/../contents/template.fasta`,
            topology: 'linear',
            length: 8,
          },
        },
      };
      insertAuditEvent(f.db, {
        eventType: 'entity_updated',
        subjectTable: 'lims_entity',
        subjectId: historical.id,
        workspaceId: f.workspaceId,
        before: historical,
        after: historical,
      });
      expect(verifyLimsAuditHashChainInDb(f.db).ok).toBe(true);
      const originalDb = Buffer.from(f.db.serialize()),
        originalFiles = await inventoryScientificRecoveryTree(f.root);
      await expect(f.ensure()).rejects.toThrow(/histor|locator|absolute|rebind/iu);
      expect(f.store.read().head).toBeNull();
      expect(await checkpoints(f)).toHaveLength(1);
      await expect(recover(f)).rejects.toThrow(/histor|locator|absolute|rebind/iu);
      expect(await outputs(f)).toEqual([]);
      expect(Buffer.from(f.db.serialize())).toEqual(originalDb);
      expect(await inventoryScientificRecoveryTree(f.root)).toEqual(originalFiles);
    }
  );

  it('removes every copied remote publication route and rebases or disables unrelated original paths', async () => {
    const f = await fixture();
    seedRemoteAndPathState(f);
    await f.ensure();
    const result = await recover(f),
      legacy = openFileTestDb(join(result.profilePath, 'dnaforge.db'));
    try {
      for (const table of [
        'workspace_sync_bindings',
        'workspace_sync_queue',
        'workspace_sync_device',
        'org_registry_sync_state',
        'org_registry_outbox',
        'native_catalog_publication_outbox',
        'compute_jobs',
        'settings',
      ])
        expect(
          legacy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
          `${table} must not act for the real profile`
        ).toEqual({ n: 0 });
      const unrelated = legacy
        .prepare('SELECT path,origin_path,archived_at FROM workspaces WHERE id=?')
        .get(f.otherId) as { path: string; origin_path: string; archived_at: number };
      expect(unrelated.path).toBe(
        join(result.directory, 'unavailable-projects', String(f.otherId))
      );
      expect(unrelated.origin_path).toBe(unrelated.path);
      expect(unrelated.archived_at).toBeGreaterThan(0);
      for (const table of ['indexed_files', 'catalog_entities', 'catalog_entity_files']) {
        const rows = JSON.stringify(legacy.prepare(`SELECT * FROM ${table}`).all());
        expect(rows).not.toContain(f.root);
        expect(rows).not.toContain(f.otherRoot);
      }
      expect(
        legacy
          .prepare('SELECT locator FROM catalog_entities WHERE id=?')
          .get(`entity-${f.workspaceId}`)
      ).toEqual({ locator: `file://${join(result.projectPath, 'file.fasta')}` });
    } finally {
      legacy.close();
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM workspace_sync_queue').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM org_registry_outbox').get()).toEqual({ n: 1 });
    expect(
      f.db.prepare('SELECT provider_job_ref FROM compute_jobs WHERE id=?').get('real-provider-job')
    ).toEqual({ provider_job_ref: 'active-remote-job-reference' });
    expect(await readFile(join(f.otherRoot, 'untouched.txt'), 'utf8')).toBe('unrelated original');
  });

  it.each(['workspace', 'database'])(
    'rechecks dirty state after waiting for the %s owner',
    async (owner) => {
      const f = await fixture();
      await f.ensure();
      const release =
        owner === 'workspace'
          ? await acquireWorkspaceSyncMutationLease(f.root)
          : await acquireWorkspaceSyncDatabaseFence(f.db);
      const pending = recover(f);
      const rejection = expect(pending).rejects.toThrow('Save unsaved changes');
      await Promise.resolve();
      dirty.hasDirtyWork = true;
      release();
      await rejection;
      expect(await outputs(f)).toEqual([]);
    }
  );

  it('refuses recovery without a pre-enrollment checkpoint or while inside a SQLite transaction', async () => {
    const f = await fixture();
    await expect(recover(f)).rejects.toThrow('No verified pre-enrollment checkpoint');
    f.db.exec('BEGIN');
    try {
      await expect(recover(f)).rejects.toThrow('open transaction');
    } finally {
      f.db.exec('ROLLBACK');
    }
  });

  it.each(['recovery-staging-created', 'before-recovery-publication'])(
    'does not publish partial legacy output after interruption at %s',
    async (step) => {
      const f = await fixture();
      await f.ensure();
      await expect(
        recover(f, {
          afterStep: (actual) => {
            if (actual === step) throw new Error(`Interrupted ${step}`);
          },
        })
      ).rejects.toThrow(`Interrupted ${step}`);
      expect(await outputs(f)).toEqual([]);
      expect((await checkpoints(f)).map((checkpoint) => checkpoint.kind)).toContain('pre-recovery');
      expect(await readFile(join(f.root, 'contents', 'template.fasta'), 'utf8')).toBe(
        '>baseline\nACGTACGT\n'
      );
    }
  );

  it('retains complete recovery output if interrupted after its publication, and a retry cannot clobber it', async () => {
    const f = await fixture();
    await f.ensure();
    await expect(
      recover(f, {
        afterStep: (step) => {
          if (step === 'recovery-renamed') throw new Error('Post-publication interruption');
        },
      })
    ).rejects.toThrow('Post-publication interruption');
    const first = await outputs(f);
    expect(first).toHaveLength(1);
    const receipt = await readFile(
      join(scientificRecoveryDirectory(f.db), first[0], 'recovery.json')
    );
    await recover(f);
    expect(await outputs(f)).toHaveLength(2);
    expect(
      await readFile(join(scientificRecoveryDirectory(f.db), first[0], 'recovery.json'))
    ).toEqual(receipt);
  });

  it('rejects newly dirty editors at the final publication boundary', async () => {
    const f = await fixture();
    await f.ensure();
    await expect(
      recover(f, {
        afterStep: (step) => {
          if (step === 'before-recovery-publication') dirty.hasDirtyWork = true;
        },
      })
    ).rejects.toThrow('Save unsaved changes');
    expect(await outputs(f)).toEqual([]);
  });

  it('rejects corruption of its staged project before publication instead of claiming a usable recovery copy', async () => {
    const f = await fixture();
    await f.ensure();
    await expect(
      recover(f, {
        afterStep: async (step, path) => {
          if (step === 'before-recovery-publication')
            await writeFile(
              join(path, 'profile', 'project', 'contents', 'template.fasta'),
              'corrupted staged output'
            );
        },
      })
    ).rejects.toThrow();
    expect(await outputs(f)).toEqual([]);
  });

  it('retains both archives and publishes nothing when recovery database durability fails', async () => {
    const f = await fixture();
    await f.ensure();
    await expect(
      recover(f, {
        flushFile: async (path) => {
          if (path.includes('legacy-') && path.endsWith('dnaforge.db'))
            throw new Error('Recovery fsync EIO');
          const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      })
    ).rejects.toThrow('Recovery fsync EIO');
    expect(await outputs(f)).toEqual([]);
    expect((await checkpoints(f)).map((checkpoint) => checkpoint.kind)).toEqual([
      'pre-enrollment',
      'pre-recovery',
    ]);
  });

  it('refuses publication if the sanitized Git configuration durability barrier fails', async () => {
    const f = await fixture();
    await f.ensure();
    let recoveryStarted = false,
      originalConfigCopied = false;
    await expect(
      recover(f, {
        afterStep: (step, path) => {
          if (step === 'recovery-staging-created') recoveryStarted = true;
          if (recoveryStarted && step === 'copied-member' && path === '.git/config')
            originalConfigCopied = true;
        },
        flushFile: async (path) => {
          if (recoveryStarted && originalConfigCopied && path.endsWith('/.git/config'))
            throw new Error('Sanitized Git config fsync EIO');
          const handle = await import('node:fs/promises').then((fs) => fs.open(path, 'r'));
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      })
    ).rejects.toThrow('Sanitized Git config fsync EIO');
    expect(originalConfigCopied).toBe(true);
    expect(await outputs(f)).toEqual([]);
    expect((await checkpoints(f)).map((checkpoint) => checkpoint.kind)).toEqual([
      'pre-enrollment',
      'pre-recovery',
    ]);
  });

  it('rejects a tampered baseline and retains the original enrolled database', async () => {
    const f = await fixture();
    await f.ensure();
    accept(f);
    const [baseline] = await checkpoints(f),
      head = f.store.read().head;
    await writeFile(
      join(scientificRecoveryDirectory(f.db), baseline.id, 'project', 'contents', 'template.fasta'),
      'tampered baseline'
    );
    await expect(recover(f)).rejects.toThrow('files differ');
    expect(f.store.read().head).toBe(head);
    expect(await outputs(f)).toEqual([]);
  });

  it.each([40, 41, 44, CURRENT_SCHEMA_VERSION + 1])(
    'refuses unsupported schema %s instead of pretending to downgrade it',
    async (version) => {
      const f = await fixture();
      f.db.pragma(`user_version = ${version}`);
      const originalDb = Buffer.from(f.db.serialize());
      await expect(f.ensure()).rejects.toThrow('qualified scientific schema 42 or 43 to 41');
      expect(f.store.read().head).toBeNull();
      expect(Buffer.from(f.db.serialize())).toEqual(originalDb);
      const [baseline] = await checkpoints(f),
        clone = join(f.tmpDir, 'clone.db');
      await copyFile(join(scientificRecoveryDirectory(f.db), baseline.id, 'database.db'), clone);
      const db = openFileTestDb(clone);
      try {
        db.pragma(`user_version = ${version}`);
        expect(() =>
          prepareScientificLegacyDatabase({
            db,
            workspaceId: f.workspaceId,
            sourceRoot: f.root,
            projectPath: join(f.tmpDir, 'legacy'),
            recoveryDirectory: join(f.tmpDir, 'output'),
          })
        ).toThrow('qualified scientific schema 42 or 43 to 41');
        expect(db.pragma('user_version', { simple: true })).toBe(version);
      } finally {
        db.close();
      }
    }
  );

  it('refuses a different owner or an already accepted database before deleting any scientific history', async () => {
    const f = await fixture();
    await f.ensure();
    accept(f);
    const before = Buffer.from(f.db.serialize());
    expect(() =>
      prepareScientificLegacyDatabase({
        db: f.db,
        workspaceId: f.workspaceId,
        sourceRoot: '/wrong-owner',
        projectPath: '/recovery',
        recoveryDirectory: '/output',
      })
    ).toThrow('different project owner');
    expect(() =>
      prepareScientificLegacyDatabase({
        db: f.db,
        workspaceId: f.workspaceId,
        sourceRoot: f.root,
        projectPath: '/recovery',
        recoveryDirectory: '/output',
      })
    ).toThrow('verified pre-enrollment');
    expect(Buffer.from(f.db.serialize())).toEqual(before);
  });

  it('does not confuse another project checkpoint with the requested project recovery authority', async () => {
    const f = await fixture();
    await f.ensure();
    const [baseline] = await checkpoints(f);
    await expect(
      createScientificLegacyRecovery({
        db: f.db,
        workspaceId: f.otherId,
        checkpointId: baseline.id,
        deps,
      })
    ).rejects.toThrow('No verified pre-enrollment checkpoint');
  });

  it('verifies recovery receipt bytes and preserved checkpoint after restarting the SQLite connection', async () => {
    const f = await fixture();
    await f.ensure();
    accept(f);
    const result = await recover(f),
      receipt = JSON.parse(await readFile(join(result.directory, 'recovery.json'), 'utf8'));
    expect(receipt.database).toEqual(
      await hashScientificRecoveryFile(join(result.profilePath, 'dnaforge.db'))
    );
    f.db.close();
    const reopened = openFileTestDb(f.dbPath);
    try {
      const archived = await verifyScientificRecoveryCheckpoint(
        join(scientificRecoveryDirectory(reopened), result.preservedCurrentCheckpointId),
        { db: reopened, workspaceId: f.workspaceId, deps }
      );
      expect(archived.acceptedHead).not.toBeNull();
      expect(reopened.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
  });
});
