/** @vitest-environment node */
import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => host.userData, getVersion: () => '1.0.0' } }));

import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import {
  findFixturePath,
  seedLimsMockDemoInDb,
  seedLimsStarterRegistryInDb,
} from '../lims-demo-seed';
import { seedLimsScenarioWithOwnedFixtures } from '../lims-scenario-seed';
import { prepareDisposableScenarioProfile } from '../scenario-profile';
import { rememberDeveloperImportSourceRootsInDb } from '../registry-source-eligibility';
import { getRegistryCandidateEntities } from '../lims-registry-projection';
import {
  assertLimsProjectionReplayParityInDb,
  verifyLimsAuditHashChainInDb,
} from '../lims-projection-rebuild';
import { MANAGED_WORKSPACE_MARKER } from '../../shared/workspace-git-types';

let db: Database.Database;
beforeEach(() => {
  host.userData = mkdtempSync(join(tmpdir(), 'dnaforge-scenario-copy-contract-'));
  prepareDisposableScenarioProfile({
    requested: true,
    explicitUserDataPath: host.userData,
  });
  db = createTestDb();
  ensureSchema(db, ':memory:');
  rememberDeveloperImportSourceRootsInDb(db, [findFixturePath('test-fixtures')]);
});
afterEach(() => {
  db.close();
  rmSync(host.userData, { recursive: true, force: true });
});

const runDatabase = <T>(operation: () => T): T => operation();

describe('intentional scenario imports own their current file bytes', () => {
  it('mock seeding stays eligible through current imported copies and never changes source bytes', async () => {
    const originalPath = findFixturePath('test-fixtures/sequences/circular/pUC19.gb');
    const original = readFileSync(originalPath);
    const result = await seedLimsScenarioWithOwnedFixtures({
      db,
      dataset: 'mock',
      runDatabase,
      seed: () => seedLimsMockDemoInDb(db),
    });
    const visible = getRegistryCandidateEntities(db);
    expect(visible.some((entity) => entity.id === result.plasmidId)).toBe(true);
    expect(visible.some((entity) => entity.id === result.genomeId)).toBe(true);
    const binding = db
      .prepare(
        `SELECT f.path, f.workspace_id, w.path AS repo_path, w.repo_uuid
       FROM catalog_entity_files f JOIN workspaces w ON w.id=f.workspace_id
       WHERE f.entity_id=? AND f.status='current'`
      )
      .get(result.plasmidId) as {
      path: string;
      workspace_id: number;
      repo_path: string;
      repo_uuid: string;
    };
    expect(binding.path.startsWith(`${binding.repo_path}/`)).toBe(true);
    expect(readFileSync(binding.path)).toEqual(original);
    expect(readFileSync(originalPath)).toEqual(original);
    expect(existsSync(join(binding.repo_path, '.git'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(binding.repo_path, MANAGED_WORKSPACE_MARKER), 'utf8'))
        .workspaceUuid
    ).toBe(binding.repo_uuid);
    expect(
      execFileSync('git', ['-C', binding.repo_path, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim()
    ).toBe(binding.repo_path);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();

    await seedLimsScenarioWithOwnedFixtures({
      db,
      dataset: 'mock',
      runDatabase,
      seed: () => seedLimsMockDemoInDb(db, { reset: true, resetScope: 'dev-seed' }),
    });
    expect(db.prepare('SELECT COUNT(*) FROM workspaces').pluck().get()).toBe(1);
    expect(getRegistryCandidateEntities(db).some((entity) => entity.id === result.plasmidId)).toBe(
      true
    );
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
  });

  it('starter chromosomes all acquire owned current bindings rather than direct fixture references', async () => {
    await seedLimsScenarioWithOwnedFixtures({
      db,
      dataset: 'starter',
      runDatabase,
      seed: () => seedLimsStarterRegistryInDb(db),
    });
    const chromosomes = db
      .prepare("SELECT id, fields FROM lims_entity WHERE kind='chromosome' AND tombstone=0")
      .all() as Array<{ id: string; fields: string }>;
    expect(chromosomes.length).toBe(17);
    const visible = new Set(getRegistryCandidateEntities(db).map((entity) => entity.id));
    for (const chromosome of chromosomes) {
      expect(visible.has(chromosome.id)).toBe(true);
      const sequence = JSON.parse(chromosome.fields).sequence as { mode: string; relPath: string };
      expect(sequence.mode).toBe('file');
      expect(sequence.relPath.startsWith(`${realpathSync(host.userData)}/`)).toBe(true);
      expect(
        db
          .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
          .pluck()
          .get(chromosome.id)
      ).toBe(sequence.relPath);
    }
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
  });

  it('failed seeding rolls back workspace publication and removes only its owned partial project', async () => {
    await expect(
      seedLimsScenarioWithOwnedFixtures({
        db,
        dataset: 'mock',
        runDatabase,
        seed: () => {
          seedLimsMockDemoInDb(db);
          throw new Error('scenario import failed');
        },
      })
    ).rejects.toThrow('scenario import failed');
    expect(db.prepare('SELECT COUNT(*) FROM workspaces').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM lims_entity').pluck().get()).toBe(0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) FROM settings WHERE key LIKE 'developer-registry-scenario-workspace:%'"
        )
        .pluck()
        .get()
    ).toBe(0);
  });
});
