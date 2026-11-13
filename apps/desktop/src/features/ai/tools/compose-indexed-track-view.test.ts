import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { composeIndexedTrackViewOutputSchema } from './genome-output-schemas';
import { asSchema } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import { execOpts, execTool as executeTool, mockUUID, resetCanvasStore } from './test-helpers';
import {
  composeIndexedTrackView,
  composeIndexedTrackViewSchema,
  createComposeIndexedTrackViewTool,
  type ComposeIndexedTrackViewResult,
} from './compose-indexed-track-view';

mockUUID();
const URL = 'https://results.example.org/run/signal.bigWig';
type AdmitInput = Parameters<
  NonNullable<NonNullable<Parameters<typeof createComposeIndexedTrackViewTool>[0]>['admit']>
>[0];

beforeEach(() => {
  resetCanvasStore();
  useLaneContractStore.getState().clear();
});

function openAssembly(): string {
  return useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'assembly:test',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:test' },
    label: 'Test assembly',
    indexedGenome: {
      sourcePath: 'refs/chrI.fa',
      sourceExt: '.fa',
      chrom: 'chrI',
      assembly: {
        assemblyId: 'test',
        displayName: 'Test assembly',
        chromosomes: [
          {
            chrom: 'chrI',
            displayName: 'chrI',
            length: 100,
            aliases: { ensembl: 'I' },
            manifest: { chrom: 'chrI', fastaPath: 'chrI.fa', faiPath: 'chrI.fa.fai' },
          },
        ],
      },
    },
  });
}

function admittedSource(url = URL) {
  return {
    admissionVersion: 1 as const,
    uri: url,
    input: { kind: 'url' as const, url },
    formatId: 'bigwig',
    recommendedTypes: ['quantitative'],
    fingerprint: 'source-fingerprint',
    readerKind: 'bbi' as const,
    scientificKind: 'quantitative' as const,
    quantitativeColumnSemantics: 'continuous-signal' as const,
    assemblyId: 'test',
    referenceReceipt: {
      assemblyId: 'test',
      referenceSignature: 'reference',
      sourceSignature: 'source',
      contigMap: { chrI: 'chrI' },
      checkedContigs: 1,
      status: 'compatible' as const,
      checkedAt: '2026-09-16T00:00:00.000Z',
    },
    provenance: { provider: 'direct-url', label: url.split('/').at(-1) ?? 'signal.bigWig' },
    quantitativeSummary: {
      contract: 'dnaforge.quantitative-source-summary.v1' as const,
      algorithm: 'equal-genomic-bin-means-r7-quantiles-v1' as const,
      targetSampleCount: 65_536,
      sampleCount: 100,
      lowerQuantile: 0.005,
      upperQuantile: 0.995,
      robustMin: 0,
      robustMax: 12,
      fullMin: 0,
      fullMax: 10_000,
      missingData: 'excluded' as const,
    },
  };
}

function admittedReadsSource() {
  return {
    admissionVersion: 1 as const,
    uri: 'file:///data/reads.bam',
    input: { kind: 'path' as const, path: '/data/reads.bam' },
    index: { kind: 'path' as const, path: '/data/reads.bam.bai' },
    formatId: 'bam',
    recommendedTypes: ['pileup'],
    fingerprint: 'read-source-fingerprint',
    readerKind: 'bam' as const,
    scientificKind: 'reads' as const,
    assemblyId: 'test',
    referenceReceipt: {
      assemblyId: 'test',
      referenceSignature: 'reference',
      sourceSignature: 'reads',
      contigMap: { chrI: 'chrI' },
      checkedContigs: 1,
      status: 'compatible' as const,
      checkedAt: '2026-09-16T00:00:00.000Z',
    },
    provenance: { provider: 'local-file', label: 'Reads' },
    alignedReadIndexState: 'present' as const,
  };
}

describe('compose_indexed_track_view', () => {
  it('advertises strict programmatic composition with existing-track preservation by default', () => {
    expect(JSON.stringify(asSchema(composeIndexedTrackViewSchema).jsonSchema)).toContain(
      'signal-with-read-evidence'
    );
    expect(
      composeIndexedTrackViewSchema.safeParse({
        name: 'Figure 4N',
        tracks: [{ kind: 'bigwig-url', url: URL, settings: { color: '#e11d48' } }],
      }).success
    ).toBe(true);
    expect(
      composeIndexedTrackViewSchema.safeParse({
        name: 'Bad',
        tracks: [{ kind: 'bigwig-url', url: 'file:///tmp/a.bw' }],
      }).success
    ).toBe(false);
    expect(
      composeIndexedTrackViewSchema.safeParse({
        name: 'Hybrid accessibility',
        signalReadPileups: [
          {
            readsTrackId: 'reads',
            signalUrl: URL,
            label: 'Accessibility → reads',
            showSourceTracks: false,
          },
        ],
      }).success
    ).toBe(true);
    expect(
      composeIndexedTrackViewSchema.safeParse({
        name: 'Ambiguous hybrid',
        signalReadPileups: [{ readsTrackId: 'reads', signalTrackId: 'signal', signalUrl: URL }],
      }).success
    ).toBe(false);
    expect(
      composeIndexedTrackViewSchema.safeParse({
        name: 'Signal first',
        views: [{ type: 'signal-with-read-evidence', signalUrl: URL }],
      }).success
    ).toBe(true);
    expect(
      composeIndexedTrackViewSchema.safeParse({
        name: 'Signal and optional reads',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalTrackId: 'signal',
            readsTrackId: 'reads',
          },
        ],
      }).success
    ).toBe(true);
    expect(
      composeIndexedTrackViewSchema.safeParse({
        name: 'Do not hide the only output',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalUrl: URL,
            showSourceTracks: false,
          },
        ],
      }).success
    ).toBe(false);
  });

  it('authors a signal-first view without demanding or fabricating a read index', async () => {
    openAssembly();
    const admit = vi.fn().mockResolvedValue(admittedSource());

    const result = await execTool<ComposeIndexedTrackViewResult>(
      createComposeIndexedTrackViewTool({ admit }),
      {
        name: 'ATAC signal before reads',
        preserveCurrentTracks: false,
        views: [
          {
            type: 'signal-with-read-evidence',
            signalUrl: URL,
            label: 'Accessibility signal',
          },
        ],
      }
    );

    expect(result).toMatchObject({
      ok: true,
      tracks: [{ family: 'quantitative', label: 'Accessibility signal', visible: true }],
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.not.objectContaining({ index: expect.anything() }),
      })
    );
    if (!result.ok) throw new Error(result.error);
    expect(useLaneContractStore.getState().lanesForOwner(result.tabId)).toHaveLength(1);
    const composedTab = useCanvasStore
      .getState()
      .panels.main.tabs.find((tab) => tab.id === result.tabId);
    expect(composedTab?.indexedGenome?.signalReadPileupViews).toEqual([]);
  });

  it('promotes the same declaration to a durable hybrid when reads are explicitly bound', async () => {
    const originalTabId = openAssembly();
    useLaneContractStore.getState().addLane(
      originalTabId,
      'test',
      {
        trackType: 'pileup',
        trackId: 'reads',
        label: 'Reads',
        color: 0x4a90d9,
        trackPx: 276,
        laneHeightPx: 3,
        maxLanes: 80,
        records: [],
        kind: 'pileup',
        source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
      },
      true,
      admittedReadsSource()
    );
    const admit = vi.fn().mockResolvedValue(admittedSource());

    const result = await execTool<ComposeIndexedTrackViewResult>(
      createComposeIndexedTrackViewTool({ admit }),
      {
        name: 'ATAC signal and reads',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalUrl: URL,
            readsTrackId: 'reads',
            label: 'Accessibility → reads',
          },
        ],
      }
    );

    expect(result).toMatchObject({
      ok: true,
      tracks: [
        { trackId: 'reads', visible: false },
        { family: 'quantitative', visible: false },
        {
          family: 'reads',
          label: 'Accessibility → reads',
          visible: true,
          composition: { kind: 'signal-read-pileup', readsTrackId: 'reads' },
        },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    const composedTab = useCanvasStore
      .getState()
      .panels.main.tabs.find((tab) => tab.id === result.tabId);
    expect(composedTab?.indexedGenome?.signalReadPileupViews).toEqual([
      expect.objectContaining({ readsTrackId: 'reads', label: 'Accessibility → reads' }),
    ]);
  });

  it('reuses an admitted signal first, then binds existing reads without re-admission', async () => {
    const originalTabId = openAssembly();
    const store = useLaneContractStore.getState();
    store.addLane(
      originalTabId,
      'test',
      {
        trackType: 'quantitative',
        trackId: 'signal',
        label: 'Original signal',
        color: 0xa8ceff,
        trackPx: 96,
        records: [],
        kind: 'annotation',
      },
      true,
      admittedSource()
    );
    store.addLane(
      originalTabId,
      'test',
      {
        trackType: 'pileup',
        trackId: 'reads',
        label: 'Reads',
        color: 0x4a90d9,
        trackPx: 276,
        laneHeightPx: 3,
        maxLanes: 80,
        records: [],
        kind: 'pileup',
        source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
      },
      true,
      admittedReadsSource()
    );
    const admit = vi.fn();

    const signalOnly = await composeIndexedTrackView(
      {
        name: 'Signal before evidence',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalTrackId: 'signal',
            label: 'Accessibility',
          },
        ],
      },
      { admit }
    );
    expect(signalOnly).toMatchObject({
      ok: true,
      tracks: [
        { trackId: 'signal', label: 'Accessibility', visible: true },
        { trackId: 'reads', visible: true },
      ],
    });
    expect(admit).not.toHaveBeenCalled();
    if (!signalOnly.ok) throw new Error(signalOnly.error);

    const withReads = await composeIndexedTrackView(
      {
        name: 'Signal with evidence',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalTrackId: 'signal',
            readsTrackId: 'reads',
            label: 'Accessibility → reads',
          },
        ],
      },
      { admit }
    );
    expect(withReads).toMatchObject({
      ok: true,
      tracks: [
        { trackId: 'signal', visible: false },
        { trackId: 'reads', visible: false },
        {
          label: 'Accessibility → reads',
          visible: true,
          composition: {
            kind: 'signal-read-pileup',
            signalTrackId: 'signal',
            readsTrackId: 'reads',
          },
        },
      ],
    });
    expect(admit).not.toHaveBeenCalled();
    if (!withReads.ok) throw new Error(withReads.error);
    const composedTab = useCanvasStore
      .getState()
      .panels.main.tabs.find((tab) => tab.id === withReads.tabId);
    expect(composedTab?.indexedGenome?.signalReadPileupViews).toHaveLength(1);
  });

  it('rejects a failed read dependency before creating a new view', async () => {
    const originalTabId = openAssembly();
    useLaneContractStore.getState().addLane(originalTabId, 'test', {
      trackType: 'pileup',
      trackId: 'reads',
      label: 'Failed reads',
      color: 0x4a90d9,
      trackPx: 276,
      records: [],
      kind: 'pileup',
      source: {
        bamPath: '/data/reads.cram',
        admissionError: 'The CRAM index is unavailable.',
      },
    });
    const beforeTabs = useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id);

    const admit = vi.fn().mockResolvedValue(admittedSource());
    const result = await composeIndexedTrackView(
      {
        name: 'Unavailable read evidence',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalUrl: URL,
            readsTrackId: 'reads',
          },
        ],
      },
      { admit }
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_COMPOSITION', stateChanged: false });
    expect(admit).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id)).toEqual(beforeTabs);
  });

  it('does not mistake an unverified index path for admitted regional reads', async () => {
    const originalTabId = openAssembly();
    useLaneContractStore.getState().addLane(originalTabId, 'test', {
      trackType: 'pileup',
      trackId: 'unverified-reads',
      label: 'Unverified reads',
      color: 0x4a90d9,
      trackPx: 276,
      records: [],
      kind: 'pileup',
      source: {
        bamPath: '/data/reads.bam',
        indexPath: '/data/reads.bam.bai',
      },
    });
    const beforeTabs = useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id);
    const admit = vi.fn().mockResolvedValue(admittedSource());

    const result = await composeIndexedTrackView(
      {
        name: 'Unverified read binding',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalUrl: URL,
            readsTrackId: 'unverified-reads',
          },
        ],
      },
      { admit }
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_COMPOSITION', stateChanged: false });
    expect(admit).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id)).toEqual(beforeTabs);
  });

  it('rejects read evidence from another assembly before admitting the signal', async () => {
    const originalTabId = openAssembly();
    const foreign = admittedReadsSource();
    useLaneContractStore.getState().addLane(
      originalTabId,
      'test',
      {
        trackType: 'pileup',
        trackId: 'foreign-reads',
        label: 'Other assembly reads',
        color: 0x4a90d9,
        trackPx: 276,
        records: [],
        kind: 'pileup',
        source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
      },
      true,
      {
        ...foreign,
        assemblyId: 'other',
        referenceReceipt: { ...foreign.referenceReceipt, assemblyId: 'other' },
      }
    );
    const admit = vi.fn().mockResolvedValue(admittedSource());

    const result = await composeIndexedTrackView(
      {
        name: 'Mismatched assembly',
        views: [
          {
            type: 'signal-with-read-evidence',
            signalUrl: URL,
            readsTrackId: 'foreign-reads',
          },
        ],
      },
      { admit }
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_COMPOSITION', stateChanged: false });
    expect(admit).not.toHaveBeenCalled();
  });

  it('offers the same validated transactional path to checked-in programmatic callers', async () => {
    openAssembly();
    const admit = vi.fn().mockResolvedValue(admittedSource());

    const result = await composeIndexedTrackView(
      {
        name: 'Checked-in composition',
        preserveCurrentTracks: false,
        tracks: [{ kind: 'bigwig-url', url: URL, settings: { color: '#8b5cf6' } }],
      },
      { admit }
    );

    expect(result).toMatchObject({
      ok: true,
      assemblyId: 'test',
      name: 'Checked-in composition',
      tracks: [{ color: '#8b5cf6' }],
    });
    expect(admit).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error(result.error);
    expect(useLaneContractStore.getState().canUndoLaneChange(result.tabId)).toBe(true);
    expect(useLaneContractStore.getState().undoLaneChange(result.tabId)).toBe(true);
    expect(useLaneContractStore.getState().lanesForOwner(result.tabId)).toEqual([]);
    expect(useLaneContractStore.getState().redoLaneChange(result.tabId)).toBe(true);
    expect(useLaneContractStore.getState().lanesForOwner(result.tabId)).toHaveLength(1);
  });

  it('preflights all sources, preserves current tracks, and commits one separate unsaved view', async () => {
    const originalTabId = openAssembly();
    useLaneContractStore.getState().addLane(originalTabId, 'test', {
      trackType: 'pileup',
      trackId: 'reads',
      label: 'Reads',
      color: 0x4a90d9,
      trackPx: 276,
      laneHeightPx: 3,
      maxLanes: 80,
      records: [],
      kind: 'pileup',
      source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
    });
    const admit = vi.fn().mockResolvedValue(admittedSource());
    const controller = new AbortController();

    const result = await execTool<ComposeIndexedTrackViewResult>(
      createComposeIndexedTrackViewTool({ admit }),
      {
        name: 'Figure 4N',
        viewport: { chrom: 'I', start0: 0, end0: 80 },
        tracks: [
          {
            kind: 'bigwig-url',
            url: URL,
            settings: {
              label: 'Pol II',
              color: '#e11d48',
              heightPx: 120,
              quantitative: {
                mode: 'robust-global',
                transform: 'log1p',
                smoothingSigmaBins: 1.2,
              },
            },
          },
        ],
      },
      { ...execOpts, abortSignal: controller.signal }
    );

    expect(admit).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        request: expect.objectContaining({
          source: { kind: 'http', url: URL },
          ingress: { kind: 'automation' },
        }),
      })
    );
    expect(result).toMatchObject({
      ok: true,
      name: 'Figure 4N',
      unsaved: true,
      tracks: [
        { trackId: 'reads', family: 'reads' },
        {
          family: 'quantitative',
          label: 'Pol II',
          color: '#e11d48',
          heightPx: 120,
          quantitative: {
            smoothingSigmaBins: 1.2,
            scale: { mode: 'robust-global', transform: 'log1p' },
          },
        },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.tabId).not.toBe(originalTabId);
    expect(useLaneContractStore.getState().lanesForOwner(originalTabId)).toHaveLength(1);
    expect(useLaneContractStore.getState().lanesForOwner(result.tabId)).toHaveLength(2);
    const composedTab = useCanvasStore
      .getState()
      .panels.main.tabs.find((tab) => tab.id === result.tabId);
    expect(composedTab?.indexedGenome?.scope).toEqual({
      kind: 'locus',
      chrom: 'chrI',
      start: 0,
      end: 80,
    });
    expect(composedTab?.viewState?.indexedViewportCommand).toMatchObject({ chrom: 'chrI' });
  });

  it('constructs a durable signal-to-reads view from an existing read track and a new BigWig URL', async () => {
    const originalTabId = openAssembly();
    useLaneContractStore.getState().addLane(
      originalTabId,
      'test',
      {
        trackType: 'pileup',
        trackId: 'reads',
        label: 'Reads',
        color: 0x4a90d9,
        trackPx: 276,
        laneHeightPx: 3,
        maxLanes: 80,
        overflowBandHeightPx: 36,
        records: [],
        kind: 'pileup',
        source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
      },
      true,
      admittedReadsSource()
    );
    const admit = vi.fn().mockResolvedValue(admittedSource());

    const result = await execTool<ComposeIndexedTrackViewResult>(
      createComposeIndexedTrackViewTool({ admit }),
      {
        name: 'Accessibility handoff',
        signalReadPileups: [
          {
            readsTrackId: 'reads',
            signalUrl: URL,
            label: 'Accessibility → reads',
            showSourceTracks: false,
            settings: { color: '#a8ceff', heightPx: 300, maxRows: 96 },
          },
        ],
      }
    );

    expect(admit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      tracks: [
        { trackId: 'reads', visible: false },
        { family: 'quantitative', visible: false },
        {
          family: 'reads',
          label: 'Accessibility → reads',
          visible: true,
          color: '#a8ceff',
          heightPx: 300,
          maxRows: 96,
          composition: {
            kind: 'signal-read-pileup',
            readsTrackId: 'reads',
          },
        },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    const composedTab = useCanvasStore
      .getState()
      .panels.main.tabs.find((tab) => tab.id === result.tabId);
    expect(composedTab?.indexedGenome?.signalReadPileupViews).toEqual([
      expect.objectContaining({
        contract: 'dnaforge.signal-read-pileup-view.v1',
        readsTrackId: 'reads',
        label: 'Accessibility → reads',
      }),
    ]);
    expect(useLaneContractStore.getState().lanesForOwner(originalTabId)).toHaveLength(1);
  });

  it('composes already admitted read and BigWig identities without another admission', async () => {
    const originalTabId = openAssembly();
    const store = useLaneContractStore.getState();
    store.addLane(
      originalTabId,
      'test',
      {
        trackType: 'pileup',
        trackId: 'reads',
        label: 'Reads',
        color: 0x4a90d9,
        trackPx: 276,
        laneHeightPx: 3,
        maxLanes: 80,
        overflowBandHeightPx: 36,
        records: [],
        kind: 'pileup',
        source: { bamPath: '/data/reads.bam', indexPath: '/data/reads.bam.bai' },
      },
      true,
      admittedReadsSource()
    );
    const signalSource = admittedSource();
    store.addLane(
      originalTabId,
      'test',
      {
        trackType: 'quantitative',
        trackId: 'signal',
        label: 'Accessibility',
        color: 0xa8ceff,
        trackPx: 96,
        records: [],
        kind: 'annotation',
      },
      true,
      signalSource
    );
    const admit = vi.fn();

    const result = await execTool<ComposeIndexedTrackViewResult>(
      createComposeIndexedTrackViewTool({ admit }),
      {
        name: 'Existing outputs',
        signalReadPileups: [
          {
            readsTrackId: 'reads',
            signalTrackId: 'signal',
            showSourceTracks: true,
          },
        ],
      }
    );

    expect(admit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      tracks: [
        { trackId: 'reads', visible: true },
        { trackId: 'signal', visible: true },
        {
          visible: true,
          composition: {
            kind: 'signal-read-pileup',
            readsTrackId: 'reads',
            signalTrackId: 'signal',
          },
        },
      ],
    });
  });

  it('does not create or mutate a view when any source fails preflight', async () => {
    const originalTabId = openAssembly();
    const beforeTabs = useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id);
    const result = await execTool<ComposeIndexedTrackViewResult>(
      createComposeIndexedTrackViewTool({
        admit: vi.fn().mockRejectedValue(new Error('BigWig reference mismatch for chrI')),
      }),
      { name: 'Broken', tracks: [{ kind: 'bigwig-url', url: URL }] }
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'ADMISSION_FAILED',
      retriable: true,
      stateChanged: false,
    });
    expect(useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id)).toEqual(beforeTabs);
    expect(useLaneContractStore.getState().lanesForOwner(originalTabId)).toEqual([]);
  });

  it('serializes admissions per origin while keeping different origins concurrent', async () => {
    openAssembly();
    const activeByOrigin = new Map<string, number>();
    const maximumByOrigin = new Map<string, number>();
    let activeTotal = 0;
    let maximumTotal = 0;
    const admit = vi.fn(async ({ request }: AdmitInput) => {
      if (request.source.kind !== 'http') throw new Error('Expected an HTTP source.');
      const origin = new globalThis.URL(request.source.url).origin;
      const active = (activeByOrigin.get(origin) ?? 0) + 1;
      activeByOrigin.set(origin, active);
      maximumByOrigin.set(origin, Math.max(maximumByOrigin.get(origin) ?? 0, active));
      activeTotal += 1;
      maximumTotal = Math.max(maximumTotal, activeTotal);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeByOrigin.set(origin, active - 1);
      activeTotal -= 1;
      return admittedSource(request.source.url);
    });

    const result = await execTool<ComposeIndexedTrackViewResult>(
      createComposeIndexedTrackViewTool({ admit }),
      {
        name: 'Origin-aware loading',
        tracks: [
          { kind: 'bigwig-url', url: 'https://results.example.org/run/one.bigWig' },
          { kind: 'bigwig-url', url: 'https://results.example.org/run/two.bigWig' },
          { kind: 'bigwig-url', url: 'https://other.example.org/run/three.bigWig' },
        ],
      }
    );

    expect(result.ok).toBe(true);
    expect(maximumByOrigin).toEqual(
      new Map([
        ['https://results.example.org', 1],
        ['https://other.example.org', 1],
      ])
    );
    expect(maximumTotal).toBe(2);
  });
  it('reports the newly created tab when lane installation fails after tab creation', async () => {
    const sourceTabId = openAssembly();
    const install = vi
      .spyOn(useLaneContractStore.getState(), 'replaceOwnerLanes')
      .mockImplementation(() => {
        throw new Error('Lane projection failed');
      });
    try {
      const result = await execTool<ComposeIndexedTrackViewResult>(
        createComposeIndexedTrackViewTool(),
        { name: 'Retained draft' }
      );
      const createdTab = useCanvasStore
        .getState()
        .panels.main.tabs.find((tab) => tab.id !== sourceTabId);
      expect(createdTab).toMatchObject({ label: 'Retained draft' });
      expect(result).toMatchObject({
        ok: false,
        code: 'VIEW_NOT_CREATED',
        stateChanged: true,
        partialEffects: [`track-view-tab:${createdTab!.id}`],
      });
    } finally {
      install.mockRestore();
    }
  });
});

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true)
    assertMcpOutput(composeIndexedTrackViewOutputSchema, result);
  return result;
}
