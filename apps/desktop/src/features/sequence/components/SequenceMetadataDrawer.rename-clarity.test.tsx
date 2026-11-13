/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSequencePackageDocument } from '../../../db/sequence-package';
import { sequencePresentation } from '../../../shared/sequence-presentation';
import { clearManagedSequenceRenameRequest } from '../public/managed-sequence-rename';
import { SequenceMetadataDrawer } from './SequenceMetadataDrawer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { peekEntityDetailsSession } from '../../entity-details/public/session';

vi.mock('../../workspace-loader/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: vi.fn().mockResolvedValue(undefined),
}));

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  updateMetadata: vi.fn(),
}));

vi.mock('../managed-sequence-repository', () => ({
  managedSequenceRepository: mocks,
}));

vi.mock('../../lims/public/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lims/public/operations')>()),
  getLimsSchemas: vi.fn().mockResolvedValue([]),
  getLimsRegistryPreview: vi.fn().mockRejectedValue(new Error('No Registry projection')),
  getLimsEntityHistory: vi.fn().mockResolvedValue([]),
  queryLimsPendingRefs: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { readTextFile: async () => JSON.stringify(sequence), exists: async () => false },
  }),
}));
vi.mock('../../../shared/parse-sequence-file', () => ({
  parseTextSequenceFileAsAnnotated: (content: string) => ({ sequence: JSON.parse(content) }),
}));

const ref = {
  kind: 'managed-sequence' as const,
  packageId: 'sequence-package-rename-clarity',
  packageRoot: '/workspace/sequence-package-dirty-state',
};

function packageDocument() {
  return buildSequencePackageDocument({
    id: ref.packageId,
    name: 'Sequence name',
    product: { file: 'physical-file.gb', topology: 'circular' },
  });
}

const sequence = {
  id: 'seq',
  name: 'Sequence name',
  sequence: 'ACGT',
  length: 42,
  annotations: [],
  circular: true,
} as const;

afterEach(async () => {
  cleanup();
  peekEntityDetailsSession(ref.packageId)?.discard();
  await Promise.resolve();
});

describe('SequenceMetadataDrawer rename clarity', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Project', addedAt: 0 }] });
    clearManagedSequenceRenameRequest();
    mocks.resolve.mockReset();
    mocks.updateMetadata.mockReset();
    mocks.resolve.mockResolvedValue({ ref, document: packageDocument(), productPath: 'hidden.gb' });
    mocks.updateMetadata.mockImplementation(async (_ref, update) => {
      const resolved = await mocks.resolve(_ref);
      const document = update(resolved.document);
      mocks.resolve.mockResolvedValue({ ...resolved, document });
      return document;
    });
  });

  it('saves a name on blur independently of pending entity-field changes', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        sequenceDocumentId={ref.packageId}
        filePath="/workspace/sequence-package/physical-file.gb"
        presentation={sequencePresentation('Sequence name')}
        sequenceLength={42}
        sequenceTopology="circular"
        sequence={{ ...sequence, annotations: [] }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    expect(await screen.findByTestId('sequence-metadata-name')).toHaveTextContent('Sequence name');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Shown in the sequence tab/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Files item/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Renaming sequence/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sequence-metadata-rename-button'));
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveFocus();
    expect(name).toHaveValue('Sequence name');

    fireEvent.change(name, { target: { value: 'Renamed sequence' } });
    fireEvent.blur(name);
    await waitFor(() =>
      expect(screen.getByTestId('sequence-metadata-name')).toHaveTextContent('Renamed sequence')
    );
    expect(mocks.updateMetadata).toHaveBeenCalledOnce();
    const persisted = await mocks.updateMetadata.mock.results[0].value;
    expect(persisted.name).toBe('Renamed sequence');
    expect(persisted.product.topology).toBe('circular');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Topology' }));
    fireEvent.click(screen.getByRole('option', { name: 'Linear', exact: true }));
    expect(screen.getByRole('button', { name: 'Update entity' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByTestId('sequence-metadata-name')).toHaveTextContent('Renamed sequence');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Topology' })).toHaveTextContent('Circular');
    await waitFor(() =>
      expect(screen.queryByTestId('sequence-metadata-save')).not.toBeInTheDocument()
    );
    expect(mocks.updateMetadata).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Edit sequence name' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });

  it('selects the existing name when a tab rename opens the drawer', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        sequenceDocumentId={ref.packageId}
        filePath="/workspace/sequence-package/physical-file.gb"
        presentation={sequencePresentation('Sequence name')}
        sequenceLength={42}
        sequenceTopology="circular"
        sequence={{ ...sequence, annotations: [] }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        nameEditRequestId={1}
      />
    );

    const name = (await screen.findByRole('textbox', {
      name: 'Name',
    })) as HTMLInputElement;
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveFocus();
    expect(name).toHaveValue('Sequence name');
    expect(name.selectionStart).toBe(0);
    expect(name.selectionEnd).toBe('Sequence name'.length);

    cleanup();
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        sequenceDocumentId={ref.packageId}
        filePath="/workspace/sequence-package/physical-file.gb"
        presentation={sequencePresentation('Sequence name')}
        sequenceLength={42}
        sequenceTopology="circular"
        sequence={{ ...sequence, annotations: [] }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        nameEditRequestId={1}
      />
    );
    const reopened = await screen.findByTestId('sequence-metadata-name');
    await act(async () => {
      await Promise.resolve();
    });
    expect(reopened).toHaveTextContent('Sequence name');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('applies rename when reopening the same document supplies an equivalent reference', async () => {
    const props = {
      documentRef: ref,
      sequenceDocumentId: ref.packageId,
      filePath: '/workspace/sequence-package/physical-file.gb',
      presentation: sequencePresentation('Sequence name'),
      sequenceLength: 42,
      sequenceTopology: 'circular' as const,
      sequence: { ...sequence, annotations: [] },
      onClose: vi.fn(),
      onSaved: vi.fn(),
    };
    const view = render(<SequenceMetadataDrawer {...props} />);
    expect(await screen.findByTestId('sequence-metadata-name')).toHaveTextContent('Sequence name');
    await act(async () => {
      await Promise.resolve();
    });
    const initialReads = mocks.resolve.mock.calls.length;

    view.rerender(
      <SequenceMetadataDrawer {...props} documentRef={{ ...ref }} nameEditRequestId={2} />
    );
    await act(async () => {
      await Promise.resolve();
    });
    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).not.toHaveAttribute('readonly');
    expect(name).toHaveFocus();
    expect(mocks.resolve).toHaveBeenCalledTimes(initialReads);
  });
});
