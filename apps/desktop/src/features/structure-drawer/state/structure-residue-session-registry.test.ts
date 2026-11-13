// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { useStructureResidueSessionRegistry } from './structure-residue-session-registry';
import { structureLinkRegistryKey, type StructureLinkEntry } from './use-structure-link-registry';

function reset() {
  useStructureResidueSessionRegistry.setState({ sessions: {} });
}

describe('useStructureResidueSessionRegistry', () => {
  beforeEach(reset);

  it('unregisters only matching pending sessions for a committed request', () => {
    const registry = useStructureResidueSessionRegistry.getState();
    registry.upsertSession({
      structureId: 'pending:42:first',
      requestId: 42,
      sequenceDocumentId: '/fixtures/a.gb',
      phase: 'awaiting-candidate-commit',
    });
    registry.upsertSession({
      structureId: 'structure:rcsb:1ABC',
      requestId: 42,
      sequenceDocumentId: '/fixtures/a.gb',
      phase: 'interactive',
    });
    registry.upsertSession({
      structureId: 'pending:43:first',
      requestId: 43,
      sequenceDocumentId: '/fixtures/b.gb',
      phase: 'awaiting-candidate-commit',
    });

    useStructureResidueSessionRegistry
      .getState()
      .unregisterSessionsForRequest(
        42,
        (entry) =>
          entry.phase === 'awaiting-candidate-commit' || entry.structureId.startsWith('pending:')
      );

    expect(Object.keys(useStructureResidueSessionRegistry.getState().sessions).sort()).toEqual([
      'pending:43:first',
      'structure:rcsb:1ABC',
    ]);
  });

  it('scopes live sessions by owner and refreshes stale provisional links with extracted residue maps', () => {
    const provisionalLink: StructureLinkEntry = {
      structureId: 'structure:rcsb:8QX8',
      ownerId: 'translated-cds:/fixtures/vps8.gb:VPS8:10-99:1',
      sequenceDocumentId: '/fixtures/vps8.gb',
      cdsLabel: 'VPS8 display label',
      cdsFeatureId: 'VPS8',
      translation: 'MST',
      cdsStart: 10,
      cdsEnd: 99,
      strand: 1,
      residueTargets: [{ chain: 'A', residues: [] }],
      residueMolecule: {
        moleculeId: 'translated-cds:/fixtures/vps8.gb:VPS8:11-100:1',
        moleculeKind: 'translated-cds',
        label: 'VPS8 display label',
      },
    };
    const refreshedLink: StructureLinkEntry = {
      ...provisionalLink,
      residueTarget: { chain: 'F', residues: [{ residueIndex: 1, position: 37 }] },
      residueTargets: [{ chain: 'F', residues: [{ residueIndex: 1, position: 37 }] }],
    };

    useStructureResidueSessionRegistry.getState().upsertSession({
      structureId: provisionalLink.structureId,
      ownerId: provisionalLink.ownerId,
      requestId: 7,
      sequenceDocumentId: provisionalLink.sequenceDocumentId,
      phase: 'viewer-mounting',
      link: provisionalLink,
    });

    useStructureResidueSessionRegistry
      .getState()
      .refreshSessionLink(provisionalLink.structureId, provisionalLink.ownerId, refreshedLink);

    const session =
      useStructureResidueSessionRegistry.getState().sessions[
        structureLinkRegistryKey(provisionalLink.structureId, provisionalLink.ownerId)
      ];
    expect(session.link).toEqual(refreshedLink);
    expect(session.link?.residueTargets?.[0].residues).toEqual([{ residueIndex: 1, position: 37 }]);
  });

  it('unregisterSession without owner removes every owner-scoped session for that structureId', () => {
    const registry = useStructureResidueSessionRegistry.getState();
    registry.upsertSession({
      structureId: 'structure:rcsb:8QX8',
      ownerId: 'owner:A',
      requestId: 1,
      sequenceDocumentId: '/fixtures/a.gb',
      phase: 'interactive',
    });
    registry.upsertSession({
      structureId: 'structure:rcsb:8QX8',
      ownerId: 'owner:B',
      requestId: 2,
      sequenceDocumentId: '/fixtures/b.gb',
      phase: 'interactive',
    });

    useStructureResidueSessionRegistry.getState().unregisterSession('structure:rcsb:8QX8');

    expect(useStructureResidueSessionRegistry.getState().sessions).toEqual({});
  });
});
