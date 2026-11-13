// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';
import {
  structureLinkRegistryKey,
  useStructureLinkRegistry,
  type StructureLinkEntry,
} from './use-structure-link-registry';

const ENTRY_A: StructureLinkEntry = {
  structureId: 'drawer-alphafold-P0AD86',
  sequenceDocumentId: '/tmp/genome-A.gb',
  cdsLabel: 'thrL',
  translation: 'MKRISTTITTTITITTGNGAG',
  cdsStart: 100,
  cdsEnd: 162,
  strand: 1,
};

const ENTRY_B: StructureLinkEntry = {
  structureId: 'drawer-alphafold-P00533',
  sequenceDocumentId: '/tmp/genome-B.gb',
  cdsLabel: 'EGFR',
  translation: 'MRPS',
  cdsStart: 200,
  cdsEnd: 211,
  strand: 1,
};

function reset() {
  useStructureLinkRegistry.setState({ links: {} });
}

describe('useStructureLinkRegistry — registration', () => {
  beforeEach(reset);

  it('registerLink adds the entry; getLinksBySequenceDocument finds it', () => {
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    expect(useStructureLinkRegistry.getState().links[ENTRY_A.structureId]).toEqual(ENTRY_A);
    expect(
      useStructureLinkRegistry.getState().getLinksBySequenceDocument(ENTRY_A.sequenceDocumentId)
    ).toEqual([ENTRY_A]);
  });

  it('registerLink overwrites the same structureId', () => {
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    const updated = { ...ENTRY_A, cdsLabel: 'thrL_v2' };
    useStructureLinkRegistry.getState().registerLink(updated);
    expect(useStructureLinkRegistry.getState().links[ENTRY_A.structureId].cdsLabel).toBe('thrL_v2');
  });

  it('multiple links for different structures coexist', () => {
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    useStructureLinkRegistry.getState().registerLink(ENTRY_B);
    expect(Object.keys(useStructureLinkRegistry.getState().links)).toHaveLength(2);
  });

  it('registerLink bails out when re-registering an identical entry (no ref churn)', () => {
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    const linksBefore = useStructureLinkRegistry.getState().links;
    const entryBefore = linksBefore[ENTRY_A.structureId];

    useStructureLinkRegistry.getState().registerLink({ ...ENTRY_A });

    const linksAfter = useStructureLinkRegistry.getState().links;
    expect(linksAfter).toBe(linksBefore);
    expect(linksAfter[ENTRY_A.structureId]).toBe(entryBefore);
  });

  it('registerLink updates state when ANY field differs (cdsLabel changed)', () => {
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    const linksBefore = useStructureLinkRegistry.getState().links;

    useStructureLinkRegistry.getState().registerLink({ ...ENTRY_A, cdsLabel: 'thrL_v2' });
    const linksAfter = useStructureLinkRegistry.getState().links;

    expect(linksAfter).not.toBe(linksBefore);
    expect(linksAfter[ENTRY_A.structureId].cdsLabel).toBe('thrL_v2');
  });

  it('getLinksBySequenceDocument returns multiple entries for a single file with multiple linked CDSes', () => {
    const sameFile = { ...ENTRY_B, sequenceDocumentId: ENTRY_A.sequenceDocumentId };
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    useStructureLinkRegistry.getState().registerLink(sameFile);
    const links = useStructureLinkRegistry
      .getState()
      .getLinksBySequenceDocument(ENTRY_A.sequenceDocumentId);
    expect(links).toHaveLength(2);
  });

  it('keeps two biological owners for the same structureId from overwriting each other', () => {
    const sharedStructureId = 'structure:rcsb:RCSB:8QX8:ENTRY:all';
    const ownerA = {
      ...ENTRY_A,
      structureId: sharedStructureId,
      ownerId: 'translated-cds:/tmp/genome.gb:atpG:100-999:1',
      sequenceDocumentId: '/tmp/genome.gb',
      cdsLabel: 'atpG',
      cdsFeatureId: 'atpG',
      residueTargets: [{ chain: 'F', residues: [{ residueIndex: 2, position: 67 }] }],
    };
    const ownerB = {
      ...ENTRY_B,
      structureId: sharedStructureId,
      ownerId: 'translated-cds:/tmp/genome.gb:atpE:2000-2200:1',
      sequenceDocumentId: '/tmp/genome.gb',
      cdsLabel: 'atpE',
      cdsFeatureId: 'atpE',
      residueTargets: [{ chain: 'I', residues: [{ residueIndex: 2, position: 3 }] }],
    };

    useStructureLinkRegistry.getState().registerLink(ownerA);
    useStructureLinkRegistry.getState().registerLink(ownerB);

    expect(useStructureLinkRegistry.getState().getLink(sharedStructureId, ownerA.ownerId)).toEqual(
      ownerA
    );
    expect(useStructureLinkRegistry.getState().getLink(sharedStructureId, ownerB.ownerId)).toEqual(
      ownerB
    );
    expect(
      useStructureLinkRegistry.getState().links[
        structureLinkRegistryKey(sharedStructureId, ownerA.ownerId)
      ]
    ).toEqual(ownerA);
    expect(
      useStructureLinkRegistry.getState().links[
        structureLinkRegistryKey(sharedStructureId, ownerB.ownerId)
      ]
    ).toEqual(ownerB);
    expect(
      useStructureLinkRegistry.getState().getLinksBySequenceDocument('/tmp/genome.gb')
    ).toHaveLength(2);
  });

  it('does not expose owner-scoped links through the bare structure id alias', () => {
    const sharedStructureId = 'structure:rcsb:RCSB:6OQR:ENTRY:all';
    const ownerA = {
      ...ENTRY_A,
      structureId: sharedStructureId,
      ownerId: 'translated-cds:/tmp/genome.gb:atpD:100-999:1',
      sequenceDocumentId: '/tmp/genome.gb',
      cdsLabel: 'atpD',
    };
    const ownerB = {
      ...ENTRY_B,
      structureId: sharedStructureId,
      ownerId: 'translated-cds:/tmp/genome.gb:atpE:2000-2200:1',
      sequenceDocumentId: '/tmp/genome.gb',
      cdsLabel: 'atpE',
    };

    useStructureLinkRegistry.getState().registerLink(ownerA);
    useStructureLinkRegistry.getState().registerLink(ownerB);

    expect(useStructureLinkRegistry.getState().links[sharedStructureId]).toBeUndefined();
    expect(useStructureLinkRegistry.getState().getLink(sharedStructureId)).toBeUndefined();
    expect(useStructureLinkRegistry.getState().getLink(sharedStructureId, ownerA.ownerId)).toEqual(
      ownerA
    );
    expect(useStructureLinkRegistry.getState().getLink(sharedStructureId, ownerB.ownerId)).toEqual(
      ownerB
    );
  });

  it('does not fall back to a bare link when an owner-scoped lookup misses', () => {
    const sharedStructureId = 'structure:rcsb:RCSB:6OQR:ENTRY:all';
    const bareAtpD = {
      ...ENTRY_A,
      structureId: sharedStructureId,
      sequenceDocumentId: '/tmp/genome.gb',
      cdsLabel: 'atpD',
      cdsFeatureId: 'b3732',
      residueTargets: [{ chain: 'D', residues: [{ residueIndex: 4, position: 4 }] }],
    };

    useStructureLinkRegistry.getState().registerLink(bareAtpD);

    expect(useStructureLinkRegistry.getState().getLink(sharedStructureId)).toEqual(bareAtpD);
    expect(
      useStructureLinkRegistry
        .getState()
        .getLink(sharedStructureId, 'translated-cds:/tmp/genome.gb:atpE:1-240:1')
    ).toBeUndefined();
  });
});

describe('useStructureLinkRegistry — unregister', () => {
  beforeEach(reset);

  it('unregisterLink removes the entry', () => {
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    useStructureLinkRegistry.getState().unregisterLink(ENTRY_A.structureId);
    expect(useStructureLinkRegistry.getState().links[ENTRY_A.structureId]).toBeUndefined();
  });

  it('unregisterLink on an unknown id is a no-op (no throw, state unchanged)', () => {
    useStructureLinkRegistry.getState().registerLink(ENTRY_A);
    const before = useStructureLinkRegistry.getState();
    useStructureLinkRegistry.getState().unregisterLink('does-not-exist');
    expect(useStructureLinkRegistry.getState().links).toEqual(before.links);
  });

  it('unregisterLink without owner removes every owner-scoped link for that structureId', () => {
    const sharedStructureId = 'structure:rcsb:RCSB:8QX8:ENTRY:all';
    useStructureLinkRegistry.getState().registerLink({
      ...ENTRY_A,
      structureId: sharedStructureId,
      ownerId: 'owner:A',
    });
    useStructureLinkRegistry.getState().registerLink({
      ...ENTRY_A,
      structureId: sharedStructureId,
      ownerId: 'owner:B',
      cdsLabel: 'other',
    });

    useStructureLinkRegistry.getState().unregisterLink(sharedStructureId);

    expect(
      useStructureLinkRegistry.getState().getLink(sharedStructureId, 'owner:A')
    ).toBeUndefined();
    expect(
      useStructureLinkRegistry.getState().getLink(sharedStructureId, 'owner:B')
    ).toBeUndefined();
    expect(useStructureLinkRegistry.getState().getLink(sharedStructureId)).toBeUndefined();
  });
});
