import { describe, expect, it } from 'vitest';
import { registryColumnsForSchema } from './registry-columns';
import type { LimsSchemaDefinitionView } from '../../../../shared/lims';

describe('Registry sequence properties', () => {
  it('shows Size as a read-only property column without treating it as a schema field', () => {
    const schema: LimsSchemaDefinitionView = {
      schemaId: 'schema-entity-sequence',
      currentRevisionId: 'schema-entity-sequence-v2',
      entityKind: 'sequence',
      baseKind: 'sequence',
      displayName: 'DNA sequence',
      description: null,
      version: 2,
      builtin: true,
      fields: [],
    };
    const columns = registryColumnsForSchema(schema);
    const size = columns.find((column) => column.label === 'Size');
    expect(size).toMatchObject({ key: 'property:size' });
    expect(size?.field).toBeUndefined();
    expect(columns.filter((column) => column.field).map((column) => column.field?.key)).toEqual([
      'topology',
      'geneticCode',
    ]);
    expect(registryColumnsForSchema(null).some((column) => column.label === 'Size')).toBe(false);
  });
});
