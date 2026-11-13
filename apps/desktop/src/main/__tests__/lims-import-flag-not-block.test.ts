import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createLimsTestBridge } from './lims-bridge-for-db';
import { materializeLimsGlobalRegistryExportInDb } from '../lims-git-export';
import type { PlatformBridge } from '../../platform/index';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {},
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const mocks = vi.hoisted(() => ({ bridge: null as PlatformBridge['lims'] | null }));
function ops(): PlatformBridge['lims'] {
  if (!mocks.bridge) throw new Error('bridge not initialized');
  return mocks.bridge;
}
vi.mock('../../features/lims/operations', () => ({
  queryLimsEntities: (input: unknown) => ops().queryEntities(input as never),
  applyLimsImportBatch: (input: unknown) => ops().applyImportBatch(input as never),
}));

import { createLimsImportPlan, applyAcceptedLimsImportPlan } from '../../features/lims/ingress';

describe(' import: flag, never block', () => {
  let bridge: PlatformBridge['lims'];
  let db: Database.Database;

  beforeEach(() => {
    const created = createLimsTestBridge();
    db = created.db;
    bridge = created.lims;
    mocks.bridge = bridge;
  });

  it('M1/M2: a required-sequence type with NO sequence imports as unresolved, not blocked', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'plasmids.csv',
      text: ['Name,Type', 'pBlank,high-copy'].join('\n'),
      defaultKind: 'plasmid',
    });
    expect(plan.canApply).toBe(true);

    const result = await applyAcceptedLimsImportPlan(plan, { actor: 'test' });
    expect(result.insertedEntities).toBe(1);

    const entities = await bridge.queryEntities({ kind: 'plasmid' });
    expect(entities.map((e) => e.name)).toContain('pBlank');
    expect(entities.find((e) => e.name === 'pBlank')?.registrationStatus).toBe('unresolved');
  });

  it('M3: a genuinely malformed value still errors (missing ≠ malformed)', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'plasmids.csv',
      text: ['Name,Sequence', 'pBad,ZZZ123-not-dna'].join('\n'),
      defaultKind: 'plasmid',
    });
    const record = plan.records.find((r) => r.entityDraft.name === 'pBad');
    expect(record?.errors?.length ?? 0).toBeGreaterThan(0);
  });

  it('M5: a non-strain type imports and unmatched columns survive as source metadata', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Name,Sequence,Freezer Box', 'OL1,ACGTACGTACGT,Box-7'].join('\n'),
      defaultKind: 'oligo',
    });
    const result = await applyAcceptedLimsImportPlan(plan, { actor: 'test' });
    expect(result.insertedEntities).toBe(1);

    const [oligo] = await bridge.queryEntities({ kind: 'oligo' });
    expect(oligo.name).toBe('OL1');
    expect(JSON.stringify(oligo.fields)).toContain('Box-7');
  });

  it('M4: an import materializes durable, workspace-less registry files (jsonl log + csv)', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'oligos.csv',
      text: ['Name,Sequence', 'OLdur,ACGTACGTACGT'].join('\n'),
      defaultKind: 'oligo',
    });
    await applyAcceptedLimsImportPlan(plan, { actor: 'test' });

    const root = mkdtempSync(join(tmpdir(), 'lims-registry-export-'));
    const result = materializeLimsGlobalRegistryExportInDb(db, root);

    expect(result.logFiles.length).toBeGreaterThan(0);
    expect(existsSync(result.oligosCsvPath)).toBe(true);
    expect(readFileSync(result.oligosCsvPath, 'utf8')).toContain('OLdur');

    const logDir = join(root, '.waypoint', 'lims', 'log');
    const logText = readdirSync(logDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(logDir, f), 'utf8'))
      .join('');
    expect(logText).toContain('OLdur');
  });
});
