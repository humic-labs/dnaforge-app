// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  LIMS_DEFAULT_ID_SCHEMES,
  LIMS_ENTITY_KINDS,
  limsKindRequiresResolvedSequence,
  validateLimsEntityFields,
} from './lims';

describe('generic molecular sequence LIMS primitives', () => {
  it.each(['dna_sequence', 'rna_sequence'] as const)(
    'retains a circular accepted %s reference and rejects an incomplete pin without changing the legacy shape',
    (kind) => {
      const fields = requiredFields(kind);
      const legacy = {
        mode: 'file',
        relPath: '/workspace/source.gb',
        topology: 'circular',
        length: 4,
        contentHash: `sha256:${'a'.repeat(64)}`,
        sourceFormat: 'genbank',
      };
      const accepted = {
        ...legacy,
        documentId: 'source',
        workspaceId: 7,
        acceptedRevisionId: `rr_${'b'.repeat(64)}`,
      };
      expect(validateLimsEntityFields(kind, { sequence: legacy }, fields)).toEqual([]);
      expect(legacy).not.toHaveProperty('acceptedRevisionId');
      expect(validateLimsEntityFields(kind, { sequence: accepted }, fields)).toEqual([]);
      expect(
        validateLimsEntityFields(
          kind,
          { sequence: { ...accepted, acceptedRevisionId: 'latest' } },
          fields
        )
      ).toEqual(['sequence.acceptedRevisionId must identify an accepted resource revision']);
      expect(
        validateLimsEntityFields(kind, { sequence: { ...accepted, workspaceId: null } }, fields)
      ).toEqual(['sequence.workspaceId must identify its accepted workspace']);
      expect(
        validateLimsEntityFields(kind, { sequence: { ...accepted, documentId: '' } }, fields)
      ).toEqual(['sequence.documentId must identify its accepted sequence']);
    }
  );
  it.each([
    ['dna_sequence', 'dna', 'dna_sequence'],
    ['rna_sequence', 'rna', 'rna_sequence'],
  ] as const)('defines %s as a resolved file-backed molecule', (kind, prefix, fieldType) => {
    expect(LIMS_ENTITY_KINDS).toContain(kind);
    expect(LIMS_DEFAULT_ID_SCHEMES[kind]).toEqual({ prefix, padWidth: 6 });
    const schema = LIMS_BUILTIN_ENTITY_SCHEMAS.find((entry) => entry.name === kind);
    expect(schema?.fields.find((field) => field.key === 'sequence')).toMatchObject({
      type: fieldType,
      required: true,
      requireResolved: true,
    });
    expect(limsKindRequiresResolvedSequence(kind)).toBe(true);
  });

  it('accepts a generic file-backed DNA molecule without inventing a specialized role', () => {
    const fields = requiredFields('dna_sequence');
    expect(
      validateLimsEntityFields(
        'dna_sequence',
        {
          sequence: {
            mode: 'file',
            relPath: '/workspace/imports/example.gb',
            topology: 'linear',
            length: 4,
            contentHash: `sha256:${'a'.repeat(64)}`,
            sourceFormat: 'genbank',
          },
        },
        fields
      )
    ).toEqual([]);
  });

  it('accepts a generic file-backed RNA molecule without claiming guide-RNA semantics', () => {
    const fields = requiredFields('rna_sequence');
    expect(
      validateLimsEntityFields(
        'rna_sequence',
        {
          sequence: {
            mode: 'file',
            relPath: '/workspace/imports/example.gb',
            topology: 'linear',
            length: 4,
            contentHash: `sha256:${'b'.repeat(64)}`,
            sourceFormat: 'genbank',
          },
        },
        fields
      )
    ).toEqual([]);
  });

  it.each(['dna_sequence', 'rna_sequence'] as const)(
    'rejects unsafe portable %s file references while preserving resolved live refs',
    (kind) => {
      const fields = requiredFields(kind);
      const sequence = {
        mode: 'file',
        pathBase: 'workspace',
        relPath: '../outside.gb',
        topology: 'linear',
        length: 4,
        contentHash: `sha256:${'c'.repeat(64)}`,
        sourceFormat: 'genbank',
      };

      expect(validateLimsEntityFields(kind, { sequence }, fields)).toEqual([
        'sequence.relPath must be a safe workspace-relative path',
      ]);
      expect(
        validateLimsEntityFields(
          kind,
          {
            sequence: {
              ...sequence,
              pathBase: undefined,
              relPath: '/workspace/imports/example.gb',
            },
          },
          fields
        )
      ).toEqual([]);
    }
  );

  it.each(['dna_sequence', 'rna_sequence'] as const)(
    'rejects unresolved relative live %s file references',
    (kind) => {
      const fields = requiredFields(kind);
      expect(
        validateLimsEntityFields(
          kind,
          {
            sequence: {
              mode: 'file',
              relPath: '../outside.gb',
              topology: 'linear',
              length: 4,
              contentHash: `sha256:${'e'.repeat(64)}`,
              sourceFormat: 'genbank',
            },
          },
          fields
        )
      ).toEqual(['sequence.relPath must be a resolved absolute path']);
    }
  );

  it.each(['dna_sequence', 'rna_sequence'] as const)(
    'rejects a fractional %s file length',
    (kind) => {
      const fields = requiredFields(kind);
      expect(
        validateLimsEntityFields(
          kind,
          {
            sequence: {
              mode: 'file',
              relPath: '/workspace/imports/example.gb',
              topology: 'linear',
              length: 4.5,
              contentHash: `sha256:${'d'.repeat(64)}`,
              sourceFormat: 'genbank',
            },
          },
          fields
        )
      ).toEqual(['sequence.length is invalid']);
    }
  );
});

function requiredFields(kind: 'dna_sequence' | 'rna_sequence') {
  const schema = LIMS_BUILTIN_ENTITY_SCHEMAS.find((entry) => entry.name === kind);
  if (!schema) throw new Error(`Missing builtin ${kind} schema.`);
  return schema.fields;
}
