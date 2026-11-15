import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: () => '1.0.0', isPackaged: false },
}));
vi.mock('../../analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from '../../__tests__/test-db';
import { CURRENT_SCHEMA_VERSION, ensureSchemaForBuild } from '../../schema';

let fixture: ReturnType<typeof createFileTestDb> | undefined;

afterEach(async () => {
  if (!fixture) return;
  try {
    if (process.env.AGENT_STOP_EVIDENCE) {
      mkdirSync(process.env.AGENT_STOP_EVIDENCE, { recursive: true });
      await fixture.db.backup(
        path.join(process.env.AGENT_STOP_EVIDENCE, 'versioned-migration.sqlite')
      );
    }
  } finally {
    if (fixture.db.open) fixture.db.close();
    fixture.cleanup();
    fixture = undefined;
  }
});

it('upgrades schema 47 stop records through the authorized build path and reopens without repairs', () => {
  fixture = createFileTestDb('agent-stop-schema-upgrade');
  const writer = { version: '1.0.0', isReleaseBuild: true, fingerprint: 'fixture', writtenAt: 100 };
  ensureSchemaForBuild(fixture.db, fixture.dbPath, { migrationAllowed: true, writer });
  fixture.db.exec(`
    INSERT INTO agent_sessions (
      id, provider, authority_profile_id, authority_class, release_mode, status,
      cwd, provider_versions_json, authority_json, started_at, updated_at, completed_at
    ) VALUES ('active', 'codex-sdk', 'profile', 'app-supervised', 'read_only', 'stop_requested',
      '/workspace', '{}', '{}', 10, 20, NULL),
      ('final', 'codex-sdk', 'profile', 'app-supervised', 'read_only', 'stop_requested',
      '/workspace', '{}', '{}', 10, 20, 30);
    PRAGMA user_version = 47;
  `);
  const rows = () => fixture!.db.prepare('SELECT * FROM agent_sessions ORDER BY id').all();
  const legacy = rows() as Array<Record<string, unknown>>;
  fixture.db.close();
  fixture.db = openFileTestDb(fixture.dbPath);
  expect(() =>
    ensureSchemaForBuild(fixture!.db, fixture!.dbPath, { migrationAllowed: false, writer })
  ).toThrow(/not authorized/i);
  expect(rows()).toEqual(legacy);
  ensureSchemaForBuild(fixture.db, fixture.dbPath, { migrationAllowed: true, writer });
  const migrated = legacy.map((row) => ({
    ...row,
    status: row.completed_at === null ? 'stopping' : 'stop_unconfirmed',
  }));
  expect(rows()).toEqual(migrated);
  expect(fixture.db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  fixture.db.close();
  fixture.db = openFileTestDb(fixture.dbPath);
  ensureSchemaForBuild(fixture.db, fixture.dbPath, { migrationAllowed: false, writer });
  expect(rows()).toEqual(migrated);
  expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM analytics_event_outbox').get()).toEqual({
    count: 0,
  });
});
