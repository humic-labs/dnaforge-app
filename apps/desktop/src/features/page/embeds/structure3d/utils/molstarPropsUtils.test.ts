import { describe, it, expect } from 'vitest';
import { getMolstarPropsFromAttrs } from './molstarPropsUtils';

describe('getMolstarPropsFromAttrs', () => {
  describe('PDB source', () => {
    it('returns pdbId from sourceId', () => {
      const result = getMolstarPropsFromAttrs('pdb', { sourceId: '1ABC' });
      expect(result).toEqual({
        pdbId: '1ABC',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:1ABC:ENTRY',
          pdbId: '1ABC',
        },
      });
    });

    it('falls back to pdbId field if sourceId is empty', () => {
      const result = getMolstarPropsFromAttrs('pdb', { pdbId: '2XYZ' });
      expect(result).toEqual({
        pdbId: '2XYZ',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:2XYZ:ENTRY',
          pdbId: '2XYZ',
        },
      });
    });

    it('prefers sourceId over pdbId', () => {
      const result = getMolstarPropsFromAttrs('pdb', { sourceId: '1ABC', pdbId: '2XYZ' });
      expect(result).toEqual({
        pdbId: '1ABC',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:1ABC:ENTRY',
          pdbId: '1ABC',
        },
      });
    });

    it('carries scoped RCSB identity into Molstar structure fetch props', () => {
      const result = getMolstarPropsFromAttrs('pdb', {
        sourceId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
        providerIdentityKey: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
        pdbId: '1RBL',
        labelAsymIds: ['A', 'B'],
      });
      expect(result).toEqual({
        pdbId: '1RBL',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:1RBL:ENTRY:LABEL_ASYM:A,B',
          pdbId: '1RBL',
          labelAsymIds: ['A', 'B'],
        },
      });
    });

    it('preserves scoped RCSB sourceId when providerIdentityKey and duplicated scope fields are absent', () => {
      const result = getMolstarPropsFromAttrs('pdb', {
        sourceId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:a',
      });
      expect(result).toEqual({
        pdbId: '1RBL',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:1RBL:ENTRY:AUTH_ASYM:a',
          pdbId: '1RBL',
          authAsymIds: ['a'],
        },
      });
    });

    it('loads the full PDB entry for complex scenes while leaving query scope in the scene model', () => {
      const result = getMolstarPropsFromAttrs('pdb', {
        sourceId: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
        providerIdentityKey: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
        pdbId: '1FS0',
        authAsymIds: ['G'],
        scene: {
          schemaVersion: 1,
          sceneId: 'scene:1fs0',
          sceneKind: 'complex',
          primaryResourceId: 'RCSB:1FS0:ENTRY',
          queryAnchor: {
            memberId: 'member:query',
            targetSelection: { pdbId: '1FS0', authAsymIds: ['G'] },
          },
          activeFocus: {
            memberId: 'member:query',
            role: 'query_anchor',
            mappingStatus: 'mapped_current_sequence',
            selection: { pdbId: '1FS0', authAsymIds: ['G'] },
          },
          members: [
            {
              memberId: 'member:query',
              kind: 'protein',
              displayName: 'atpG',
              selection: { pdbId: '1FS0', authAsymIds: ['G'] },
              relationToAnchor: 'query',
              mappingStatus: 'mapped_current_sequence',
            },
            {
              memberId: 'member:chain:E',
              kind: 'protein',
              displayName: 'Chain E',
              selection: { pdbId: '1FS0', authAsymIds: ['E'] },
              relationToAnchor: 'known_partner',
              mappingStatus: 'unmapped',
            },
          ],
          layers: [],
          provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
        },
      });

      expect(result).toEqual({
        pdbId: '1FS0',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:1FS0:ENTRY:AUTH_ASYM:G',
          fetchExternalId: 'RCSB:1FS0:ENTRY',
          pdbId: '1FS0',
          authAsymIds: ['G'],
        },
      });
    });

    it('loads the full PDB entry for scoped single-query scenes so the viewer can discover complex members', () => {
      const result = getMolstarPropsFromAttrs('pdb', {
        sourceId: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
        providerIdentityKey: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
        pdbId: '6OQT',
        authAsymIds: ['G'],
        scene: {
          schemaVersion: 1,
          sceneId: 'scene:live-6oqt',
          sceneKind: 'single_query',
          primaryResourceId: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
          queryAnchor: {
            memberId: 'member:atpG',
            targetSelection: { pdbId: '6OQT', authAsymIds: ['G'], chainIds: ['G'] },
          },
          activeFocus: {
            memberId: 'member:atpG',
            role: 'query_anchor',
            mappingStatus: 'mapped_current_sequence',
            selection: { pdbId: '6OQT', authAsymIds: ['G'], chainIds: ['G'] },
          },
          members: [
            {
              memberId: 'member:atpG',
              kind: 'protein',
              displayName: 'atpG',
              selection: { pdbId: '6OQT', authAsymIds: ['G'], chainIds: ['G'] },
              relationToAnchor: 'query',
              mappingStatus: 'mapped_current_sequence',
            },
          ],
          layers: [],
          provenance: { createdBy: 'structure-drawer', provider: 'pdb' },
        },
      });

      expect(result).toEqual({
        pdbId: '6OQT',
        structureIdentity: {
          provider: 'rcsb',
          externalId: 'RCSB:6OQT:ENTRY:AUTH_ASYM:G',
          fetchExternalId: 'RCSB:6OQT:ENTRY',
          pdbId: '6OQT',
          authAsymIds: ['G'],
        },
      });
    });
  });

  describe('AlphaFold source', () => {
    it('returns uniprotId from sourceId', () => {
      const result = getMolstarPropsFromAttrs('alphafold', { sourceId: 'P12345' });
      expect(result).toEqual({
        uniprotId: 'P12345',
        structureIdentity: {
          provider: 'alphafold',
          externalId: 'AF:P12345:F1:LATEST',
          accession: 'P12345',
          fragment: 'F1',
          version: 'LATEST',
        },
      });
    });

    it('falls back to uniprotId field if sourceId is empty', () => {
      const result = getMolstarPropsFromAttrs('alphafold', { uniprotId: 'Q67890' });
      expect(result).toEqual({
        uniprotId: 'Q67890',
        structureIdentity: {
          provider: 'alphafold',
          externalId: 'AF:Q67890:F1:LATEST',
          accession: 'Q67890',
          fragment: 'F1',
          version: 'LATEST',
        },
      });
    });

    it('carries scoped AlphaFold identity into Molstar structure fetch props', () => {
      const result = getMolstarPropsFromAttrs('alphafold', {
        sourceId: 'AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6',
        providerIdentityKey: 'AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6',
        accession: 'A0A0H3JZA8',
        fragment: 'F1',
        version: 'V6',
        modelId: 'AF-A0A0H3JZA8-F1-model_v6',
      });
      expect(result).toEqual({
        uniprotId: 'A0A0H3JZA8',
        structureIdentity: {
          provider: 'alphafold',
          externalId: 'AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6',
          accession: 'A0A0H3JZA8',
          fragment: 'F1',
          version: 'V6',
          modelId: 'AF-A0A0H3JZA8-F1-model_v6',
        },
      });
    });

    it('adds model scope when older attrs have version plus modelId but no scoped provider key', () => {
      const result = getMolstarPropsFromAttrs('alphafold', {
        sourceId: 'AF:A0A0H3JZA8:F1:V6',
        providerIdentityKey: 'AF:A0A0H3JZA8:F1:V6',
        accession: 'A0A0H3JZA8',
        fragment: 'F1',
        version: 'V6',
        modelId: 'AF-A0A0H3JZA8-F1-model_v6',
      });

      expect(result.structureIdentity?.externalId).toBe(
        'AF:A0A0H3JZA8:F1:V6:MODEL:AF-A0A0H3JZA8-F1-model_v6'
      );
    });
  });

  describe('URL source', () => {
    it('returns url from sourceId', () => {
      const result = getMolstarPropsFromAttrs('url', {
        sourceId: 'https://example.com/structure.pdb',
      });
      expect(result).toEqual({ url: 'https://example.com/structure.pdb' });
    });

    it('falls back to url field if sourceId is empty', () => {
      const result = getMolstarPropsFromAttrs('url', { url: 'https://example.com/other.pdb' });
      expect(result).toEqual({ url: 'https://example.com/other.pdb' });
    });
  });

  describe('File source', () => {
    it('returns structureData from sourceId', () => {
      const pdbData = 'ATOM 1 CA ALA A 1...';
      const result = getMolstarPropsFromAttrs('file', { sourceId: pdbData });
      expect(result).toEqual({ structureData: pdbData });
    });
  });

  describe('default/unknown source', () => {
    it('returns pdbId for unknown source types', () => {
      const result = getMolstarPropsFromAttrs('unknown' as any, { sourceId: 'ABC123' });
      expect(result).toEqual({ pdbId: 'ABC123' });
    });
  });
});
