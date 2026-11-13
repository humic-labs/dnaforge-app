// @vitest-environment node

import { classifyLimsEntityFieldIssues, type LimsFieldDefinition } from './lims';

describe('LIMS date field compatibility', () => {
  it('preserves legacy date strings when the field has no date bounds', () => {
    const fields: LimsFieldDefinition[] = [
      { key: 'collectedOn', label: 'Collected on', type: 'date' },
    ];

    expect(classifyLimsEntityFieldIssues('sample', { collectedOn: '15/01/2024' }, fields)).toEqual({
      malformed: [],
      incomplete: [],
    });
  });

  it('requires a parseable date when the field declares a date bound', () => {
    const fields: LimsFieldDefinition[] = [
      {
        key: 'collectedOn',
        label: 'Collected on',
        type: 'date',
        minDate: '2024-01-01T00:00:00.000Z',
      },
    ];

    expect(
      classifyLimsEntityFieldIssues('sample', { collectedOn: 'not a date' }, fields).malformed
    ).toEqual(['collectedOn must be a valid date']);
    expect(
      classifyLimsEntityFieldIssues('sample', { collectedOn: '2023-12-31T00:00:00.000Z' }, fields)
        .malformed
    ).toEqual(['collectedOn must be on or after 2024-01-01T00:00:00.000Z']);
  });
});
