import { describe, it, expect } from 'vitest';
import {
  dominantFileTypeCategory,
  importDurationBucket,
  importFailureStage,
  importRecordCountBucket,
} from './import-telemetry';
import {
  isAllowedClosedBetaEvent,
  sanitizeClosedBetaProperties,
} from '../../shared/analytics-allowlist';

describe('import bucket vocabularies', () => {
  it('maps record counts onto the allowlist buckets at every boundary', () => {
    expect(importRecordCountBucket(0)).toBe('0');
    expect(importRecordCountBucket(1)).toBe('1');
    expect(importRecordCountBucket(2)).toBe('2_5');
    expect(importRecordCountBucket(5)).toBe('2_5');
    expect(importRecordCountBucket(6)).toBe('6_20');
    expect(importRecordCountBucket(20)).toBe('6_20');
    expect(importRecordCountBucket(21)).toBe('21_100');
    expect(importRecordCountBucket(100)).toBe('21_100');
    expect(importRecordCountBucket(101)).toBe('100_plus');
  });

  it('reports a corrupt measurement as unknown, never as a plausible zero', () => {
    expect(importRecordCountBucket(-1)).toBe('unknown');
    expect(importRecordCountBucket(Number.NaN)).toBe('unknown');
    expect(importDurationBucket(-1)).toBe('unknown');
    expect(importDurationBucket(Number.NaN)).toBe('unknown');
  });

  it('maps durations onto the allowlist buckets at every boundary', () => {
    expect(importDurationBucket(0)).toBe('lt_1s');
    expect(importDurationBucket(1)).toBe('lt_1s');
    expect(importDurationBucket(999)).toBe('lt_1s');
    expect(importDurationBucket(1000)).toBe('1_5s');
    expect(importDurationBucket(4999)).toBe('1_5s');
    expect(importDurationBucket(5000)).toBe('5_30s');
    expect(importDurationBucket(29999)).toBe('5_30s');
    expect(importDurationBucket(30000)).toBe('30s_plus');
  });
});

describe('dominantFileTypeCategory', () => {
  it('reports the category when the import is homogeneous', () => {
    expect(dominantFileTypeCategory(['/a/x.gb', '/a/y.gbk'])).toBe('dna');
  });

  it('reports the most common category when the import is mixed', () => {
    expect(dominantFileTypeCategory(['/a/x.gb', '/a/y.gb', '/a/z.csv'])).toBe('dna');
  });

  it('falls back to unknown on a tie rather than picking arbitrarily', () => {
    expect(dominantFileTypeCategory(['/a/x.gb', '/a/z.csv'])).toBe('unknown');
  });

  it('handles an empty import', () => {
    expect(dominantFileTypeCategory([])).toBe('unknown');
  });

  it('never leaks a file name — only ever one of the fixed categories', () => {
    const category = dominantFileTypeCategory(['/secret/patient-BRCA1-sample.gb']);
    expect(['dna', 'protein', 'sequence', 'spreadsheet', 'image', 'text', 'unknown']).toContain(
      category
    );
  });
});

describe('importFailureStage', () => {
  it('classifies per-item errors as a write failure', () => {
    expect(
      importFailureStage({ imported: 1, skipped: 0, failed: 2, errors: [], written: [] })
    ).toBe('write');
  });

  it('does not guess a stage when nothing failed', () => {
    expect(
      importFailureStage({ imported: 3, skipped: 0, failed: 0, errors: [], written: [] })
    ).toBe('unknown');
    expect(importFailureStage(null)).toBe('unknown');
  });
});

describe('every import event survives the real allowlist', () => {
  const operationId = '550e8400-e29b-41d4-a716-446655440070';
  const cases = [
    {
      event: 'import_started',
      properties: {
        feature_area: 'import',
        source_system_type: 'file',
        file_type_category: 'dna',
        operation_id: operationId,
      },
    },
    {
      event: 'import_completed',
      properties: {
        feature_area: 'import',
        source_system_type: 'file',
        file_type_category: 'dna',
        record_count_bucket: '2_5',
        import_duration_bucket: '1_5s',
        operation_id: operationId,
      },
    },
    {
      event: 'import_failed',
      properties: {
        feature_area: 'import',
        source_system_type: 'file',
        failure_stage: 'write',
        error_class: 'import_item_write_failed',
        operation_id: operationId,
      },
    },
    {
      event: 'import_completed',
      properties: {
        feature_area: 'import',
        source_system_type: 'file',
        file_type_category: 'unknown',
        record_count_bucket: 'unknown',
        import_duration_bucket: 'unknown',
        operation_id: operationId,
      },
    },
    { event: 'workspace_created', properties: { feature_area: 'workspace' } },
  ];

  for (const { event, properties } of cases) {
    it(`${event} (${JSON.stringify(properties).slice(0, 60)}) keeps every property it sends`, () => {
      expect(isAllowedClosedBetaEvent(event)).toBe(true);
      const sanitized = sanitizeClosedBetaProperties(properties);
      for (const [key, value] of Object.entries(properties)) {
        expect(sanitized[key], `${event}.${key} was dropped by the allowlist`).toBe(value);
      }
    });
  }
});
