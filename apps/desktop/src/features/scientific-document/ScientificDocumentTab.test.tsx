import { userMessage } from '@waypoint/user-messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  buildMigrationDestinationLinkIndexWriterPayload,
  type MigrationDestinationLinkIndexEntryInput,
} from '../../shared/benchling-migration-destination-index';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { resolveProtocolSourcePath, ScientificDocumentTab } from './ScientificDocumentTab';

const mocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  readScientificDocument: vi.fn(),
  cancelScientificDocumentRead: vi.fn(),
  readFileBounded: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn(),
  validateWorkspacePath: vi.fn(),
  writeTextFile: vi.fn(),
  writeWorkspaceTextFileAtomic: vi.fn(),
  readScientificDocument: vi.fn(),
  cancelScientificDocumentRead: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  on: vi.fn(),
  fileChangedListener: null as ((...args: unknown[]) => void) | null,
  updateTabByEntityId: vi.fn(),
  openInFocusedPanel: vi.fn(),
  openSequenceFile: vi.fn(),
  resolveNativeCatalogDestination: vi.fn(),
  planWorkspaceArtifactRepair: vi.fn(),
  applyAcceptedWorkspaceArtifactRepair: vi.fn(),
  resolveArtifactFile: vi.fn(),
  getCatalogEntityForFilePath: vi.fn(),
  getCatalogWorkspaceRootForFilePath: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  resolveWorkspaceId: vi.fn(),
  reconcileEntitySnapshot: vi.fn(),
  updateCatalogEntityName: vi.fn(),
  bindCatalogEntityToFile: vi.fn(),
  recordCatalogEvent: vi.fn(),
  readDesktopScientificDocument: vi.fn(),
  upsertPageFromArtifact: vi.fn(),
  upsertDesignFromArtifact: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      readTextFile: mocks.readTextFile,
      readFileBounded: mocks.readFileBounded,
      exists: mocks.exists,
      stat: mocks.stat,
      validateWorkspacePath: mocks.validateWorkspacePath,
      writeTextFile: mocks.writeTextFile,
      writeWorkspaceTextFileAtomic: mocks.writeWorkspaceTextFileAtomic,
      watchFile: mocks.watchFile,
      unwatchFile: mocks.unwatchFile,
    },
    scientificDocuments: {
      read: mocks.readScientificDocument,
      cancelRead: mocks.cancelScientificDocumentRead,
    },
    on: mocks.on,
  }),
}));

vi.mock('../canvas/store', () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        updateTabByEntityId: mocks.updateTabByEntityId,
        openInFocusedPanel: mocks.openInFocusedPanel,
      }),
    { getState: () => ({ panels: {} }) }
  ),
}));

vi.mock('../document-opening/compat', () => ({
  openSequenceFile: mocks.openSequenceFile,
}));

vi.mock('../../services/native-catalog-destination', () => ({
  resolveNativeCatalogDestination: mocks.resolveNativeCatalogDestination,
}));

vi.mock('../../db/workspace-artifacts', () => ({
  planWorkspaceArtifactRepair: mocks.planWorkspaceArtifactRepair,
  applyAcceptedWorkspaceArtifactRepair: mocks.applyAcceptedWorkspaceArtifactRepair,
  resolveArtifactFile: mocks.resolveArtifactFile,
}));

vi.mock('../../db/workspace-catalog', () => ({
  inferCatalogFileKind: vi.fn(),
  registerWorkspaceFile: vi.fn(),
  getCatalogEntityForFilePath: mocks.getCatalogEntityForFilePath,
  getCatalogWorkspaceRootForFilePath: mocks.getCatalogWorkspaceRootForFilePath,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
  resolveWorkspaceId: mocks.resolveWorkspaceId,
  updateCatalogEntityName: mocks.updateCatalogEntityName,
  bindCatalogEntityToFile: mocks.bindCatalogEntityToFile,
  recordCatalogEvent: mocks.recordCatalogEvent,
}));

vi.mock('../../db/entity-substrate/adapter', () => ({
  reconcileEntitySnapshot: mocks.reconcileEntitySnapshot,
}));

vi.mock('./services/desktop-scientific-documents', () => ({
  readDesktopScientificDocument: mocks.readDesktopScientificDocument,
}));

vi.mock('../page', () => ({
  usePageStore: (selector: (state: unknown) => unknown) =>
    selector({ upsertPageFromArtifact: mocks.upsertPageFromArtifact }),
}));

vi.mock('../design', () => ({
  useDesignStore: (selector: (state: unknown) => unknown) =>
    selector({ upsertDesignFromArtifact: mocks.upsertDesignFromArtifact }),
}));

describe('ScientificDocumentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeTextFile.mockResolvedValue(undefined);
    mocks.readScientificDocument.mockImplementation(
      async (request: { workspaceRoot: string; document: string }) => ({
        ok: true,
        document: {
          content: await mocks.readTextFile(`${request.workspaceRoot}/${request.document}`),
        },
      })
    );
    mocks.cancelScientificDocumentRead.mockResolvedValue(undefined);
    mocks.exists.mockResolvedValue(true);
    mocks.readFileBounded.mockResolvedValue(new Uint8Array());
    mocks.stat.mockResolvedValue({ isFile: true });
    mocks.validateWorkspacePath.mockResolvedValue(true);
    mocks.writeWorkspaceTextFileAtomic.mockResolvedValue({ path: '/ws/file', contentHash: 'hash' });
    mocks.readScientificDocument.mockImplementation(
      async (request: { workspaceRoot: string; workspace: string; document: string }) => {
        const content = await mocks.readTextFile(`${request.workspaceRoot}/${request.document}`);
        return {
          ok: true,
          document: {
            workspace: request.workspace,
            document: request.document,
            name: request.document.split('/').at(-1) ?? request.document,
            format: 'scientific-json',
            content,
            byteLength: new TextEncoder().encode(content).byteLength,
            revision: { kind: 'local-file', contentSha256: '0'.repeat(64) },
            support: { route: 'desktop', access: 'read-write' },
          },
        };
      }
    );
    mocks.cancelScientificDocumentRead.mockResolvedValue(undefined);
    mocks.watchFile.mockResolvedValue(undefined);
    mocks.unwatchFile.mockResolvedValue(undefined);
    mocks.fileChangedListener = null;
    mocks.on.mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'file-changed') mocks.fileChangedListener = listener;
      return vi.fn();
    });
    mocks.openSequenceFile.mockResolvedValue('sequence-tab');
    mocks.resolveNativeCatalogDestination.mockResolvedValue(null);
    mocks.getCatalogEntityForFilePath.mockResolvedValue(null);
    mocks.getCatalogWorkspaceRootForFilePath.mockResolvedValue(null);
    mocks.resolveWorkspaceScope.mockResolvedValue('workspace-test');
    mocks.resolveWorkspaceId.mockResolvedValue(1);
    mocks.reconcileEntitySnapshot.mockResolvedValue({
      id: 'workspace-scoped-page-1',
      outcome: 'in-sync',
    });
    mocks.upsertPageFromArtifact.mockResolvedValue(undefined);
    mocks.updateCatalogEntityName.mockResolvedValue(undefined);
    mocks.bindCatalogEntityToFile.mockResolvedValue(undefined);
    mocks.recordCatalogEvent.mockResolvedValue(undefined);
    mocks.readDesktopScientificDocument.mockImplementation(
      async ({ filePath }: { filePath: string }) => ({
        ok: true,
        document: { content: await mocks.readTextFile(filePath) },
      })
    );
  });

  it('resolves a package-relative protocol source against its owning root in a multi-root workspace', () => {
    const folders = [
      { path: '/fixtures', name: 'Test Fixtures', addedAt: 1 },
      { path: '/ws/paper-protocol', name: 'Paper protocol', addedAt: 2 },
    ];

    expect(
      resolveProtocolSourcePath(
        folders,
        '/ws/paper-protocol/Protocols/Purification/.forge/protocol.json',
        'paper-protocol-synthetic.pdf'
      )
    ).toBe('/ws/paper-protocol/paper-protocol-synthetic.pdf');
    expect(
      resolveProtocolSourcePath(
        folders,
        '/ws/paper-protocol/Protocols/Purification/.forge/protocol.json',
        'Test Fixtures/documents/reference.pdf'
      )
    ).toBe('/fixtures/documents/reference.pdf');
  });

  it('renders a completed imported ProtocolRun as immutable with no amendment controls', async () => {
    mockMigrationFiles('/ws/Benchling Imports/run.dnaforge-protocol-run.json', runDocument(), true);
    render(
      <ScientificDocumentTab filePath="/ws/Benchling Imports/run.dnaforge-protocol-run.json" />
    );

    expect(await screen.findByText('Completed imported run · immutable')).toBeInTheDocument();
    expect(screen.getByText('PCR verification')).toBeInTheDocument();
    expect(screen.getByText('pTemplate')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add amendment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Document title')).toBeDisabled();
  });

  it('shows source formula status beside read-only run results', async () => {
    const raw = JSON.parse(runDocument());
    raw.tables = [
      {
        id: 'table1',
        name: 'Preserved results',
        cells: [
          [
            {
              type: 'formula',
              value: '=BENCHLING(A1)',
              computed: 42,
              formulaCompatibility: 'unsupported',
              stale: false,
            },
            {
              type: 'formula',
              value: '=BENCHLING(B1)',
              computed: 7,
              formulaCompatibility: 'unsupported',
              stale: true,
            },
          ],
        ],
      },
    ];
    mockMigrationFiles(
      '/ws/Benchling Imports/run.dnaforge-protocol-run.json',
      JSON.stringify(raw),
      true
    );
    render(
      <ScientificDocumentTab filePath="/ws/Benchling Imports/run.dnaforge-protocol-run.json" />
    );
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeVisible();
    expect(screen.getByText('May be outdated')).toBeVisible();
    expect(screen.getByRole('img', { name: /^Saved result/ })).toHaveAttribute(
      'title',
      expect.stringContaining('=BENCHLING(A1)')
    );
    expect(screen.getByRole('img', { name: /^May be outdated/ })).toHaveAttribute(
      'title',
      expect.stringContaining('=BENCHLING(B1)')
    );
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });

  it('edits and saves an in-progress native Protocol Run through its normal package lifecycle', async () => {
    const filePath = '/ws/Protocol Runs/PCR run 1/.forge/protocol-run.json';
    const raw = JSON.parse(runDocument());
    raw.status = 'in_progress';
    raw.immutable = false;
    raw.completedAt = null;
    raw.provenance = {
      immutableSource: false,
      provider: 'dnaforge',
      capturedAt: '2026-07-18T00:00:00.000Z',
    };
    mockMigrationFiles(filePath, JSON.stringify(raw), false);
    mocks.getCatalogWorkspaceRootForFilePath.mockResolvedValue('/ws');
    mocks.getCatalogEntityForFilePath.mockResolvedValue({ id: 'protocol-run-pcr-1' });
    render(<ScientificDocumentTab filePath={filePath} />);

    fireEvent.change(await screen.findByLabelText('Amendment path'), {
      target: { value: '/measurements/temperature' },
    });
    fireEvent.change(screen.getByLabelText('Amendment reason'), {
      target: { value: 'Correct the recorded temperature' },
    });
    fireEvent.change(screen.getByLabelText('Amendment value'), {
      target: { value: '37 C' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add amendment' }));

    expect(await screen.findByText('Correct the recorded temperature')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^save$/iu }));
    await waitFor(() => expect(mocks.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(1));
    const written = JSON.parse(mocks.writeWorkspaceTextFileAtomic.mock.calls[0][0].content);
    expect(written).toMatchObject({
      schema: 'dnaforge.protocol-run.v1',
      kind: 'protocol_run',
      amendments: [
        expect.objectContaining({
          path: '/measurements/temperature',
          reason: 'Correct the recorded temperature',
          value: { type: 'text', value: '37 C' },
        }),
      ],
    });
  });

  it('renders preserved TipTap links and edits ordered protocol steps without changing provenance', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    const source = protocolDocument();
    mockMigrationFiles(filePath, source, true, [
      destinationEntry({
        destinationObjectId: 'benchling-template-1',
        sourceStableIds: ['seq_template_1'],
        relativePath: 'Benchling Imports/Sequences/template.gb',
        tabType: 'sequence',
        title: 'PCR template',
      }),
    ]);
    render(<ScientificDocumentTab filePath={filePath} />);

    const paper = await screen.findByRole('link', { name: 'paper' });
    expect(paper).toHaveAttribute('href', 'https://example.org/pcr');
    expect(paper).toHaveAttribute('target', '_blank');
    const template = screen.getByRole('button', { name: 'template' });
    fireEvent.click(template);
    await waitFor(() =>
      expect(mocks.openSequenceFile).toHaveBeenCalledWith({
        filePath: '/ws/Benchling Imports/Sequences/template.gb',
        label: 'PCR template',
        strategy: { kind: 'focused' },
      })
    );

    fireEvent.change(screen.getByLabelText('Protocol overview'), {
      target: { value: 'Updated overview' },
    });
    fireEvent.change(screen.getByLabelText('Step 1 title'), {
      target: { value: 'Prepare master mix' },
    });
    fireEvent.change(screen.getByLabelText('Step 1 content'), {
      target: { value: 'Combine template and primers.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(await screen.findByLabelText('Step 3 title')).toHaveValue('New step 3');
    fireEvent.click(screen.getByRole('button', { name: 'Move step 3 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete step 3' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mocks.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(1));
    const written = JSON.parse(mocks.writeWorkspaceTextFileAtomic.mock.calls[0][0].content);
    const original = JSON.parse(source);
    expect(written.overview.content[0].content[0].text).toBe('Updated overview');
    expect(written.steps).toHaveLength(2);
    expect(written.steps.map((step: { ordinal: number }) => step.ordinal)).toEqual([1, 2]);
    expect(written.steps.some((step: { title: string }) => step.title === 'New step 3')).toBe(true);
    expect(written.steps[0]).toMatchObject({
      title: 'Prepare master mix',
      content: {
        content: [{ content: [{ text: 'Combine template and primers.' }] }],
      },
    });
    expect(written.version).toEqual(original.version);
    expect(written.provenance).toEqual(original.provenance);
  });

  it('reloads a clean protocol after an agent changes it on disk', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    const source = protocolDocument();
    mockMigrationFiles(filePath, source, true);
    render(<ScientificDocumentTab filePath={filePath} />);

    expect(await screen.findByLabelText('Step 1 content')).toHaveValue('Mix reagents');
    const revised = JSON.parse(source);
    revised.steps[0].content.content[0].content[0].text = 'Agent revised the instructions.';
    mocks.readTextFile.mockImplementation(async (path: string) => {
      if (path === filePath) return JSON.stringify(revised);
      if (path.endsWith('/migration-manifest.json')) return JSON.stringify({ status: 'unlocked' });
      throw new Error(`Unexpected path: ${path}`);
    });

    act(() => mocks.fileChangedListener?.(filePath));

    await waitFor(() =>
      expect(screen.getByLabelText('Step 1 content')).toHaveValue('Agent revised the instructions.')
    );
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
  });

  it('does not overwrite an unsaved draft when the protocol changes on disk', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    mockMigrationFiles(filePath, protocolDocument(), true);
    render(<ScientificDocumentTab filePath={filePath} />);

    const stepContent = await screen.findByLabelText('Step 1 content');
    fireEvent.change(stepContent, { target: { value: 'My unsaved revision.' } });
    act(() => mocks.fileChangedListener?.(filePath));

    expect(await screen.findByTestId('scientific-document-external-change')).toHaveTextContent(
      'changed on disk while you have unsaved edits'
    );
    expect(stepContent).toHaveValue('My unsaved revision.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep my edits' }));
    expect(screen.queryByTestId('scientific-document-external-change')).not.toBeInTheDocument();
    expect(stepContent).toHaveValue('My unsaved revision.');
  });

  it('edits and saves a native protocol package without a migration marker', async () => {
    const filePath = '/ws/Benchling Imports/PCR/.forge/protocol.json';
    mockMigrationFiles(filePath, protocolDocument(), false);
    mocks.getCatalogWorkspaceRootForFilePath.mockResolvedValue('/ws');
    mocks.getCatalogEntityForFilePath.mockResolvedValue({ id: 'protocol-pcr' });
    render(<ScientificDocumentTab filePath={filePath} />);

    const overview = await screen.findByLabelText('Protocol overview');
    expect(overview).toBeEnabled();
    expect(screen.queryByText(/read-only migration staging/i)).not.toBeInTheDocument();
    fireEvent.change(overview, { target: { value: 'Native editable overview' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mocks.writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(1));
    expect(mocks.readTextFile.mock.calls.map(([path]) => path)).toEqual([filePath]);
  });

  it('keeps selected and hovered paper evidence while an unsaved correction updates registration', async () => {
    const filePath = '/ws/Protocols/Paper/.forge/protocol.json';
    mockMigrationFiles(filePath, paperProtocolDocument(), false);
    mocks.getCatalogWorkspaceRootForFilePath.mockResolvedValue('/ws');
    useWorkspaceStore.setState({
      folders: [{ name: 'workspace', path: '/ws', addedAt: 1 }],
    });
    render(<ScientificDocumentTab filePath={filePath} />);

    expect(await screen.findByLabelText('Step 1 title')).toHaveValue('Prepare');
    const step = document.querySelector<HTMLElement>('[data-protocol-step-id="step-1"]');
    expect(step).not.toBeNull();
    fireEvent.mouseEnter(step!);

    fireEvent.change(screen.getByLabelText('Step 1 title'), {
      target: { value: 'Prepare corrected sample' },
    });

    await waitFor(() => expect(step).toHaveClass('bg-bg-hover'));
    fireEvent.mouseLeave(step!);
    fireEvent.click(step!);
    expect(step).toHaveAttribute('data-review-selected', 'true');

    fireEvent.change(screen.getByLabelText('Step 1 title'), {
      target: { value: 'Prepare final corrected sample' },
    });
    await waitFor(() => expect(step).toHaveAttribute('data-review-selected', 'true'));
  });

  it('opens the exact native catalog path for an imported sequence', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    const indexedPath = '/ws/Benchling Imports/Sequences/template.gb';
    mockMigrationFiles(filePath, protocolDocument(), true, [
      destinationEntry({
        destinationObjectId: 'benchling-template-1',
        sourceStableIds: ['seq_template_1'],
        relativePath: 'Benchling Imports/Sequences/template.gb',
        tabType: 'sequence',
        title: 'PCR template',
      }),
    ]);
    mocks.exists.mockImplementation(async (path: string) => path !== indexedPath);
    mocks.readFileBounded.mockResolvedValue(
      new TextEncoder().encode(
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'benchling-sequence-template',
            name: 'PCR template',
            product: { file: 'template.gb' },
            updatedAt: '2026-07-29T00:00:00.000Z',
          })
        )
      )
    );
    render(<ScientificDocumentTab filePath={filePath} />);

    fireEvent.click(await screen.findByRole('button', { name: 'template' }));

    await waitFor(() =>
      expect(mocks.openSequenceFile).toHaveBeenCalledWith({
        filePath: indexedPath,
        label: 'PCR template',
        strategy: { kind: 'focused' },
      })
    );
    expect(mocks.readFileBounded).not.toHaveBeenCalled();
  });

  it('recovers a legacy indexed sequence from an older nested package layout', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    const indexedPath = '/ws/Benchling Imports/Sequences/template.gb';
    const recoveredPath = '/ws/Benchling Imports/Sequences/template/template.gb';
    mockMigrationFiles(
      filePath,
      protocolDocument(),
      true,
      [
        destinationEntry({
          destinationObjectId: 'benchling-template-1',
          sourceStableIds: ['seq_template_1'],
          relativePath: 'Benchling Imports/Sequences/template.gb',
          tabType: 'sequence',
          title: 'PCR template',
        }),
      ],
      'legacy_index'
    );
    mocks.exists.mockImplementation(async (path: string) => path !== indexedPath);
    mocks.readFileBounded.mockResolvedValue(
      new TextEncoder().encode(
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'benchling-sequence-template',
            name: 'PCR template',
            product: { file: 'template.gb' },
            updatedAt: '2026-07-29T00:00:00.000Z',
          })
        )
      )
    );
    render(<ScientificDocumentTab filePath={filePath} />);

    fireEvent.click(await screen.findByRole('button', { name: 'template' }));

    await waitFor(() =>
      expect(mocks.openSequenceFile).toHaveBeenCalledWith({
        filePath: recoveredPath,
        label: 'PCR template',
        strategy: { kind: 'focused' },
      })
    );
    expect(mocks.readFileBounded).toHaveBeenCalledTimes(1);
  });

  it('routes a legacy indexed LIMS destination through app-level native navigation', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    const openEntity = vi.fn();
    window.addEventListener('waypoint:open-entity', openEntity);
    mockMigrationFiles(filePath, protocolDocument(), true, [
      destinationEntry({
        destinationObjectId: 'benchling-template-1',
        sourceStableIds: ['seq_template_1'],
        locator: { kind: 'lims_entity', entityId: 'benchling-protein-template' },
        title: 'PCR template',
      }),
    ]);
    render(<ScientificDocumentTab filePath={filePath} />);

    fireEvent.click(await screen.findByRole('button', { name: 'template' }));

    await waitFor(() => expect(openEntity).toHaveBeenCalledTimes(1));
    expect((openEntity.mock.calls[0][0] as CustomEvent).detail).toEqual({
      entityType: 'native-catalog',
      entityId: 'benchling-template-1',
      label: 'PCR template',
      owningRoot: '/ws',
    });
    window.removeEventListener('waypoint:open-entity', openEntity);
  });

  it('reports a preserved sequence destination that is no longer available', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    mockMigrationFiles(filePath, protocolDocument(), true, [
      destinationEntry({
        destinationObjectId: 'benchling-template-1',
        sourceStableIds: ['seq_template_1'],
        relativePath: 'Benchling Imports/Sequences/template.gb',
        tabType: 'sequence',
        title: 'PCR template',
      }),
    ]);
    mocks.resolveNativeCatalogDestination.mockResolvedValue(null);
    render(<ScientificDocumentTab filePath={filePath} />);

    expect(await screen.findByText(/preserved reference unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'template' })).not.toBeInTheDocument();
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
  });

  it('keeps the protocol visible when a preserved destination lookup fails', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    mockMigrationFiles(filePath, protocolDocument(), true);
    mocks.resolveNativeCatalogDestination.mockRejectedValue(new Error('Catalog unavailable'));

    render(<ScientificDocumentTab filePath={filePath} />);

    expect(await screen.findByDisplayValue('PCR')).toBeInTheDocument();
    expect(screen.getByLabelText('Step 1 content')).toHaveValue('Mix reagents');
    expect(
      screen.getByText(/some preserved project references are unavailable/i)
    ).toHaveTextContent(userMessage('failure.reference-lookup-failed'));
    expect(screen.queryByText(/document unavailable/i)).not.toBeInTheDocument();
  });

  it('keeps migration projections read-only until unlock', async () => {
    const filePath = '/ws/Benchling Imports/protein.faa';
    mockMigrationFiles(filePath, '>prot_1 Example protein\nMKWVTFIS\n', false);
    render(<ScientificDocumentTab filePath={filePath} />);

    expect(await screen.findByText(/read-only migration staging/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Amino-acid sequence')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/never sent to the nucleotide sequence viewer/i)).toBeInTheDocument();
  });

  it('opens a notebook workspace locator through path resolution before using its scoped page ID', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    const protocol = JSON.parse(protocolDocument());
    const notebookLink = protocol.overview.content[0].content[3];
    notebookLink.text = 'Notebook 1';
    notebookLink.marks[0].attrs.href = 'entity://workspace/benchling-notebook-1';
    notebookLink.marks[0].attrs.destinationTargetId = 'benchling-notebook-1';
    mockMigrationFiles(filePath, JSON.stringify(protocol), true, [
      destinationEntry({
        destinationObjectId: 'benchling-notebook-1',
        sourceStableIds: ['etr_notebook_1'],
        relativePath: 'Benchling Imports/Notebook 1/Notebook 1.wpnote.json',
        tabType: 'page',
        title: 'Notebook 1',
      }),
    ]);
    mocks.planWorkspaceArtifactRepair.mockResolvedValue({ kind: 'no-op' });
    mocks.resolveArtifactFile.mockResolvedValue({
      entity: { id: 'workspace-scoped-page-1' },
      artifact: {
        kind: 'notebook',
        id: 'workspace-scoped-page-1',
        title: 'Notebook 1',
        content: { type: 'doc', content: [] },
        raw: { updatedAt: '2026-10-02T00:00:00.000Z' },
      },
    });
    render(<ScientificDocumentTab filePath={filePath} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Notebook 1' }));
    await waitFor(() => expect(mocks.upsertPageFromArtifact).toHaveBeenCalledTimes(1));
    expect(mocks.reconcileEntitySnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        document: expect.objectContaining({ id: 'workspace-scoped-page-1' }),
      }),
      '/ws/Benchling Imports/Notebook 1/Notebook 1.wpnote.json',
      expect.objectContaining({ workspaceRoot: '/ws', workspaceId: 1 }),
      { conflictResolution: undefined }
    );
    expect(mocks.planWorkspaceArtifactRepair).toHaveBeenCalledWith({
      path: '/ws/Benchling Imports/Notebook 1/Notebook 1.wpnote.json',
      workspaceRoot: '/ws',
    });
    expect(mocks.resolveArtifactFile).toHaveBeenCalledWith({
      path: '/ws/Benchling Imports/Notebook 1/Notebook 1.wpnote.json',
      workspaceRoot: '/ws',
    });
    expect(mocks.upsertPageFromArtifact).toHaveBeenCalledWith({
      id: 'workspace-scoped-page-1',
      title: 'Notebook 1',
      content: { type: 'doc', content: [] },
      workspaceRoot: '/ws',
      mutationToken: undefined,
    });
    expect(mocks.openInFocusedPanel).toHaveBeenCalledWith(
      'page',
      'workspace-scoped-page-1',
      'Notebook 1'
    );
    expect(mocks.openInFocusedPanel).not.toHaveBeenCalledWith(
      'page',
      'benchling-notebook-1',
      expect.anything()
    );
  });

  it('keeps locked local targets visible without making them navigable', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    mockMigrationFiles(filePath, protocolDocument(), false, [
      destinationEntry({
        destinationObjectId: 'benchling-template-1',
        sourceStableIds: ['seq_template_1'],
        relativePath: 'Benchling Imports/Sequences/template.gb',
        tabType: 'sequence',
        title: 'PCR template',
      }),
    ]);
    render(<ScientificDocumentTab filePath={filePath} />);

    expect(await screen.findByText(/read-only migration staging/i)).toBeInTheDocument();
    expect(screen.getByText(/preserved reference unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'template' })).not.toBeInTheDocument();
    expect(mocks.openSequenceFile).not.toHaveBeenCalled();
  });

  it('preserves an unsafe provenance URL without rendering an executable href', async () => {
    const filePath = '/ws/Benchling Imports/PCR.dnaforge-protocol.json';
    const raw = JSON.parse(protocolDocument());
    raw.provenance.sourceUrl =
      'https://user:secret@example.benchling.com/example/protocols/prtl_pcr';
    mockMigrationFiles(filePath, JSON.stringify(raw), true);
    render(<ScientificDocumentTab filePath={filePath} />);

    expect(await screen.findByTestId('preserved-unsafe-source-reference')).toHaveTextContent(
      /unsafe navigation is unavailable/i
    );
    expect(
      screen.queryByRole('link', { name: /open immutable benchling source reference/i })
    ).not.toBeInTheDocument();
  });

  it('opens retired collection artifacts as read-only legacy folders with named members', async () => {
    const filePath = '/ws/Benchling Imports/Collections/archive/archive.dnaforge-collection.json';
    mockMigrationFiles(filePath, legacyCollectionDocument(), true, [
      destinationEntry({
        destinationObjectId: 'notebook-cccccccccccccccccccccccc',
        relativePath: 'Benchling Imports/Notebooks/readable/.forge/notebook.json',
        tabType: 'page',
        title: 'Readable notebook',
      }),
    ]);
    render(<ScientificDocumentTab filePath={filePath} />);

    expect(
      await screen.findByText('Legacy migration folder · read-only compatibility view')
    ).toBeVisible();
    expect(screen.getByText('Members (1)')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Readable notebook' })).toBeVisible();
    expect(screen.getByLabelText('Document title')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^save$/iu })).not.toBeInTheDocument();
  });
});

function mockMigrationFiles(
  filePath: string,
  document: string,
  unlocked: boolean,
  destinations: MigrationDestinationLinkIndexEntryInput[] = [],
  destinationSource: 'native_catalog' | 'legacy_index' = 'native_catalog'
) {
  void buildMigrationDestinationLinkIndexWriterPayload(destinations);
  mocks.resolveNativeCatalogDestination.mockImplementation(
    async ({ rawId }: { workspaceRoot: string; rawId: string }) => {
      const destination = destinations.find(
        (entry) => entry.destinationObjectId === rawId || entry.sourceStableIds.includes(rawId)
      );
      if (!destination) return null;
      if (destination.locator.kind === 'lims_entity') {
        return {
          source: destinationSource,
          rawId,
          entityId: destination.locator.entityId,
          title: destination.title,
          entityType: 'protein',
          locator: destination.locator,
        };
      }
      return {
        source: destinationSource,
        rawId,
        entityId: `ws::${destination.destinationObjectId}`,
        title: destination.title,
        entityType:
          destination.locator.tabType === 'page'
            ? 'notebook'
            : destination.locator.tabType === 'sequence'
              ? 'sequence'
              : 'file',
        locator: {
          kind: 'workspace_path',
          relativePath: destination.locator.relativePath,
          absolutePath: `/ws/${destination.locator.relativePath}`,
          tabType: destination.locator.tabType,
        },
      };
    }
  );
  mocks.readTextFile.mockImplementation(async (path: string) => {
    if (path === filePath) return document;
    if (path === '/ws/.dnaforge/migration/workspace.json') {
      return JSON.stringify({ status: unlocked ? 'unlocked' : 'locked' });
    }
    throw new Error(`Unexpected read: ${path}`);
  });
}

type TestDestinationEntryOverrides = Omit<
  Partial<MigrationDestinationLinkIndexEntryInput>,
  'locator'
> & {
  locator?: MigrationDestinationLinkIndexEntryInput['locator'];
  relativePath?: string;
  tabType?: Extract<
    MigrationDestinationLinkIndexEntryInput['locator'],
    { kind: 'workspace_path' }
  >['tabType'];
};

function destinationEntry(
  overrides: TestDestinationEntryOverrides = {}
): MigrationDestinationLinkIndexEntryInput {
  const { locator, relativePath, tabType, ...entryOverrides } = overrides;
  return {
    destinationObjectId: 'destination-default',
    sourceStableIds: ['source_default'],
    locator: locator ?? {
      kind: 'workspace_path',
      relativePath: relativePath ?? 'Benchling Imports/Objects/default.txt',
      tabType: tabType ?? 'text',
    },
    title: 'Default object',
    ...entryOverrides,
  };
}

function runDocument(): string {
  return JSON.stringify({
    schema: 'dnaforge.protocol-run.v1',
    kind: 'protocol_run',
    id: 'benchling-run-1',
    title: 'PCR verification run',
    status: 'completed',
    immutable: true,
    protocol: {
      sourceId: 'prtl_pcr',
      destinationId: 'benchling-protocol-1',
      name: 'PCR verification',
      pinnedVersionId: 'version_3',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
    },
    inputs: [{ key: 'template', label: 'Template', value: { type: 'record', label: 'pTemplate' } }],
    outputs: [],
    measurements: [],
    tables: [],
    links: [],
    startedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T01:00:00.000Z',
    amendments: [],
    provenance: {
      sourceUrl: 'https://example.benchling.com/example/etr/run_1',
    },
  });
}

function legacyCollectionDocument(): string {
  return JSON.stringify({
    schema: 'dnaforge.collection.v1',
    kind: 'collection',
    id: 'benchling-collection-aaaaaaaaaaaaaaaaaaaaaaaa',
    title: 'Archive folder',
    editable: true,
    parentCollectionId: null,
    childCollectionIds: [],
    memberObjectIds: ['notebook-cccccccccccccccccccccccc'],
    excludedChildFolders: [],
    provenance: {
      sourceUrl: 'https://example.benchling.com/folders/archive',
    },
  });
}

function protocolDocument(): string {
  return JSON.stringify({
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'benchling-protocol-1',
    title: 'PCR',
    editable: true,
    overview: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Read ' },
            {
              type: 'text',
              text: 'paper',
              marks: [{ type: 'link', attrs: { href: 'https://example.org/pcr' } }],
            },
            { type: 'text', text: ' and open ' },
            {
              type: 'text',
              text: 'template',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'entity://workspace/benchling-template-1',
                    destinationTargetId: 'benchling-template-1',
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    steps: [
      {
        id: 'step-1',
        sourceStepId: 'source-step-1',
        ordinal: 1,
        title: 'Prepare',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mix reagents' }] }],
        },
      },
      {
        id: 'step-2',
        sourceStepId: 'source-step-2',
        ordinal: 2,
        title: 'Cycle',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Run PCR' }] }],
        },
      },
    ],
    inputs: [],
    outputs: [],
    links: [],
    version: {
      sourceVersionId: 'version_3',
      pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
      immutable: true,
      importedAt: '2026-07-18T00:00:00.000Z',
    },
    provenance: {
      immutableSource: true,
      provider: 'benchling',
      sourceObjectId: 'source-protocol-1',
      stableSourceId: 'prtl_pcr',
      sourceUrl: 'https://example.benchling.com/example/protocols/prtl_pcr',
      sourceSchemaId: null,
      sourceCreatedAt: null,
      sourceModifiedAt: null,
      capturedAt: '2026-07-18T00:00:00.000Z',
    },
  });
}

function paperProtocolDocument(): string {
  const raw = JSON.parse(protocolDocument());
  const sourceHash = `sha256:${'a'.repeat(64)}`;
  raw.version = {
    sourceVersionId: sourceHash,
    pinnedVersionHash: sourceHash,
    immutable: true,
    importedAt: '2026-08-19T00:00:00.000Z',
  };
  raw.provenance = {
    immutableSource: true,
    provider: 'local-pdf',
    capturedAt: '2026-08-19T00:00:00.000Z',
  };
  raw.paperProtocol = {
    schema: 'dnaforge.paper-protocol.v1',
    candidate: {
      candidateSetId: 'paper-set-1',
      candidateId: 'paper-candidate-1',
      ordinal: 1,
      label: 'PCR',
      status: 'selected',
    },
    draft: { revision: 1, state: 'draft', reopenedFromAcceptedVersionId: null },
    sources: [
      {
        sourceId: 'source-pdf',
        kind: 'pdf',
        title: 'Paper PDF',
        mediaType: 'application/pdf',
        sha256: sourceHash,
        capturedAt: '2026-08-19T00:00:00.000Z',
        workspacePath: 'Papers/source.pdf',
        pageCount: 1,
      },
    ],
    evidence: [
      {
        evidenceId: 'evidence-1',
        stepId: 'step-1',
        sourceId: 'source-pdf',
        sourceSha256: sourceHash,
        evidenceClass: 'direct',
        quote: 'Mix reagents',
        locator: {
          kind: 'pdf_rects',
          page: 1,
          rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.05 }],
        },
      },
    ],
    gaps: [],
    acceptedVersions: [],
  };
  return JSON.stringify(raw);
}
