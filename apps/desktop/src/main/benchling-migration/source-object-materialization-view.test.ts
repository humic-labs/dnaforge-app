import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SourceObject } from '../../shared/benchling-migration';
import {
  nativeSequenceMaterializationFacts,
  sourceObjectMaterializationView,
} from './source-object-materialization-view';

function sourceObject(overrides: Partial<SourceObject> = {}): SourceObject {
  return {
    id: 'seq_large',
    stableId: 'seq_large',
    sourceType: 'dna_sequence',
    name: 'Large sequence',
    aliases: [],
    sourceUrl: 'https://benchling.example/seq_large',
    attachmentHashes: [],
    memberships: ['folder-1'],
    metadata: {},
    content: {},
    relationships: [],
    ...overrides,
  };
}

describe('sourceObjectMaterializationView', () => {
  it('replaces nucleotide bases with the exact facts needed by native LIMS materialization', () => {
    const bases = 'acgt'.repeat(1_250_000);
    const view = sourceObjectMaterializationView(
      sourceObject({
        content: {
          kind: 'dna_sequence',
          bases,
          topology: 'circular',
          annotations: [{ label: 'large' }],
        },
      })
    );

    expect(view.content).not.toHaveProperty('bases');
    expect(view.content).not.toHaveProperty('annotations');
    expect(nativeSequenceMaterializationFacts(view.content)).toEqual({
      kind: 'nucleotide',
      length: bases.length,
      normalizedSequenceHash: `sha256:${createHash('sha256').update(bases.toUpperCase()).digest('hex')}`,
      topology: 'circular',
    });
    expect(JSON.stringify(view).length).toBeLessThan(1_000);
  });

  it('replaces amino acids with their exact native materialization facts', () => {
    const aminoAcids = 'MKT'.repeat(100_000);
    const view = sourceObjectMaterializationView(
      sourceObject({
        id: 'prtn_large',
        stableId: 'prtn_large',
        sourceType: 'protein',
        content: { aminoAcids },
      })
    );

    expect(view.content).not.toHaveProperty('aminoAcids');
    expect(nativeSequenceMaterializationFacts(view.content)).toEqual({
      kind: 'protein',
      length: aminoAcids.length,
      normalizedSequenceHash: `sha256:${createHash('sha256').update(aminoAcids).digest('hex')}`,
    });
  });

  it('preserves native strain and needs-sequence content verbatim', () => {
    const strainContent = {
      kind: 'benchling_strain',
      displayName: 'Strain one',
      fields: [{ label: 'Organism', value: 'E. coli', position: 0 }],
    };
    const needsSequenceContent = {
      kind: 'dna_sequence_needs_sequence',
      moleculeType: 'DNA',
      bases: '',
      annotations: [],
      genbankMetadata: { sourceFields: [] },
    };

    expect(
      sourceObjectMaterializationView(
        sourceObject({ sourceType: 'strain', content: strainContent })
      ).content
    ).toEqual(strainContent);
    expect(
      sourceObjectMaterializationView(sourceObject({ content: needsSequenceContent })).content
    ).toEqual(needsSequenceContent);
  });

  it('drops notebook bodies while preserving invalid strain content for fail-closed checks', () => {
    const notebook = sourceObjectMaterializationView(
      sourceObject({
        id: 'etr_large',
        stableId: 'etr_large',
        sourceType: 'notebook_entry',
        content: { html: '<p>large</p>'.repeat(100_000) },
      })
    );
    const invalidStrain = sourceObjectMaterializationView(
      sourceObject({ sourceType: 'strain', content: 'invalid' })
    );

    expect(notebook.content).toEqual({});
    expect(invalidStrain.content).toBe('invalid');
  });
});
