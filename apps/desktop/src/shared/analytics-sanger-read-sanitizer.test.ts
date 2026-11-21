import { describe, expect, it } from 'vitest';
import { hasPropertySanitizer, sanitizeClosedBetaProperties } from './analytics-allowlist';

const UUID_KEYS = ['sanger_read_revision_id', 'sanger_view_id'] as const;
const CLOCK_KEYS = [
  'sanger_started_at_ms',
  'sanger_parse_started_at_ms',
  'sanger_view_started_at_ms',
] as const;
const BOOLEAN_KEYS = [
  'sanger_trace_available',
  'sanger_quality_available',
  'sanger_trace_visible',
  'sanger_quality_visible',
  'sanger_bases_visible',
] as const;
const ENUM_VALUES = {
  sanger_stage: [
    'read_requested',
    'parse_started',
    'parsed',
    'revision_ready',
    'scene_admitted',
    'first_viewport_presented',
    'read_refused',
    'read_failed',
    'read_cancelled',
    'read_superseded',
    'viewport_accepted',
    'viewport_presented',
    'viewport_refused',
    'viewport_failed',
    'viewport_cancelled',
    'viewport_superseded',
  ],
  sanger_origin: ['initial_read', 'local_reload', 'native_reload', 'attached_read', 'reopen'],
  sanger_classification: ['requested_ab1', 'decoded_ab1'],
  sanger_reason: [
    'source_unavailable',
    'decode',
    'scene',
    'renderer',
    'stale_revision',
    'closed',
    'superseded',
  ],
  sanger_viewport_kind: ['pan', 'zoom'],
} as const;
const NEW_KEYS = [...UUID_KEYS, ...CLOCK_KEYS, ...BOOLEAN_KEYS, ...Object.keys(ENUM_VALUES)];
const OPAQUE_ID = '550e8400-e29b-41d4-a716-446655440001';
const CANARIES = [
  'unknown_sanger_value',
  '/owned-synthetic/read.ab1',
  'https://synthetic.invalid/read.ab1',
  'ACGTAC',
  '30,31,32,33,34,35',
  { sequence: 'ACGTAC', quality: [30, 31, 32, 33, 34, 35] },
  [30, 31, 32, 33, 34, 35],
  ['ACGTAC'],
];

describe('Sanger read lifecycle sanitizer', () => {
  it('retains the complete closed read snapshot without biological or source data', () => {
    const snapshot = {
      feature_area: 'file',
      operation_id: OPAQUE_ID,
      sanger_read_revision_id: '550e8400-e29b-41d4-a716-446655440002',
      sanger_view_id: '550e8400-e29b-41d4-a716-446655440003',
      viewport_operation_id: '550e8400-e29b-41d4-a716-446655440004',
      sanger_stage: 'viewport_failed',
      sanger_origin: 'initial_read',
      sanger_classification: 'decoded_ab1',
      sanger_reason: 'renderer',
      sanger_started_at_ms: 1_000,
      sanger_parse_started_at_ms: 1_001,
      sanger_view_started_at_ms: 1_002,
      viewport_started_at_ms: 1_003,
      sanger_viewport_kind: 'zoom',
      sanger_trace_available: true,
      sanger_quality_available: true,
      sanger_trace_visible: false,
      sanger_quality_visible: false,
      sanger_bases_visible: false,
      occurred_at_ms: 1_004,
    };
    const result = sanitizeClosedBetaProperties({
      ...snapshot,
      source_path: '/owned-synthetic/read.ab1',
      called_bases: 'ACGTAC',
      quality_values: [30, 31, 32, 33, 34, 35],
      sanger_undeclared: { sequence: 'ACGTAC' },
    });
    expect(result).toEqual(snapshot);
    expect(Object.keys(result)).toHaveLength(20);
  });

  it('registers each of the fifteen exact Sanger property rules', () => {
    expect(NEW_KEYS).toHaveLength(15);
    expect(new Set(NEW_KEYS).size).toBe(15);
    expect(NEW_KEYS.filter((key) => !hasPropertySanitizer(key))).toEqual([]);
    expect(hasPropertySanitizer('sanger_undeclared')).toBe(false);
  });

  it('accepts opaque UUID strings and refuses source-derived or coerced identities', () => {
    for (const key of UUID_KEYS) {
      expect(sanitizeClosedBetaProperties({ [key]: OPAQUE_ID })).toEqual({ [key]: OPAQUE_ID });
      for (const value of [
        'read-1',
        '550e8400e29b41d4a716446655440001',
        `${OPAQUE_ID}/read.ab1`,
        ` ${OPAQUE_ID}`,
        `${OPAQUE_ID} `,
        1,
        true,
        null,
        undefined,
        [OPAQUE_ID],
        { value: OPAQUE_ID },
      ]) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({});
      }
    }
  });

  it('preserves finite nonnegative original clocks without string or boolean coercion', () => {
    for (const key of CLOCK_KEYS) {
      for (const value of [0, 0.5, 1_700_000_000_123]) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({ [key]: value });
      }
      for (const value of [
        -1,
        NaN,
        Infinity,
        -Infinity,
        '0',
        '1000',
        true,
        false,
        null,
        undefined,
      ]) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({});
      }
    }
  });

  it('retains literal availability and visibility booleans without coercion', () => {
    for (const key of BOOLEAN_KEYS) {
      for (const value of [true, false]) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({ [key]: value });
      }
      for (const value of [0, 1, 'true', 'false', null, undefined, {}, []]) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({});
      }
    }
  });

  it('accepts only the literal closed lifecycle vocabulary for every enum rule', () => {
    for (const [key, values] of Object.entries(ENUM_VALUES)) {
      for (const value of values) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({ [key]: value });
        for (const rejected of [
          value.toUpperCase(),
          ` ${value}`,
          `${value} `,
          [value],
          { value },
        ]) {
          expect(sanitizeClosedBetaProperties({ [key]: rejected })).toEqual({});
        }
      }
      for (const value of [
        'unknown',
        'sequence',
        'import',
        'alignment',
        0,
        true,
        null,
        undefined,
      ]) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({});
      }
    }
  });

  it('excludes raw source bases quality objects and arrays from every new rule', () => {
    for (const key of NEW_KEYS) {
      for (const value of CANARIES) {
        expect(sanitizeClosedBetaProperties({ [key]: value })).toEqual({});
      }
    }
  });
});
