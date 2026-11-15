// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  classifyMetadataValues,
  type MetadataFieldDefinition,
} from '@waypoint/domain-services/metadata-fields';
import { classifyLimsEntityFieldIssues, type LimsFieldDefinition } from './lims';

describe('shared scalar metadata compatibility', () => {
  it.each<{
    field: MetadataFieldDefinition;
    values: readonly unknown[];
    errors: readonly (string | null)[];
  }>([
    {
      field: { key: 'f', label: 'F', type: 'text', maxLength: 3 },
      values: ['abc', 'abcd', 1],
      errors: [null, 'f exceeds 3 characters', 'f must be a string'],
    },
    {
      field: { key: 'f', label: 'F', type: 'long_text', maxLength: 3 },
      values: ['abc', 'abcd', false],
      errors: [null, 'f exceeds 3 characters', 'f must be a string'],
    },
    {
      field: { key: 'f', label: 'F', type: 'number', minValue: -1, maxValue: 2 },
      values: [-1, 0.5, 2, -2, 3, NaN, Infinity, '1'],
      errors: [
        null,
        null,
        null,
        'f must be at least -1',
        'f must be at most 2',
        'f must be a finite number',
        'f must be a finite number',
        'f must be a finite number',
      ],
    },
    {
      field: { key: 'f', label: 'F', type: 'boolean' },
      values: [false, true, 0],
      errors: [null, null, 'f must be a boolean'],
    },
    {
      field: { key: 'f', label: 'F', type: 'string_array' },
      values: [[], [''], ['a', 'b'], ['a', 1], 'a'],
      errors: [null, null, null, 'f must be an array of strings', 'f must be an array of strings'],
    },
    {
      field: { key: 'f', label: 'F', type: 'enum', enumOptions: ['a', 'b'] },
      values: ['a', 'c', false],
      errors: [null, 'f must be one of a, b', 'f must be a string'],
    },
    { field: { key: 'f', label: 'F', type: 'enum' }, values: ['legacy'], errors: [null] },
    {
      field: { key: 'f', label: 'F', type: 'date' },
      values: ['15/01/2024', 'not a date', 1],
      errors: [null, null, 'f must be a string'],
    },
    {
      field: {
        key: 'f',
        label: 'F',
        type: 'date',
        minDate: '2024-01-01T00:00:00Z',
        maxDate: '2024-12-31T00:00:00Z',
      },
      values: ['2024-01-01', 'not a date', '2023-01-01', '2025-01-01'],
      errors: [
        null,
        'f must be a valid date',
        'f must be on or after 2024-01-01T00:00:00Z',
        'f must be on or before 2024-12-31T00:00:00Z',
      ],
    },
  ])('preserves $field.type values and exact public LIMS errors', ({ field, values, errors }) => {
    values.forEach((value, index) => {
      const expected = { malformed: errors[index] === null ? [] : [errors[index]], incomplete: [] };
      expect(classifyMetadataValues([field], { f: value })).toEqual(expected);
      expect(classifyLimsEntityFieldIssues('sample', { f: value }, [field])).toEqual(expected);
    });
  });

  it('keeps missing-value and unknown-field behavior in the public scientific adapter', () => {
    const fields: LimsFieldDefinition[] = [
      { key: 'a', label: 'A', type: 'text', required: true },
      { key: 'b', label: 'B', type: 'boolean', required: true, readOnly: true },
      { key: 'c', label: 'C', type: 'number', required: true },
      { key: 'd', label: 'D', type: 'string_array', required: true },
    ];
    for (const missing of [null, undefined, '']) {
      expect(
        classifyLimsEntityFieldIssues(
          'sample',
          { a: missing, b: false, c: 0, d: [], undeclared: 'preserved' },
          fields
        )
      ).toEqual({
        malformed: [],
        incomplete: ['a is required'],
      });
    }
  });

  it('retains scientific-only unresolved sequence classification', () => {
    expect(
      classifyLimsEntityFieldIssues('sample', { sequence: { mode: 'unresolved' } }, [
        { key: 'sequence', label: 'Sequence', type: 'dna_sequence', requireResolved: true },
      ])
    ).toEqual({ malformed: [], incomplete: ['sequence has no resolved sequence yet'] });
  });
});
