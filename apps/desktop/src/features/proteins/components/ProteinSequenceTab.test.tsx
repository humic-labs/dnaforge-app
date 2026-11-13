/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { userMessage } from '@waypoint/user-messages';

const opsMock = vi.hoisted(() => ({ queryLimsEntities: vi.fn() }));
vi.mock('../../lims/operations', () => opsMock);

const fastaMock = vi.hoisted(() => ({ resolveNativeFastaSourceAuthority: vi.fn() }));
vi.mock('../../../services/native-catalog-destination', () => fastaMock);

const catalogMock = vi.hoisted(() => ({ getCatalogEntityForFilePath: vi.fn() }));
vi.mock('../../../db/workspace-catalog', () => catalogMock);

vi.mock('../../../platform', () => ({
  platform: () => ({ molecularCatalog: { list: vi.fn().mockResolvedValue([]) } }),
}));

const seqMock = vi.hoisted(() => ({ resolveAminoAcidSequence: vi.fn() }));
vi.mock('../../lims/protein-sequence', () => seqMock);

const drawerStoreMock = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../structure-drawer', () => ({
  useStructureDrawerStore: { getState: () => drawerStoreMock },
}));

vi.mock('../../structure-drawer/components/StructureDrawerContent', () => ({
  StructureDrawerContent: ({ onCloseDrawer }: { onCloseDrawer?: () => void }) => (
    <div data-testid="mock-structure-drawer">
      <button type="button" data-testid="mock-close-drawer" onClick={onCloseDrawer}>
        Close
      </button>
    </div>
  ),
}));

const askAiMock = vi.hoisted(() => ({ askAiAboutProtein: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../ask-ai-about-protein', () => askAiMock);

const saveMock = vi.hoisted(() => ({
  saveProteinSequence: vi.fn(),
  resolveProteinEntityArtifactRevision: vi.fn(),
}));
vi.mock('../save-protein-sequence', () => saveMock);

vi.stubGlobal('navigator', {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

import { ProteinSequenceTab } from './ProteinSequenceTab';
import { usePredictStructureStore } from '../../compute/public/predict-structure';
import type { LimsEntity } from '../../../shared/lims';

afterEach(cleanup);

function makeEntity(overrides: Partial<LimsEntity> = {}): LimsEntity {
  return {
    id: 'uuid-1',
    kind: 'protein',
    schemaId: null,
    schemaRevisionId: 'rev-1',
    name: 'GFP',
    registryId: 'aa000001',
    fields: {
      sequence: { mode: 'file', relPath: 'proteins/gfp-abc123.faa', length: 3 },
    },
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: null,
    actor: null,
    eventSeq: 1,
    tombstone: false,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...overrides,
  };
}

function renderProteinTab(entityId: string): ReturnType<typeof vi.fn> {
  const onUnavailable = vi.fn();
  render(<ProteinSequenceTab entityId={entityId} onUnavailable={onUnavailable} />);
  return onUnavailable;
}

beforeEach(() => {
  vi.clearAllMocks();
  fastaMock.resolveNativeFastaSourceAuthority.mockResolvedValue(null);
  catalogMock.getCatalogEntityForFilePath.mockResolvedValue(null);
  opsMock.queryLimsEntities.mockResolvedValue([]);
  saveMock.saveProteinSequence.mockImplementation(async ({ entity, bases }) => ({
    status: 'saved',
    entity,
    bases: String(bases).replace(/\s/gu, '').toUpperCase(),
    expectedContentHash: 'b'.repeat(64),
  }));
});

describe('ProteinSequenceTab  slice 1.3)', () => {
  it('renders the AA sequence with a position ruler once resolved', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([
      makeEntity({ fields: { sequence: {}, sourceCds: 'GFP-cds', organism: 'A. victoria' } }),
    ]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG',
      length: 33,
    });

    renderProteinTab('uuid-1');

    await waitFor(() => expect(screen.getByTestId('protein-sequence-tab')).toBeTruthy());
    expect(screen.getByText('GFP')).toBeTruthy();
    expect(screen.getByText('aa000001')).toBeTruthy();
    expect(screen.getByText('· 33 aa')).toBeTruthy();
    expect(screen.getByText('Source CDS: GFP-cds')).toBeTruthy();
    expect(screen.getByText('Organism: A. victoria')).toBeTruthy();
    expect(screen.getByTestId('protein-residue-track').textContent).toContain(
      'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG'
    );
    expect(opsMock.queryLimsEntities).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'uuid-1' })
    );
  });

  it('wraps long sequences into multiple rows with correct position numbers', async () => {
    const bases = 'A'.repeat(75);
    opsMock.queryLimsEntities.mockResolvedValue([makeEntity()]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases,
      length: 75,
    });

    renderProteinTab('uuid-1');
    await waitFor(() => expect(screen.getByTestId('protein-residue-track')).toBeTruthy());
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('61')).toBeTruthy();
  });

  it('requests tab removal when the protein was deleted or archived', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([]);

    const onUnavailable = renderProteinTab('uuid-gone');
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('protein-tab-missing-entity')).toBeNull();
    expect(seqMock.resolveAminoAcidSequence).not.toHaveBeenCalled();
  });

  it('opens an ordinary unregistered protein FASTA as a read-only protein sequence', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MKTW',
      length: 4,
    });

    renderProteinTab('/workspace/Reporter.faa');

    await waitFor(() => expect(screen.getByTestId('protein-sequence-tab')).toBeTruthy());
    expect(screen.getByText('Reporter')).toBeTruthy();
    expect(screen.getByText('Unregistered file')).toBeTruthy();
    expect(screen.getByTestId('protein-residue-track').textContent).toContain('MKTW');
    expect(screen.queryByTestId('protein-edit-sequence')).toBeNull();
    expect(opsMock.queryLimsEntities).toHaveBeenCalledWith({
      kind: 'protein',
      sequenceDocumentId: '/workspace/Reporter.faa',
      includeArchived: true,
      limit: 1,
    });
  });

  it.each(['/workspace/Ambiguous.fasta', '/workspace/protein.fna'])(
    'reads a declared protein from its exact native source %s',
    async (path) => {
      fastaMock.resolveNativeFastaSourceAuthority.mockResolvedValue({
        status: 'declared',
        kind: 'protein',
        entityId: 'native-protein',
        path,
      });
      seqMock.resolveAminoAcidSequence.mockResolvedValue({
        status: 'loaded',
        bases: 'MKQL',
        length: 4,
      });
      const unavailable = renderProteinTab(path);
      await waitFor(() =>
        expect(screen.getByTestId('protein-residue-track').textContent).toContain('MKQL')
      );
      expect(unavailable).not.toHaveBeenCalled();
      expect(fastaMock.resolveNativeFastaSourceAuthority).toHaveBeenCalledWith(path);
    }
  );

  it('retains the historical protein read view while withholding scientific and reference actions until native classification', async () => {
    const path = '/workspace/Legacy.faa';
    fastaMock.resolveNativeFastaSourceAuthority.mockResolvedValue({
      status: 'needs-classification',
      storedKind: 'sequence',
      legacyReadView: 'protein',
      readOnly: true,
      entityId: 'historical-sequence',
      path,
    });
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MKTW',
      length: 4,
    });
    const readRequest = {
      status: 'needs-classification',
      storedKind: 'sequence',
      legacyReadView: 'protein',
      readOnly: true,
      path,
      workspaceRoot: '/workspace',
      entityId: 'historical-sequence',
      bindingId: 'historical-binding',
      objectUuid: 'historical-object',
    } as const;
    const onUnavailable = vi.fn();
    const reader = render(
      <ProteinSequenceTab entityId={path} onUnavailable={onUnavailable} legacyFasta={readRequest} />
    );
    await waitFor(() =>
      expect(screen.getByTestId('protein-residue-track').textContent).toContain('MKTW')
    );
    expect(screen.getByTestId('fasta-kind-status').textContent).toContain('needs classification');
    expect(screen.queryByTestId('protein-edit-sequence')).toBeNull();
    expect(screen.queryByTestId('protein-view-structure')).toBeNull();
    expect(screen.queryByTestId('protein-predict-structure')).toBeNull();
    fireEvent.contextMenu(screen.getByTestId('protein-residue-track'), {
      clientX: 10,
      clientY: 10,
    });
    expect(screen.getByTestId('protein-menu-copy-sequence')).toBeTruthy();
    expect(screen.queryByTestId('protein-menu-ask-ai')).toBeNull();
    expect(screen.queryByTestId('protein-menu-backtranslate')).toBeNull();
    expect(askAiMock.askAiAboutProtein).not.toHaveBeenCalled();
    reader.rerender(<ProteinSequenceTab entityId={path} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(screen.getByTestId('fasta-kind-status')).toBeTruthy());
    expect(screen.queryByTestId('protein-predict-structure')).toBeNull();
    fastaMock.resolveNativeFastaSourceAuthority.mockResolvedValue({
      ...readRequest,
      status: 'declared',
      kind: 'protein',
      authority: 'native-declaration',
    });
    reader.rerender(
      <ProteinSequenceTab entityId={path} onUnavailable={onUnavailable} legacyFasta={readRequest} />
    );
    await waitFor(() => expect(screen.getByTestId('protein-predict-structure')).toBeTruthy());
    expect(screen.queryByTestId('fasta-kind-status')).toBeNull();
  });

  it('refuses a forged protein presentation for a native DNA source', async () => {
    fastaMock.resolveNativeFastaSourceAuthority.mockResolvedValue({
      status: 'declared',
      kind: 'sequence',
      entityId: 'native-dna',
      path: '/workspace/DNA.faa',
    });
    renderProteinTab('/workspace/DNA.faa');
    await waitFor(() =>
      expect(screen.getByTestId('protein-tab-error').textContent).toContain(
        'not available in the protein view'
      )
    );
    expect(seqMock.resolveAminoAcidSequence).not.toHaveBeenCalled();
    expect(screen.queryByTestId('protein-residue-track')).toBeNull();
  });

  it('recovers a registered protein identity from its exact file path', async () => {
    const entity = makeEntity({
      id: 'saved-protein-1',
      name: 'Saved reporter',
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/workspace/Reporter.faa',
          length: 4,
          contentHash: `sha256:${'a'.repeat(64)}`,
          sourceFormat: 'fasta',
        },
      },
    });
    opsMock.queryLimsEntities.mockResolvedValue([entity]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MKTW',
      length: 4,
    });

    renderProteinTab('/workspace/Reporter.faa');

    await waitFor(() => expect(screen.getByTestId('protein-edit-sequence')).toBeTruthy());
    expect(screen.getByText('Saved reporter')).toBeTruthy();
    expect(opsMock.queryLimsEntities).toHaveBeenCalledWith({
      kind: 'protein',
      sequenceDocumentId: '/workspace/Reporter.faa',
      includeArchived: true,
      limit: 1,
    });
  });

  it('resolves a registered protein file through the catalog without scanning the registry', async () => {
    catalogMock.getCatalogEntityForFilePath.mockResolvedValue({
      id: 'workspace-protein-1',
      type: 'protein',
    });
    opsMock.queryLimsEntities.mockResolvedValue([
      makeEntity({
        id: 'workspace-protein-1',
        fields: {
          sequence: { mode: 'file', relPath: '/workspace/Reporter.faa', length: 4 },
        },
      }),
    ]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MKTW',
      length: 4,
    });

    renderProteinTab('/workspace/Reporter.faa');

    await waitFor(() => expect(screen.getByTestId('protein-sequence-tab')).toBeTruthy());
    expect(catalogMock.getCatalogEntityForFilePath).toHaveBeenCalledWith('/workspace/Reporter.faa');
    expect(opsMock.queryLimsEntities).toHaveBeenCalledTimes(1);
    expect(opsMock.queryLimsEntities).toHaveBeenCalledWith({
      id: 'workspace-protein-1',
      includeArchived: true,
      limit: 1,
    });
  });

  it('requests tab removal when the entity exists but its sequence file is gone', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([makeEntity()]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({ status: 'missing', length: 33 });

    const onUnavailable = renderProteinTab('uuid-1');
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('protein-tab-missing-file')).toBeNull();
  });

  it('shows an error state when resolution fails', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([makeEntity()]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'error',
      error: 'disk exploded',
    });

    renderProteinTab('uuid-1');
    await waitFor(() => expect(screen.getByTestId('protein-tab-error')).toBeTruthy());
    expect(screen.getByTestId('protein-tab-error').textContent).toContain(
      userMessage('structure.failed')
    );
    expect(screen.queryByText('disk exploded')).toBeNull();
  });

  it('offers the sequence viewer when a protein FASTA contains multiple records', async () => {
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'error',
      error:
        'This protein FASTA contains multiple records. Open it in the sequence viewer to browse its records.',
    });
    const opened = vi.fn();
    window.addEventListener('waypoint:open-entity', opened, { once: true });

    renderProteinTab('/workspace/proteome.faa');
    fireEvent.click(await screen.findByRole('button', { name: 'Open in sequence viewer' }));

    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      entityId: '/workspace/proteome.faa',
      entityType: 'sequence',
      label: 'proteome',
    });
  });

  it('edits and saves a file-backed protein through the native protein lifecycle', async () => {
    const entity = makeEntity({
      fields: {
        sequence: {
          mode: 'file',
          relPath: '/workspace/proteins/gfp.faa',
          length: 3,
          contentHash: `sha256:${'a'.repeat(64)}`,
          fileContentHash: `sha256:${'a'.repeat(64)}`,
          sourceFormat: 'fasta',
        },
      },
    });
    opsMock.queryLimsEntities.mockResolvedValue([entity]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MSK',
      length: 3,
    });

    renderProteinTab('uuid-1');
    await waitFor(() => expect(screen.getByTestId('protein-edit-sequence')).toBeTruthy());
    fireEvent.click(screen.getByTestId('protein-edit-sequence'));
    fireEvent.change(screen.getByLabelText('Amino-acid sequence'), { target: { value: 'MSKW' } });
    fireEvent.click(screen.getByTestId('protein-save-sequence'));

    await waitFor(() =>
      expect(saveMock.saveProteinSequence).toHaveBeenCalledWith({
        entity,
        bases: 'MSKW',
        expectedContentHash: `sha256:${'a'.repeat(64)}`,
        workspaceRoots: [],
      })
    );
    await waitFor(() => expect(screen.queryByTestId('protein-sequence-editor')).toBeNull());
    expect(screen.getByText('· 4 aa')).toBeTruthy();
  });

  it('opens a package-backed inline protein from its authoritative artifact and enables editing', async () => {
    const entity = makeEntity({
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'STALE', length: 5 },
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'proteins/GFP.entity.json' },
      },
    });
    opsMock.queryLimsEntities.mockResolvedValue([entity]);
    saveMock.resolveProteinEntityArtifactRevision.mockResolvedValue({
      status: 'ready',
      revision: {
        artifact: {
          fields: { sequence: { mode: 'inline', aminoAcids: 'MSKX*', length: 5 } },
        },
        contentHash: `sha256:${'c'.repeat(64)}`,
      },
    });
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MSKX*',
      length: 5,
    });

    renderProteinTab('uuid-1');

    await waitFor(() => expect(screen.getByTestId('protein-edit-sequence')).toBeTruthy());
    expect(screen.getByTestId('protein-residue-track').textContent).toContain('MSKX*');
    expect(saveMock.resolveProteinEntityArtifactRevision).toHaveBeenCalledWith({
      entity,
      workspaceRoots: [],
    });
  });

  it('predicts a package-backed protein from its saved file location', async () => {
    const entity = makeEntity({
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'MSKX*', length: 5 },
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'proteins/GFP.entity.json' },
      },
    });
    opsMock.queryLimsEntities.mockResolvedValue([entity]);
    saveMock.resolveProteinEntityArtifactRevision.mockResolvedValue({
      status: 'ready',
      revision: {
        artifact: {
          fields: { sequence: { mode: 'inline', aminoAcids: 'MSKX*', length: 5 } },
        },
        artifactPath: '/ws/proteins/GFP.entity.json',
        contentHash: `sha256:${'c'.repeat(64)}`,
      },
    });
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: 'MSKX*',
      length: 5,
    });

    renderProteinTab('uuid-1');

    fireEvent.click(await screen.findByTestId('protein-predict-structure'));
    expect(usePredictStructureStore.getState().target).toMatchObject({
      preferredRoot: '/ws/proteins/GFP.entity.json',
    });
  });

  it('requests tab removal when the authoritative package projection is orphaned', async () => {
    const entity = makeEntity({
      fields: {
        sequence: { mode: 'inline', aminoAcids: 'STALE', length: 5 },
        artifact: { schema: 'waypoint.entity.v1', relativePath: 'proteins/Gone.entity.json' },
      },
    });
    opsMock.queryLimsEntities.mockResolvedValue([entity]);
    saveMock.resolveProteinEntityArtifactRevision.mockResolvedValue({
      status: 'missing-authority',
    });

    const onUnavailable = renderProteinTab('uuid-1');

    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('protein-tab-missing-entity')).toBeNull();
    expect(screen.queryByTestId('protein-tab-error')).toBeNull();
    expect(seqMock.resolveAminoAcidSequence).not.toHaveBeenCalled();
  });
});

describe('ProteinSequenceTab — View Structure split-view  slice 1.4)', () => {
  const GFP = 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG';

  it('is absent until the sequence has resolved', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([makeEntity()]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: GFP,
      length: 33,
    });

    renderProteinTab('uuid-1');
    expect(screen.queryByTestId('protein-view-structure')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('protein-view-structure')).toBeTruthy());
  });

  it('opens the structure drawer and hands the store a request keyed by this entity', async () => {
    opsMock.queryLimsEntities.mockResolvedValue([makeEntity()]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: GFP,
      length: 33,
    });

    renderProteinTab('uuid-1');
    await waitFor(() => expect(screen.getByTestId('protein-view-structure')).toBeTruthy());

    expect(screen.queryByTestId('mock-structure-drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('protein-view-structure'));

    expect(drawerStoreMock.open).toHaveBeenCalledTimes(1);
    const request = drawerStoreMock.open.mock.calls[0][0];
    expect(request.entityId).toBe('uuid-1');
    expect(request.translation).toBe(GFP);
    expect(request.cdsBounds).toBeUndefined();
    expect(request.residueMolecule?.moleculeId).toContain('uuid-1');
    expect(screen.getByTestId('mock-structure-drawer')).toBeTruthy();
  });

  it("closes the drawer via the drawer content's own close callback", async () => {
    opsMock.queryLimsEntities.mockResolvedValue([makeEntity()]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: GFP,
      length: 33,
    });

    renderProteinTab('uuid-1');
    await waitFor(() => expect(screen.getByTestId('protein-view-structure')).toBeTruthy());
    fireEvent.click(screen.getByTestId('protein-view-structure'));
    expect(screen.getByTestId('mock-structure-drawer')).toBeTruthy();

    fireEvent.click(screen.getByTestId('mock-close-drawer'));
    expect(screen.queryByTestId('mock-structure-drawer')).toBeNull();
  });
});

describe('ProteinSequenceTab — right-click routing  interactive viewer)', () => {
  const GFP = 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEG';

  async function renderReady() {
    opsMock.queryLimsEntities.mockResolvedValue([makeEntity()]);
    seqMock.resolveAminoAcidSequence.mockResolvedValue({
      status: 'loaded',
      bases: GFP,
      length: 33,
    });
    renderProteinTab('uuid-1');
    await waitFor(() => expect(screen.getByTestId('protein-residue-track')).toBeTruthy());
  }

  it('right-clicking a residue opens the protein context menu', async () => {
    await renderReady();
    fireEvent.contextMenu(screen.getByTestId('protein-residue-1'));
    expect(screen.getByTestId('protein-sequence-context-menu')).toBeTruthy();
  });

  it('Copy Sequence with no selection copies the WHOLE sequence', async () => {
    await renderReady();
    fireEvent.contextMenu(screen.getByTestId('protein-residue-1'));
    fireEvent.click(screen.getByTestId('protein-menu-copy-sequence'));
    expect(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(GFP);
  });

  it('Copy Selection with a range selected copies only that substring', async () => {
    await renderReady();
    fireEvent.mouseDown(screen.getByTestId('protein-residue-2'), { button: 0 });
    fireEvent.mouseEnter(screen.getByTestId('protein-residue-5'));
    fireEvent.mouseUp(screen.getByTestId('protein-residue-5'));
    fireEvent.contextMenu(screen.getByTestId('protein-residue-5'));
    fireEvent.click(screen.getByTestId('protein-menu-copy-sequence'));
    expect(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      GFP.slice(1, 5)
    );
  });

  it('Backtranslate opens the result dialog scoped to the selection', async () => {
    await renderReady();
    fireEvent.mouseDown(screen.getByTestId('protein-residue-1'), { button: 0 });
    fireEvent.mouseEnter(screen.getByTestId('protein-residue-3'));
    fireEvent.mouseUp(screen.getByTestId('protein-residue-3'));
    fireEvent.contextMenu(screen.getByTestId('protein-residue-3'));
    fireEvent.click(screen.getByTestId('protein-menu-backtranslate'));
    expect(screen.getByTestId('backtranslate-result-dialog')).toBeTruthy();
    expect(screen.getByTestId('backtranslate-result-body').textContent).toHaveLength(9);
  });

  it('Ask AI about this protein calls askAiAboutProtein with the entity and current selection', async () => {
    await renderReady();
    fireEvent.contextMenu(screen.getByTestId('protein-residue-1'));
    fireEvent.click(screen.getByTestId('protein-menu-ask-ai'));
    expect(askAiMock.askAiAboutProtein).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'uuid-1', name: 'GFP' }),
      null
    );
  });

  it('View Structure is also reachable from the right-click menu', async () => {
    await renderReady();
    fireEvent.contextMenu(screen.getByTestId('protein-residue-1'));
    fireEvent.click(screen.getByTestId('protein-menu-view-structure'));
    expect(drawerStoreMock.open).toHaveBeenCalledTimes(1);
  });
});
