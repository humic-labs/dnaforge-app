// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  LIMS_DEFAULT_ID_SCHEMES,
  LIMS_ENTITY_KINDS,
  limsKindRequiresResolvedSequence,
  normalizeInlineAminoAcidSequenceRef,
  validateAminoAcidSequenceRef,
  validateLimsEntityFields,
  validateProteinSequenceRef,
  type AminoAcidSequenceRef,
  type ProteinSequenceRef,
} from './lims';

describe('protein LIMS entity kind ', () => {
  it('registers "protein" in LIMS_ENTITY_KINDS and its id scheme', () => {
    expect(LIMS_ENTITY_KINDS).toContain('protein');
    expect(LIMS_DEFAULT_ID_SCHEMES.protein).toEqual({ prefix: 'aa', padWidth: 6 });
  });

  it('declares a builtin "protein" entity schema requiring a resolved sequence', () => {
    const schema = LIMS_BUILTIN_ENTITY_SCHEMAS.find((s) => s.name === 'protein');
    expect(schema).toBeDefined();
    expect(schema?.kind).toBe('entity');
    const sequenceField = schema?.fields.find((f) => f.key === 'sequence');
    expect(sequenceField).toMatchObject({
      type: 'protein_sequence',
      required: true,
      requireResolved: true,
    });
    expect(limsKindRequiresResolvedSequence('protein')).toBe(true);
  });
});

describe('validateAminoAcidSequenceRef', () => {
  const field = { key: 'sequence', requireResolved: true };

  it.each(['MU', 'MO'])(
    'accepts recoded protein %s in both inline reference representations',
    (sequence) => {
      expect(
        validateAminoAcidSequenceRef('protein', field, {
          mode: 'inline',
          bases: sequence,
          length: sequence.length,
        })
      ).toBeNull();
      expect(
        validateProteinSequenceRef('protein', field, {
          mode: 'inline',
          aminoAcids: sequence,
          length: sequence.length,
        })
      ).toBeNull();
    }
  );

  it('accepts a valid inline amino-acid sequence', () => {
    const ref: AminoAcidSequenceRef = {
      mode: 'inline',
      bases:
        'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTLTYGVQCFSRYPDHMKQHDFFKSAMPEGYVQERTIFFKDDGNYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK',
      length: 238,
    };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toBeNull();
  });

  it('rejects an invalid amino-acid character', () => {
    const ref: AminoAcidSequenceRef = {
      mode: 'inline',
      bases: 'MSKGEEL1FTGVVPI',
      length: 15,
    };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(/invalid amino/i);
  });

  it('rejects an unresolved sequence when the field requires resolution', () => {
    const ref: AminoAcidSequenceRef = { mode: 'unresolved' };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(/must reference/i);
  });

  it('allows an unresolved sequence when the field does not require resolution', () => {
    const ref: AminoAcidSequenceRef = { mode: 'unresolved' };
    expect(
      validateAminoAcidSequenceRef('protein', { key: 'sequence', requireResolved: false }, ref)
    ).toBeNull();
  });

  it('accepts a valid file-backed amino-acid sequence ref', () => {
    const ref: AminoAcidSequenceRef = {
      mode: 'file',
      relPath: 'proteins/gfp.faa',
      length: 238,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toBeNull();
  });

  it('accepts the absolute artifact path used by existing protein records', () => {
    const ref: AminoAcidSequenceRef = {
      mode: 'file',
      relPath: '/workspace/proteins/GFP-abc12345.faa',
      length: 238,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    };

    expect(validateAminoAcidSequenceRef('protein', field, ref)).toBeNull();
  });

  it('rejects a file-backed ref missing relPath', () => {
    const ref = {
      mode: 'file',
      length: 238,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    } as unknown as AminoAcidSequenceRef;
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(/relPath/);
  });

  it('rejects a non-object value', () => {
    expect(validateAminoAcidSequenceRef('protein', field, null)).toMatch(
      /must be a protein_sequence reference/
    );
    expect(validateAminoAcidSequenceRef('protein', field, 'not-an-object')).toMatch(
      /must be a protein_sequence reference/
    );
  });

  it('rejects an inline ref whose bases is not a string', () => {
    const ref = { mode: 'inline', bases: 123, length: 3 } as unknown as AminoAcidSequenceRef;
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(/bases must be a string/);
  });

  it('rejects an inline ref whose length does not match the cleaned bases length', () => {
    const ref: AminoAcidSequenceRef = { mode: 'inline', bases: 'MSK', length: 99 };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(
      /length must match bases length/
    );
  });

  it('rejects an inline ref exceeding maxLength', () => {
    const ref: AminoAcidSequenceRef = { mode: 'inline', bases: 'MSKGEEL', length: 7 };
    expect(validateAminoAcidSequenceRef('protein', { key: 'sequence', maxLength: 5 }, ref)).toMatch(
      /exceeds 5 residues/
    );
  });

  it('rejects a file ref with a negative length', () => {
    const ref: AminoAcidSequenceRef = {
      mode: 'file',
      relPath: 'proteins/gfp.faa',
      length: -1,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(/length is invalid/);
  });

  it('rejects a file ref with a malformed fileContentHash', () => {
    const ref: AminoAcidSequenceRef = {
      mode: 'file',
      relPath: 'proteins/gfp.faa',
      length: 238,
      contentHash: `sha256:${'a'.repeat(64)}`,
      fileContentHash: 'not-a-real-hash',
      sourceFormat: 'fasta',
    };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(
      /fileContentHash must be a sha256 or git object hash/
    );
  });

  it('rejects a file ref with a malformed normalizedSequenceHash', () => {
    const ref: AminoAcidSequenceRef = {
      mode: 'file',
      relPath: 'proteins/gfp.faa',
      length: 238,
      contentHash: `sha256:${'a'.repeat(64)}`,
      normalizedSequenceHash: 'not-a-sha256-hash',
      sourceFormat: 'fasta',
    };
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(
      /normalizedSequenceHash must be a sha256 hash/
    );
  });

  it('rejects an unrecognized ref.mode', () => {
    const ref = { mode: 'bogus' } as unknown as AminoAcidSequenceRef;
    expect(validateAminoAcidSequenceRef('protein', field, ref)).toMatch(
      /mode must be inline, file, or unresolved/
    );
  });
});

describe('normalizeInlineAminoAcidSequenceRef', () => {
  it('uppercases and strips whitespace, computing length', () => {
    const ref = normalizeInlineAminoAcidSequenceRef('msk gee\nlft');
    expect(ref).toEqual({ mode: 'inline', bases: 'MSKGEELFT', length: 9 });
  });
});

describe('validateProteinSequenceRef', () => {
  it('accepts unknown residues and stop markers like the legacy protein shape', () => {
    const ref: ProteinSequenceRef = {
      mode: 'inline',
      aminoAcids: 'MXX*',
      length: 4,
    };

    expect(validateProteinSequenceRef('protein', { key: 'sequence' }, ref)).toBeNull();
  });

  it('dispatches explicitly portable file refs to the strict path validator', () => {
    const field = { key: 'sequence', label: 'Sequence', type: 'protein_sequence' } as const;
    const portable: ProteinSequenceRef = {
      mode: 'file',
      representation: 'portable',
      relPath: 'Benchling Imports/proteins/GFP.faa',
      length: 238,
      contentHash: `sha256:${'a'.repeat(64)}`,
      sourceFormat: 'fasta',
    };

    expect(validateLimsEntityFields('protein', { sequence: portable }, [field])).toEqual([]);
    expect(
      validateLimsEntityFields(
        'protein',
        { sequence: { ...portable, relPath: '/workspace/proteins/GFP.faa' } },
        [field]
      )
    ).toEqual(['sequence.relPath must be a safe workspace-relative path']);
  });
});
