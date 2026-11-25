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

import * as workbookReviewHelpers from './workbook-review';
import type { LimsIdScheme, LimsImportPlan } from '../../../shared/lims';

function countPlan(accepted: boolean[]): LimsImportPlan {
  return {
    id: 'count-plan',
    sourceName: 'records.csv',
    sourceKind: 'csv',
    detectedKind: 'primer_table',
    columns: [
      {
        sourceColumn: 'Name',
        mappedField: 'entity.name',
        mappingMode: 'mapped',
        confidence: 'deterministic',
        warnings: [],
      },
    ],
    records: accepted.map((selected, index) => ({
      id: `row-${index}`,
      accepted: selected,
      action: 'create',
      entityDraft: { kind: 'oligo', name: `Oligo ${index}`, fields: {} },
      duplicateCandidates: [],
      proposedLinks: [],
      unresolvedLinks: [],
      errors: [],
      warnings: [],
      source: {},
    })),
    aggregateWarnings: [],
    canApply: true,
    oracle: { ok: true, source: 'count-fixture', invariants: [] },
  };
}

function countSchema(fields: LimsSchemaDefinitionView['fields'] = []): LimsSchemaDefinitionView {
  return {
    schemaId: 'live-schema',
    entityKind: 'oligo',
    displayName: 'Oligo',
    description: '',
    version: 1,
    builtin: false,
    fields,
  };
}

function countScheme(overrides: Partial<LimsIdScheme> = {}): LimsIdScheme {
  return {
    kind: 'oligo',
    prefix: 'o',
    padWidth: 3,
    nextSeq: 1,
    enabled: true,
    updatedAt: 0,
    ...overrides,
  };
}

function freezeCountInput(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeCountInput(child);
  Object.freeze(value);
}

describe('workbookAcceptedCount', () => {
  it('returns zero for no review and no selected usable plans', () => {
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: null,
        preview: countPlan([true]),
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(0);
    const review = state([
      tab({ sheetName: 'Skipped', selected: false, plan: countPlan([true]) }),
      tab({ sheetName: 'Missing', plan: null }),
    ]);
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(0);
  });

  it('sums accepted flags from selected sheets without substituting row counts or filtering review issues', () => {
    const first = countPlan([true, true, false]);
    first.records[0].errors.push('invalid source field');
    first.records[1].warnings.push('review this row');
    first.records[1].duplicateCandidates.push({
      entityId: 'existing',
      name: 'Existing',
      reason: 'Already registered',
    });
    first.records[1].action = 'skip';
    const review = state([
      tab({ sheetName: 'First', plan: first, rowCount: 900 }),
      tab({ sheetName: 'Second', plan: countPlan([true, false]), rowCount: 700 }),
      tab({ sheetName: 'Unchecked', selected: false, plan: countPlan([true, true, true]) }),
    ]);
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(3);
  });

  it('uses only the active sheet preview and falls back to its saved plan when preview is null', () => {
    const review = state(
      [
        tab({ sheetName: 'Active', plan: countPlan([true, true]) }),
        tab({ sheetName: 'Other', plan: countPlan([true]) }),
      ],
      'Active'
    );
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: countPlan([true, false, false]),
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(2);
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(3);
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: { ...review, activeSheet: 'Absent' },
        preview: countPlan([true, true, true, true]),
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(3);
  });

  it('applies the active preview to each selected tab with that sheet name and skips missing inactive plans', () => {
    const review = state(
      [
        tab({ sheetName: 'Repeated', plan: null }),
        tab({ sheetName: 'Repeated', plan: countPlan([true, true]) }),
        tab({ sheetName: 'Missing', plan: null }),
      ],
      'Repeated'
    );
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: countPlan([true]),
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(2);
  });

  it('uses the first matching live schema instead of the review schema and preserves full view errors', () => {
    const sentinel = new Error('first live schema was evaluated');
    const first: LimsSchemaDefinitionView = {
      ...countSchema(),
      get fields() {
        throw sentinel;
      },
    };
    const review = state([tab({ sheetName: 'Sheet', plan: countPlan([true]) })]);
    review.schemas = [countSchema()];
    expect(() =>
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [],
        limsSchemas: [first, countSchema()],
      })
    ).toThrow(sentinel);
    const ignoredReviewSchema: LimsSchemaDefinitionView = {
      ...countSchema(),
      get fields() {
        throw new Error('review schema must not be read');
      },
    };
    review.schemas = [ignoredReviewSchema];
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [],
        limsSchemas: [],
      })
    ).toBe(1);
  });

  it('retains default prefix evaluation for enabled schemes and avoids disabled scheme prefixes', () => {
    const sentinel = new Error('default prefix was evaluated');
    const enabled: LimsIdScheme = {
      ...countScheme(),
      get prefix() {
        throw sentinel;
      },
    };
    const disabled: LimsIdScheme = {
      ...countScheme({ enabled: false }),
      get prefix() {
        throw new Error('disabled prefix must not be read');
      },
    };
    const review = state([tab({ sheetName: 'Sheet', plan: countPlan([true]) })]);
    expect(() =>
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [enabled],
        limsSchemas: [],
      })
    ).toThrow(sentinel);
    expect(
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [disabled],
        limsSchemas: [],
      })
    ).toBe(1);
  });

  it('evaluates selected sheets in order without inspecting unchecked plans', () => {
    const seen: string[] = [];
    const first: LimsImportPlan = {
      ...countPlan([true]),
      get columns() {
        seen.push('first');
        return [];
      },
    };
    const stop = new Error('second selected plan reached');
    const second: LimsImportPlan = {
      ...countPlan([true]),
      get columns() {
        seen.push('second');
        throw stop;
      },
    };
    const ignored: WorkbookReviewTab = {
      ...tab({ sheetName: 'Ignored', selected: false }),
      get plan() {
        throw new Error('unchecked plan must not be read');
      },
    };
    const review = state([
      tab({ sheetName: 'First', plan: first }),
      ignored,
      tab({ sheetName: 'Second', plan: second }),
    ]);
    expect(() =>
      workbookReviewHelpers.workbookAcceptedCount({
        workbookReview: review,
        preview: null,
        idSchemes: [],
        limsSchemas: [],
      })
    ).toThrow(stop);
    expect(seen.indexOf('first')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('second')).toBeGreaterThan(seen.indexOf('first'));
  });

  it('leaves review, preview, scheme and schema inputs unchanged', () => {
    const input = {
      workbookReview: state([
        tab({ sheetName: 'First', plan: countPlan([true, false]) }),
        tab({ sheetName: 'Second', plan: countPlan([true]) }),
      ]),
      preview: countPlan([true, true]),
      idSchemes: [countScheme()],
      limsSchemas: [countSchema()],
    };
    const before = JSON.stringify(input);
    freezeCountInput(input);
    expect(workbookReviewHelpers.workbookAcceptedCount(input)).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
  });
});
