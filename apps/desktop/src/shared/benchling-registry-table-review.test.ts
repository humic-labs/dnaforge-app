// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { parseRegistryTableMappingDecision } from './benchling-registry-table-review';

const source = {
  archiveSha256: 'a'.repeat(64),
  entryPath: 'Registry/Records.csv',
  entrySha256: 'b'.repeat(64),
  entrySizeBytes: 100,
};
const decision = () => ({
  kind: 'registry_table_mapping',
  version: 1,
  source,
  outcome: {
    kind: 'records',
    headersSha256: 'c'.repeat(64),
    rowCount: 2,
    columns: [
      { kind: 'name' },
      { kind: 'field', label: 'Amount', type: 'number' },
      { kind: 'source_only', reason: 'Keep original notes' },
    ],
  },
});

describe('reviewed registry table decisions', () => {
  it('parses explicit ordered column roles without guessing from labels or values', () => {
    expect(parseRegistryTableMappingDecision(decision())).toEqual(decision());
  });
  it('keeps a source-only table decision without requiring a parsable header', () => {
    const value = {
      kind: 'registry_table_mapping',
      version: 1,
      source,
      outcome: { kind: 'source_only', reason: 'Not a record list' },
    };
    expect(parseRegistryTableMappingDecision(value)).toEqual(value);
  });
  it.each([
    { columns: [{ kind: 'source_only', reason: 'Keep' }] },
    { columns: [{ kind: 'name' }, { kind: 'name' }] },
    { columns: [{ kind: 'name' }, { kind: 'provider_id' }, { kind: 'provider_id' }] },
    { columns: [{ kind: 'name' }, { kind: 'field', label: '', type: 'text' }] },
    { columns: [{ kind: 'name' }, { kind: 'field', label: 'Unknown', type: 'guess' }] },
    { columns: [{ kind: 'name' }, { kind: 'source_only', reason: '' }] },
    { rowCount: -1 },
    { headersSha256: 'not-a-digest' },
  ])('refuses incomplete or ambiguous mapping %j', (outcome) => {
    const value = decision();
    expect(() =>
      parseRegistryTableMappingDecision({ ...value, outcome: { ...value.outcome, ...outcome } })
    ).toThrow();
  });
  it('rejects a path outside the checked ZIP member namespace', () => {
    expect(() =>
      parseRegistryTableMappingDecision({
        ...decision(),
        source: { ...source, entryPath: '../outside.csv' },
      })
    ).toThrow();
  });
  it('rejects extra fields instead of silently dropping an unsupported choice', () => {
    expect(() => parseRegistryTableMappingDecision({ ...decision(), guessed: true })).toThrow();
  });
  it('normalizes property order so a repeated answer has the same durable JSON', () => {
    const value = decision();
    const reordered = {
      outcome: value.outcome,
      source: {
        entrySizeBytes: 100,
        entrySha256: source.entrySha256,
        entryPath: source.entryPath,
        archiveSha256: source.archiveSha256,
      },
      version: 1,
      kind: value.kind,
    };
    expect(parseRegistryTableMappingDecision(value)).toMatchObject({ kind: value.kind });
    expect(JSON.stringify(parseRegistryTableMappingDecision(reordered))).toBe(
      JSON.stringify(parseRegistryTableMappingDecision(value))
    );
  });
});
