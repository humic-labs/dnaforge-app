import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLimsImportPlan } from '../ingress';
import { computeImportPlanView } from './import-plan-view';
import { LimsImportColumnsPane } from './LimsImportColumnsPane';

vi.mock('../../db', () => ({ ensureSequenceIdentity: vi.fn(async () => 1) }));
vi.mock('../operations', () => ({
  queryLimsEntities: vi.fn(async () => []),
  applyLimsImportBatch: vi.fn(async () => ({
    batchId: 'b1',
    insertedEntities: 0,
    insertedLinks: 0,
    skipped: 0,
    insertedEntityIds: [],
    insertedLinkIds: [],
    skippedRecordIds: [],
    unresolvedLinks: [],
    errors: [],
  })),
}));

const PUC19 = join(__dirname, '../../../../../../test-fixtures/sequences/circular/pUC19.gb');
async function renderPaneForFile(fileName: string, path: string) {
  const plan = await createLimsImportPlan({ fileName, text: readFileSync(path, 'utf8') });
  const view = computeImportPlanView(plan, []);
  render(
    <LimsImportColumnsPane
      plan={plan}
      view={view}
      onColumnMappingsChange={vi.fn()}
      onRecordAcceptedChange={vi.fn()}
    />
  );
  return { plan };
}

describe('LimsImportColumnsPane — DNA sequence type', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the base DNA sequence type without a subtype picker', async () => {
    await renderPaneForFile('pUC19.gb', PUC19);
    const type = screen.getByTestId('lims-import-record-sequence-file-1-kind');
    expect(type).toHaveTextContent('DNA sequence');
    expect(type.tagName).toBe('SPAN');
    expect(screen.queryByRole('combobox', { name: /type for/i })).toBeNull();
  });

  it('a WRONG-DOOR incompatible record renders the Type READ-ONLY — no interactive picker (R3)', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'pUC19.gb',
      text: readFileSync(PUC19, 'utf8'),
      defaultKind: 'oligo',
    });
    render(
      <LimsImportColumnsPane
        plan={plan}
        view={computeImportPlanView(plan, [])}
        onColumnMappingsChange={vi.fn()}
        onRecordAcceptedChange={vi.fn()}
      />
    );
    expect(screen.queryByTestId('lims-import-record-sequence-file-1-kind')).toBeNull();
    const reason = screen.getByTestId('lims-import-record-sequence-file-1-reason');
    expect(reason).toHaveTextContent(/must be imported as DNA sequences/i);
    expect(reason.className).toContain('text-error');
  });
});

describe('LimsImportColumnsPane — protein FASTA type', () => {
  beforeEach(() => vi.clearAllMocks());

  it('labels amino-acid FASTA records as proteins rather than DNA sequences', async () => {
    const plan = await createLimsImportPlan({
      fileName: 'proteins.faa',
      text: '>alpha first protein\nMSTNPKPQR\n>beta second protein\nGGHPEVYIL\n',
      forcedKind: 'protein',
    });
    render(
      <LimsImportColumnsPane
        plan={plan}
        view={computeImportPlanView(plan, [])}
        onColumnMappingsChange={vi.fn()}
        onRecordAcceptedChange={vi.fn()}
      />
    );

    expect(screen.getAllByText('protein')).toHaveLength(2);
    expect(screen.queryByText('DNA sequence')).toBeNull();
  });
});

describe('LimsImportColumnsPane — row multi-select (shift range + ⌘/Ctrl toggle, OS-agnostic)', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderRows() {
    const csv = ['Name,Sequence', 'P1,ACGT', 'P2,ACGT', 'P3,ACGT', 'P4,ACGT', 'P5,ACGT'].join('\n');
    const plan = await createLimsImportPlan({
      fileName: 'primers.csv',
      text: csv,
      forcedKind: 'oligo',
    });
    const ids = plan.records.map((r) => r.id);
    expect(ids).toHaveLength(5);
    const onRecordAcceptedChange = vi.fn();
    const onRecordsAcceptedChange = vi.fn();
    render(
      <LimsImportColumnsPane
        plan={plan}
        view={computeImportPlanView(plan, [])}
        onColumnMappingsChange={vi.fn()}
        onRecordAcceptedChange={onRecordAcceptedChange}
        onRecordsAcceptedChange={onRecordsAcceptedChange}
      />
    );
    const row = (id: string) => screen.getByTestId(`lims-import-record-${id}`);
    const isSelected = (id: string) => row(id).getAttribute('data-selected') === 'true';
    return { ids, row, isSelected, onRecordAcceptedChange, onRecordsAcceptedChange };
  }

  it('plain click selects a single row', async () => {
    const { ids, row, isSelected } = await renderRows();
    fireEvent.click(row(ids[1]));
    expect(isSelected(ids[1])).toBe(true);
    expect([ids[0], ids[2], ids[3], ids[4]].some(isSelected)).toBe(false);
  });

  it('Shift+click extends a contiguous range from the anchor (either direction)', async () => {
    const { ids, row, isSelected } = await renderRows();
    fireEvent.click(row(ids[1]));
    fireEvent.click(row(ids[3]), { shiftKey: true });
    expect([ids[1], ids[2], ids[3]].every(isSelected)).toBe(true);
    expect(isSelected(ids[0])).toBe(false);
    expect(isSelected(ids[4])).toBe(false);
    fireEvent.click(row(ids[0]), { shiftKey: true });
    expect([ids[0], ids[1]].every(isSelected)).toBe(true);
    expect(isSelected(ids[3])).toBe(false);
  });

  it('⌘/Ctrl+click toggles a row in/out of the selection (discontiguous)', async () => {
    const { ids, row, isSelected } = await renderRows();
    fireEvent.click(row(ids[0]));
    fireEvent.click(row(ids[2]), { metaKey: true, ctrlKey: true });
    fireEvent.click(row(ids[4]), { metaKey: true, ctrlKey: true });
    expect([ids[0], ids[2], ids[4]].every(isSelected)).toBe(true);
    expect([ids[1], ids[3]].some(isSelected)).toBe(false);
    fireEvent.click(row(ids[2]), { metaKey: true, ctrlKey: true });
    expect(isSelected(ids[2])).toBe(false);
  });

  it('toggling a checkbox in a multi-selection applies to EVERY selected row (bulk)', async () => {
    const { ids, row, onRecordAcceptedChange, onRecordsAcceptedChange } = await renderRows();
    fireEvent.click(row(ids[1]));
    fireEvent.click(row(ids[3]), { shiftKey: true });
    const box = screen.getByTestId(`lims-import-record-${ids[2]}-accepted`) as HTMLInputElement;
    const wasChecked = box.checked;
    fireEvent.click(box);
    expect(onRecordsAcceptedChange).toHaveBeenCalledTimes(1);
    const [calledIds, accepted] = onRecordsAcceptedChange.mock.calls[0];
    expect(new Set(calledIds)).toEqual(new Set([ids[1], ids[2], ids[3]]));
    expect(accepted).toBe(!wasChecked);
    expect(onRecordAcceptedChange).not.toHaveBeenCalled();
  });

  it('toggling a checkbox OUTSIDE the selection acts on that row alone', async () => {
    const { ids, row, onRecordAcceptedChange, onRecordsAcceptedChange } = await renderRows();
    fireEvent.click(row(ids[0]));
    fireEvent.click(row(ids[1]), { shiftKey: true });
    const box = screen.getByTestId(`lims-import-record-${ids[4]}-accepted`) as HTMLInputElement;
    const wasChecked = box.checked;
    fireEvent.click(box);
    expect(onRecordAcceptedChange).toHaveBeenCalledWith(ids[4], !wasChecked);
    expect(onRecordsAcceptedChange).not.toHaveBeenCalled();
  });

  it('clicking the checkbox does NOT change the row selection (apply, not select)', async () => {
    const { ids, row, isSelected } = await renderRows();
    fireEvent.click(row(ids[0]));
    fireEvent.click(screen.getByTestId(`lims-import-record-${ids[3]}-accepted`));
    expect(isSelected(ids[0])).toBe(true);
    expect(isSelected(ids[3])).toBe(false);
  });
});
