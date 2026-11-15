import { describe, expect, it } from 'vitest';
import {
  classifyMetadataValues,
  metadataFieldDefinitionsJsonSchema,
  parseMetadataFieldDefinitions,
  validateMetadataValues,
} from './metadata-fields';

describe('portable metadata fields', () => {
  it('round-trips scalar definitions without scientific fields or mutable input arrays', () => {
    const fields = [
      { key: 'label', label: 'Label', type: 'text', required: true, maxLength: 20 },
      {
        key: 'notes',
        label: 'Notes',
        type: 'long_text',
        suggested: true,
        description: 'Instructions',
      },
      { key: 'active', label: 'Active', type: 'boolean', readOnly: true },
      { key: 'color', label: 'Color', type: 'enum', enumOptions: ['red', 'blue'] },
      {
        key: 'created',
        label: 'Created',
        type: 'date',
        minDate: '2024-02-29T00:00:00Z',
        maxDate: '2024-12-31T23:59:59+01:00',
      },
      { key: 'score', label: 'Score', type: 'number', minValue: -1.5, maxValue: 2.5 },
      { key: 'tags', label: 'Tags', type: 'string_array' },
    ];
    const parsed = parseMetadataFieldDefinitions(fields);
    expect(parsed).toEqual(fields);
    fields[3].enumOptions!.push('green');
    expect(parsed[3].enumOptions).toEqual(['red', 'blue']);
    expect(metadataFieldDefinitionsJsonSchema()).toMatchObject({
      type: 'array',
      items: { additionalProperties: false, required: ['key', 'label', 'type'] },
    });
  });

  it.each([
    [{ key: 'id', label: 'ID', type: 'dna_sequence' }],
    [{ key: 'id', label: 'ID', type: 'text', intrinsic: 'sequence.length' }],
    [{ key: 'id', label: 'ID', type: 'text', requireResolved: true }],
    [
      { key: 'id', label: 'ID', type: 'text' },
      { key: 'id', label: 'Again', type: 'text' },
    ],
    [{ key: '_id', label: 'ID', type: 'text' }],
    [{ key: 'id', label: '', type: 'text' }],
    [{ key: 'id', label: 'ID', type: 'enum' }],
    [{ key: 'id', label: 'ID', type: 'enum', enumOptions: [''] }],
    [{ key: 'id', label: 'ID', type: 'text', required: true, suggested: true }],
    [{ key: 'id', label: 'ID', type: 'text', maxLength: 0 }],
    [{ key: 'id', label: 'ID', type: 'number', minValue: 2, maxValue: 1 }],
    [{ key: 'id', label: 'ID', type: 'number', minValue: Infinity }],
    [{ key: 'id', label: 'ID', type: 'date', minDate: '2023-02-29T00:00:00Z' }],
    [{ key: 'id', label: 'ID', type: 'date', minDate: '2024-01-01' }],
    [
      {
        key: 'id',
        label: 'ID',
        type: 'date',
        minDate: '2025-01-01T00:00:00Z',
        maxDate: '2024-01-01T00:00:00Z',
      },
    ],
  ])('rejects malformed or unsupported field definitions: %j', (...fields) => {
    expect(() => parseMetadataFieldDefinitions(fields)).toThrow(TypeError);
  });

  it('separates malformed values from missing required fields and optionally refuses undeclared keys', () => {
    const fields = parseMetadataFieldDefinitions([
      { key: 'count', label: 'Count', type: 'number', required: true },
      { key: 'active', label: 'Active', type: 'boolean', required: true },
      { key: 'tags', label: 'Tags', type: 'string_array', required: true },
      { key: 'notes', label: 'Notes', type: 'text', required: true },
    ]);
    expect(
      classifyMetadataValues(fields, { count: 0, active: false, tags: [], notes: '' })
    ).toEqual({
      malformed: [],
      incomplete: ['notes is required'],
    });
    const values = { count: 'zero', active: null, tags: [], notes: undefined, extra: 1 };
    expect(classifyMetadataValues(fields, values)).toEqual({
      malformed: ['count must be a finite number'],
      incomplete: ['active is required', 'notes is required'],
    });
    expect(validateMetadataValues(fields, values, { rejectUnknownFields: true })).toEqual([
      'count must be a finite number',
      'extra is not a declared field',
      'active is required',
      'notes is required',
    ]);
  });

  it('requires actual metadata values rather than inherited object properties', () => {
    const fields = parseMetadataFieldDefinitions([
      { key: 'constructor', label: 'Constructor', type: 'text', required: true },
    ]);
    expect(validateMetadataValues(fields, {})).toEqual(['constructor is required']);
    expect(validateMetadataValues(fields, { constructor: 'Synthetic' })).toEqual([]);
  });

  it('refuses absent entries in definition and enum option arrays', () => {
    expect(() => parseMetadataFieldDefinitions(Array(1))).toThrow(TypeError);
    expect(() =>
      parseMetadataFieldDefinitions([
        { key: 'color', label: 'Color', type: 'enum', enumOptions: Array(1) },
      ])
    ).toThrow(TypeError);
  });
});
