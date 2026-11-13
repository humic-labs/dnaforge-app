import { describe, expect, it } from 'vitest';
import type { ResidueSelection } from './residue-selection-store';
import {
  appendSavedResidueSelectionRevision,
  classifySavedResidueSelectionCompatibility,
  createSavedResidueSelectionDocument,
  parseSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
} from './saved-residue-selection';

const DISJOINT_SELECTION: ResidueSelection = {
  selectionId: 'runtime-selection',
  source: { kind: 'structure', id: 'structure:3OAA', surface: 'molstar' },
  target: {
    moleculeId: 'protein:sha256:abc123',
    moleculeKind: 'protein',
    coordinateSystem: 'residue',
    intervals: [
      { start: 85, end: 108 },
      { start: 194, end: 204 },
    ],
    label: 'BPSA CDS translation',
  },
  mappings: [
    {
      kind: 'structure',
      structureId: 'structure:3OAA',
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
      operator: 'ASM_1',
      position: 86,
      residueStart: 86,
      residueEnd: 109,
    },
  ],
};

describe('saved residue selection documents', () => {
  it('rejects parsed selections whose total interval coverage exceeds the validation budget', () => {
    const document = createSavedResidueSelectionDocument({
      id: 'selection-asset-too-large',
      name: 'Unbounded selection',
      color: '#ef4444',
      revisionId: 'selection-revision-too-large',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      members: [
        {
          id: 'member-too-large',
          selection: {
            target: {
              moleculeId: 'protein:sha256:abc123',
              moleculeKind: 'protein',
              coordinateSystem: 'residue',
              intervals: [{ start: 0, end: 0 }],
            },
          },
          scope: { kind: 'polymer' },
          polymerRevision: {
            moleculeId: 'protein:sha256:abc123',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'abc123',
          },
        },
      ],
    });
    const malicious = JSON.parse(serializeSavedResidueSelectionDocument(document));
    malicious.revisions[0].members[0].selection.target.intervals = [{ start: 0, end: 1_000_000 }];
    malicious.revisions[0].members[0].residueIdentities = [];

    expect(() => parseSavedResidueSelectionDocument(JSON.stringify(malicious))).toThrow(
      'Saved selection cannot contain more than 1000000 selected residues'
    );
  });

  it('validates exact identity coverage without expanding high-valued coordinates', () => {
    const highCoordinate = 1_000_000_000_000;
    const document = createSavedResidueSelectionDocument({
      id: 'selection-asset-high-coordinate',
      name: 'High coordinate selection',
      color: '#ef4444',
      revisionId: 'selection-revision-high-coordinate',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      members: [
        {
          id: 'member-high-coordinate',
          selection: {
            target: {
              moleculeId: 'protein:sha256:abc123',
              moleculeKind: 'protein',
              coordinateSystem: 'residue',
              intervals: [{ start: highCoordinate, end: highCoordinate + 1 }],
            },
          },
          scope: { kind: 'polymer' },
          polymerRevision: {
            moleculeId: 'protein:sha256:abc123',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'abc123',
          },
          residueIdentities: [
            {
              polymerIndex: highCoordinate,
              authSeqId: 1,
              labelCompId: 'ALA',
              oneLetterCode: 'A',
            },
            {
              polymerIndex: highCoordinate + 1,
              authSeqId: 2,
              labelCompId: 'GLY',
              oneLetterCode: 'G',
            },
          ],
        },
      ],
    });

    expect(
      parseSavedResidueSelectionDocument(serializeSavedResidueSelectionDocument(document))
    ).toEqual(document);
  });

  it('round-trips exact disjoint intervals and physical chain scope', () => {
    const document = createSavedResidueSelectionDocument({
      id: 'selection-asset-1',
      name: 'Catalytic and interface residues',
      color: '#ef4444',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      members: [
        {
          id: 'member-1',
          selection: DISJOINT_SELECTION,
          scope: {
            kind: 'structure-chain-instance',
            structureRevisionId: 'structure-revision-1',
            chain: {
              chain: 'A',
              labelAsymId: 'A',
              authAsymId: 'A',
              entityId: '1',
              operator: 'ASM_1',
            },
          },
          polymerRevision: {
            moleculeId: 'protein:sha256:abc123',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'abc123',
            sourceArtifact: {
              entityId: 'plasmid-asset-1',
              gitCommit: '0123456789abcdef',
              path: 'bpsa.gb',
            },
            translation: {
              featureId: 'CDS:bpsA',
              strand: 1,
              geneticCode: 11,
              frame: 0,
            },
          },
        },
      ],
      structureRevisions: [
        {
          id: 'structure-revision-1',
          structureId: 'structure:3OAA',
          providerIdentityKey: 'rcsb:3OAA:assembly:1',
          coordinateDigestSha256: 'coordinates123',
          assemblyId: '1',
        },
      ],
    });

    const parsed = parseSavedResidueSelectionDocument(
      serializeSavedResidueSelectionDocument(document)
    );

    expect(parsed).toEqual(document);
    expect(parsed.revisions[0].members[0].selection.target.intervals).toEqual([
      { start: 85, end: 108 },
      { start: 194, end: 204 },
    ]);
    expect(parsed.revisions[0].members[0].scope).toMatchObject({
      kind: 'structure-chain-instance',
      structureRevisionId: 'structure-revision-1',
      chain: { labelAsymId: 'A', operator: 'ASM_1' },
    });
  });

  it('appends an immutable child revision instead of mutating historical references', () => {
    const original = createSavedResidueSelectionDocument({
      id: 'selection-asset-1',
      name: 'Active site',
      color: '#ef4444',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      members: [
        {
          id: 'member-1',
          selection: DISJOINT_SELECTION,
          scope: { kind: 'polymer' },
          polymerRevision: {
            moleculeId: 'protein:sha256:abc123',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'abc123',
          },
        },
      ],
    });

    const next = appendSavedResidueSelectionRevision(original, {
      revisionId: 'selection-revision-2',
      createdAt: '2026-07-14T13:00:00.000Z',
      actor: { kind: 'agent', id: 'codex' },
      reason: 'Add interface residues',
      members: [
        {
          ...original.revisions[0].members[0],
          selection: {
            ...DISJOINT_SELECTION,
            target: {
              ...DISJOINT_SELECTION.target,
              intervals: [...DISJOINT_SELECTION.target.intervals, { start: 250, end: 251 }],
            },
          },
        },
      ],
    });

    expect(original.currentRevisionId).toBe('selection-revision-1');
    expect(original.revisions).toHaveLength(1);
    expect(next.currentRevisionId).toBe('selection-revision-2');
    expect(next.revisions).toHaveLength(2);
    expect(next.revisions[1]).toMatchObject({
      id: 'selection-revision-2',
      parentRevisionId: 'selection-revision-1',
      reason: 'Add interface residues',
    });
    expect(next.revisions[0]).toEqual(original.revisions[0]);
  });

  it('fails closed on polymer drift and requires explicit structure remapping', () => {
    const document = createSavedResidueSelectionDocument({
      id: 'selection-asset-1',
      name: 'Active site',
      color: '#ef4444',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      members: [
        {
          id: 'member-1',
          selection: DISJOINT_SELECTION,
          scope: {
            kind: 'structure-chain-instance',
            structureRevisionId: 'structure-revision-1',
            chain: { chain: 'A', labelAsymId: 'A', operator: 'ASM_1' },
          },
          polymerRevision: {
            moleculeId: 'protein:sha256:abc123',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'abc123',
          },
        },
      ],
      structureRevisions: [
        {
          id: 'structure-revision-1',
          structureId: 'structure:3OAA',
          coordinateDigestSha256: 'coordinates123',
        },
      ],
    });
    const revision = document.revisions[0];

    expect(
      classifySavedResidueSelectionCompatibility(revision, {
        polymers: [{ moleculeId: 'protein:sha256:abc123', sequenceDigestSha256: 'changed' }],
        structures: [{ structureId: 'structure:3OAA', coordinateDigestSha256: 'coordinates123' }],
      })
    ).toMatchObject({ status: 'stale-polymer' });

    expect(
      classifySavedResidueSelectionCompatibility(revision, {
        polymers: [{ moleculeId: 'protein:sha256:abc123', sequenceDigestSha256: 'abc123' }],
        structures: [{ structureId: 'structure:3OAA', coordinateDigestSha256: 'revised' }],
      })
    ).toMatchObject({ status: 'structure-remap-required' });

    expect(
      classifySavedResidueSelectionCompatibility(revision, {
        polymers: [{ moleculeId: 'protein:sha256:abc123', sequenceDigestSha256: 'abc123' }],
        structures: [{ structureId: 'structure:3OAA', coordinateDigestSha256: 'coordinates123' }],
      })
    ).toEqual({ status: 'compatible' });
  });
});
