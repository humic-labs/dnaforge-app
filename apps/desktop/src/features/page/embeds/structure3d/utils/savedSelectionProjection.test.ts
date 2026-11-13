// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { SavedSelectionStructureRevision } from '@waypoint/workspace-editor';
import type { ChainSequence, HighlightGroup, Structure3dAttrs } from '../types';
import {
  buildSavedSelectionDocumentFromStructure,
  projectSavedSelectionRevisionToHighlightGroup,
} from './savedSelectionProjection';

const CHAIN: ChainSequence = {
  chainId: 'A',
  chainLabel: 'Chain A',
  sequence: 'ACDEFGHIKLMNPQRSTVWYACDE',
  baseChain: 'A',
  labelAsymId: 'A',
  authAsymId: 'H',
  entityId: '1',
  operator: 'ASM_1',
  residues: [...'ACDEFGHIKLMNPQRSTVWYACDE'].map((name, index) => ({
    position: 86 + index,
    sequenceIndex: index,
    labelSeqId: index + 1,
    name,
    name3: 'ALA',
  })),
};

const ATTRS: Structure3dAttrs = {
  source: 'pdb',
  sourceId: '3OAA',
  providerIdentityKey: 'RCSB:3OAA:ENTRY:ASSEMBLY:1',
  assemblyId: '1',
  scene: {
    schemaVersion: 1,
    sceneId: 'scene-1',
    sceneKind: 'single_query',
    primaryResourceId: 'RCSB:3OAA:ENTRY:ASSEMBLY:1',
    queryAnchor: {
      memberId: 'query',
      sourceEntityId: 'plasmid-asset-1',
      sourceWorkspaceRoot: '/lab',
      targetSelection: { labelAsymIds: ['A'] },
      proteinIdentity: {
        schemaVersion: 2,
        sequence: {
          kind: 'protein_sequence',
          schemaVersion: 2,
          identityKey: 'protein-sequence:v2:abc123',
          canonicalizationStatus: 'sidecar_confirmed',
          lookupSequence: CHAIN.sequence,
          canonicalLookupSequence: CHAIN.sequence,
          length: CHAIN.sequence.length,
          source: 'derived_cds',
          startCodon: 'ATG',
          initiatorNormalized: false,
          translationConfig: { geneticCode: 11, frame: 0 },
          digests: { sha256: 'abc123' },
          evidenceIds: [],
        },
        feature: {
          kind: 'sequence_feature',
          entityId: 'plasmid-asset-1',
          featureKey: 'CDS:bpsA',
          label: 'bpsA CDS',
          location: {
            segments: [{ start0: 100, end0: 172, strand: 1 }],
            circular: true,
          },
          hintSummary: {
            dbXrefCount: 0,
            hasProteinId: false,
            hasLocusTag: true,
            hasGeneName: true,
          },
          evidenceIds: [],
        },
        externalProteins: [],
        resolutionSets: [],
        structures: [],
        evidence: [],
      },
    },
    members: [],
    layers: [],
    provenance: { createdBy: 'structure-drawer' },
  },
};

const GROUP: HighlightGroup = {
  id: 'legacy-runtime-id',
  label: 'Catalytic and gate residues',
  color: '#ef4444',
  visible: false,
  selections: [
    {
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'H',
      entityId: '1',
      operator: 'ASM_1',
      ranges: [
        [86, 90],
        [109, 109],
      ],
    },
  ],
};

const STRUCTURE_REVISION: SavedSelectionStructureRevision = {
  id: 'structure-revision-1',
  structureId: 'structure:3OAA',
  providerIdentityKey: 'RCSB:3OAA:ENTRY:ASSEMBLY:1',
  coordinateDigestSha256: 'coordinates123',
  assemblyId: '1',
  sourceArtifact: {
    entityId: 'structure-asset-1',
    path: 'Structures/3OAA.structure-asset-1.cif',
    gitCommit: '0123456789abcdef',
  },
};

describe('saved selection structure projection', () => {
  it('converts author-numbered disjoint physical-chain ranges to canonical polymer intervals', async () => {
    const document = await buildSavedSelectionDocumentFromStructure({
      assetId: 'selection-asset-1',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      group: GROUP,
      attrs: ATTRS,
      chains: [CHAIN],
      structureId: 'structure:3OAA',
      structureRevision: STRUCTURE_REVISION,
      sourceArtifactGitCommit: 'fedcba9876543210',
    });

    expect(document.currentRevisionId).toBe('selection-revision-1');
    expect(document.revisions[0].members).toHaveLength(1);
    expect(document.revisions[0].members[0]).toMatchObject({
      scope: {
        kind: 'structure-chain-instance',
        structureRevisionId: 'structure-revision-1',
        chain: { chain: 'A', labelAsymId: 'A', authAsymId: 'H', operator: 'ASM_1' },
      },
      polymerRevision: {
        moleculeId: 'protein-sequence:v2:abc123',
        sequenceDigestSha256: 'abc123',
        sourceArtifact: {
          entityId: 'plasmid-asset-1',
          gitCommit: 'fedcba9876543210',
        },
        translation: { featureId: 'CDS:bpsA', strand: 1, geneticCode: 11, frame: 0 },
      },
    });
    expect(document.revisions[0].members[0].selection.target.intervals).toEqual([
      { start: 0, end: 4 },
      { start: 23, end: 23 },
    ]);
    expect(document.revisions[0].members[0].selection.mappings).toEqual([
      expect.objectContaining({ kind: 'structure', residueStart: 86, residueEnd: 90 }),
      expect.objectContaining({ kind: 'structure', residueStart: 109, residueEnd: 109 }),
    ]);
    expect(document.revisions[0].members[0].residueIdentities).toEqual([
      { polymerIndex: 0, authSeqId: 86, labelSeqId: 1, labelCompId: 'ALA', oneLetterCode: 'A' },
      { polymerIndex: 1, authSeqId: 87, labelSeqId: 2, labelCompId: 'ALA', oneLetterCode: 'C' },
      { polymerIndex: 2, authSeqId: 88, labelSeqId: 3, labelCompId: 'ALA', oneLetterCode: 'D' },
      { polymerIndex: 3, authSeqId: 89, labelSeqId: 4, labelCompId: 'ALA', oneLetterCode: 'E' },
      { polymerIndex: 4, authSeqId: 90, labelSeqId: 5, labelCompId: 'ALA', oneLetterCode: 'F' },
      { polymerIndex: 23, authSeqId: 109, labelSeqId: 24, labelCompId: 'ALA', oneLetterCode: 'E' },
    ]);
  });

  it('derives a viewer-only HighlightGroup projection from a pinned revision', async () => {
    const document = await buildSavedSelectionDocumentFromStructure({
      assetId: 'selection-asset-1',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      group: GROUP,
      attrs: ATTRS,
      chains: [CHAIN],
      structureId: 'structure:3OAA',
      structureRevision: STRUCTURE_REVISION,
    });

    expect(
      projectSavedSelectionRevisionToHighlightGroup(document, 'selection-revision-1', true)
    ).toEqual({
      id: 'selection-asset-1',
      label: 'Catalytic and gate residues',
      color: '#22c55e',
      renderMode: 'annotation',
      visible: true,
      residueLocations: [
        {
          chain: 'A',
          position: 86,
          labelSeqId: 1,
          labelCompId: 'ALA',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          operator: 'ASM_1',
        },
        {
          chain: 'A',
          position: 87,
          labelSeqId: 2,
          labelCompId: 'ALA',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          operator: 'ASM_1',
        },
        {
          chain: 'A',
          position: 88,
          labelSeqId: 3,
          labelCompId: 'ALA',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          operator: 'ASM_1',
        },
        {
          chain: 'A',
          position: 89,
          labelSeqId: 4,
          labelCompId: 'ALA',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          operator: 'ASM_1',
        },
        {
          chain: 'A',
          position: 90,
          labelSeqId: 5,
          labelCompId: 'ALA',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          operator: 'ASM_1',
        },
        {
          chain: 'A',
          position: 109,
          labelSeqId: 24,
          labelCompId: 'ALA',
          baseChain: 'A',
          labelAsymId: 'A',
          authAsymId: 'H',
          entityId: '1',
          operator: 'ASM_1',
        },
      ],
      selections: GROUP.selections,
    });
  });

  it('fails instead of fabricating a continuous range when an author residue is unmapped', async () => {
    await expect(
      buildSavedSelectionDocumentFromStructure({
        assetId: 'selection-asset-1',
        revisionId: 'selection-revision-1',
        createdAt: '2026-07-14T12:00:00.000Z',
        group: { ...GROUP, selections: [{ ...GROUP.selections[0], ranges: [[80, 90]] }] },
        attrs: ATTRS,
        chains: [CHAIN],
        structureId: 'structure:3OAA',
        structureRevision: STRUCTURE_REVISION,
      })
    ).rejects.toThrow(/cannot map author residue 80/i);
  });
});
