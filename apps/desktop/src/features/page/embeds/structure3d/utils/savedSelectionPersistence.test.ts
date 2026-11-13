import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Structure3dAttrs } from '../types';
import {
  assertSavedSelectionStructureCompatibility,
  ensureStructureCoordinateArtifact,
  loadSavedSelectionProjectionsFromFolders,
  resolveStructureWorkspaceRoot,
  resolveWorkspaceArtifactPath,
} from './savedSelectionPersistence';
import {
  createSavedResidueSelectionDocument,
  serializeSavedResidueSelectionDocument,
} from '@waypoint/workspace-editor';
import { MockFsModule, setMockFileContent } from '../../../../../test/platform-mocks';
import { initPlatform } from '../../../../../platform';

beforeAll(async () => {
  await initPlatform();
});

describe('saved selection workspace paths', () => {
  it('uses the owning notebook project when an embed has no standalone file binding', () => {
    const attrs: Structure3dAttrs = { source: 'file', sourceId: 'coordinate bytes' };
    const folders = [{ path: '/project-a' }, { path: '/project-b' }];
    expect(resolveStructureWorkspaceRoot(folders, attrs, '/project-b')).toBe('/project-b');
    expect(resolveStructureWorkspaceRoot(folders, attrs, '/unmounted-project')).toBeNull();
  });

  it('uses the exact containing workspace for a source-derived structure', () => {
    const attrs: Structure3dAttrs = {
      source: 'pdb',
      sourceId: '1ABC',
      scene: {
        schemaVersion: 1,
        id: 'scene-1',
        queryAnchor: {
          memberId: 'query',
          sourceWorkspaceRoot: '/projects/experiment-a',
          targetSelection: { pdbId: '1ABC' },
        },
        members: [],
      },
    };

    expect(
      resolveStructureWorkspaceRoot(
        [{ path: '/projects' }, { path: '/projects/experiment-a' }],
        attrs
      )
    ).toBe('/projects/experiment-a');
  });

  it('falls back only when there is exactly one unambiguous workspace', () => {
    const attrs: Structure3dAttrs = { source: 'pdb', sourceId: '1ABC' };

    expect(resolveStructureWorkspaceRoot([{ path: '/only-workspace' }], attrs)).toBe(
      '/only-workspace'
    );
    expect(
      resolveStructureWorkspaceRoot([{ path: '/project-a' }, { path: '/project-b' }], attrs)
    ).toBeNull();
  });

  it('restores workspace-relative artifact refs after a workspace move', () => {
    expect(
      resolveWorkspaceArtifactPath(
        '/moved/experiment-a',
        'Selections/Catalytic.selection-1.wpselection.json'
      )
    ).toBe('/moved/experiment-a/Selections/Catalytic.selection-1.wpselection.json');
    expect(() =>
      resolveWorkspaceArtifactPath('/moved/experiment-a', '../outside.wpselection.json')
    ).toThrow('cannot escape its root');
  });

  it('finds a relative selection ref by stable id across project roots and rejects duplicates', async () => {
    const document = createSavedResidueSelectionDocument({
      id: 'selection-multi-root',
      name: 'Multi-root pocket',
      color: '#dc2626',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      members: [
        {
          id: 'member-1',
          selection: {
            target: {
              moleculeId: 'protein:sha256:protein-digest',
              moleculeKind: 'protein',
              coordinateSystem: 'residue',
              intervals: [{ start: 0, end: 0 }],
            },
          },
          scope: { kind: 'polymer' },
          polymerRevision: {
            moleculeId: 'protein:sha256:protein-digest',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'protein-digest',
          },
        },
      ],
    });
    const relativePath = 'Selections/Multi-root.selection-multi-root.wpselection.json';
    const serialized = serializeSavedResidueSelectionDocument(document);
    setMockFileContent(`/project-b/${relativePath}`, serialized);
    const ref = {
      selectionId: document.id,
      revisionId: document.currentRevisionId,
      artifactPath: relativePath,
      visible: true,
    };

    await expect(
      loadSavedSelectionProjectionsFromFolders(
        [{ path: '/project-a' }, { path: '/project-b' }],
        [ref],
        undefined
      )
    ).resolves.toMatchObject({
      groups: [{ id: document.id, label: document.name, visible: true }],
      errors: [],
    });

    setMockFileContent(`/project-a/${relativePath}`, serialized);
    const ambiguous = await loadSavedSelectionProjectionsFromFolders(
      [{ path: '/project-a' }, { path: '/project-b' }],
      [ref],
      undefined
    );
    expect(ambiguous.groups).toEqual([]);
    expect(ambiguous.errors[0]?.error).toContain('ambiguous across mounted projects');
  });

  it('fails closed when the current coordinate bytes differ from the pinned structure revision', () => {
    const document = createSavedResidueSelectionDocument({
      id: 'selection-1',
      name: 'Catalytic residue',
      color: '#ef4444',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      actor: { kind: 'user' },
      structureRevisions: [
        {
          id: 'structure-revision-1',
          structureId: 'structure:1ABC',
          coordinateDigestSha256: 'pinned-digest',
        },
      ],
      members: [
        {
          id: 'member-1',
          selection: {
            target: {
              moleculeId: 'protein:sha256:protein-digest',
              moleculeKind: 'protein',
              coordinateSystem: 'residue',
              intervals: [{ start: 41, end: 41 }],
            },
          },
          scope: {
            kind: 'structure-chain-instance',
            structureRevisionId: 'structure-revision-1',
            chain: { chain: 'A' },
          },
          polymerRevision: {
            moleculeId: 'protein:sha256:protein-digest',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'protein-digest',
          },
        },
      ],
    });

    expect(() =>
      assertSavedSelectionStructureCompatibility(document, 'selection-revision-1', {
        entityId: 'structure-asset-2',
        revisionId: 'structure-revision-2',
        structureId: 'structure:1ABC',
        coordinateDigestSha256: 'different-digest',
        artifactPath: 'Structures/1ABC.cif',
        format: 'mmcif',
      })
    ).toThrow('coordinate bytes differ');
  });

  it('fails closed when identical entry bytes are opened as a different biological assembly', () => {
    const document = createSavedResidueSelectionDocument({
      id: 'selection-assembly-1',
      name: 'Assembly-specific pocket',
      color: '#22c55e',
      revisionId: 'selection-revision-1',
      createdAt: '2026-07-16T12:00:00.000Z',
      actor: { kind: 'user' },
      structureRevisions: [
        {
          id: 'structure-revision-1',
          structureId: 'structure:1ABC',
          coordinateDigestSha256: 'same-entry-digest',
          assemblyId: '1',
        },
      ],
      members: [
        {
          id: 'member-1',
          selection: {
            target: {
              moleculeId: 'protein:sha256:protein-digest',
              moleculeKind: 'protein',
              coordinateSystem: 'residue',
              intervals: [{ start: 41, end: 41 }],
            },
          },
          scope: {
            kind: 'structure-chain-instance',
            structureRevisionId: 'structure-revision-1',
            chain: { chain: 'A', operator: '1_555' },
          },
          polymerRevision: {
            moleculeId: 'protein:sha256:protein-digest',
            moleculeKind: 'protein',
            sequenceDigestSha256: 'protein-digest',
          },
        },
      ],
    });

    expect(() =>
      assertSavedSelectionStructureCompatibility(document, 'selection-revision-1', {
        entityId: 'structure-asset-2',
        revisionId: 'structure-revision-2',
        structureId: 'structure:1ABC',
        coordinateDigestSha256: 'same-entry-digest',
        assemblyId: '2',
        artifactPath: 'Structures/1ABC.cif',
        format: 'mmcif',
      })
    ).toThrow('biological assembly differs');
  });

  it('runs compatibility validation before persisting an unpinned coordinate artifact', async () => {
    const writeSpy = vi.spyOn(MockFsModule, 'writeTextFile');
    await expect(
      ensureStructureCoordinateArtifact({
        workspaceRoot: '/lab',
        structureId: 'structure:1ABC',
        attrs: {
          source: 'file',
          sourceId: 'data_1ABC\n_atom_site.id 1\n',
          label: '1ABC assembly 2',
          assemblyId: '2',
        },
        validateBeforePersist: () => {
          throw new Error('biological assembly differs');
        },
      })
    ).rejects.toThrow('biological assembly differs');
    expect(writeSpy.mock.calls.some(([path]) => String(path).includes('/Structures/'))).toBe(false);
  });
});
