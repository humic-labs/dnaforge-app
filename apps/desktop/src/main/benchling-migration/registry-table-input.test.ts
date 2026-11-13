import { describe, expect, it } from 'vitest';

import { parseRegistryTable, readLocalRegistryTableRows } from './registry-table-input';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { inspectNativeExportArchive } from './native-export-archive';
import { scientificSourceObjectSha256 } from './linked-item-recovery-decoder';
import type { LimsFieldType } from '../../shared/lims';

describe('normalized registry table data', () => {
  it('preserves quoted commas, escaped quotes, Unicode and embedded newlines', () => {
    expect(
      parseRegistryTable('id,name,note\r\nbfi_RECORD01,"α, β","one\r\ntwo ""quoted"""\r\n', '.csv')
    ).toEqual([{ id: 'bfi_RECORD01', name: 'α, β', note: 'one\r\ntwo "quoted"' }]);
  });

  it('retains empty trailing cells and a UTF-8 byte order marker', () => {
    expect(parseRegistryTable('\uFEFFid,name,note\nbfi_RECORD01,Record,', '.csv')).toEqual([
      { id: 'bfi_RECORD01', name: 'Record', note: '' },
    ]);
  });

  it('does not interpret TSV source formulas', () => {
    expect(parseRegistryTable('id\tresult\nbfi_RECORD01\t=1+2\n', '.tsv')).toEqual([
      { id: 'bfi_RECORD01', result: '=1+2' },
    ]);
  });

  it.each([
    ['id,id\na,b\n', 'duplicate'],
    ['id,Registry ID,Registry_ID\na,b,c\n', 'ambiguous'],
    ['id,\na,b\n', 'empty header'],
    ['id,name\na,b,c\n', '3 cells'],
    ['id,name\na\n', '1 cells'],
    ['id,name\na,"unfinished', 'unterminated'],
    ['id,name\na,"closed"tail\n', 'quoting'],
    ['id,name\na,un"quoted\n', 'quoting'],
  ])('rejects lossy or malformed input %j', (input, reason) => {
    expect(() => parseRegistryTable(input, '.csv')).toThrow(reason);
  });

  it.each(['.json', '.jsonl'])('preserves native JSON scalar types in %s', (extension) => {
    const row = { id: 'bfi_RECORD01', amount: 0, confirmed: false, absent: null, labels: ['α'] };
    expect(
      parseRegistryTable(JSON.stringify(extension === '.json' ? [row] : row), extension)
    ).toEqual([row]);
  });

  it('rejects non-record JSON rows', () => {
    expect(() => parseRegistryTable('[null]', '.json')).toThrow('invalid rows');
  });

  it.each(['.json', '.jsonl'])('rejects duplicate JSON keys in %s', (extension) => {
    expect(() =>
      parseRegistryTable('{"id":"bfi_RECORD01","id":"bfi_RECORD02"}', extension)
    ).toThrow(/duplicat/i);
  });

  it.each(['9007199254740993', '1e-400', '1.0000000000000001'])(
    'rejects a number that would silently change: %s',
    async (value) => {
      await expect(registryRows('number', value)).rejects.toThrow(/precision|range|underflow/i);
    }
  );

  it.each(['2026-02-30', '2026-02-29', '2024-02-29T99:00:00Z'])(
    'rejects an impossible date %s',
    async (value) => {
      await expect(registryRows('date', value)).rejects.toThrow(/date/i);
    }
  );

  it('accepts a real leap day', async () => {
    expect((await registryRows('date', '2024-02-29'))[0]?.sourceObject.content).toMatchObject({
      fieldValues: { value: '2024-02-29' },
    });
  });

  it.each(['0', '-0', '0e400', '+12.500', '.125', '-2.5e-3', '9007199254740991'])(
    'accepts an exactly representable decimal %s',
    async (value) => {
      expect((await registryRows('number', value))[0]?.sourceObject.content).toMatchObject({
        fieldValues: { value: Number(value) },
      });
    }
  );

  it.each(['.json', '.jsonl'])('rejects numeric loss before JSON coercion in %s', (extension) => {
    expect(() => parseRegistryTable('{"amount":9007199254740993}', extension)).toThrow(/precision/);
  });

  it.each(['dna_sequence', 'rna_sequence', 'protein_sequence'] as const)(
    'refuses a source-provided local file for %s',
    async (type) => {
      await expect(
        registryRows(type, JSON.stringify({ mode: 'file', relPath: 'unverified.gb' }))
      ).rejects.toThrow(/verified source attachment/);
    }
  );

  it('accepts a source inline DNA sequence without granting file authority', async () => {
    expect(
      (
        await registryRows(
          'dna_sequence',
          JSON.stringify({ mode: 'inline', bases: 'ACGT', length: 4, topology: 'linear' })
        )
      )[0]?.sourceObject.content
    ).toMatchObject({ fieldValues: { value: { mode: 'inline', bases: 'ACGT' } } });
  });

  it('ignores an unrelated malformed schema-named asset', async () => {
    expect(
      await rowsFromEntries([{ path: 'assets/schema.json', bytes: '{not a registry schema' }])
    ).toEqual([]);
  });

  it('rejects a damaged declared registry schema', async () => {
    await expect(
      rowsFromEntries([
        { path: 'records.schema.json', bytes: '{"schema":"benchling.registry-schema.v1",' },
      ])
    ).rejects.toThrow(/JSON/);
  });

  it('rejects one input column claimed by two schema fields', async () => {
    await expect(
      registryRows('number', '1', '', [
        { sourceFieldId: 'second', definition: { key: 'other', label: 'Value', type: 'number' } },
      ])
    ).rejects.toThrow(/multiple fields/);
  });

  it('does not change one record fingerprint when another row changes or moves', async () => {
    const first = await registryRows('number', '12.5', 'bfi_RECORD02,Other,1\n');
    const second = await registryRows('number', '12.5', 'bfi_RECORD02,Other,2\n');
    const a = first[0]?.sourceObject;
    const b = second[0]?.sourceObject;
    if (!a || !b) throw new Error('Expected registry fixtures.');
    expect(scientificSourceObjectSha256(a)).toBe(scientificSourceObjectSha256(b));
  });
});

async function registryRows(
  type: LimsFieldType,
  value: string,
  extraRow = '',
  extraFields: Record<string, unknown>[] = []
) {
  return rowsFromEntries([
    {
      path: 'records.schema.json',
      bytes: JSON.stringify({
        schema: 'benchling.registry-schema.v1',
        sourceSchemaId: 'schema-test',
        sourceRevisionId: 'revision-1',
        name: 'reagent',
        displayName: 'Reagent',
        recordPaths: ['records.csv'],
        fields: [
          { sourceFieldId: 'field-value', definition: { key: 'value', label: 'Value', type } },
          ...extraFields,
        ],
      }),
    },
    {
      path: 'records.csv',
      bytes: `id,name,value\nbfi_RECORD01,Record,"${value.replaceAll('"', '""')}"\n${extraRow}`,
    },
  ]);
}

async function rowsFromEntries(entries: Parameters<typeof buildSyntheticNativeExportZip>[0]) {
  const fixture = buildSyntheticNativeExportZip(entries);
  const archive = await inspectNativeExportArchive({
    kind: 'bytes',
    logicalFilename: 'synthetic-registry.zip',
    bytes: fixture.bytes,
    expectedSha256: fixture.sha256,
    expectedSizeBytes: fixture.sizeBytes,
  });
  return readLocalRegistryTableRows(archive);
}
