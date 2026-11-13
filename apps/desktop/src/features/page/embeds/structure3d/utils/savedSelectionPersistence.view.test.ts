import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainSequence, HighlightGroup, Structure3dAttrs } from '../types';
import {
  loadSavedSelectionProjectionsFromFolders,
  recordSelectionInOpenViews,
  renameSavedSelectionRef,
  saveStructureSelection,
} from './savedSelectionPersistence';
import { useStructure3dStore } from '../store';
import { initPlatform, platform } from '../../../../../platform';
import { molecularDocumentFixture } from '../../../../../test/fixtures/molecular-documents';
import {
  getCurrentMolecularSnapshot,
  molecularDocumentSchema,
  type MolecularDocument,
} from '../../../../../shared/molecular-document';

const ROOT = '/project';
const VIEW_PATH = '/project/views/Pocket.dnaforge-molecular.json';

const CHAIN: ChainSequence = {
  chainId: 'A',
  chainLabel: 'Chain A',
  sequence: 'ACDE',
  baseChain: 'A',
  labelAsymId: 'A',
  authAsymId: 'A',
  entityId: '1',
  residues: [...'ACDE'].map((name, index) => ({
    position: index + 1,
    sequenceIndex: index,
    labelSeqId: index + 1,
    name,
    name3: 'ALA',
  })),
};

const GROUP: HighlightGroup = {
  id: 'runtime-group',
  label: 'Pocket residues',
  color: '#ef4444',
  visible: true,
  selections: [
    {
      chain: 'A',
      baseChain: 'A',
      labelAsymId: 'A',
      authAsymId: 'A',
      entityId: '1',
      ranges: [[2, 3]],
    },
  ],
};

let stored: { document: MolecularDocument; revision: number };

beforeAll(async () => {
  await initPlatform();
});

beforeEach(async () => {
  stored = { document: await molecularDocumentFixture(), revision: 1 };
  vi.spyOn(platform().molecularDocuments, 'read').mockImplementation(async (location) => ({
    ...location,
    document: structuredClone(stored.document),
    revision: `r${stored.revision}`,
  }));
  vi.spyOn(platform().molecularDocuments, 'save').mockImplementation(async (request) => {
    if (request.expectedRevision !== `r${stored.revision}`)
      throw new Error('The molecular document changed since it was opened.');
    stored = {
      document: molecularDocumentSchema.parse(request.document),
      revision: stored.revision + 1,
    };
    return {
      ...request.destination,
      document: structuredClone(stored.document),
      revision: `r${stored.revision}`,
    };
  });
  vi.spyOn(platform().fs, 'exists').mockImplementation(async (path) => path === VIEW_PATH);
});

function viewAttrs(revision = `r${stored.revision}`): Structure3dAttrs {
  return {
    source: 'file',
    sourceId: getCurrentMolecularSnapshot(stored.document).coordinates.text,
    coordinateSha256: getCurrentMolecularSnapshot(stored.document).coordinates.sha256,
    molecularDocumentId: stored.document.id,
    molecularDocumentPath: VIEW_PATH,
    molecularDocumentRevision: revision,
  };
}

async function saveOnView() {
  return saveStructureSelection({
    workspaceRoot: ROOT,
    structureId: 'molecular-document:pocket',
    attrs: viewAttrs(),
    chains: [CHAIN],
    group: GROUP,
  });
}

describe('selections saved on a molecular view ', () => {
  it('stores the selection in the view file instead of a separate selection file', async () => {
    const saved = await saveOnView();
    expect(saved.ref.artifactPath).toBe('views/Pocket.dnaforge-molecular.json');
    expect(saved.molecularDocumentRevision).toBe('r2');
    expect(saved.structureArtifactRef).toBeUndefined();
    expect(stored.document.selections).toHaveLength(1);
    const [selection] = stored.document.selections!;
    expect(selection.name).toBe('Pocket residues');
    expect(selection.revisions[0].structureRevisions[0].coordinateDigestSha256).toBe(
      getCurrentMolecularSnapshot(stored.document).coordinates.sha256
    );
  });

  it('reloads a view-file selection for the viewer', async () => {
    const saved = await saveOnView();
    const loaded = await loadSavedSelectionProjectionsFromFolders(
      [{ path: ROOT }],
      [saved.ref],
      undefined
    );
    expect(loaded.errors).toEqual([]);
    expect(loaded.groups).toHaveLength(1);
    expect(loaded.groups[0].label).toBe('Pocket residues');
  });

  it('renames a view-file selection by appending a revision', async () => {
    const saved = await saveOnView();
    const renamed = await renameSavedSelectionRef(ROOT, saved.ref, 'Active site');
    expect(renamed.molecularDocumentRevision).toBe('r3');
    expect(renamed.projection.label).toBe('Active site');
    const [selection] = stored.document.selections!;
    expect(selection.name).toBe('Active site');
    expect(selection.revisions).toHaveLength(2);
    expect(renamed.ref.revisionId).toBe(selection.currentRevisionId);
  });

  it('refuses to save into a view that changed elsewhere', async () => {
    await expect(
      saveStructureSelection({
        workspaceRoot: ROOT,
        structureId: 'molecular-document:pocket',
        attrs: viewAttrs('r0'),
        chains: [CHAIN],
        group: GROUP,
      })
    ).rejects.toThrow(/changed elsewhere/i);
    expect(stored.document.selections).toBeUndefined();
  });

  it('records a saved selection on every open panel of that view file', () => {
    const ref = {
      selectionId: 'selection-1',
      revisionId: 'revision-1',
      artifactPath: 'views/Pocket.dnaforge-molecular.json',
      visible: true,
    };
    const before = 'a'.repeat(64);
    const after = 'b'.repeat(64);
    useStructure3dStore.setState({
      expandedStructures: {
        'molecular-document:pocket': {
          label: 'Pocket',
          data: {
            source: 'file',
            molecularDocumentId: crypto.randomUUID(),
            molecularDocumentPath: VIEW_PATH,
            molecularDocumentRevision: before,
            molecularDocumentSavedReferenceId: crypto.randomUUID(),
          },
        },
        'structure:file:before-save': {
          label: 'Pocket.pdb',
          data: { source: 'file', coordinateFilePath: '/project/views/Pocket.pdb' },
        },
      },
    });
    expect(recordSelectionInOpenViews(VIEW_PATH, ref, after)).toBe(1);
    const state = useStructure3dStore.getState().expandedStructures;
    expect(state['molecular-document:pocket'].data).toMatchObject({
      savedSelectionRefs: [ref],
      molecularDocumentRevision: after,
    });
    expect(state['structure:file:before-save'].data.savedSelectionRefs).toBeUndefined();
    useStructure3dStore.setState({ expandedStructures: {} });
  });
});
