// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { SavedSelectionStructureRevision } from '@waypoint/workspace-editor';
import type { ChainSequence, HighlightGroup, Structure3dAttrs } from '../types';
import {
  buildSavedSelectionDocumentFromStructure,
  savedSelectionMoleculeKind,
} from './savedSelectionProjection';

const DNA_CODES = 'CGCGAATTCGCG';
const DNA_COMP_IDS = ['DC', 'DG', 'DC', 'DG', 'DA', 'DA', 'DT', 'DT', 'DC', 'DG', 'DC', 'DG'];

const DNA_CHAIN: ChainSequence = {
  chainId: 'A',
  chainLabel: 'Chain A',
  sequence: DNA_CODES,
  polymerType: 'dna',
  baseChain: 'A',
  labelAsymId: 'A',
  authAsymId: 'A',
  entityId: '1',
  residues: [...DNA_CODES].map((name, index) => ({
    position: index + 1,
    sequenceIndex: index,
    labelSeqId: index + 1,
    name,
    displayLabel: `d${name}`,
    name3: DNA_COMP_IDS[index],
  })),
};

const ATTRS: Structure3dAttrs = {
  source: 'file',
  sourceId: '1BNA',
  providerIdentityKey: 'FILE:1BNA',
};

const GROUP: HighlightGroup = {
  id: 'saved-dna-selection',
  label: 'Central AATT',
  color: '#22c55e',
  visible: true,
  selections: [{ chain: 'A', labelAsymId: 'A', authAsymId: 'A', ranges: [[5, 8]] }],
};

const STRUCTURE_REVISION: SavedSelectionStructureRevision = {
  id: 'structure-revision-1',
  structureId: 'structure:1BNA',
  providerIdentityKey: 'FILE:1BNA',
  coordinateDigestSha256: 'coordinates123',
};

function buildDocument(chain: ChainSequence) {
  return buildSavedSelectionDocumentFromStructure({
    assetId: 'selection-asset-1',
    revisionId: 'selection-revision-1',
    createdAt: '2026-08-07T12:00:00.000Z',
    group: GROUP,
    attrs: ATTRS,
    chains: [chain],
    structureId: 'structure:1BNA',
    structureRevision: STRUCTURE_REVISION,
  });
}

describe('saved selection projection — nucleic-acid chains', () => {
  it('saves a DNA chain selection instead of throwing', async () => {
    await expect(buildDocument(DNA_CHAIN)).resolves.toBeDefined();
  });

  it('records one-letter codes, not display labels, in the durable artifact', async () => {
    const document = await buildDocument(DNA_CHAIN);
    const identities = document.revisions[0].members[0].residueIdentities;

    expect(identities.map((identity) => identity.oneLetterCode)).toEqual(['A', 'A', 'T', 'T']);
    expect(identities.map((identity) => identity.labelCompId)).toEqual(['DA', 'DA', 'DT', 'DT']);
  });

  it('records the molecule as DNA rather than claiming it is a protein', async () => {
    const document = await buildDocument(DNA_CHAIN);
    const polymer = document.revisions[0].members[0].polymerRevision;

    expect(polymer.moleculeKind).toBe('dna');
    expect(polymer.moleculeId.startsWith('dna-sequence:sha256:')).toBe(true);
  });

  it('digests the valid one-letter sequence, so the same DNA hashes the same everywhere', async () => {
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(DNA_CODES).digest('hex');

    const document = await buildDocument(DNA_CHAIN);
    const polymer = document.revisions[0].members[0].polymerRevision;

    expect(polymer.sequenceDigestSha256).toBe(expected);
  });

  it('still records an unanchored protein chain exactly as before', async () => {
    expect(savedSelectionMoleculeKind('protein')).toBe('protein');
    expect(savedSelectionMoleculeKind(undefined)).toBe('protein');
    expect(savedSelectionMoleculeKind('unknown')).toBe('protein');
  });

  it('preserves pre- durable identities for RNA and chimeric strands', () => {
    expect(savedSelectionMoleculeKind('rna')).toBe('protein');
    expect(savedSelectionMoleculeKind('mixed')).toBe('protein');
  });
});
