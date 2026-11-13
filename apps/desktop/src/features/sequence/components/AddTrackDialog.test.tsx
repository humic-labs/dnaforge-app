import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userMessage } from '@waypoint/user-messages';

import { inspectUcscHub, listUcscPublicHubs } from '../ucsc-track-client';
import type { UcscCatalogSearchResult } from '../ucsc-catalog-store';
import { searchUcscCatalog, subscribeUcscCatalog } from '../ucsc-catalog-store';
import { searchUcscCatalogLocally } from '../ucsc-catalog-search';
import { AddTrackDialog, trackHeadline } from './AddTrackDialog';

const catalogMocks = vi.hoisted(() => ({
  leaves: [
    {
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:knownGene',
      track: 'knownGene',
      shortLabel: 'GENCODE genes',
      longLabel: 'GENCODE comprehensive genes',
      scientificKind: 'transcript',
      formatId: 'bigbed',
      assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
      type: 'bigGenePred',
    },
    {
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:cpgIslandExt',
      track: 'cpgIslandExt',
      shortLabel: 'CpG Islands',
      longLabel: 'CpG Islands (Islands under 300 bases are light green)',
      scientificKind: 'interval',
      formatId: 'ucsc-native',
      assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
      type: 'bed 4 +',
    },
    {
      sourceKind: 'ucsc-native',
      catalogId: 'hg38:gc5BaseBw',
      track: 'gc5BaseBw',
      shortLabel: 'GC Percent',
      longLabel: 'GC percent',
      scientificKind: 'quantitative',
      formatId: 'bigwig',
      assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
      bigDataUrl: 'https://encode-public.s3.amazonaws.com/sample.bigWig',
      type: 'bigWig',
      parentTrack: 'wgEncodeReg4Epigenetics',
      catalogColor: '6,218,147',
      experimentAccession: 'ENCSR109DTU',
      fileAccession: 'ENCFF230LAU',
    },
  ],
}));

vi.mock('../ucsc-track-client', () => ({
  inspectUcscHub: vi.fn(),
  listUcscPublicHubs: vi.fn(),
}));

vi.mock('../ucsc-catalog-store', () => ({
  searchUcscCatalog: vi.fn(),
  subscribeUcscCatalog: vi.fn(() => () => undefined),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    workspace: {
      getPathForFile: (file: File) => `/data/${file.name}`,
    },
  }),
}));

function catalogResult(tracks: ReadonlyArray<unknown>): UcscCatalogSearchResult {
  return {
    tracks: tracks as UcscCatalogSearchResult['tracks'],
    total: tracks.length,
    catalogSize: tracks.length,
    complete: true,
    terms: [],
  };
}

const noopNetworkSource = vi.fn(async () => undefined);
const noopSaveCredential = vi.fn(async () => undefined);

describe('AddTrackDialog', () => {
  const observers: Array<{
    callback: IntersectionObserverCallback;
    root: Element | Document | null | undefined;
    target?: Element;
    disconnected: boolean;
  }> = [];
  beforeEach(() => {
    vi.mocked(searchUcscCatalog)
      .mockReset()
      .mockImplementation(async () => catalogResult(catalogMocks.leaves));
    vi.mocked(inspectUcscHub).mockReset();
    vi.mocked(listUcscPublicHubs).mockReset();
    vi.mocked(subscribeUcscCatalog)
      .mockReset()
      .mockImplementation(() => () => undefined);
    noopNetworkSource.mockClear();
    noopSaveCredential.mockClear();
    observers.length = 0;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observer: (typeof observers)[number];
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.observer = { callback, root: options?.root, disconnected: false };
          observers.push(this.observer);
        }
        observe(target: Element) {
          this.observer.target = target;
        }
        disconnect() {
          this.observer.disconnected = true;
        }
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function filterColumn(label: string, value: string) {
    if (!screen.queryByLabelText(`Filter ${label}`)) {
      fireEvent.click(screen.getByLabelText('Choose table columns'));
      fireEvent.click(screen.getByLabelText(`Show ${label} column`));
      fireEvent.click(screen.getByLabelText('Choose table columns'));
    }
    const filter = screen.getByLabelText(`Filter ${label}`);
    if (filter.tagName === 'BUTTON') {
      fireEvent.click(filter);
    }
    fireEvent.change(screen.getByLabelText(`Filter ${label}`), {
      target: { value },
    });
  }

  function intersectCatalogEnd() {
    const sentinel = screen.getByTestId('ucsc-catalog-scroll-sentinel');
    const observer = [...observers].reverse().find((o) => !o.disconnected && o.target === sentinel);
    expect(observer?.root).toBe(screen.getByTestId('ucsc-catalog-table-scroll'));
    act(() =>
      observer!.callback(
        [{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    );
  }

  const HUB_URL = 'https://hub.example.org/hub.txt';
  const HUB_LEAF = {
    sourceKind: 'ucsc-hub' as const,
    catalogId: 'ucsc-hub\u0000hg38\u0000labSignal\u0000' + HUB_URL,
    track: 'labSignal',
    shortLabel: 'Lab signal',
    longLabel: 'Quantitative signal from a lab hub',
    scientificKind: 'quantitative' as const,
    formatId: 'bigwig' as const,
    assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
    hubUrl: HUB_URL,
    bigDataUrl: 'signal.bw',
    type: 'bigWig',
  };

  function renderPublicDialog(
    ucscTarget: { genomeId: string; hubUrl?: string } | null,
    presentCatalogIds?: ReadonlySet<string>
  ) {
    const onAddUcscTrack = vi.fn(async () => 'added' as const);
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={ucscTarget}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={onAddUcscTrack}
        presentCatalogIds={presentCatalogIds}
        onClose={vi.fn()}
      />
    );
    return { onAddUcscTrack };
  }

  it('explains that a pipeline manifest may import BigWig signal without reads or a CRAI', () => {
    renderPublicDialog(null);
    fireEvent.click(screen.getByTestId('add-data-files-tab'));

    expect(screen.getByText(/BigWig signal and peaks without reads or a CRAI/u)).toBeVisible();
    expect(screen.getByTestId('add-data-files-choose')).toBeEnabled();
  });

  it('keeps a failed UCSC search diagnostic out of the dialog', async () => {
    const diagnostic = 'ucsc-tracks: VITE_API_URL is not set. Configure the renderer.';
    vi.mocked(searchUcscCatalog).mockRejectedValue(new Error(diagnostic));
    renderPublicDialog({ genomeId: 'hg38' });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText(userMessage('tracks.loadFailed'))).toBeVisible();
    expect(screen.queryByText(diagnostic)).not.toBeInTheDocument();
  });

  it('connects a track hub by URL, lists its tracks, and adds them with hub identity', async () => {
    vi.mocked(inspectUcscHub).mockResolvedValue({
      hubUrl: HUB_URL,
      genomes: [{ name: 'hg38', organism: 'Human', assemblyHub: false }],
    });
    vi.mocked(searchUcscCatalog).mockImplementation(async (input) =>
      catalogResult(input.hubUrl === HUB_URL ? [HUB_LEAF] : [])
    );
    const { onAddUcscTrack } = renderPublicDialog({ genomeId: 'hg38' });

    fireEvent.click(screen.getByTestId('add-track-hubs-toggle'));
    fireEvent.change(screen.getByLabelText('Track hub URL'), { target: { value: HUB_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect hub' }));

    await waitFor(() => expect(inspectUcscHub).toHaveBeenCalledWith(HUB_URL));
    await waitFor(() =>
      expect(screen.getByTestId(`ucsc-catalog-source-${HUB_URL}`)).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    );
    await waitFor(() =>
      expect(searchUcscCatalog).toHaveBeenCalledWith(
        { genome: 'hg38', query: '', hubUrl: HUB_URL },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    const row = await screen.findByTestId('ucsc-track-result-labSignal');
    expect(row).toHaveTextContent('Track hub');
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAddUcscTrack).toHaveBeenCalledWith(HUB_LEAF));
    expect(await within(row).findByTestId('ucsc-track-added-labSignal')).toBeVisible();
    expect(screen.queryByText('Lab signal added.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ucsc-catalog-source-hosted'));
    await waitFor(() =>
      expect(searchUcscCatalog).toHaveBeenLastCalledWith(
        { genome: 'hg38', query: '' },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
  });

  it('asks which hub assembly to use when the hub does not name the open reference', async () => {
    vi.mocked(inspectUcscHub).mockResolvedValue({
      hubUrl: HUB_URL,
      genomes: [
        { name: 'labAsm1', organism: 'Lab strain', assemblyHub: true },
        { name: 'labAsm2', organism: 'Lab strain', assemblyHub: true },
      ],
    });
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult([]));
    renderPublicDialog(null);

    expect(screen.getByRole('status')).toHaveTextContent('Connect a track hub');
    fireEvent.click(screen.getByTestId('add-track-hubs-toggle'));
    fireEvent.change(screen.getByLabelText('Track hub URL'), { target: { value: HUB_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect hub' }));

    const chooser = await screen.findByRole('group', {
      name: 'Choose the hub assembly for hub.example.org',
    });
    fireEvent.change(within(chooser).getByLabelText('Hub assembly'), {
      target: { value: 'labAsm2' },
    });
    fireEvent.click(within(chooser).getByRole('button', { name: 'Use this assembly' }));

    await waitFor(() =>
      expect(searchUcscCatalog).toHaveBeenCalledWith(
        { genome: 'labAsm2', query: '', hubUrl: HUB_URL },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    expect(screen.getByTestId(`ucsc-catalog-source-${HUB_URL}`)).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('browses the public registry filtered to hubs that publish the open assembly', async () => {
    vi.mocked(listUcscPublicHubs).mockResolvedValue([
      { hubUrl: HUB_URL, shortLabel: 'Lab hub', longLabel: 'Lab tracks', genomes: ['hg38'] },
      {
        hubUrl: 'https://mouse.example.org/hub.txt',
        shortLabel: 'Mouse hub',
        longLabel: 'Mouse only',
        genomes: ['mm10'],
      },
    ]);
    vi.mocked(inspectUcscHub).mockResolvedValue({
      hubUrl: HUB_URL,
      genomes: [{ name: 'hg38', assemblyHub: false }],
    });
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult([]));
    renderPublicDialog({ genomeId: 'hg38' });

    fireEvent.click(screen.getByTestId('add-track-hubs-toggle'));
    fireEvent.click(screen.getByRole('button', { name: 'Browse public hubs' }));
    const registry = await screen.findByRole('list', { name: 'Public track hubs' });
    expect(within(registry).getAllByRole('listitem')).toHaveLength(1);
    expect(registry).toHaveTextContent('Lab hub');
    expect(registry).not.toHaveTextContent('Mouse hub');

    fireEvent.click(within(registry).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(inspectUcscHub).toHaveBeenCalledWith(HUB_URL));
    await waitFor(() => expect(registry).toHaveTextContent('Connected'));

    fireEvent.click(screen.getAllByRole('tab')[0]!);
    expect(screen.getByTestId(`ucsc-catalog-source-${HUB_URL}`)).toHaveTextContent('Lab hub');
  });

  it('browses the catalog as a sortable table with column filters that compose with facets', async () => {
    const { onAddUcscTrack: onAdd } = renderPublicDialog({ genomeId: 'hg38' });
    await screen.findByTestId('ucsc-track-result-cpgIslandExt');
    const table = screen.getByRole('table', { name: 'Public genomic data' });
    expect(within(table).getByRole('columnheader', { name: /Track type/ })).toBeVisible();

    fireEvent.click(within(table).getByRole('button', { name: 'Sort by Track' }));
    const rows = within(table).getAllByTestId(/^ucsc-track-result-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'ucsc-track-result-cpgIslandExt',
      'ucsc-track-result-gc5BaseBw',
      'ucsc-track-result-knownGene',
    ]);

    filterColumn('Description', 'percent');
    expect(screen.queryByTestId('ucsc-track-result-knownGene')).toBeNull();
    expect(screen.getByTestId('ucsc-track-result-gc5BaseBw')).toBeVisible();
    expect(screen.getByTestId('ucsc-catalog-result-summary')).toHaveTextContent('1 of 3 tracks');

    fireEvent.click(screen.getByTestId('ucsc-facet-scientificKind-interval'));
    expect(screen.queryByTestId('ucsc-track-result-gc5BaseBw')).toBeNull();
    expect(screen.getByText('No tracks match these column filters.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear column filters' }));
    const interval = screen.getByTestId('ucsc-track-result-cpgIslandExt');
    fireEvent.click(within(interval).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(catalogMocks.leaves[1]));
  });

  it('shows every track type and lets people find cell types beyond the first sidebar choices', async () => {
    const kinds = [
      'transcript',
      'quantitative',
      'peak',
      'interval',
      'repeat',
      'reads',
      'variants',
      'alignment',
    ] as const;
    const tracks = Array.from({ length: 80 }, (_, index) => ({
      ...catalogMocks.leaves[2],
      catalogId: `hg38:facet${index}`,
      track: `facet${index}`,
      shortLabel: `Facet ${index}`,
      scientificKind: kinds[index % kinds.length],
      attributes: [{ key: 'cellType', value: `cell${index % 20}`, origin: 'subGroups' }],
    }));
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult(tracks));
    renderPublicDialog({ genomeId: 'hg38' });
    await screen.findByTestId('ucsc-track-result-facet0');
    for (const kind of kinds) {
      expect(screen.getByTestId(`ucsc-facet-scientificKind-${kind}`)).toBeVisible();
    }
    expect(screen.getByRole('button', { name: 'Cell type filter' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Find Cell type' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cell type filter' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find Cell type' }), {
      target: { value: 'cell19' },
    });
    fireEvent.click(screen.getByTestId('ucsc-facet-cellType-cell19'));
    expect(screen.getByTestId('ucsc-catalog-result-summary')).toHaveAttribute(
      'data-match-count',
      '4'
    );
  });

  it('makes relevance the visible default for search and restores it after an alphabetical sort', async () => {
    const tracks = [
      {
        ...catalogMocks.leaves[2],
        catalogId: 'hg38:z',
        track: 'z',
        shortLabel: 'Zebra',
        longLabel: 'Adipose tissue signal',
      },
      {
        ...catalogMocks.leaves[2],
        catalogId: 'hg38:a',
        track: 'a',
        shortLabel: 'Adipose signal',
        longLabel: 'Signal',
      },
      {
        ...catalogMocks.leaves[2],
        catalogId: 'hg38:adipose',
        track: 'adipose',
        shortLabel: 'ZZ exact ID',
        longLabel: 'Signal',
      },
    ];
    vi.mocked(searchUcscCatalog).mockImplementation(async ({ query }) => ({
      ...searchUcscCatalogLocally(tracks as UcscCatalogSearchResult['tracks'], query),
      complete: true,
    }));
    renderPublicDialog({ genomeId: 'hg38' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search public genomic data' }), {
      target: { value: 'adipose' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('ucsc-catalog-result-summary')).toHaveAttribute(
        'data-match-count',
        '3'
      )
    );
    const table = screen.getByRole('table', { name: 'Public genomic data' });
    const order = () =>
      within(table)
        .getAllByTestId(/^ucsc-track-result-/)
        .map((row) => row.getAttribute('data-testid'));
    expect(screen.getByRole('combobox', { name: 'Sort results' })).toHaveValue('relevance');
    expect(order()).toEqual([
      'ucsc-track-result-adipose',
      'ucsc-track-result-a',
      'ucsc-track-result-z',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort results' }), {
      target: { value: 'track:asc' },
    });
    expect(order()).toEqual([
      'ucsc-track-result-a',
      'ucsc-track-result-z',
      'ucsc-track-result-adipose',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort results' }), {
      target: { value: 'relevance' },
    });
    expect(order()[0]).toBe('ucsc-track-result-adipose');
  });

  it('updates a visible saved catalog after refresh while retaining column filters', async () => {
    let onRefresh: (() => void) | undefined;
    vi.mocked(subscribeUcscCatalog).mockImplementation((_target, listener) => {
      onRefresh = listener;
      return () => undefined;
    });
    renderPublicDialog({ genomeId: 'hg38' });
    await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    filterColumn('Description', 'percent');
    expect(screen.getByTestId('ucsc-track-result-gc5BaseBw')).toBeVisible();

    const refreshed = [
      {
        ...catalogMocks.leaves[2],
        catalogId: 'hg38:newSignal',
        track: 'newSignal',
        shortLabel: 'New signal',
        longLabel: 'New percent signal',
      },
    ];
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult(refreshed));
    await act(async () => onRefresh?.());

    expect(screen.getByTestId('ucsc-track-result-newSignal')).toBeVisible();
    expect(screen.queryByTestId('ucsc-track-result-gc5BaseBw')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Filter Description' })).toHaveValue('percent');
  });

  it('uses registry headings with searches that open inline without another header row', async () => {
    renderPublicDialog({ genomeId: 'hg38' });
    await screen.findByTestId('ucsc-track-result-cpgIslandExt');
    const table = screen.getByRole('table', { name: 'Public genomic data' });
    expect(table.querySelectorAll('thead tr')).toHaveLength(1);
    expect(within(table).queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize Track column' })).toBeVisible();
    filterColumn('Description', 'percent');
    const search = screen.getByRole('textbox', { name: 'Filter Description' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('percent');
    fireEvent.blur(search);
    expect(screen.getByTestId('ucsc-track-result-gc5BaseBw')).toBeVisible();
    expect(screen.queryByTestId('ucsc-track-result-knownGene')).toBeNull();
    expect(table.querySelectorAll('thead tr')).toHaveLength(1);
  });

  it('appends results on infinite scroll and filters beyond the rendered window', async () => {
    const tracks = Array.from({ length: 125 }, (_, index) => ({
      ...catalogMocks.leaves[1],
      catalogId: `hg38:interval${index}`,
      track: `interval${index}`,
      shortLabel: `Interval ${index}`,
      longLabel: index === 124 ? 'A distant matching dataset' : 'Ordinary interval',
    }));
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult(tracks));
    const { onAddUcscTrack } = renderPublicDialog({ genomeId: 'hg38' });
    await screen.findByTestId('ucsc-track-result-interval0');
    expect(screen.getAllByTestId(/^ucsc-track-result-/)).toHaveLength(50);
    expect(screen.queryByTestId('ucsc-track-result-interval124')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
    intersectCatalogEnd();
    expect(screen.getAllByTestId(/^ucsc-track-result-/)).toHaveLength(100);
    expect(screen.getByTestId('ucsc-track-result-interval0')).toBeVisible();
    intersectCatalogEnd();
    expect(screen.getAllByTestId(/^ucsc-track-result-/)).toHaveLength(125);
    expect(screen.queryByTestId('ucsc-catalog-scroll-sentinel')).toBeNull();
    const last = screen.getByTestId('ucsc-track-result-interval124');
    fireEvent.click(within(last).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAddUcscTrack).toHaveBeenCalledWith(tracks[124]));
    filterColumn('Description', 'distant');
    expect(screen.getByTestId('ucsc-track-result-interval124')).toBeVisible();
    expect(screen.getAllByTestId(/^ucsc-track-result-/)).toHaveLength(1);
    expect(screen.getByTestId('ucsc-catalog-result-summary')).toHaveTextContent('1 of 125 tracks');
    fireEvent.click(screen.getByRole('button', { name: 'Clear column filters' }));
    expect(screen.getAllByTestId(/^ucsc-track-result-/)).toHaveLength(50);
    expect(screen.queryByTestId('ucsc-track-result-interval124')).toBeNull();
    intersectCatalogEnd();
    expect(screen.getAllByTestId(/^ucsc-track-result-/)).toHaveLength(100);
    const scroll = screen.getByTestId('ucsc-catalog-table-scroll');
    scroll.scrollTop = 400;
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Track' }));
    expect(screen.getByTestId('ucsc-track-result-interval0')).toBeVisible();
    expect(screen.getAllByTestId(/^ucsc-track-result-/)).toHaveLength(50);
    expect(scroll.scrollTop).toBe(0);
  });

  it('adds the selected older release with its original catalog identity', async () => {
    const older = {
      ...catalogMocks.leaves[0],
      catalogId: 'hg38:genesV48',
      track: 'genesV48',
      shortLabel: 'Genes V48',
    };
    const newest = {
      ...older,
      catalogId: 'hg38:genesV49',
      track: 'genesV49',
      shortLabel: 'Genes V49',
    };
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult([older, newest]));
    const { onAddUcscTrack } = renderPublicDialog(
      { genomeId: 'hg38' },
      new Set([newest.catalogId])
    );
    const select = await screen.findByRole('combobox', { name: 'Release of Genes V49' });
    expect(select).toHaveValue(newest.catalogId);
    expect(screen.getByTestId('ucsc-track-added-genesV49')).toBeVisible();
    fireEvent.change(select, { target: { value: older.catalogId } });
    const row = screen.getByTestId('ucsc-track-result-genesV48');
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onAddUcscTrack).toHaveBeenCalledWith(older));
  });

  it('lets rare metadata become a column and clears its filter when the column is hidden', async () => {
    vi.mocked(searchUcscCatalog).mockResolvedValue(
      catalogResult([
        {
          ...catalogMocks.leaves[0],
          attributes: [
            { key: 'category', value: 'tissue', origin: 'subgroup' },
            { key: 'cellType', value: 'brain', origin: 'subgroup' },
            { key: 'donorId', value: 'donor-17', origin: 'metadata' },
          ],
        },
      ])
    );
    renderPublicDialog({ genomeId: 'hg38' });
    await screen.findByTestId('ucsc-track-result-knownGene');
    expect(screen.queryByRole('textbox', { name: 'Filter Donor id' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose table columns' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Donor id column' }));
    filterColumn('Donor id', 'not-this-donor');
    expect(screen.queryByTestId('ucsc-track-result-knownGene')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Donor id column' }));
    expect(screen.getByTestId('ucsc-track-result-knownGene')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear column filters' })).toBeNull();
  });

  it('opens on the whole catalog and adds a track without requiring a search', async () => {
    const onAdd = vi.fn(async () => 'added' as const);
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={onAdd}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Search public genomic data')).toBeVisible();
    fireEvent.click(screen.getByTestId('add-data-files-tab'));
    expect(screen.getByTestId('add-data-files-choose')).toBeVisible();
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    expect(screen.queryByText(/Attach data to/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Signal graph')).not.toBeInTheDocument();
    expect(screen.queryByText('Aligned sequencing reads')).not.toBeInTheDocument();
    const signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    expect(vi.mocked(searchUcscCatalog)).toHaveBeenCalledWith(
      {
        genome: 'hg38',
        query: '',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(signal).toHaveTextContent('Signal');
    expect(signal).toHaveTextContent('BigWig');
    expect(signal).toHaveTextContent('ENCODE');
    expect(signal.querySelector('[data-column-id="track"]')).toHaveAttribute(
      'title',
      expect.stringContaining('ENCSR109DTU')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose table columns' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Experiment accession column' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show File accession column' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose table columns' }));
    expect(signal).toHaveTextContent('ENCSR109DTU');
    expect(signal).toHaveTextContent('ENCFF230LAU');
    expect(signal).not.toHaveTextContent('hg38');
    fireEvent.click(signal.querySelector('button')!);

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        track: 'gc5BaseBw',
        scientificKind: 'quantitative',
        formatId: 'bigwig',
      })
    );
    expect(await screen.findByTestId('ucsc-track-added-gc5BaseBw')).toBeVisible();
    expect(screen.queryByText('GC Percent added.')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('GC Percent is in this view.');
    expect(screen.getByRole('status')).toHaveClass('sr-only');
  });

  it('shows tracks already in the view when the dialog opens', async () => {
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        presentCatalogIds={new Set(['hg38:gc5BaseBw'])}
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    const signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    expect(within(signal).getByTestId('ucsc-track-added-gc5BaseBw')).toHaveAccessibleName(
      'GC Percent is in this view'
    );
    expect(within(signal).queryByRole('button', { name: 'Add' })).toBeNull();
    expect(
      within(screen.getByTestId('ucsc-track-result-knownGene')).getByRole('button', { name: 'Add' })
    ).toBeEnabled();
    expect(screen.queryByText(/added\./i)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('ucsc-catalog-result-summary')).toBeVisible();
  });

  it('offers Add again after a track leaves the view', async () => {
    const props = {
      assemblyDisplayName: 'GRCh38',
      ucscTarget: { genomeId: 'hg38' },
      busy: null,
      progress: null,
      notice: null,
      dataFileNotice: null,
      indexedBusy: null,
      indexedNotice: null,
      onChooseDataFiles: vi.fn(),
      onAddNetworkSource: noopNetworkSource,
      onSaveCredential: noopSaveCredential,
      remoteVariantsAvailable: true,
      onAddUcscTrack: vi.fn(async () => 'added' as const),
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <AddTrackDialog {...props} open presentCatalogIds={new Set<string>()} />
    );
    const signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    fireEvent.click(within(signal).getByRole('button', { name: 'Add' }));
    expect(await within(signal).findByTestId('ucsc-track-added-gc5BaseBw')).toBeVisible();

    const present = new Set(['hg38:gc5BaseBw']);
    rerender(<AddTrackDialog {...props} open presentCatalogIds={present} />);
    expect(screen.getByTestId('ucsc-track-added-gc5BaseBw')).toBeVisible();

    rerender(<AddTrackDialog {...props} open presentCatalogIds={new Set<string>()} />);
    expect(
      await within(await screen.findByTestId('ucsc-track-result-gc5BaseBw')).findByRole('button', {
        name: 'Add',
      })
    ).toBeVisible();
  });

  it('searches GRCz12tu by its exact UCSC GenArk accession', async () => {
    vi.mocked(searchUcscCatalog).mockResolvedValueOnce(catalogResult([]));
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCz12tu"
        ucscTarget={{ genomeId: 'GCF_049306965.2' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(searchUcscCatalog).toHaveBeenCalledWith(
        { genome: 'GCF_049306965.2', query: '' },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    expect(searchUcscCatalog).not.toHaveBeenCalledWith(
      expect.objectContaining({ genome: 'GRCz12tu' }),
      expect.anything()
    );
  });

  it('lists a hub-backed assembly target whole, keeping its genome id and hub', async () => {
    vi.mocked(searchUcscCatalog).mockResolvedValueOnce(catalogResult([]));
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="Hub assembly"
        ucscTarget={{ genomeId: 'hubAssembly', hubUrl: 'https://example.org/hub.txt' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(searchUcscCatalog).toHaveBeenCalledWith(
        {
          genome: 'hubAssembly',
          query: '',
          hubUrl: 'https://example.org/hub.txt',
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    );
    const source = screen.getByTestId('ucsc-catalog-source-hosted');
    expect(source).toHaveTextContent('example.org (hubAssembly)');
    expect(source).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the automatic search alive when the already-active public tab is clicked', async () => {
    let finishSearch!: (result: UcscCatalogSearchResult) => void;
    let searchSignal: AbortSignal | undefined;
    vi.mocked(searchUcscCatalog).mockImplementationOnce(
      (_input, options) =>
        new Promise((resolve) => {
          searchSignal = options?.signal;
          finishSearch = resolve;
        })
    );
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(searchSignal).toBeDefined());
    expect(searchSignal?.aborted).toBe(false);

    await act(async () =>
      finishSearch(
        catalogResult([
          {
            sourceKind: 'ucsc-native',
            catalogId: 'hg38:gc5BaseBw',
            track: 'gc5BaseBw',
            shortLabel: 'GC Percent',
            longLabel: 'GC percent',
            scientificKind: 'quantitative',
            formatId: 'bigwig',
            assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
            bigDataUrl: 'https://encode-public.s3.amazonaws.com/sample.bigWig',
            type: 'bigWig',
          },
        ])
      )
    );
    expect(await screen.findByTestId('ucsc-track-result-gc5BaseBw')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it('does not trap the user in the picker while remote track admission is pending', async () => {
    const onClose = vi.fn();
    const onAdd = vi.fn(() => new Promise<'added'>(() => {}));
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={onAdd}
        onClose={onClose}
      />
    );

    const signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    fireEvent.click(signal.querySelector('button')!);
    await waitFor(() => expect(signal.querySelector('button')).toHaveTextContent('Adding…'));

    const close = screen.getByRole('button', { name: 'Close data picker' });
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lets a user leave while a durable alignment-index job continues in Jobs', async () => {
    const onClose = vi.fn();
    const progress = {
      phase: 'checking-index' as const,
      label: 'Checking index',
      fileName: 'sample.bam',
      fileNumber: 1,
      fileCount: 1,
      stepNumber: 1,
      stepCount: 4 as const,
    };
    const props = {
      open: true,
      assemblyDisplayName: 'GRCh38',
      ucscTarget: null,
      busy: 'Checking sample.bam…',
      progress,
      notice: null,
      dataFileNotice: null,
      indexedBusy: null,
      indexedNotice: null,
      onChooseDataFiles: vi.fn(),
      onAddNetworkSource: noopNetworkSource,
      onSaveCredential: noopSaveCredential,
      remoteVariantsAvailable: true,
      onAddUcscTrack: vi.fn(async () => 'added' as const),
      onClose,
    };
    const { rerender } = render(<AddTrackDialog {...props} busy={null} progress={null} />);
    rerender(<AddTrackDialog {...props} />);

    const close = screen.getByRole('button', { name: 'Close data picker' });
    expect(close).toBeEnabled();
    fireEvent.click(screen.getByTestId('add-data-files-tab'));
    expect(screen.getByTestId('add-data-files-choose')).toBeDisabled();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <AddTrackDialog
        {...props}
        progress={{ ...progress, phase: 'validating-assembly', label: 'Validating assembly' }}
        busy="Validating sample.bam…"
      />
    );
    expect(close).toBeDisabled();
  });

  it('imports files dropped anywhere on the dialog, with no box to aim at', async () => {
    const onImportDataFilePaths = vi.fn(async () => undefined);
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult([]));
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onImportDataFilePaths={onImportDataFilePaths}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByTestId('add-track-dialog');
    const files = [new File(['x'], 'reads.bam'), new File(['y'], 'signal.bw')];
    const dataTransfer = { types: ['Files'], files, dropEffect: 'none' };

    expect(screen.queryByTestId('add-track-drop-overlay')).toBeNull();
    fireEvent.dragOver(dialog, { dataTransfer });
    expect(screen.getByTestId('add-track-drop-overlay')).toHaveTextContent('Drop to add');

    fireEvent.drop(dialog, { dataTransfer });
    expect(onImportDataFilePaths).toHaveBeenCalledWith(['/data/reads.bam', '/data/signal.bw']);
    expect(screen.queryByTestId('add-track-drop-overlay')).toBeNull();
  });

  it('searches as the query is typed, with no button and no frozen field', async () => {
    vi.mocked(searchUcscCatalog).mockResolvedValue(catalogResult([]));
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Search' })).toHaveClass('sr-only');

    const box = screen.getByRole('textbox', { name: 'Search public genomic data' });
    fireEvent.change(box, { target: { value: 'CpG' } });
    await waitFor(() =>
      expect(searchUcscCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ genome: 'hg38', query: 'CpG' }),
        expect.anything()
      )
    );
    expect(box).toBeEnabled();
    expect(box).toHaveValue('CpG');

    fireEvent.change(box, { target: { value: 'CpG islands' } });
    await waitFor(() =>
      expect(searchUcscCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'CpG islands' }),
        expect.anything()
      )
    );
    expect(box).toBeEnabled();
  });

  it('locks a catalog result after permanent remote admission failure', async () => {
    const failure = Object.assign(new Error('The remote track file was not found (HTTP 404)'), {
      retryable: false,
    });
    const onAdd = vi.fn(async () => Promise.reject(failure));
    const props = {
      assemblyDisplayName: 'GRCh38',
      ucscTarget: { genomeId: 'hg38' },
      busy: null,
      progress: null,
      notice: null,
      dataFileNotice: null,
      indexedBusy: null,
      indexedNotice: null,
      onChooseDataFiles: vi.fn(),
      onAddNetworkSource: noopNetworkSource,
      onSaveCredential: noopSaveCredential,
      remoteVariantsAvailable: true,
      onAddUcscTrack: onAdd,
      onClose: vi.fn(),
    };
    const { rerender } = render(<AddTrackDialog {...props} open />);

    const signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    fireEvent.click(signal.querySelector('button')!);

    expect(await screen.findByText(userMessage('tracks.loadFailed'))).toBeVisible();
    expect(screen.queryByText(/track file was not found \(HTTP 404\)/)).not.toBeInTheDocument();
    const unavailable = screen.getByRole('button', { name: 'Unavailable' });
    expect(unavailable).toBeDisabled();
    fireEvent.click(unavailable);
    expect(onAdd).toHaveBeenCalledOnce();

    rerender(<AddTrackDialog {...props} open={false} />);
    rerender(<AddTrackDialog {...props} open />);

    const reopenedSignal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    expect(reopenedSignal.querySelector<HTMLButtonElement>('button')).toHaveTextContent(
      'Unavailable'
    );
    expect(reopenedSignal.querySelector<HTMLButtonElement>('button')).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search public genomic data' }), {
      target: { value: 'GC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const searchedSignal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    expect(searchedSignal.querySelector<HTMLButtonElement>('button')).toHaveTextContent(
      'Unavailable'
    );
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('labels temporary remote admission failure as Retry instead of Add', async () => {
    const firstFailure = Object.assign(new Error('The remote source could not be reached'), {
      retryable: true,
    });
    const onAdd = vi
      .fn<() => Promise<'added'>>()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce('added');
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={onAdd}
        onClose={vi.fn()}
      />
    );

    const signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    fireEvent.click(signal.querySelector('button')!);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(await screen.findByTestId('ucsc-track-added-gc5BaseBw')).toBeVisible();
    expect(screen.queryByText('GC Percent added.')).not.toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it('does not let a completed add from a closed picker clear a newer add', async () => {
    let resolveFirst!: (result: 'added') => void;
    let resolveSecond!: (result: 'added') => void;
    const first = new Promise<'added'>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<'added'>((resolve) => {
      resolveSecond = resolve;
    });
    const onAdd = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const props = {
      assemblyDisplayName: 'GRCh38',
      ucscTarget: { genomeId: 'hg38' },
      busy: null,
      progress: null,
      notice: null,
      dataFileNotice: null,
      indexedBusy: null,
      indexedNotice: null,
      onChooseDataFiles: vi.fn(),
      onAddNetworkSource: noopNetworkSource,
      onSaveCredential: noopSaveCredential,
      remoteVariantsAvailable: true,
      onAddUcscTrack: onAdd,
      onClose: vi.fn(),
    };
    const { rerender } = render(<AddTrackDialog {...props} open />);

    let signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    fireEvent.click(signal.querySelector('button')!);
    await waitFor(() => expect(signal.querySelector('button')).toHaveTextContent('Adding…'));

    rerender(<AddTrackDialog {...props} open={false} />);
    rerender(<AddTrackDialog {...props} open />);
    signal = await screen.findByTestId('ucsc-track-result-gc5BaseBw');
    fireEvent.click(signal.querySelector('button')!);
    await waitFor(() => expect(signal.querySelector('button')).toHaveTextContent('Adding…'));

    await act(async () => {
      resolveFirst('added');
      await first;
    });
    expect(signal.querySelector('button')).toHaveTextContent('Adding…');
    expect(screen.queryByTestId('ucsc-track-added-gc5BaseBw')).not.toBeInTheDocument();
    expect(screen.queryByText('GC Percent added.')).not.toBeInTheDocument();

    await act(async () => {
      resolveSecond('added');
      await second;
    });
    expect(await screen.findByTestId('ucsc-track-added-gc5BaseBw')).toBeVisible();
    expect(screen.queryByText('GC Percent added.')).not.toBeInTheDocument();
  });

  it('shows what the catalog says a track measured', async () => {
    vi.mocked(searchUcscCatalog).mockResolvedValue(
      catalogResult([
        {
          sourceKind: 'ucsc-native',
          catalogId: 'hg38:encTfChipPkENCFF635MUK',
          track: 'encTfChipPkENCFF635MUK',
          shortLabel: 'vagina POLR2A 2',
          longLabel: 'Transcription Factor ChIP-seq Peaks of POLR2A in vagina',
          scientificKind: 'peak',
          formatId: 'ucsc-native',
          assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
          attributes: [
            { key: 'cellType', value: 'vagina', origin: 'subgroup' },
            { key: 'factor', value: 'POLR2A', origin: 'subgroup' },
          ],
        },
        {
          sourceKind: 'ucsc-native',
          catalogId: 'hg38:plain',
          track: 'plain',
          shortLabel: 'Plain track',
          longLabel: 'A track the catalog says nothing else about',
          scientificKind: 'interval',
          formatId: 'ucsc-native',
          assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
        },
      ]) as never
    );

    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('Search public genomic data'), {
      target: { value: 'POLR2A' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const row = await screen.findByTestId('ucsc-track-result-encTfChipPkENCFF635MUK');
    expect(screen.getByRole('columnheader', { name: /Cell type/ })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: /Factor/ })).toBeVisible();
    expect(row.querySelector('[data-column-id="attribute:cellType"]')).toHaveTextContent('vagina');
    expect(row.querySelector('[data-column-id="attribute:factor"]')).toHaveTextContent('POLR2A');
    expect(
      screen
        .getByTestId('ucsc-track-result-plain')
        .querySelector('[data-column-id="attribute:factor"]')
    ).toHaveTextContent('—');
  });

  it("lists every match as a row, with the hub's filing as provenance", async () => {
    const conservation = { track: 'cons26way', shortLabel: 'Conservation', kind: 'composite' };
    const alignView = {
      track: 'cons26wayViewalign',
      shortLabel: 'Multiz Alignments',
      kind: 'view',
    };
    const elementView = {
      track: 'cons26wayViewelements',
      shortLabel: 'Conserved Elements',
      kind: 'view',
    };
    const hubLeaf = (track: string, shortLabel: string, containerPath: unknown[]) => ({
      sourceKind: 'ucsc-hub',
      catalogId: `hub:${track}`,
      track,
      shortLabel,
      longLabel: `${shortLabel} long`,
      scientificKind: 'interval',
      formatId: 'bigbed',
      assembly: { ucscGenome: 'hg38', aliases: ['hg38'] },
      hubUrl: 'https://hub.example.org/hub.txt',
      bigDataUrl: `https://hub.example.org/${track}.bb`,
      containerPath,
    });
    vi.mocked(searchUcscCatalog).mockResolvedValue(
      catalogResult([
        hubLeaf('multiz26way', 'Multiz Align', [conservation, alignView]),
        hubLeaf('phastConsElements26way', '26-way El', [conservation, elementView]),
        hubLeaf('augustusGene', 'AUGUSTUS', []),
      ]) as never
    );

    const onAdd = vi.fn(async () => 'added' as const);
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={onAdd}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText('Search public genomic data'), {
      target: { value: 'conservation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    const nested = await screen.findByTestId('ucsc-track-result-multiz26way');
    expect(nested).toBeVisible();
    expect(screen.getByTestId('ucsc-track-result-phastConsElements26way')).toBeVisible();
    expect(screen.getByTestId('ucsc-track-result-augustusGene')).toBeVisible();
    expect(screen.queryByTestId('ucsc-track-group-cons26way')).toBeNull();

    expect(screen.getByTestId('ucsc-track-context-multiz26way')).toHaveTextContent(
      'Conservation › Multiz Alignments'
    );

    fireEvent.click(nested.querySelector('button')!);
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ track: 'multiz26way' }))
    );
  });

  it('adds native intervals and semantic BigBed catalog tracks', async () => {
    const onAdd = vi.fn(async () => 'added' as const);
    const onClose = vi.fn();
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={onAdd}
        onClose={onClose}
      />
    );

    fireEvent.change(screen.getByLabelText('Search public genomic data'), {
      target: { value: 'CpG islands' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('GENCODE genes')).toBeVisible());

    const geneRow = screen.getByTestId('ucsc-track-result-knownGene');
    expect(geneRow.querySelector('button')).toBeEnabled();
    expect(geneRow.querySelector('button')).toHaveAttribute(
      'title',
      expect.stringContaining('Add GENCODE genes')
    );
    fireEvent.click(geneRow.querySelector('button')!);
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          track: 'knownGene',
          scientificKind: 'transcript',
          formatId: 'bigbed',
        })
      )
    );

    const cpgRow = screen.getByTestId('ucsc-track-result-cpgIslandExt');
    expect(cpgRow.querySelector('button')).toBeEnabled();
    fireEvent.click(cpgRow.querySelector('button')!);
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          track: 'cpgIslandExt',
          scientificKind: 'interval',
          formatId: 'ucsc-native',
        })
      )
    );

    const bigWigRow = screen.getByTestId('ucsc-track-result-gc5BaseBw');
    expect(bigWigRow.querySelector('button')).toBeEnabled();
    expect(cpgRow).toHaveTextContent('UCSC');
    fireEvent.click(screen.getByTestId('ucsc-facet-scientificKind-quantitative'));
    expect(screen.queryByTestId('ucsc-track-result-cpgIslandExt')).not.toBeInTheDocument();
    expect(screen.getByTestId('ucsc-track-result-gc5BaseBw')).toBeVisible();

    fireEvent.click(screen.getByTestId('ucsc-facet-scientificKind-quantitative'));
    fireEvent.click(screen.getByTestId('ucsc-facet-scientificKind-interval'));
    expect(screen.getByTestId('ucsc-track-result-cpgIslandExt')).toBeVisible();
    expect(screen.queryByTestId('ucsc-track-result-knownGene')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ucsc-track-result-gc5BaseBw')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search public genomic data'), {
      target: { value: 'new query' },
    });
    await waitFor(() => expect(screen.getByTestId('ucsc-track-result-gc5BaseBw')).toBeVisible());
    expect(screen.getByTestId('ucsc-track-result-cpgIslandExt')).toBeVisible();
    expect(screen.getByTestId('ucsc-track-result-knownGene')).toBeVisible();
    fireEvent.click(screen.getByTestId('ucsc-track-result-gc5BaseBw').querySelector('button')!);
    await waitFor(() =>
      expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ track: 'gc5BaseBw' }))
    );
    expect(screen.getByRole('dialog', { name: 'Add data' })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers only source and composition choices backed by real product paths', async () => {
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Search public genomic data')).toBeVisible();
    expect(screen.getByTestId('add-track-link-toggle')).toBeVisible();
    expect(screen.getByTestId('add-track-hubs-toggle')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Remote cluster' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Signal + reads' })).toBeVisible();
    fireEvent.click(screen.getByTestId('add-data-files-tab'));
    expect(screen.getByTestId('add-data-files-choose')).toBeVisible();
    expect(screen.queryAllByRole('tab')).toHaveLength(6);
    expect(screen.getByTestId('add-track-dialog')).toHaveClass('h-[88vh]');
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    expect(await screen.findByText('GC Percent')).toBeVisible();
  });

  it('offers no UCSC actions or requests for an unmapped assembly', () => {
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="Custom reference called GRCh38.p14"
        ucscTarget={null}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={noopNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('add-track-link-toggle')).toBeEnabled();
    expect(screen.getByText(/Public catalog loading is not mapped/i)).toBeVisible();
    expect(screen.getByTestId('add-track-link-toggle')).toBeEnabled();
    fireEvent.click(screen.getByTestId('add-data-files-tab'));
    expect(screen.getByTestId('add-data-files-choose')).toBeEnabled();
    expect(searchUcscCatalog).not.toHaveBeenCalled();
  });

  it('attaches a workflow BigWig URL without describing it as a UCSC track', async () => {
    const onAddNetworkSource = vi.fn(async () => undefined);
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={{ kind: 'success', text: 'sample.bigWig added.' }}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={onAddNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Indexed track URL'), {
      target: { value: 'https://results.example.org/run/sample.bigWig' },
    });
    fireEvent.change(screen.getByLabelText(/Track label/), {
      target: { value: 'RNA-seq coverage' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() =>
      expect(onAddNetworkSource).toHaveBeenCalledWith({
        source: { kind: 'http', url: 'https://results.example.org/run/sample.bigWig' },
        label: 'RNA-seq coverage',
      })
    );
    expect(screen.getByText(/does not download the whole file/i)).toBeVisible();
  });

  it('lets a linked BigBed declare its scientific interpretation', async () => {
    const onAddNetworkSource = vi.fn(async () => undefined);
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={onAddNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'bigbed' } });
    fireEvent.change(screen.getByLabelText('BigBed content'), { target: { value: 'peak' } });
    fireEvent.change(screen.getByLabelText('Indexed track URL'), {
      target: { value: 'https://results.example.org/run/accessible.bb' },
    });
    fireEvent.change(screen.getByLabelText(/Track label/), {
      target: { value: 'Accessible peaks' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() =>
      expect(onAddNetworkSource).toHaveBeenCalledWith({
        formatId: 'bigbed',
        source: { kind: 'http', url: 'https://results.example.org/run/accessible.bb' },
        scientificKind: 'peak',
        label: 'Accessible peaks',
      })
    );
  });

  it('collects an explicit remote BAM index instead of guessing a neighboring URL', async () => {
    const onAddNetworkSource = vi.fn(async () => undefined);
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={onAddNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'bam' } });
    fireEvent.change(screen.getByLabelText('Indexed track URL'), {
      target: { value: 'https://reads.example.org/run/tumor.bam' },
    });
    fireEvent.change(screen.getByLabelText('Alignment index URL'), {
      target: { value: 'https://reads.example.org/run/tumor.bam.bai' },
    });
    fireEvent.change(screen.getByLabelText(/Track label/), {
      target: { value: 'Tumor reads' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() =>
      expect(onAddNetworkSource).toHaveBeenCalledWith({
        formatId: 'bam',
        source: { kind: 'http', url: 'https://reads.example.org/run/tumor.bam' },
        index: { kind: 'http', url: 'https://reads.example.org/run/tumor.bam.bai' },
        label: 'Tumor reads',
      })
    );
  });

  it.each([
    [
      'vcf',
      'https://variants.example.org/tumor.vcf.gz',
      'https://variants.example.org/tumor.vcf.gz.tbi',
    ],
    ['bcf', 'https://variants.example.org/tumor.bcf', 'https://variants.example.org/tumor.bcf.csi'],
  ] as const)(
    'collects an explicit remote %s index for mutation navigation',
    async (formatId, sourceUrl, indexUrl) => {
      const onAddNetworkSource = vi.fn(async () => undefined);
      render(
        <AddTrackDialog
          open
          assemblyDisplayName="GRCh38"
          ucscTarget={{ genomeId: 'hg38' }}
          busy={null}
          progress={null}
          notice={null}
          dataFileNotice={null}
          indexedBusy={null}
          indexedNotice={null}
          onChooseDataFiles={vi.fn()}
          onAddNetworkSource={onAddNetworkSource}
          onSaveCredential={noopSaveCredential}
          remoteVariantsAvailable
          onAddUcscTrack={vi.fn(async () => 'added' as const)}
          onClose={vi.fn()}
        />
      );

      fireEvent.click(screen.getByTestId('add-track-link-toggle'));
      fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: formatId } });
      fireEvent.change(screen.getByLabelText('Indexed track URL'), {
        target: { value: sourceUrl },
      });
      fireEvent.change(screen.getByLabelText('Variant index URL'), {
        target: { value: indexUrl },
      });
      fireEvent.change(screen.getByLabelText(/Track label/), {
        target: { value: 'Tumor calls' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

      await waitFor(() =>
        expect(onAddNetworkSource).toHaveBeenCalledWith({
          formatId,
          source: { kind: 'http', url: sourceUrl },
          index: { kind: 'http', url: indexUrl },
          label: 'Tumor calls',
        })
      );
    }
  );

  it('collects an htsget endpoint and resource without asking for a file index', async () => {
    const onAddNetworkSource = vi.fn(async () => undefined);
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={onAddNetworkSource}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Source protocol'), {
      target: { value: 'htsget' },
    });
    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'vcf' } });
    fireEvent.change(screen.getByLabelText('htsget service endpoint'), {
      target: { value: 'https://htsget.example.org' },
    });
    fireEvent.change(screen.getByLabelText('htsget resource ID'), {
      target: { value: 'tumor-calls' },
    });
    fireEvent.change(screen.getByLabelText(/Track label/), {
      target: { value: 'Tumor calls' },
    });

    expect(screen.queryByLabelText(/index URL/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() =>
      expect(onAddNetworkSource).toHaveBeenCalledWith({
        formatId: 'vcf',
        source: {
          kind: 'htsget',
          endpoint: 'https://htsget.example.org',
          resourceId: 'tumor-calls',
          dataClass: 'variants',
          format: 'VCF',
        },
        label: 'Tumor calls',
      })
    );
  });

  it('shows an approved message when remote variant admission fails', async () => {
    render(
      <AddTrackDialog
        open
        assemblyDisplayName="GRCh38"
        ucscTarget={{ genomeId: 'hg38' }}
        busy={null}
        progress={null}
        notice={null}
        dataFileNotice={null}
        indexedBusy={null}
        indexedNotice={null}
        onChooseDataFiles={vi.fn()}
        onAddNetworkSource={vi.fn(async () => {
          throw new Error('The VCF index does not match this source.');
        })}
        onSaveCredential={noopSaveCredential}
        remoteVariantsAvailable
        onAddUcscTrack={vi.fn(async () => 'added' as const)}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'vcf' } });
    fireEvent.change(screen.getByLabelText('Indexed track URL'), {
      target: { value: 'https://variants.example.org/tumor.vcf.gz' },
    });
    fireEvent.change(screen.getByLabelText('Variant index URL'), {
      target: { value: 'https://variants.example.org/tumor.vcf.gz.tbi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    expect(await screen.findByTestId('add-track-url-error')).toHaveTextContent(
      userMessage('tracks.loadFailed')
    );
    expect(screen.queryByText('The VCF index does not match this source.')).not.toBeInTheDocument();
  });
});

describe('what a track is called on its row', () => {
  function leaf(shortLabel: string, longLabel: string, facts: ReadonlyArray<string> = []) {
    return {
      shortLabel,
      longLabel,
      track: 'someTable',
      attributes: facts.map((value) => ({ key: 'k', value, origin: 'subGroups' as const })),
    } as Parameters<typeof trackHeadline>[0];
  }

  it("uses the catalog's own label, because it is what distinguishes rows", () => {
    expect(
      trackHeadline(
        leaf('AdipocyteBreastD1+', 'Adipocyte - breast, donor1_CNhs11051_forward', [
          'hCAGE',
          'primaryCell',
          'forward',
        ])
      )
    ).toBe('AdipocyteBreastD1+');
  });

  it('spells out a bare accession, which is unique and says nothing', () => {
    expect(
      trackHeadline(leaf('ENCFF004SRJ', 'Colonic mucosa, female adult (41 years): H3K27ac'))
    ).toBe('Colonic mucosa, female adult (41 years): H3K27ac');
  });

  it('leaves an all-capital word alone, since it is a name and not an accession', () => {
    expect(trackHeadline(leaf('AUGUSTUS', 'AUGUSTUS ab initio gene predictions'))).toBe('AUGUSTUS');
    expect(trackHeadline(leaf('CCDS', 'Consensus CDS'))).toBe('CCDS');
    expect(trackHeadline(leaf('MANE', 'MANE Select Plus Clinical'))).toBe('MANE');
  });

  it('falls back to the long label when a catalog gives no short one', () => {
    expect(trackHeadline(leaf('', 'Repeating elements by RepeatMasker'))).toBe(
      'Repeating elements by RepeatMasker'
    );
  });
});
