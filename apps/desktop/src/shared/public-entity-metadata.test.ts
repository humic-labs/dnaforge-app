import { describe, expect, it } from 'vitest';
import { LIMS_BUILTIN_ENTITY_SCHEMAS } from './lims';
import { publicEntitySchemaFields } from './public-entity-metadata';

describe('public metadata for native document kinds', () => {
  it.each(['notebook', 'track-view', 'molecular-document'])(
    'excludes native locators and fingerprints from %s',
    (kind) => {
      const builtin = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === kind)!;
      const fields = publicEntitySchemaFields(
        {
          schemaId: 'schema',
          schemaRevisionId: 'revision',
          name: kind,
          displayName: builtin.displayName,
          baseKind: kind,
          fields: [...builtin.fields],
          version: 1,
        },
        kind
      );
      expect(fields.map((field) => field.key)).not.toEqual(
        expect.arrayContaining(['artifactFingerprint'])
      );
      expect(
        fields.some((field) =>
          ['packagePath', 'currentReferenceId', 'referenceAssemblyId'].includes(field.key)
        )
      ).toBe(false);
      expect(fields.length).toBeGreaterThan(0);
    }
  );
});
