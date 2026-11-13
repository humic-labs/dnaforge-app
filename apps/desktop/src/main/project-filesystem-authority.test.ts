import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BENCHLING_MIGRATION_WORKSPACE_MARKER,
  MANAGED_WORKSPACE_MARKER,
} from '../shared/workspace-git-types';
import { createTestDb } from './__tests__/test-db';
import { resolveProjectRootInMain } from './project-filesystem-authority';
import { ensureSchema } from './schema';

const electronPaths = vi.hoisted(() => ({ home: '', userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: (name: keyof typeof electronPaths) => electronPaths[name] },
}));

describe('managed project root identity', () => {
  let root: string;
  let managedRootDir: string;
  let db: Database.Database;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'managed-project-identity-')));
    electronPaths.home = join(root, 'home');
    electronPaths.userData = join(root, 'user-data');
    managedRootDir = join(electronPaths.userData, 'managed-workspaces');
    await mkdir(electronPaths.home);
    await mkdir(managedRootDir, { recursive: true });
    db = createTestDb();
    ensureSchema(db, ':memory:');
  });

  afterAll(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function managedProject(uuid: string, marker: { path: string; body: unknown }) {
    const repo = join(managedRootDir, uuid, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, marker.path, '..'), { recursive: true });
    await writeFile(join(repo, marker.path), `${JSON.stringify(marker.body)}\n`);
    db.prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)').run(
      uuid,
      repo,
      uuid
    );
    return repo;
  }

  function benchlingMarker(workspaceId: string) {
    return {
      path: BENCHLING_MIGRATION_WORKSPACE_MARKER,
      body: {
        schema: 'dnaforge.benchling-migration-workspace.v1',
        workspaceId,
        runId: `migration-${workspaceId}`,
        status: 'unlocked',
        createdAt: '2026-11-12T00:00:00.000Z',
      },
    };
  }

  it('opens a project that Benchling import created in managed storage', async () => {
    const uuid = '6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5001';
    const repo = await managedProject(uuid, benchlingMarker(uuid));

    await expect(
      resolveProjectRootInMain({ path: repo }, { db, managedRootDir })
    ).resolves.toMatchObject({ rootPath: repo, repoUuid: uuid });
  });

  it('still opens a project that carries the managed workspace marker', async () => {
    const uuid = '6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5002';
    const repo = await managedProject(uuid, {
      path: MANAGED_WORKSPACE_MARKER,
      body: { schema: 1, workspaceUuid: uuid },
    });

    await expect(
      resolveProjectRootInMain({ path: repo }, { db, managedRootDir })
    ).resolves.toMatchObject({ rootPath: repo, repoUuid: uuid });
  });

  it('refuses a Benchling identity that names another project', async () => {
    const uuid = '6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5003';
    const repo = await managedProject(
      uuid,
      benchlingMarker('6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5099')
    );

    await expect(resolveProjectRootInMain({ path: repo }, { db, managedRootDir })).rejects.toThrow(
      'PROJECT_ROOT_INVALID: The project identity does not match its registered owner.'
    );
  });

  it('refuses a Benchling identity reached through a linked folder', async () => {
    const uuid = '6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5004';
    const repo = join(managedRootDir, uuid, 'repo');
    const elsewhere = join(root, 'elsewhere-migration');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.dnaforge'), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(
      join(elsewhere, 'workspace.json'),
      `${JSON.stringify(benchlingMarker(uuid).body)}\n`
    );
    await symlink(elsewhere, join(repo, '.dnaforge', 'migration'), 'dir');
    db.prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)').run(
      uuid,
      repo,
      uuid
    );

    await expect(resolveProjectRootInMain({ path: repo }, { db, managedRootDir })).rejects.toThrow(
      'PROJECT_ROOT_INVALID: The project identity or repository structure is missing.'
    );
  });

  it('refuses a managed project without any app-written identity', async () => {
    const uuid = '6b0f2c47-5f0e-4d1e-9a3b-0d3c1a2b5005';
    const repo = join(managedRootDir, uuid, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    db.prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)').run(
      uuid,
      repo,
      uuid
    );

    await expect(resolveProjectRootInMain({ path: repo }, { db, managedRootDir })).rejects.toThrow(
      'PROJECT_ROOT_INVALID: The project identity or repository structure is missing.'
    );
  });
});
