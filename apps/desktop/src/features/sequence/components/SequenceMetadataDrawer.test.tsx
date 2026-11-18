/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { buildSequencePackageDocument } from '../../../db/sequence-package';
import {
  buildCustomGeneticCode,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import { SequenceMetadataDrawer as ActualDrawer } from './SequenceMetadataDrawer';
import { peekEntityDetailsSession } from '../../entity-details/public/session';
function SequenceMetadataDrawer(props: Parameters<typeof ActualDrawer>[0]) {
  mocks.sequence = props.sequence;
  return <ActualDrawer {...props} />;
}
afterEach(() => {
  cleanup();
  peekEntityDetailsSession(ref.packageId)?.discard();
  mocks.registeredLifecycle = false;
});
import { useSequenceStore } from '../store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { listProjectEditFolders } from '../../workspace-loader/public/project-edit-folders';

vi.mock('../../workspace-loader/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: vi.fn().mockResolvedValue(undefined),
}));
import { sequencePresentation } from '../../../shared/sequence-presentation';

const mocks = vi.hoisted(() => ({
  sequence: null as AnnotatedSequence | null,
  registeredLifecycle: false,
  resolve: vi.fn(),
  updateMetadata: vi.fn(),
  parseAcceptedAssemblyPayload: vi.fn(),
  getLimsSchemas: vi.fn(),
  openAssemblySourceRegion: vi.fn(),
  organizationSync: vi.fn(),
}));

vi.mock('../../lims/public/organization-record-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lims/public/organization-record-status')>()),
  useOrganizationRecordSync: mocks.organizationSync,
}));

vi.mock('../managed-sequence-repository', () => ({
  managedSequenceRepository: mocks,
}));

vi.mock('../../assembly/accepted-reopen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../assembly/public/accepted-reopen')>()),
  parseAcceptedAssemblyPayload: mocks.parseAcceptedAssemblyPayload,
}));

vi.mock('../../lims/public/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lims/public/operations')>()),
  getLimsSchemas: mocks.getLimsSchemas,
  getLimsEntityHistory: vi.fn().mockResolvedValue([]),
  queryLimsPendingRefs: vi.fn().mockResolvedValue([]),
  getLimsRegistryPreview: async () => {
    const resolved = await mocks.resolve(ref);
    const document = resolved.document;
    return {
      entity: {
        id: ref.packageId,
        name: document.name,
        kind: 'sequence',
        fields: document.entity.fields,
        registrationStatus: document.entity.registrationStatus,
        registryId: document.entity.registryId,
      },
      schemaSnapshot: document.entity.schema,
      ...(mocks.registeredLifecycle ? { savedLifecycleAuthority: 'sequence_package' } : {}),
      summary: {
        id: ref.packageId,
        name: document.name,
        archived: document.entity.lifecycle?.archived ?? false,
        schemaSnapshot: document.entity.schema,
        fieldValues: document.entity.fields,
        representation: { canOpen: true, openTarget: { kind: 'managed_sequence', document: ref } },
      },
      incomingLinks: [],
      outgoingLinks: [],
    };
  },
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { readTextFile: async () => JSON.stringify(mocks.sequence), exists: async () => false },
  }),
}));
vi.mock('../../../shared/parse-sequence-file', () => ({
  parseTextSequenceFileAsAnnotated: (content: string) => ({ sequence: JSON.parse(content) }),
}));

vi.mock('../../assembly/public/open-assembly-source', () => ({
  openAssemblySourceRegion: mocks.openAssemblySourceRegion,
}));

const ref = {
  kind: 'managed-sequence' as const,
  packageId: 'sequence-package-1',
  packageRoot: '/workspace/sequence-package',
};

function packageDocument() {
  return buildSequencePackageDocument({
    id: ref.packageId,
    name: 'Sequence name',
    product: { file: 'physical-file.gb', topology: 'circular' },
  });
}

const sequenceFacts = {
  sequenceDocumentId: ref.packageId,
  filePath: '/workspace/sequence-package/physical-file.gb',
  presentation: sequencePresentation('Sequence name'),
  sequenceLength: 42,
  sequenceTopology: 'circular' as const,
  sequence: {
    id: 'seq',
    name: 'Sequence name',
    sequence: 'ACGT',
    length: 42,
    annotations: [],
    circular: true,
  } satisfies AnnotatedSequence,
};

describe('SequenceMetadataDrawer', () => {
  it('includes version history in the same metadata panel used by Registry', async () => {
    render(
      <SequenceMetadataDrawer
        {...sequenceFacts}
        documentRef={ref}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.getByText('Version history', { exact: true })).toBeVisible();
  });

  it('edits Topology with the shared dropdown and cancels without changing its value', async () => {
    render(
      <SequenceMetadataDrawer
        {...sequenceFacts}
        documentRef={ref}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Topology' }));
    const control = screen.getByRole('combobox', { name: 'Topology' });
    expect(control).toHaveAttribute('data-ui-control', 'select');
    expect(screen.getByRole('listbox', { name: 'Topology' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Circular' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const search = screen.getByRole('searchbox', { name: 'Search topology' });
    fireEvent.change(search, { target: { value: 'lin' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Linear' })).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Topology' })).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Edit Topology' })).toHaveTextContent('Circular');
    expect(screen.getByRole('button', { name: 'Edit Topology' })).toHaveFocus();
  });

  beforeEach(() => {
    useSequenceStore.setState({ sequences: {} });
    vi.mocked(listProjectEditFolders).mockResolvedValue([]);
    useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Project', addedAt: 0 }] });
    mocks.organizationSync.mockReturnValue({
      status: null,
      review: null,
      pendingResolution: null,
      resolving: false,
      busy: false,
      error: null,
    });
    mocks.resolve.mockReset();
    mocks.updateMetadata.mockReset();
    mocks.parseAcceptedAssemblyPayload.mockReset();
    mocks.getLimsSchemas.mockReset();
    mocks.openAssemblySourceRegion.mockReset().mockResolvedValue(undefined);
    mocks.parseAcceptedAssemblyPayload.mockImplementation((value) => ({
      ...value,
      artifacts: {
        productGenBankPath: `${ref.packageRoot}/physical-file.gb`,
        sidecarJsonPath: `${ref.packageRoot}/accepted-assembly.json`,
        productSequenceChecksum: `sha256:${createHash('sha256')
          .update(value.projectionInput?.productSequence ?? '')
          .digest('hex')}`,
        ...value.artifacts,
      },
      projectionInput: {
        assemblyMethod: value.construction?.method ?? 'gibson',
        topology: 'circular',
        productSequence: '',
        spacers: [],
        homologyRegions: [],
        designPrimers: [],
        ...value.projectionInput,
        regions: (value.projectionInput?.regions ?? []).map(
          (region: { annotations?: unknown[]; sequence?: string }) => ({
            ...region,
            sequence: region.sequence ?? '',
            annotations: region.annotations ?? [],
          })
        ),
        sourceProvenance: (value.projectionInput?.sourceProvenance ?? []).map(
          (source: { sourceAnnotations?: unknown[] }) => ({
            ...source,
            sourceAnnotations: source.sourceAnnotations ?? [],
          })
        ),
      },
    }));
    mocks.getLimsSchemas.mockResolvedValue([]);
    mocks.resolve.mockResolvedValue({ ref, document: packageDocument(), productPath: 'hidden.gb' });
    mocks.updateMetadata.mockImplementation(async (_ref, update, options) => {
      const resolved = await mocks.resolve(_ref);
      const document = update(resolved.document);
      mocks.resolve.mockResolvedValue({ ...resolved, document });
      if (options?.geneticCode !== undefined && mocks.sequence)
        mocks.sequence = { ...mocks.sequence, chosenGeneticCode: options.geneticCode ?? undefined };
      return document;
    });
  });

  it('explains reference ownership and prevents editing through Metadata', async () => {
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace', name: 'Dev Assets', addedAt: 0, pinned: true }],
    });
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.queryByTestId('sequence-metadata-rename-button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Topology' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Description' })).not.toBeInTheDocument();
    expect(screen.getByTestId('sequence-metadata-read-only')).toHaveTextContent('Dev Assets');
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it.each(['reference', 'archived'] as const)(
    'explains %s ownership when the sequence tab also supplies a read-only flag',
    async (reason) => {
      vi.mocked(listProjectEditFolders).mockResolvedValue([
        {
          path: '/workspace',
          name: 'Dev Assets',
          pinned: reason === 'reference',
          lifecycle: reason === 'archived' ? 'archived' : 'active',
        },
      ]);
      render(
        <SequenceMetadataDrawer
          documentRef={ref}
          {...sequenceFacts}
          readOnly
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      );
      await screen.findByTestId('sequence-metadata-name');
      expect(screen.getByTestId('sequence-metadata-read-only')).toHaveTextContent('Dev Assets');
      expect(screen.getByTestId('sequence-metadata-read-only')).toHaveTextContent(
        reason === 'reference' ? 'reference folder' : 'archive'
      );
      expect(screen.queryByRole('button', { name: 'Edit Description' })).not.toBeInTheDocument();
      expect(mocks.updateMetadata).not.toHaveBeenCalled();
    }
  );

  it('shows archived project ownership after native package resolution becomes unavailable', async () => {
    vi.mocked(listProjectEditFolders).mockResolvedValue([
      { path: '/workspace', name: 'Project', lifecycle: 'active' },
    ]);
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Description' })).toBeEnabled()
    );
    const originalSequence = JSON.stringify(mocks.sequence);
    mocks.resolve.mockRejectedValue(
      new Error('Scientific request does not match its active owning workspace.')
    );
    vi.mocked(listProjectEditFolders).mockResolvedValue([
      { path: '/workspace', name: 'Project', lifecycle: 'archived' },
    ]);
    await act(async () => {
      useWorkspaceStore.setState({
        folders: [{ path: '/workspace', name: 'Archived project', addedAt: 0 }],
      });
    });
    expect(await screen.findByTestId('sequence-metadata-read-only')).toHaveTextContent('archive');
    expect(screen.getByTestId('sequence-metadata-name')).toHaveTextContent('Sequence name');
    expect(screen.getByTestId('sequence-metadata-size')).toHaveTextContent('42');
    expect(screen.queryByRole('button', { name: 'Edit Description' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('sequence-metadata-rename-button')).not.toBeInTheDocument();
    expect(JSON.stringify(mocks.sequence)).toBe(originalSequence);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps a package readable when its owning project is unavailable', async () => {
    useWorkspaceStore.setState({ folders: [] });
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.queryByTestId('sequence-metadata-rename-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('sequence-metadata-read-only')).toHaveTextContent(
      'project is unavailable'
    );
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps an active project editable when it is absent from the current window', async () => {
    useWorkspaceStore.setState({ folders: [] });
    vi.mocked(listProjectEditFolders).mockResolvedValue([
      { path: '/workspace', name: 'My project', lifecycle: 'active' },
    ]);
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    await waitFor(() =>
      expect(screen.getByTestId('sequence-metadata-rename-button')).toBeEnabled()
    );
    fireEvent.click(screen.getByTestId('sequence-metadata-rename-button'));
    const name = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Saved without a sidebar' } });
    fireEvent.blur(name);
    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the complete schema record with intrinsic sequence values', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    expect(await screen.findByTestId('sequence-metadata-name')).toHaveTextContent('Sequence name');
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.getByTestId('sequence-metadata-rename-button')).toBeInTheDocument();
    expect(screen.getByTestId('sequence-metadata-rename-button').lastElementChild).toHaveClass(
      'opacity-0'
    );
    expect(screen.getByTestId('sequence-metadata-size')).toHaveTextContent('42');
    expect(screen.getByRole('button', { name: 'Edit Topology' })).toHaveTextContent('Circular');
    expect(screen.queryByRole('combobox', { name: 'Topology' })).not.toBeInTheDocument();
    expect(screen.getByText('Description')).toBeVisible();
    const recordFields = screen.getByTestId('sequence-metadata-fields');
    const labels = ['Name', 'ID', 'Schema', 'Topology', 'Genetic code', 'Description'];
    expect(Array.from(recordFields.querySelectorAll('dt'), (row) => row.textContent)).toEqual(
      labels
    );
    for (const label of labels) {
      expect(within(recordFields).getByText(label)).toBeVisible();
    }
    const properties = screen.getByRole('region', { name: 'Sequence properties' });
    expect(within(properties).getByTestId('sequence-metadata-size')).toHaveTextContent('42');
    expect(within(properties).queryByRole('button')).not.toBeInTheDocument();
    expect(within(recordFields).queryByText('Size')).not.toBeInTheDocument();
    expect(screen.queryByText('tracked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sequence-metadata-add-field')).not.toBeInTheDocument();
    expect(screen.queryByText('Package details')).not.toBeInTheDocument();
  });

  it('updates derived Size from the shared viewed sequence without entering edit mode or writing', async () => {
    render(
      <SequenceMetadataDrawer
        {...sequenceFacts}
        documentRef={ref}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-size');
    act(() =>
      useSequenceStore.setState({
        sequences: { [ref.packageId]: { ...sequenceFacts.sequence, length: 84 } },
      })
    );
    expect(screen.getByTestId('sequence-metadata-size')).toHaveTextContent('84');
    expect(screen.queryByText('Editing', { exact: true })).not.toBeInTheDocument();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('uses the same instant edit affordance for name, schema, topology, and schema fields', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    const triggers = [
      screen.getByTestId('sequence-metadata-rename-button'),
      screen.getByRole('button', { name: 'Edit Schema' }),
      screen.getByRole('button', { name: 'Edit Topology' }),
      screen.getByRole('button', { name: 'Edit Description' }),
    ];
    for (const trigger of triggers) {
      expect(trigger).toHaveClass('group/field-edit', INTERACTION_CLASS);
      expect(trigger.className).not.toMatch(/transition|duration|delay/);
      expect(trigger.lastElementChild?.className).not.toMatch(/transition|duration|delay/);
    }
    expect(screen.getByTestId('sequence-metadata-name')).toHaveClass('font-semibold');
  });

  it('marks the entire record as editing and discards a selected genetic code without writing', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.queryByRole('button', { name: 'Update entity' })).not.toBeInTheDocument();
    chooseGeneticCode('genetic-code-option-4');
    expect(screen.getByTestId('entity-details-panel')).toHaveAttribute('data-editing', 'true');
    expect(screen.getByText('Editing')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update entity' })).toBeEnabled();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('button', { name: 'Edit Genetic code' })).toHaveTextContent(
      '1 — Standard'
    );
    await waitFor(() =>
      expect(screen.getByTestId('entity-details-panel')).toHaveAttribute('data-editing', 'false')
    );
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it.each(['Topology', 'Schema', 'Genetic code'])(
    'releases the %s editor when another metadata field is clicked',
    async (label) => {
      render(
        <SequenceMetadataDrawer
          documentRef={ref}
          {...sequenceFacts}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      );
      await screen.findByTestId('sequence-metadata-name');
      fireEvent.click(screen.getByRole('button', { name: `Edit ${label}` }));
      fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
      expect(screen.getByRole('button', { name: `Edit ${label}` })).toBeVisible();
      expect(screen.getAllByRole('textbox')).toHaveLength(1);
      expect(screen.getByRole('textbox', { name: 'Description' })).toHaveFocus();
      expect(mocks.updateMetadata).not.toHaveBeenCalled();
    }
  );

  it.each(['Topology', 'Schema', 'Genetic code'])(
    'Escape leaves %s editing without closing the drawer or changing its value',
    async (label) => {
      const onClose = vi.fn();
      render(
        <SequenceMetadataDrawer
          documentRef={ref}
          {...sequenceFacts}
          onClose={onClose}
          onSaved={vi.fn()}
        />
      );
      await screen.findByTestId('sequence-metadata-name');
      fireEvent.click(screen.getByRole('button', { name: `Edit ${label}` }));
      const active = document.activeElement;
      expect(active).not.toBe(document.body);
      if (!active) throw new Error('Expected the metadata editor to own keyboard focus.');
      fireEvent.keyDown(active, { key: 'Escape' });
      const trigger = screen.getByRole('button', { name: `Edit ${label}` });
      expect(trigger).toBeVisible();
      expect(trigger).toHaveFocus();
      expect(onClose).not.toHaveBeenCalled();
      expect(mocks.updateMetadata).not.toHaveBeenCalled();
      expect(screen.queryByTestId('sequence-metadata-save')).not.toBeInTheDocument();
    }
  );

  it('releases an intrinsic editor when clicking a non-focusable metadata label', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Topology' }));
    fireEvent.pointerDown(screen.getByText('ID', { exact: true }));
    expect(screen.getByRole('button', { name: 'Edit Topology' })).toBeVisible();
    expect(screen.queryByTestId('sequence-metadata-save')).not.toBeInTheDocument();
  });

  it('ignores a schema lookup failure after the user leaves its editor', async () => {
    let rejectLookup!: (reason: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectLookup = reject;
    });
    mocks.getLimsSchemas.mockReturnValue(pending);
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Schema' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    await act(async () => rejectLookup(new Error('Old schema lookup failed.')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveFocus();
  });

  it('saves a rename immediately without committing or discarding pending metadata', async () => {
    let durable = packageDocument();
    mocks.updateMetadata.mockImplementation(async (_ref, update) => (durable = update(durable)));
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    chooseGeneticCode('genetic-code-option-4');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'Pending description' } });
    fireEvent.blur(description);
    fireEvent.click(screen.getByTestId('sequence-metadata-rename-button'));
    const name = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(name, { target: { value: 'Immediate rename' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(durable.name).toBe('Immediate rename'));
    expect(durable.entity.fields.description).toBeUndefined();
    expect(mocks.updateMetadata.mock.calls[0][2]).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Edit Description' })).toHaveTextContent(
      'Pending description'
    );
    expect(screen.getByRole('button', { name: 'Edit Genetic code' })).toHaveTextContent('4 —');
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByTestId('sequence-metadata-name')).toHaveTextContent('Immediate rename');
    expect(screen.getByRole('button', { name: 'Edit Description' })).toHaveTextContent('-');
    expect(mocks.updateMetadata).toHaveBeenCalledTimes(1);
  });

  it('shows saved assembly versions and opens the existing design workflow', async () => {
    const document = packageDocument();
    document.assembly = {
      accepted: {
        acceptedAssemblyVersionId: 'accepted-2',
        acceptedAt: '2026-09-25T12:00:00Z',
        construction: { method: 'gibson' },
        projectionInput: {
          regions: [
            { id: 'backbone', sourceSequenceName: 'Backbone', sourceType: 'rd' },
            { id: 'insert', sourceSequenceName: 'Insert', sourceType: 'pcr' },
          ],
        },
      },
      history: [
        {
          acceptedAssemblyVersionId: 'accepted-1',
          acceptedAt: '2026-09-24T12:00:00Z',
          construction: { method: 'nebuilder' },
          projectionInput: {
            regions: [{ id: 'earlier', sourceSequenceName: 'Earlier part', sourceType: 'pcr' }],
          },
        },
      ],
    };
    mocks.resolve.mockResolvedValue({ ref, document, productPath: 'hidden.gb' });
    const onReopenAssembly = vi.fn().mockResolvedValue(undefined);
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onReopenAssembly={onReopenAssembly}
        assemblyReopenStatus="available"
      />
    );
    const history = await screen.findByTestId('sequence-assembly-history');
    expect(within(history).getByText('Gibson assembly · Current')).toBeInTheDocument();
    expect(within(history).getByText('NEBuilder assembly')).toBeInTheDocument();
    expect(within(history).getByText('Backbone')).toBeInTheDocument();
    expect(within(history).getByText('Insert')).toBeInTheDocument();
    fireEvent.click(within(history).getByRole('button', { name: 'Edit assembly' }));
    expect(onReopenAssembly).toHaveBeenCalledTimes(1);
  });

  it('shows saved primer tails, binding sites, spacers and an origin-spanning overlap in Metadata', async () => {
    const document = packageDocument();
    const primer = (direction: 'forward' | 'reverse') => ({
      id: direction,
      name: direction === 'forward' ? 'F1-fwd' : 'F1-rev',
      sequence:
        direction === 'forward'
          ? 'AGTTTTCGCTTTGTGATGCTCGTCAGGGG'
          : 'ACACATGCAAGGCATTGAAATTGTTATCCGCTCAC',
      pbs: { start: 0, end: 20, sequence: 'TTTGTGATGCTCGTCAGGGG' },
      overhang: { length: 9, sequence: 'AGTTTTCGC' },
      direction,
      fragmentIndex: 0,
      junctionIndex: 0,
    });
    document.assembly = {
      accepted: {
        acceptedAssemblyVersionId: 'actual-shape-accepted',
        acceptedAt: '2026-10-22T20:00:00Z',
        construction: { method: 'gibson' },
        projectionInput: {
          topology: 'circular',
          productSequence: 'A'.repeat(846),
          regions: [
            {
              id: 'part',
              sourceSequenceName: 'pUC19',
              sourceType: 'pcr',
              sequence: 'A'.repeat(846),
              sourceStart: 0,
              sourceEnd: 846,
            },
          ],
          sourceProvenance: [],
          homologyRegions: [
            {
              id: 'origin-overlap',
              junctionIndex: 0,
              junctionPosition: 846,
              start: 837,
              end: 10,
              encoding: { onLeft: 9, onRight: 10 },
              metadata: { sequence: 'AGTTTTCGCTTTGTGATGC' },
            },
          ],
          spacers: [{ id: 'spacer', junctionIndex: 0, sequence: 'ATGCCT' }],
          designPrimers: [
            { fragmentIndex: 0, forward: primer('forward'), reverse: primer('reverse') },
          ],
        },
      },
    };
    mocks.resolve.mockResolvedValue({ ref, document });
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const metadata = await screen.findByTestId('sequence-metadata-drawer');
    expect(await within(metadata).findByText('19 bp overlap')).toBeVisible();
    expect(within(metadata).getByText('AGTTTTCGCTTTGTGATGC')).toBeVisible();
    expect(within(metadata).getByText('9 bp from left · 10 bp from right')).toBeVisible();
    expect(within(metadata).getByText('ATGCCT')).toBeVisible();
    expect(within(metadata).getByText(primer('forward').sequence)).toBeVisible();
    expect(within(metadata).getByText(primer('reverse').sequence)).toBeVisible();
    expect(within(metadata).getAllByText('TTTGTGATGCTCGTCAGGGG')).toHaveLength(2);
    expect(within(metadata).getAllByText('AGTTTTCGC')).toHaveLength(2);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('previews saved assembly colors on section/fragment hover and opens the actual source on click', async () => {
    const document = packageDocument();
    const part = {
      id: 'source-part',
      sourceSequenceId: 'catalog-source-1',
      sourceSequenceName: 'Original source',
      sourceType: 'pcr',
      sequence: sequenceFacts.sequence.sequence,
      sourceStart: 10,
      sourceEnd: 14,
      annotations: [],
    };
    const provenance = {
      regionId: part.id,
      sourceConstructId: part.sourceSequenceId,
      sourceAnnotations: [],
    };
    document.assembly = {
      accepted: {
        acceptedAssemblyVersionId: 'accepted-1',
        acceptedAt: '2026-09-25T12:00:00Z',
        construction: { method: 'gibson' },
        projectionInput: {
          productSequence: part.sequence,
          regions: [part],
          spacers: [],
          sourceProvenance: [provenance],
        },
      },
    };
    mocks.resolve.mockResolvedValue({ ref, document });
    const onAssemblyBackboneSegmentsChange = vi.fn();
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAssemblyBackboneSegmentsChange={onAssemblyBackboneSegmentsChange}
      />
    );
    const history = await screen.findByTestId('sequence-assembly-history');
    fireEvent.pointerEnter(history);
    await waitFor(() =>
      expect(onAssemblyBackboneSegmentsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ start: 0, end: 4, regionId: part.id, strokeWidth: 5.25 }),
      ])
    );
    const fragment = within(history).getByRole('button', { name: 'Open source Original source' });
    fireEvent.pointerEnter(fragment);
    await waitFor(() =>
      expect(onAssemblyBackboneSegmentsChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ regionId: part.id, strokeWidth: 7 }),
      ])
    );
    fireEvent.click(fragment);
    expect(mocks.openAssemblySourceRegion).toHaveBeenCalledWith(part, { provenance });
    fireEvent.pointerLeave(history);
    await waitFor(() =>
      expect(onAssemblyBackboneSegmentsChange).toHaveBeenLastCalledWith(undefined)
    );
  });

  it('explicitly adopts a custom sequence schema without discarding previous metadata', async () => {
    const document = packageDocument();
    document.entity.fields = { description: 'Prior description' };
    mocks.resolve.mockResolvedValue({ ref, document, productPath: 'hidden.gb' });
    mocks.getLimsSchemas.mockResolvedValue([
      {
        schemaId: 'custom-schema',
        currentRevisionId: 'custom-schema-v1',
        entityKind: 'custom_sequence',
        baseKind: 'sequence',
        displayName: 'Custom sequence',
        description: null,
        version: 1,
        builtin: false,
        fields: [{ key: 'source', label: 'Source', type: 'text' }],
      },
    ]);
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Schema' }));
    fireEvent.click(
      await screen.findByRole('option', { name: /Custom sequence.*custom_sequence.*v1/ })
    );
    expect(screen.getByRole('button', { name: 'Edit Source' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Additional details' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Source' }), { target: { value: 'Lab' } });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));
    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledTimes(1));
    const update = mocks.updateMetadata.mock.calls[0]?.[1];
    const next = update(document);
    expect(next.entity.schema.schemaRevisionId).toBe('custom-schema-v1');
    expect(next.entity.fields).toEqual({ description: 'Prior description', source: 'Lab' });
  });

  it('persists topology and schema fields as one package-backed record after an immediate rename', async () => {
    const onSaved = vi.fn();
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByTestId('sequence-metadata-rename-button'));
    const name = screen.getByTestId('sequence-metadata-name');

    fireEvent.change(name, { target: { value: 'Renamed sequence' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Topology' }));
    fireEvent.click(screen.getByRole('option', { name: 'Linear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, {
      target: { value: 'Stored in the shared record.' },
    });
    fireEvent.blur(description);
    expect(screen.getByRole('button', { name: 'Update entity' })).toBeEnabled();
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));

    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledTimes(2));
    const update = mocks.updateMetadata.mock.calls[1]?.[1];
    const next = update(packageDocument());
    expect(next.name).toBe('Sequence name');
    expect(next.entity.fields).toEqual({
      description: 'Stored in the shared record.',
    });
    expect(next.product.file).toBe('physical-file.gb');
    expect(next.product.topology).toBe('linear');

    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Renamed sequence' }),
      undefined
    );
  });

  it('preserves schema field types when editing package metadata', async () => {
    const document = packageDocument();
    document.entity.schema.fields = [{ key: 'markers', label: 'Markers', type: 'string_array' }];
    document.entity.fields = { markers: ['AmpR'] };
    mocks.resolve.mockResolvedValue({ ref, document, productPath: 'hidden.gb' });
    mocks.updateMetadata.mockImplementation(async (_ref, update) => update(document));

    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Markers' }));
    const markers = screen.getByRole('textbox', { name: 'Markers' });
    fireEvent.change(markers, { target: { value: 'AmpR\nKanR' } });
    fireEvent.blur(markers);
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));

    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledTimes(1));
    const update = mocks.updateMetadata.mock.calls[0]?.[1];
    expect(update(document).entity.fields.markers).toEqual(['AmpR', 'KanR']);
  });

  it('merges an unrelated Registry edit and refuses to overwrite the same field', async () => {
    const document = packageDocument();
    document.entity.schema.fields = [
      { key: 'description', label: 'Description', type: 'long_text' },
      { key: 'notes', label: 'Notes', type: 'long_text' },
    ];
    document.entity.fields = { description: 'Original', notes: 'Original notes' };
    mocks.resolve.mockResolvedValue({ ref, document, productPath: 'hidden.gb' });
    const latest = structuredClone(document);
    latest.entity.fields.notes = 'Changed in Registry';
    mocks.updateMetadata.mockImplementation(async (_ref, update) => update(latest));

    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Description' }));
    const description = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(description, { target: { value: 'Drawer edit' } });
    fireEvent.blur(description);
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));
    await waitFor(() => expect(mocks.updateMetadata).toHaveBeenCalledTimes(1));
    const update = mocks.updateMetadata.mock.calls[0]?.[1];
    expect(update(latest).entity.fields).toEqual({
      description: 'Drawer edit',
      notes: 'Changed in Registry',
    });

    const conflicting = structuredClone(latest);
    conflicting.entity.fields.description = 'Changed in Registry too';
    expect(() => update(conflicting)).toThrow(/description changed elsewhere/i);
  });

  function declaring(code: string, count: number): Annotation[] {
    return Array.from({ length: count }, (_, i) => ({
      name: `cds${i}`,
      type: 'CDS',
      start: 1,
      end: 3,
      direction: 1 as const,
      qualifiers: { transl_table: [code] },
    }));
  }

  function chooseGeneticCode(optionTestId: string) {
    fireEvent.click(screen.getByRole('button', { name: 'Edit Genetic code' }));
    fireEvent.click(screen.getByTestId(optionTestId));
  }

  it("shows the genetic code control in Metadata, reading the file's own code", async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        sequence={{ ...sequenceFacts.sequence, annotations: declaring('3', 19) }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.getByRole('button', { name: 'Edit Genetic code' }).textContent).toBe(
      '3 — Yeast Mitochondrial'
    );
    expect(screen.queryByText(/nothing in this file declares a code/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('sequence-metadata-genetic-code-status')).not.toBeInTheDocument();
  });

  it('stages a chosen code until Save, then writes it into the file', async () => {
    const onSaved = vi.fn();
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );
    await screen.findByTestId('sequence-metadata-name');

    chooseGeneticCode('genetic-code-option-3');
    expect(screen.getByRole('button', { name: 'Edit Genetic code' }).textContent).toBe(
      '3 — Yeast Mitochondrial'
    );
    expect(screen.queryByTestId('sequence-metadata-genetic-code-pending')).not.toBeInTheDocument();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Update entity'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0][1]).toBe(3);

    expect(mocks.updateMetadata.mock.calls[0][2]).toEqual({ geneticCode: 3 });
  });

  it('reports going back to what the file declares as null, not as absent', async () => {
    const onSaved = vi.fn();
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        sequence={{
          ...sequenceFacts.sequence,
          annotations: declaring('3', 19),
          chosenGeneticCode: 4,
        }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    );
    await screen.findByTestId('sequence-metadata-name');

    chooseGeneticCode('genetic-code-option-3');
    expect(screen.queryByTestId('sequence-metadata-genetic-code-pending')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Update entity'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    expect(onSaved.mock.calls[0][1]).toBeNull();
    expect(mocks.updateMetadata.mock.calls[0][2]).toEqual({ geneticCode: null });
  });

  it('enables Save for a genetic-code change alone, and Cancel restores it', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.queryByText('Update entity')).not.toBeInTheDocument();

    chooseGeneticCode('genetic-code-option-4');
    expect(screen.getByText('Update entity')).not.toBeDisabled();

    fireEvent.click(screen.getByText('Discard changes'));
    expect(screen.getByRole('button', { name: 'Edit Genetic code' })).toHaveTextContent(
      '1 — Standard'
    );
    expect(screen.queryByTestId('sequence-metadata-genetic-code-pending')).toBeNull();
  });
});

describe('SequenceMetadataDrawer and custom genetic codes', () => {
  const DRAFT = {
    name: 'Amber suppression (pAzF at TAG)',
    base: 11,
    changes: { TAG: { kind: 'residue' as const, residue: 'pAzF' } },
    residues: [{ abbreviation: 'pAzF', name: 'p-azido-L-phenylalanine', ccd: 'AZF' }],
  };

  function onRevision1() {
    const built = buildCustomGeneticCode({ id: 'gc-3f2a9c1e', revision: 1, ...DRAFT });
    if (!built.ok) throw new Error('fixture must build');
    return { ...sequenceFacts.sequence, chosenGeneticCode: built.definition };
  }

  beforeEach(() => {
    mocks.organizationSync.mockReturnValue({
      status: null,
      review: null,
      pendingResolution: null,
      resolving: false,
      busy: false,
      error: null,
    });
    mocks.resolve.mockReset();
    mocks.updateMetadata.mockReset();
    mocks.resolve.mockResolvedValue({ ref, document: packageDocument(), productPath: 'hidden.gb' });
    mocks.updateMetadata.mockImplementation(async (_ref, update, options) => {
      const resolved = await mocks.resolve(_ref);
      const document = update(resolved.document);
      mocks.resolve.mockResolvedValue({ ...resolved, document });
      if (options?.geneticCode !== undefined && mocks.sequence)
        mocks.sequence = { ...mocks.sequence, chosenGeneticCode: options.geneticCode ?? undefined };
      return document;
    });
  });

  it('shows no update action when the record is current', async () => {
    render(
      <SequenceMetadataDrawer
        documentRef={ref}
        {...sequenceFacts}
        sequence={onRevision1()}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.queryByTestId('sequence-metadata-genetic-code-update')).toBeNull();
  });
});

it('shows both organization choices for the same saved package and reloads it after approval', async () => {
  useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Project', addedAt: 0 }] });
  mocks.resolve.mockResolvedValue({ ref, document: packageDocument(), productPath: 'hidden.gb' });
  const next = { ...packageDocument(), name: 'Organization sequence' };
  const resolve = vi.fn(async () => ({
    entity: { id: ref.packageId, workspaceId: 1 },
    request: { resolutionId: 'approved' },
    isCurrent: () => true,
  }));
  const finishResolution = vi.fn();
  const sync = {
    status: { status: 'remote_changes', baseRevision: 1 },
    review: {
      local: { name: 'Saved sequence', fields: {}, archived: false },
      organization: { name: 'Organization sequence', fields: {}, archived: false },
      organizationRevision: 2,
    },
    pendingResolution: null,
    resolving: false,
    busy: false,
    error: null,
    resolve,
    finishResolution,
    synchronize: vi.fn(),
    refresh: vi.fn(),
  };
  mocks.organizationSync.mockReturnValue(sync);
  const onSaved = vi.fn(),
    reload = vi.fn(async () => {});
  render(
    <SequenceMetadataDrawer
      documentRef={ref}
      {...sequenceFacts}
      onClose={vi.fn()}
      onSaved={onSaved}
      onReloadSavedSequence={reload}
    />
  );
  await screen.findByTestId('sequence-metadata-name');
  expect(screen.getByTestId('sequence-keep-saved')).toBeEnabled();
  mocks.resolve.mockResolvedValue({ ref, document: next, productPath: 'hidden.gb' });
  fireEvent.click(screen.getByTestId('sequence-use-organization'));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next, undefined));
  expect(resolve).toHaveBeenCalledWith('use_remote');
  expect(reload).toHaveBeenCalledTimes(1);
  expect(finishResolution).toHaveBeenCalledWith({ resolutionId: 'approved' });
  expect(screen.getByTestId('sequence-metadata-name')).toHaveTextContent('Organization sequence');
});

it('keeps organization resolution available after applying an archived registered sequence', async () => {
  useSequenceStore.setState({ sequences: {}, dirtyPaths: {} });
  useWorkspaceStore.setState({ folders: [{ path: '/workspace', name: 'Project', addedAt: 0 }] });
  vi.mocked(listProjectEditFolders).mockResolvedValue([]);
  mocks.registeredLifecycle = true;
  const next = {
    ...packageDocument(),
    entity: {
      ...packageDocument().entity,
      lifecycle: { archived: true, archivedAt: 2 },
    },
  };
  mocks.resolve.mockReset().mockResolvedValue({
    ref,
    document: packageDocument(),
    productPath: 'hidden.gb',
  });
  const resolve = vi.fn(async () => {
    mocks.resolve.mockResolvedValue({ ref, document: next, productPath: 'hidden.gb' });
    return {
      entity: { id: ref.packageId, workspaceId: 1 },
      request: { resolutionId: 'archived-approved' },
      isCurrent: () => true,
    };
  });
  const finishResolution = vi.fn();
  mocks.organizationSync.mockReturnValue({
    status: { status: 'remote_changes', baseRevision: 1 },
    review: {
      local: { name: next.name, fields: {}, archived: false },
      organization: { name: next.name, fields: {}, archived: true },
      organizationRevision: 2,
    },
    pendingResolution: null,
    resolving: false,
    busy: false,
    error: null,
    resolve,
    finishResolution,
    synchronize: vi.fn(),
    refresh: vi.fn(),
  });
  const reload = vi.fn(async () => {});
  render(
    <SequenceMetadataDrawer
      documentRef={ref}
      {...sequenceFacts}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onReloadSavedSequence={reload}
    />
  );
  await screen.findByTestId('sequence-metadata-name');
  fireEvent.click(screen.getByTestId('sequence-use-organization'));
  await waitFor(() => expect(finishResolution).toHaveBeenCalledTimes(1));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Restore this record before editing it.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Edit name' })).toBeNull();
  expect(screen.queryByTestId('sequence-metadata-save')).toBeNull();
  expect(screen.getByTestId('sequence-keep-saved')).toBeEnabled();
  fireEvent.click(screen.getByTestId('sequence-keep-saved'));
  await waitFor(() => expect(finishResolution).toHaveBeenCalledTimes(2));
  expect(resolve.mock.calls).toEqual([['use_remote'], ['keep_saved']]);
  expect(reload).toHaveBeenCalledTimes(2);
});
