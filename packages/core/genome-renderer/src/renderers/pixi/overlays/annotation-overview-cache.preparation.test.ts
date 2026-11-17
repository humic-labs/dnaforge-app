import { describe, expect, it } from 'vitest';
import type { Feature, Genome, RenderState } from '../../../types';
import { computeUnifiedLayout, type UnifiedLayout } from '../shared/track-layout';
import {
  AnnotationOverviewCacheManager,
  type AnnotationOverviewCacheContext,
  type RetainedOverviewBodyCache,
} from './annotation-overview-cache';

function features(genomeLength = 10_000): Feature[] {
  return [
    {
      id: 1,
      type: 'gene',
      start: 100,
      end: 800,
      direction: 'forward',
      displayName: 'first',
      color: 0x22c55e,
      lane: 0,
    },
    {
      id: 2,
      type: 'gene',
      start: genomeLength - 500,
      end: 300,
      direction: 'reverse',
      displayName: 'origin-spanning',
      color: 0x3b82f6,
      lane: 1,
    },
    {
      id: 3,
      type: 'gene',
      start: 1001,
      end: 1002,
      direction: 'none',
      displayName: 'tiny',
      color: 0x654321,
      lane: 0,
      qualifiers: { source: 'pLannotate-draft' },
    },
    {
      id: 4,
      type: 'CDS',
      start: 4000,
      end: 4300,
      direction: 'forward',
      displayName: 'spliced',
      color: 0x22c55e,
      lane: 0,
      segments: [
        { start: 4000, end: 4100 },
        { start: 4200, end: 4300 },
      ],
      qualifiers: { _locationString: 'join(4000..4100,4200..4300)' },
    },
    {
      id: 5,
      type: 'gene',
      start: 200,
      end: 600,
      direction: 'reverse',
      displayName: 'overlapping',
      color: 0x22c55e,
      lane: 0,
    },
  ];
}

function layout(source: Feature[], genomeLength: number): UnifiedLayout {
  const genome: Genome = {
    name: 'circular-source',
    length: genomeLength,
    circular: true,
    features: source,
  };
  const state: RenderState = {
    morph: 1,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 600,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
  return computeUnifiedLayout({
    overlays: [],
    genome,
    state,
    pixelsPerBp: 0.0005,
    viewportHeight: 600,
    hasSequence: false,
    translationLanes: 0,
    annotationLanes: 2,
    cdsLanes: 1,
  });
}

function fixture(
  options: {
    source?: Feature[];
    genomeLength?: number;
    physicalLayout?: UnifiedLayout;
  } = {}
) {
  const genomeLength = options.genomeLength ?? 10_000;
  const source = options.source ?? features(genomeLength);
  const physicalLayout = options.physicalLayout ?? layout(source, genomeLength);
  const gate = { forbidAll: false, forbidGeometry: false, calls: [] as string[] };
  function evaluate<T>(name: string, geometry: boolean, read: () => T): T {
    gate.calls.push(name);
    if (gate.forbidAll || (geometry && gate.forbidGeometry)) {
      throw new Error(`unexpected cache construction callback: ${name}`);
    }
    return read();
  }
  const context: AnnotationOverviewCacheContext = {
    features: source,
    genomeLength,
    layout: physicalLayout,
    maxAnnotationLane: 1,
    maxCdsLane: 0,
    minAggregateFeaturePixels: 2,
    getEndBp: (feature) =>
      evaluate('end', false, () =>
        feature.end > feature.start ? feature.end : feature.end + genomeLength
      ),
    getOffset: (feature) =>
      evaluate('offset', true, () =>
        feature.type === 'CDS'
          ? physicalLayout.cdsBarOffset - feature.lane * physicalLayout.cdsLaneStep
          : physicalLayout.annotationOffset - feature.lane * physicalLayout.annotationStep
      ),
    getHalfHeight: () => evaluate('height', true, () => 7),
    getColor: (feature) => evaluate('color', true, () => feature.color ?? 0),
    getAlpha: (feature, featureScoped) =>
      evaluate('alpha', true, () =>
        featureScoped && feature.qualifiers?.source === 'pLannotate-draft' ? 0.35 : 0.85
      ),
    shouldPassThrough: (feature, featureScoped) =>
      evaluate(
        'passthrough',
        false,
        () =>
          featureScoped &&
          feature.type === 'CDS' &&
          (feature.segments?.length ?? 0) > 1 &&
          /join\s*\(/i.test(feature.qualifiers?._locationString ?? '')
      ),
  };
  return { context, gate, source, physicalLayout };
}

function domain(
  context: AnnotationOverviewCacheContext,
  pixelsPerBpMin = 0.00025,
  pixelsPerBpMax = 0.001
) {
  return {
    presentationKey: 'circular-map',
    contexts: [{ context, pixelsPerBpMin, pixelsPerBpMax }],
  };
}

function readyBody(
  owner: AnnotationOverviewCacheManager,
  pixelsPerBp: number,
  context: AnnotationOverviewCacheContext
): RetainedOverviewBodyCache {
  const result = owner.readRetainedOverviewBodyCache({ pixelsPerBp }, context);
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('exact body level is unavailable');
  return result.cache;
}

function geometryCalls(calls: string[]) {
  return calls.filter((name) => ['offset', 'height', 'color', 'alpha'].includes(name));
}

describe('retained overview cache preparation', () => {
  it('preserves individual source geometry, origin crossing, tiny bodies and passthrough identity', () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, source, physicalLayout } = fixture();
    const cache = owner.getRetainedOverviewBodyCache({ pixelsPerBp: 0.0005 }, context);
    expect(cache?.bins.map((bin) => [bin.featureId, bin.startBp, bin.endBp])).toEqual([
      [1, 100, 500],
      [1, 500, 800],
      [2, 9500, 10_000],
      [2, 10_000, 10_300],
      [3, 1001, 1002],
      [5, 200, 500],
      [5, 500, 600],
    ]);
    expect(cache?.bins.find((bin) => bin.featureId === 2)).toMatchObject({
      featureStart: 9500,
      featureEnd: 300,
      featureRawEnd: 10_300,
      featureDirection: 'reverse',
      offset: physicalLayout.annotationOffset - physicalLayout.annotationStep,
      halfHeight: 7,
      color: 0x3b82f6,
      alpha: 0.85,
    });
    expect(cache?.bins.find((bin) => bin.featureId === 3)).toMatchObject({
      color: 0x654321,
      alpha: 0.35,
      coverageBp: 1,
    });
    expect(cache?.passthroughFeatures).toEqual([source[3]]);
    expect(cache?.passthroughFeatures[0]).toBe(source[3]);
  });

  it('reports an unprepared exact level without invoking data or geometry construction', () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, gate } = fixture();
    gate.forbidAll = true;
    const result = owner.readRetainedOverviewBodyCache({ pixelsPerBp: 0.0005 }, context);
    expect(result).toMatchObject({
      kind: 'unprepared',
      request: { selectedBinBp: 500, generation: expect.any(Number) },
    });
    expect(gate.calls).toEqual([]);
  });

  it('publishes awaitable readiness for every exact level in a finite camera domain', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context } = fixture();
    const preparation = owner.prepareRetainedOverview(domain(context));
    expect(typeof preparation.then).toBe('function');
    const receipt = await preparation;
    expect(receipt).toMatchObject({
      kind: 'ready',
      generation: expect.any(Number),
      presentationKey: 'circular-map',
      exactBinCount: 24,
    });
    if (receipt.kind !== 'ready') throw new Error('finite camera domain was not prepared');
    expect(new Set(receipt.contextLevelKeys).size).toBe(3);
    expect(readyBody(owner, 0.001, context).binBp).toBe(250);
    expect(readyBody(owner, 0.0005, context).binBp).toBe(500);
    expect(readyBody(owner, 0.00025, context).binBp).toBe(1000);
  });

  it('reuses exact prepared bins across repeated camera reads without construction', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, gate, source } = fixture();
    await owner.prepareRetainedOverview(domain(context));
    const initial = new Map(
      [0.001, 0.0005, 0.00025].map((pixelsPerBp) => [
        pixelsPerBp,
        readyBody(owner, pixelsPerBp, context),
      ])
    );
    gate.calls.length = 0;
    gate.forbidAll = true;
    for (const pixelsPerBp of [0.001, 0.0005, 0.00025, 0.0005, 0.001]) {
      const current = readyBody(owner, pixelsPerBp, context);
      expect(current.bins).toBe(initial.get(pixelsPerBp)?.bins);
      expect(current.passthroughFeatures[0]).toBe(source[3]);
    }
    expect(gate.calls).toEqual([]);
  });

  it('refuses an uncovered level without substitution or construction', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, gate } = fixture();
    await owner.prepareRetainedOverview(domain(context));
    const previous = readyBody(owner, 0.0005, context);
    gate.calls.length = 0;
    gate.forbidAll = true;
    expect(owner.readRetainedOverviewBodyCache({ pixelsPerBp: 0.000125 }, context)).toMatchObject({
      kind: 'unprepared',
      request: { selectedBinBp: 2000 },
    });
    expect(readyBody(owner, 0.0005, context).bins).toBe(previous.bins);
    expect(gate.calls).toEqual([]);
  });

  it('does not reuse a same-count replacement source under an old ready receipt', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const first = fixture();
    await owner.prepareRetainedOverview(domain(first.context));
    const replacement = fixture({
      source: first.source.map((feature) => ({ ...feature, start: feature.start + 7 })),
      physicalLayout: first.physicalLayout,
    });
    replacement.gate.forbidAll = true;
    expect(
      owner.readRetainedOverviewBodyCache({ pixelsPerBp: 0.0005 }, replacement.context)
    ).toMatchObject({
      kind: 'unprepared',
    });
    expect(replacement.gate.calls).toEqual([]);
  });

  it('requires preparation for changed physical geometry and keeps its exact offset', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const first = fixture();
    await owner.prepareRetainedOverview(domain(first.context));
    const original = readyBody(owner, 0.0005, first.context);
    const moved = fixture({
      source: first.source,
      physicalLayout: {
        ...first.physicalLayout,
        annotationOffset: first.physicalLayout.annotationOffset - 32,
      },
    });
    moved.gate.forbidAll = true;
    expect(
      owner.readRetainedOverviewBodyCache({ pixelsPerBp: 0.0005 }, moved.context)
    ).toMatchObject({
      kind: 'unprepared',
    });
    expect(moved.gate.calls).toEqual([]);
    moved.gate.forbidAll = false;
    await owner.prepareRetainedOverview(domain(moved.context));
    const current = readyBody(owner, 0.0005, moved.context);
    expect(current.bins).not.toBe(original.bins);
    expect(current.bins[0].offset).toBe(original.bins[0].offset - 32);
    expect(current.bins.map((bin) => [bin.featureId, bin.startBp, bin.endBp])).toEqual(
      original.bins.map((bin) => [bin.featureId, bin.startBp, bin.endBp])
    );
  });

  it('retires all prepared levels on invalidation and advances the generation', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, gate } = fixture();
    const first = await owner.prepareRetainedOverview(domain(context));
    const original = readyBody(owner, 0.0005, context);
    owner.invalidate();
    gate.calls.length = 0;
    gate.forbidAll = true;
    for (const pixelsPerBp of [0.001, 0.0005, 0.00025]) {
      const result = owner.readRetainedOverviewBodyCache({ pixelsPerBp }, context);
      expect(result.kind).toBe('unprepared');
      if (result.kind !== 'unprepared') throw new Error('retired level remained ready');
      expect(result.request.generation).toBeGreaterThan(first.generation);
    }
    expect(gate.calls).toEqual([]);
    gate.forbidAll = false;
    const next = await owner.prepareRetainedOverview(domain(context));
    expect(next.kind).toBe('ready');
    expect(next.generation).toBeGreaterThan(first.generation);
    expect(readyBody(owner, 0.0005, context).bins).not.toBe(original.bins);
  });

  it('does not publish a preparation whose generation was retired while pending', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, gate } = fixture();
    const pending = owner.prepareRetainedOverview(domain(context));
    owner.invalidate();
    gate.forbidAll = true;
    const result = await pending;
    expect(result).toMatchObject({ kind: 'unprepared', reason: 'stale-generation' });
    expect(owner.readRetainedOverviewBodyCache({ pixelsPerBp: 0.0005 }, context).kind).toBe(
      'unprepared'
    );
  });

  it('keeps the default retained entry bound across successive single-level domains', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, gate } = fixture({ genomeLength: 4_641_652 });
    const binBps = [250, 500, 1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000];
    for (const binBp of binBps) {
      const pixelsPerBp = 0.25 / binBp;
      expect(
        (await owner.prepareRetainedOverview(domain(context, pixelsPerBp, pixelsPerBp))).kind
      ).toBe('ready');
    }
    gate.calls.length = 0;
    gate.forbidAll = true;
    const reads = binBps.map((binBp) =>
      owner.readRetainedOverviewBodyCache({ pixelsPerBp: 0.25 / binBp }, context)
    );
    expect(reads.filter((result) => result.kind === 'ready')).toHaveLength(8);
    expect(reads.slice(0, 3).map((result) => result.kind)).toEqual([
      'unprepared',
      'unprepared',
      'unprepared',
    ]);
    expect(reads.at(-1)?.kind).toBe('ready');
    expect(gate.calls).toEqual([]);
  });

  it('admits a larger exact finite domain under an explicit retained capacity', async () => {
    const owner = new AnnotationOverviewCacheManager({
      maxResidentRetainedLevels: 12,
      maxPreparedRetainedBins: 1000,
    });
    const { context, gate } = fixture({ genomeLength: 4_641_652 });
    const receipt = await owner.prepareRetainedOverview(domain(context, 0.000001, 0.001));
    expect(receipt.kind).toBe('ready');
    if (receipt.kind !== 'ready') throw new Error('bounded exact domain was refused');
    expect(new Set(receipt.contextLevelKeys).size).toBe(11);
    expect(receipt.exactBinCount).toBeLessThanOrEqual(1000);
    gate.calls.length = 0;
    gate.forbidAll = true;
    for (const binBp of [
      250, 500, 1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000,
    ]) {
      expect(readyBody(owner, 0.25 / binBp, context).binBp).toBe(binBp);
    }
    expect(gate.calls).toEqual([]);
  });

  it('refuses an over-capacity domain before constructing any body geometry', async () => {
    const owner = new AnnotationOverviewCacheManager({
      maxResidentRetainedLevels: 8,
      maxPreparedRetainedBins: 1000,
    });
    const { context, gate } = fixture({ genomeLength: 4_641_652 });
    gate.forbidGeometry = true;
    const result = await owner.prepareRetainedOverview(domain(context, 0.000001, 0.001));
    expect(result).toMatchObject({ kind: 'unprepared', reason: 'retention-budget-exceeded' });
    expect(geometryCalls(gate.calls)).toEqual([]);
    gate.forbidAll = true;
    expect(owner.readRetainedOverviewBodyCache({ pixelsPerBp: 0.0005 }, context).kind).toBe(
      'unprepared'
    );
  });

  it('refuses an over-budget domain before constructing any partial body level', async () => {
    const owner = new AnnotationOverviewCacheManager({
      maxResidentRetainedLevels: 8,
      maxPreparedRetainedBins: 23,
    });
    const { context, gate } = fixture();
    gate.forbidGeometry = true;
    const result = await owner.prepareRetainedOverview(domain(context));
    expect(result).toMatchObject({ kind: 'unprepared', reason: 'bin-budget-exceeded' });
    expect(geometryCalls(gate.calls)).toEqual([]);
    gate.forbidAll = true;
    for (const pixelsPerBp of [0.001, 0.0005, 0.00025]) {
      expect(owner.readRetainedOverviewBodyCache({ pixelsPerBp }, context).kind).toBe('unprepared');
    }
  });

  it('reuses a ready domain without invoking preparation callbacks again', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context, gate } = fixture();
    const first = await owner.prepareRetainedOverview(domain(context));
    const original = readyBody(owner, 0.0005, context);
    gate.calls.length = 0;
    gate.forbidAll = true;
    const repeated = await owner.prepareRetainedOverview(domain(context));
    expect(repeated).toEqual(first);
    expect(readyBody(owner, 0.0005, context).bins).toBe(original.bins);
    expect(gate.calls).toEqual([]);
  });

  it('deduplicates overlapping preparation profiles without claiming duplicate bins', async () => {
    const owner = new AnnotationOverviewCacheManager();
    const { context } = fixture();
    const input = domain(context);
    input.contexts.push({ context, pixelsPerBpMin: 0.0005, pixelsPerBpMax: 0.001 });
    const receipt = await owner.prepareRetainedOverview(input);
    expect(receipt).toMatchObject({ kind: 'ready', exactBinCount: 24 });
    if (receipt.kind !== 'ready') throw new Error('overlapping finite domain was refused');
    expect(receipt.contextLevelKeys).toHaveLength(3);
    expect(new Set(receipt.contextLevelKeys).size).toBe(3);
  });
});
