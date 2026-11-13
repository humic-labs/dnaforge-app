import { afterEach, describe, expect, it } from 'vitest';

import {
  isProtectedImportReplacementPath,
  nextUnansweredImportDecision,
  sortPendingImportDecisions,
  summarizeImportDecisions,
  type ImportDecision,
  type PendingImportDecision,
} from '../../shared/benchling-import-decision';
import type { MigrationRun } from '../../shared/benchling-migration';
import { createFileTestDb, openFileTestDb } from '../__tests__/test-db';
import { MigrationStore } from './store';
import { parseRegistryTableMappingDecision } from '../../shared/benchling-registry-table-review';

const RUN_ID = 'run-import-decisions';
const ACTION_ID = 'action-import-decisions';
const HASH = `sha256:${'a'.repeat(64)}` as const;

describe('migration import decision store', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('persists an exact reviewed table mapping across restart and refuses a changed answer', () => {
    const fixture = createFileTestDb('reviewed-table-decisions');
    cleanups.push(fixture.cleanup);
    let store = new MigrationStore(fixture.db);
    store.saveRun(run());
    const decision = parseRegistryTableMappingDecision({
      kind: 'registry_table_mapping',
      version: 1,
      source: {
        archiveSha256: 'a'.repeat(64),
        entrySha256: 'b'.repeat(64),
        entryPath: 'Records.csv',
        entrySizeBytes: 100,
      },
      outcome: {
        kind: 'records',
        headersSha256: 'c'.repeat(64),
        rowCount: 1,
        columns: [{ kind: 'name' }],
      },
    });
    store.putImportDecision(RUN_ID, ACTION_ID, decision);
    store.putImportDecision(RUN_ID, ACTION_ID, decision);
    store.close();
    fixture.db.close();
    store = new MigrationStore(openFileTestDb(fixture.dbPath), true);
    expect(store.listImportDecisions(RUN_ID, ACTION_ID)).toEqual([decision]);
    expect(() =>
      store.putImportDecision(RUN_ID, ACTION_ID, {
        ...decision,
        outcome: { kind: 'source_only', reason: 'Changed answer' },
      })
    ).toThrow(/changed its persisted answer/i);
    store.close();
  });

  it('upgrades the old decision constraint atomically without rewriting historical answers', () => {
    const fixture = createFileTestDb('legacy-import-decisions');
    cleanups.push(fixture.cleanup);
    let store = new MigrationStore(fixture.db);
    store.saveRun(run());
    store.close();
    fixture.db.exec(`
      DROP TABLE import_decision;
      CREATE TABLE import_decision (
        run_id TEXT NOT NULL, action_id TEXT NOT NULL, decision_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('provider_version_conflict', 'unbound_exact_match', 'structural_path_conflict')),
        body_json TEXT NOT NULL CHECK(json_valid(body_json)),
        PRIMARY KEY(run_id, action_id, decision_key),
        FOREIGN KEY(run_id) REFERENCES migration_run(id)
      );
    `);
    const original = '{ "kind": "provider_version_conflict", "policy": "keep_existing" }';
    fixture.db
      .prepare('INSERT INTO import_decision VALUES (?, ?, ?, ?, ?)')
      .run(RUN_ID, ACTION_ID, 'provider_version_conflict', 'provider_version_conflict', original);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      store = new MigrationStore(fixture.db);
      expect(
        fixture.db
          .prepare('SELECT body_json FROM import_decision WHERE kind = ?')
          .get('provider_version_conflict')
      ).toEqual({ body_json: original });
      store.putImportDecision(RUN_ID, ACTION_ID, {
        kind: 'registry_table_mapping',
        version: 1,
        source: {
          archiveSha256: 'a'.repeat(64),
          entrySha256: 'b'.repeat(64),
          entryPath: 'Records.csv',
          entrySizeBytes: 100,
        },
        outcome: { kind: 'source_only', reason: 'Keep original source' },
      });
      expect(store.listImportDecisions(RUN_ID, ACTION_ID)).toHaveLength(2);
      expect(fixture.db.pragma('foreign_key_check')).toEqual([]);
      store.close();
    }
  });

  it('persists the three decision classes in deterministic prompt order across restart', () => {
    const fixture = createFileTestDb('import-decisions');
    cleanups.push(fixture.cleanup);
    let store = new MigrationStore(fixture.db);
    store.saveRun(run());

    const structural: ImportDecision = {
      kind: 'structural_path_conflict',
      relativePath: 'Designs/Shared',
      expectedExistingState: { kind: 'directory', treeSha256: HASH },
      policy: 'rename_incoming',
    };
    const exact: ImportDecision = {
      kind: 'unbound_exact_match',
      sourceObjectId: 'seq_SOURCE01',
      candidateEntityId: 'entity-existing',
      expectedCandidateScientificSha256: HASH,
      expectedBindingState: 'unbound',
      policy: 'link_existing',
    };
    const version: ImportDecision = {
      kind: 'provider_version_conflict',
      policy: 'keep_existing',
    };

    store.putImportDecision(RUN_ID, ACTION_ID, structural);
    store.putImportDecision(RUN_ID, ACTION_ID, exact);
    store.putImportDecision(RUN_ID, ACTION_ID, version);
    store.putImportDecision(RUN_ID, ACTION_ID, version);

    expect(store.listImportDecisions(RUN_ID, ACTION_ID)).toEqual([version, exact, structural]);
    store.close();
    fixture.db.close();

    const reopenedDb = openFileTestDb(fixture.dbPath);
    store = new MigrationStore(reopenedDb, true);
    expect(store.listImportDecisions(RUN_ID, ACTION_ID)).toEqual([version, exact, structural]);
    store.close();
  });

  it('refuses to change a persisted answer or accept unsafe decision authority', () => {
    const fixture = createFileTestDb('import-decision-immutability');
    cleanups.push(fixture.cleanup);
    const store = new MigrationStore(fixture.db);
    store.saveRun(run());
    store.putImportDecision(RUN_ID, ACTION_ID, {
      kind: 'provider_version_conflict',
      policy: 'keep_existing',
    });

    expect(() =>
      store.putImportDecision(RUN_ID, ACTION_ID, {
        kind: 'provider_version_conflict',
        policy: 'use_incoming',
      })
    ).toThrow(/changed its persisted answer/i);
    expect(() =>
      store.putImportDecision(RUN_ID, ACTION_ID, {
        kind: 'structural_path_conflict',
        relativePath: '../outside',
        expectedExistingState: { kind: 'file', sha256: HASH, sizeBytes: 1 },
        policy: 'replace_existing',
      })
    ).toThrow(/relative path/i);
    store.close();
  });

  it('orders and summarizes the three decision classes without conflating their scopes', () => {
    const provider: PendingImportDecision = {
      kind: 'provider_version_conflict',
      conflicts: [{ sourceObjectId: 'seq_3', stableId: 'seq_3', displayName: 'Version 3' }],
    };
    const exactA: PendingImportDecision = {
      kind: 'unbound_exact_match',
      sourceObjectId: 'seq_A',
      sourceDisplayName: 'Incoming A',
      candidateEntityId: 'native-a',
      candidateDisplayName: 'Native A',
      expectedCandidateScientificSha256: HASH,
    };
    const exactB: PendingImportDecision = { ...exactA, sourceObjectId: 'seq_B' };
    const structural: PendingImportDecision = {
      kind: 'structural_path_conflict',
      relativePath: 'Designs/Shared',
      incomingKind: 'file',
      expectedExistingState: { kind: 'directory', treeSha256: HASH },
      replaceAllowed: true,
    };

    expect(sortPendingImportDecisions([structural, exactB, provider, exactA])).toEqual([
      provider,
      exactA,
      exactB,
      structural,
    ]);
    const providerAnswer: ImportDecision = {
      kind: 'provider_version_conflict',
      policy: 'keep_existing',
    };
    const exactAAnswer: ImportDecision = {
      kind: 'unbound_exact_match',
      sourceObjectId: 'seq_A',
      candidateEntityId: 'native-a',
      expectedCandidateScientificSha256: HASH,
      expectedBindingState: 'unbound',
      policy: 'link_existing',
    };
    expect(
      nextUnansweredImportDecision([structural, exactB, provider, exactA], [providerAnswer])
    ).toBe(exactA);
    expect(summarizeImportDecisions([providerAnswer, exactAAnswer])).toEqual({
      providerVersionConflictCount: 1,
      unboundExactMatchCount: 1,
      structuralPathConflictCount: 0,
    });
    expect(isProtectedImportReplacementPath('.dnaforge/migration/state.json')).toBe(true);
    expect(isProtectedImportReplacementPath('Designs/state.json')).toBe(false);
  });
});

function run(): MigrationRun {
  return {
    version: 1,
    id: RUN_ID,
    workspaceId: 'workspace-import-decisions',
    workspacePath: '/tmp/workspace-import-decisions',
    displayName: 'Import decisions',
    scope: {
      version: 1,
      kind: 'file',
      source: {
        id: 'seq_SOURCE01',
        url: 'https://benchling.com/example/seq_SOURCE01',
        objectType: 'dna_sequence',
      },
    },
    binding: null,
    state: 'draft',
    resumeState: null,
    attempt: 0,
    converterVersions: { artifact: '1' },
    createdAt: '2026-08-29T22:00:00.000Z',
    updatedAt: '2026-08-29T22:00:00.000Z',
    unlockedAt: null,
    startedAt: null,
    lastError: null,
  };
}
