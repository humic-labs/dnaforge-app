// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { LIMS_BUILTIN_ENTITY_SCHEMAS, limsSchemaFieldsJson } from '../../shared/lims';
import { assertBuiltinSchemasAreMetaValid, validateEntityInstanceFromFieldsJson } from './schemas';
import * as limsSchemas from './schemas';

describe('LIMS schema definitions', () => {
  it('does not export unused sequence-ref and field-filter helpers', () => {
    expect(limsSchemas).not.toHaveProperty('dnaSequenceRefSchema');
    expect(limsSchemas).not.toHaveProperty('limsRegistrationStatusSchema');
    expect(limsSchemas).not.toHaveProperty('entitySchemaForKind');
    expect(limsSchemas).not.toHaveProperty('relationshipSchemaForType');
    expect(limsSchemas).not.toHaveProperty('requiredFields');
    expect(limsSchemas).not.toHaveProperty('suggestedFields');
    expect(typeof limsSchemas.assertBuiltinSchemasAreMetaValid).toBe('function');
  });

  it('keeps built-in schemas valid against the Zod meta-schema', () => {
    expect(() => assertBuiltinSchemasAreMetaValid()).not.toThrow();
  });

  it('validates entity instances from a pinned schema revision payload', () => {
    const strain = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === 'strain');
    expect(strain).toBeTruthy();
    const fieldsJson = limsSchemaFieldsJson(strain!);

    expect(validateEntityInstanceFromFieldsJson('strain', {}, fieldsJson)).toEqual([
      'genotypeCanonical is required',
    ]);
    expect(
      validateEntityInstanceFromFieldsJson(
        'strain',
        { genotypeCanonical: 'leu2 ura3 his3' },
        fieldsJson
      )
    ).toEqual([]);
  });
});
