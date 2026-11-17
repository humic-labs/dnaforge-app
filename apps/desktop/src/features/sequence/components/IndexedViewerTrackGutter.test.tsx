import { SCIENTIFIC_COLOR_PALETTES } from '@waypoint/sequence-utils';
import type { SequenceDataLayerPresentation } from '../../../shared/sequence-data-layer';
import type { SequenceDataLayerTrackControls } from '../data-layers/useSequenceDataLayers';
import { userMessage } from '@waypoint/user-messages';
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdmittedTrackSource } from '@waypoint/genome-data';

import { useConfirmDialogStore } from '../../../components/confirm-dialog-store';
import type { AnnotationTrackDefinition } from '../annotation-track-registry';
import { useLaneContractStore, type ActiveStressDataset } from '../lane-contract-store';
import { UCSC_TRACK_RECOVERING_STATUS } from '../ucsc-streaming-status';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';

import type { AlignedReadTrackStatusSnapshot } from '../aligned-read-track-lifecycle';
import type { RemoteEndpointProfileV1 } from '../../../shared/remote-genomics-ipc';
import {
  coverageDepthToSliderPosition,
  coverageSliderPositionToDepth,
} from './CoverageCutoffControl';
import { IndexedViewerTrackGutter, remoteEndpointDisplayLabel } from './IndexedViewerTrackGutter';
import { useTrackGutterLayoutStore } from './track-gutter-layout-store';

type LinearRenderer = NonNullable<
  ReturnType<IndexedGenomeTileNativeMapHandle['getLinearRenderer']>
>;
type PresentedScrollReceipt = NonNullable<
  ReturnType<LinearRenderer['getPresentedTrackScrollReceipt']>
>;

const ucscMocks = vi.hoisted(() => ({
  search: vi.fn(async (input: { query: string }) => {
    if (input.query === 'CpG islands') {
      return [
        {
          sourceKind: 'ucsc-native' as const,
          catalogId: 'hg38:cpgIslandExt',
          track: 'cpgIslandExt',
          shortLabel: 'CpG Islands',
          longLabel: 'CpG Islands (Islands under 300 bases are light green)',
          scientificKind: 'interval' as const,
          formatId: 'ucsc-native' as const,
          assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
          type: 'bed 4 +',
        },
      ];
    }
    if (input.query === 'Transcript models') {
      return [
        {
          sourceKind: 'ucsc-native' as const,
          catalogId: 'hg38:knownGene',
          track: 'knownGene',
          shortLabel: 'Known Genes',
          longLabel: 'UCSC known gene transcript models',
          scientificKind: 'transcript' as const,
          formatId: 'bigbed' as const,
          assembly: { ucscGenome: 'hg38', aliases: ['GRCh38'] },
          bigDataUrl: 'https://hgdownload.example.org/knownGene.bb',
          type: 'bigGenePred',
        },
      ];
    }
    return [];
  }),
  fetchWhole: vi.fn(async () => ({
    records: [{ chrom: 'chr1', chromStart: 28_735, chromEnd: 29_737, name: 'CpG: 111' }],
    complete: true,
    itemsReturned: 1,
    maxItemsOutput: 100_000,
    trackType: 'bed 4 +',
  })),
  admit: vi.fn(),
  open: vi.fn(),
  closeSource: vi.fn(),
}));

const credentialMocks = vi.hoisted(() => ({
  save: vi.fn(async (input: { authRef: string; kind: string }) => ({
    authRef: input.authRef,
    kind: input.kind,
    connected: true as const,
  })),
}));

const remoteProfileMocks = vi.hoisted(() => ({
  rename: vi.fn(async (endpointId: string, displayName: string) => ({
    endpointId,
    displayName,
    target: 'lab-hpc',
    lastConnectedAt: 1,
    observedPlatform: 'linux',
    lastFailure: null,
  })),
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    genomeCredentials: { save: credentialMocks.save },
    remoteGenomics: { renameEndpoint: remoteProfileMocks.rename },
  }),
}));

vi.mock('../ucsc-track-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ucsc-track-client')>()),
  searchUcscTracks: ucscMocks.search,
  admitUcscTrack: ucscMocks.admit,
  fetchUcscWholeTrack: ucscMocks.fetchWhole,
}));

vi.mock('../bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: ucscMocks.open,
    queryQuantitative: vi.fn(),
    queryIntervals: vi.fn(),
    closeSource: ucscMocks.closeSource,
  }),
}));

const laneBands = vi.hoisted(() => ({
  current: {
    reference: { topPx: 14, heightPx: 100 },
    dataBounds: {
      'bam-a': { topPx: 114, heightPx: 80 },
      'bam-b': { topPx: 194, heightPx: 80 },
    },
  } as {
    reference?: { topPx: number; heightPx: number };
    dataBounds: Record<string, { topPx: number; heightPx: number }>;
    annotationSearchFocusPresentation?: {
      trackId: string;
      canonicalIdentity: string;
      lane: number;
    } | null;
  },
}));

const rendererTrackDiagnostics: {
  current: Record<string, object | null>;
} = { current: {} };

const ASSEMBLY_ID = 'grch38';
const ANNOTATION_REGISTRY: ReadonlyArray<AnnotationTrackDefinition> = [
  { trackId: 'gene', label: 'gene', order: 0, visible: true },
];

function pileup(trackId: string, label: string, cutoff: number): ActiveStressDataset {
  return {
    trackType: 'pileup-genomewide',
    trackId,
    label,
    color: 0x2563eb,
    trackPx: 80,
    records: [],
    pileupRecords: [],
    kind: 'pileup',
    coverageCutoffDepth: cutoff,
  };
}

function sourcedPileup(trackId: string, label: string, cutoff: number): ActiveStressDataset {
  return {
    ...pileup(trackId, label, cutoff),
    source: { bamPath: `/fixtures/${trackId}.bam`, indexPath: `/fixtures/${trackId}.bam.bai` },
  };
}

function quantitative(trackId: string, label: string): ActiveStressDataset {
  return {
    trackType: 'quantitative',
    trackId,
    label,
    color: 0x3b82f6,
    trackPx: 80,
    records: [],
    kind: 'annotation',
  };
}

function admittedBigWig(label: string): AdmittedTrackSource {
  return {
    uri: `/fixtures/${label}.bigWig`,
    input: { kind: 'path', path: `/fixtures/${label}.bigWig` },
    formatId: 'bigwig',
    admissionVersion: 1,
    fingerprint: `bigwig:${label}`,
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    assemblyId: ASSEMBLY_ID,
    referenceReceipt: {
      assemblyId: ASSEMBLY_ID,
      referenceSignature: 'reference',
      sourceSignature: 'source',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible',
      checkedAt: '2026-09-24T00:00:00.000Z',
    },
    provenance: { provider: 'local-file', sourceKind: 'local-file', label },
  };
}

function firePointerAt(
  type: 'down' | 'move' | 'up',
  target: Element | Document,
  clientY: number,
  pointerId: number
): void {
  const event =
    type === 'down'
      ? createEvent.pointerDown(target)
      : type === 'move'
        ? createEvent.pointerMove(target)
        : createEvent.pointerUp(target);
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: 10 },
    clientY: { value: clientY },
    pointerId: { value: pointerId },
  });
  fireEvent(target, event);
}

function mockReorderGeometry(): void {
  const rectangle = (top: number, height: number) => ({
    top,
    bottom: top + height,
    left: 0,
    right: 220,
    width: 220,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  vi.spyOn(screen.getByTestId('track-gutter'), 'getBoundingClientRect').mockReturnValue(
    rectangle(0, 800)
  );
  vi.spyOn(
    screen.getByTestId(`track-gutter-row-${ASSEMBLY_ID}:bam-a`),
    'getBoundingClientRect'
  ).mockReturnValue(rectangle(74, 80));
  vi.spyOn(
    screen.getByTestId(`track-gutter-row-${ASSEMBLY_ID}:bam-b`),
    'getBoundingClientRect'
  ).mockReturnValue(rectangle(154, 80));
}

function renderGutter(
  scrollTracksBy = vi.fn(() => false),
  temporaryAnnotationReveal?: {
    trackId: string;
    onShowTrack: () => void;
  } | null,
  visibleAnnotationSearchFocus?: {
    trackId: string;
    canonicalIdentity: string;
    onKeepAdditionalLane?: () => void;
  } | null,
  ucscTrackErrors: Readonly<Record<string, string>> = {},
  onRetryUcscTracks = vi.fn(),
  pileupTrackStatuses: AlignedReadTrackStatusSnapshot = {},
  onRetryPileupTrack = vi.fn(),
  onRepairPileupTrack = vi.fn(),
  recentRemoteEndpoints: readonly RemoteEndpointProfileV1[] = [],
  refreshRemoteEndpoints = vi.fn(async () => undefined),
  dataLayerControls?: SequenceDataLayerTrackControls
) {
  const onOpenMutationNavigator = vi.fn();
  const onAddVariantTrackRequest = vi.fn(async () => undefined);
  const addBamRequests = vi.fn(async () => undefined);
  const webglRef = createRef<IndexedGenomeTileNativeMapHandle>();
  const setTrackStackEndReserve = vi.fn(() => true);
  const setTrackPresentationOrder = vi.fn(() => true);
  const setTrackPresentationDrag = vi.fn(() => true);
  webglRef.current = {
    scrollTracksBy,
    setTrackStackEndReserve,
    requestRender: vi.fn(),
    subscribeToPresentedFrames: vi.fn(() => () => undefined),
    setTrackPresentationOrder,
    setTrackPresentationDrag,
    getLinearRenderer: () =>
      ({
        hasTrackInstance: vi.fn(() => true),
        setTrackColor: vi.fn(() => true),
        getPresentedTrackScrollReceipt: (): PresentedScrollReceipt => ({
          completedFrameEpoch: 7,
          trackScrollTop: 40,
          contentClipTopPx: 0,
        }),
        getTrackDiagnostics: (trackId: string) =>
          rendererTrackDiagnostics.current[trackId] ??
          (trackId === 'bam-a'
            ? { coverageDepthP99: 100, coverageDepthMax: 1_000 }
            : { coverageDepthP99: 200, coverageDepthMax: 2_000 }),
      }) as never,
  } as IndexedGenomeTileNativeMapHandle;
  const renderAtEpoch = (rendererReadyEpoch: number) => (
    <IndexedViewerTrackGutter
      dataLayerControls={dataLayerControls}
      laneOwnerId={ASSEMBLY_ID}
      assemblyId={ASSEMBLY_ID}
      assemblyDisplayName="GRCh38"
      assemblyReferences={[
        { name: 'chr1', length: 248_956_422 },
        { name: 'chr2', length: 242_193_529 },
      ]}
      visibleTypes={new Set(['gene'])}
      onToggleAnnotationLane={vi.fn()}
      annotationTrackRegistry={ANNOTATION_REGISTRY}
      onToggleVisibleType={vi.fn()}
      onSetVisibleTypes={vi.fn()}
      temporaryAnnotationReveal={temporaryAnnotationReveal}
      visibleAnnotationSearchFocus={visibleAnnotationSearchFocus}
      laneLimit={12}
      onChangeLaneLimit={vi.fn()}
      transcriptDisplayMode="canonical"
      onToggleTranscriptDisplayMode={vi.fn()}
      expandedGeneCount={0}
      rendererReadyEpoch={rendererReadyEpoch}
      ucscTrackErrors={ucscTrackErrors}
      onRetryUcscTracks={onRetryUcscTracks}
      pileupTrackStatuses={pileupTrackStatuses}
      onRetryPileupTrack={onRetryPileupTrack}
      bamImport={{
        busy: null,
        progress: null,
        notice: null,
        lastOperation: null,
        clearNotice: vi.fn(),
        recentRemoteEndpoints,
        refreshRemoteEndpoints,
        addRemote: vi.fn(async () => undefined),
        addFiles: vi.fn(async () => undefined),
        addRequests: addBamRequests,
        reconnectRemoteTrack: vi.fn(async () => true),
        editRemoteTrack: vi.fn(async () => undefined),
        repairTrack: onRepairPileupTrack,
      }}
      onAddVariantTrackRequest={onAddVariantTrackRequest}
      onOpenMutationNavigator={onOpenMutationNavigator}
      bands={laneBands.current}
      webglRef={webglRef}
    />
  );
  const rendered = render(renderAtEpoch(1));
  return {
    ...rendered,
    scrollTracksBy,
    setTrackStackEndReserve,
    setTrackPresentationOrder,
    setTrackPresentationDrag,
    onAddVariantTrackRequest,
    addBamRequests,
    onOpenMutationNavigator,
    refreshRemoteEndpoints,
    rerenderAtEpoch: (rendererReadyEpoch: number) =>
      rendered.rerender(renderAtEpoch(rendererReadyEpoch)),
  };
}

beforeEach(() => {
  remoteProfileMocks.rename.mockClear();
  credentialMocks.save.mockClear();
  ucscMocks.search.mockClear();
  ucscMocks.fetchWhole.mockClear();
  ucscMocks.admit.mockReset().mockResolvedValue({
    baseUrl: 'http://127.0.0.1:8100',
    sourceUri: 'https://hgdownload.example.org/knownGene.bb',
    sourceToken: 'opaque-token',
    canonicalUrlHash: 'hash',
    representationSha256: 'b'.repeat(64),
    representationIdentityKind: 'content-sha256',
    byteLength: 10_000,
    provenanceId: 'provenance',
    expiresAtMs: Date.now() + 60_000,
  });
  ucscMocks.open.mockReset().mockResolvedValue({
    fileType: 'bigbed',
    references: [
      { name: 'chr1', length: 248_956_422 },
      { name: 'chr2', length: 242_193_529 },
    ],
    zoomReductionLevels: [],
    fieldCount: 12,
  });
  ucscMocks.closeSource.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  rendererTrackDiagnostics.current = {};
  useConfirmDialogStore.setState({ request: null });
  laneBands.current = {
    reference: { topPx: 14, heightPx: 100 },
    dataBounds: {
      'bam-a': { topPx: 114, heightPx: 80 },
      'bam-b': { topPx: 194, heightPx: 80 },
    },
  };
  useLaneContractStore.getState().clear();
  useLaneContractStore
    .getState()
    .addLane(ASSEMBLY_ID, ASSEMBLY_ID, pileup('bam-a', 'Tumor BAM', 75));
  useLaneContractStore
    .getState()
    .addLane(ASSEMBLY_ID, ASSEMBLY_ID, pileup('bam-b', 'Normal BAM', 200));
});

afterEach(() => {
  cleanup();
  useConfirmDialogStore.getState().resolveCurrent(false);
  useLaneContractStore.getState().clear();
  localStorage.clear();
});

describe('IndexedViewerTrackGutter', () => {
  function savedLayerControls(unavailable: string | null = null): SequenceDataLayerTrackControls {
    const presentation: SequenceDataLayerPresentation = {
      sampleId: 'glucose',
      annotationColors: true,
      signalVisible: true,
      style: {
        geometry: 'bars',
        colorScale: {
          kind: 'continuous',
          domain: [0, 16],
          colors: [...SCIENTIFIC_COLOR_PALETTES.viridis.colors],
          missingColor: '#cbd5e1',
          transform: 'linear',
        },
      },
    };
    return {
      rows: [
        {
          id: 'expression',
          label: 'Expression',
          visible: true,
          samples: [
            { id: 'glucose', label: 'Glucose' },
            { id: 'acetate', label: 'Acetate' },
          ],
          presentation,
          unavailable,
        },
      ],
      errors: [],
      onVisibilityChange: vi.fn(),
      onPresentationChange: vi.fn(),
    };
  }

  function renderSavedLayers(controls: SequenceDataLayerTrackControls) {
    laneBands.current.dataBounds['sequence-data-expression'] = { topPx: 274, heightPx: 190 };
    return renderGutter(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controls
    );
  }

  it('places saved layers in the native gutter and changes their visibility through the layer owner', () => {
    const controls = savedLayerControls();
    renderSavedLayers(controls);
    const row = screen.getByTestId(
      'track-gutter-row-sequence-data-layers:sequence-data-expression'
    );
    expect(row.style.top).toBe('274px');
    expect(screen.queryByLabelText('Sample for Expression')).toBeNull();
    expect(within(row).queryByLabelText('Remove Expression')).toBeNull();
    fireEvent.click(within(row).getByLabelText('Show Expression'));
    expect(controls.onVisibilityChange).toHaveBeenCalledWith('expression', false);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['bam-a', 'bam-b']);
  });

  it('uses the native gear for retained samples, drawing styles and shared palette changes', () => {
    const controls = savedLayerControls();
    renderSavedLayers(controls);
    fireEvent.click(screen.getByLabelText('Open settings for Expression'));
    const original = controls.rows[0].presentation;
    fireEvent.change(screen.getByLabelText('Sample for Expression'), {
      target: { value: 'acetate' },
    });
    expect(controls.onPresentationChange).toHaveBeenLastCalledWith('expression', {
      ...original,
      sampleId: 'acetate',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Heatmap for Expression' }));
    expect(controls.onPresentationChange).toHaveBeenLastCalledWith('expression', {
      ...original,
      style: { ...original.style, geometry: 'band' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Points for Expression' }));
    expect(controls.onPresentationChange).toHaveBeenLastCalledWith('expression', {
      ...original,
      style: { ...original.style, geometry: 'points' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cividis palette for Expression' }));
    expect(controls.onPresentationChange).toHaveBeenLastCalledWith('expression', {
      ...original,
      style: {
        ...original.style,
        colorScale: {
          ...original.style.colorScale,
          colors: [...SCIENTIFIC_COLOR_PALETTES.cividis.colors],
        },
      },
    });
    fireEvent.click(screen.getByLabelText('Color annotations from Expression'));
    expect(controls.onPresentationChange).toHaveBeenLastCalledWith('expression', {
      ...original,
      annotationColors: false,
    });
    fireEvent.click(screen.getByLabelText('Show signal for Expression'));
    expect(controls.onPresentationChange).toHaveBeenLastCalledWith('expression', {
      ...original,
      signalVisible: false,
    });
  });

  it('keeps an unavailable saved layer discoverable with its actual mapping status', () => {
    const controls = savedLayerControls('The displayed annotations have changed.');
    renderSavedLayers(controls);
    expect(screen.getByRole('status')).toHaveTextContent('The displayed annotations have changed.');
    expect(screen.getByLabelText('Open settings for Expression')).toBeVisible();
    expect(controls.onPresentationChange).not.toHaveBeenCalled();
  });

  it('refreshes shared recent connections after renaming from an attached track', async () => {
    useLaneContractStore.getState().clearOwner(ASSEMBLY_ID);
    const alignment = sourcedPileup('bam-a', 'Tumor BAM', 75);
    alignment.source = {
      ...alignment.source!,
      remote: {
        sessionId: 'ssh-session',
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'hpc',
          target: 'lab-hpc',
          alignmentPath: '/cluster/tumor.bam',
          indexPath: '/cluster/tumor.bam.bai',
        },
        connection: {
          state: 'online',
          attempt: 0,
          transportGeneration: 1,
          lastFailure: null,
          updatedAt: 1,
        },
      },
    };
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, alignment);
    const refresh = vi.fn(async () => undefined);
    renderGutter(
      undefined,
      null,
      null,
      {},
      vi.fn(),
      {},
      vi.fn(),
      vi.fn(),
      [
        {
          endpointId: 'hpc',
          displayName: 'Lab cluster',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
      ],
      refresh
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    refresh.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Connection details for /u }));
    const details = within(screen.getByRole('dialog', { name: /^Connection details for /u }));
    fireEvent.click(details.getByRole('button', { name: 'Edit source…' }));
    fireEvent.click(details.getByRole('button', { name: 'Rename Lab cluster', exact: true }));
    fireEvent.change(details.getByRole('textbox', { name: 'Connection name' }), {
      target: { value: 'Reads archive' },
    });
    fireEvent.click(details.getByRole('button', { name: 'Save connection name', exact: true }));
    await waitFor(() =>
      expect(remoteProfileMocks.rename).toHaveBeenCalledWith('hpc', 'Reads archive')
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(useLaneContractStore.getState().lanesForOwner(ASSEMBLY_ID)[0].dataset).toEqual(
      alignment
    );
  });

  it('prefers the configured endpoint name and falls back to the saved OpenSSH target', () => {
    const locator = {
      contract: 'remote-alignment-locator.v1',
      endpointId: 'hpc',
      target: 'lab-hpc',
      alignmentPath: '/cluster/tumor.bam',
      indexPath: '/cluster/tumor.bam.bai',
    } as const;
    expect(remoteEndpointDisplayLabel(locator, [])).toBe('lab-hpc');
    expect(
      remoteEndpointDisplayLabel(locator, [
        {
          endpointId: 'hpc',
          displayName: 'Fred Hutch HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
      ])
    ).toBe('Fred Hutch HPC');
  });

  it('shows a retry only on the UCSC track whose streaming failed', () => {
    const trackId = 'ucsc:hg38-gc5BaseBw';
    const onRetryUcscTracks = vi.fn();
    useLaneContractStore
      .getState()
      .addLane(ASSEMBLY_ID, ASSEMBLY_ID, quantitative(trackId, 'GC Percent'));
    laneBands.current.dataBounds[trackId] = { topPx: 274, heightPx: 80 };

    renderGutter(undefined, null, null, { [trackId]: 'UCSC returned HTTP 599' }, onRetryUcscTracks);

    expect(screen.getByTestId(`ucsc-track-stream-error-${trackId}`)).toHaveTextContent(
      "Couldn't load: " + userMessage('sequence.failed')
    );
    expect(screen.queryByTestId('ucsc-track-stream-error-bam-a')).toBeNull();

    const details = screen.getByRole('button', {
      name: 'Show load failure details for GC Percent',
    });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    const reason = screen.getByRole('dialog', { name: 'Load failure details for GC Percent' });
    expect(reason).toHaveTextContent(userMessage('sequence.failed'));
    expect(within(reason).getByText(userMessage('sequence.failed'))).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(reason).not.toBeInTheDocument();
    expect(details).toHaveFocus();

    fireEvent.click(screen.getByLabelText('Retry GC Percent'));
    expect(onRetryUcscTracks).toHaveBeenCalledOnce();
  });

  it('shows transient recovery without asking for a manual Retry', () => {
    const trackId = 'ucsc:hg38-gc5BaseBw';
    useLaneContractStore
      .getState()
      .addLane(ASSEMBLY_ID, ASSEMBLY_ID, quantitative(trackId, 'GC Percent'));
    laneBands.current.dataBounds[trackId] = { topPx: 274, heightPx: 80 };

    renderGutter(undefined, null, null, { [trackId]: UCSC_TRACK_RECOVERING_STATUS });

    expect(screen.getByTestId(`ucsc-track-stream-recovering-${trackId}`)).toHaveTextContent(
      'Reconnecting'
    );
    expect(screen.queryByLabelText('Retry GC Percent')).toBeNull();
  });

  it('shows blocked and valid-empty BAM states from the shared lifecycle snapshot', () => {
    useLaneContractStore.getState().clearOwner(ASSEMBLY_ID);
    useLaneContractStore
      .getState()
      .addLane(ASSEMBLY_ID, ASSEMBLY_ID, sourcedPileup('bam-a', 'Tumor BAM', 75));
    useLaneContractStore
      .getState()
      .addLane(ASSEMBLY_ID, ASSEMBLY_ID, sourcedPileup('bam-b', 'Normal BAM', 200));
    const onRetryPileupTrack = vi.fn();
    const onRepairPileupTrack = vi.fn();

    renderGutter(
      undefined,
      null,
      null,
      {},
      vi.fn(),
      {
        'bam-a': {
          phase: 'blocked',
          message: 'The aligned-read source needs attention.',
          action: 'repair',
          hasLastGood: false,
        },
        'bam-b': { phase: 'ready', kind: 'empty' },
      },
      onRetryPileupTrack,
      onRepairPileupTrack
    );

    expect(screen.getByTestId('aligned-read-gutter-status-bam-a')).toHaveTextContent(
      'The aligned-read source needs attention.'
    );
    expect(screen.getByTestId('aligned-read-gutter-status-bam-b')).toHaveTextContent(
      'No reads here'
    );
    expect(screen.getByTestId(`track-gutter-row-${ASSEMBLY_ID}:bam-a`).innerHTML).toContain(
      'bg-danger'
    );
    fireEvent.click(screen.getByLabelText('Repair Tumor BAM'));
    expect(onRepairPileupTrack).toHaveBeenCalledWith('bam-a');
    expect(onRetryPileupTrack).not.toHaveBeenCalled();
  });

  it('shows the backing endpoint name on a visible hybrid when both source lanes are hidden', async () => {
    useLaneContractStore.getState().clearOwner(ASSEMBLY_ID);
    const alignment = sourcedPileup('bam-a', 'Tumor BAM', 75);
    alignment.source = {
      ...alignment.source!,
      remote: {
        sessionId: 'ssh-session',
        locator: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'hpc',
          target: 'lab-hpc',
          alignmentPath: '/cluster/tumor.bam',
          indexPath: '/cluster/tumor.bam.bai',
        },
      },
    };
    const signal = quantitative('bigwig-a', 'Tumor BigWig');
    const hybrid: ActiveStressDataset = {
      ...pileup('hybrid-a', 'Tumor BAM · BigWig → reads', 75),
      experimentalHybrid: {
        alignmentTrackId: alignment.trackId,
        quantitativeTrackId: signal.trackId,
      },
    };
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, alignment, false);
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, signal, false);
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, hybrid, true);
    laneBands.current.dataBounds['hybrid-a'] = { topPx: 114, heightPx: 80 };
    const onRetryPileupTrack = vi.fn();
    const onRetryUcscTracks = vi.fn();

    const rendered = renderGutter(
      undefined,
      null,
      null,
      { 'bigwig-a': 'Remote BigWig range request failed' },
      onRetryUcscTracks,
      {
        'bam-a': { phase: 'stalled', hasLastGood: true, elapsedMs: 5_000 },
      },
      onRetryPileupTrack,
      vi.fn(),
      [
        {
          endpointId: 'hpc',
          displayName: 'Fred Hutch HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
      ]
    );

    const alignedStatus = screen.getByTestId('aligned-read-gutter-status-hybrid-a');
    expect(alignedStatus).toHaveTextContent('Fred Hutch HPC slow — still waiting');
    expect(alignedStatus).not.toHaveTextContent('SSH');
    expect(
      screen.queryByLabelText('Hybrid loading animation for Tumor BAM · BigWig → reads')
    ).not.toBeInTheDocument();
    await waitFor(() => expect(rendered.refreshRemoteEndpoints).toHaveBeenCalledOnce());
    fireEvent.click(within(alignedStatus).getByRole('button', { name: /Retry/ }));
    expect(onRetryPileupTrack).toHaveBeenCalledWith('bam-a');
    const signalError = screen.getByTestId('ucsc-track-stream-error-hybrid-a');
    expect(signalError).toHaveTextContent("Couldn't load: " + userMessage('sequence.failed'));
    fireEvent.click(within(signalError).getByRole('button', { name: /Retry/ }));
    expect(onRetryUcscTracks).toHaveBeenCalledOnce();
  });

  it('shows a reconnecting endpoint on the hybrid even while cached reads remain ready', async () => {
    useLaneContractStore.getState().clearOwner(ASSEMBLY_ID);
    const alignment = sourcedPileup('bam-a', 'Tumor BAM', 75);
    const locator = {
      contract: 'remote-alignment-locator.v1' as const,
      endpointId: 'hpc',
      target: 'lab-hpc',
      alignmentPath: '/cluster/tumor.bam',
      indexPath: '/cluster/tumor.bam.bai',
    };
    const connection = {
      state: 'retrying' as const,
      attempt: 1,
      transportGeneration: 2,
      lastFailure: null,
      updatedAt: 2,
    };
    alignment.source = {
      ...alignment.source!,
      remote: { locator, sessionId: 'ssh-session', connection },
    };
    const hybrid: ActiveStressDataset = {
      ...pileup('hybrid-a', 'Tumor BAM · BigWig → reads', 75),
      experimentalHybrid: {
        alignmentTrackId: alignment.trackId,
        quantitativeTrackId: 'bigwig-a',
      },
    };
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, alignment, false);
    useLaneContractStore
      .getState()
      .addLane(ASSEMBLY_ID, ASSEMBLY_ID, quantitative('bigwig-a', 'Tumor BigWig'), false);
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, hybrid, true);
    laneBands.current.dataBounds['hybrid-a'] = { topPx: 114, heightPx: 80 };
    const onRetryPileupTrack = vi.fn();
    renderGutter(
      undefined,
      null,
      null,
      {},
      vi.fn(),
      { 'bam-a': { phase: 'ready', kind: 'reads' } },
      onRetryPileupTrack,
      vi.fn(),
      [
        {
          endpointId: 'hpc',
          displayName: 'Fred Hutch HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
      ]
    );
    const gutter = screen.getByTestId('aligned-read-gutter-status-hybrid-a');
    expect(gutter).toHaveAttribute('data-status-phase', 'recovering');
    expect(gutter).toHaveTextContent('Reconnecting Fred Hutch HPC…');
    fireEvent.click(within(gutter).getByRole('button', { name: /Retry/ }));
    expect(onRetryPileupTrack).toHaveBeenCalledWith('bam-a');

    act(() => {
      useLaneContractStore.getState().replaceLaneDataset(ASSEMBLY_ID, 'bam-a', ASSEMBLY_ID, {
        ...alignment,
        source: {
          ...alignment.source!,
          remote: {
            locator,
            sessionId: 'ssh-session',
            connection: { ...connection, state: 'online', attempt: 0, transportGeneration: 3 },
          },
        },
      });
    });
    await waitFor(() => expect(gutter).toHaveAttribute('data-status-phase', 'ready'));
    expect(gutter).toHaveTextContent('Fred Hutch HPC live • reads');
  });

  it('offers an explicit promotion action without marking a temporary track visible', () => {
    const onShowTrack = vi.fn();
    renderGutter(undefined, { trackId: 'lncRNA', onShowTrack });

    expect(screen.getByText('Selected annotation from hidden lncRNA track')).toBeVisible();
    expect(screen.getByLabelText('Show lncRNA track')).toBeVisible();
    expect(screen.queryByLabelText('Hide lncRNA')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show lncRNA track'));

    expect(onShowTrack).toHaveBeenCalledOnce();
  });

  it('surfaces one temporary search lane and makes persistence explicit', () => {
    const onKeepAdditionalLane = vi.fn();
    laneBands.current.annotationSearchFocusPresentation = {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-mRNA-hit',
      lane: 2,
    };
    renderGutter(undefined, null, {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-mRNA-hit',
      onKeepAdditionalLane,
    });

    expect(screen.getByText('mRNA selected in temporary search lane')).toBeVisible();
    fireEvent.click(screen.getByLabelText('Raise mRNA lane limit by one'));

    expect(onKeepAdditionalLane).toHaveBeenCalledOnce();
  });

  it('does not fabricate a temporary search row before the renderer presents one', () => {
    renderGutter(undefined, null, {
      trackId: 'mRNA',
      canonicalIdentity: 'canonical-mRNA-hit',
      onKeepAdditionalLane: vi.fn(),
    });

    expect(screen.queryByTestId('track-gutter-visible-annotation-search-focus')).toBeNull();
  });

  it('rejects a stale renderer receipt for another result in the same track', () => {
    laneBands.current.annotationSearchFocusPresentation = {
      trackId: 'mRNA',
      canonicalIdentity: 'previous-canonical-mRNA-hit',
      lane: 2,
    };
    renderGutter(undefined, null, {
      trackId: 'mRNA',
      canonicalIdentity: 'next-canonical-mRNA-hit',
      onKeepAdditionalLane: vi.fn(),
    });

    expect(screen.queryByTestId('track-gutter-visible-annotation-search-focus')).toBeNull();
    expect(screen.queryByLabelText('Raise mRNA lane limit by one')).toBeNull();
  });

  it('preserves the last presented scroll through gutter collapse', () => {
    renderGutter();
    const before = screen.getByTestId('track-gutter-scroll-layer');
    expect(before.style.transform).toBe('translate3d(0, -40px, 0)');

    act(() => useTrackGutterLayoutStore.getState().toggleCollapsed(ASSEMBLY_ID));

    const after = screen.getByTestId('track-gutter-scroll-layer');
    expect(after.style.transform).toBe('translate3d(0, -40px, 0)');
    act(() => useTrackGutterLayoutStore.getState().toggleCollapsed(ASSEMBLY_ID));
  });

  it('live-resizes one track from its divider and records the gesture as one undoable change', () => {
    useLaneContractStore.getState().clearOwnerHistory(ASSEMBLY_ID);
    renderGutter();

    const handle = screen.getByRole('separator', { name: 'Resize Tumor BAM track height' });
    firePointerAt('down', handle, 194, 17);
    firePointerAt('move', document, 226, 17);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'bam-a')?.dataset.trackPx
    ).toBe(112);
    expect(useLaneContractStore.getState().canUndoLaneChange(ASSEMBLY_ID)).toBe(false);

    firePointerAt('up', document, 226, 17);
    expect(useLaneContractStore.getState().canUndoLaneChange(ASSEMBLY_ID)).toBe(true);
    fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));
    expect(screen.getByLabelText('Track height for Tumor BAM')).toHaveValue(112);

    act(() => {
      expect(useLaneContractStore.getState().undoLaneChange(ASSEMBLY_ID)).toBe(true);
    });
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'bam-a')?.dataset.trackPx
    ).toBe(80);
    expect(useLaneContractStore.getState().canUndoLaneChange(ASSEMBLY_ID)).toBe(false);
  });

  it('owns Reference policy controls and independent per-BAM height cutoffs', () => {
    vi.useFakeTimers();
    renderGutter();
    act(() => vi.advanceTimersByTime(250));

    const referenceRow = screen.getByTestId('track-gutter-row-lane:reference');
    expect(referenceRow).toContainElement(screen.getByTestId('reference-track-controls'));
    expect(screen.getByLabelText('Max lanes')).toHaveValue('12');

    const tumorScale = { min: 1, auto: 100, max: 1_000 };
    const normalScale = { min: 1, auto: 200, max: 2_000 };
    fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));
    let tumorCutoff = screen.getByTestId('coverage-cutoff-range-bam-a');
    expect(tumorCutoff).toHaveValue(String(coverageDepthToSliderPosition(75, tumorScale)));
    fireEvent.click(screen.getByLabelText('Open settings for Normal BAM'));
    const normalCutoff = screen.getByTestId('coverage-cutoff-range-bam-b');
    expect(normalCutoff).toHaveValue(String(coverageDepthToSliderPosition(200, normalScale)));
    fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));
    tumorCutoff = screen.getByTestId('coverage-cutoff-range-bam-a');
    expect(tumorCutoff.className).toContain('accent-emerald-600');

    fireEvent.change(tumorCutoff, { target: { value: '700' } });

    const lanes = useLaneContractStore.getState().lanesForOwner(ASSEMBLY_ID);
    expect(
      lanes.find((lane) => lane.dataset.trackId === 'bam-a')?.dataset.coverageCutoffDepth
    ).toBe(coverageSliderPositionToDepth(700, tumorScale));
    expect(
      lanes.find((lane) => lane.dataset.trackId === 'bam-b')?.dataset.coverageCutoffDepth
    ).toBe(200);
    vi.useRealTimers();
  });

  it('does not report a presentation update failure after changing the coverage cutoff', () => {
    renderGutter();
    fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));

    fireEvent.click(
      screen.getByRole('button', { name: 'Use automatic coverage cutoff for Tumor BAM' })
    );

    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'bam-a')?.dataset.coverageCutoffDepth
    ).toBe(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['missing', 'invalid'] as const)(
    'shows a refused %s presentation update and clears it after the next successful edit',
    (status) => {
      const update = vi
        .spyOn(useLaneContractStore.getState(), 'updateLanePresentation')
        .mockReturnValueOnce({ status, message: 'Presentation update refused.' });
      try {
        renderGutter();
        fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));
        const automatic = screen.getByRole('button', {
          name: 'Use automatic coverage cutoff for Tumor BAM',
        });

        fireEvent.click(automatic);

        expect(screen.getByRole('alert')).toBeVisible();
        expect(
          useLaneContractStore
            .getState()
            .lanesForOwner(ASSEMBLY_ID)
            .find((lane) => lane.dataset.trackId === 'bam-a')?.dataset.coverageCutoffDepth
        ).toBe(75);

        fireEvent.click(automatic);

        expect(
          useLaneContractStore
            .getState()
            .lanesForOwner(ASSEMBLY_ID)
            .find((lane) => lane.dataset.trackId === 'bam-a')?.dataset.coverageCutoffDepth
        ).toBe(0);
        expect(screen.queryByRole('alert')).toBeNull();
      } finally {
        update.mockRestore();
      }
    }
  );

  it('offers the established track swatches and applies a preset without replacing read data', () => {
    const before = useLaneContractStore
      .getState()
      .lanesForOwner(ASSEMBLY_ID)
      .find((lane) => lane.dataset.trackId === 'bam-a')!.dataset;
    renderGutter();

    fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));
    fireEvent.click(screen.getByLabelText('Light read color for Tumor BAM'));
    const picker = screen.getByRole('dialog', { name: 'Light read color picker for Tumor BAM' });
    expect(
      within(picker)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'Use #3b82f6',
      'Use #2563eb',
      'Use #8b5cf6',
      'Use #7c3aed',
      'Use #d97706',
      'Use #f59e0b',
      'Use #16a34a',
      'Use #0891b2',
      'Use #e11d48',
      'Use #64748b',
      'Use #111827',
      'Use #f8fafc',
    ]);

    fireEvent.click(within(picker).getByRole('button', { name: 'Use #7c3aed' }));
    const after = useLaneContractStore
      .getState()
      .lanesForOwner(ASSEMBLY_ID)
      .find((lane) => lane.dataset.trackId === 'bam-a')!.dataset;
    expect(after.color).toBe(0x7c3aed);
    expect(after.records).toBe(before.records);
    expect(after.source).toBe(before.source);
    expect(
      screen.queryByRole('dialog', { name: 'Light read color picker for Tumor BAM' })
    ).toBeNull();
  });

  it('edits an exact light-mode pileup read color without replacing the track data', () => {
    const before = useLaneContractStore
      .getState()
      .lanesForOwner(ASSEMBLY_ID)
      .find((lane) => lane.dataset.trackId === 'bam-a')!.dataset;
    renderGutter();

    fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));
    const picker = screen.getByLabelText('Light read color for Tumor BAM');
    fireEvent.click(picker);
    const hex = screen.getByLabelText('Light read hex color for Tumor BAM');
    expect(picker).toHaveAttribute('data-color', '#2563eb');
    expect(hex).toHaveValue('#2563eb');

    fireEvent.change(hex, { target: { value: '#35c9a4' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    const after = useLaneContractStore
      .getState()
      .lanesForOwner(ASSEMBLY_ID)
      .find((lane) => lane.dataset.trackId === 'bam-a')!.dataset;
    expect(after.color).toBe(0x35c9a4);
    expect(after.records).toBe(before.records);
    expect(after.coverageCutoffDepth).toBe(before.coverageCutoffDepth);
  });

  it('resets every BAM appearance control in one undoable change', () => {
    const store = useLaneContractStore.getState();
    store.updateLanePresentation(ASSEMBLY_ID, 'bam-a', {
      color: 0xe11d48,
      heightPx: 144,
      rowHeightPx: 12,
      maxRows: 33,
      coverageCutoffDepth: 500,
    });
    renderGutter();

    fireEvent.click(screen.getByLabelText('Open settings for Tumor BAM'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'bam-a')?.dataset
    ).toMatchObject({
      color: 0xa8ceff,
      trackPx: 276,
      laneHeightPx: 3,
      maxLanes: 80,
      coverageCutoffDepth: 0,
    });
    let didUndo = false;
    act(() => {
      didUndo = useLaneContractStore.getState().undoLaneChange(ASSEMBLY_ID);
    });
    expect(didUndo).toBe(true);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'bam-a')?.dataset
    ).toMatchObject({
      color: 0xe11d48,
      trackPx: 144,
      laneHeightPx: 12,
      maxLanes: 33,
      coverageCutoffDepth: 500,
    });
  });

  it('recolors one quantitative track from its gutter control and preserves its data', () => {
    const records = [{ chrom: 'chr1', start: 0, end: 5, value: 42 }];
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, {
      trackType: 'quantitative',
      trackId: 'ucsc:hg38-gc5BaseBw',
      label: 'GC Percent',
      color: 0x2563eb,
      trackPx: 80,
      records,
      kind: 'annotation',
    });
    laneBands.current = {
      ...laneBands.current,
      dataBounds: {
        ...laneBands.current.dataBounds,
        'ucsc:hg38-gc5BaseBw': { topPx: 274, heightPx: 80 },
      },
    };
    renderGutter();

    fireEvent.click(screen.getByLabelText('Open settings for GC Percent'));
    const picker = screen.getByLabelText('Color for GC Percent');
    expect(picker).toHaveAttribute('data-color', '#2563eb');
    fireEvent.click(picker);
    const hex = screen.getByLabelText('Hex color for GC Percent');
    fireEvent.change(hex, { target: { value: '#e11d48' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Color picker for GC Percent' })).toBeNull();

    const lane = useLaneContractStore
      .getState()
      .lanesForOwner(ASSEMBLY_ID)
      .find((candidate) => candidate.dataset.trackId === 'ucsc:hg38-gc5BaseBw');
    expect(lane?.dataset.color).toBe(0xe11d48);
    expect(lane?.dataset.records).toBe(records);
  });

  it('does not offer a color control when the registered renderer cannot apply it', () => {
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, {
      trackType: 'imported-transcript',
      trackId: 'ucsc:hg38-knownGene',
      label: 'MANE Select',
      color: 0x2563eb,
      trackPx: 80,
      records: [],
      kind: 'annotation',
    });
    renderGutter();

    fireEvent.click(screen.getByLabelText('Open settings for MANE Select'));
    expect(screen.queryByLabelText('Color for MANE Select')).not.toBeInTheDocument();
  });

  it('expands complete quantitative settings and commits scale and height changes', () => {
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, {
      trackType: 'quantitative',
      trackId: 'signal-settings',
      label: 'RNA signal',
      color: 0x3b82f6,
      trackPx: 96,
      records: [],
      kind: 'annotation',
      quantitativeSourceSummary: {
        contract: 'dnaforge.quantitative-source-summary.v1',
        algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
        targetSampleCount: 65_536,
        sampleCount: 1_000,
        lowerQuantile: 0.005,
        upperQuantile: 0.995,
        robustMin: 0,
        robustMax: 12,
        fullMin: 0,
        fullMax: 10_000,
        missingData: 'excluded',
      },
    });
    laneBands.current.dataBounds['signal-settings'] = { topPx: 274, heightPx: 96 };
    renderGutter();

    fireEvent.click(screen.getByLabelText('Open settings for RNA signal'));
    expect(screen.getByTestId(`track-settings-form-signal-settings`)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Heatmap for RNA signal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cividis palette for RNA signal' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'signal-settings')?.dataset
        .quantitativePresentation
    ).toMatchObject({ graph: 'band', palette: 'cividis' });
    expect(screen.queryByTestId('quantitative-range-summary-signal-settings')).toBeNull();
    expect(screen.queryByText(/Values outside the chosen range/)).toBeNull();
    fireEvent.change(screen.getByTestId('quantitative-scale-mode-signal-settings'), {
      target: { value: 'full-global' },
    });
    fireEvent.change(screen.getByTestId('quantitative-scale-transform-signal-settings'), {
      target: { value: 'log1p' },
    });
    const smoothing = screen.getByTestId('quantitative-smoothing-signal-settings');
    expect(smoothing).toHaveAttribute('type', 'range');
    expect(smoothing).toHaveAttribute('max', '10');
    expect(smoothing).toHaveAttribute('step', '0.5');
    expect(smoothing).toHaveValue('1');
    fireEvent.change(smoothing, {
      target: { value: '7.5' },
    });
    fireEvent.pointerUp(smoothing);
    fireEvent.change(screen.getByTestId('track-height-signal-settings'), {
      target: { value: '140' },
    });
    fireEvent.blur(screen.getByTestId('track-height-signal-settings'));

    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'signal-settings')?.dataset
    ).toMatchObject({
      trackPx: 140,
      quantitativePresentation: {
        smoothingSigmaBins: 7.5,
        scale: { mode: 'full-global', transform: 'log1p' },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'signal-settings')?.dataset
    ).toMatchObject({
      color: 0x3b82f6,
      trackPx: 96,
      quantitativePresentation: {
        smoothingSigmaBins: 1,
        showRange: true,
        scale: { mode: 'robust-global', transform: 'linear' },
      },
    });
  });

  it('provides compact number steppers, an unclipped fixed range, and a dismissible color editor', () => {
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, {
      trackType: 'quantitative',
      trackId: 'adjustable-signal',
      label: 'Adjustable signal',
      color: 0x3b82f6,
      trackPx: 96,
      records: [],
      kind: 'annotation',
      quantitativePresentation: {
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothingSigmaBins: 0,
        scale: { mode: 'fixed', transform: 'linear', min: 0, max: 15.2 },
      },
    });
    laneBands.current.dataBounds['adjustable-signal'] = { topPx: 274, heightPx: 96 };
    renderGutter();

    fireEvent.click(screen.getByLabelText('Open settings for Adjustable signal'));
    const panel = screen.getByRole('region', { name: 'Settings for Adjustable signal' });
    expect(panel).toHaveStyle({ minWidth: '244px' });
    expect(screen.getByTestId('quantitative-scale-mode-adjustable-signal')).toHaveValue('fixed');

    fireEvent.click(
      screen.getByRole('button', { name: 'Increase track height for Adjustable signal' })
    );
    expect(screen.getByLabelText('Track height for Adjustable signal')).toHaveValue(97);
    expect(
      screen.getByRole('separator', { name: 'Resize Adjustable signal track height' })
    ).toHaveAttribute('aria-valuenow', '97');
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'adjustable-signal')?.dataset.trackPx
    ).toBe(97);
    fireEvent.click(
      screen.getByRole('button', { name: 'Decrease track height for Adjustable signal' })
    );
    expect(screen.getByLabelText('Track height for Adjustable signal')).toHaveValue(96);
    expect(
      screen.getByRole('separator', { name: 'Resize Adjustable signal track height' })
    ).toHaveAttribute('aria-valuenow', '96');

    const colorControl = screen.getByRole('button', { name: 'Color for Adjustable signal' });
    fireEvent.click(colorControl);
    expect(
      screen.getByRole('dialog', { name: 'Color picker for Adjustable signal' })
    ).toBeVisible();
    fireEvent.pointerDown(screen.getByLabelText('Track height for Adjustable signal'));
    expect(screen.queryByRole('dialog', { name: 'Color picker for Adjustable signal' })).toBeNull();
    expect(panel).toBeVisible();

    fireEvent.click(colorControl);
    const hex = screen.getByLabelText('Hex color for Adjustable signal');
    fireEvent.change(hex, { target: { value: '#e11d48' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Color picker for Adjustable signal' })).toBeNull();
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'adjustable-signal')?.dataset.color
    ).toBe(0xe11d48);
  });

  it('keeps quantitative y-axes out of the settings gutter', () => {
    useLaneContractStore.getState().addLane(ASSEMBLY_ID, ASSEMBLY_ID, {
      trackType: 'quantitative',
      trackId: 'axis-signal',
      label: 'Axis signal',
      color: 0x3b82f6,
      trackPx: 96,
      records: [],
      kind: 'annotation',
      quantitativePresentation: {
        version: 1,
        graph: 'bar',
        showRange: true,
        scale: { mode: 'full-global', transform: 'log1p' },
      },
      quantitativeSourceSummary: {
        contract: 'dnaforge.quantitative-source-summary.v1',
        algorithm: 'equal-genomic-bin-means-r7-quantiles-v1',
        targetSampleCount: 65_536,
        sampleCount: 1_000,
        lowerQuantile: 0.005,
        upperQuantile: 0.995,
        robustMin: 0,
        robustMax: 12,
        fullMin: 0,
        fullMax: 99,
        missingData: 'excluded',
      },
    });
    laneBands.current.dataBounds['axis-signal'] = { topPx: 274, heightPx: 96 };
    renderGutter();

    expect(screen.queryByTestId('quantitative-y-axis-axis-signal')).toBeNull();
  });

  it('opens the picker on the catalog, with every other route named beside it', () => {
    renderGutter();

    fireEvent.click(screen.getByTestId('track-gutter-add'));

    expect(screen.getByRole('dialog', { name: 'Add data' })).toBeVisible();
    expect(screen.queryAllByRole('tab')).toHaveLength(6);
    expect(screen.getByLabelText('Search public genomic data')).toBeVisible();
    expect(screen.getByTestId('add-data-files-tab')).toBeVisible();
    expect(screen.getByTestId('add-track-link-toggle')).toBeVisible();
    expect(screen.getByTestId('add-track-hubs-toggle')).toBeVisible();
  });

  it('lets a person compose an admitted BigWig and read track into one durable handoff lane', async () => {
    useLaneContractStore.getState().clearOwner(ASSEMBLY_ID);
    useLaneContractStore
      .getState()
      .addLane(ASSEMBLY_ID, ASSEMBLY_ID, sourcedPileup('reads-a', 'ATAC reads', 80), true);
    useLaneContractStore
      .getState()
      .addLane(
        ASSEMBLY_ID,
        ASSEMBLY_ID,
        quantitative('signal-a', 'ATAC BigWig'),
        true,
        admittedBigWig('ATAC BigWig')
      );
    renderGutter();

    fireEvent.click(screen.getByTestId('track-gutter-add'));
    await waitFor(() =>
      expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true')
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Signal + reads' }));
    await waitFor(() => expect(screen.getByTestId('add-track-combine-panel')).toBeVisible());
    fireEvent.change(screen.getByLabelText(/Combined view label/), {
      target: { value: 'ATAC accessibility + reads' },
    });
    fireEvent.click(screen.getByLabelText('Keep the source tracks visible'));
    fireEvent.click(screen.getByRole('button', { name: 'Create combined view' }));

    await waitFor(() =>
      expect(screen.getByTestId('signal-read-compose-notice')).toHaveTextContent(
        'Combined view created'
      )
    );
    const lanes = useLaneContractStore.getState().lanesForOwner(ASSEMBLY_ID);
    expect(lanes).toHaveLength(3);
    expect(lanes.find((lane) => lane.dataset.trackId === 'reads-a')?.visible).toBe(false);
    expect(lanes.find((lane) => lane.dataset.trackId === 'signal-a')?.visible).toBe(false);
    expect(lanes.at(-1)).toMatchObject({
      visible: true,
      dataset: {
        label: 'ATAC accessibility + reads',
        kind: 'pileup',
        experimentalHybrid: {
          alignmentTrackId: 'reads-a',
          quantitativeTrackId: 'signal-a',
          loadingAnimation: 'diagonal-scan',
        },
      },
    });

    fireEvent.click(screen.getByLabelText('Close data picker'));
    fireEvent.click(screen.getByLabelText('Remove ATAC BigWig'));
    expect(useConfirmDialogStore.getState().request?.message).toBe(
      'Remove “ATAC BigWig” and 1 combined view that depends on it?'
    );
    act(() => useConfirmDialogStore.getState().resolveCurrent(true));
    await waitFor(() =>
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner(ASSEMBLY_ID)
          .map((lane) => lane.dataset.trackId)
      ).toEqual(['reads-a'])
    );
  });

  it('reopens mutations from the gutter and closes Add data after a remote VCF attaches', async () => {
    const { onAddVariantTrackRequest, onOpenMutationNavigator } = renderGutter();

    fireEvent.click(screen.getByTestId('open-mutation-navigator'));
    expect(onOpenMutationNavigator).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId('track-gutter-add'));
    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'vcf' } });
    fireEvent.change(screen.getByLabelText('Indexed track URL'), {
      target: { value: 'https://variants.example.org/tumor.vcf.gz' },
    });
    fireEvent.change(screen.getByLabelText('Variant index URL'), {
      target: { value: 'https://variants.example.org/tumor.vcf.gz.tbi' },
    });
    fireEvent.change(screen.getByLabelText(/Track label/), {
      target: { value: 'Tumor calls' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() =>
      expect(onAddVariantTrackRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          assemblyId: ASSEMBLY_ID,
          contract: 'dnaforge.track-admission-request.v1',
          formatId: 'vcf',
          scientificKind: 'variants',
          ingress: { kind: 'url' },
          source: { kind: 'http', url: 'https://variants.example.org/tumor.vcf.gz' },
          index: { kind: 'http', url: 'https://variants.example.org/tumor.vcf.gz.tbi' },
          label: 'Tumor calls',
        })
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add data' })).not.toBeInTheDocument()
    );
  });

  it('routes htsget BAM and VCF through the shared durable admission request', async () => {
    const { addBamRequests, onAddVariantTrackRequest } = renderGutter();

    fireEvent.click(screen.getByTestId('track-gutter-add'));
    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Source protocol'), {
      target: { value: 'htsget' },
    });
    fireEvent.change(screen.getByLabelText('htsget service endpoint'), {
      target: { value: 'https://htsget.example.org' },
    });
    fireEvent.change(screen.getByLabelText('htsget resource ID'), {
      target: { value: 'tumor-reads' },
    });
    const credentialSelect = document.querySelector('#source-credential-mode')!;
    fireEvent.change(credentialSelect, {
      target: { value: 'saved' },
    });
    expect(credentialSelect).toHaveValue('saved');
    expect(credentialSelect.closest('fieldset')).toHaveAttribute('data-credential-mode', 'saved');
    fireEvent.change(await screen.findByLabelText(/Credential reference/), {
      target: { value: 'credential:htsget-lab' },
    });
    fireEvent.change(screen.getByLabelText(/Track label/), {
      target: { value: 'Tumor reads' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() =>
      expect(addBamRequests).toHaveBeenCalledWith([
        expect.objectContaining({
          contract: 'dnaforge.track-admission-request.v1',
          assemblyId: ASSEMBLY_ID,
          source: {
            kind: 'htsget',
            endpoint: 'https://htsget.example.org',
            resourceId: 'tumor-reads',
            dataClass: 'reads',
            format: 'BAM',
            authRef: 'credential:htsget-lab',
          },
          formatId: 'bam',
          scientificKind: 'reads',
          ingress: { kind: 'url' },
          label: 'Tumor reads',
        }),
      ])
    );

    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'vcf' } });
    fireEvent.change(screen.getByLabelText('htsget resource ID'), {
      target: { value: 'tumor-calls' },
    });
    fireEvent.change(screen.getByLabelText(/Track label/), {
      target: { value: 'Tumor calls' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() =>
      expect(onAddVariantTrackRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          source: {
            kind: 'htsget',
            endpoint: 'https://htsget.example.org',
            resourceId: 'tumor-calls',
            dataClass: 'variants',
            format: 'VCF',
            authRef: 'credential:htsget-lab',
          },
          formatId: 'vcf',
          scientificKind: 'variants',
          label: 'Tumor calls',
        })
      )
    );
    expect(credentialMocks.save).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add data' })).not.toBeInTheDocument()
    );
  });

  it('saves AWS keys outside the request and routes requester-pays S3 BAM through admission', async () => {
    const { addBamRequests } = renderGutter();
    const canary = 'INERT_UI_AWS_SECRET_CANARY_123456';

    fireEvent.click(screen.getByTestId('track-gutter-add'));
    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Source protocol'), { target: { value: 's3' } });
    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'bam' } });
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'research-data' } });
    fireEvent.change(screen.getByLabelText(/AWS region/), { target: { value: 'us-west-2' } });
    fireEvent.click(screen.getByLabelText('Requester-pays bucket'));
    fireEvent.change(screen.getByLabelText('Object key'), {
      target: { value: 'cohort/tumor.bam' },
    });
    fireEvent.change(screen.getByLabelText('Alignment index object key'), {
      target: { value: 'cohort/tumor.bam.bai' },
    });
    fireEvent.change(document.querySelector('#source-credential-mode')!, {
      target: { value: 'aws-sigv4' },
    });
    fireEvent.change(await screen.findByLabelText(/Credential reference/), {
      target: { value: 'credential:aws-research' },
    });
    fireEvent.change(await screen.findByLabelText('AWS access key ID'), {
      target: { value: 'TESTACCESSKEY1234' },
    });
    fireEvent.change(screen.getByLabelText('AWS secret access key'), {
      target: { value: canary },
    });
    fireEvent.change(screen.getByLabelText('AWS session token (optional)'), {
      target: { value: `session-${canary}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() => expect(credentialMocks.save).toHaveBeenCalledOnce());
    expect(credentialMocks.save).toHaveBeenCalledWith({
      contract: 'dnaforge.genome-source-credential.v1',
      authRef: 'credential:aws-research',
      kind: 'aws-sigv4',
      accessKeyId: 'TESTACCESSKEY1234',
      secretAccessKey: canary,
      sessionToken: `session-${canary}`,
    });
    await waitFor(() => expect(addBamRequests).toHaveBeenCalledOnce());
    const request = addBamRequests.mock.calls[0]?.[0]?.[0];
    expect(request).toMatchObject({
      contract: 'dnaforge.track-admission-request.v1',
      assemblyId: ASSEMBLY_ID,
      formatId: 'bam',
      scientificKind: 'reads',
      ingress: { kind: 'cloud' },
      source: {
        kind: 's3',
        bucket: 'research-data',
        key: 'cohort/tumor.bam',
        region: 'us-west-2',
        requesterPays: true,
        authRef: 'credential:aws-research',
      },
      index: {
        kind: 's3',
        bucket: 'research-data',
        key: 'cohort/tumor.bam.bai',
        region: 'us-west-2',
        requesterPays: true,
        authRef: 'credential:aws-research',
      },
    });
    expect(JSON.stringify(request)).not.toContain(canary);
  });

  it('keeps a GCS OAuth token out of a billed cloud VCF request', async () => {
    const { onAddVariantTrackRequest } = renderGutter();
    const canary = 'INERT_UI_GCS_TOKEN_CANARY_987654';

    fireEvent.click(screen.getByTestId('track-gutter-add'));
    fireEvent.click(screen.getByTestId('add-track-link-toggle'));
    fireEvent.change(screen.getByLabelText('Source protocol'), { target: { value: 'gcs' } });
    fireEvent.change(screen.getByLabelText('Indexed format'), { target: { value: 'vcf' } });
    fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'research-data' } });
    fireEvent.change(screen.getByLabelText(/Billing project/), {
      target: { value: 'genomics-billing' },
    });
    fireEvent.change(screen.getByLabelText('Object key'), {
      target: { value: 'cohort/tumor.vcf.gz' },
    });
    fireEvent.change(screen.getByLabelText('Variant index object key'), {
      target: { value: 'cohort/tumor.vcf.gz.tbi' },
    });
    fireEvent.change(document.querySelector('#source-credential-mode')!, {
      target: { value: 'gcs-oauth' },
    });
    fireEvent.change(await screen.findByLabelText(/Credential reference/), {
      target: { value: 'credential:gcs-research' },
    });
    fireEvent.change(await screen.findByLabelText('GCS OAuth access token'), {
      target: { value: canary },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));

    await waitFor(() => expect(onAddVariantTrackRequest).toHaveBeenCalledOnce());
    const request = onAddVariantTrackRequest.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      formatId: 'vcf',
      scientificKind: 'variants',
      ingress: { kind: 'cloud' },
      source: {
        kind: 'gcs',
        bucket: 'research-data',
        object: 'cohort/tumor.vcf.gz',
        billingProject: 'genomics-billing',
        authRef: 'credential:gcs-research',
      },
      index: {
        kind: 'gcs',
        bucket: 'research-data',
        object: 'cohort/tumor.vcf.gz.tbi',
        billingProject: 'genomics-billing',
        authRef: 'credential:gcs-research',
      },
    });
    expect(credentialMocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'gcs-oauth', accessToken: canary })
    );
    expect(JSON.stringify(request)).not.toContain(canary);
  });

  it('adds a native CpG interval through the real admission and lane path', async () => {
    renderGutter();

    fireEvent.click(screen.getByTestId('track-gutter-add'));
    fireEvent.change(screen.getByLabelText('Search public genomic data'), {
      target: { value: 'CpG islands' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const result = await screen.findByTestId('ucsc-track-result-cpgIslandExt');
    fireEvent.click(result.querySelector('button')!);

    await waitFor(() => {
      const lane = useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((candidate) => candidate.dataset.trackId === 'ucsc:hg38-cpgIslandExt');
      expect(lane?.dataset).toMatchObject({
        trackType: 'generic-interval',
        label: 'CpG Islands',
        trackPx: 160,
        kind: 'annotation',
        records: [],
      });
      expect(lane?.source).toMatchObject({
        formatId: 'ucsc-native',
        readerKind: 'ucsc-rest',
        scientificKind: 'interval',
        assemblyId: ASSEMBLY_ID,
      });
    });
    fireEvent.click(screen.getByLabelText('Open settings for CpG Islands'));
    expect(await screen.findByLabelText('Color for CpG Islands')).toBeVisible();
  });

  it('adds a catalog BigBed transcript through the shared semantic lane adapter', async () => {
    renderGutter();

    fireEvent.click(screen.getByTestId('track-gutter-add'));
    fireEvent.change(screen.getByLabelText('Search public genomic data'), {
      target: { value: 'Transcript models' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const result = await screen.findByTestId('ucsc-track-result-knownGene');
    fireEvent.click(result.querySelector('button')!);

    await waitFor(() => {
      const lane = useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((candidate) => candidate.dataset.trackId === 'ucsc:hg38-knownGene');
      expect(lane).toMatchObject({
        dataset: {
          trackType: 'imported-transcript',
          label: 'Known Genes',
          trackPx: 160,
          records: [],
        },
        source: {
          formatId: 'bigbed',
          readerKind: 'bbi',
          scientificKind: 'transcript',
        },
      });
    });
    expect(ucscMocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ formatId: 'bigbed', track: 'knownGene' })
    );
  });

  it('routes gutter wheel motion to the renderer vertical stack without camera input', () => {
    const scrollTracksBy = vi.fn(() => true);
    renderGutter(scrollTracksBy);

    fireEvent.wheel(screen.getByTestId('track-gutter'), { deltaY: -48 });

    expect(scrollTracksBy).toHaveBeenCalledOnce();
    expect(scrollTracksBy).toHaveBeenCalledWith(-48);
  });

  it('keeps hidden BAMs manageable and confirms before removing only the selected lane', async () => {
    renderGutter();

    fireEvent.click(screen.getByLabelText('Show Tumor BAM'));

    expect(screen.getByTestId(`track-gutter-row-${ASSEMBLY_ID}:bam-a`)).toBeVisible();
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .find((lane) => lane.dataset.trackId === 'bam-a')?.visible
    ).toBe(false);
    expect(useLaneContractStore.getState().activeDatasets.map((lane) => lane.trackId)).toEqual([
      'bam-b',
    ]);

    fireEvent.click(screen.getByLabelText('Remove Normal BAM'));

    expect(useConfirmDialogStore.getState().request).toMatchObject({
      title: 'Remove track?',
      message: 'Are you sure you want to remove “Normal BAM” from this view?',
      confirmLabel: 'Remove track',
      tone: 'danger',
      safeDefault: true,
    });
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['bam-a', 'bam-b']);

    act(() => useConfirmDialogStore.getState().resolveCurrent(false));
    await waitFor(() => expect(useConfirmDialogStore.getState().request).toBeNull());
    expect(useLaneContractStore.getState().lanesForOwner(ASSEMBLY_ID)).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('Remove Normal BAM'));
    act(() => useConfirmDialogStore.getState().resolveCurrent(true));

    await waitFor(() => {
      expect(
        useLaneContractStore
          .getState()
          .lanesForOwner(ASSEMBLY_ID)
          .map((lane) => lane.dataset.trackId)
      ).toEqual(['bam-a']);
    });
    expect(screen.queryByTestId(`track-gutter-row-${ASSEMBLY_ID}:bam-b`)).toBeNull();
  });

  it('previews WebGL order while durable lane order stays unchanged until drop', () => {
    const { setTrackPresentationOrder, setTrackPresentationDrag } = renderGutter();
    setTrackPresentationOrder.mockClear();
    mockReorderGeometry();
    const handle = screen.getByRole('button', { name: 'Move Normal BAM' });

    firePointerAt('down', handle, 165, 21);
    firePointerAt('move', document, 84, 21);

    expect(setTrackPresentationOrder).toHaveBeenCalledWith(['bam-b', 'bam-a']);
    expect(setTrackPresentationDrag).toHaveBeenLastCalledWith({ trackId: 'bam-b', topPx: 73 });
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['bam-a', 'bam-b']);

    firePointerAt('up', document, 84, 21);
    expect(setTrackPresentationDrag).toHaveBeenLastCalledWith(null);

    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['bam-b', 'bam-a']);
  });

  it('restores the durable WebGL order after a canceled preview', () => {
    const { setTrackPresentationOrder } = renderGutter();
    setTrackPresentationOrder.mockClear();
    mockReorderGeometry();
    const handle = screen.getByRole('button', { name: 'Move Normal BAM' });

    firePointerAt('down', handle, 165, 21);
    firePointerAt('move', document, 84, 21);
    fireEvent.keyDown(document, { key: 'Escape' });
    firePointerAt('up', document, 84, 21);

    expect(setTrackPresentationOrder).toHaveBeenNthCalledWith(1, ['bam-b', 'bam-a']);
    expect(setTrackPresentationOrder).toHaveBeenLastCalledWith(['bam-a', 'bam-b']);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['bam-a', 'bam-b']);
  });

  it('restores the current durable WebGL order when a stale drag commit is rejected', () => {
    const { setTrackPresentationOrder } = renderGutter();
    setTrackPresentationOrder.mockClear();
    mockReorderGeometry();
    const handle = screen.getByRole('button', { name: 'Move Normal BAM' });

    firePointerAt('down', handle, 165, 21);
    firePointerAt('move', document, 84, 21);
    expect(setTrackPresentationOrder).toHaveBeenLastCalledWith(['bam-b', 'bam-a']);

    act(() => {
      useLaneContractStore.getState().removeLane(ASSEMBLY_ID, 'bam-a');
    });
    firePointerAt('up', document, 84, 21);

    expect(setTrackPresentationOrder).toHaveBeenLastCalledWith(['bam-b']);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(ASSEMBLY_ID)
        .map((lane) => lane.dataset.trackId)
    ).toEqual(['bam-b']);
  });

  it('extends the renderer scroll tail for every management row without a painted band', () => {
    const { setTrackStackEndReserve, rerenderAtEpoch } = renderGutter();
    expect(setTrackStackEndReserve).toHaveBeenLastCalledWith(32);

    laneBands.current = {
      reference: { topPx: 14, heightPx: 100 },
      dataBounds: { 'bam-b': { topPx: 114, heightPx: 80 } },
    };
    rerenderAtEpoch(1);
    fireEvent.click(screen.getByLabelText('Show Tumor BAM'));

    expect(setTrackStackEndReserve).toHaveBeenLastCalledWith(62);
  });

  it('reapplies the same scroll-tail contract when the renderer object is replaced', () => {
    const { rerenderAtEpoch, setTrackStackEndReserve } = renderGutter();
    expect(setTrackStackEndReserve).toHaveBeenLastCalledWith(32);
    setTrackStackEndReserve.mockClear();

    rerenderAtEpoch(2);

    expect(setTrackStackEndReserve).toHaveBeenCalledOnce();
    expect(setTrackStackEndReserve).toHaveBeenCalledWith(32);
  });
});
