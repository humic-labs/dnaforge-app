import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ImportWizardModal } from './ImportWizardModal';
import type { ImportWizardState, ImportItem } from '../workspace-loader/import-wizard-state';
import type { ImportItemTarget } from './import-item-target';

const fsMock = vi.hoisted(() => ({
  readDir: vi.fn(async (_path: string) => [] as { name: string; isDirectory: boolean }[]),
  exists: vi.fn(async () => false),
  mkdir: vi.fn(),
  rename: vi.fn(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ fs: fsMock }) }));
beforeEach(() => {
  fsMock.readDir.mockImplementation(async (path: string) =>
    path === '/ws/ecoli'
      ? [{ name: 'assays', isDirectory: true }]
      : path === '/ws/ecoli/assays'
        ? [{ name: 'run-1', isDirectory: true }]
        : []
  );
});

const ECOLI: ImportItemTarget = { kind: 'existing-root', rootPath: '/ws/ecoli' };

function item(name: string, extra: Partial<ImportItem> = {}): ImportItem {
  return { path: `/d/${name}`, name, kind: 'file', ...extra };
}
function state(over: Partial<ImportWizardState> = {}): ImportWizardState {
  return {
    items: [item('pUC19.gb', { format: 'genbank', target: ECOLI })],
    destination: { kind: 'existing-root', rootPath: '/ws/ecoli' },
    availableRoots: [{ path: '/ws/ecoli', name: 'ecoli' }],
    requiresExplicitChoice: false,
    destinationChosen: true,
    agentRequested: false,
    ...over,
  };
}

function renderModal(over: Partial<ImportWizardState> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ImportWizardModal initial={state(over)} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe('ImportWizardModal (file review, L1)', () => {
  it('browses two nested folders with the shared filesystem picker before assigning the destination', async () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Destination for all files' }));
    expect(screen.getByTestId('import-folder-picker-folder-/ws/ecoli')).toBeVisible();
    fireEvent.click(await screen.findByText('assays'));
    expect(screen.getByTestId('import-location-picker')).toBeVisible();
    fireEvent.click(await screen.findByText('run-1'));
    expect(screen.getByTestId('import-row-destination')).toHaveTextContent('ecoli');
    fireEvent.click(screen.getByRole('button', { name: 'Use folder' }));
    expect(screen.getByTestId('import-row-destination')).toHaveTextContent('ecoli/assays/run-1');
    fireEvent.click(screen.getByTestId('import-confirm'));
    expect(onConfirm.mock.calls[0][0].items[0].target).toEqual({
      kind: 'existing-root',
      rootPath: '/ws/ecoli/assays/run-1',
    });
    expect(fsMock.mkdir).not.toHaveBeenCalled();
    expect(fsMock.rename).not.toHaveBeenCalled();
  });

  it('sets the destination for all files without changing selection or blocked validation', () => {
    const { onConfirm } = renderModal({
      importIntent: { entityType: 'dna-sequences' },
      availableRoots: [
        { path: '/ws/ecoli', name: 'ecoli' },
        { path: '/ws/yeast', name: 'yeast' },
      ],
      items: [
        item('first.gb', { target: ECOLI }),
        item('second.gb', { target: ECOLI }),
        item('blocked.fa', {
          target: ECOLI,
          block: { kind: 'sequence-preview-failed', message: 'Missing type.' },
        }),
      ],
    });
    expect(screen.getByRole('columnheader', { name: 'Destination' })).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import first.gb' }));
    expect(screen.getByRole('button', { name: 'Destination for all files' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Import options' })).toBeNull();
    fireEvent.click(screen.getByTestId('import-destination-button'));
    fireEvent.click(screen.getByTestId('import-folder-picker-folder-/ws/yeast'));
    fireEvent.click(screen.getByRole('button', { name: 'Use folder' }));
    expect(screen.getByRole('checkbox', { name: 'Import first.gb' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Import blocked.fa' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import first.gb' }));
    fireEvent.click(screen.getByTestId('import-confirm'));
    expect(onConfirm.mock.calls[0][0].items.map((entry: ImportItem) => entry.target)).toEqual([
      { kind: 'existing-root', rootPath: '/ws/yeast' },
      { kind: 'existing-root', rootPath: '/ws/yeast' },
      { kind: 'existing-root', rootPath: '/ws/yeast' },
    ]);
  });

  it('can choose the shared destination even after clearing every selected file', () => {
    renderModal();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all files' }));
    expect(screen.getByRole('button', { name: 'Destination for all files' })).toBeEnabled();
    expect(screen.getByTestId('import-confirm')).toBeDisabled();
  });

  it('Escape closes a row picker, restores focus, and leaves import open; the next Escape cancels', () => {
    const onCancel = vi.fn();
    render(<ImportWizardModal initial={state()} onCancel={onCancel} onConfirm={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'Destination for pUC19.gb' });
    fireEvent.click(trigger);
    expect(screen.getByTestId('import-location-picker')).toBeVisible();
    const folder = screen.getByTestId('import-folder-picker-folder-/ws/ecoli');
    fireEvent.click(folder);
    folder.focus();
    fireEvent.keyDown(folder, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByTestId('import-location-picker')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: 'Escape', code: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('re-previews DNA confirmation and forwards its byte-bound decision to the writer', async () => {
    const source = '/d/unknown.fa';
    const hash = 'a'.repeat(64);
    const previewSequenceImport = vi.fn().mockResolvedValue({
      kind: 'ready',
      sourcePath: source,
      sourceSha256: hash,
      packages: [{ name: 'unknown', recordIndex: 0, recordCount: 1 }],
    });
    const onConfirm = vi.fn();
    render(
      <ImportWizardModal
        initial={state({
          importIntent: { entityType: 'dna-sequences' },
          items: [
            item('unknown.fa', {
              path: source,
              sourcePath: source,
              expectedSourceSha256: hash,
              target: ECOLI,
              block: {
                kind: 'sequence-preview-failed',
                reasonCode: 'unconfirmed_molecule_identity',
                canConfirmDnaIdentity: true,
                message: 'Missing DNA label.',
              },
            }),
          ],
        })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        previewSequenceImport={previewSequenceImport}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm DNA' }));
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeEnabled());
    expect(previewSequenceImport).toHaveBeenCalledWith({
      sourcePath: source,
      confirmedDnaSourceSha256: hash,
      confirmedNucleicAcid: 'dna',
    });
    expect(screen.getByTestId('import-confirm')).toHaveTextContent('Import 1 sequence');
    fireEvent.click(screen.getByTestId('import-confirm'));
    expect(onConfirm.mock.calls[0][0].items[0]).toMatchObject({
      sourcePath: source,
      expectedSourceSha256: hash,
      confirmedDnaSourceSha256: hash,
      target: ECOLI,
    });
    expect(onConfirm.mock.calls[0][0].items[0].block).toBeUndefined();
  });

  it('keeps a failed DNA re-preview blocked and exposes the new reason', async () => {
    render(
      <ImportWizardModal
        initial={state({
          importIntent: { entityType: 'dna-sequences' },
          items: [
            item('unknown.fa', {
              expectedSourceSha256: 'a'.repeat(64),
              target: ECOLI,
              block: {
                kind: 'sequence-preview-failed',
                reasonCode: 'unconfirmed_molecule_identity',
                canConfirmDnaIdentity: true,
                message: 'Missing DNA label.',
              },
            }),
          ],
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        previewSequenceImport={vi.fn().mockResolvedValue({
          kind: 'blocked',
          sourcePath: '/d/unknown.fa',
          reasonCode: 'non_dna_content',
          reason: 'This file identifies RNA.',
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm DNA' }));
    await waitFor(() => expect(screen.getByText('Not a DNA sequence')).toBeVisible());
    expect(screen.getByTestId('import-confirm')).toBeDisabled();
  });

  it('uses checkboxes to exclude files from the actual import and supports clear/select all', () => {
    const { onConfirm } = renderModal({
      items: [
        item('first.gb', { target: ECOLI }),
        item('second.gb', { target: ECOLI }),
        item('blocked.fa', {
          block: { kind: 'sequence-preview-failed', message: 'Confirm DNA identity.' },
        }),
      ],
    });
    expect(screen.getByRole('checkbox', { name: 'Import blocked.fa' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all files' }));
    expect(screen.getByTestId('import-confirm')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import first.gb' }));
    expect(screen.getByTestId('import-confirm')).toHaveTextContent('Import 1 item');
    fireEvent.click(screen.getByTestId('import-confirm'));
    const confirmed = onConfirm.mock.calls[0][0];
    expect(confirmed.items.map((entry: ImportItem) => entry.name)).toEqual([
      'first.gb',
      'blocked.fa',
    ]);
  });

  it('keeps the error short and exposes the full validation message on demand', () => {
    renderModal({
      items: [
        item('blocked.fa', {
          block: {
            kind: 'sequence-preview-failed',
            reasonCode: 'unconfirmed_molecule_identity',
            message: 'Detailed explanation of ambiguous molecule identity.',
          },
        }),
      ],
    });
    expect(screen.getByText('Molecule type unspecified')).toBeVisible();
    expect(screen.queryByText(/Detailed explanation/)).toBeNull();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByRole('alert')).toHaveTextContent('The molecule identity is ambiguous.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Detailed explanation');
  });

  it('counts only files that will be imported and keeps duplicate skips separate from validation', () => {
    renderModal({
      items: [
        item('new.gb', { target: ECOLI }),
        item('existing.gb', {
          dedup: { action: 'skip-duplicate', existingRelPath: 'existing.gb', matchedByName: true },
        }),
        item('blocked.fa', {
          target: ECOLI,
          block: { kind: 'sequence-preview-failed', message: 'Confirm this file contains DNA.' },
        }),
      ],
    });
    expect(screen.getByTestId('import-confirm')).toBeEnabled();
    expect(screen.getByTestId('import-confirm')).toHaveTextContent('Import 1 item');
    expect(screen.getByTestId('import-readiness-summary')).toHaveTextContent('1 selected');
    expect(screen.getByTestId('import-readiness-summary')).toHaveTextContent('1 cannot import');
    expect(screen.getByTestId('import-readiness-summary')).toHaveTextContent('1 already imported');
  });

  it('explains that an all-duplicate selection needs an override instead of offering an empty import', () => {
    renderModal({
      items: [
        item('existing.gb', {
          target: ECOLI,
          dedup: { action: 'skip-duplicate', existingRelPath: 'existing.gb', matchedByName: true },
        }),
      ],
    });
    expect(screen.getByTestId('import-confirm')).toBeDisabled();
    expect(screen.getByTestId('import-confirm-reason')).toHaveTextContent('already imported');
    fireEvent.click(screen.getByRole('button', { name: 'Import anyway' }));
    expect(screen.getByTestId('import-confirm')).toBeEnabled();
  });

  it('explains the editable result without Registry jargon in the import screen', () => {
    renderModal({ importIntent: { entityType: 'dna-sequences' } });

    expect(screen.getByRole('heading', { name: 'Import DNA sequences' })).toBeTruthy();
    expect(screen.getByTestId('import-confirm')).toHaveTextContent('Import 1 sequence');
    expect(screen.queryByRole('button', { name: 'Import options' })).toBeNull();
    expect(screen.queryByText(/Registry/)).toBeNull();
    expect(screen.queryByTestId('import-agent-toggle')).toBeNull();
    expect(screen.queryByRole('treeitem', { name: /register as entities/i })).toBeNull();
  });

  it('presents a file selection column and a compact destination control', () => {
    renderModal({
      items: [item('pUC19.gb', { format: 'genbank', target: ECOLI })],
    });
    expect(screen.getByTestId('import-review-list')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select all files' })).toBeChecked();
    expect(screen.getByTestId('import-destination-button')).toBeTruthy();
    expect(screen.queryByTestId('import-location-picker')).toBeNull();
  });

  it('requires an explicit destination when none was chosen', () => {
    renderModal({
      items: [item('pUC19.gb', { format: 'genbank' })],
      requiresExplicitChoice: true,
      destinationChosen: false,
    });
    const confirm = screen.getByTestId('import-confirm');
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('import-confirm-reason').textContent).toMatch(
      /Choose a destination/i
    );
    fireEvent.click(screen.getByTestId('import-destination-button'));
    fireEvent.click(screen.getByTestId('import-folder-picker-folder-/ws/ecoli'));
    fireEvent.click(screen.getByRole('button', { name: 'Use folder' }));
    expect(confirm).toBeEnabled();
  });

  it('enables Import with the count label once placed, and calls onConfirm with the outcome', () => {
    const { onConfirm } = renderModal({
      items: [item('pUC19.gb', { format: 'genbank', target: ECOLI })],
    });
    const confirm = screen.getByTestId('import-confirm');
    expect(confirm).not.toBeDisabled();
    expect(confirm.textContent).toBe('Import 1 item');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: { kind: 'existing-root', rootPath: '/ws/ecoli' },
        agentRequested: false,
      })
    );
  });

  it('a blocked (multi-FASTA) item is exempt from the placement gate', () => {
    renderModal({
      items: [
        item('pUC19.gb', { format: 'genbank', target: ECOLI }),
        item('multi.fasta', {
          format: 'fasta',
          block: { kind: 'multi-record-fasta', recordCount: 3, message: '3 sequences' },
        }),
      ],
    });
    expect(screen.getByTestId('import-confirm')).not.toBeDisabled();
  });

  it('Cancel and Esc both resolve without confirming', () => {
    const { onCancel, onConfirm } = renderModal();
    fireEvent.click(screen.getByTestId('import-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('relabels Import when an agent is requested via the toggle', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('import-agent-toggle'));
    expect(screen.getByTestId('import-confirm').textContent?.toLowerCase()).toContain('agent');
  });
});
