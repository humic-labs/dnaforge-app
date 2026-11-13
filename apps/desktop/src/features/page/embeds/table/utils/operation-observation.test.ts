import { describe, expect, it } from 'vitest';
import { evaluateAllFormulas, evaluateTableRevision } from './formulas';
import { tableOperationObservation } from './operation-observation';
import {
  boundedTableObservationCount,
  isTableOperationObservation,
  MAX_TABLE_OBSERVATION_COUNT,
  tableObservationProperties,
} from '../../../../../shared/table-notebook-observation';
import { sanitizeClosedBetaProperties } from '../../../../../shared/analytics-allowlist';
import { CLOSED_BETA_EVENT_PROPERTIES } from '../../../../../shared/analytics-registry.generated';
import type { Cell } from '../types';

describe('real current-revision calculation provenance', () => {
  it('classifies typed resolver failures separately from error-shaped text and recovered errors', () => {
    const cells: Cell[][] = [
      [
        { value: '#REF', type: 'text' },
        { value: '=CONCAT("#REF")', type: 'formula' },
        { value: '=IFERROR(Z99,7)', type: 'formula' },
        {
          value: '=SOURCE()',
          type: 'formula',
          formulaCompatibility: 'unsupported',
          computed: '#ERROR',
        },
      ],
    ];
    const revision = evaluateTableRevision(cells);
    expect(revision.cells[0].map((cell) => cell.computed ?? cell.value)).toEqual([
      '#REF',
      '#REF',
      7,
      '#ERROR',
    ]);
    expect(revision.calculation).toEqual({
      result: 'mixed',
      evaluatedCount: 2,
      errorCount: 0,
      savedCount: 1,
      staleCount: 0,
      unavailableCount: 0,
    });
    expect(evaluateAllFormulas(cells)).toEqual(revision.cells);
    expect(cells[0][1]).not.toHaveProperty('computed');
    expect(cells[0][3].computed).toBe('#ERROR');
  });

  it('uses dependency outcomes from this revision, never an old stored computed value', () => {
    const cells: Cell[][] = [
      [
        { value: '2', type: 'number' },
        { value: '=A1+1', type: 'formula', computed: -999 },
        { value: '=B1+1', type: 'formula', computed: '#ERROR' },
      ],
    ];
    expect(evaluateTableRevision(cells)).toMatchObject({
      cells: [[{ value: '2' }, { computed: 3 }, { computed: 4 }]],
      calculation: {
        result: 'evaluated',
        evaluatedCount: 2,
        errorCount: 0,
        savedCount: 0,
        staleCount: 0,
        unavailableCount: 0,
      },
    });
    cells[0][0] = { value: '=C1', type: 'formula' };
    expect(evaluateTableRevision(cells).calculation).toEqual({
      result: 'failed',
      evaluatedCount: 3,
      errorCount: 3,
      savedCount: 0,
      staleCount: 0,
      unavailableCount: 0,
    });
    expect(evaluateTableRevision(cells).cells[0].map((cell) => cell.computed)).toEqual([
      '#REF',
      '#REF',
      '#REF',
    ]);
  });

  it.each(['text', 'formula'] as const)(
    'keeps unsupported %s saved provenance distinct from fresh computation and failure',
    (type) => {
      const saved: Cell =
        type === 'text'
          ? {
              type,
              value: '#REF',
              sourceFormula: '=SOURCE()',
              sourceRenderedValue: '#REF',
              formulaCompatibility: 'unsupported',
            }
          : { type, value: '=SOURCE()', computed: '#REF', formulaCompatibility: 'unsupported' };
      expect(evaluateTableRevision([[saved]]).calculation).toEqual({
        result: 'saved',
        evaluatedCount: 0,
        errorCount: 0,
        savedCount: 1,
        staleCount: 0,
        unavailableCount: 0,
      });
      const stale = { ...saved, stale: true };
      expect(evaluateTableRevision([[stale]]).calculation).toEqual({
        result: 'saved_stale',
        evaluatedCount: 0,
        errorCount: 0,
        savedCount: 1,
        staleCount: 1,
        unavailableCount: 0,
      });
      const mixed = evaluateTableRevision([
        [stale, { value: '=NO_SUCH_FUNCTION()', type: 'formula' }],
      ]);
      expect(mixed.calculation).toEqual({
        result: 'mixed_failed',
        evaluatedCount: 1,
        errorCount: 1,
        savedCount: 1,
        staleCount: 1,
        unavailableCount: 0,
      });
      expect(mixed.cells[0][0]).toBe(stale);
      expect(saved).not.toHaveProperty('stale');
    }
  );

  it('does not infer an operation from programmatic data or leak scientific content through the closed projection', () => {
    const cells: Cell[][] = [
      [
        { value: 'PRIVATE_CELL', type: 'text' },
        { value: '=A1', type: 'formula' },
      ],
    ];
    const calculation = evaluateTableRevision(cells).calculation;
    expect(tableOperationObservation('paste', undefined, cells, calculation)).toBeUndefined();
    const observation = tableOperationObservation('paste', 'expanded', cells, calculation)!;
    expect(isTableOperationObservation(observation)).toBe(true);
    const properties = tableObservationProperties(observation);
    expect(CLOSED_BETA_EVENT_PROPERTIES.workflow_action_observed).toEqual(
      expect.arrayContaining(Object.keys(properties))
    );
    expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
    expect(properties).toMatchObject({
      table_operation: 'paste',
      table_surface: 'expanded',
      table_calculation_result: 'evaluated',
      table_rows: 1,
      table_columns: 2,
      table_formula_count: 1,
      table_calculation_error_count: 0,
    });
    expect(JSON.stringify(properties)).not.toContain('PRIVATE_CELL');
    expect(JSON.stringify(properties)).not.toContain('=A1');
    expect(isTableOperationObservation({ ...observation, cells })).toBe(false);
    expect(
      isTableOperationObservation({
        ...observation,
        calculation: { ...observation.calculation, expression: '=A1' },
      })
    ).toBe(false);
    expect(
      isTableOperationObservation({
        ...observation,
        calculation: { ...observation.calculation, result: 'failed' },
      })
    ).toBe(false);
    expect(isTableOperationObservation(undefined)).toBe(false);
    expect(isTableOperationObservation({ operation: 'edit' })).toBe(false);
  });

  it('does not call absent imported result evidence a successful saved or native calculation', () => {
    const missing: Cell = {
      type: 'formula',
      value: '=SOURCE()',
      formulaCompatibility: 'unsupported',
      stale: true,
    };
    const revision = evaluateTableRevision([[missing, { value: '=1+1', type: 'formula' }]]);
    expect(revision.calculation).toEqual({
      result: 'unavailable',
      evaluatedCount: 1,
      errorCount: 0,
      savedCount: 0,
      staleCount: 0,
      unavailableCount: 1,
    });
    expect(revision.cells[0][0]).toBe(missing);
    expect(revision.cells[0][0]).not.toHaveProperty('computed');
    const observation = tableOperationObservation(
      'edit',
      'inline',
      [[missing]],
      evaluateTableRevision([[missing]]).calculation
    )!;
    expect(isTableOperationObservation(observation)).toBe(true);
    expect(tableObservationProperties(observation)).toMatchObject({
      table_calculation_result: 'unavailable',
      table_saved_result_count: 0,
      table_saved_result_unavailable_count: 1,
      table_formula_count: 0,
    });
  });

  it('bounds every dimension/count and rejects unbounded or private wire values', () => {
    expect(boundedTableObservationCount(MAX_TABLE_OBSERVATION_COUNT + 42)).toBe(
      MAX_TABLE_OBSERVATION_COUNT
    );
    const names = [
      'table_rows',
      'table_columns',
      'table_formula_count',
      'table_calculation_error_count',
      'table_saved_result_count',
      'table_stale_result_count',
      'table_saved_result_unavailable_count',
    ];
    for (const value of [
      -1,
      0.5,
      Infinity,
      NaN,
      MAX_TABLE_OBSERVATION_COUNT + 1,
      'PRIVATE_VALUE',
    ]) {
      expect(
        sanitizeClosedBetaProperties(Object.fromEntries(names.map((name) => [name, value])))
      ).toEqual({});
    }
    expect(
      sanitizeClosedBetaProperties({
        table_operation: 'PRIVATE_OPERATION',
        table_surface: '/private/path',
        table_calculation_result: '=PRIVATE_FORMULA()',
        cells: 'PRIVATE_CELL',
        clipboard: 'PRIVATE_CLIPBOARD',
      })
    ).toEqual({});
    expect(
      sanitizeClosedBetaProperties({
        table_rows: MAX_TABLE_OBSERVATION_COUNT,
        table_formula_count: 0,
      })
    ).toEqual({ table_rows: MAX_TABLE_OBSERVATION_COUNT, table_formula_count: 0 });
  });
});
