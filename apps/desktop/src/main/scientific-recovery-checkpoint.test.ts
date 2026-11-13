import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import {
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
} from '@waypoint/workspace-revisions';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { CURRENT_SCHEMA_VERSION, ensureSchema } from './schema';
import { ScientificObjectStore } from './scientific-object-store';
import { acquireWorkspaceSyncDatabaseFence } from './workspace-sync-database-fence';
import { acquireWorkspaceSyncMutationLease } from './workspace-sync-mutation-lease';
import {
  captureScientificRecoveryCheckpoint,
  flushScientificRecoveryFile,
  hashScientificRecoveryFile,
  scientificRecoveryDirectory,
  verifyScientificRecoveryCheckpoint,
  type ScientificRecoveryCheckpoint,
  type ScientificRecoveryDependencies,
} from './scientific-recovery-checkpoint';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const deps = { openDatabase: openFileTestDb };
const gitEnvironment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

async function fixture() {
  const allocated = createFileTestDb('scientific-checkpoint-pressure');
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
  const root = join(file.tmpDir, 'project');
  await mkdir(join(root, 'contents'), { recursive: true });
  await writeFile(join(root, 'contents', 'template.fasta'), '>template\nACGTACGT\n');
  await writeFile(join(root, '.gitignore'), 'untracked.bin\n');
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
      'Before enrollment',
    ],
    { env: gitEnvironment }
  );
  await writeFile(join(root, 'untracked.bin'), Buffer.from([0, 255, 1, 128]));
  await mkdir(join(root, 'empty'));
  const workspaceId = Number(
    file.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES (?,?,?,1)')
      .run('Checkpoint pressure', root, 'checkpoint-pressure-owner').lastInsertRowid
  );
  const capture = async (
    faults: ScientificRecoveryDependencies = {},
    kind: ScientificRecoveryCheckpoint['kind'] = 'pre-enrollment'
  ) => {
    const releaseWorkspace = await acquireWorkspaceSyncMutationLease(root);
    try {
      const releaseDatabase = await acquireWorkspaceSyncDatabaseFence(file.db);
      try {
        return await captureScientificRecoveryCheckpoint({
          db: file.db,
          workspaceId,
          kind,
          deps: { ...deps, ...faults },
        });
      } finally {
        releaseDatabase();
      }
    } finally {
      releaseWorkspace();
    }
  };
  return { ...file, root, workspaceId, capture };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const checkpointPath = (f: Fixture, checkpoint: ScientificRecoveryCheckpoint) =>
  join(scientificRecoveryDirectory(f.db), checkpoint.id);
const verify = (f: Fixture, checkpoint: ScientificRecoveryCheckpoint) =>
  verifyScientificRecoveryCheckpoint(checkpointPath(f, checkpoint), {
    db: f.db,
    workspaceId: f.workspaceId,
    deps,
  });
async function modifyManifest(
  f: Fixture,
  checkpoint: ScientificRecoveryCheckpoint,
  change: (manifest: ScientificRecoveryCheckpoint) => void
) {
  const path = join(checkpointPath(f, checkpoint), 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as ScientificRecoveryCheckpoint;
  change(manifest);
  await writeFile(path, JSON.stringify(manifest));
}
async function published(f: Fixture) {
  return (await readdir(scientificRecoveryDirectory(f.db)).catch(() => [])).filter((name) =>
    /^[0-9a-f-]{36}$/u.test(name)
  );
}

describe('complete scientific recovery checkpoint on real SQLite and native files', () => {
  it('preserves committed WAL rows, complete Git, ignored bytes and empty directories with independent inodes', async () => {
    const f = await fixture();
    f.db
      .prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,1)')
      .run('wal-proof', 'committed immediately before snapshot');
    const checkpoint = await f.capture();
    expect(await verify(f, checkpoint)).toEqual(checkpoint);
    const path = checkpointPath(f, checkpoint);
    const archived = openFileTestDb(join(path, 'database.db'));
    try {
      expect(archived.prepare('SELECT value FROM settings WHERE key=?').get('wal-proof')).toEqual({
        value: 'committed immediately before snapshot',
      });
      expect(archived.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      archived.close();
    }
    const sourceHead = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], {
      env: gitEnvironment,
    }).toString();
    expect(
      execFileSync('git', ['-C', join(path, 'project'), 'rev-parse', 'HEAD'], {
        env: gitEnvironment,
      }).toString()
    ).toBe(sourceHead);
    expect(await readFile(join(path, 'project', 'untracked.bin'))).toEqual(
      Buffer.from([0, 255, 1, 128])
    );
    expect((await lstat(join(path, 'project', 'empty'))).isDirectory()).toBe(true);
    for (const member of checkpoint.files.filter((member) => member.kind === 'file')) {
      const [original, copy] = await Promise.all([
        lstat(join(f.root, member.path)),
        lstat(join(path, 'project', member.path)),
      ]);
      expect(`${copy.dev}:${copy.ino}`).not.toBe(`${original.dev}:${original.ino}`);
    }
    await writeFile(join(f.root, 'untracked.bin'), 'new original work');
    expect(await readFile(join(path, 'project', 'untracked.bin'))).toEqual(
      Buffer.from([0, 255, 1, 128])
    );
  });

  it.each([
    'staging-created',
    'database-copied',
    'copied-member',
    'tree-copied',
    'before-checkpoint-publication',
  ])('leaves no published checkpoint after interruption at %s', async (step) => {
    const f = await fixture();
    await expect(
      f.capture({
        afterStep: (actual) => {
          if (actual === step) throw new Error(`Interrupted ${step}`);
        },
      })
    ).rejects.toThrow(`Interrupted ${step}`);
    expect(await published(f)).toEqual([]);
    expect(await readFile(join(f.root, 'contents', 'template.fasta'), 'utf8')).toBe(
      '>template\nACGTACGT\n'
    );
    expect(f.db.pragma('quick_check', { simple: true })).toBe('ok');
  });

  it('retains a fully verifiable checkpoint if interrupted just after atomic publication', async () => {
    const f = await fixture();
    await expect(
      f.capture({
        afterStep: (step) => {
          if (step === 'checkpoint-renamed') throw new Error('Post-rename interruption');
        },
      })
    ).rejects.toThrow('Post-rename interruption');
    const names = await published(f);
    expect(names).toHaveLength(1);
    expect(
      (
        await verifyScientificRecoveryCheckpoint(
          join(scientificRecoveryDirectory(f.db), names[0]),
          { db: f.db, workspaceId: f.workspaceId, deps }
        )
      ).kind
    ).toBe('pre-enrollment');
  });

  it.each(['database', 'project member'])(
    'rejects staged %s corruption at the final checkpoint publication boundary',
    async (kind) => {
      const f = await fixture();
      const error = await f
        .capture({
          afterStep: async (step, path) => {
            if (step !== 'before-checkpoint-publication') return;
            await writeFile(
              kind === 'database'
                ? join(path, 'database.db')
                : join(path, 'project', 'contents', 'template.fasta'),
              'staged corruption before publication'
            );
          },
        })
        .then(
          () => null,
          (cause: unknown) => cause
        );
      expect(error).toBeInstanceOf(Error);
      expect(await published(f)).toEqual([]);
    }
  );

  it.each(['database.db', 'template.fasta', 'manifest.json'])(
    'refuses publication when the %s durability barrier fails',
    async (member) => {
      const f = await fixture();
      await expect(
        f.capture({
          flushFile: async (path) => {
            if (path.endsWith(member)) throw new Error('Injected EIO durability failure');
            await flushScientificRecoveryFile(path);
          },
        })
      ).rejects.toThrow('Injected EIO durability failure');
      expect(await published(f)).toEqual([]);
    }
  );

  it.each(['edit', 'add', 'remove', 'same-byte replacement'])(
    'rejects source %s during capture without publishing a mixed checkpoint',
    async (mutation) => {
      const f = await fixture();
      await expect(
        f.capture({
          afterStep: async (step) => {
            if (step !== 'tree-copied') return;
            const path = join(f.root, 'contents', 'template.fasta');
            if (mutation === 'edit') await writeFile(path, '>template\nTTTTTTTT\n');
            if (mutation === 'add')
              await writeFile(join(f.root, 'new-file'), 'concurrent addition');
            if (mutation === 'remove') await rm(path);
            if (mutation === 'same-byte replacement') {
              const replacement = `${path}.replacement`;
              await copyFile(path, replacement, constants.COPYFILE_EXCL);
              await rename(replacement, path);
            }
          },
        })
      ).rejects.toThrow('Recovery source changed during capture');
      expect(await published(f)).toEqual([]);
    }
  );

  it('rejects committed changes from a second SQLite connection during capture', async () => {
    const f = await fixture();
    const other = openFileTestDb(f.dbPath);
    try {
      await expect(
        f.capture({
          afterStep: (step) => {
            if (step === 'tree-copied')
              other
                .prepare('INSERT INTO settings(key,value,updated_at) VALUES (?,?,1)')
                .run('concurrent', 'new');
          },
        })
      ).rejects.toThrow('Recovery source changed during capture');
    } finally {
      other.close();
    }
    expect(await published(f)).toEqual([]);
  });

  it.each(['member', 'root'])('rejects a symlinked source %s', async (kind) => {
    const f = await fixture();
    if (kind === 'member') await symlink(f.dbPath, join(f.root, 'outside-link'));
    else {
      const alias = `${f.root}-alias`;
      await symlink(f.root, alias);
      f.db.prepare('UPDATE workspaces SET path=? WHERE id=?').run(alias, f.workspaceId);
    }
    await expect(f.capture()).rejects.toThrow(/alias|link/u);
  });

  it.each([
    'gitfile',
    'commondir',
    'alternates',
    'http-alternates',
    'worktree',
    'hooksPath',
    'include',
    'nested gitfile',
    'sha256 object format',
    'registered worktree',
  ])('rejects external Git dependency %s before producing a checkpoint', async (kind) => {
    const f = await fixture();
    const git = join(f.root, '.git');
    if (kind === 'gitfile') {
      await rename(git, join(f.tmpDir, 'external-git'));
      await writeFile(git, `gitdir: ${join(f.tmpDir, 'external-git')}\n`);
    } else if (kind === 'commondir') await writeFile(join(git, 'commondir'), '../external');
    else if (kind === 'alternates' || kind === 'http-alternates')
      await writeFile(join(git, 'objects', 'info', kind), '/external/objects\n');
    else if (kind === 'nested gitfile') {
      await mkdir(join(f.root, 'nested-checkout'));
      await writeFile(join(f.root, 'nested-checkout', '.git'), `gitdir: ${git}\n`);
    } else if (kind === 'registered worktree') {
      execFileSync(
        'git',
        [
          '-C',
          f.root,
          'worktree',
          'add',
          '--quiet',
          '--detach',
          join(f.tmpDir, 'external-worktree'),
          'HEAD',
        ],
        { env: gitEnvironment }
      );
    } else if (kind === 'sha256 object format') {
      await rm(git, { recursive: true });
      execFileSync('git', ['init', '--quiet', '--object-format=sha256', f.root], {
        env: gitEnvironment,
      });
      execFileSync('git', ['-C', f.root, 'add', '.'], { env: gitEnvironment });
      execFileSync(
        'git',
        [
          '-C',
          f.root,
          '-c',
          'user.name=Recovery Test',
          '-c',
          'user.email=recovery@example.test',
          'commit',
          '--quiet',
          '-m',
          'Actual SHA256 repository',
        ],
        { env: gitEnvironment }
      );
      expect(
        execFileSync('git', ['-C', f.root, 'rev-parse', '--show-object-format'], {
          env: gitEnvironment,
        })
          .toString()
          .trim()
      ).toBe('sha256');
    } else
      await writeFile(
        join(git, 'config'),
        kind === 'include' ? '[include]\npath=/outside/config\n' : `[core]\n${kind}=/outside\n`
      );
    await expect(f.capture()).rejects.toThrow(/Git|external/u);
  });

  it('rejects recovery storage located inside any registered project', async () => {
    const f = await fixture();
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES (?,?,?,1)')
      .run('Profile ancestor', f.tmpDir, 'other-owner');
    await expect(f.capture()).rejects.toThrow('outside every project source');
  });

  it('rejects open SQLite transactions before creating staging files', async () => {
    const f = await fixture();
    f.db.exec('BEGIN');
    try {
      await expect(
        captureScientificRecoveryCheckpoint({
          db: f.db,
          workspaceId: f.workspaceId,
          kind: 'pre-enrollment',
          deps,
        })
      ).rejects.toThrow('open database transaction');
    } finally {
      f.db.exec('ROLLBACK');
    }
  });

  it.each([
    [
      'future version',
      (m: ScientificRecoveryCheckpoint) => {
        m.version = 2 as 1;
      },
    ],
    [
      'workspace identity',
      (m: ScientificRecoveryCheckpoint) => {
        m.workspaceUuid = 'different-owner';
      },
    ],
    [
      'workspace id',
      (m: ScientificRecoveryCheckpoint) => {
        m.workspaceId += 1;
      },
    ],
    [
      'source root',
      (m: ScientificRecoveryCheckpoint) => {
        m.sourceRoot = '/outside';
      },
    ],
    [
      'accepted head',
      (m: ScientificRecoveryCheckpoint) => {
        m.acceptedHead = 'forged-head';
      },
    ],
    [
      'schema',
      (m: ScientificRecoveryCheckpoint) => {
        m.schemaVersion += 1;
      },
    ],
    [
      'path escape',
      (m: ScientificRecoveryCheckpoint) => {
        m.files[0].path = '../outside';
      },
    ],
    [
      'absolute path',
      (m: ScientificRecoveryCheckpoint) => {
        m.files[0].path = '/outside';
      },
    ],
    [
      'Windows path',
      (m: ScientificRecoveryCheckpoint) => {
        m.files[0].path = 'C:\\outside';
      },
    ],
    [
      'duplicate path',
      (m: ScientificRecoveryCheckpoint) => {
        m.files.push({ ...m.files[0] });
      },
    ],
    [
      'case collision',
      (m: ScientificRecoveryCheckpoint) => {
        m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase() });
      },
    ],
    [
      'negative member length',
      (m: ScientificRecoveryCheckpoint) => {
        m.files.find((file) => file.kind === 'file')!.byteLength = -1;
      },
    ],
  ] as const)('rejects corrupted manifest: %s', async (_name, change) => {
    const f = await fixture(),
      checkpoint = await f.capture();
    await modifyManifest(f, checkpoint, change);
    await expect(verify(f, checkpoint)).rejects.toThrow();
  });

  it.each([
    'truncated database',
    'missing database',
    'modified member',
    'missing member',
    'extra member',
    'mutable sidecar',
    'symlink member',
  ])('rejects checkpoint corruption: %s', async (kind) => {
    const f = await fixture(),
      checkpoint = await f.capture(),
      path = checkpointPath(f, checkpoint);
    const member = join(path, 'project', 'contents', 'template.fasta');
    if (kind === 'truncated database') await truncate(join(path, 'database.db'), 64);
    if (kind === 'missing database') await rm(join(path, 'database.db'));
    if (kind === 'modified member') await writeFile(member, 'corrupt');
    if (kind === 'missing member') await rm(member);
    if (kind === 'extra member') await writeFile(join(path, 'project', 'extra'), 'not in manifest');
    if (kind === 'mutable sidecar')
      await writeFile(join(path, 'database.db-wal'), 'not a closed snapshot');
    if (kind === 'symlink member') {
      await rm(member);
      await symlink(join(f.root, 'contents', 'template.fasta'), member);
    }
    await expect(verify(f, checkpoint)).rejects.toThrow();
  });

  it('rejects internally changed schema even when an attacker updates the outer database digest', async () => {
    const f = await fixture(),
      checkpoint = await f.capture(),
      path = join(checkpointPath(f, checkpoint), 'database.db');
    const changed = openFileTestDb(path);
    changed.pragma('user_version = 44');
    changed.close();
    const digest = await hashScientificRecoveryFile(path);
    await modifyManifest(f, checkpoint, (manifest) => {
      manifest.database = digest;
    });
    await expect(verify(f, checkpoint)).rejects.toThrow('schema, integrity or scientific owner');
  });

  it.each(['canonical record', 'scientific blob'])(
    'rejects %s corruption inside a physically valid database with an updated outer digest',
    async (kind) => {
      const f = await fixture();
      const must = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => {
        if (!value.ok) throw new Error(JSON.stringify(value.error));
        return value.value;
      };
      const document = defineScientificDocument({
        formatVersion: 1,
        kind: 'primer',
        name: 'Preserved primer',
        molecule: 'DNA',
        bases: 'ACGTACGT',
        modifications: [],
        fields: {},
      });
      const store = new ScientificObjectStore(f.db, f.workspaceId);
      const result = store.submit({
        operationId: must(parseOperationId('accepted-before-recovery')),
        expectedHead: null,
        mutations: [
          {
            kind: 'create-resource',
            resourceId: must(parseResourceId('preserved-primer')),
            path: must(parseWorkspacePath('preserved-primer.json')),
            state: document.state,
            origin: { kind: 'created' },
          },
        ],
        blobs: [new TextEncoder().encode(document.text)],
      });
      expect(result.kind).toBe('changed');
      const checkpoint = await f.capture({}, 'pre-recovery'),
        path = join(checkpointPath(f, checkpoint), 'database.db');
      const changed = openFileTestDb(path);
      try {
        if (kind === 'canonical record')
          changed
            .prepare(
              "UPDATE scientific_revision_records SET canonical_json='{}' WHERE record_kind='resource-state'"
            )
            .run();
        else {
          const row = changed
            .prepare('SELECT blob_hash,byte_length FROM scientific_revision_blobs LIMIT 1')
            .get() as { blob_hash: string; byte_length: number };
          changed
            .prepare('UPDATE scientific_revision_blobs SET bytes=? WHERE blob_hash=?')
            .run(Buffer.alloc(row.byte_length, 0), row.blob_hash);
        }
        expect(changed.pragma('quick_check', { simple: true })).toBe('ok');
        expect(changed.pragma('foreign_key_check')).toEqual([]);
      } finally {
        changed.close();
      }
      const digest = await hashScientificRecoveryFile(path);
      await modifyManifest(f, checkpoint, (manifest) => {
        manifest.database = digest;
      });
      const error = await verify(f, checkpoint).then(
        () => null,
        (cause: unknown) => cause
      );
      expect(error).toBeInstanceOf(Error);
    }
  );

  it('rejects a valid checkpoint presented from outside its native recovery directory', async () => {
    const f = await fixture(),
      checkpoint = await f.capture(),
      path = checkpointPath(f, checkpoint),
      outside = join(f.tmpDir, checkpoint.id);
    await rename(path, outside);
    await expect(
      verifyScientificRecoveryCheckpoint(outside, { db: f.db, workspaceId: f.workspaceId, deps })
    ).rejects.toThrow('outside its native recovery owner');
  });
});
