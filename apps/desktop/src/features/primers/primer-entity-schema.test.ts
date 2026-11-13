import { describe, expect, it } from 'vitest';
import type { LimsSchemaDefinitionView } from '../../shared/lims';
import { builtinPrimerSchemaView, primerSchemas } from './primer-entity-schema';

const derived = (
  schemaId: string,
  entityKind: string,
  sequenceType: 'dna_sequence' | 'rna_sequence'
): LimsSchemaDefinitionView => ({
  schemaId,
  currentRevisionId: `${schemaId}-v1`,
  entityKind,
  baseKind: 'primer',
  displayName: entityKind,
  description: null,
  version: 1,
  builtin: false,
  fields: [
    {
      key: 'sequence',
      label: 'Sequence',
      type: sequenceType,
      required: true,
      requireResolved: true,
    },
  ],
});

describe('oligo entity schemas', () => {
  it('uses distinct built-in schema identities and sequence field types', () => {
    expect(builtinPrimerSchemaView('dna')).toMatchObject({
      entityKind: 'oligo',
      displayName: 'DNA Oligo',
    });
    expect(builtinPrimerSchemaView('dna').fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'sequence', type: 'dna_sequence' })])
    );
    expect(builtinPrimerSchemaView('rna')).toMatchObject({
      entityKind: 'rna_oligo',
      displayName: 'RNA Oligo',
    });
    expect(builtinPrimerSchemaView('rna').fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'sequence', type: 'rna_sequence' })])
    );
  });

  it('offers derived schemas only to their matching oligo entity type', () => {
    const dna = derived('schema-dna-custom', 'qpcr_primer', 'dna_sequence');
    const rna = derived('schema-rna-custom', 'sirna', 'rna_sequence');

    expect(primerSchemas([dna, rna], 'dna').map((schema) => schema.schemaId)).toContain(
      'schema-dna-custom'
    );
    expect(primerSchemas([dna, rna], 'dna').map((schema) => schema.schemaId)).not.toContain(
      'schema-rna-custom'
    );
    expect(primerSchemas([dna, rna], 'rna').map((schema) => schema.schemaId)).toContain(
      'schema-rna-custom'
    );
    expect(primerSchemas([dna, rna], 'rna').map((schema) => schema.schemaId)).not.toContain(
      'schema-dna-custom'
    );
  });
});
