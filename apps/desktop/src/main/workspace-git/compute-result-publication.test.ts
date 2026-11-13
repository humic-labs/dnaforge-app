import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  captureComputeResultJob,
  publishComputeResultJob,
  type ComputeResultPublication,
} from './compute-result-publication';

let file: ReturnType<typeof createFileTestDb>;
let root: string;

beforeEach(() => {
  file = createFileTestDb('compute-publication');
  ensureSchema(file.db, file.dbPath);
  root = join(realpathSync(file.tmpDir), 'project');
  mkdirSync(root);
  file.db
    .prepare('INSERT INTO workspaces(name,path,created_at,repo_uuid) VALUES (?,?,?,?)')
    .run('Owned project', root, 1, randomUUID());
});

afterEach(() => file.cleanup());

function seedJob(id = 'job-1', workspaceRoot = root, importDetails: unknown = null) {
  file.db
    .prepare(
      `INSERT INTO compute_jobs
       (id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,workspace_root,
        imported_paths_json,import_details_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      'boltz',
      'boltz-2',
      'a'.repeat(64),
      '{}',
      'remote-1',
      'imported',
      workspaceRoot,
      JSON.stringify([join(workspaceRoot, 'compute', 'boltz', 'remote-1', 'model.pdb')]),
      importDetails === null ? null : JSON.stringify(importDetails),
      1,
      1
    );
}

function capture() {
  return captureComputeResultJob(file.db, {
    workspaceRoot: root,
    provider: 'boltz',
    remoteId: 'remote-1',
    sourceRelativePath: 'compute/boltz/remote-1',
  });
}

function publication(): ComputeResultPublication {
  return {
    operationId: 'operation-1',
    planSha256: 'b'.repeat(64),
    sourceTreeSha256: 'c'.repeat(64),
    targetRelativePaths: ['GFP prediction.dnaforge-molecular.json', 'Prediction files/scores.bin'],
    previews: [{ name: 'scores.json', content: '{"ptm":0.8}' }],
  };
}

const rows = () => file.db.prepare('SELECT * FROM compute_jobs ORDER BY id').all();

describe('exact compute migration database publication', () => {
  it('admits only the owning workspace when another project has the same remote job ID', () => {
    seedJob();
    seedJob('foreign-job', '/another-project');
    const foreign = file.db.prepare('SELECT * FROM compute_jobs WHERE id=?').get('foreign-job');
    const result = publishComputeResultJob(file.db, capture(), publication(), 5);
    expect(result.kind).toBe('committed');
    expect(result.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(file.db.prepare('SELECT * FROM compute_jobs WHERE id=?').get('foreign-job')).toEqual(
      foreign
    );
    const saved = file.db
      .prepare('SELECT imported_paths_json,import_details_json FROM compute_jobs WHERE id=?')
      .get('job-1') as { imported_paths_json: string; import_details_json: string };
    expect(JSON.parse(saved.imported_paths_json)).toEqual(
      publication().targetRelativePaths.map((path) => join(root, path))
    );
    expect(JSON.parse(saved.import_details_json).receipt.legacyResultMigration).toMatchObject({
      operationId: 'operation-1',
      planSha256: 'b'.repeat(64),
      sourceRelativePath: 'compute/boltz/remote-1',
    });
  });

  it.each(['missing', 'ambiguous'] as const)('refuses a %s job before publication', (kind) => {
    if (kind === 'ambiguous') {
      seedJob();
      seedJob('duplicate-job');
    }
    const before = rows();
    expect(capture).toThrow('COMPUTE_PUBLICATION_JOB_UNAVAILABLE');
    expect(rows()).toEqual(before);
  });

  it('preserves existing receipt, outputs and extra details while adding migration evidence', () => {
    const previous = {
      receipt: { original: 'retained' },
      outputs: [{ name: 'prior.txt', content: 'prior' }],
      extra: { preserved: true },
    };
    seedJob('job-1', root, previous);
    publishComputeResultJob(file.db, capture(), publication(), 5);
    const saved = file.db
      .prepare('SELECT import_details_json FROM compute_jobs WHERE id=?')
      .get('job-1') as { import_details_json: string };
    expect(JSON.parse(saved.import_details_json)).toMatchObject({
      receipt: { original: 'retained' },
      outputs: [...previous.outputs, ...publication().previews],
      extra: previous.extra,
    });
  });

  it('retains unrelated output paths and unknown output metadata during a partial relocation', () => {
    const prior = {
      name: 'prior.bin',
      content: 'preview',
      media: { encoding: 'binary', version: 7 },
    };
    seedJob('job-1', root, { receipt: {}, outputs: [prior] });
    const unrelated = join(root, 'previous-run', 'result.dat');
    file.db
      .prepare('UPDATE compute_jobs SET imported_paths_json=? WHERE id=?')
      .run(JSON.stringify([join(root, 'compute/boltz/remote-1/model.pdb'), unrelated]), 'job-1');
    publishComputeResultJob(file.db, capture(), publication(), 5);
    const saved = file.db
      .prepare('SELECT imported_paths_json,import_details_json FROM compute_jobs WHERE id=?')
      .get('job-1') as { imported_paths_json: string; import_details_json: string };
    expect(JSON.parse(saved.imported_paths_json)).toEqual([
      unrelated,
      ...publication().targetRelativePaths.map((path) => join(root, path)),
    ]);
    expect(JSON.parse(saved.import_details_json).outputs[0]).toEqual(prior);
  });

  it('recognizes an exact committed retry after the database is reopened', () => {
    seedJob();
    const witness = capture();
    const first = publishComputeResultJob(file.db, witness, publication(), 5);
    const before = rows();
    file.db.close();
    const reopened = openFileTestDb(file.dbPath);
    try {
      expect(publishComputeResultJob(reopened, witness, publication(), 100)).toEqual({
        ...first,
        kind: 'already-committed',
      });
      expect(reopened.prepare('SELECT * FROM compute_jobs ORDER BY id').all()).toEqual(before);
      expect(() =>
        publishComputeResultJob(
          reopened,
          witness,
          { ...publication(), planSha256: 'd'.repeat(64) },
          100
        )
      ).toThrow('COMPUTE_PUBLICATION_OPERATION_CONFLICT');
    } finally {
      reopened.close();
    }
  });

  it('rejects a changed job without overwriting a newer import', () => {
    seedJob();
    const witness = capture();
    file.db
      .prepare('UPDATE compute_jobs SET imported_paths_json=? WHERE id=?')
      .run('["newer-output"]', 'job-1');
    const before = rows();
    expect(() => publishComputeResultJob(file.db, witness, publication(), 5)).toThrow(
      'COMPUTE_PUBLICATION_JOB_CHANGED'
    );
    expect(rows()).toEqual(before);
  });

  it('leaves paths and details unchanged when SQLite aborts the publication', () => {
    seedJob();
    const witness = capture();
    file.db.exec(
      "CREATE TRIGGER fail_compute_publication BEFORE UPDATE ON compute_jobs BEGIN SELECT RAISE(ABORT,'injected-publication-failure'); END"
    );
    const before = rows();
    expect(() => publishComputeResultJob(file.db, witness, publication(), 5)).toThrow(
      'injected-publication-failure'
    );
    expect(rows()).toEqual(before);
  });
});
