import { describe, expect, it } from 'vitest';
import {
  otherEntityMetadata,
  resolveEntityRecordFieldValues,
  validatedSequenceEntityRegistrationStatus,
} from './entity-record';

describe('resolveEntityRecordFieldValues', () => {
  it('combines sequence-owned metadata and custom schema values into one record', () => {
    expect(
      resolveEntityRecordFieldValues(
        {
          schemaId: 'schema-plasmid',
          schemaRevisionId: 'schema-plasmid-v1',
          name: 'plasmid',
          displayName: 'Plasmid',
          baseKind: 'sequence',
          version: 1,
          fields: [{ key: 'cloningMethod', label: 'Cloning method', type: 'text' }],
        },
        { cloningMethod: 'Gibson' },
        { length: 8233, topology: 'circular', geneticCode: 1 }
      )
    ).toEqual({
      size: 8233,
      topology: 'circular',
      geneticCode: 1,
      cloningMethod: 'Gibson',
    });
  });

  it('uses the standard genetic code when a DNA record declares no code', () => {
    expect(
      resolveEntityRecordFieldValues(
        {
          schemaId: 'schema-sequence',
          schemaRevisionId: 'schema-sequence-v1',
          name: 'sequence',
          displayName: 'DNA sequence',
          baseKind: 'sequence',
          version: 1,
          fields: [],
        },
        {}
      ).geneticCode
    ).toBe(1);
  });

  it('separates unmatched user metadata from schema values and projection bookkeeping', () => {
    expect(
      otherEntityMetadata(
        {
          baseKind: 'record',
          fields: [{ key: 'notes', label: 'Notes', type: 'long_text' }],
        },
        {
          notes: 'in schema',
          cloningMethod: 'gibson',
          artifact: { schema: 'dnaforge.primer', relativePath: 'primers/example.primer.json' },
          _managedSequenceDocument: {},
          schemaId: 'schema-sequence',
        }
      )
    ).toEqual([{ key: 'cloningMethod', label: 'Cloning Method', value: 'gibson' }]);
  });

  it('retains user metadata called artifact when it is not a known native file locator', () => {
    const value = { description: 'Label printed on the physical sample' };
    expect(otherEntityMetadata({ baseKind: 'record', fields: [] }, { artifact: value })).toEqual([
      { key: 'artifact', label: 'Artifact', value },
    ]);
  });

  it('does not expose stale copies of sequence primitive values as other metadata', () => {
    expect(
      otherEntityMetadata(
        {
          baseKind: 'sequence',
          fields: [{ key: 'notes', label: 'Notes', type: 'long_text' }],
        },
        { size: 999, topology: 'linear', geneticCode: 11, notes: 'in schema', legacyOwner: 'lab' }
      )
    ).toEqual([{ key: 'legacyOwner', label: 'Legacy Owner', value: 'lab' }]);
  });

  it('derives size from the viewed sequence instead of a stale stored field', () => {
    const schema = {
      schemaId: 'schema-sequence',
      schemaRevisionId: 'schema-sequence-v1',
      name: 'sequence',
      displayName: 'DNA sequence',
      baseKind: 'sequence',
      version: 1,
      fields: [],
    };
    expect(resolveEntityRecordFieldValues(schema, { size: 999 }, { length: 42 }).size).toBe(42);
    expect(resolveEntityRecordFieldValues(schema, { size: 999 }, { length: 0 }).size).toBe(0);
    expect(resolveEntityRecordFieldValues(schema, { size: 999 }).size).toBeUndefined();
    expect(otherEntityMetadata({ baseKind: 'record', fields: [] }, { size: 999 })).toEqual([
      { key: 'size', label: 'Size', value: 999 },
    ]);
  });

  it('marks a registered package unresolved when a required schema value is empty', () => {
    const schema = {
      schemaId: 'schema-vector',
      schemaRevisionId: 'schema-vector-v1',
      name: 'vector',
      displayName: 'Vector',
      baseKind: 'sequence' as const,
      version: 1,
      fields: [{ key: 'purpose', label: 'Purpose', type: 'text', required: true }],
    };
    expect(validatedSequenceEntityRegistrationStatus(schema, {}, 'registered')).toBe('unresolved');
    expect(
      validatedSequenceEntityRegistrationStatus(schema, { purpose: 'Expression' }, 'unresolved')
    ).toBe('registered');
  });

  it('rejects malformed package field values before they can outrun the Registry projection', () => {
    expect(() =>
      validatedSequenceEntityRegistrationStatus(
        {
          schemaId: 'schema-vector',
          schemaRevisionId: 'schema-vector-v1',
          name: 'vector',
          displayName: 'Vector',
          baseKind: 'sequence',
          version: 1,
          fields: [{ key: 'copies', label: 'Copies', type: 'number' }],
        },
        { copies: 'many' },
        'registered'
      )
    ).toThrow('copies must be a finite number');
  });
});
