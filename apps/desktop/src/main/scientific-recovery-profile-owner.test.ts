import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type SQLite from 'better-sqlite3';
vi.mock('better-sqlite3', async () => {
  const { default: Database } = await vi.importActual<{ default: typeof SQLite }>('better-sqlite3');
  return {
    default: class extends Database {
      constructor(path: string, options?: SQLite.Options) {
        super(path, {
          ...options,
          nativeBinding: join(
            import.meta.dirname,
            '__tests__/__fixtures__/better_sqlite3_node.node'
          ),
        });
      }
    },
  };
});
import { acquireScientificRecoveryProfileOwner } from './scientific-recovery-profile-owner';
import { scientificRecoveryFeature } from './features/scientific-recovery';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function profile() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scientific-profile-owner-')));
  roots.push(root);
  const owner = JSON.stringify({
    schema: 'dnaforge.scientific-recovery-profile/v1',
    workspaceId: '31da3243-0000-4000-8000-000000000001',
    candidateId: '31da3243-0000-4000-8000-000000000003',
    accountId: '31da3243-0000-4000-8000-000000000002',
  });
  const directory = join(
    root,
    'scientific-cloud-recovery',
    createHash('sha256').update(owner).digest('hex')
  );
  const path = join(directory, 'profile');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(directory, 'owner.json'), owner);
  return path;
}
it('keeps recovery and application startup mutually exclusive for the whole owned operation', () => {
  const path = profile();
  const release = acquireScientificRecoveryProfileOwner(path, 'recovery')!;
  expect(() => scientificRecoveryFeature.prepareProfile?.(path)).toThrow(
    'another application or recovery process'
  );
  expect(() => acquireScientificRecoveryProfileOwner(path, 'application')).toThrow(
    'another application or recovery process'
  );
  release();
  const appRelease = acquireScientificRecoveryProfileOwner(path, 'application')!;
  expect(() => acquireScientificRecoveryProfileOwner(path, 'recovery')).toThrow(
    'another application or recovery process'
  );
  appRelease();
});
it('refuses changed profile authority without replacing its receipt', () => {
  const path = profile();
  const owner = join(path, '..', 'owner.json');
  const replacement = readFileSync(owner, 'utf8').replace('000000000001', '000000000004');
  writeFileSync(owner, replacement);
  expect(() => acquireScientificRecoveryProfileOwner(path, 'recovery')).toThrow('receipt changed');
  expect(readFileSync(owner, 'utf8')).toBe(replacement);
});
it('leaves ordinary application profiles outside the recovery lock', () => {
  expect(
    acquireScientificRecoveryProfileOwner('/ordinary/application/profile', 'application')
  ).toBeNull();
});
