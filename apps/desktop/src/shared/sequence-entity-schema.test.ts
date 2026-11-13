import { describe, expect, it } from 'vitest';
import type { ProjectableEntitySchemaRevisionSnapshot } from './entity-schema';
import {
  SEQUENCE_INTRINSIC_FIELD_DEFINITIONS,
  createSequenceEntityMetadataForSchema,
  resolvedEntitySchemaFields,
} from './sequence-entity-schema';

function schema(
  baseKind: string,
  fields: ProjectableEntitySchemaRevisionSnapshot['fields']
): ProjectableEntitySchemaRevisionSnapshot {
  return {
    schemaId: 'schema-custom',
    schemaRevisionId: 'schema-custom-v1',
    name: 'custom',
    displayName: 'Custom',
    baseKind,
    version: 1,
    fields,
  };
}

describe('resolvedEntitySchemaFields', () => {
  it('gives every sequence-backed schema the same intrinsic DNA metadata', () => {
    const fields = resolvedEntitySchemaFields(
      schema('sequence', [{ key: 'cloningMethod', label: 'Cloning method', type: 'text' }])
    );

    expect(fields.map((field) => field.key)).toEqual([
      ...SEQUENCE_INTRINSIC_FIELD_DEFINITIONS.map((field) => field.key),
      'cloningMethod',
    ]);
    expect(fields.some((field) => field.key === 'size')).toBe(false);
  });

  it('does not add sequence metadata to an ordinary record schema', () => {
    expect(
      resolvedEntitySchemaFields(
        schema('record', [{ key: 'vendor', label: 'Vendor', type: 'text' }])
      ).map((field) => field.key)
    ).toEqual(['vendor']);
  });

  it('does not duplicate intrinsic keys carried by an older snapshot', () => {
    expect(
      resolvedEntitySchemaFields(
        schema('sequence', [
          { key: 'topology', label: 'Legacy topology', type: 'text' },
          { key: 'notes', label: 'Notes', type: 'long_text' },
        ])
      ).map((field) => field.key)
    ).toEqual(['topology', 'geneticCode', 'notes']);
  });

  it('keeps legacy sequence length declarations out of the schema field list', () => {
    expect(
      resolvedEntitySchemaFields(
        schema('sequence', [
          {
            key: 'size',
            label: 'Size',
            type: 'number',
            intrinsic: 'sequence.length',
            readOnly: true,
          },
          { key: 'length', label: 'Length', type: 'number', intrinsic: 'sequence.length' },
          { key: 'notes', label: 'Notes', type: 'long_text' },
        ])
      ).map((field) => field.key)
    ).toEqual(['topology', 'geneticCode', 'notes']);
  });

  it('preserves a user-defined size field on an independent record', () => {
    expect(
      resolvedEntitySchemaFields(
        schema('record', [{ key: 'size', label: 'Container size', type: 'number' }])
      )
    ).toEqual([{ key: 'size', label: 'Container size', type: 'number' }]);
  });
});

describe('createSequenceEntityMetadataForSchema', () => {
  it('pins a new package to the supplied live schema revision', () => {
    expect(
      createSequenceEntityMetadataForSchema({
        schemaId: 'schema-custom-vector',
        currentRevisionId: 'schema-custom-vector-v4',
        entityKind: 'custom_vector',
        baseKind: 'sequence',
        displayName: 'Custom vector',
        description: 'Lab-defined vector schema',
        version: 4,
        fields: [{ key: 'purpose', label: 'Purpose', type: 'text' }],
      })
    ).toMatchObject({
      schema: {
        schemaId: 'schema-custom-vector',
        schemaRevisionId: 'schema-custom-vector-v4',
        name: 'custom_vector',
        baseKind: 'sequence',
        version: 4,
        fields: [{ key: 'purpose', label: 'Purpose', type: 'text' }],
      },
      fields: {},
      registrationStatus: 'tracked',
    });
  });

  it('rejects a non-sequence schema at the package boundary', () => {
    expect(() =>
      createSequenceEntityMetadataForSchema({
        schemaId: 'schema-sample',
        currentRevisionId: 'schema-sample-v1',
        entityKind: 'sample',
        baseKind: 'record',
        displayName: 'Sample',
        version: 1,
        fields: [],
      })
    ).toThrow(/not a sequence-backed schema/i);
  });
});
