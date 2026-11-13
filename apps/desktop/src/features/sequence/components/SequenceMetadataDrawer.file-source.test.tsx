/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { SequenceMetadataDrawer as ActualDrawer } from './SequenceMetadataDrawer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { peekEntityDetailsSession } from '../../entity-details/public/session';
function SequenceMetadataDrawer(props: Parameters<typeof ActualDrawer>[0]) {
  mocks.sequence = props.sequence;
  return <ActualDrawer {...props} />;
}
import { sequencePresentation } from '../../../shared/sequence-presentation';
import type { AcceptedAssemblySidecarPayload } from '../../assembly/public/accepted-types';

const mocks = vi.hoisted(() => ({
  sequence: null as AnnotatedSequence | null,
  resolve: vi.fn(),
  updateMetadata: vi.fn(),
  setGeneticCode: vi.fn(),
  register: vi.fn(),
}));
vi.mock('../managed-sequence-repository', () => ({ managedSequenceRepository: mocks }));
vi.mock('../set-sequence-genetic-code', () => ({
  setSequenceGeneticCodeOnDocument: mocks.setGeneticCode,
}));
vi.mock('../../lims/registration-badge', () => ({
  useLimsRegistrationBadge: () => ({ status: 'not_registered', entity: null }),
}));
vi.mock('../../lims/register-open-sequence', () => ({ registerOpenSequenceFile: mocks.register }));
vi.mock('../../workspace-loader/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../services/entity-registry-reference', () => ({
  resolveEntityRegistryReference: vi.fn().mockResolvedValue(null),
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
    fs: {
      readTextFile: async () => JSON.stringify(mocks.sequence),
      stat: async () => ({ size: 42 }),
      exists: async () => false,
    },
  }),
}));
vi.mock('../../../shared/parse-sequence-file', () => ({
  parseTextSequenceFileAsAnnotated: (content: string) => ({ sequence: JSON.parse(content) }),
}));

const props = {
  sequenceDocumentId: 'catalog-document-1',
  filePath: '/workspace/sequence.gb',
  presentation: sequencePresentation('Sequence name'),
  sequenceLength: 42,
  sequenceTopology: 'linear' as const,
  sequence: {
    id: 'catalog-document-1',
    name: 'Sequence name',
    sequence: '',
    length: 42,
    annotations: [],
    circular: false,
  } satisfies AnnotatedSequence,
  onClose: vi.fn(),
  onSaved: vi.fn(),
};

function chooseCode() {
  fireEvent.click(screen.getByRole('button', { name: 'Edit Genetic code' }));
  fireEvent.click(screen.getByTestId('genetic-code-option-3'));
}

afterEach(async () => {
  cleanup();
  peekEntityDetailsSession(props.sequenceDocumentId)?.discard();
  await Promise.resolve();
});

describe('Metadata for a cataloged sequence file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace', name: 'Project', addedAt: 0, pinned: false }],
    });
    mocks.setGeneticCode.mockImplementation(async ({ geneticCode }) => {
      if (mocks.sequence) mocks.sequence = { ...mocks.sequence, chosenGeneticCode: geneticCode };
      return { ok: true, savedToFile: true };
    });
    mocks.register.mockResolvedValue({ alreadyRegistered: false });
  });

  it.each([false, true])(
    'retains a legacy saved recipe in Metadata, readOnly=%s',
    async (readOnly) => {
      const acceptedAssemblyRecord: AcceptedAssemblySidecarPayload = {
        type: 'accepted_assembly',
        schemaVersion: 1,
        acceptedAssemblyVersionId: 'legacy-accepted',
        acceptedAt: '2026-10-22T12:00:00Z',
        designId: 'legacy-design',
        designName: 'Legacy assembly',
        construction: {
          method: 'gibson',
          topology: 'linear',
          canonicalDraftChecksum: 'sha256:canonical',
          regionCount: 1,
          spacerCount: 0,
        },
        projectionInput: {
          schemaVersion: 1,
          designId: 'legacy-design',
          designName: 'Legacy assembly',
          topology: 'linear',
          assemblyMethod: 'gibson',
          backboneSequenceId: null,
          defaultHomologyLength: 30,
          productSequence: 'ACGT',
          canonicalDraftChecksum: 'sha256:canonical',
          regions: [
            {
              id: 'legacy-part',
              sourceSequenceId: 'source',
              sourceSequenceName: 'Legacy source',
              sourceType: 'pcr',
              sourceStart: 0,
              sourceEnd: 4,
              sequence: 'ACGT',
              annotations: [],
            },
          ],
          spacers: [],
          homologyRegions: [],
          designPrimers: [],
          sourceProvenance: [],
        },
        validationSnapshot: {
          schemaVersion: 1,
          designId: 'legacy-design',
          designVersion: 1,
          assemblyMethod: 'gibson',
          projectionInputChecksum: 'sha256:canonical',
          validatedAt: '2026-10-22T12:00:00Z',
          clean: true,
          issues: [],
        },
        artifacts: {
          productGenBankPath: props.filePath,
          sidecarJsonPath: '/workspace/sequence.waypoint-assembly.json',
          primerCsvPath: '',
          primerFastaPath: '',
          productSequenceChecksum: 'sha256:product',
          primerCsvChecksum: '',
          primerFastaChecksum: '',
          canonicalDraftChecksum: 'sha256:canonical',
        },
      };
      const onReopenAssembly = vi.fn().mockResolvedValue(undefined);
      const input = {
        ...props,
        readOnly,
        acceptedAssemblyRecord,
        onReopenAssembly,
        assemblyReopenStatus: 'available' as const,
      };
      render(<SequenceMetadataDrawer {...input} />);
      expect(await screen.findByTestId('sequence-assembly-history')).toHaveTextContent(
        'Legacy source'
      );
      if (readOnly) {
        expect(screen.queryByTestId('metadata-edit-assembly')).not.toBeInTheDocument();
      } else {
        fireEvent.click(screen.getByTestId('metadata-edit-assembly'));
        expect(onReopenAssembly).toHaveBeenCalledTimes(1);
      }
      expect(mocks.updateMetadata).not.toHaveBeenCalled();
      expect(mocks.setGeneticCode).not.toHaveBeenCalled();
    }
  );

  it('uses the common Metadata controls and the existing genetic-code save operation', async () => {
    render(<SequenceMetadataDrawer {...props} />);
    expect(await screen.findByTestId('sequence-metadata-name')).toHaveTextContent('Sequence name');
    expect(screen.getByTestId('sequence-metadata-size')).toHaveTextContent('42 bp');
    expect(screen.getByRole('status', { name: 'Topology' })).toHaveTextContent('Linear');
    expect(screen.queryByRole('combobox', { name: 'Topology' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('sequence-metadata-rename-button')).not.toBeInTheDocument();
    chooseCode();
    expect(mocks.setGeneticCode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));
    await waitFor(() =>
      expect(mocks.setGeneticCode).toHaveBeenCalledWith({
        documentId: props.sequenceDocumentId,
        geneticCode: 3,
        folders: [{ path: '/workspace', name: 'Project', addedAt: 0, pinned: false }],
      })
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('cancels a pending choice without saving or registering', async () => {
    render(<SequenceMetadataDrawer {...props} />);
    await screen.findByTestId('sequence-metadata-name');
    chooseCode();
    fireEvent.click(screen.getByTestId('sequence-metadata-cancel'));
    await waitFor(() =>
      expect(screen.queryByTestId('sequence-metadata-save')).not.toBeInTheDocument()
    );
    expect(mocks.setGeneticCode).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('uses the presentation name rather than the physical filename or recorded locus', async () => {
    render(
      <SequenceMetadataDrawer
        {...props}
        filePath="/workspace/physical-sequence.gb"
        sequence={{ ...props.sequence, name: 'RAW_LOCUS' }}
        presentation={sequencePresentation('Friendly sequence.v2')}
      />
    );
    const name = await screen.findByTestId('sequence-metadata-name');
    expect(name).toHaveTextContent('Friendly sequence.v2');
    chooseCode();
    fireEvent.click(screen.getByTestId('sequence-metadata-cancel'));
    expect(name).toHaveTextContent('Friendly sequence.v2');
  });

  it('presents fixed name and topology as labeled selectable values, without edit controls', async () => {
    render(<SequenceMetadataDrawer {...props} />);
    const name = await screen.findByRole('status', { name: 'Sequence name' });
    const topology = screen.getByRole('status', { name: 'Topology' });
    expect(name).toHaveTextContent('Sequence name');
    expect(topology).toHaveTextContent('Linear');
    expect(name.tagName).toBe('OUTPUT');
    expect(topology.tagName).toBe('OUTPUT');
    expect(name).toHaveClass('select-text');
    expect(topology).toHaveClass('select-text');
    expect(screen.queryByRole('textbox', { name: 'Sequence name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Topology' })).not.toBeInTheDocument();
    const range = document.createRange();
    range.selectNodeContents(name);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toBe('Sequence name');
    selection?.removeAllRanges();
    expect(screen.queryByTestId('sequence-metadata-save')).not.toBeInTheDocument();
    expect(mocks.setGeneticCode).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('shows the actual circular topology without an editing affordance', async () => {
    render(
      <SequenceMetadataDrawer
        {...props}
        sequenceTopology="circular"
        sequence={{ ...props.sequence, circular: true }}
      />
    );
    expect(await screen.findByRole('status', { name: 'Topology' })).toHaveTextContent('Circular');
    expect(screen.queryByRole('combobox', { name: 'Topology' })).not.toBeInTheDocument();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps a failed save visible and preserves the pending choice', async () => {
    mocks.setGeneticCode.mockResolvedValue({
      ok: false,
      error: 'unsaved_edits',
      message: 'That sequence document has unsaved edits.',
    });
    render(<SequenceMetadataDrawer {...props} />);
    await screen.findByTestId('sequence-metadata-name');
    chooseCode();
    fireEvent.click(screen.getByTestId('sequence-metadata-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Save or discard this document’s content before editing its metadata.'
    );
    expect(screen.getByRole('button', { name: 'Edit Genetic code' })).toHaveTextContent(
      /Yeast Mitochondrial/i
    );
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('runs the existing registration process from the same drawer', async () => {
    render(<SequenceMetadataDrawer {...props} />);
    await screen.findByTestId('sequence-metadata-name');
    fireEvent.click(screen.getByTestId('sequence-metadata-register'));
    fireEvent.click(screen.getByTestId('lims-registration-kind-sequence'));
    await waitFor(() =>
      expect(mocks.register).toHaveBeenCalledWith({
        documentId: props.sequenceDocumentId,
        sourcePath: props.filePath,
        kind: 'sequence',
      })
    );
    expect(mocks.setGeneticCode).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it('keeps a read-only sequence inspectable without offering edits or registration', async () => {
    render(<SequenceMetadataDrawer {...props} readOnly />);
    await screen.findByTestId('sequence-metadata-name');
    expect(screen.getByRole('button', { name: 'Edit Genetic code' })).toBeDisabled();
    expect(screen.queryByTestId('sequence-metadata-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sequence-metadata-register')).not.toBeInTheDocument();
    expect(mocks.setGeneticCode).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });
});
