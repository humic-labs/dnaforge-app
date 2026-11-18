/** @vitest-environment jsdom */
import { documentLifecycle } from '../../../shared/document-lifecycle';
import { isTabDirty } from '../../canvas/public/artifact-document-lifecycle';

import { userMessage } from '@waypoint/user-messages';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/store';
import type { Tab } from '../../canvas/types';
import { useDesignStore } from '../../design/public/store';
import type { SequenceDesign } from '../../design/public/types';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { peekEntityDetailsSession } from '../../entity-details/public/session';
import { PrimerCreationTab } from './PrimerCreationTab';
import { PrimerPublicationPendingError } from '../primer-artifact-service';
import { useAuthStore } from '../../../stores/auth-store';
import { PrimerAcceptedSavePendingError } from '../primer-artifact-service';
import { buildPrimerArtifact } from '../public/primer-artifact';
import type { ScientificAcceptedDocumentRevision } from '@waypoint/domain-services';

const commandMocks = vi.hoisted(() => ({
  createPrimer: vi.fn(),
  listSchemas: vi.fn(),
  readArtifactAtPath: vi.fn(),
  updateArtifactContent: vi.fn(),
  resumeArtifactSave: vi.fn(),
  confirmDialog: vi.fn(),
  notifyBindingsChanged: vi.fn(),
  syncStatus: vi.fn(),
  syncReview: vi.fn(),
  resolveOrganization: vi.fn(),
  syncOrganization: vi.fn(),
  registryChanged: vi.fn(
    (_callback: (event: { accountId: string; orgId: string }) => void) => () => {}
  ),
  readCatalogFile: vi.fn(),
  readWorkspaceRoot: vi.fn(),
}));

let lastReadablePrimer: ReturnType<typeof existingPrimerRead> | undefined;

vi.mock('../../../platform', () => ({
  platform: () => ({
    cloudSync: {
      getOrganizationRegistryRecordSyncStatus: commandMocks.syncStatus,
      getOrganizationRegistrySavedRecordReview: commandMocks.syncReview,
      resolveOrganizationRegistrySavedRecord: commandMocks.resolveOrganization,
      syncOrganizationRegistry: commandMocks.syncOrganization,
      onOrganizationRegistryChanged: commandMocks.registryChanged,
    },
  }),
}));
vi.mock('../../workspace-loader/public/use-project-edit-folders', () => {
  const folders = [
    { path: '/workspace/project', name: 'Home', pinned: false, lifecycle: 'active' },
  ];
  return { useProjectEditFolders: () => folders };
});

vi.mock('../create-file-authoritative-primer', () => ({
  createFileAuthoritativePrimer: commandMocks.createPrimer,
}));

vi.mock('../primer-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primer-services')>();
  return {
    ...actual,
    primerServices: {
      ...actual.primerServices,
      persistence: {
        ...actual.primerServices.persistence,
        readArtifactAtPath: (...args: unknown[]) => readCurrentArtifact(...args),
        updateArtifactContent: commandMocks.updateArtifactContent,
        resumeArtifactSave: commandMocks.resumeArtifactSave,
        notifyBindingsChanged: commandMocks.notifyBindingsChanged,
      },
    },
  };
});

vi.mock('../../../components/confirm-dialog-store', () => ({
  confirmDialog: commandMocks.confirmDialog,
}));

vi.mock('../../lims/operations', () => ({
  getLimsSchemas: commandMocks.listSchemas,
  getLimsEntityHistory: async () => [],
  queryLimsPendingRefs: async () => [],
  getLimsRegistryPreview: async () => {
    const read = lastReadablePrimer ?? existingPrimerRead();
    const artifact = read.artifact;
    const schemas = await commandMocks.listSchemas();
    const schema = { ...artifact.entity.schema, fields: schemas[0].fields };
    const fields = {
      sequence: { mode: 'inline', ...artifact.sequence },
      use: 'primer',
      notes: artifact.metadata.notes,
      artifact: { schema: 'dnaforge.primer', revision: artifact.artifactRevision },
    };
    const entity = {
      id: artifact.registry.entityId,
      name: artifact.name,
      kind: 'oligo',
      fields,
      registrationStatus: 'registered',
      eventSeq: artifact.artifactRevision,
    };
    return {
      entity,
      schemaSnapshot: schema,
      summary: {
        id: entity.id,
        name: entity.name,
        archived: false,
        schemaSnapshot: schema,
        fieldValues: fields,
        representation: { canOpen: true },
      },
      incomingLinks: [],
      outgoingLinks: [],
    };
  },
}));
vi.mock('../../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/workspace-catalog')>()),
  getCatalogFileForPath: commandMocks.readCatalogFile,
  getWorkspaceRootById: commandMocks.readWorkspaceRoot,
  getCurrentCatalogFileForEntity: async () => ({
    path: '/workspace/project/oligos/Existing.primer.json',
  }),
  getCatalogWorkspaceRootForFilePath: async () => '/workspace/project',
}));
vi.mock('../../workspace-loader/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: async () => [],
}));
vi.mock('../primer-artifact-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../primer-artifact-service')>()),
  readPrimerArtifactAtPath: (...args: unknown[]) => readCurrentArtifact(...args),
  updatePrimerArtifactContent: commandMocks.updateArtifactContent,
  resumePrimerArtifactSave: commandMocks.resumeArtifactSave,
}));
async function readCurrentArtifact(...args: unknown[]) {
  const read = await commandMocks.readArtifactAtPath(...args);
  const latest = commandMocks.updateArtifactContent.mock.results.at(-1);
  let saved;
  try {
    saved = latest?.type === 'return' ? await latest.value : null;
  } catch (cause) {
    saved =
      cause instanceof PrimerAcceptedSavePendingError
        ? { artifact: cause.artifact, acceptedRevision: cause.acceptedRevision }
        : null;
  }
  const current = saved?.artifact
    ? {
        ...read,
        artifact: saved.artifact,
        ...(saved.acceptedRevision ? { acceptedRevision: saved.acceptedRevision } : {}),
      }
    : read;
  if (current) lastReadablePrimer = current;
  return current;
}
afterEach(() => {
  cleanup();
  peekEntityDetailsSession('20000000-0000-4000-8000-000000000001')?.discard();
});

vi.mock('../hooks/usePrimerTm', () => ({
  usePrimerTm: (sequence: string) => ({
    tm: sequence.length >= 10 ? 61.2 : null,
    ta: null,
    source: 'local',
    verified: false,
    unavailable: false,
    modelKind: 'local',
  }),
}));

vi.mock('./PrimerSaveLocationPicker', () => ({
  PrimerSaveLocationPicker: () => <div data-testid="primer-save-location-picker" />,
}));

const tab: Tab = {
  id: 'primer-tab-1',
  type: 'primer',
  entityId: 'primer-draft:1',
  label: 'Untitled Primer',
  artifactDocument: {
    kind: 'primer',
    persistence: 'draft',
    workspaceRoot: '/workspace/project',
    destinationPath: '/workspace/project/oligos',
  },
};

describe('PrimerCreationTab', () => {
  beforeEach(() => {
    commandMocks.createPrimer.mockReset();
    commandMocks.syncStatus.mockReset();
    commandMocks.syncReview.mockReset();
    commandMocks.resolveOrganization.mockReset();
    commandMocks.syncOrganization.mockReset();
    commandMocks.registryChanged.mockClear();
    commandMocks.readCatalogFile.mockReset();
    commandMocks.readWorkspaceRoot.mockReset();
    commandMocks.syncStatus.mockResolvedValue({ ok: true, accountId: 'account-a', status: null });
    commandMocks.readCatalogFile.mockResolvedValue(null);
    commandMocks.readArtifactAtPath.mockReset();
    lastReadablePrimer = undefined;
    commandMocks.updateArtifactContent.mockReset();
    commandMocks.resumeArtifactSave.mockReset();
    useAuthStore.setState({ state: { status: 'signed-out' } });
    commandMocks.confirmDialog.mockReset();
    commandMocks.notifyBindingsChanged.mockReset();
    commandMocks.confirmDialog.mockResolvedValue(true);
    commandMocks.listSchemas.mockResolvedValue([
      {
        schemaId: 'schema-entity-oligo',
        currentRevisionId: 'schema-entity-oligo-v1',
        entityKind: 'oligo',
        baseKind: 'oligo',
        displayName: 'Oligo',
        description: 'Primer-compatible oligo',
        version: 1,
        builtin: true,
        fields: [
          { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
          { key: 'use', label: 'Use', type: 'enum', enumOptions: ['primer'] },
          { key: 'notes', label: 'Notes', type: 'long_text' },
        ],
      },
      {
        schemaId: 'schema-qpcr-primer',
        currentRevisionId: 'schema-qpcr-primer-v2',
        entityKind: 'qpcr_primer',
        baseKind: 'primer',
        displayName: 'qPCR primer',
        description: 'A custom primer schema',
        version: 2,
        builtin: false,
        fields: [
          { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
          { key: 'use', label: 'Use', type: 'enum', enumOptions: ['primer'] },
          { key: 'assayId', label: 'Assay ID', type: 'text', required: true },
          { key: 'notes', label: 'Notes', type: 'long_text' },
        ],
      },
    ]);
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace/project', name: 'project', addedAt: 1 }],
    });
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [tab], activeTabId: tab.id },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      recentlyClosed: [],
      oversizeScanComplete: true,
    });
  });

  it('keeps base entry in the main pane and reuses the established primer design form in the right tool', async () => {
    render(<PrimerCreationTab tab={tab} panelId="main" />);

    await waitFor(() => expect(commandMocks.listSchemas).toHaveBeenCalled());

    expect(screen.getByRole('main', { name: 'Primer editor' })).toContainElement(
      screen.getByRole('textbox', { name: 'Primer sequence' })
    );
    expect(screen.getByTestId('primer-creation-form')).toContainElement(
      screen.getByTestId('primer-name-input')
    );
    expect(screen.queryByTestId('primer-metadata-drawer')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('primer-sequence-input')).toHaveLength(1);
    expect(screen.queryByText('New primer')).not.toBeInTheDocument();
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute('wrap', 'soft');
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
      'placeholder',
      'Type or paste bases · / for modifications'
    );
    expect(screen.getByTestId('primer-order-type')).toHaveTextContent('DNA Oligo');
    expect(screen.queryByTestId('primer-order-type-dna')).not.toBeInTheDocument();
    expect(screen.queryByTestId('primer-order-type-rna')).not.toBeInTheDocument();
    expect(screen.getByTestId('primer-sequence-input')).not.toHaveAttribute('rows', '10');
    expect(screen.getByRole('main', { name: 'Primer editor' }).className).toContain(
      'overflow-hidden'
    );
    expect(screen.getByTestId('primer-canvas-column').className).toContain('h-full');
    expect(screen.getByTestId('primer-canvas-column').className).toContain('min-h-0');
    expect(screen.getByTestId('primer-standalone-sequence-editor').className).toContain('flex-1');
    expect(screen.getByTestId('primer-standalone-sequence-editor').className).toContain('min-h-0');
    expect(screen.getByTestId('primer-standalone-sequence-editor').className).not.toContain(
      'border-y'
    );
    expect(screen.getByTestId('primer-sequence-five-prime')).toBeInTheDocument();
    expect(screen.queryByTestId('primer-validation-summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Primer sequence', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forward primer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse primer' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: 'ATCGATCGATCGATCGATCG' },
    });
    expect(screen.getAllByText('20 nt')).toHaveLength(2);
    expect(screen.getByTestId('primer-tm-value')).toHaveTextContent('61.2°C');
    expect(screen.getByText('50%')).toBeVisible();

    fireEvent.click(screen.getByTestId('primer-toolbar-metadata'));
    expect(screen.queryByTestId('primer-creation-form')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('primer-toolbar-metadata'));
    expect(screen.getByTestId('primer-creation-form')).toBeVisible();
  });

  it('reopens a closed metadata panel for a Registry request on the same primer tab', async () => {
    render(<PrimerCreationTab tab={tab} panelId="main" />);
    await waitFor(() => expect(commandMocks.listSchemas).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Metadata' }));
    expect(screen.queryByTestId('primer-creation-form')).not.toBeInTheDocument();
    act(() =>
      useCanvasStore.getState().setTabViewState('main', tab.id, {
        metadataEditRequestId: 'registry-request',
        sequenceViewportZoomLevel: 75,
      })
    );
    expect(await screen.findByTestId('primer-creation-form')).toBeVisible();
    expect(useCanvasStore.getState().panels.main.tabs[0].viewState).toMatchObject({
      metadataEditRequestId: undefined,
      sequenceViewportZoomLevel: 75,
    });
    expect(commandMocks.createPrimer).not.toHaveBeenCalled();
    expect(commandMocks.updateArtifactContent).not.toHaveBeenCalled();
  });

  it('keeps the canvas tab label synchronized with the one primer-name draft', async () => {
    render(<PrimerCreationTab tab={tab} panelId="main" />);
    await waitFor(() => expect(commandMocks.listSchemas).toHaveBeenCalled());

    expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Untitled Primer');
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Library_F1' },
    });
    expect(screen.getByTestId('primer-form-title')).toHaveTextContent('Library_F1');
    expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Library_F1');

    fireEvent.change(screen.getByTestId('primer-name-input'), { target: { value: '' } });
    expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Untitled DNA Oligo');
  });

  it('binds a new RNA oligo tab to RNA identity without a mutable type switch', async () => {
    const rnaTab: Tab = {
      ...tab,
      id: 'rna-oligo-tab',
      label: 'Untitled RNA Oligo',
      artifactDocument: { ...tab.artifactDocument!, orderType: 'rna' },
    };
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [rnaTab], activeTabId: rnaTab.id } },
      focusedPanelId: 'main',
    });

    render(<PrimerCreationTab tab={rnaTab} panelId="main" />);
    await waitFor(() => expect(commandMocks.listSchemas).toHaveBeenCalled());

    expect(screen.getByTestId('primer-order-type')).toHaveTextContent('RNA Oligo');
    expect(screen.getByTestId('primer-form-title')).toHaveTextContent('Untitled RNA Oligo');
    expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
      'placeholder',
      'Type or paste bases · / for modifications'
    );
    expect(screen.queryByTestId('primer-order-type-dna')).not.toBeInTheDocument();
  });

  it('shows optional schema fields directly without an Add field action', async () => {
    render(<PrimerCreationTab tab={tab} panelId="main" />);
    await waitFor(() => expect(commandMocks.listSchemas).toHaveBeenCalled());

    expect(screen.getByTestId('entity-schema-field-notes')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Add schema field' })).not.toBeInTheDocument();
  });

  it('switches to a primer-derived schema and saves its revision plus entered fields', async () => {
    commandMocks.createPrimer.mockResolvedValue({
      artifactPath: '/workspace/project/oligos/qPCR_F1.primer.json',
      artifact: { name: 'qPCR_F1' },
    });
    render(<PrimerCreationTab tab={tab} panelId="main" />);

    await waitFor(() => expect(commandMocks.listSchemas).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('primer-schema-select'));
    fireEvent.click(screen.getByRole('option', { name: 'qPCR primer' }));
    fireEvent.change(screen.getByTestId('entity-schema-field-assayId'), {
      target: { value: 'ASSAY-42' },
    });
    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: 'ATCGATCGATCGATCGATCG' },
    });
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'qPCR_F1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Primer' }));

    await waitFor(() =>
      expect(commandMocks.createPrimer).toHaveBeenCalledWith(
        expect.objectContaining({
          entitySchema: expect.objectContaining({
            schemaId: 'schema-qpcr-primer',
            schemaRevisionId: 'schema-qpcr-primer-v2',
            name: 'qpcr_primer',
            baseKind: 'primer',
          }),
          entityFields: { assayId: 'ASSAY-42' },
        })
      )
    );
  });

  it('saves one unbound file-authoritative primer and closes only its draft tab', async () => {
    commandMocks.createPrimer.mockResolvedValue({
      artifactPath: '/workspace/project/oligos/Library_F1.primer.json',
      artifact: { name: 'Library_F1' },
    });
    const changed = vi.fn();
    window.addEventListener('waypoint:workspace-files-changed', changed);
    render(<PrimerCreationTab tab={tab} panelId="main" />);

    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: 'ATCGATCGATCGATCGATCG' },
    });
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Library_F1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Primer' }));

    await waitFor(() => {
      expect(commandMocks.createPrimer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Library_F1',
          sequence: 'ATCGATCGATCGATCGATCG',
          artifactPath: '/workspace/project/oligos/Library_F1.primer.json',
          workspaceRoot: '/workspace/project',
          requireRegistry: true,
          origin: 'manual',
          entitySchema: expect.objectContaining({
            schemaId: 'schema-entity-oligo',
            schemaRevisionId: 'schema-entity-oligo-v1',
            baseKind: 'primer',
          }),
          entityFields: {},
        })
      );
    });
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener('waypoint:workspace-files-changed', changed);
  });

  it('saves an intentionally short valid primer without a scientific length veto', async () => {
    commandMocks.createPrimer.mockResolvedValue({
      artifactPath: '/workspace/project/oligos/Intentional_short.primer.json',
      artifact: { name: 'Intentional_short' },
    });
    render(<PrimerCreationTab tab={tab} panelId="main" />);
    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: 'ATCG' },
    });
    fireEvent.change(screen.getByTestId('primer-name-input'), {
      target: { value: 'Intentional_short' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Primer' }));
    await waitFor(() =>
      expect(commandMocks.createPrimer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Intentional_short',
          sequence: 'ATCG',
          requireRegistry: true,
        })
      )
    );
    expect(screen.queryByTestId('primer-form-error')).not.toBeInTheDocument();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('projects a loaded RNA oligo into the existing tab context', async () => {
    const existing = existingPrimerRead();
    const rnaArtifact = {
      ...existing.artifact,
      oligo: { ...existing.artifact.oligo, orderType: 'rna' as const },
    };
    commandMocks.readArtifactAtPath.mockResolvedValue({ ...existing, artifact: rnaArtifact });
    const savedTab = existingPrimerTab();
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [savedTab], activeTabId: savedTab.id } },
    });
    render(<SavedPrimerHarness />);
    await waitFor(() =>
      expect(useCanvasStore.getState().panels.main.tabs[0].artifactDocument?.orderType).toBe('rna')
    );
    expect(commandMocks.updateArtifactContent).not.toHaveBeenCalled();
    expect(commandMocks.createPrimer).not.toHaveBeenCalled();
  });

  it('opens an existing authoritative primer in the same editable tab', async () => {
    const existing = existingPrimerRead();
    commandMocks.readArtifactAtPath.mockResolvedValue(existing);
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);

    await waitFor(() =>
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        existing.artifact.oligo.notation
      )
    );
    expect(screen.getByTestId('primer-sequence-input')).toBeVisible();
    await screen.findByRole('button', { name: 'Edit Name' });
    expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent('Existing primer');
    expect(screen.queryByTestId('primer-creation-form')).not.toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Primer editor' })).not.toHaveTextContent(
      'Update entity'
    );
    expect(screen.queryByTestId('primer-save-location-picker')).not.toBeInTheDocument();
    expect(useCanvasStore.getState().panels.main.tabs[0].label).toBe('Existing primer');
  });

  it('lists the assemblies that use a saved oligo under its sequence editor', async () => {
    const path = '/workspace/project/oligos/Existing.primer.json';
    const tail = 'ACGTACGT';
    const binding = 'ACGTACGTACGT';
    const artifact = await buildPrimerArtifact({
      id: 'primer-existing',
      catalogNumber: 'P-3',
      name: 'Existing primer',
      sequence: `${tail}${binding}`,
      workspaceRoot: '/workspace/project',
      artifactPath: path,
      source: 'manual',
    });
    commandMocks.readArtifactAtPath.mockResolvedValue({
      path,
      content: '{}',
      artifact,
      resolvedBindings: [],
    });
    const designPrimer = (id: string, direction: 'forward' | 'reverse') => ({
      id,
      name: `F1 ${direction}`,
      sequence: `${tail}${binding}`,
      pbs: { start: 0, end: binding.length, sequence: binding },
      overhang: { length: tail.length, sequence: tail, tailLength: tail.length },
      direction,
      fragmentIndex: 0,
      junctionIndex: 0,
      tm: 58.2,
    });
    onTestFinished(() => useDesignStore.setState({ designs: {} }));
    useDesignStore.setState({
      designs: {
        'design-1': {
          topology: 'circular',
          assemblyState: 'ready',
          validationErrors: [],
          proposedPlans: [],
          defaultHomologyLength: 30,
          homologyRegions: [],
          selectedJunctionIndex: null,
          scrollToPosition: null,
          highlightRange: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          id: 'design-1',
          name: 'TamB Gibson',
          version: 12,
          assemblyMethod: 'gibson',
          spacers: [],
          regions: [],
          designPrimers: [
            {
              fragmentIndex: 0,
              forward: designPrimer('p-f', 'forward'),
              reverse: designPrimer('p-r', 'reverse'),
            },
          ],
          savedPrimerLinks: [
            {
              primerId: 'p-f',
              oligoId: artifact.id,
              artifactRevision: artifact.artifactRevision,
              sequenceContentHash: artifact.sequence.contentHash,
              linkedAtDesignVersion: 11,
              linkedAt: '2026-11-10T12:00:00.000Z',
              via: 'matched-existing',
            },
          ],
        } satisfies SequenceDesign,
      },
    });

    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);

    await screen.findByRole('main', { name: 'Primer editor' });
    const uses = await screen.findByTestId('primer-assembly-uses');
    expect(uses.closest('fieldset')).toBeNull();
    const use = within(uses).getByTestId('primer-assembly-use');
    expect(use).toHaveAttribute('data-design-id', 'design-1');
    expect(use).toHaveAttribute('data-primer-id', 'p-f');
    expect(use).toHaveAttribute('data-link-state', 'current');
    expect(within(use).getByTestId('primer-assembly-use-tail')).toHaveTextContent(
      `5′ tail (8 nt)${tail}`
    );
    expect(within(use).getByTestId('primer-assembly-use-binding')).toHaveTextContent(
      `Binding part (12 nt)${binding}`
    );
  });

  it('keeps a durably accepted Save dirty after a refresh failure and retries from the returned accepted revision', async () => {
    const path = '/workspace/project/oligos/Existing.primer.json';
    const artifact = await buildPrimerArtifact({
      id: 'primer-existing',
      catalogNumber: 'P-3',
      name: 'Existing primer',
      sequence: 'ACGTACGTACGTACGTACGT',
      workspaceRoot: '/workspace/project',
      artifactPath: path,
      source: 'manual',
    });
    const before: ScientificAcceptedDocumentRevision = {
      kind: 'accepted-object',
      resourceId: artifact.id,
      resourceRevisionId: `rr_${'a'.repeat(64)}`,
      workspaceVersionId: `wv_${'b'.repeat(64)}`,
      contentSha256: 'c'.repeat(64),
      sequenceEditParentEventId: null,
    };
    const after = {
      ...before,
      resourceRevisionId: `rr_${'d'.repeat(64)}`,
      workspaceVersionId: `wv_${'e'.repeat(64)}`,
    };
    const savedArtifact = { ...artifact, artifactRevision: 2, name: 'Changed primer' };
    commandMocks.readArtifactAtPath.mockResolvedValue({
      path,
      content: '{}',
      artifact,
      resolvedBindings: [],
      acceptedRevision: before,
    });
    commandMocks.updateArtifactContent.mockRejectedValueOnce(
      new PrimerAcceptedSavePendingError(
        savedArtifact,
        after,
        new Error('Save accepted; project refresh is pending.')
      )
    );
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);
    const editName = await screen.findByRole('button', { name: 'Edit Name' });
    expect(editName).toHaveTextContent('Existing primer');
    fireEvent.click(editName);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Changed primer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));
    expect(await screen.findByRole('button', { name: 'Retry save' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(userMessage('document.saveRefreshPending'));
    expect(useCanvasStore.getState().panels.main.tabs[0].isDirty).toBe(true);
    expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent('Changed primer');
    commandMocks.updateArtifactContent.mockResolvedValueOnce({
      artifactPath: path,
      artifact: savedArtifact,
      acceptedRevision: after,
      gitCommitted: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(commandMocks.updateArtifactContent).toHaveBeenCalledTimes(2));
    expect(commandMocks.updateArtifactContent.mock.calls[0][0]).toMatchObject({
      acceptedRevision: before,
    });
    expect(commandMocks.updateArtifactContent.mock.calls[1][0]).toMatchObject({
      expectedArtifactRevision: 2,
      acceptedRevision: after,
    });
    await waitFor(() => expect(useCanvasStore.getState().panels.main.tabs[0].isDirty).toBe(false));
  });

  it('keeps an attached scientific edit unsaved when impact confirmation is declined', async () => {
    commandMocks.readArtifactAtPath.mockResolvedValue(existingPrimerRead());
    commandMocks.confirmDialog.mockResolvedValue(false);
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);

    const editor = await screen.findByTestId('primer-sequence-input');
    await waitFor(() => expect(editor).toBeEnabled());
    fireEvent.change(editor, { target: { value: '/5Phos/ACGTACGTACGTACGTACGA' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Update entity' }));

    await waitFor(() => expect(commandMocks.confirmDialog).toHaveBeenCalledTimes(1));
    expect(commandMocks.updateArtifactContent).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    expect(useCanvasStore.getState().panels.main.tabs[0].isDirty).toBe(true);

    await act(async () => {
      expect(await documentLifecycle.save({ kind: 'tab', tabId: tab.id }, tab.id)).toBe(false);
    });
    expect(useCanvasStore.getState().panels.main.tabs[0].isDirty).toBe(true);
  });

  it('updates the same artifact revision after attached-primer confirmation', async () => {
    const existing = existingPrimerRead();
    commandMocks.readArtifactAtPath.mockResolvedValue(existing);
    commandMocks.updateArtifactContent.mockImplementation(async (input) => ({
      artifactPath: input.artifactPath,
      artifact: {
        ...existing.artifact,
        artifactRevision: 4,
        name: input.name,
        sequence: { ...existing.artifact.sequence, bases: input.sequence },
        oligo: input.oligo,
      },
      limsEntity: { id: existing.artifact.id },
      primer: { id: existing.artifact.id },
      gitCommitted: true,
    }));
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);

    const editor = await screen.findByTestId('primer-sequence-input');
    fireEvent.change(editor, { target: { value: '/5Phos/ACGTACGTACGTACGTACGA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));

    await waitFor(() =>
      expect(commandMocks.updateArtifactContent).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactPath: '/workspace/project/oligos/Existing.primer.json',
          expectedArtifactRevision: 3,
          sequence: 'ACGTACGTACGTACGTACGA',
          oligo: expect.objectContaining({ notation: '/5Phos/ACGTACGTACGTACGTACGA' }),
        })
      )
    );
    expect(commandMocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Update an attached primer?' })
    );
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Update entity' })).not.toBeInTheDocument()
    );
    expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({
      label: 'Existing primer',
      isDirty: false,
    });
  });

  it('does not demand binding-impact confirmation for a name-only revision', async () => {
    const existing = existingPrimerRead();
    commandMocks.readArtifactAtPath.mockResolvedValue(existing);
    commandMocks.updateArtifactContent.mockImplementation(async (input) => ({
      artifactPath: input.artifactPath,
      artifact: { ...existing.artifact, artifactRevision: 4, name: input.name },
      limsEntity: { id: existing.artifact.id },
      primer: { id: existing.artifact.id },
      gitCommitted: true,
    }));
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);

    await waitFor(() =>
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        existing.artifact.oligo.notation
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Name' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Renamed primer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));

    await waitFor(() => expect(commandMocks.updateArtifactContent).toHaveBeenCalledTimes(1));
    expect(commandMocks.confirmDialog).not.toHaveBeenCalled();
  });

  it('counts binding sites separately from sequences and refreshes every affected sequence', async () => {
    const existing = existingPrimerRead();
    const bindings = [
      { ...existing.artifact.bindings[0], id: 'site-a1', target: { documentId: 'sequence-a' } },
      { ...existing.artifact.bindings[0], id: 'site-a2', target: { documentId: 'sequence-a' } },
      { ...existing.artifact.bindings[0], id: 'site-b1', target: { documentId: 'sequence-b' } },
    ];
    const loaded = {
      ...existing,
      artifact: { ...existing.artifact, bindings },
      resolvedBindings: bindings.map((binding, index) => ({
        binding,
        sequenceId: index === 2 ? 99 : 42,
      })),
    };
    commandMocks.readArtifactAtPath.mockResolvedValue(loaded);
    commandMocks.updateArtifactContent.mockImplementation(async (input) => ({
      artifactPath: input.artifactPath,
      artifact: {
        ...loaded.artifact,
        artifactRevision: 4,
        sequence: { ...loaded.artifact.sequence, bases: input.sequence },
        oligo: input.oligo,
      },
      primer: { id: loaded.artifact.id },
      gitCommitted: true,
    }));
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);
    await waitFor(() =>
      expect(screen.getByTestId('primer-sequence-input')).toHaveAttribute(
        'data-oligo-notation',
        existing.artifact.oligo.notation
      )
    );
    fireEvent.change(screen.getByTestId('primer-sequence-input'), {
      target: { value: '/5Phos/ACGTACGTACGTACGTACGA' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));
    await waitFor(() => expect(commandMocks.updateArtifactContent).toHaveBeenCalledOnce());
    expect(commandMocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('3 binding sites on 2 sequences'),
      })
    );
    expect(commandMocks.notifyBindingsChanged.mock.calls).toEqual([[42], [99]]);
  });
  it('keeps a completed publication retryable when its actual-file reload fails', async () => {
    const loaded = existingPrimerRead();
    const operationId = '20000000-0000-4000-8000-000000000048';
    const saved = {
      artifactPath: loaded.path,
      artifact: { ...loaded.artifact, name: 'Saved change', artifactRevision: 4 },
      limsEntity: { id: loaded.artifact.id, workspaceId: 7 },
      publication: { entityId: loaded.artifact.id, operationId },
    };
    let refuseRead = false;
    commandMocks.readArtifactAtPath.mockImplementation(async () => {
      if (refuseRead) throw new Error('Temporary read refusal');
      return loaded;
    });
    commandMocks.updateArtifactContent.mockImplementationOnce(async () => {
      refuseRead = true;
      return saved;
    });
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);
    await editSavedPrimerField('Name', saved.artifact.name);
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));
    const reload = await screen.findByRole('button', { name: 'Reload metadata' });
    expect(screen.getByTestId('primer-sequence-input')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(userMessage('document.saveRefreshPending'));
    refuseRead = false;
    fireEvent.click(reload);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent(
        saved.artifact.name
      )
    );
    expect(commandMocks.resumeArtifactSave).not.toHaveBeenCalled();
    expect(commandMocks.updateArtifactContent).toHaveBeenCalledOnce();
    expect(commandMocks.updateArtifactContent).toHaveBeenCalledWith(
      expect.objectContaining({ artifactPath: loaded.path, expectedArtifactRevision: 3 })
    );
  });

  it('opens an interrupted saved primer directly to Retry and preserves that operation after a failed retry', async () => {
    const loaded = existingPrimerRead();
    const pending = {
      state: 'pending' as const,
      entityId: loaded.artifact.id,
      operationId: '20000000-0000-4000-8000-000000000045',
      workspaceId: 7,
      relativePath: loaded.artifact.file.workspaceRelativePath,
      name: 'Published primer',
      artifactRevision: 4,
    };
    commandMocks.readArtifactAtPath.mockRejectedValueOnce(
      new PrimerPublicationPendingError(pending)
    );
    commandMocks.resumeArtifactSave.mockRejectedValueOnce(
      new Error('Project write access is unavailable')
    );
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);
    const retry = await screen.findByTestId('primer-retry-save');
    expect(screen.queryByTestId('primer-name-input')).not.toBeInTheDocument();
    fireEvent.click(retry);
    await screen.findByText(userMessage('failure.the-primer-save-could-not-finish'));
    const savedRead = {
      ...loaded,
      artifact: { ...loaded.artifact, name: pending.name, artifactRevision: 4 },
    };
    commandMocks.resumeArtifactSave.mockResolvedValueOnce({
      artifactPath: loaded.path,
      artifact: savedRead.artifact,
      publication: { entityId: pending.entityId, operationId: pending.operationId },
    });
    commandMocks.readArtifactAtPath.mockResolvedValue(savedRead);
    fireEvent.click(screen.getByTestId('primer-retry-save'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent(pending.name)
    );
    expect(commandMocks.resumeArtifactSave.mock.calls).toEqual([
      [
        {
          entityId: pending.entityId,
          operationId: pending.operationId,
          workspaceRoot: '/workspace/project',
        },
      ],
      [
        {
          entityId: pending.entityId,
          operationId: pending.operationId,
          workspaceRoot: '/workspace/project',
        },
      ],
    ]);
    expect(commandMocks.updateArtifactContent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('primer-retry-save')).not.toBeInTheDocument();
  });

  it('keeps the draft blocked on a pending Save until exact Retry reloads the actual published file', async () => {
    const loaded = existingPrimerRead();
    const pending = {
      state: 'pending' as const,
      entityId: loaded.artifact.id,
      operationId: '20000000-0000-4000-8000-000000000046',
      workspaceId: 7,
      relativePath: loaded.artifact.file.workspaceRelativePath,
      name: 'Edited once',
      artifactRevision: 4,
    };
    commandMocks.readArtifactAtPath.mockResolvedValue(loaded);
    commandMocks.updateArtifactContent.mockRejectedValueOnce(
      new PrimerPublicationPendingError(pending)
    );
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);
    await editSavedPrimerField('Name', pending.name);
    fireEvent.click(screen.getByRole('button', { name: 'Update entity' }));
    const retry = await screen.findByRole('button', { name: 'Retry save' });
    expect(peekEntityDetailsSession(loaded.artifact.id)?.getSnapshot()).toMatchObject({
      completionPending: true,
      draft: { name: pending.name },
    });
    expect(screen.getByRole('button', { name: 'Edit Name' })).toBeDisabled();
    expect(screen.getByTestId('primer-sequence-input')).toBeDisabled();
    let finishRead!: (value: ReturnType<typeof existingPrimerRead>) => void;
    commandMocks.resumeArtifactSave.mockResolvedValueOnce({
      artifactPath: loaded.path,
      artifact: loaded.artifact,
    });
    const readback = new Promise<ReturnType<typeof existingPrimerRead>>((resolve) => {
      finishRead = resolve;
    });
    commandMocks.readArtifactAtPath.mockReturnValue(readback);
    fireEvent.click(retry);
    await waitFor(() => expect(commandMocks.resumeArtifactSave).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Retry save' })).not.toBeInTheDocument();
    expect(screen.getByTestId('primer-sequence-input')).toBeDisabled();
    expect(screen.getByTestId('entity-details-panel')).toHaveTextContent(pending.name);
    await act(async () =>
      finishRead({
        ...loaded,
        artifact: { ...loaded.artifact, name: 'Actual published file', artifactRevision: 4 },
      })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent(
        'Actual published file'
      )
    );
    expect(commandMocks.resumeArtifactSave).toHaveBeenCalledWith({
      entityId: pending.entityId,
      operationId: pending.operationId,
      workspaceRoot: '/workspace/project',
    });
    expect(commandMocks.updateArtifactContent).toHaveBeenCalledOnce();
  });

  function organizationFixture() {
    const loaded = existingPrimerRead();
    const session = {
      accountId: 'account-a',
      desktopSessionId: 'session-a',
      channel: 'test',
      accessTokenExpiresAt: '2099-01-01T00:00:00Z',
    };
    useAuthStore.setState({ state: { status: 'signed-in', session } });
    const editorTab = existingPrimerTab();
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [editorTab], activeTabId: editorTab.id } },
    });
    commandMocks.readCatalogFile.mockResolvedValue({
      entity_id: loaded.artifact.id,
      workspace_id: 7,
      status: 'current',
      file_kind: 'primer-artifact',
    });
    commandMocks.readWorkspaceRoot.mockResolvedValue('/workspace/project');
    const status = {
      orgId: 'organization',
      entityId: loaded.artifact.id,
      homeWorkspaceId: 'remote-home',
      acknowledgedRevision: 1,
      baseRevision: 1,
      baseProvenance: 'receipt',
      status: 'remote_changes',
      mutationId: null,
      message: null,
      pendingResolution: null,
    };
    commandMocks.syncStatus.mockResolvedValue({ ok: true, accountId: session.accountId, status });
    const local = { name: loaded.artifact.name, fields: { notes: 'Local notes' }, archived: false };
    commandMocks.syncReview.mockResolvedValue({
      ok: true,
      review: {
        accountId: session.accountId,
        orgId: status.orgId,
        entityId: loaded.artifact.id,
        sourceRevision: 'a'.repeat(64),
        localEventSeq: 12,
        organizationRevision: 2,
        local,
        organization: {
          ...local,
          name: 'Organization primer',
          fields: { notes: 'Organization notes' },
        },
      },
    });
    commandMocks.syncOrganization.mockResolvedValue({
      ok: false,
      code: 'SYNC_ERROR',
      message: 'Offline',
    });
    const next = {
      ...loaded,
      artifact: { ...loaded.artifact, name: 'Organization primer', artifactRevision: 4 },
      registeredRevision: {
        state: 'ready',
        workspaceId: 7,
        entity: { id: loaded.artifact.id, workspaceId: 7 },
      },
    };
    commandMocks.readArtifactAtPath.mockResolvedValue(loaded);
    commandMocks.resolveOrganization.mockImplementation(async () => {
      commandMocks.readArtifactAtPath.mockResolvedValue(next);
      commandMocks.syncStatus.mockResolvedValue({
        ok: true,
        accountId: session.accountId,
        status: { ...status, status: 'synced' },
      });
      return { ok: true, entity: { id: loaded.artifact.id, workspaceId: 7 }, replayed: false };
    });
    return { loaded, next, session, status };
  }

  function SavedPrimerHarness() {
    const current = useCanvasStore((state) => state.panels.main.tabs[0]);
    return <PrimerCreationTab tab={current} panelId="main" />;
  }

  it('refreshes an already-open primer after a native Registry change for its current account', async () => {
    const { loaded, session, status } = organizationFixture();
    commandMocks.syncStatus.mockResolvedValue({
      ok: true,
      accountId: session.accountId,
      status: { ...status, status: 'synced' },
    });
    const editor = render(<SavedPrimerHarness />);
    await waitFor(() =>
      expect(screen.getByTestId('primer-organization-sync')).toHaveAttribute(
        'data-status',
        'synced'
      )
    );
    expect(await screen.findByRole('button', { name: 'Edit Name' })).toHaveTextContent(
      loaded.artifact.name
    );
    expect(commandMocks.registryChanged).toHaveBeenCalledOnce();
    const listener = commandMocks.registryChanged.mock.calls[0][0];
    const reads = commandMocks.syncStatus.mock.calls.length;
    commandMocks.syncStatus.mockResolvedValue({ ok: true, accountId: session.accountId, status });
    await act(async () => listener({ accountId: 'another-account', orgId: status.orgId }));
    expect(commandMocks.syncStatus).toHaveBeenCalledTimes(reads);
    await act(async () => listener({ accountId: session.accountId, orgId: status.orgId }));
    await screen.findByTestId('primer-use-organization');
    expect(screen.getByTestId('primer-organization-sync')).toHaveAttribute(
      'data-status',
      'remote_changes'
    );
    expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent(
      loaded.artifact.name
    );
    expect(commandMocks.updateArtifactContent).not.toHaveBeenCalled();
    editor.unmount();
  });

  it('applies the reviewed organization primer through the shared approval and reloads the same saved document', async () => {
    const { loaded, next } = organizationFixture();
    render(<SavedPrimerHarness />);
    const choice = await screen.findByTestId('primer-use-organization');
    expect(screen.getByTestId('primer-organization-conflict')).toHaveTextContent(
      'Organization notes'
    );
    fireEvent.click(choice);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent(
        next.artifact.name
      )
    );
    expect(commandMocks.resolveOrganization).toHaveBeenCalledWith('organization', {
      entityId: loaded.artifact.id,
      resolutionId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      choice: 'use_remote',
      sourceRevision: 'a'.repeat(64),
    });
    expect(commandMocks.readArtifactAtPath).toHaveBeenLastCalledWith(
      loaded.path,
      '/workspace/project'
    );
    expect(commandMocks.updateArtifactContent).not.toHaveBeenCalled();
    expect(isTabDirty(useCanvasStore.getState().panels.main.tabs[0])).toBe(false);
  });

  it.each(['name', 'notes'])(
    'blocks organization replacement while the primer has an unsaved %s draft',
    async (field) => {
      organizationFixture();
      render(<SavedPrimerHarness />);
      const choice = await screen.findByTestId('primer-use-organization');
      const input = await editSavedPrimerField(
        field === 'name' ? 'Name' : 'Notes',
        'Unsaved primer'
      );
      expect(choice).toBeDisabled();
      fireEvent.click(choice);
      expect(commandMocks.resolveOrganization).not.toHaveBeenCalled();
      expect(input).toHaveValue('Unsaved primer');
    }
  );

  it('retains the exact organization approval when reopening its published primer fails', async () => {
    const { next } = organizationFixture();
    render(<SavedPrimerHarness />);
    const choice = await screen.findByTestId('primer-use-organization');
    commandMocks.readArtifactAtPath.mockRejectedValueOnce(new Error('Temporary read refusal'));
    fireEvent.click(choice);
    await screen.findByText(userMessage('failure.the-approved-primer-could-not-be-reopened'));
    const approved = commandMocks.resolveOrganization.mock.calls[0][1];
    expect(screen.getByTestId('primer-sequence-input')).toBeDisabled();
    commandMocks.readArtifactAtPath.mockResolvedValue(next);
    fireEvent.click(screen.getByTestId('primer-retry-organization-resolution'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent(
        next.artifact.name
      )
    );
    expect(commandMocks.resolveOrganization.mock.calls[1]).toEqual(['organization', approved]);
    expect(commandMocks.resumeArtifactSave).not.toHaveBeenCalled();
  });

  it('reopens an interrupted organization approval from the checked primer owner when its file is unavailable', async () => {
    const { loaded, next, status } = organizationFixture();
    const approval = {
      entityId: loaded.artifact.id,
      resolutionId: '20000000-0000-4000-8000-000000000049',
      choice: 'use_remote',
      sourceRevision: 'a'.repeat(64),
    };
    commandMocks.syncStatus.mockResolvedValue({
      ok: true,
      accountId: 'account-a',
      status: { ...status, status: 'publication_pending', pendingResolution: approval },
    });
    commandMocks.readArtifactAtPath
      .mockReset()
      .mockRejectedValueOnce(new Error('Approved primer publication is incomplete'));
    render(<SavedPrimerHarness />);
    const retry = await screen.findByTestId('primer-retry-organization-resolution');
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.queryByTestId('primer-retry-save')).not.toBeInTheDocument();
    commandMocks.readArtifactAtPath.mockResolvedValue(next);
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name' })).toHaveTextContent(
        next.artifact.name
      )
    );
    expect(commandMocks.resolveOrganization).toHaveBeenCalledWith('organization', approval);
    expect(commandMocks.updateArtifactContent).not.toHaveBeenCalled();
  });

  it('discards a late organization primer result after the active account changes', async () => {
    const { loaded, session } = organizationFixture();
    let finish!: (value: unknown) => void;
    commandMocks.resolveOrganization.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<SavedPrimerHarness />);
    fireEvent.click(await screen.findByTestId('primer-use-organization'));
    await waitFor(() => expect(commandMocks.resolveOrganization).toHaveBeenCalledOnce());
    commandMocks.readArtifactAtPath.mockRejectedValueOnce(new Error('Different account'));
    await act(async () =>
      useAuthStore.setState({
        state: { status: 'signed-in', session: { ...session, accountId: 'account-b' } },
      })
    );
    await screen.findByText(userMessage('failure.failed-to-open-primer'));
    const readsAfterAccountChange = commandMocks.readArtifactAtPath.mock.calls.length;
    await act(async () =>
      finish({ ok: true, entity: { id: loaded.artifact.id, workspaceId: 7 }, replayed: false })
    );
    expect(commandMocks.readArtifactAtPath).toHaveBeenCalledTimes(readsAfterAccountChange);
    expect(screen.queryByTestId('primer-name-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-details-panel')).not.toBeInTheDocument();
  });

  it('discards a late Retry result after the active account changes', async () => {
    const loaded = existingPrimerRead();
    const pending = {
      state: 'pending' as const,
      entityId: loaded.artifact.id,
      operationId: '20000000-0000-4000-8000-000000000047',
      workspaceId: 7,
      relativePath: loaded.artifact.file.workspaceRelativePath,
      name: 'Old account save',
      artifactRevision: 4,
    };
    const session = {
      accountId: 'account-a',
      desktopSessionId: 'session-a',
      channel: 'test',
      accessTokenExpiresAt: '2099-01-01T00:00:00Z',
    };
    useAuthStore.setState({ state: { status: 'signed-in', session } });
    commandMocks.readArtifactAtPath.mockRejectedValueOnce(
      new PrimerPublicationPendingError(pending)
    );
    let complete!: (value: unknown) => void;
    commandMocks.resumeArtifactSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    render(<PrimerCreationTab tab={existingPrimerTab()} panelId="main" />);
    fireEvent.click(await screen.findByTestId('primer-retry-save'));
    await waitFor(() => expect(commandMocks.resumeArtifactSave).toHaveBeenCalledOnce());
    commandMocks.readArtifactAtPath.mockRejectedValueOnce(
      new Error('Sign in with the registered account')
    );
    await act(async () =>
      useAuthStore.setState({
        state: { status: 'signed-in', session: { ...session, accountId: 'account-b' } },
      })
    );
    await screen.findByText(userMessage('failure.failed-to-open-primer'));
    const readsAfterAccountChange = commandMocks.readArtifactAtPath.mock.calls.length;
    await act(async () =>
      complete({ artifactPath: loaded.path, artifact: { ...loaded.artifact, name: pending.name } })
    );
    expect(commandMocks.readArtifactAtPath).toHaveBeenCalledTimes(readsAfterAccountChange);
    expect(screen.queryByTestId('primer-retry-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('primer-name-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-details-panel')).not.toBeInTheDocument();
  });
});

async function editSavedPrimerField(label: string, value: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit ' + label }));
  const input = screen.getByRole('textbox', { name: label });
  fireEvent.change(input, { target: { value } });
  return input;
}

function existingPrimerTab(): Tab {
  return {
    ...tab,
    label: 'Existing',
    entityId: '/workspace/project/oligos/Existing.primer.json',
    artifactDocument: {
      ...tab.artifactDocument!,
      persistence: 'persisted',
      artifactPath: '/workspace/project/oligos/Existing.primer.json',
    },
  };
}

function existingPrimerRead() {
  return {
    path: '/workspace/project/oligos/Existing.primer.json',
    content: '{}',
    artifact: {
      schema: 'dnaforge.primer',
      schemaVersion: 1,
      artifactRevision: 3,
      id: '20000000-0000-4000-8000-000000000001',
      catalogNumber: 'P-3',
      name: 'Existing primer',
      sequence: {
        bases: 'ACGTACGTACGTACGTACGT',
        topology: 'linear',
        length: 20,
        contentHash: 'sha256:bases',
      },
      oligo: {
        vendor: 'idt',
        notation: '/5Phos/ACGTACGTACGTACGTACGT',
        modifications: [
          {
            chemistryId: 'phosphorylation',
            vendor: 'idt',
            vendorCode: '5Phos',
            placement: 'five-prime',
            behavior: 'terminal-attachment',
            anchor: { kind: 'terminus', end: 'five-prime' },
          },
        ],
      },
      computed: { tmC: 61.2, gcPercent: 50 },
      metadata: {
        createdAt: '2026-08-19T00:00:00.000Z',
        updatedAt: '2026-08-19T00:00:00.000Z',
        actor: 'local-user',
        source: 'manual',
        application: null,
        notes: 'existing note',
      },
      registry: {
        required: true,
        entityId: '20000000-0000-4000-8000-000000000001',
        kind: 'oligo',
        use: 'primer',
      },
      entity: {
        schema: {
          schemaId: 'schema-entity-oligo',
          schemaRevisionId: 'schema-entity-oligo-v1',
          name: 'oligo',
          displayName: 'Primer',
          baseKind: 'primer',
          version: 1,
          fields: [
            { key: 'sequence', label: 'Sequence', type: 'dna_sequence', required: true },
            { key: 'use', label: 'Use', type: 'enum', enumOptions: ['primer'] },
            { key: 'notes', label: 'Notes', type: 'long_text' },
          ],
        },
        fields: { notes: 'existing note' },
      },
      file: { workspaceRelativePath: 'oligos/Existing.primer.json' },
      bindings: [
        {
          id: 'binding-existing',
          relation: 'binds_to_sequence',
          target: { workspaceRelativePath: 'sequences/template.gb' },
        },
      ],
    },
    resolvedBindings: [],
  };
}
