/** @vitest-environment jsdom */
import { StrictMode } from 'react';
import { EntityDetails } from '../../entity-details/public/EntityDetails';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  assertWorkspaceEditorsSettled,
  freezeWorkspaceEditorWrites,
} from '../../../services/workspace-editor-mutation-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSequencePackageDocument } from '../../../db/sequence-package';
import { SequenceMetadataDrawer } from './SequenceMetadataDrawer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useCanvasStore } from '../../canvas/public/store';
import { peekEntityDetailsSession } from '../../entity-details/public/session';

vi.mock('../../workspace-loader/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: vi.fn().mockResolvedValue(undefined),
}));
import { sequencePresentation } from '../../../shared/sequence-presentation';

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
  packageId: 'sequence-package-dirty-state',
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

describe('SequenceMetadataDrawer save state', () => {
  const mutation = { workspaceRoot: '/workspace', affectedEntityIds: [ref.packageId] };
  it('blocks Undo for a local metadata draft and an unmounted pending save', async () => {
    const view = render(
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
    await screen.findByTestId('sequence-metadata-name');
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Draft' },
    });
    expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/unsaved/);
    expect(screen.getByTestId('entity-details-panel')).toHaveAttribute(
      'data-workspace-mutation-entity-id',
      ref.packageId
    );
    const pending = Promise.withResolvers<ReturnType<typeof packageDocument>>();
    mocks.updateMetadata.mockReturnValue(pending.promise);
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));
    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledOnce());
    view.unmount();
    expect(() => assertWorkspaceEditorsSettled(mutation)).toThrow(/still saving/);
    await act(async () => {
      pending.resolve(packageDocument());
      await pending.promise;
    });
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
  });
  it('refuses metadata persistence while the package workspace is frozen', async () => {
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
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Draft' },
    });
    const release = freezeWorkspaceEditorWrites(mutation);
    try {
      fireEvent.click(screen.getByTestId('sequence-metadata-save'));
      expect(mocks.updateMetadata).not.toHaveBeenCalled();
      expect(await screen.findByText(/project update is in progress/)).toBeVisible();
    } finally {
      release();
    }
  });
  beforeEach(async () => {
    useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Project', addedAt: 0 }] });
    mocks.resolve.mockReset();
    mocks.updateMetadata.mockReset();
    mocks.resolve.mockResolvedValue({ ref, document: packageDocument(), productPath: 'hidden.gb' });
    await peekEntityDetailsSession(ref.packageId)?.load();
  });

  it('commits an automatically opened name field under StrictMode before lifecycle actions', async () => {
    let document = packageDocument();
    mocks.updateMetadata.mockImplementation(async (_ref, update) => {
      document = update(document);
      mocks.resolve.mockResolvedValue({ ref, document, productPath: 'hidden.gb' });
      return document;
    });
    render(
      <StrictMode>
        <EntityDetails
          target={{ entityId: ref.packageId, managedSequence: ref }}
          host="metadata"
          nameEditRequestId={1}
          onClose={vi.fn()}
        />
      </StrictMode>
    );
    await screen.findByRole('textbox', { name: 'Name', exact: true });
    const input = screen.getByRole('textbox', { name: 'Name', exact: true });
    fireEvent.change(input, { target: { value: 'RenamedNativeAssembly' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledOnce());
    const session = peekEntityDetailsSession(ref.packageId)!;
    await waitFor(() => expect(session.getSnapshot().saving).toBe(false));
    expect(session.getSnapshot().error).toBeNull();
    expect(session.dirty).toBe(false);
    expect(() => assertWorkspaceEditorsSettled(mutation)).not.toThrow();
    const action = vi.fn(async () => 'Completed.');
    await act(async () => session.performAction(action));
    expect(action).toHaveBeenCalledOnce();
  });

  it('enables Save only while the package metadata differs from disk', async () => {
    const document = packageDocument();
    document.entity.fields.description = 'Saved description';
    mocks.resolve.mockResolvedValue({ ref, document, productPath: 'hidden.gb' });
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

    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const description = screen.getByRole('textbox', { name: 'Description' });
    const save = screen.getByTestId('sequence-metadata-save');
    expect(save).toBeDisabled();

    fireEvent.change(description, { target: { value: 'Changed description' } });
    expect(save).toBeEnabled();

    fireEvent.change(description, { target: { value: 'Saved description' } });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Topology' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Linear', exact: true }));
    });
    expect(save).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Topology' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Circular', exact: true }));
    });
    expect(screen.queryByTestId('sequence-metadata-save')).not.toBeInTheDocument();
  });

  it('keeps an invalid name pending until the field is discarded without losing staged metadata', async () => {
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
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Staged metadata' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit sequence name' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: '' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' });
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('required');
    expect(screen.getByTestId('sequence-metadata-save')).toBeDisabled();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard Name' }));
    expect(screen.getByTestId('sequence-metadata-name')).toHaveTextContent('Sequence name');
    expect(screen.getByRole('button', { name: 'Edit Description' })).toHaveTextContent(
      'Staged metadata'
    );
    expect(screen.getByTestId('sequence-metadata-save')).toBeEnabled();
  });

  it('disables Save after a newly filled optional field is cleared back to its missing saved value', async () => {
    const document = packageDocument();
    delete document.entity.fields.description;
    mocks.resolve.mockResolvedValue({ ref, document, productPath: 'hidden.gb' });
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        presentation={sequencePresentation('Sequence name')}
        sequenceLength={42}
        sequenceTopology="circular"
        sequence={{ ...sequence, annotations: [] }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const input = screen.getByRole('textbox', { name: 'Description' });
    const save = screen.getByTestId('sequence-metadata-save');
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: 'New description' } });
    expect(save).toBeEnabled();
    fireEvent.change(input, { target: { value: '' } });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });
  it('keeps a Registry edit request until loaded fields enter editing, with unchanged Save disabled', async () => {
    const before = useCanvasStore.getState();
    const pending = Promise.withResolvers<{
      ref: typeof ref;
      document: ReturnType<typeof packageDocument>;
      productPath: string;
    }>();
    mocks.resolve.mockReturnValue(pending.promise);
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          activeTabId: 'registry-edit-sequence',
          tabs: [
            {
              id: 'registry-edit-sequence',
              entityId: ref.packageId,
              type: 'sequence',
              label: 'Sequence name',
              viewState: { metadataEditRequestId: 'registry-request' },
            },
          ],
        },
      },
    });
    const view = render(
      <SequenceMetadataDrawer
        metadataEditorTabId="registry-edit-sequence"
        documentRef={ref}
        sequenceDocumentId={ref.packageId}
        filePath="/workspace/sequence-package-dirty-state/physical-file.gb"
        presentation={sequencePresentation('Sequence name')}
        sequenceLength={42}
        sequenceTopology="circular"
        sequence={{ ...sequence, annotations: [] }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    try {
      expect(useCanvasStore.getState().panels.main.tabs[0].viewState?.metadataEditRequestId).toBe(
        'registry-request'
      );
      expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
      const document = packageDocument();
      document.entity.fields.description = 'Saved description';
      await act(async () => {
        pending.resolve({ ref, document, productPath: 'hidden.gb' });
      });
      const description = await screen.findByRole('textbox', { name: 'Description' });
      expect(description).toHaveValue('Saved description');
      expect(screen.getByTestId('entity-details-panel')).toHaveAttribute('data-editing', 'true');
      expect(
        useCanvasStore.getState().panels.main.tabs[0].viewState?.metadataEditRequestId
      ).toBeUndefined();
      const save = screen.getByTestId('sequence-metadata-save');
      expect(save).toBeDisabled();
      fireEvent.change(description, { target: { value: 'Changed description' } });
      expect(save).toBeEnabled();
      fireEvent.change(description, { target: { value: 'Saved description' } });
      expect(save).toBeDisabled();
      fireEvent.click(save);
      expect(mocks.updateMetadata).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      useCanvasStore.setState({ panels: before.panels });
    }
  });
});
