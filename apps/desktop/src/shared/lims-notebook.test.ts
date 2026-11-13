// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  LIMS_DEFAULT_ID_SCHEMES,
  LIMS_ENTITY_KINDS,
  limsKindRequiresResolvedSequence,
  validateLimsEntityFields,
} from './lims';

describe('notebook LIMS entity kind ', () => {
  it('registers notebook in LIMS_ENTITY_KINDS and its id scheme', () => {
    expect(LIMS_ENTITY_KINDS).toContain('notebook');
    expect(LIMS_DEFAULT_ID_SCHEMES.notebook).toEqual({ prefix: 'nb', padWidth: 6 });
  });

  it('declares a builtin notebook schema with no required sequence', () => {
    const schema = LIMS_BUILTIN_ENTITY_SCHEMAS.find((entry) => entry.name === 'notebook');
    expect(schema).toBeDefined();
    expect(schema?.kind).toBe('entity');
    expect(schema?.displayName).toBe('Notebook entry');
    expect(schema?.fields.some((field) => field.type === 'dna_sequence')).toBe(false);
    expect(limsKindRequiresResolvedSequence('notebook')).toBe(false);
    expect(
      validateLimsEntityFields('notebook', { packagePath: '/lab/Miniprep' }, schema!.fields)
    ).toEqual([]);
  });
});
