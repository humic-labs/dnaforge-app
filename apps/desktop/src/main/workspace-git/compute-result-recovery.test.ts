import * as fs from 'node:fs';
import * as git from 'isomorphic-git';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { recoverComputeResult } from './compute-result-recovery';
import { inventoryComputeSource } from './compute-result-retention';

let file: ReturnType<typeof createFileTestDb>;
let root: string;
let source: string;
const input = () => ({ workspaceRoot: root, provider: 'boltz', remoteId: 'remote-1' });

beforeEach(async () => {
  file = createFileTestDb('compute-recovery');
  ensureSchema(file.db, file.dbPath);
  root = join(realpathSync(file.tmpDir), 'project');
  source = join(root, 'compute/boltz/remote-1');
  mkdirSync(join(source, 'nested'), { recursive: true });
  mkdirSync(join(source, 'empty'));
  writeFileSync(join(source, 'nested/data.bin'), Buffer.from([255, 0, 128]));
  writeFileSync(join(source, '.receipt'), 'original receipt');
  await git.init({ fs, dir: root });
  await git.add({ fs, dir: root, filepath: '.' });
  await git.commit({
    fs,
    dir: root,
    message: 'original',
    author: { name: 'Test', email: 'test@example.invalid' },
  });
  file.db
    .prepare('INSERT INTO workspaces(name,path,created_at,repo_uuid) VALUES (?,?,?,?)')
    .run('Project', root, 1, randomUUID());
  file.db
    .prepare(
      `INSERT INTO compute_jobs (id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,workspace_root,imported_paths_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      'job',
      'boltz',
      'boltz-2',
      'a'.repeat(64),
      '{}',
      'remote-1',
      'imported',
      root,
      JSON.stringify([join(source, 'nested/data.bin')]),
      1,
      1
    );
});
afterEach(() => file.cleanup());

it('reopens SQLite and resumes the same published files after interruption without retiring any source', async () => {
  const before = await inventoryComputeSource(source);
  let stopped = false;
  await expect(
    recoverComputeResult(file.db, input(), {
      checkpoint: async (phase) => {
        if (phase === 'file-published' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
      },
    })
  ).rejects.toThrow('interrupted');
  expect((await inventoryComputeSource(source)).treeSha256).toBe(before.treeSha256);
  const db = openFileTestDb(file.dbPath);
  try {
    const result = await recoverComputeResult(db, input());
    expect(result.kind).toBe('committed');
    expect(readFileSync(join(root, result.targetRelativePath, 'nested/data.bin'))).toEqual(
      Buffer.from([255, 0, 128])
    );
    expect((await inventoryComputeSource(join(root, result.retainedRelativePath))).treeSha256).toBe(
      before.treeSha256
    );
    const committed = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
    expect(
      (
        await git.readBlob({
          fs,
          dir: root,
          oid: committed,
          filepath: `${result.retainedRelativePath}/nested/data.bin`,
        })
      ).blob
    ).toEqual(Uint8Array.from([255, 0, 128]));
    const retry = await recoverComputeResult(db, input());
    expect(await git.resolveRef({ fs, dir: root, ref: 'HEAD' })).toBe(committed);
    expect(retry).toEqual({ ...result, kind: 'already-committed' });
    expect((await inventoryComputeSource(source)).treeSha256).toBe(before.treeSha256);
  } finally {
    db.close();
  }
});

it('retains the complete source and refuses changed metadata after files are prepared', async () => {
  const before = await inventoryComputeSource(source);
  await expect(
    recoverComputeResult(file.db, input(), {
      checkpoint: async (phase) => {
        if (phase === 'prepared')
          file.db
            .prepare("UPDATE compute_jobs SET import_details_json=? WHERE id='job'")
            .run(JSON.stringify({ receipt: { newer: true }, outputs: [] }));
      },
    })
  ).rejects.toThrow('COMPUTE_PUBLICATION_JOB_CHANGED');
  expect((await inventoryComputeSource(source)).treeSha256).toBe(before.treeSha256);
  expect(
    file.db.prepare("SELECT import_details_json FROM compute_jobs WHERE id='job'").get()
  ).toEqual({ import_details_json: JSON.stringify({ receipt: { newer: true }, outputs: [] }) });
});

it('never overwrites an independently replaced publication file on retry', async () => {
  let target = '';
  await expect(
    recoverComputeResult(file.db, input(), {
      checkpoint: async (phase, path) => {
        if (phase === 'file-published') {
          target = path!;
          throw new Error('interrupted');
        }
      },
    })
  ).rejects.toThrow('interrupted');
  const { unlinkSync } = await import('node:fs');
  unlinkSync(target);
  writeFileSync(target, 'external writer');
  await expect(recoverComputeResult(file.db, input())).rejects.toThrow(
    'COMPUTE_RECOVERY_DESTINATION_CHANGED'
  );
  expect(readFileSync(target, 'utf8')).toBe('external writer');
  expect(readFileSync(join(source, '.receipt'), 'utf8')).toBe('original receipt');
});

it('converts real coordinates and a sequence while preserving all original bytes and IDs across retries', async () => {
  writeFileSync(
    join(source, 'model.pdb'),
    'HEADER    LEGACY COMPUTE RESULT\nATOM      1  CA  MET A   1       0.000   0.000   0.000  1.00 90.00           C\nEND\n'
  );
  writeFileSync(
    join(source, 'result.gb'),
    'LOCUS       retained                  12 bp    DNA     linear   SYN 01-JAN-2026\nDEFINITION  Retained legacy compute sequence.\nACCESSION   retained\nFEATURES             Location/Qualifiers\nORIGIN\n        1 atgacgatcgat\n//\n'
  );
  const before = await inventoryComputeSource(source);
  const result = await recoverComputeResult(file.db, input());
  const output = await inventoryComputeSource(join(root, result.targetRelativePath));
  expect(
    output.entries.some((item) => item.relativePath.endsWith('.dnaforge-molecular.json'))
  ).toBe(true);
  expect(output.entries.some((item) => item.relativePath.endsWith('.forge/plasmid.json'))).toBe(
    true
  );
  expect((await inventoryComputeSource(source)).treeSha256).toBe(before.treeSha256);
  await recoverComputeResult(file.db, input());
  expect((await inventoryComputeSource(join(root, result.targetRelativePath))).treeSha256).toBe(
    output.treeSha256
  );
});

it('finishes the Git publication after interruption at the durable completion record', async () => {
  const before = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
  await expect(
    recoverComputeResult(file.db, input(), {
      checkpoint: async (phase) => {
        if (phase === 'completion-recorded') throw new Error('interrupted before Git');
      },
    })
  ).rejects.toThrow('interrupted before Git');
  expect(await git.resolveRef({ fs, dir: root, ref: 'HEAD' })).toBe(before);
  const result = await recoverComputeResult(file.db, input());
  const committed = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
  expect(committed).not.toBe(before);
  expect(
    (
      await git.readBlob({
        fs,
        dir: root,
        oid: committed,
        filepath: `${result.retainedRelativePath}/nested/data.bin`,
      })
    ).blob
  ).toEqual(Uint8Array.from([255, 0, 128]));
  writeFileSync(join(root, result.targetRelativePath, 'nested/data.bin'), 'later user edit');
  await recoverComputeResult(file.db, input());
  expect(await git.resolveRef({ fs, dir: root, ref: 'HEAD' })).toBe(committed);
  expect(readFileSync(join(root, result.targetRelativePath, 'nested/data.bin'), 'utf8')).toBe(
    'later user edit'
  );
});
