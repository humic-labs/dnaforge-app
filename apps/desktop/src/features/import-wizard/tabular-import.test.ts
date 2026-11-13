import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { normalizeInlineDnaSequenceRef } from '../../shared/lims';
import type { PlatformBridge } from '../../platform/index';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {},
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const mocks = vi.hoisted(() => ({ bridge: null as PlatformBridge['lims'] | null }));
function ops(): PlatformBridge['lims'] {
  if (!mocks.bridge) throw new Error('mocks.bridge not initialized');
  return mocks.bridge;
}

vi.mock('../lims/operations', () => ({
  queryLimsEntities: (input: unknown) => ops().queryEntities(input as never),
  applyLimsImportBatch: (input: unknown) => ops().applyImportBatch(input as never),
}));

import {
  buildTabularImportPlans,
  summarizeResolveWorklist,
  summarizeReviewReconciliation,
  formatResolveHeadline,
  formatReviewHeadline,
} from './tabular-import';
import { build187SheetWorkbook } from '../lims/__fixtures__/messy-workbook';

const STRAINS_CSV = readFileSync(
  join(__dirname, '..', 'lims', '__fixtures__', 'strains-34.csv'),
  'utf8'
);
const CARRIED_PLASMIDS = ['pUC19', 'pET28a', 'pACYC184', 'pRS416'];

describe(' Phase 1 tier-2 — Resolve/Review summaries (real engine plans)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const bridge = createLimsTestBridge();
    mocks.bridge = bridge.lims;
    await bridge.lims.ensureSeeded();
    for (const name of CARRIED_PLASMIDS) {
      await bridge.lims.registerEntity({
        kind: 'plasmid',
        name,
        fields: { sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT') },
      });
    }
  });

  it('a clean 34-row strains.csv resolves as "1 ready · 0 need you"', async () => {
    const entries = await buildTabularImportPlans([{ name: 'strains.csv', text: STRAINS_CSV }]);
    const worklist = summarizeResolveWorklist(entries);

    expect(worklist).toMatchObject({ total: 1, ready: 1, needYou: 0 });
    expect(worklist.items[0]).toMatchObject({
      fileName: 'strains.csv',
      status: 'ready',
      detectedKind: 'strain_table',
      recordCount: 34,
      reasons: [],
    });
    expect(formatResolveHeadline(worklist)).toBe('1 ready · 0 need you');
  });

  it('review reconciliation is "34 register · 0 duplicate" with ZERO silent loss', async () => {
    const entries = await buildTabularImportPlans([{ name: 'strains.csv', text: STRAINS_CSV }]);
    const review = summarizeReviewReconciliation(entries);

    expect(review).toMatchObject({
      totalRows: 34,
      register: 34,
      duplicate: 0,
      flagged: 0,
      cannotParse: 0,
    });
    expect(review.register + review.duplicate + review.flagged + review.cannotParse).toBe(
      review.totalRows
    );
    expect(formatReviewHeadline(review)).toBe('34 register · 0 duplicate');
  });

  it('an xlsx workbook flows through as bytes and triages to its entity sheet', async () => {
    const entries = await buildTabularImportPlans([
      { name: 'messy-187.xlsx', arrayBuffer: build187SheetWorkbook() },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].plan?.selectedSheet).toBe('Strains');
    expect(entries[0].plan?.sheetDispositions?.length).toBe(187);
    const worklist = summarizeResolveWorklist(entries);
    expect(worklist.items[0].recordCount).toBeGreaterThan(0);
  });

  it('an unparseable file fails toward a visible cannot-parse disposition (never dropped)', async () => {
    const entries = await buildTabularImportPlans([
      { name: 'strains.csv', text: STRAINS_CSV },
      { name: 'empty.csv', text: '' },
    ]);
    const worklist = summarizeResolveWorklist(entries);
    const review = summarizeReviewReconciliation(entries);

    expect(worklist.total).toBe(2);
    expect(worklist.items.some((i) => i.fileName === 'empty.csv')).toBe(true);
    expect(review.register + review.duplicate + review.flagged + review.cannotParse).toBe(
      review.totalRows
    );
    expect(review.register).toBe(34);
  });
});
