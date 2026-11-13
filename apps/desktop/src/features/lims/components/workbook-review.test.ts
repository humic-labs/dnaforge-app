import { describe, expect, it } from 'vitest';
import type { LimsSchemaDefinitionView } from '../../../shared/lims';
import {
  activeReviewTab,
  buildReviewSummaryRows,
  fieldOptionsForSchema,
  selectedReviewTabs,
  type WorkbookReviewState,
  type WorkbookReviewTab,
} from './workbook-review';

function tab(partial: Partial<WorkbookReviewTab> & { sheetName: string }): WorkbookReviewTab {
  return {
    verdict: 'entity-table',
    rowCount: 3,
    selected: true,
    plan: null,
    ...partial,
  };
}

function state(
  tabs: WorkbookReviewTab[],
  activeSheet = tabs[0]?.sheetName ?? ''
): WorkbookReviewState {
  return {
    fileName: 'book.xlsx',
    arrayBuffer: new ArrayBuffer(0),
    kind: 'oligo',
    schemas: [],
    tabs,
    activeSheet,
    gridPreviews: {},
    phase: 'review',
  };
}

describe('workbook-review helpers  one-type multi-sheet)', () => {
  it('activeReviewTab resolves the tab named by activeSheet', () => {
    const s = state([tab({ sheetName: 'Primers' }), tab({ sheetName: 'Strains' })], 'Strains');
    expect(activeReviewTab(s)?.sheetName).toBe('Strains');
    expect(activeReviewTab({ ...s, activeSheet: 'Nope' })).toBeUndefined();
  });

  it('selectedReviewTabs returns only checked tabs', () => {
    const s = state([
      tab({ sheetName: 'Primers', selected: true }),
      tab({ sheetName: 'Strains', selected: false }),
      tab({ sheetName: 'Plasmids', selected: true }),
    ]);
    expect(selectedReviewTabs(s).map((t) => t.sheetName)).toEqual(['Primers', 'Plasmids']);
  });

  it('buildReviewSummaryRows accounts for EVERY sheet — an unchecked tab is not-selected, never absent', () => {
    const s = state([
      tab({
        sheetName: 'Primers',
        outcome: { sheetName: 'Primers', status: 'imported', added: 8, skipped: 0, flagged: 0 },
      }),
      tab({ sheetName: 'Strains', selected: false }),
      tab({
        sheetName: 'Broken',
        outcome: {
          sheetName: 'Broken',
          status: 'failed',
          added: 0,
          skipped: 0,
          flagged: 0,
          error: 'boom',
        },
      }),
    ]);
    const rows = buildReviewSummaryRows(s);
    expect(rows.map((r) => `${r.sheetName}:${r.status}`)).toEqual([
      'Primers:imported',
      'Strains:not-selected',
      'Broken:failed',
    ]);
    expect(rows.find((r) => r.sheetName === 'Primers')?.added).toBe(8);
  });

  it('fieldOptionsForSchema builds the Name + fields.<key> mapping targets from a live schema', () => {
    const schema: LimsSchemaDefinitionView = {
      schemaId: 's1',
      entityKind: 'strain',
      displayName: 'Strain',
      description: '',
      version: 1,
      builtin: true,
      fields: [
        { key: 'species', label: 'Species', type: 'text' },
        { key: 'genotypeCanonical', label: 'Genotype', type: 'long_text' },
      ],
    };
    expect(fieldOptionsForSchema(schema)).toEqual([
      { value: 'entity.name', label: 'Name' },
      { value: 'fields.species', label: 'Species' },
      { value: 'fields.genotypeCanonical', label: 'Genotype' },
    ]);
    expect(fieldOptionsForSchema(undefined)).toEqual([]);
  });
});
