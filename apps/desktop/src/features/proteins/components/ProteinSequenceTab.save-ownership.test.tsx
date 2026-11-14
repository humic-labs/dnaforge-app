import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
const h = vi.hoisted(() => ({
  save: vi.fn(),
  notices: vi.fn(),
  folders: [{ path: '/ws', name: 'Workspace', addedAt: 1 }],
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: unknown) => unknown) => select({ folders: h.folders }),
}));
vi.mock('../../../db/workspace-catalog', () => ({ getCatalogEntityForFilePath: async () => null }));
vi.mock('../../../services/native-catalog-destination', () => ({
  resolveNativeFastaSourceAuthority: () => null,
}));
vi.mock('../../lims/public/operations', () => ({
  queryLimsEntities: async ({ id }: { id: string }) => [
    {
      id,
      kind: 'protein',
      name: id,
      fields: {
        sequence: {
          mode: 'file',
          relPath: `${id}.faa`,
          length: 3,
          fileContentHash: 'a'.repeat(64),
        },
      },
      registryId: 'aa1',
      tombstone: false,
    },
  ],
}));
vi.mock('../../lims/public/protein-sequence', () => ({
  resolveAminoAcidSequence: async () => ({ status: 'loaded', bases: 'MKS', length: 3 }),
}));
vi.mock('../../lims/public/events', () => ({ subscribeLimsRegistrationChanged: () => () => {} }));
vi.mock('../../sequence/public/hooks/useDrawerState', () => ({
  useDrawerState: () => ({
    activeDrawer: null,
    drawerWidth: 300,
    openDrawer: () => {},
    closeDrawer: () => {},
    setDrawerWidth: () => {},
  }),
}));
vi.mock('../../sequence/public/components/SequenceDrawer', () => ({ SequenceDrawer: () => null }));
vi.mock('../../structure-drawer/public/components/StructureDrawerContent', () => ({
  StructureDrawerContent: () => null,
}));
vi.mock('../../structure-drawer/public/api/build-structure-request', () => ({
  buildStructureDrawerRequestFromProteinEntity: () => null,
}));
vi.mock('../../structure-drawer/public', () => ({
  useStructureDrawerStore: { getState: () => ({ open: () => {} }) },
}));
vi.mock('../../compute/public/SavedMolecularStructures', () => ({
  SavedMolecularStructures: () => null,
}));
vi.mock('../../compute/public/predict-structure', () => ({
  usePredictStructureStore: { getState: () => ({ open: () => {} }) },
}));
vi.mock('./ProteinSequenceContextMenu', () => ({ ProteinSequenceContextMenu: () => null }));
vi.mock('./BacktranslateResultDialog', () => ({ BacktranslateResultDialog: () => null }));
vi.mock('../ask-ai-about-protein', () => ({ askAiAboutProtein: () => {} }));
vi.mock('../../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: (...args: unknown[]) => h.notices(...args) }) },
}));
vi.mock('../save-protein-sequence', () => ({
  resolveProteinEntityArtifactRevision: () => null,
  saveProteinSequence: (...args: unknown[]) => h.save(...args),
}));
import { ProteinSequenceTab } from './ProteinSequenceTab';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const unavailable = () => {
  throw new Error('Unexpected unavailable');
};
beforeEach(() => {
  h.save.mockReset();
  h.notices.mockReset();
});
afterEach(cleanup);

describe('protein draft save ownership', () => {
  it('records the original write failure and retains the unsaved residues', async () => {
    const entityId = 'protein-a';
    const failure = new Error('EACCES: protein write denied');
    h.save.mockRejectedValueOnce(failure);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<ProteinSequenceTab entityId={entityId} onUnavailable={unavailable} />);
      fireEvent.click(await screen.findByTestId('protein-edit-sequence'));
      fireEvent.change(screen.getByLabelText('Amino-acid sequence'), { target: { value: 'MKW' } });
      fireEvent.click(screen.getByTestId('protein-save-sequence'));
      await waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          '[ProteinSequenceTab] Save failed:',
          { entityId },
          failure
        )
      );
      expect(screen.getByLabelText('Amino-acid sequence')).toHaveValue('MKW');
    } finally {
      report.mockRestore();
    }
  });

  it('keeps newer residues editable and uses the accepted revision for the next save', async () => {
    const pending = deferred();
    h.save.mockImplementationOnce(async ({ entity, bases }) => {
      await pending.promise;
      return { status: 'saved', entity, bases, expectedContentHash: 'b'.repeat(64) };
    });
    h.save.mockImplementationOnce(async ({ entity, bases }) => ({
      status: 'saved',
      entity,
      bases,
      expectedContentHash: 'c'.repeat(64),
    }));
    render(<ProteinSequenceTab entityId="protein-a" onUnavailable={unavailable} />);
    fireEvent.click(await screen.findByTestId('protein-edit-sequence'));
    const input = screen.getByLabelText('Amino-acid sequence');
    fireEvent.change(input, { target: { value: 'MKI' } });
    fireEvent.click(screen.getByTestId('protein-save-sequence'));
    fireEvent.change(input, { target: { value: 'MKW' } });
    await act(async () => {
      pending.resolve();
    });
    expect(screen.getByLabelText('Amino-acid sequence')).toHaveValue('MKW');
    expect(h.notices).not.toHaveBeenCalledWith('Protein sequence saved', expect.anything());
    fireEvent.click(screen.getByTestId('protein-save-sequence'));
    await screen.findByTestId('protein-residue-track');
    expect(h.save.mock.calls[1][0]).toMatchObject({
      bases: 'MKW',
      expectedContentHash: 'b'.repeat(64),
    });
    expect(screen.getByTestId('protein-residue-track')).toHaveTextContent('MKW');
  });

  it('does not replace another protein with a late save response', async () => {
    const pending = deferred();
    h.save.mockImplementationOnce(async ({ entity, bases }) => {
      await pending.promise;
      return { status: 'saved', entity, bases, expectedContentHash: 'b'.repeat(64) };
    });
    const view = render(<ProteinSequenceTab entityId="protein-a" onUnavailable={unavailable} />);
    fireEvent.click(await screen.findByTestId('protein-edit-sequence'));
    fireEvent.change(screen.getByLabelText('Amino-acid sequence'), { target: { value: 'MKI' } });
    fireEvent.click(screen.getByTestId('protein-save-sequence'));
    view.rerender(<ProteinSequenceTab entityId="protein-b" onUnavailable={unavailable} />);
    await screen.findByText('protein-b');
    await act(async () => {
      pending.resolve();
    });
    expect(screen.getByText('protein-b')).toBeVisible();
    expect(screen.queryByText('protein-a')).toBeNull();
    expect(h.notices).not.toHaveBeenCalled();
  });
});
