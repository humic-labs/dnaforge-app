import { render, screen, fireEvent } from '@testing-library/react';
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
  if (!mocks.bridge) throw new Error('bridge not initialized');
  return mocks.bridge;
}
vi.mock('../lims/operations', () => ({
  queryLimsEntities: (input: unknown) => ops().queryEntities(input as never),
  applyLimsImportBatch: (input: unknown) => ops().applyImportBatch(input as never),
}));

import { buildTabularImportPlans, type TabularImportEntry } from './tabular-import';
import { TabularImportWizard } from './TabularImportWizard';

const TWO_STRAINS = [
  'Name,Genotype,Organism,Plasmid Carried',
  'A,g1,E. coli,pUC19',
  'B,g2,E. coli,pUC19',
].join('\n');

describe('TabularImportWizard  Phase 1 tier-2)', () => {
  let entries: TabularImportEntry[];

  beforeEach(async () => {
    vi.clearAllMocks();
    const bridge = createLimsTestBridge();
    mocks.bridge = bridge.lims;
    await bridge.lims.ensureSeeded();
    await bridge.lims.registerEntity({
      kind: 'plasmid',
      name: 'pUC19',
      fields: { sequence: normalizeInlineDnaSequenceRef('ACGTACGTACGTACGTACGT') },
    });
    entries = await buildTabularImportPlans([{ name: 'strains.csv', text: TWO_STRAINS }]);
  });

  it('Resolve shows the confidence headline; one clean table is "1 ready · 0 need you"', () => {
    render(<TabularImportWizard entries={entries} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('tabular-resolve-headline').textContent).toBe('1 ready · 0 need you');
    expect(screen.getByTestId('tabular-resolve-item').getAttribute('data-status')).toBe('ready');
    expect(screen.getByTestId('tabular-import-wizard').getAttribute('data-step')).toBe('resolve');
  });

  it('advancing to Review shows the reconciliation headline "2 register · 0 duplicate"', () => {
    render(<TabularImportWizard entries={entries} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tabular-to-review'));
    expect(screen.getByTestId('tabular-import-wizard').getAttribute('data-step')).toBe('review');
    expect(screen.getByTestId('tabular-review-headline').textContent).toBe(
      '2 register · 0 duplicate'
    );
    expect(screen.getByTestId('review-register').textContent).toBe('2');
    expect(screen.getByTestId('review-total').textContent).toBe('2');
  });

  it('Confirm funnels the confirmed entries to the host (nothing written here)', () => {
    const onConfirm = vi.fn();
    render(<TabularImportWizard entries={entries} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tabular-to-review'));
    fireEvent.click(screen.getByTestId('tabular-import-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toBe(entries);
  });

  it('Cancel resolves without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<TabularImportWizard entries={entries} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('tabular-import-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
