import { withUserMessage, userMessage } from '@waypoint/user-messages';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type {
  HostedReferenceCatalogEntryV1,
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetPreparationProgressV1,
} from '../../../shared/reference-assets-ipc';

const {
  mockOpenAssembly,
  mockImportLocalReference,
  mockImportHubGenomeReference,
  mockInspectUcscHub,
  mockFindUcscGenomes,
  mockDescribeUcscGenArkGenome,
  mockInstallHostedReference,
  mockListHostedReferences,
  mockListLocalReferences,
  mockOnHostedInstallProgress,
  mockOnReferencePreparationProgress,
  mockChoosePortableGenomeViewDocument,
  mockListTrackViews,
  mockReadTrackView,
  mockQueryLimsEntities,
  mockOpenTrackView,
  mockOpenSavedTrackView,
  mockGetPathForFile,
  mockAdmitPortableTracks,
  mockRecoverScenarioTrackView,
  mockTrackViewRecoveryDocument,
} = vi.hoisted(() => ({
  mockOpenAssembly: vi.fn(),
  mockImportLocalReference: vi.fn(),
  mockImportHubGenomeReference: vi.fn(),
  mockInspectUcscHub: vi.fn(),
  mockFindUcscGenomes: vi.fn(),
  mockDescribeUcscGenArkGenome: vi.fn(),
  mockInstallHostedReference: vi.fn(),
  mockListHostedReferences: vi.fn(),
  mockListLocalReferences: vi.fn(),
  mockOnHostedInstallProgress: vi.fn(),
  mockOnReferencePreparationProgress: vi.fn(),
  mockChoosePortableGenomeViewDocument: vi.fn(),
  mockListTrackViews: vi.fn(),
  mockReadTrackView: vi.fn(),
  mockQueryLimsEntities: vi.fn(),
  mockOpenTrackView: vi.fn(),
  mockOpenSavedTrackView: vi.fn(),
  mockGetPathForFile: vi.fn(),
  mockAdmitPortableTracks: vi.fn(),
  mockRecoverScenarioTrackView: vi.fn(),
  mockTrackViewRecoveryDocument: vi.fn(),
}));

vi.mock('../openAssembly', () => ({ openAssembly: mockOpenAssembly }));
vi.mock('../portable-genome-view-file', () => ({
  choosePortableGenomeViewDocument: mockChoosePortableGenomeViewDocument,
}));
vi.mock('../genome-view-file', () => ({
  chooseGenomeViewFile: async () => {
    const saved = await mockChoosePortableGenomeViewDocument();
    return saved ? { kind: 'legacy-portable-view', saved } : null;
  },
  readGenomeViewFile: async (path: string) => {
    const listed = await mockListTrackViews();
    const saved = listed.views.find((view: { path: string }) => view.path === path);
    if (!saved) throw new Error(`Unknown saved view: ${path}`);
    return { kind: 'track-view', saved };
  },
}));
vi.mock('../recover-scenario-track-view', () => ({
  recoverScenarioTrackView: mockRecoverScenarioTrackView,
}));
vi.mock('../track-view-recovery-document', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../track-view-recovery-document')>();
  return {
    ...actual,
    trackViewRecoveryDocument: (...args: Parameters<typeof actual.trackViewRecoveryDocument>) => {
      mockTrackViewRecoveryDocument(...args);
      return actual.trackViewRecoveryDocument(...args);
    },
  };
});
vi.mock('../open-track-view', () => ({
  openTrackView: mockOpenTrackView,
  openSavedTrackView: mockOpenSavedTrackView,
}));
vi.mock('../portable-genome-view-restore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../portable-genome-view-restore')>();
  return {
    ...actual,
    admitPortableTracks: (...args: Parameters<typeof actual.admitPortableTracks>) =>
      mockAdmitPortableTracks.getMockImplementation()
        ? mockAdmitPortableTracks(...args)
        : actual.admitPortableTracks(...args),
  };
});
vi.mock('../ucsc-track-client', () => ({
  inspectUcscHub: mockInspectUcscHub,
  findUcscGenomes: mockFindUcscGenomes,
  describeUcscGenArkGenome: mockDescribeUcscGenArkGenome,
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    referenceAssets: {
      importLocal: mockImportLocalReference,
      importHubGenome: mockImportHubGenomeReference,
      installHosted: mockInstallHostedReference,
      listHosted: mockListHostedReferences,
      listLocal: mockListLocalReferences,
      onHostedInstallProgress: mockOnHostedInstallProgress,
      onPreparationProgress: mockOnReferencePreparationProgress,
    },
    trackViews: {
      list: mockListTrackViews,
      read: mockReadTrackView,
    },
    lims: {
      queryEntities: mockQueryLimsEntities,
    },
    workspace: {
      getPathForFile: mockGetPathForFile,
    },
  }),
}));

import { trackViewFixture } from '../../../shared/track-view-fixture';
import { validateTrackViewDocument, type SavedTrackView } from '../../../shared/track-view';
import { PORTABLE_GENOME_VIEW_SCHEMA } from '@waypoint/genome-data';
import { referenceSignature } from '../bbi-reference-compatibility';
import { portableFingerprintFromIdentity } from '../portable-genome-view-adapter';
import { ASSEMBLY_REFERENCE_ASSET_GENERATION_V1 } from '../../../shared/indexed-genome';
import { useLaneContractStore } from '../lane-contract-store';
import type { OpenAssemblyOptions, OpenAssemblyViewRestore } from '../openAssembly';
import { buildGenomeAssembly, referenceAssemblyById } from '../reference-catalog';
import { ReferenceGenomePicker } from './ReferenceGenomePicker';
import { useToastStore } from '../../../stores/toast-store';
import {
  finishGenomeViewFileOpen,
  pendingGenomeViewFileOpen,
  requestGenomeViewFileOpen,
} from '../public/genome-view-open-request';

function hostedOpenRecoveryFixture(): {
  hosted: HostedReferenceCatalogEntryV1;
  prepared: PreparedReferenceAssemblyEntryV1;
} {
  const hosted: HostedReferenceCatalogEntryV1 = {
    id: 'controlled-reference',
    name: 'Controlled reference',
    organism: 'Synthetic fixture',
    description: 'Controlled hosted opening recovery.',
    cacheStatus: 'cached',
    lengthBp: 100,
    contigCount: 1,
    downloadBytes: 100,
    provider: 'Controlled fixture',
    datasetVersion: 'controlled-v1',
  };
  return {
    hosted,
    prepared: {
      id: hosted.id,
      name: hosted.name,
      organism: hosted.organism,
      description: hosted.description,
      assetCacheKey: hosted.id,
      members: [{ chrom: 'chr1', lengthBp: 100, circular: false }],
      portableView: {
        generationRoot: '/controlled/reference/generation-one',
        bundleFingerprint: 'a'.repeat(64),
        trackTypes: [],
      },
    },
  };
}

describe('ReferenceGenomePicker — assemblies section', () => {
  beforeEach(() => {
    mockOpenAssembly.mockReset();
    mockImportLocalReference.mockReset();
    mockImportHubGenomeReference.mockReset();
    mockInspectUcscHub.mockReset();
    mockFindUcscGenomes.mockReset();
    mockDescribeUcscGenArkGenome.mockReset();
    mockInstallHostedReference.mockReset();
    mockListHostedReferences.mockReset();
    mockListLocalReferences.mockReset();
    mockOnHostedInstallProgress.mockReset();
    mockOnReferencePreparationProgress.mockReset();
    mockChoosePortableGenomeViewDocument.mockReset().mockResolvedValue(null);
    mockListTrackViews.mockReset().mockResolvedValue({ views: [], errors: [] });
    mockReadTrackView.mockReset();
    mockQueryLimsEntities.mockReset().mockResolvedValue([]);
    mockOpenTrackView.mockReset().mockResolvedValue(undefined);
    mockOpenSavedTrackView.mockReset().mockResolvedValue('tab-1');
    mockGetPathForFile.mockReset().mockReturnValue('');
    mockAdmitPortableTracks.mockReset();
    mockRecoverScenarioTrackView.mockReset().mockImplementation(async (saved) => saved);
    mockTrackViewRecoveryDocument.mockReset();
    useToastStore.getState().clearToasts();
    mockOpenAssembly.mockResolvedValue('tab-1');
    mockListHostedReferences.mockResolvedValue([]);
    mockListLocalReferences.mockResolvedValue([]);
    mockOnHostedInstallProgress.mockReturnValue(() => {});
    mockOnReferencePreparationProgress.mockReturnValue(() => {});
    useLaneContractStore.getState().clear();
    cleanup();
  });

  afterEach(() => {
    finishGenomeViewFileOpen(null);
    useToastStore.getState().clearToasts();
  });

  it('keeps a background file open alive through StrictMode effect replay and cancels on real unmount', async () => {
    const path = '/tmp/held-view.dnaforge-track-view.json';
    const opened = requestGenomeViewFileOpen(path);
    const requestId = pendingGenomeViewFileOpen()!.id;
    mockListTrackViews.mockImplementation(() => new Promise(() => {}));

    const view = render(
      <StrictMode>
        <ReferenceGenomePicker
          open
          backgroundFileOpen
          backgroundFileOpenRequestId={requestId}
          onClose={() => {}}
        />
      </StrictMode>
    );
    await screen.findByTestId('genome-view-opening-status');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingGenomeViewFileOpen()?.id).toBe(requestId);

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    await expect(opened).resolves.toBeNull();
  });

  it('does not let a separate reference picker close cancel a Files open', async () => {
    const opened = requestGenomeViewFileOpen('/tmp/pending-view.dnaforge-track-view.json');
    const requestId = pendingGenomeViewFileOpen()!.id;
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(pendingGenomeViewFileOpen()?.id).toBe(requestId);
    finishGenomeViewFileOpen(null, requestId);
    await expect(opened).resolves.toBeNull();
  });

  it('keeps a failed Files open visible until the user dismisses its error', async () => {
    const path = '/tmp/unreadable-view.dnaforge-track-view.json';
    const opened = requestGenomeViewFileOpen(path);
    const requestId = pendingGenomeViewFileOpen()!.id;
    const onClose = vi.fn();
    render(
      <ReferenceGenomePicker
        open
        backgroundFileOpen
        backgroundFileOpenRequestId={requestId}
        onClose={onClose}
      />
    );

    await expect(
      screen.findByTestId('reference-picker-open-saved-view-error')
    ).resolves.toHaveTextContent(userMessage('tracks.loadFailed'));
    expect(pendingGenomeViewFileOpen()?.id).toBe(requestId);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    await expect(opened).resolves.toBeNull();
    expect(pendingGenomeViewFileOpen()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the embedded References workspace as one sortable genome table', async () => {
    mockListHostedReferences.mockResolvedValue([
      {
        id: 'grch38',
        name: 'GRCh38 (human)',
        organism: 'Homo sapiens',
        assembly: 'GRCh38.p14',
        description: 'Human primary assembly.',
        cacheStatus: 'not-cached',
        lengthBp: 3_088_269_832,
        contigCount: 24,
        downloadBytes: 1_061_733_652,
        provider: 'NCBI RefSeq',
        datasetVersion: 'GRCh38.p14',
        sourceUrl: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/',
      },
    ]);

    render(<ReferenceGenomePicker open embedded onClose={() => {}} />);

    const workspace = await screen.findByRole('region', { name: 'Reference genome library' });
    const savedViews = screen.getByTestId('saved-track-views');
    const genomeLibrary = screen.getByTestId('reference-genome-library');
    const hostedRow = await screen.findByTestId('reference-hosted-grch38');
    expect(workspace).toContainElement(savedViews);
    expect(workspace).toContainElement(genomeLibrary);
    expect(genomeLibrary).toContainElement(hostedRow);
    expect(screen.queryByRole('dialog', { name: 'Reference genome library' })).toBeNull();
    const toolbar = screen.getByTestId('reference-library-toolbar');
    expect(toolbar).toContainElement(screen.getByRole('heading', { name: 'References' }));
    expect(toolbar).toContainElement(screen.getByTestId('reference-picker-open-saved-view'));
    expect(toolbar).toContainElement(screen.getByTestId('reference-import-custom'));
    for (const column of [
      'Reference',
      'Assembly',
      'Source version',
      'Genome size',
      'Availability',
    ]) {
      expect(screen.getByRole('button', { name: `Sort by ${column}` })).toBeVisible();
    }
    expect(screen.queryByRole('button', { name: 'Sort by Download size' })).toBeNull();
    expect(screen.getByTestId('reference-genome-library-header').children).toHaveLength(5);

    const referenceSort = screen.getByRole('button', { name: 'Sort by Reference' });
    expect(referenceSort.querySelector('[data-sort-arrow="ascending"]')).toHaveTextContent('▲');
    expect(referenceSort.querySelector('[data-sort-arrow="descending"]')).toHaveTextContent('▼');
    expect(referenceSort.querySelector('[data-sort-arrow="ascending"]')).toHaveClass(
      'text-fg-subtle/40'
    );
    fireEvent.click(referenceSort);
    expect(referenceSort.querySelector('[data-sort-arrow="ascending"]')).toHaveClass('text-accent');

    const sourceLink = screen.getByRole('link', {
      name: 'Open NCBI RefSeq source for GRCh38 (human)',
    });
    expect(sourceLink).toHaveAttribute(
      'href',
      'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/'
    );
    expect(sourceLink).toHaveAttribute('target', '_blank');
    expect(sourceLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(sourceLink.closest('button')).toBeNull();
  });

  it('recovers managed sources before projecting a portable saved view', async () => {
    const base = validateTrackViewDocument(trackViewFixture('track-view-recovered-portable'));
    const saved: SavedTrackView = {
      path: '/tmp/recovered.dnaforge-track-view.json',
      workspaceRoot: '/tmp',
      revision: 'before-recovery',
      document: validateTrackViewDocument({
        ...base,
        portableReference: {
          kind: 'workspace-reference',
          entityId: base.reference.assemblyId,
          assemblyId: base.reference.assemblyId,
          contentFingerprint: `sha256:${'d'.repeat(64)}`,
          referenceSignature: await portableFingerprintFromIdentity(
            await referenceSignature([{ name: 'pUC19', length: 2686 }])
          ),
        },
      }),
    };
    const recovered = {
      ...saved,
      revision: 'after-recovery',
      document: { ...saved.document, updatedAt: '2026-11-04T00:00:00.000Z' },
    };
    let finishRecovery!: (saved: SavedTrackView) => void;
    mockRecoverScenarioTrackView.mockImplementation(
      () =>
        new Promise<SavedTrackView>((resolve) => {
          finishRecovery = resolve;
        })
    );
    mockListTrackViews.mockResolvedValue({ views: [saved], errors: [] });
    render(<ReferenceGenomePicker open embedded onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId(`saved-track-view-${saved.document.id}`));
    await waitFor(() => expect(mockRecoverScenarioTrackView).toHaveBeenCalledWith(saved));
    expect(mockTrackViewRecoveryDocument).not.toHaveBeenCalled();
    await act(async () => {
      finishRecovery(recovered);
    });
    await waitFor(() =>
      expect(mockTrackViewRecoveryDocument).toHaveBeenCalledWith(recovered.document)
    );
    expect(await screen.findByTestId('portable-reference-recovery')).toBeVisible();
    expect(mockOpenSavedTrackView).not.toHaveBeenCalled();
  });

  it.each(['all', 'chromosome', 'locus'] as const)(
    'retains the saved managed %s scope when opening its native file',
    async (kind) => {
      const catalog = referenceAssemblyById('grch38');
      if (!catalog) throw new Error('Missing GRCh38 catalog fixture');
      const bundleFingerprint = 'a'.repeat(64);
      const sourceFingerprint = 'b'.repeat(24);
      const inventoryFingerprint = 'c'.repeat(64);
      const prepared: PreparedReferenceAssemblyEntryV1 = {
        ...catalog,
        portableView: {
          generationRoot: '/reference-assets/grch38/view-generation',
          bundleFingerprint,
          trackTypes: ['gene'],
          assetGenerationsByTheme: {
            light: {
              contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
              sourceFingerprint,
              inventoryFingerprint,
              themeMode: 'light',
            },
          },
        },
      };
      const assembly = buildGenomeAssembly(prepared, (relative) => relative);
      let offset = 0;
      for (const chromosome of assembly.chromosomes) {
        if (chromosome.chrom === 'chr2') break;
        offset += chromosome.length;
      }
      const scope =
        kind === 'all'
          ? { kind }
          : kind === 'chromosome'
            ? { kind, chrom: 'chr2' }
            : { kind, chrom: 'chr2', start: 100, end: 800 };
      const saved: SavedTrackView = {
        path: '/tmp/saved-scope.dnaforge-track-view.json',
        workspaceRoot: '/tmp',
        revision: 'd'.repeat(64),
        document: validateTrackViewDocument({
          ...trackViewFixture('track-view-saved-scope'),
          reference: {
            assemblyId: catalog.id,
            name: catalog.name,
            chromosomes: assembly.chromosomes.map(({ chrom, length }) => ({ chrom, length })),
            sourceFingerprint,
            inventoryFingerprint,
            bundleFingerprint,
          },
          portableReference: {
            kind: 'hosted-reference',
            catalogId: catalog.id,
            assemblyId: catalog.id,
            bundleFingerprint,
            sourceFingerprint,
            inventoryFingerprint,
          },
          viewport: { start0: offset + 100, end0: offset + 800 },
          scope,
        }),
      };
      mockListTrackViews.mockResolvedValue({ views: [saved], errors: [] });
      mockInstallHostedReference.mockResolvedValue({ status: 'view-ready', entry: prepared });
      const opened = requestGenomeViewFileOpen(saved.path);
      const requestId = pendingGenomeViewFileOpen()!.id;
      render(
        <ReferenceGenomePicker
          open
          backgroundFileOpen
          backgroundFileOpenRequestId={requestId}
          onClose={() => {}}
        />
      );
      await expect(opened).resolves.toBe('tab-1');
      expect(mockOpenAssembly).toHaveBeenCalledWith(
        prepared,
        expect.objectContaining({
          restoreView: expect.objectContaining({
            scope,
            indexedViewport: saved.document.viewport,
          }),
        })
      );
      expect(useToastStore.getState().toasts).toEqual([]);
    }
  );

  it('returns to the viewer after a saved Track view opens from the permanent library', async () => {
    mockListTrackViews.mockResolvedValue({
      views: [
        {
          path: '/tmp/Saved view.dnaforge-track-view.json',
          workspaceRoot: null,
          document: {
            id: 'track-view-saved-view-1234',
            name: 'Saved view',
            updatedAt: '2026-09-18T08:00:00.000Z',
            reference: { assemblyId: 'sacCer3' },
            dataTracks: [],
            bamTracks: [],
          },
        },
      ],
      errors: [],
    });
    const onClose = vi.fn();

    render(<ReferenceGenomePicker open embedded onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('saved-track-view-track-view-saved-view-1234'));

    await waitFor(() =>
      expect(mockOpenSavedTrackView).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/tmp/Saved view.dnaforge-track-view.json' }),
        expect.objectContaining({ commitGuard: expect.any(Function) })
      )
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('expands reference details without opening the viewer and keeps saved views accessible', async () => {
    const savedPath = '/tmp/GRCh38 view.dnaforge-track-view.json';
    mockListTrackViews.mockResolvedValue({
      views: [
        {
          path: savedPath,
          workspaceRoot: null,
          document: {
            id: 'grch38-saved-view',
            name: 'GRCh38 saved view',
            updatedAt: '2026-09-18T08:00:00.000Z',
            reference: { assemblyId: 'grch38' },
            dataTracks: [],
            bamTracks: [],
          },
        },
      ],
      errors: [],
    });
    mockQueryLimsEntities.mockResolvedValue([
      {
        id: 'grch38-saved-view',
        kind: 'track-view',
        name: 'GRCh38 saved view',
        updatedAt: 1,
        tombstone: false,
        fields: { referenceAssemblyId: 'grch38', trackCount: 0 },
      },
    ]);
    mockReadTrackView.mockResolvedValue({ path: savedPath });
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);

    const row = await screen.findByTestId('reference-assembly-grch38');
    const details = within(row).getByRole('button', {
      name: 'Show details for GRCh38 (human)',
    });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(within(row).getByRole('button', { name: 'Open GRCh38 (human)' })).toBeVisible();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    const expanded = screen.getByTestId('reference-saved-views-grch38');
    expect(expanded).toBeVisible();
    expect(within(expanded).queryByRole('button', { name: 'Open GRCh38 (human)' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open GRCh38 (human)' })).toHaveLength(1);
    expect(
      await within(expanded).findByTestId('reference-saved-view-grch38-saved-view')
    ).toBeVisible();
    expect(mockOpenAssembly).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('reference-saved-view-grch38-saved-view'));
    await waitFor(() => expect(mockReadTrackView).toHaveBeenCalledWith('grch38-saved-view'));
    await waitFor(() =>
      expect(mockOpenSavedTrackView).toHaveBeenCalledWith(
        expect.objectContaining({ path: savedPath }),
        expect.objectContaining({ commitGuard: expect.any(Function) })
      )
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('labels cached and downloadable rows with non-color state plus light/dark treatments', async () => {
    mockListHostedReferences.mockResolvedValue([
      {
        id: 'cached-reference',
        name: 'Cached reference',
        organism: 'Cached organism',
        description: 'Already on this computer.',
        cacheStatus: 'cached',
        lengthBp: 12_400_000,
        contigCount: 1,
        downloadBytes: 875_000_000,
        provider: 'NCBI',
        datasetVersion: 'cached-v1',
      },
      {
        id: 'downloadable-reference',
        name: 'Downloadable reference',
        organism: 'Remote organism',
        description: 'Available from the catalog.',
        cacheStatus: 'not-cached',
        lengthBp: 850_000,
        contigCount: 1,
        downloadBytes: 875_000,
        provider: 'NCBI',
        datasetVersion: 'remote-v1',
      },
    ]);

    render(<ReferenceGenomePicker open embedded onClose={() => {}} />);

    const cached = await screen.findByTestId('reference-hosted-cached-reference-availability');
    expect(cached).toHaveAttribute('data-availability', 'cached');
    expect(within(cached).getByRole('button', { name: 'Open Cached reference' })).toBeVisible();
    expect(cached).not.toHaveTextContent('Ready');
    expect(cached).not.toHaveTextContent('Cached locally');
    expect(cached.className).toMatch(/text-green-600/u);
    expect(cached.className).toMatch(/dark:text-green-400/u);
    expect(cached.className).not.toMatch(/font-medium/u);
    expect(cached.className).not.toMatch(/(?:^|\s)(?:bg-|border|rounded)/u);
    const downloadable = screen.getByTestId('reference-hosted-downloadable-reference-availability');
    expect(downloadable).toHaveAttribute('data-availability', 'downloadable');
    const download = screen.getByRole('button', { name: 'Download Downloadable reference' });
    expect(downloadable).toContainElement(download);
    expect(download).toHaveTextContent('Download (875 KB)');
    expect(download.querySelector('span')?.className).not.toMatch(/text-/u);
    expect(download.className).toMatch(/text-blue-600/u);
    expect(download.className).toMatch(/dark:text-blue-400/u);
    expect(download.className).not.toMatch(/font-medium/u);
    expect(download.className).not.toMatch(/green/u);
    expect(download.lastElementChild?.tagName).toBe('svg');
    expect(download.querySelector('svg')).toHaveAttribute('stroke', 'currentColor');
    expect(downloadable.className).not.toMatch(/(?:^|\s)(?:bg-|border|rounded)/u);
    expect(screen.getByTestId('reference-hosted-downloadable-reference')).toHaveClass(
      'bg-bg-subtle/50'
    );
    expect(screen.getByTestId('reference-hosted-cached-reference')).toHaveTextContent('cached-v1');
    expect(screen.getByTestId('reference-hosted-cached-reference')).toHaveTextContent('NCBI');
    expect(screen.getByTestId('reference-hosted-cached-reference')).toHaveTextContent('12.4 Mb');
    expect(screen.getByTestId('reference-hosted-cached-reference')).not.toHaveTextContent('875 MB');
    expect(screen.getByTestId('reference-hosted-downloadable-reference')).toHaveTextContent(
      '850 kb'
    );
    expect(download).toHaveTextContent('875 KB');

    fireEvent.click(screen.getByTestId('reference-hosted-downloadable-reference'));
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
    fireEvent.click(download);
    await waitFor(() =>
      expect(mockInstallHostedReference).toHaveBeenCalledWith({
        catalogId: 'downloadable-reference',
        themeMode: 'light',
        intent: 'open-view',
      })
    );
  });

  it('sorts reference text and numeric columns in both directions', async () => {
    mockListHostedReferences.mockResolvedValue([
      {
        id: 'zeta-reference',
        name: 'Zeta reference',
        organism: 'Zeta organism',
        assembly: 'Z2',
        description: 'First catalog row.',
        cacheStatus: 'not-cached',
        lengthBp: 800_000,
        contigCount: 1,
        downloadBytes: 900_000,
        provider: 'Provider Z',
        datasetVersion: 'version-2',
      },
      {
        id: 'alpha-reference',
        name: 'Alpha reference',
        organism: 'Alpha organism',
        assembly: 'A1',
        description: 'Second catalog row.',
        cacheStatus: 'cached',
        lengthBp: 1_200_000,
        contigCount: 1,
        downloadBytes: 400_000,
        provider: 'Provider A',
        datasetVersion: 'version-1',
      },
    ]);

    render(<ReferenceGenomePicker open embedded onClose={() => {}} />);
    const hostedRows = () =>
      screen
        .getAllByTestId(/^reference-hosted-/)
        .map((row) => row.getAttribute('data-testid'))
        .filter(
          (testid): testid is string =>
            Boolean(testid) && !testid?.includes('-availability') && !testid?.includes('-download')
        );

    await screen.findByTestId('reference-hosted-zeta-reference');
    expect(hostedRows()).toEqual([
      'reference-hosted-zeta-reference',
      'reference-hosted-alpha-reference',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Reference' }));
    expect(hostedRows()).toEqual([
      'reference-hosted-alpha-reference',
      'reference-hosted-zeta-reference',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Reference' }));
    expect(hostedRows()).toEqual([
      'reference-hosted-zeta-reference',
      'reference-hosted-alpha-reference',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Assembly' }));
    expect(hostedRows()).toEqual([
      'reference-hosted-alpha-reference',
      'reference-hosted-zeta-reference',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Source version' }));
    expect(hostedRows()).toEqual([
      'reference-hosted-alpha-reference',
      'reference-hosted-zeta-reference',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Genome size' }));
    expect(hostedRows()).toEqual([
      'reference-hosted-zeta-reference',
      'reference-hosted-alpha-reference',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Availability' }));
    expect(hostedRows()).toEqual([
      'reference-hosted-zeta-reference',
      'reference-hosted-alpha-reference',
    ]);
    expect(
      screen.getByRole('button', { name: 'Sort by Availability' }).parentElement
    ).toHaveAttribute('aria-sort', 'ascending');
  });

  it.each(['installed', 'cold'])(
    'passes a saved hosted reference view through one guarded open transaction (%s)',
    async (cacheState) => {
      const catalog = referenceAssemblyById('grch38');
      expect(catalog).toBeDefined();
      const bundleFingerprint = 'a'.repeat(64);
      const sourceFingerprint = 'b'.repeat(24);
      const inventoryFingerprint = 'c'.repeat(64);
      const prepared: PreparedReferenceAssemblyEntryV1 = {
        ...catalog!,
        portableView: {
          generationRoot: '/reference-assets/grch38/view-generation',
          bundleFingerprint,
          trackTypes: ['mRNA', 'gene'],
          assetGenerationsByTheme: {
            light: {
              contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
              sourceFingerprint,
              inventoryFingerprint,
              themeMode: 'light',
            },
            dark: {
              contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
              sourceFingerprint,
              inventoryFingerprint,
              themeMode: 'dark',
            },
          },
        },
      };
      const document = {
        schema: PORTABLE_GENOME_VIEW_SCHEMA,
        kind: 'indexed-genome-view' as const,
        id: 'view-grch38-review',
        name: 'GRCh38 review view',
        provenance: {
          createdAt: '2026-09-01T08:00:00.000Z',
          updatedAt: '2026-09-01T08:00:00.000Z',
          createdBy: { kind: 'user' as const },
        },
        reference: {
          kind: 'hosted-reference' as const,
          catalogId: 'grch38',
          assemblyId: 'grch38',
          bundleFingerprint,
          sourceFingerprint,
          inventoryFingerprint,
        },
        viewport: { kind: 'locus' as const, chrom: 'chr1', start0: 120, end0: 420 },
        annotation: {
          policy: { isoformMode: 'expanded' as const, laneLimit: 12 },
          visibilityByTrackId: { gene: true, mRNA: false },
          orderedTrackIds: ['gene', 'mRNA'],
        },
        tracks: [
          {
            trackId: 'ucsc:grch38-gc5BaseBw',
            trackType: 'quantitative',
            label: 'GC percent',
            order: 0,
            visible: true,
            source: {
              kind: 'hosted-track' as const,
              provider: 'ucsc',
              catalogId: 'gc5BaseBw',
              assemblyId: 'grch38',
              contentFingerprint: `sha256:${'d'.repeat(64)}`,
              referenceSignature: `sha256:${'e'.repeat(64)}`,
            },
            presentation: {
              kind: 'quantitative' as const,
              color: '#3b82f6',
              trackHeightPx: 96,
              scale: { kind: 'auto' as const },
            },
          },
        ],
      };
      mockChoosePortableGenomeViewDocument.mockResolvedValue({
        filePath: '/tmp/grch38.dnaforge-genome-view.json',
        document,
      });
      mockInstallHostedReference.mockResolvedValue({ status: 'view-ready', entry: prepared });
      mockAdmitPortableTracks.mockResolvedValue({
        dataTracks: [],
        bamTracks: [],
        outcomes: [
          {
            trackId: 'ucsc:grch38-gc5BaseBw',
            label: 'GC percent',
            status: 'restored',
          },
        ],
      });
      if (cacheState === 'cold') {
        mockInstallHostedReference.mockResolvedValueOnce({
          status: 'view-ready',
          entry: {
            ...prepared,
            portableView: { ...prepared.portableView!, assetGenerationsByTheme: undefined },
          },
        });
      }
      let committedRestoreView: OpenAssemblyViewRestore | undefined;
      mockOpenAssembly.mockImplementation(
        async (_entry: PreparedReferenceAssemblyEntryV1, options?: OpenAssemblyOptions) => {
          if (options?.commitGuard && !options.commitGuard()) return null;
          committedRestoreView = options?.restoreView;
          if (!committedRestoreView) throw new Error('portable restore options were not supplied');
          return 'tab-1';
        }
      );
      const onClose = vi.fn();

      const rendered = render(<ReferenceGenomePicker open onClose={onClose} />);
      fireEvent.click(await screen.findByTestId('reference-picker-open-saved-view'));

      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(mockAdmitPortableTracks).toHaveBeenCalledWith(
        expect.objectContaining({
          tracks: expect.arrayContaining([expect.objectContaining({ label: 'GC percent' })]),
        })
      );
      expect(useToastStore.getState().toasts).toEqual([]);
      expect(mockInstallHostedReference).toHaveBeenNthCalledWith(1, {
        catalogId: 'grch38',
        themeMode: 'light',
        intent: 'open-view',
      });
      expect(mockInstallHostedReference).toHaveBeenCalledTimes(cacheState === 'cold' ? 2 : 1);
      if (cacheState === 'cold') {
        expect(mockInstallHostedReference).toHaveBeenNthCalledWith(2, {
          catalogId: 'grch38',
          themeMode: 'light',
          intent: 'require-ready',
        });
      }
      expect(committedRestoreView).toMatchObject({
        scope: { kind: 'locus', chrom: 'chr1', start: 120, end: 420 },
        dataTracks: [],
        indexedViewport: { start0: 120, end0: 420 },
        annotationTrackTypes: ['gene', 'mRNA'],
        command: {
          viewport: { kind: 'locus', chrom: 'chr1', start0: 120, end0: 420 },
          annotationPolicy: { isoformMode: 'expanded', laneLimit: 12 },
          visibleAnnotationTrackIds: ['gene'],
          orderedAnnotationTrackIds: ['gene', 'mRNA'],
        },
      });
      const firstRestoreCommandId = committedRestoreView?.command.id;
      expect(firstRestoreCommandId).toEqual(expect.any(String));

      rendered.rerender(<ReferenceGenomePicker open={false} onClose={onClose} />);
      rendered.rerender(<ReferenceGenomePicker open onClose={onClose} />);
      fireEvent.click(await screen.findByTestId('reference-picker-open-saved-view'));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
      expect(committedRestoreView?.command.id).not.toBe(firstRestoreCommandId);
    }
  );

  describe('saved view whose library reference is missing', () => {
    const CHROMOSOMES = [{ name: 'chrIV', length: 1_531_933 }];
    const labEntry = (id: string, name: string): PreparedReferenceAssemblyEntryV1 => ({
      id,
      name,
      organism: 'Saccharomyces cerevisiae',
      description: 'Custom reference imported from lab-chrIV.fa.',
      assetCacheKey: id,
      members: [
        {
          chrom: 'chrIV',
          lengthBp: 1_531_933,
          manifest: {
            fastaPath: 'prepared/chrIV/chrIV.fa',
            faiPath: 'prepared/chrIV/chrIV.fa.fai',
          },
        },
      ],
    });
    const savedViewFor = async (assemblyId: string) => ({
      filePath: '/tmp/lab.dnaforge-genome-view.json',
      document: {
        schema: PORTABLE_GENOME_VIEW_SCHEMA,
        kind: 'indexed-genome-view' as const,
        id: 'view-lab',
        name: 'Lab chrIV view',
        provenance: {
          createdAt: '2026-09-22T08:00:00.000Z',
          updatedAt: '2026-09-22T08:00:00.000Z',
          createdBy: { kind: 'user' as const },
        },
        reference: {
          kind: 'workspace-reference' as const,
          entityId: assemblyId,
          assemblyId,
          contentFingerprint: `sha256:${'d'.repeat(64)}`,
          referenceSignature: await portableFingerprintFromIdentity(
            await referenceSignature(CHROMOSOMES)
          ),
        },
        viewport: { kind: 'locus' as const, chrom: 'chrIV', start0: 1_000, end0: 2_000 },
        annotation: {
          policy: { isoformMode: 'canonical' as const, laneLimit: null },
          visibilityByTrackId: {},
          orderedTrackIds: [],
        },
        tracks: [],
      },
    });
    const MISSING_ID = `local-${'f'.repeat(24)}`;
    const IMPORTED_ID = `local-${'a'.repeat(24)}`;

    it('offers to add the reference and opens the view once its chromosome table matches', async () => {
      const onClose = vi.fn();
      mockChoosePortableGenomeViewDocument.mockResolvedValue(await savedViewFor(MISSING_ID));
      mockListLocalReferences.mockResolvedValue([]);
      mockImportLocalReference.mockResolvedValue({
        status: 'ready',
        entry: labEntry(IMPORTED_ID, 'lab-chrIV'),
      });
      mockOpenAssembly.mockResolvedValue('tab-lab');

      render(<ReferenceGenomePicker open onClose={onClose} />);
      fireEvent.click(await screen.findByTestId('reference-picker-open-saved-view'));
      const recovery = await screen.findByTestId('portable-reference-recovery');
      expect(recovery).toHaveTextContent('Restore Lab chrIV view');
      expect(recovery).toHaveTextContent(MISSING_ID);
      expect(screen.queryByTestId('reference-picker-open-saved-view-error')).toBeNull();
      expect(mockOpenAssembly).not.toHaveBeenCalled();
      expect(within(recovery).queryByRole('list')).toBeNull();

      fireEvent.click(within(recovery).getByTestId('portable-reference-recovery-add'));
      await waitFor(() =>
        expect(mockImportLocalReference).toHaveBeenCalledWith({
          operationId: expect.any(String),
          themeMode: 'light',
        })
      );
      await waitFor(() =>
        expect(mockOpenAssembly).toHaveBeenCalledWith(
          expect.objectContaining({ id: IMPORTED_ID, name: 'lab-chrIV' }),
          expect.objectContaining({
            restoreView: expect.objectContaining({
              scope: { kind: 'locus', chrom: 'chrIV', start: 1_000, end: 2_000 },
            }),
          })
        )
      );
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(screen.queryByTestId('portable-reference-recovery')).toBeNull();
    });

    it('keeps the recovery step open when the added reference has another chromosome table', async () => {
      mockChoosePortableGenomeViewDocument.mockResolvedValue(await savedViewFor(MISSING_ID));
      mockListLocalReferences.mockResolvedValue([]);
      mockImportLocalReference.mockResolvedValue({
        status: 'ready',
        entry: {
          ...labEntry(IMPORTED_ID, 'other-strain'),
          members: [{ chrom: 'chrIV', lengthBp: 1_531_000 }],
        },
      });

      render(<ReferenceGenomePicker open onClose={() => {}} />);
      fireEvent.click(await screen.findByTestId('reference-picker-open-saved-view'));
      const recovery = await screen.findByTestId('portable-reference-recovery');
      fireEvent.click(within(recovery).getByTestId('portable-reference-recovery-add'));

      expect(await screen.findByTestId('portable-reference-recovery-error')).toHaveTextContent(
        'Reference other-strain has a different chromosome table than the one this view was saved against.'
      );
      expect(screen.getByTestId('portable-reference-recovery')).toBeVisible();
      expect(screen.getByTestId('portable-reference-recovery-add')).toBeEnabled();
      expect(mockOpenAssembly).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('portable-reference-recovery-cancel'));
      expect(screen.queryByTestId('portable-reference-recovery')).toBeNull();
      await expect(screen.findByTestId('reference-picker-open-saved-view')).resolves.toBeEnabled();
    });

    it('lists library references with the same chromosome table and opens on the chosen one', async () => {
      const onClose = vi.fn();
      const twin = labEntry(`local-${'b'.repeat(24)}`, 'lab-chrIV (re-prepared)');
      const stranger: PreparedReferenceAssemblyEntryV1 = {
        ...labEntry(`local-${'c'.repeat(24)}`, 'other-chromosome'),
        members: [{ chrom: 'chrV', lengthBp: 576_874 }],
      };
      mockChoosePortableGenomeViewDocument.mockResolvedValue(await savedViewFor(MISSING_ID));
      mockListLocalReferences.mockResolvedValue([stranger, twin]);
      mockOpenAssembly.mockResolvedValue('tab-lab');

      render(<ReferenceGenomePicker open onClose={onClose} />);
      fireEvent.click(await screen.findByTestId('reference-picker-open-saved-view'));
      const recovery = await screen.findByTestId('portable-reference-recovery');
      const candidates = within(recovery).getByRole('list', {
        name: 'References with the same chromosome table',
      });
      expect(within(candidates).getAllByRole('listitem')).toHaveLength(1);
      expect(candidates).toHaveTextContent('lab-chrIV (re-prepared)');
      expect(candidates).not.toHaveTextContent('other-chromosome');

      fireEvent.click(within(recovery).getByTestId(`portable-reference-recovery-use-${twin.id}`));
      await waitFor(() =>
        expect(mockOpenAssembly).toHaveBeenCalledWith(
          expect.objectContaining({ id: twin.id }),
          expect.objectContaining({ annotationThemeMode: 'light' })
        )
      );
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(mockImportLocalReference).not.toHaveBeenCalled();
    });
  });

  it('does not commit a saved view after an external picker close', async () => {
    const catalog = referenceAssemblyById('grch38');
    if (!catalog) throw new Error('Missing GRCh38 catalog fixture');
    const bundleFingerprint = 'a'.repeat(64);
    const sourceFingerprint = 'b'.repeat(24);
    const inventoryFingerprint = 'c'.repeat(64);
    const prepared: PreparedReferenceAssemblyEntryV1 = {
      ...catalog,
      portableView: {
        generationRoot: '/reference-assets/grch38/view-generation',
        bundleFingerprint,
        trackTypes: ['gene'],
        assetGenerationsByTheme: {
          light: {
            contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
            sourceFingerprint,
            inventoryFingerprint,
            themeMode: 'light',
          },
        },
      },
    };
    mockChoosePortableGenomeViewDocument.mockResolvedValue({
      filePath: '/tmp/grch38-cancelled.dnaforge-genome-view.json',
      document: {
        schema: PORTABLE_GENOME_VIEW_SCHEMA,
        kind: 'indexed-genome-view',
        id: 'view-grch38-cancelled',
        name: 'Cancelled GRCh38 view',
        provenance: {
          createdAt: '2026-09-01T08:00:00.000Z',
          updatedAt: '2026-09-01T08:00:00.000Z',
          createdBy: { kind: 'user' },
        },
        reference: {
          kind: 'hosted-reference',
          catalogId: 'grch38',
          assemblyId: 'grch38',
          bundleFingerprint,
          sourceFingerprint,
          inventoryFingerprint,
        },
        viewport: { kind: 'all' },
        annotation: {
          policy: { isoformMode: 'canonical', laneLimit: 2 },
          visibilityByTrackId: { gene: true },
          orderedTrackIds: ['gene'],
        },
        tracks: [],
      },
    });
    mockInstallHostedReference.mockResolvedValue({ status: 'view-ready', entry: prepared });
    let releaseOpen: (() => void) | null = null;
    let commitAllowedAfterClose: boolean | null = null;
    mockOpenAssembly.mockImplementation(
      (_entry: PreparedReferenceAssemblyEntryV1, options?: OpenAssemblyOptions) =>
        new Promise<string | null>((resolve) => {
          releaseOpen = () => {
            commitAllowedAfterClose = options?.commitGuard?.() ?? true;
            if (!commitAllowedAfterClose) {
              resolve(null);
              return;
            }
            resolve('unexpected-tab');
          };
        })
    );

    const onClose = vi.fn();
    const rendered = render(<ReferenceGenomePicker open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('reference-picker-open-saved-view'));
    await waitFor(() => expect(mockOpenAssembly).toHaveBeenCalledOnce());

    rendered.rerender(<ReferenceGenomePicker open={false} onClose={onClose} />);
    await act(async () => {
      releaseOpen?.();
      await Promise.resolve();
    });

    expect(commitAllowedAfterClose).toBe(false);
    expect(useLaneContractStore.getState().lanesForOwner('unexpected-tab')).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the genome-wide Assemblies section with the GRCh38 entry', async () => {
    render(<ReferenceGenomePicker open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('reference-picker-assemblies')).toBeTruthy());
    const grch38 = screen.getByTestId('reference-assembly-grch38');
    expect(grch38.textContent).toContain('GRCh38 (human)');
    expect(grch38.textContent).toContain('24 chr');
    expect(grch38.textContent).toContain('24 indexed');
  });

  it('opens GRCh38 only from its Open button', async () => {
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);
    const grch38 = await screen.findByTestId('reference-assembly-grch38');
    const details = within(grch38).getByRole('button', {
      name: 'Show details for GRCh38 (human)',
    });
    const open = within(grch38).getByRole('button', { name: 'Open GRCh38 (human)' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(details);
    expect(screen.getByTestId('reference-saved-views-grch38')).toBeVisible();
    expect(mockOpenAssembly).not.toHaveBeenCalled();
    fireEvent.click(open);
    await waitFor(() => expect(mockOpenAssembly).toHaveBeenCalledTimes(1));
    expect(mockOpenAssembly.mock.calls[0][0]).toMatchObject({ id: 'grch38' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an actionable reference error without development-only fixture instructions', async () => {
    mockOpenAssembly.mockRejectedValue(
      new Error(
        'Prepared reference files are missing for chr2. Add the reference again from its original folder or package.'
      )
    );
    render(<ReferenceGenomePicker open onClose={() => {}} />);

    const row = await screen.findByTestId('reference-assembly-grch38');
    fireEvent.click(within(row).getByRole('button', { name: 'Open GRCh38 (human)' }));

    expect(await screen.findByText(/Prepared reference files are missing for chr2/u)).toBeVisible();
    expect(screen.queryByText(/download-ncbi-fixtures/u)).toBeNull();
  });

  it('renders only whole assemblies and hides retired or narrowed cached entries', async () => {
    mockListHostedReferences.mockResolvedValue([
      {
        id: 'puc19-l09137-2',
        name: 'pUC19',
        organism: 'synthetic DNA construct',
        assembly: 'L09137.2',
        description: 'Retired cloning vector.',
        lengthBp: 2686,
        contigCount: 1,
        downloadBytes: 4423,
        provider: 'NCBI',
        datasetVersion: 'L09137.2',
      },
    ]);
    mockListLocalReferences.mockResolvedValue([
      {
        id: 'puc19-l09137-2',
        name: 'pUC19',
        organism: 'synthetic DNA construct',
        assembly: 'L09137.2',
        description: 'Retired cached cloning vector.',
        assetCacheKey: 'puc19-l09137-2',
        members: [],
      },
      {
        id: 'grcm39',
        name: 'GRCm39 (mouse)',
        organism: 'Mus musculus',
        assembly: 'GRCm39',
        description: 'Mouse reference genome.',
        assetCacheKey: 'grcm39',
        members: [],
      },
    ]);

    render(<ReferenceGenomePicker open onClose={() => {}} />);

    expect(await screen.findByTestId('reference-local-grcm39')).toBeVisible();
    expect(screen.queryByText('pUC19')).toBeNull();
    expect(screen.queryByText('E. coli MG1655')).toBeNull();
    expect(screen.queryByText('S. cerevisiae chrIV')).toBeNull();
    expect(screen.queryByText('GRCh38 chr22')).toBeNull();
  });

  it('shows the real cold assembly phase and genomic span while pre-tab indexing is pending', async () => {
    let finish!: (tabId: string | null) => void;
    mockOpenAssembly.mockImplementation(
      async (
        _entry: unknown,
        options: { onProgress?: (progress: { phase: string; label: string }) => void }
      ) => {
        options.onProgress?.({
          phase: 'building-annotation-indexes',
          label: 'Building annotation indexes',
        });
        return new Promise<string | null>((resolve) => {
          finish = resolve;
        });
      }
    );
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);
    const grch38 = await screen.findByTestId('reference-assembly-grch38');
    const open = within(grch38).getByRole('button', { name: 'Open GRCh38 (human)' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);

    const progress = await screen.findByRole('progressbar', {
      name: 'GRCh38 (human) indexing progress',
    });
    expect(progress).not.toHaveAttribute('value');
    expect(progress).not.toHaveAttribute('aria-valuenow');
    expect(progress).toHaveAttribute('aria-valuetext', 'Building annotation indexes');
    expect(screen.getByText('Current step: Building annotation indexes')).toBeVisible();
    expect(screen.getByText('3.09 Gb genomic span · 24 chromosomes')).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    finish('tab-1');
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('opens one Add reference modal and imports without asking for a source kind first', async () => {
    const onClose = vi.fn();
    mockImportLocalReference.mockResolvedValue({
      status: 'ready',
      entry: {
        id: 'local-puc19',
        name: 'pUC19',
        organism: 'synthetic DNA construct',
        description: 'Imported reference',
        assetCacheKey: 'local-puc19',
        members: [
          {
            chrom: 'puc19',
            displayName: 'puc19',
            lengthBp: 2686,
            circular: true,
            manifest: {
              fastaPath: 'prepared/puc19/puc19.fa',
              faiPath: 'prepared/puc19/puc19.fa.fai',
              gffPath: 'prepared/puc19/puc19.gff3.gz',
              tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
            },
          },
        ],
      },
    });

    const { rerender } = render(<ReferenceGenomePicker open onClose={onClose} />);
    const importButton = await screen.findByTestId('reference-import-custom');
    expect(importButton).toHaveAccessibleName('Add reference');
    expect(screen.queryByText(/manifest/i)).toBeNull();

    fireEvent.click(importButton);
    expect(mockImportLocalReference).not.toHaveBeenCalled();
    const modal = await screen.findByRole('dialog', { name: 'Add reference' });
    expect(modal).toBeVisible();
    expect(screen.getByLabelText('Assembly link')).toBeVisible();
    expect(modal).not.toHaveTextContent('does not upload your source');
    expect(modal).not.toHaveTextContent('Paste an accession such as');
    expect(screen.queryByText('Choose folder')).toBeNull();
    expect(screen.queryByText('Choose file or package')).toBeNull();
    expect(screen.getByTestId('reference-genome-library')).not.toContainElement(modal);
    fireEvent.click(screen.getByTestId('reference-import-browse'));

    await waitFor(() =>
      expect(mockImportLocalReference).toHaveBeenCalledWith({
        operationId: expect.any(String),
        themeMode: 'light',
      })
    );
    await waitFor(() =>
      expect(mockOpenAssembly).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'local-puc19', name: 'pUC19' }),
        expect.objectContaining({ annotationThemeMode: 'light' })
      )
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

    rerender(<ReferenceGenomePicker open={false} onClose={onClose} />);
    rerender(<ReferenceGenomePicker open onClose={onClose} />);
    await expect(screen.findByTestId('reference-import-custom')).resolves.not.toBeDisabled();
  });

  it('keeps Add reference idle while Browse is still choosing a file', async () => {
    mockImportLocalReference.mockReturnValue(new Promise(() => undefined));
    render(<ReferenceGenomePicker open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.click(screen.getByTestId('reference-import-browse'));

    expect(screen.getByTestId('reference-import-browse')).toHaveTextContent('Browse…');
    expect(screen.queryByTestId('reference-import-progress')).toBeNull();
    expect(screen.queryByText('Inspecting selected source')).toBeNull();
  });

  it('sends a bare NCBI assembly accession', async () => {
    mockImportLocalReference.mockResolvedValue({ status: 'cancelled' });
    render(<ReferenceGenomePicker open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.change(await screen.findByTestId('reference-import-ncbi-link'), {
      target: { value: 'GCF_000008865.2' },
    });
    fireEvent.click(screen.getByTestId('reference-import-ncbi-open'));

    await waitFor(() =>
      expect(mockImportLocalReference).toHaveBeenCalledWith({
        operationId: expect.any(String),
        themeMode: 'light',
        assemblyLink: 'GCF_000008865.2',
      })
    );
  });

  it('opens an NCBI assembly link through the same preparation path', async () => {
    const onClose = vi.fn();
    mockImportLocalReference.mockResolvedValue({
      status: 'ready',
      entry: {
        id: 'local-ncbi',
        name: 'Escherichia coli',
        organism: 'Escherichia coli',
        description: 'Imported reference',
        assetCacheKey: 'local-ncbi',
        members: [
          {
            chrom: 'chr',
            displayName: 'chr',
            lengthBp: 4641652,
            circular: false,
            manifest: {
              fastaPath: 'prepared/ecoli/ecoli.fa',
              faiPath: 'prepared/ecoli/ecoli.fa.fai',
              gffPath: 'prepared/ecoli/ecoli.gff3.gz',
              tbiPath: 'prepared/ecoli/ecoli.gff3.gz.tbi',
            },
          },
        ],
      },
    });
    render(<ReferenceGenomePicker open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    const link = await screen.findByTestId('reference-import-ncbi-link');
    fireEvent.change(link, {
      target: { value: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000005845.2/' },
    });
    fireEvent.click(screen.getByTestId('reference-import-ncbi-open'));

    await waitFor(() =>
      expect(mockImportLocalReference).toHaveBeenCalledWith({
        operationId: expect.any(String),
        themeMode: 'light',
        assemblyLink: 'https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000005845.2/',
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add reference' })).not.toBeInTheDocument()
    );
    expect(await screen.findByTestId('reference-custom-references')).toHaveTextContent(
      'Escherichia coli'
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a running assembly link under Custom references instead of the dialog', async () => {
    mockImportLocalReference.mockReturnValue(new Promise(() => undefined));
    render(<ReferenceGenomePicker open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.change(await screen.findByTestId('reference-import-ncbi-link'), {
      target: { value: 'https://www.ebi.ac.uk/ena/browser/view/GCF_000008865.2' },
    });
    fireEvent.click(screen.getByTestId('reference-import-ncbi-open'));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add reference' })).not.toBeInTheDocument()
    );
    const custom = await screen.findByTestId('reference-custom-references');
    expect(custom).toHaveTextContent('GCF_000008865.2');
    expect(custom).toHaveTextContent('Checking the library');
    expect(screen.queryByText(/DNAForge detects whether/u)).toBeNull();
  });

  it('imports a GenArk assembly through the hub lookup and opens it', async () => {
    const onClose = vi.fn();
    mockFindUcscGenomes.mockResolvedValue([
      {
        accession: 'GCF_000146045.2',
        hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
        scientificName: 'Saccharomyces cerevisiae',
        commonName: "baker's yeast",
        description: 'R64 559292 2014-12-17',
      },
    ]);
    mockDescribeUcscGenArkGenome.mockResolvedValue({
      accession: 'GCF_000146045.2',
      hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
      assemblyName: 'R64',
      scientificName: 'Saccharomyces cerevisiae',
      taxId: 559292,
    });
    mockInspectUcscHub.mockResolvedValue({
      hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
      genomes: [
        {
          name: 'GCF_000146045.2',
          organism: 'R64 Dec. 2014',
          assemblyHub: true,
          twoBitPath: 'GCF_000146045.2.2bit',
        },
      ],
    });
    const entry = {
      id: 'local-yeast',
      name: 'R64 (GCF_000146045.2)',
      organism: 'Saccharomyces cerevisiae',
      description: 'UCSC GenArk assembly GCF_000146045.2.',
      assetCacheKey: 'local-yeast',
      members: [
        {
          chrom: 'chrIV',
          lengthBp: 1_531_933,
          manifest: {
            fastaPath: 'prepared/chrIV/chrIV.fa',
            faiPath: 'prepared/chrIV/chrIV.fa.fai',
          },
        },
      ],
    };
    mockImportHubGenomeReference.mockResolvedValue({ status: 'ready', entry });
    mockOpenAssembly.mockResolvedValue('tab-yeast');

    render(<ReferenceGenomePicker open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    const panel = await screen.findByTestId('reference-import-hub');
    fireEvent.change(screen.getByLabelText('Hub address or GenArk search'), {
      target: { value: 'cerevisiae' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() => expect(mockFindUcscGenomes).toHaveBeenCalledWith('cerevisiae'));
    const row = await within(panel).findByRole('listitem');
    expect(row).toHaveTextContent("baker's yeast");
    expect(row).toHaveTextContent('GCF_000146045.2');
    fireEvent.click(within(row).getByRole('button', { name: 'Add GCF_000146045.2' }));

    await waitFor(() =>
      expect(mockImportHubGenomeReference).toHaveBeenCalledWith({
        operationId: expect.any(String),
        themeMode: 'light',
        hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
        genome: 'GCF_000146045.2',
        twoBitPath: 'GCF_000146045.2.2bit',
        provider: 'genark',
        organism: 'Saccharomyces cerevisiae',
        assemblyName: 'R64',
        taxId: 559292,
      })
    );
    expect(mockDescribeUcscGenArkGenome).toHaveBeenCalledWith('GCF_000146045.2');
    expect(mockInspectUcscHub).toHaveBeenCalledWith(
      'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt'
    );
    expect(mockImportLocalReference).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockOpenAssembly).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'local-yeast', name: 'R64 (GCF_000146045.2)' }),
        expect.objectContaining({ annotationThemeMode: 'light' })
      )
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('offers an assembly hub genome only when the hub publishes its sequence', async () => {
    mockInspectUcscHub.mockResolvedValue({
      hubUrl: 'https://yeast-hub.example.org/hub.txt',
      genomes: [
        { name: 'sacCer2', organism: 'S. cerevisiae', assemblyHub: false },
        {
          name: 'sacCer3',
          organism: 'S. cerevisiae',
          description: 'Deterministic chromosome-IV lab data',
          assemblyHub: true,
          twoBitPath: 'sacCer3/sacCer3.2bit',
        },
      ],
    });
    mockImportHubGenomeReference.mockImplementation(() => new Promise(() => {}));
    render(<ReferenceGenomePicker open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    const panel = await screen.findByTestId('reference-import-hub');
    fireEvent.change(screen.getByLabelText('Hub address or GenArk search'), {
      target: { value: 'https://yeast-hub.example.org/hub.txt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));

    const list = await within(panel).findByRole('list', {
      name: 'Assemblies in yeast-hub.example.org',
    });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('sacCer2');
    expect(rows[0]).toHaveTextContent('Track hub only, no sequence');
    expect(within(rows[0]!).queryByRole('button')).toBeNull();
    expect(mockFindUcscGenomes).not.toHaveBeenCalled();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Add sacCer3' }));

    await waitFor(() =>
      expect(mockImportHubGenomeReference).toHaveBeenCalledWith({
        operationId: expect.any(String),
        themeMode: 'light',
        hubUrl: 'https://yeast-hub.example.org/hub.txt',
        genome: 'sacCer3',
        twoBitPath: 'sacCer3/sacCer3.2bit',
        provider: 'assembly-hub',
        organism: 'S. cerevisiae',
      })
    );
    expect(screen.getByTestId('reference-import-browse')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled();
    expect(screen.getByTestId('reference-import-custom')).toBeDisabled();
  });

  it('shows a hub lookup failure inside the panel without leaving the modal', async () => {
    mockInspectUcscHub.mockRejectedValue(
      withUserMessage(
        new Error('UCSC returned no assemblies for this track hub.'),
        'guidance.ucsc-returned-no-assemblies-for-this-track-hub'
      )
    );
    render(<ReferenceGenomePicker open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.change(await screen.findByLabelText('Hub address or GenArk search'), {
      target: { value: 'https://empty.example.org/hub.txt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByTestId('reference-import-hub-error')).toHaveTextContent(
      'UCSC returned no assemblies for this track hub.'
    );
    expect(screen.getByRole('dialog', { name: 'Add reference' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Look up' })).toBeEnabled();
    expect(mockImportHubGenomeReference).not.toHaveBeenCalled();
  });

  it('routes a dropped file through the same source-intake control', async () => {
    mockImportLocalReference.mockResolvedValue({ status: 'cancelled' });
    mockGetPathForFile.mockReturnValue('/source/arabidopsis.zip');
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    const source = new File(['zip fixture'], 'arabidopsis.zip', { type: 'application/zip' });
    fireEvent.drop(await screen.findByTestId('reference-import-source'), {
      dataTransfer: { files: [source] },
    });

    await waitFor(() =>
      expect(mockImportLocalReference).toHaveBeenCalledWith({
        operationId: expect.any(String),
        themeMode: 'light',
        sourcePath: '/source/arabidopsis.zip',
      })
    );
    expect(mockGetPathForFile).toHaveBeenCalledWith(source);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps an invalid dropped source recoverable inside the modal', async () => {
    mockGetPathForFile.mockReturnValue('');
    render(<ReferenceGenomePicker open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.drop(await screen.findByTestId('reference-import-source'), {
      dataTransfer: { files: [new File(['bad'], 'unsupported.txt', { type: 'text/plain' })] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('reference.dropUnavailable')
    );
    expect(screen.getByTestId('reference-import-browse')).toBeEnabled();
    expect(mockImportLocalReference).not.toHaveBeenCalled();
  });

  it('closes an untouched Add reference modal without importing', async () => {
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    const modal = await screen.findByRole('dialog', { name: 'Add reference' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel adding reference' }));

    await waitFor(() => expect(modal).not.toBeInTheDocument());
    expect(mockImportLocalReference).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('recovers from an import error without leaving the Add reference modal', async () => {
    mockImportLocalReference.mockRejectedValue(new Error('Unsupported reference source.'));
    render(<ReferenceGenomePicker open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.click(await screen.findByTestId('reference-import-browse'));

    const modal = await screen.findByRole('dialog', { name: 'Add reference' });
    expect(modal).toHaveTextContent(userMessage('tracks.loadFailed'));
    expect(screen.getByTestId('reference-import-browse')).toBeEnabled();
    mockImportLocalReference.mockResolvedValue({ status: 'cancelled' });
    fireEvent.click(screen.getByTestId('reference-import-browse'));
    await waitFor(() => expect(mockImportLocalReference).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog', { name: 'Add reference' })).toBeVisible();
  });

  it('shows the added reference while its indexed viewer is opening', async () => {
    const prepared: PreparedReferenceAssemblyEntryV1 = {
      id: 'local-added-reference',
      name: 'Added reference',
      organism: 'Test organism',
      description: 'Imported reference',
      assetCacheKey: 'local-added-reference',
      members: [
        {
          chrom: 'chr1',
          displayName: 'chr1',
          lengthBp: 850_000,
          circular: false,
          manifest: {
            fastaPath: 'prepared/chr1/chr1.fa',
            faiPath: 'prepared/chr1/chr1.fa.fai',
          },
        },
      ],
    };
    mockImportLocalReference.mockResolvedValue({ status: 'ready', entry: prepared });
    let finishOpen!: (tabId: string | null) => void;
    mockOpenAssembly.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        })
    );
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.click(await screen.findByTestId('reference-import-browse'));

    expect(await screen.findByTestId('reference-import-success')).toHaveTextContent(
      'Added reference is ready'
    );
    expect(
      within(screen.getByTestId('reference-local-local-added-reference')).getByRole('button', {
        name: 'Open Added reference',
      })
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    finishOpen('tab-added');
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('accepts progress only for the active renderer-owned import operation and clears terminal state', async () => {
    let progressListener: ((progress: ReferenceAssetPreparationProgressV1) => void) | undefined;
    mockOnReferencePreparationProgress.mockImplementation((listener) => {
      progressListener = listener;
      return () => {};
    });
    let finishImport!: (result: { status: 'cancelled' }) => void;
    mockImportLocalReference.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        })
    );
    render(<ReferenceGenomePicker open onClose={() => {}} />);

    const importButton = await screen.findByTestId('reference-import-custom');
    fireEvent.click(importButton);
    fireEvent.click(await screen.findByTestId('reference-import-browse'));
    await waitFor(() => expect(mockImportLocalReference).toHaveBeenCalledOnce());
    const operationId = mockImportLocalReference.mock.calls[0]?.[0]?.operationId;
    expect(operationId).toEqual(expect.any(String));
    if (typeof operationId !== 'string') throw new Error('Missing renderer import operation id.');
    expect(importButton).toBeDisabled();

    act(() => {
      progressListener?.({
        operationId: 'another-import',
        phase: 'ready',
        label: 'Another reference is ready',
        completed: 1,
        total: 1,
      });
    });
    expect(importButton).toBeDisabled();

    act(() => {
      progressListener?.({
        operationId,
        phase: 'ready',
        label: 'Selected reference is ready',
        completed: 1,
        total: 1,
      });
    });
    expect(importButton).toBeDisabled();
    expect(screen.queryByTestId('reference-import-progress')).toBeNull();

    await act(async () => {
      finishImport({ status: 'cancelled' });
    });
    await waitFor(() => expect(importButton).not.toBeDisabled());
  });

  it('keeps the recognized source visible after later preparation labels arrive', async () => {
    let progressListener: ((progress: ReferenceAssetPreparationProgressV1) => void) | undefined;
    mockOnReferencePreparationProgress.mockImplementation((listener) => {
      progressListener = listener;
      return () => {};
    });
    mockImportLocalReference.mockImplementation(() => new Promise(() => {}));
    render(<ReferenceGenomePicker open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.click(await screen.findByTestId('reference-import-browse'));
    await waitFor(() => expect(mockImportLocalReference).toHaveBeenCalledOnce());
    const operationId = mockImportLocalReference.mock.calls[0]?.[0]?.operationId;
    if (typeof operationId !== 'string') throw new Error('Missing renderer import operation id.');

    act(() => {
      progressListener?.({
        operationId,
        phase: 'source-recognized',
        label: 'Standalone FASTA recognized',
      });
    });
    act(() => {
      progressListener?.({
        operationId,
        phase: 'indexing-sequence',
        label: 'Indexing reference sequence',
      });
    });

    const progress = screen.getByTestId('reference-import-progress');
    expect(progress).toHaveTextContent('Standalone FASTA recognized');
    expect(progress).toHaveTextContent('Indexing reference sequence');
  });

  it('ignores stale import progress and completion after the picker closes and reopens', async () => {
    let progressListener: ((progress: ReferenceAssetPreparationProgressV1) => void) | undefined;
    mockOnReferencePreparationProgress.mockImplementation((listener) => {
      progressListener = listener;
      return () => {};
    });
    let finishImport!: (
      result: { status: 'cancelled' } | { status: 'ready'; entry: PreparedReferenceAssemblyEntryV1 }
    ) => void;
    mockImportLocalReference.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        })
    );
    const onClose = vi.fn();
    const { rerender } = render(<ReferenceGenomePicker open onClose={onClose} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.click(await screen.findByTestId('reference-import-browse'));
    await waitFor(() => expect(mockImportLocalReference).toHaveBeenCalledOnce());
    const operationId = mockImportLocalReference.mock.calls[0]?.[0]?.operationId;
    if (typeof operationId !== 'string') throw new Error('Missing renderer import operation id.');

    rerender(<ReferenceGenomePicker open={false} onClose={onClose} />);
    rerender(<ReferenceGenomePicker open onClose={onClose} />);
    const importButton = await screen.findByTestId('reference-import-custom');
    await waitFor(() => expect(importButton).not.toBeDisabled());

    act(() => {
      progressListener?.({
        operationId,
        phase: 'indexing-fasta',
        label: 'Stale preparation progress',
      });
    });
    expect(importButton).not.toBeDisabled();
    expect(screen.queryByText('Stale preparation progress')).toBeNull();

    const preparedEntry: PreparedReferenceAssemblyEntryV1 = {
      id: 'local-stale-import',
      name: 'Stale import',
      organism: 'Test organism',
      description: 'Imported reference',
      assetCacheKey: 'local-stale-import',
      members: [
        {
          chrom: 'chr1',
          displayName: 'chr1',
          lengthBp: 100,
          circular: false,
          manifest: {
            fastaPath: 'prepared/chr1/chr1.fa',
            faiPath: 'prepared/chr1/chr1.fa.fai',
            gffPath: null,
            tbiPath: null,
          },
        },
      ],
    };
    await act(async () => {
      finishImport({ status: 'ready', entry: preparedEntry });
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(mockOpenAssembly).not.toHaveBeenCalled();
    expect(importButton).not.toBeDisabled();
  });

  it('keeps a failed open visible and ignores later progress from that settled import', async () => {
    let progressListener: ((progress: ReferenceAssetPreparationProgressV1) => void) | undefined;
    mockOnReferencePreparationProgress.mockImplementation((listener) => {
      progressListener = listener;
      return () => {};
    });
    mockImportLocalReference.mockResolvedValue({
      status: 'ready',
      entry: {
        id: 'local-open-failure',
        name: 'Open failure',
        organism: 'Test organism',
        description: 'Imported reference',
        assetCacheKey: 'local-open-failure',
        members: [
          {
            chrom: 'chr1',
            displayName: 'chr1',
            lengthBp: 100,
            circular: false,
            manifest: {
              fastaPath: 'prepared/chr1/chr1.fa',
              faiPath: 'prepared/chr1/chr1.fa.fai',
              gffPath: null,
              tbiPath: null,
            },
          },
        ],
      },
    });
    mockOpenAssembly.mockResolvedValue(null);
    render(<ReferenceGenomePicker open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    fireEvent.click(await screen.findByTestId('reference-import-browse'));
    expect(
      await screen.findByText('The reference was prepared but could not be opened.')
    ).toBeVisible();
    const operationId = mockImportLocalReference.mock.calls[0]?.[0]?.operationId;
    if (typeof operationId !== 'string') throw new Error('Missing renderer import operation id.');

    act(() => {
      progressListener?.({
        operationId,
        phase: 'ready',
        label: 'Late ready event',
        completed: 1,
        total: 1,
      });
    });
    expect(screen.getByText('The reference was prepared but could not be opened.')).toBeVisible();
    expect(screen.getByTestId('reference-import-custom')).not.toBeDisabled();
  });

  it('closes the Add reference modal before closing the library on Escape', async () => {
    const onClose = vi.fn();
    render(<ReferenceGenomePicker open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId('reference-import-custom'));
    expect(await screen.findByRole('dialog', { name: 'Add reference' })).toBeVisible();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add reference' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows GRCh38 once and routes a ready hosted click through installation', async () => {
    const onClose = vi.fn();
    const hosted = {
      id: 'grch38',
      name: 'GRCh38 (human)',
      organism: 'Homo sapiens',
      assembly: 'GRCh38.p14',
      description: 'Human primary assembly.',
      cacheStatus: 'cached' as const,
      lengthBp: 3_088_269_832,
      contigCount: 24,
      downloadBytes: 1_061_733_652,
      provider: 'NCBI RefSeq',
      datasetVersion: 'GRCh38.p14',
    };
    const prepared = {
      id: hosted.id,
      name: hosted.name,
      organism: hosted.organism,
      assembly: hosted.assembly,
      description: hosted.description,
      assetCacheKey: hosted.id,
      members: [
        {
          chrom: 'chr1',
          displayName: 'chr1',
          lengthBp: 248_956_422,
          role: 'assembled-molecule' as const,
          circular: false,
          manifest: {
            fastaPath: 'prepared/chr1/chr1.fa',
            faiPath: 'prepared/chr1/chr1.fa.fai',
            gffPath: 'prepared/chr1/chr1.gff3.gz',
            tbiPath: 'prepared/chr1/chr1.gff3.gz.tbi',
          },
        },
      ],
    };
    mockListHostedReferences.mockResolvedValue([hosted]);
    mockInstallHostedReference.mockResolvedValue({ status: 'ready', entry: prepared });

    render(<ReferenceGenomePicker open onClose={onClose} />);

    const hostedRow = await screen.findByTestId('reference-hosted-grch38');
    expect(screen.queryByTestId('reference-assembly-grch38')).toBeNull();
    expect(screen.queryByTestId('reference-local-grch38')).toBeNull();
    expect(hostedRow).toHaveTextContent('Genome length: 3.09 Gb');
    expect(hostedRow).not.toHaveTextContent('1.06 GB');
    const details = within(hostedRow).getByRole('button', {
      name: 'Show details for GRCh38 (human)',
    });
    const open = within(hostedRow).getByRole('button', { name: 'Open GRCh38 (human)' });
    expect(open).toBeVisible();
    fireEvent.click(details);
    expect(screen.getByTestId('reference-saved-views-grch38')).toBeVisible();
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
    fireEvent.click(open);

    await waitFor(() =>
      expect(mockInstallHostedReference).toHaveBeenCalledWith({
        catalogId: 'grch38',
        themeMode: 'light',
        intent: 'open-view',
      })
    );
    await waitFor(() =>
      expect(mockOpenAssembly).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'grch38' }),
        expect.objectContaining({ annotationThemeMode: 'light' })
      )
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('downloads an uncached hosted genome by catalog id and opens the admitted assembly', async () => {
    const onClose = vi.fn();
    const hosted = {
      id: 'grcm39-gcf-000001635-27',
      name: 'GRCm39 (mouse)',
      organism: 'Mus musculus',
      assembly: 'GCF_000001635.27',
      description: 'Mouse reference genome.',
      cacheStatus: 'not-cached' as const,
      lengthBp: 2_723_433_227,
      contigCount: 22,
      downloadBytes: 1_234_567_890,
      provider: 'NCBI',
      datasetVersion: 'GCF_000001635.27',
    };
    const prepared = {
      id: hosted.id,
      name: hosted.name,
      organism: hosted.organism,
      assembly: hosted.assembly,
      description: hosted.description,
      assetCacheKey: hosted.id,
      members: [
        {
          chrom: 'chr1',
          lengthBp: 195_154_279,
          circular: false,
          manifest: {
            fastaPath: 'prepared/mouse/chr1.fa',
            faiPath: 'prepared/mouse/chr1.fa.fai',
            gffPath: 'prepared/mouse/chr1.gff3.gz',
            tbiPath: 'prepared/mouse/chr1.gff3.gz.tbi',
          },
        },
      ],
    };
    mockListHostedReferences
      .mockResolvedValueOnce([hosted])
      .mockResolvedValue([{ ...hosted, cacheStatus: 'cached' as const }]);
    mockInstallHostedReference.mockResolvedValue({ status: 'ready', entry: prepared });

    render(<ReferenceGenomePicker open onClose={onClose} />);
    const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
    expect(row).toHaveTextContent('GRCm39 (mouse)');
    expect(row).toHaveTextContent('Genome length: 2.72 Gb');
    expect(row).toHaveTextContent('Download');
    expect(screen.getByRole('button', { name: 'Download GRCm39 (mouse)' })).toHaveTextContent(
      '1.23 GB'
    );

    fireEvent.click(row);
    expect(mockInstallHostedReference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download GRCm39 (mouse)' }));

    await waitFor(() =>
      expect(mockInstallHostedReference).toHaveBeenCalledWith({
        catalogId: hosted.id,
        themeMode: 'light',
        intent: 'open-view',
      })
    );
    expect(mockOpenAssembly).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open GRCm39 (mouse)' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open GRCm39 (mouse)' }));
    await waitFor(() =>
      expect(mockOpenAssembly).toHaveBeenCalledWith(
        expect.objectContaining({ id: hosted.id }),
        expect.objectContaining({ annotationThemeMode: 'light' })
      )
    );
    expect(mockImportLocalReference).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    await waitFor(() => expect(row).not.toBeDisabled());
  });

  it('routes a cached hosted genome through main-process readiness admission before opening', async () => {
    const onClose = vi.fn();
    const hosted = {
      id: 'grcm39-gcf-000001635-27',
      name: 'GRCm39 (mouse)',
      organism: 'Mus musculus',
      assembly: 'GCF_000001635.27',
      description: 'Mouse reference genome.',
      cacheStatus: 'cached' as const,
      lengthBp: 2_723_433_227,
      contigCount: 22,
      downloadBytes: 1_234_567_890,
      provider: 'NCBI',
      datasetVersion: 'GCF_000001635.27',
    };
    const prepared = {
      ...hosted,
      assetCacheKey: hosted.id,
      members: [
        {
          chrom: 'chr1',
          lengthBp: 195_154_279,
          circular: false,
          manifest: {
            fastaPath: 'prepared/mouse/chr1.fa',
            faiPath: 'prepared/mouse/chr1.fa.fai',
            gffPath: 'prepared/mouse/chr1.gff3.gz',
            tbiPath: 'prepared/mouse/chr1.gff3.gz.tbi',
          },
        },
      ],
    };
    mockListHostedReferences.mockResolvedValue([hosted]);
    mockListLocalReferences.mockResolvedValue([prepared]);
    mockInstallHostedReference.mockResolvedValue({ status: 'ready', entry: prepared });

    render(<ReferenceGenomePicker open onClose={onClose} />);
    const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
    expect(within(row).getByRole('button', { name: 'Open GRCm39 (mouse)' })).toBeEnabled();
    expect(row).toHaveTextContent('Genome length: 2.72 Gb');
    expect(row).not.toHaveTextContent('1.23 GB');
    fireEvent.click(screen.getByRole('button', { name: 'Open GRCm39 (mouse)' }));

    await waitFor(() => expect(mockOpenAssembly).toHaveBeenCalledOnce());
    expect(mockInstallHostedReference).toHaveBeenCalledWith({
      catalogId: hosted.id,
      themeMode: 'light',
      intent: 'open-view',
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    await waitFor(() => expect(row).not.toBeDisabled());
  });

  it.each(['null', 'rejected'] as const)(
    'retries a %s hosted final open through fresh admission without a separate download workflow',
    async (failure) => {
      const { hosted, prepared } = hostedOpenRecoveryFixture();
      const onClose = vi.fn();
      mockListHostedReferences.mockResolvedValue([hosted]);
      mockInstallHostedReference.mockResolvedValue({ status: 'view-ready', entry: prepared });
      if (failure === 'null') mockOpenAssembly.mockResolvedValueOnce(null);
      else mockOpenAssembly.mockRejectedValueOnce(new Error('Private opening failure detail'));
      mockOpenAssembly.mockResolvedValueOnce('retry-opened-tab');

      render(<ReferenceGenomePicker open onClose={onClose} />);
      const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
      fireEvent.click(within(row).getByRole('button', { name: `Open ${hosted.name}` }));
      const retry = await within(row).findByRole('button', {
        name: `Retry opening ${hosted.name}`,
      });

      expect(row).toHaveTextContent('The reference could not be opened.');
      expect(screen.getByTestId(`reference-hosted-${hosted.id}-availability`)).toHaveAttribute(
        'data-availability',
        'cached'
      );
      expect(
        within(row).queryByRole('button', { name: `Retry download ${hosted.name}` })
      ).toBeNull();
      expect(row).not.toHaveTextContent('Private opening failure detail');
      expect(mockInstallHostedReference).toHaveBeenCalledTimes(1);
      expect(mockOpenAssembly).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(retry);
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(mockInstallHostedReference).toHaveBeenCalledTimes(2);
      expect(mockInstallHostedReference).toHaveBeenNthCalledWith(2, {
        catalogId: hosted.id,
        themeMode: 'light',
        intent: 'open-view',
      });
      expect(mockOpenAssembly).toHaveBeenCalledTimes(2);
      expect(mockOpenAssembly).toHaveBeenNthCalledWith(
        2,
        prepared,
        expect.objectContaining({ annotationThemeMode: 'light' })
      );
    }
  );

  it('uses the newly native-admitted entry when retrying a failed hosted open', async () => {
    const { hosted, prepared } = hostedOpenRecoveryFixture();
    const readmitted: PreparedReferenceAssemblyEntryV1 = {
      ...prepared,
      portableView: {
        generationRoot: '/controlled/reference/generation-two',
        bundleFingerprint: 'b'.repeat(64),
        trackTypes: [],
      },
    };
    const onClose = vi.fn();
    mockListHostedReferences.mockResolvedValue([hosted]);
    mockInstallHostedReference
      .mockResolvedValueOnce({ status: 'view-ready', entry: prepared })
      .mockResolvedValueOnce({ status: 'view-ready', entry: readmitted });
    mockOpenAssembly.mockResolvedValueOnce(null).mockResolvedValueOnce('retry-opened-tab');

    render(<ReferenceGenomePicker open onClose={onClose} />);
    const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
    fireEvent.click(within(row).getByRole('button', { name: `Open ${hosted.name}` }));
    fireEvent.click(
      await within(row).findByRole('button', { name: `Retry opening ${hosted.name}` })
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mockInstallHostedReference).toHaveBeenCalledTimes(2);
    expect(mockOpenAssembly).toHaveBeenNthCalledWith(
      2,
      readmitted,
      expect.objectContaining({ annotationThemeMode: 'light' })
    );
  });

  it.each(['download', 'open'] as const)(
    'keeps acquisition recovery when native admission fails during %s',
    async (action) => {
      const fixture = hostedOpenRecoveryFixture();
      const hosted: HostedReferenceCatalogEntryV1 = {
        ...fixture.hosted,
        cacheStatus: action === 'download' ? 'not-cached' : 'cached',
      };
      const onClose = vi.fn();
      mockListHostedReferences.mockResolvedValue([hosted]);
      mockInstallHostedReference
        .mockRejectedValueOnce(new Error('Private acquisition failure detail'))
        .mockResolvedValue({ status: 'view-ready', entry: fixture.prepared });

      render(<ReferenceGenomePicker open onClose={onClose} />);
      const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
      fireEvent.click(
        within(row).getByRole('button', {
          name: `${action === 'download' ? 'Download' : 'Open'} ${hosted.name}`,
        })
      );
      const retry = await within(row).findByRole('button', {
        name: `Retry download ${hosted.name}`,
      });
      expect(
        within(row).queryByRole('button', { name: `Retry opening ${hosted.name}` })
      ).toBeNull();
      expect(mockOpenAssembly).not.toHaveBeenCalled();
      expect(row).not.toHaveTextContent('Private acquisition failure detail');

      fireEvent.click(retry);
      await within(row).findByRole('button', { name: `Open ${hosted.name}` });
      expect(mockInstallHostedReference).toHaveBeenCalledTimes(2);
      expect(mockOpenAssembly).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    }
  );

  it('keeps admitted annotations and pending search visible after a hosted final-open failure', async () => {
    const fixture = hostedOpenRecoveryFixture();
    const hosted: HostedReferenceCatalogEntryV1 = {
      ...fixture.hosted,
      cacheStatus: 'not-cached',
      preparation: {
        status: 'annotation-ready',
        phase: 'detail-ready',
        label: 'Finishing search',
        active: true,
      },
    };
    const onClose = vi.fn();
    mockListHostedReferences.mockResolvedValue([hosted]);
    mockInstallHostedReference.mockResolvedValue({ status: 'view-ready', entry: fixture.prepared });
    mockOpenAssembly.mockResolvedValueOnce(null);

    render(<ReferenceGenomePicker open onClose={onClose} />);
    const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
    fireEvent.click(within(row).getByRole('button', { name: `Open ${hosted.name}` }));
    const retry = await within(row).findByRole('button', { name: `Retry opening ${hosted.name}` });

    expect(row).toHaveTextContent('Finishing search');
    expect(screen.getByTestId(`reference-hosted-${hosted.id}-availability`)).toHaveAttribute(
      'data-availability',
      'preparing'
    );
    expect(retry).toBeEnabled();
    expect(within(row).queryByRole('button', { name: `Retry download ${hosted.name}` })).toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(mockInstallHostedReference).toHaveBeenCalledTimes(2);
    expect(mockOpenAssembly).toHaveBeenCalledTimes(2);
  });

  it('does not bypass native admission when a hosted opening retry is refused', async () => {
    const { hosted, prepared } = hostedOpenRecoveryFixture();
    const onClose = vi.fn();
    mockListHostedReferences.mockResolvedValue([hosted]);
    mockInstallHostedReference
      .mockResolvedValueOnce({ status: 'view-ready', entry: prepared })
      .mockRejectedValueOnce(new Error('Controlled admission refusal'));
    mockOpenAssembly.mockResolvedValueOnce(null);

    render(<ReferenceGenomePicker open onClose={onClose} />);
    const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
    fireEvent.click(within(row).getByRole('button', { name: `Open ${hosted.name}` }));
    fireEvent.click(
      await within(row).findByRole('button', { name: `Retry opening ${hosted.name}` })
    );

    expect(
      await within(row).findByRole('button', { name: `Retry download ${hosted.name}` })
    ).toBeEnabled();
    expect(mockInstallHostedReference).toHaveBeenCalledTimes(2);
    expect(mockOpenAssembly).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not call a same-ID stale local publication Cached', async () => {
    const hosted = {
      id: 'grcm39-gcf-000001635-27',
      name: 'GRCm39 (mouse)',
      organism: 'Mus musculus',
      assembly: 'GCF_000001635.27',
      description: 'Mouse reference genome.',
      cacheStatus: 'stale' as const,
      lengthBp: 2_723_433_227,
      contigCount: 22,
      downloadBytes: 1_234_567_890,
      provider: 'NCBI',
      datasetVersion: 'GCF_000001635.27',
    };
    mockListHostedReferences.mockResolvedValue([hosted]);
    mockListLocalReferences.mockResolvedValue([
      {
        id: hosted.id,
        name: hosted.name,
        organism: hosted.organism,
        assembly: hosted.assembly,
        description: hosted.description,
        assetCacheKey: hosted.id,
        members: [],
      },
    ]);

    render(<ReferenceGenomePicker open onClose={() => {}} />);

    const row = await screen.findByTestId(`reference-hosted-${hosted.id}`);
    expect(row).toHaveTextContent('Checking readiness');
    expect(row).not.toHaveTextContent('Background verification');
    expect(row).not.toHaveTextContent('Update available');
    expect(row).not.toHaveTextContent('Cached');
    expect(screen.getByTestId(`reference-hosted-${hosted.id}-availability`)).toHaveAttribute(
      'data-availability',
      'stale'
    );
  });
  it('restores ongoing preparation and failure from the main-owned library snapshot', async () => {
    const hosted = {
      id: 'sacCer3',
      name: 'Yeast',
      organism: 'S. cerevisiae',
      description: 'Yeast reference',
      cacheStatus: 'not-cached',
      cacheStatusReason: 'prepared-files-incomplete',
      lengthBp: 12_157_105,
      contigCount: 16,
      downloadBytes: 5_000_000,
      provider: 'NCBI',
      datasetVersion: 'R64',
      preparation: {
        status: 'annotation-ready',
        active: true,
        phase: 'detail-ready',
        label: 'Preparing search',
      },
    };
    mockListHostedReferences.mockResolvedValue([hosted]);
    const rendered = render(<ReferenceGenomePicker open onClose={() => {}} />);
    const row = await screen.findByTestId('reference-hosted-sacCer3');
    expect(row).toHaveTextContent('Finishing search');
    expect(row).not.toHaveTextContent('Ready');
    expect(row).not.toHaveTextContent('Preparing search');
    const preparingAvailability = screen.getByTestId('reference-hosted-sacCer3-availability');
    expect(preparingAvailability).toHaveAttribute('data-availability', 'preparing');
    expect(preparingAvailability.className).toMatch(/amber/u);
    expect(preparingAvailability.className).toMatch(/dark:/u);
    expect(screen.getByRole('button', { name: 'Open Yeast' })).toBeEnabled();
    rendered.unmount();
    mockListHostedReferences.mockResolvedValue([
      {
        ...hosted,
        preparation: {
          status: 'failed',
          active: false,
          phase: 'background-preparation-failed',
          label: 'Search download failed. Open to retry.',
        },
      },
    ]);
    render(<ReferenceGenomePicker open onClose={() => {}} />);
    const returned = await screen.findByTestId('reference-hosted-sacCer3');
    expect(returned).toHaveTextContent('Retry setup');
    expect(returned).toHaveTextContent('Search download failed. Open to retry.');
    expect(returned).not.toHaveTextContent('Background repair');
    const failedAvailability = screen.getByTestId('reference-hosted-sacCer3-availability');
    expect(failedAvailability).toHaveAttribute('data-availability', 'failed');
    expect(failedAvailability.className).toMatch(/red/u);
    expect(failedAvailability.className).toMatch(/dark:/u);
    expect(returned).not.toBeDisabled();
  });

  it.each(['preparing', 'failed'] as const)(
    'lets the user resume an inactive incomplete reference with main status %s',
    async (status) => {
      const definition = referenceAssemblyById('grch38')!;
      mockListHostedReferences.mockResolvedValue([
        {
          id: definition.id,
          name: definition.name,
          organism: definition.organism,
          description: definition.description,
          cacheStatus: 'not-cached',
          cacheStatusReason: 'prepared-files-incomplete',
          preparation: {
            status,
            active: false,
            phase: status === 'failed' ? 'background-preparation-failed' : 'resolving',
            label:
              status === 'failed'
                ? 'Reference preparation was interrupted.'
                : 'Preparing reference',
          },
          lengthBp: 3_088_269_832,
          contigCount: 24,
          downloadBytes: 1_061_733_652,
          provider: 'NCBI RefSeq',
          datasetVersion: 'GRCh38.p14',
        },
      ]);
      mockInstallHostedReference.mockResolvedValue({
        status: 'view-ready',
        entry: {
          id: definition.id,
          name: definition.name,
          organism: definition.organism,
          description: definition.description,
          assetCacheKey: definition.assetCacheKey,
          members: definition.members.map(({ chrom, cytobandId, circular }) => ({
            chrom,
            cytobandId,
            circular,
          })),
        },
      });

      render(<ReferenceGenomePicker open onClose={() => {}} />);
      const row = await screen.findByTestId('reference-hosted-grch38');
      expect(mockInstallHostedReference).not.toHaveBeenCalled();
      expect(within(row).queryByRole('button', { name: 'Open GRCh38 (human)' })).toBeNull();
      const action = within(row).getByRole('button', {
        name: `${status === 'failed' ? 'Retry setup' : 'Finish setup'} GRCh38 (human)`,
      });
      expect(action).toBeEnabled();
      fireEvent.click(action);

      await waitFor(() =>
        expect(mockInstallHostedReference).toHaveBeenCalledWith({
          catalogId: 'grch38',
          themeMode: 'light',
          intent: 'open-view',
        })
      );
      await waitFor(() =>
        expect(within(row).getByRole('button', { name: 'Open GRCh38 (human)' })).toBeEnabled()
      );
    }
  );

  it.each(['preparing', 'failed'] as const)(
    'keeps an active incomplete reference under its existing preparation owner (%s)',
    async (status) => {
      mockListHostedReferences.mockResolvedValue([
        {
          id: 'grch38',
          name: 'GRCh38 (human)',
          organism: 'Homo sapiens',
          cacheStatus: 'not-cached',
          cacheStatusReason: 'prepared-files-incomplete',
          preparation: { status, active: true, phase: 'resolving', label: 'Preparing reference' },
          lengthBp: 3_088_269_832,
          contigCount: 24,
          downloadBytes: 1_061_733_652,
          provider: 'NCBI RefSeq',
          datasetVersion: 'GRCh38.p14',
        },
      ]);
      render(<ReferenceGenomePicker open onClose={() => {}} />);
      const row = await screen.findByTestId('reference-hosted-grch38');
      expect(within(row).queryByRole('button', { name: /^(?:Finish|Retry) setup /u })).toBeNull();
      expect(within(row).getByRole('progressbar')).toBeVisible();
      expect(mockInstallHostedReference).not.toHaveBeenCalled();
    }
  );
});
