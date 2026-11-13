import { describe, expect, it } from 'vitest';

import type { AnnotationScenePrimitiveV1 } from './annotation-scene-binary-v1';
import {
  BROAD_SURFACE_LANE_ROW_CSS_HEIGHT_PX_V2,
  BROAD_SURFACE_LANE_ROW_TRANSPARENT_TAIL_GUTTER_CSS_PX_V2,
  BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2,
  BROAD_SURFACE_PREFETCH_RING_V2,
  BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2,
  BROAD_SURFACE_X_FILTER_GUARD_PX_V2,
  COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2,
  buildCompiledBroadSurfaceManifestV2,
  type BroadSurfaceIsoformModeV2,
  type CompiledBroadSurfaceManifestV2,
} from './bounded-annotation-broad-surface';
import {
  COMPILED_BROAD_SURFACE_RGBA8_CELL_V1,
  CompiledBroadSurfaceRasterCancelledError,
  compilePackedTranscriptBroadSurfaceRgba8V1,
  type CompiledBroadSurfaceRgba8CellV1,
} from './compiled-broad-surface-rgba8-compiler';
import { buildPartitionedTranscriptScene } from './partitioned-transcript-scene';
import {
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  type PackedPartitionedTranscriptSceneBinaryV4,
} from './partitioned-transcript-scene-binary-v4';
import { buildPrepackedAnnotationInteractionIndexV2 } from './prepacked-annotation-interaction-index-v2';

interface PrimitiveSpec {
  readonly featureIndex: number;
  readonly lane: number;
  readonly startBp: number;
  readonly endBp: number;
  readonly halfH: number;
  readonly color: number;
  readonly alpha: number;
  readonly dirSign: 0 | 1 | -1;
  readonly canonical?: boolean;
}

interface Fixture {
  readonly packed: PackedPartitionedTranscriptSceneBinaryV4;
  readonly surface: CompiledBroadSurfaceManifestV2;
}

interface CapturedCell extends Omit<CompiledBroadSurfaceRgba8CellV1, 'pixels'> {
  readonly pixels: Uint8Array;
}

const SHAPE_SPECS: readonly PrimitiveSpec[] = [
  {
    featureIndex: 0,
    lane: 0,
    startBp: 30,
    endBp: 90,
    halfH: 0.84,
    color: 0x808080,
    alpha: 0.6,
    dirSign: 0,
    canonical: true,
  },
  {
    featureIndex: 0,
    lane: 0,
    startBp: 100,
    endBp: 140,
    halfH: 7,
    color: 0xff0000,
    alpha: 0.85,
    dirSign: 1,
    canonical: true,
  },
  {
    featureIndex: 0,
    lane: 0,
    startBp: 150,
    endBp: 190,
    halfH: 7,
    color: 0x00aa00,
    alpha: 0.85,
    dirSign: -1,
    canonical: true,
  },
  {
    featureIndex: 1,
    lane: 1,
    startBp: 200,
    endBp: 201,
    halfH: 7,
    color: 0x0000ff,
    alpha: 0.85,
    dirSign: 0,
  },
  ...Array.from(
    { length: 6 },
    (_, index): PrimitiveSpec => ({
      featureIndex: index + 2,
      lane: index + 2,
      startBp: 300 + index * 10,
      endBp: 304 + index * 10,
      halfH: 7,
      color: 0x336699,
      alpha: 0.85,
      dirSign: 0,
    })
  ),
  {
    featureIndex: 8,
    lane: 8,
    startBp: 510,
    endBp: 514,
    halfH: 7,
    color: 0xff00ff,
    alpha: 0.85,
    dirSign: 0,
  },
];

describe('compiled broad surface RGBA8 compiler', () => {
  it('streams every exact address including transparent cells with one bounded pixel buffer', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const captured: CapturedCell[] = [];
    const bufferIdentities = new Set<ArrayBufferLike>();
    const work = await compilePackedTranscriptBroadSurfaceRgba8V1({
      packedScene: fixture.packed,
      surfaceManifest: fixture.surface,
      onCell(cell) {
        bufferIdentities.add(cell.pixels.buffer);
        captured.push(capture(cell));
      },
    });

    expect(work).toMatchObject({
      emittedCellCount: 9,
      pixelBufferAllocationCount: 1,
      peakLivePixelBufferCount: 1,
      peakLivePixelBytes: 514 * 128 * 4,
    });
    expect(bufferIdentities.size).toBe(1);
    expect(captured).toHaveLength(9);
    expect(
      captured.map((cell) => [cell.isoformMode, cell.level, cell.tileX, cell.laneSlabIndex])
    ).toEqual([
      ['canonical', 0, 0, 0],
      ['canonical', 0, 1, 0],
      ['canonical', 1, 0, 0],
      ['expanded', 0, 0, 0],
      ['expanded', 0, 0, 1],
      ['expanded', 0, 1, 0],
      ['expanded', 0, 1, 1],
      ['expanded', 1, 0, 0],
      ['expanded', 1, 0, 1],
    ]);
    for (const cell of captured) {
      expect(cell.contract).toBe(COMPILED_BROAD_SURFACE_RGBA8_CELL_V1);
      expect(cell.cellId).toBe(
        `M${fixture.surface.manifestFingerprint}|DPR1|L${cell.level}:X${cell.tileX}|${cell.isoformMode}:slab:${cell.laneSlabIndex}`
      );
      expect(cell.widthPx).toBe(514);
      expect(cell.heightPx).toBe(128);
      expect(cell.contentXStartPx).toBe(1);
      expect(cell.contentXEndExclusivePx).toBe(513);
      expect(cell.pixels).toHaveLength(514 * 128 * 4);
      expect(cell.sourcePayloadSha256).toBe(fixture.packed.manifest.integrity.payloadSha256);
    }
    expect(findCell(captured, 'canonical', 0, 1, 0).transparent).toBe(true);
    expect(findCell(captured, 'expanded', 0, 1, 0).transparent).toBe(true);
    expect(work.transparentCellCount).toBeGreaterThanOrEqual(2);
  });

  it('renders thin introns, thick exons, both chevron directions, and stable one-pixel support', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const cells = await compileAndCapture(fixture);
    const finest = findCell(cells, 'expanded', 0, 0, 0);

    expect(alphaAt(finest, 50, 6)).toBeGreaterThan(0);
    expect(alphaAt(finest, 50, 7)).toBeGreaterThan(0);
    expect(alphaAt(finest, 50, 5)).toBe(0);
    expect(alphaAt(finest, 50, 8)).toBe(0);

    expect(alphaAt(finest, 120, 0)).toBeGreaterThan(0);
    expect(alphaAt(finest, 140, 7)).toBeGreaterThan(0);
    expect(alphaAt(finest, 140, 0)).toBe(0);

    expect(alphaAt(finest, 151, 7)).toBeGreaterThan(0);
    expect(alphaAt(finest, 151, 0)).toBe(0);
    expect(alphaAt(finest, 180, 0)).toBeGreaterThan(0);

    const root = findCell(cells, 'expanded', 1, 0, 0);
    const laneOneCenterY = 16 + 7;
    const supportedColumns = [100, 101, 102].filter((x) => alphaAt(root, x, laneOneCenterY) > 0);
    expect(supportedColumns).toEqual([100, 101]);
    expect(alphaAt(root, 100, laneOneCenterY)).toBeLessThan(alphaAt(root, 101, laneOneCenterY));
  });

  it('duplicates exact neighboring samples into the one-pixel X guards', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const cells = await compileAndCapture(fixture);
    const left = findCell(cells, 'expanded', 0, 0, 1);
    const right = findCell(cells, 'expanded', 0, 1, 1);
    const row = 7;

    expect(pixelAt(left, 513, row)).toEqual(pixelAt(right, 1, row));
    expect(pixelAt(left, 512, row)).toEqual(pixelAt(right, 0, row));
    expect(alphaAt(left, 513, row)).toBeGreaterThan(0);
    expect(alphaAt(right, 0, row)).toBeGreaterThan(0);
  });

  it('keeps canonical and expanded banks distinct while preserving their shared lane pixels', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const cells = await compileAndCapture(fixture);
    const canonical = findCell(cells, 'canonical', 1, 0, 0);
    const expanded = findCell(cells, 'expanded', 1, 0, 0);
    const rowBytes = 514 * 16 * 4;

    expect(expanded.pixels.slice(0, rowBytes)).toEqual(canonical.pixels.slice(0, rowBytes));
    expect(alphaAt(canonical, 101, 23)).toBe(0);
    expect(alphaAt(expanded, 101, 23)).toBeGreaterThan(0);
    expect(fixture.surface.laneSlabs.canonical).toHaveLength(1);
    expect(fixture.surface.laneSlabs.expanded).toHaveLength(2);
  });

  it('projects a larger V4 bank to 64 raster rows without changing any retained pixel', async () => {
    const retainedSpecs = Array.from(
      { length: COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2 },
      (_, lane): PrimitiveSpec => ({
        featureIndex: lane,
        lane,
        startBp: 8 + lane * 7,
        endBp: 12 + lane * 7,
        halfH: 7,
        color: (lane * 0x010203) & 0xffffff,
        alpha: 0.85,
        dirSign: lane % 3 === 0 ? 1 : lane % 3 === 1 ? -1 : 0,
        canonical: lane === 0,
      })
    );
    const aboveFiniteCapability: readonly PrimitiveSpec[] = [
      ...retainedSpecs,
      {
        featureIndex: 64,
        lane: 64,
        startBp: 700,
        endBp: 710,
        halfH: 7,
        color: 0xff00ff,
        alpha: 0.85,
        dirSign: 0,
      },
      {
        featureIndex: 65,
        lane: 65,
        startBp: 720,
        endBp: 730,
        halfH: 7,
        color: 0x00ffff,
        alpha: 0.85,
        dirSign: 0,
      },
    ];
    const finiteSource = await buildFixture(retainedSpecs);
    const largerSource = await buildFixture(aboveFiniteCapability);

    expect(largerSource.packed.manifest.directContract.expanded.maxTrackLane + 1).toBe(66);
    expect(largerSource.surface.laneRowCounts.expanded).toBe(64);
    expect(largerSource.surface.laneSlabs.expanded).toHaveLength(8);
    expect(largerSource.surface.laneSlabs.expanded.at(-1)).toMatchObject({
      slabIndex: 7,
      firstLaneRow: 56,
      sourceLaneRowCount: 8,
    });

    const finiteCells = await compileAndCapture(finiteSource);
    const largerCells = await compileAndCapture(largerSource);
    expect(largerCells).toHaveLength(27);
    expect(largerCells.some((cell) => cell.laneSlabIndex >= 8)).toBe(false);
    expect(largerCells.map((cell) => cell.cellId)).toEqual(finiteCells.map((cell) => cell.cellId));
    for (let index = 0; index < largerCells.length; index++) {
      expect(equalBytes(largerCells[index].pixels, finiteCells[index].pixels)).toBe(true);
    }
  });

  it('preserves V4 record draw order with deterministic premultiplied source-over bytes', async () => {
    const fixture = await buildFixture([
      {
        featureIndex: 0,
        lane: 0,
        startBp: 100,
        endBp: 200,
        halfH: 7,
        color: 0xff0000,
        alpha: 0.5,
        dirSign: 0,
        canonical: true,
      },
      {
        featureIndex: 1,
        lane: 0,
        startBp: 100,
        endBp: 200,
        halfH: 7,
        color: 0x0000ff,
        alpha: 0.5,
        dirSign: 0,
        canonical: true,
      },
    ]);
    const first = await compileAndCapture(fixture);
    const second = await compileAndCapture(fixture);
    expect(second).toHaveLength(first.length);
    for (let index = 0; index < first.length; index++) {
      expect(equalBytes(second[index].pixels, first[index].pixels)).toBe(true);
    }

    const cell = findCell(first, 'canonical', 0, 0, 0);
    expect(pixelAt(cell, 120, 7)).toEqual([64, 0, 128, 192]);
  });

  it('paints byte-identical cells with the WebAssembly rasterizer', async () => {
    for (const rasterDevicePixelRatio of [1, 2, 3] as const) {
      const fixture = await buildFixture(SHAPE_SPECS, { rasterDevicePixelRatio });
      const reference = await compileAndCapture(fixture);
      const cells: CapturedCell[] = [];
      await compilePackedTranscriptBroadSurfaceRgba8V1({
        packedScene: fixture.packed,
        surfaceManifest: fixture.surface,
        rasterizer: 'wasm',
        onCell(cell) {
          cells.push(capture(cell));
        },
      });
      expect(cells).toHaveLength(reference.length);
      cells.forEach((cell, index) => {
        expect(cell.cellId).toBe(reference[index].cellId);
        expect(cell.transparent).toBe(reference[index].transparent);
        expect(cell.primitiveRasterizationCount).toBe(reference[index].primitiveRasterizationCount);
        if (!cell.transparent) expect(equalBytes(cell.pixels, reference[index].pixels)).toBe(true);
      });
    }
  });

  it('paints role-weight cells identically in TypeScript and WebAssembly', async () => {
    for (const rasterDevicePixelRatio of [1, 2, 3] as const) {
      const fixture = await buildFixture(SHAPE_SPECS, { rasterDevicePixelRatio });
      const sections = fixture.packed.manifest.sections;
      const rolesFor = (count: number, pick: (index: number) => number) =>
        Uint8Array.from({ length: count }, (_, index) => pick(index));
      const compile = async (
        rasterizer: 'typescript' | 'wasm',
        pick: (index: number) => number
      ) => {
        const cells: CapturedCell[] = [];
        await compilePackedTranscriptBroadSurfaceRgba8V1({
          packedScene: fixture.packed,
          surfaceManifest: fixture.surface,
          rasterizer,
          roleWeights: {
            expanded: rolesFor(sections.expandedGlyphs.count, pick),
            canonical: rolesFor(sections.canonicalGlyphs.count, pick),
          },
          onCell(cell) {
            cells.push(capture(cell));
          },
        });
        return cells;
      };
      const rgba = await compileAndCapture(fixture);
      const mixed = (index: number) => index % 3;
      const typescript = await compile('typescript', mixed);
      const wasm = await compile('wasm', mixed);
      expect(wasm).toHaveLength(typescript.length);
      wasm.forEach((cell, index) => {
        expect(cell.transparent).toBe(typescript[index].transparent);
        expect(cell.transparent).toBe(rgba[index].transparent);
        if (!cell.transparent) {
          expect(equalBytes(cell.pixels, typescript[index].pixels)).toBe(true);
        }
      });

      const single = await compile('wasm', () => 0);
      let alphaMismatches = 0;
      let strayWeights = 0;
      single.forEach((cell, index) => {
        if (cell.transparent) return;
        const reference = rgba[index].pixels;
        for (let offset = 0; offset < cell.pixels.length; offset += 4) {
          if (Math.abs(cell.pixels[offset] - reference[offset + 3]) > 1) alphaMismatches++;
          strayWeights +=
            cell.pixels[offset + 1] + cell.pixels[offset + 2] + cell.pixels[offset + 3];
        }
      });
      expect(alphaMismatches).toBe(0);
      expect(strayWeights).toBe(0);
    }
  });

  it('splits cells round-robin across shards that together equal one full compile', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const serial = await compileAndCapture(fixture);
    for (const count of [1, 2, 3, 4]) {
      const shards: CapturedCell[][] = [];
      for (let index = 0; index < count; index++) {
        const cells: CapturedCell[] = [];
        await compilePackedTranscriptBroadSurfaceRgba8V1({
          packedScene: fixture.packed,
          surfaceManifest: fixture.surface,
          shard: { index, count },
          onCell(cell) {
            cells.push(capture(cell));
          },
        });
        shards.push(cells);
      }
      const merged = serial.map(
        (_, ordinal) => shards[ordinal % count][Math.floor(ordinal / count)]
      );
      expect(shards.reduce((sum, cells) => sum + cells.length, 0)).toBe(serial.length);
      merged.forEach((cell, ordinal) => {
        expect(cell.cellId).toBe(serial[ordinal].cellId);
        expect(cell.transparent).toBe(serial[ordinal].transparent);
        if (!cell.transparent) expect(equalBytes(cell.pixels, serial[ordinal].pixels)).toBe(true);
      });
    }
    await expect(
      compilePackedTranscriptBroadSurfaceRgba8V1({
        packedScene: fixture.packed,
        surfaceManifest: fixture.surface,
        shard: { index: 2, count: 2 },
        onCell() {},
      })
    ).rejects.toThrow('shard is invalid');
  });

  it('lets concurrent workers claim cells from one counter and together equal one full compile', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const serial = await compileAndCapture(fixture);
    let next = 0;
    const byOrdinal = new Map<number, CapturedCell>();
    await Promise.all(
      [0, 1, 2].map(async () => {
        const claimed: number[] = [];
        let emitted = 0;
        await compilePackedTranscriptBroadSurfaceRgba8V1({
          packedScene: fixture.packed,
          surfaceManifest: fixture.surface,
          shard: {
            claim: () => {
              claimed.push(next);
              return next++;
            },
          },
          async onCell(cell) {
            byOrdinal.set(claimed[emitted++], capture(cell));
            await new Promise((resolve) => setTimeout(resolve, 0));
          },
        });
      })
    );
    expect(byOrdinal.size).toBe(serial.length);
    serial.forEach((reference, ordinal) => {
      const cell = byOrdinal.get(ordinal)!;
      expect(cell.cellId).toBe(reference.cellId);
      expect(cell.transparent).toBe(reference.transparent);
      if (!cell.transparent) expect(equalBytes(cell.pixels, reference.pixels)).toBe(true);
    });
  });

  it('cancels only between complete published cells', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const controller = new AbortController();
    const published: Uint8Array[] = [];
    await expect(
      compilePackedTranscriptBroadSurfaceRgba8V1({
        packedScene: fixture.packed,
        surfaceManifest: fixture.surface,
        signal: controller.signal,
        onCell(cell) {
          published.push(cell.pixels.slice());
          controller.abort();
        },
      })
    ).rejects.toBeInstanceOf(CompiledBroadSurfaceRasterCancelledError);
    expect(published).toHaveLength(1);
    expect(published[0]).toHaveLength(514 * 128 * 4);
  });

  it('uses the admitted DPR lane stride while retaining a one-CSS-pixel support', async () => {
    const fixture = await buildFixture(
      [
        {
          featureIndex: 0,
          lane: 0,
          startBp: 200,
          endBp: 201,
          halfH: 7,
          color: 0x0088ff,
          alpha: 0.85,
          dirSign: 0,
          canonical: true,
        },
      ],
      { finestSpanBp: 1_024, rasterDevicePixelRatio: 3 }
    );
    const cells = await compileAndCapture(fixture);
    const cell = findCell(cells, 'canonical', 0, 0, 0);
    expect(cell.widthPx).toBe(514);
    expect(cell.heightPx).toBe(8 * 16 * 3);
    expect(cell.pixels).toHaveLength(514 * 8 * 16 * 3 * 4);
    const centerY = 7 * 3;
    const supportedColumns = [99, 100, 101, 102, 103].filter((x) => alphaAt(cell, x, centerY) > 0);
    expect(supportedColumns).toEqual([99, 100, 101, 102]);
  });

  it('rejects mismatched source, lane, and section dimensions before publication', async () => {
    const fixture = await buildFixture(SHAPE_SPECS);
    const callback = () => {
      throw new Error('must not publish');
    };
    const wrongGenomeSurface = await buildSurface(fixture.packed, {
      genomeLengthBp: fixture.surface.genomeLengthBp + 1,
    });
    await expect(
      compilePackedTranscriptBroadSurfaceRgba8V1({
        packedScene: fixture.packed,
        surfaceManifest: wrongGenomeSurface,
        onCell: callback,
      })
    ).rejects.toThrow(/genome identity mismatch/);
    const wrongLaneSurface = await buildSurface(fixture.packed, {
      expandedLaneRows: 8,
    });
    await expect(
      compilePackedTranscriptBroadSurfaceRgba8V1({
        packedScene: fixture.packed,
        surfaceManifest: wrongLaneSurface,
        onCell: callback,
      })
    ).rejects.toThrow(/expanded lane identity mismatch/);
    const badPacked = {
      ...fixture.packed,
      manifest: structuredClone(fixture.packed.manifest),
    };
    badPacked.manifest.sections.expandedGlyphs.byteLength -= 4;
    await expect(
      compilePackedTranscriptBroadSurfaceRgba8V1({
        packedScene: badPacked,
        surfaceManifest: fixture.surface,
        onCell: callback,
      })
    ).rejects.toThrow(/expanded glyphs section is invalid/);

    await expect(
      compilePackedTranscriptBroadSurfaceRgba8V1({
        packedScene: fixture.packed,
        surfaceManifest: { ...fixture.surface },
        onCell: callback,
      })
    ).rejects.toThrow(/manifest is invalid/);
  });
});

async function buildFixture(
  specs: readonly PrimitiveSpec[],
  options: {
    assemblyLengthBp?: number;
    finestSpanBp?: number;
    rasterDevicePixelRatio?: 1 | 2 | 3;
  } = {}
): Promise<Fixture> {
  const assemblyLengthBp = options.assemblyLengthBp ?? 1_024;
  const maxFeatureIndex = Math.max(...specs.map((spec) => spec.featureIndex));
  const byFeature = Array.from({ length: maxFeatureIndex + 1 }, (_, featureIndex) => {
    const owned = specs.filter((spec) => spec.featureIndex === featureIndex);
    if (owned.length === 0) throw new Error(`fixture feature ${featureIndex} is absent`);
    return owned;
  });
  const primitives: AnnotationScenePrimitiveV1[] = specs.map((spec) => ({
    startBp: spec.startBp,
    endBp: spec.endBp,
    featureIndex: spec.featureIndex,
    offsetCenter: -7 - spec.lane * 16,
    halfH: spec.halfH,
    color: spec.color,
    alpha: spec.alpha,
    cdsFade: 0,
    dirSign: spec.dirSign,
  }));
  const scene = buildPartitionedTranscriptScene(primitives, 512);
  const interactionFeatures = byFeature.map((owned, featureIndex) => ({
    rendererId: featureIndex,
    startBp: Math.min(...owned.map((spec) => spec.startBp)),
    endBp: Math.max(...owned.map((spec) => spec.endBp)),
    lane: owned[0].lane,
    direction: owned.some((spec) => spec.dirSign < 0) ? ('reverse' as const) : ('forward' as const),
    displayName: `feature-${featureIndex}`,
    type: 'mRNA',
    transcriptId: `TX-${featureIndex}`,
    sourceId: `source-${featureIndex}`,
    canonicalIdentity: `fixture|mRNA|${featureIndex}`,
  }));
  const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
    interactionFeatures,
    scene.sortedPrimitives
  );
  const policyProjection = {
    features: byFeature.map((owned) => {
      const spec = owned[0];
      const canonicalTrackLane = spec.canonical ? spec.lane : null;
      return {
        annotationType: 'mRNA',
        expandedLane: spec.lane,
        expandedTrackLane: spec.lane,
        canonicalLane: canonicalTrackLane,
        canonicalTrackLane,
      };
    }),
    expandedBandOrder: ['mRNA'],
    canonicalBandOrder: ['mRNA'],
  };
  const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
    datasetContract: {
      datasetId: 'rgba8-compiler-fixture',
      datasetVersion: 'v1',
      sourceSha256: 'a'.repeat(64),
    },
    assemblyContract: { assemblyId: 'fixture-assembly', assemblyLengthBp },
    families: [{ id: 'transcript-glyph-v2', kind: 'transcript', metadata: {} }],
    featureFamilyIndices: new Uint32Array(maxFeatureIndex + 1),
    scene,
    interactionIndex,
    policyProjection,
  });
  const surface = await buildSurface(packed, {
    finestSpanBp: options.finestSpanBp,
    rasterDevicePixelRatio: options.rasterDevicePixelRatio,
  });
  return { packed, surface };
}

async function buildSurface(
  packed: PackedPartitionedTranscriptSceneBinaryV4,
  options: {
    genomeLengthBp?: number;
    finestSpanBp?: number;
    rasterDevicePixelRatio?: 1 | 2 | 3;
    canonicalLaneRows?: number;
    expandedLaneRows?: number;
  } = {}
): Promise<CompiledBroadSurfaceManifestV2> {
  const rasterDevicePixelRatio = options.rasterDevicePixelRatio ?? 1;
  return buildCompiledBroadSurfaceManifestV2({
    artifactKey: 'fixture-artifact',
    trackId: 'mRNA',
    genomeLengthBp: options.genomeLengthBp ?? packed.manifest.assemblyContract.assemblyLengthBp,
    broadCorridorFinestSpanBp: options.finestSpanBp ?? 512,
    broadTilePhysicalWidthPx: BROAD_SURFACE_TILE_CONTENT_WIDTH_PX_V2,
    broadTileXGuardPhysicalPx: BROAD_SURFACE_X_FILTER_GUARD_PX_V2,
    prefetchRing: BROAD_SURFACE_PREFETCH_RING_V2,
    maxQualifiedRasterMagnificationX: 1.5,
    rasterDevicePixelRatio,
    laneSlabRowCount: BROAD_SURFACE_LANE_SLAB_ROW_COUNT_V2,
    laneRowCssHeightPx: BROAD_SURFACE_LANE_ROW_CSS_HEIGHT_PX_V2,
    laneRowTextureStridePx: BROAD_SURFACE_LANE_ROW_CSS_HEIGHT_PX_V2 * rasterDevicePixelRatio,
    laneRowTransparentTailGutterPx:
      BROAD_SURFACE_LANE_ROW_TRANSPARENT_TAIL_GUTTER_CSS_PX_V2 * rasterDevicePixelRatio,
    laneRowCounts: {
      canonical:
        options.canonicalLaneRows ??
        Math.min(
          packed.manifest.directContract.canonical.maxTrackLane + 1,
          COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
        ),
      expanded:
        options.expandedLaneRows ??
        Math.min(
          packed.manifest.directContract.expanded.maxTrackLane + 1,
          COMPILED_BROAD_SURFACE_MAX_FINITE_LANE_LIMIT_V2
        ),
    },
  });
}

async function compileAndCapture(fixture: Fixture): Promise<CapturedCell[]> {
  const cells: CapturedCell[] = [];
  await compilePackedTranscriptBroadSurfaceRgba8V1({
    packedScene: fixture.packed,
    surfaceManifest: fixture.surface,
    onCell(cell) {
      cells.push(capture(cell));
    },
  });
  return cells;
}

function capture(cell: CompiledBroadSurfaceRgba8CellV1): CapturedCell {
  return { ...cell, pixels: cell.pixels.slice() };
}

function findCell(
  cells: readonly CapturedCell[],
  mode: BroadSurfaceIsoformModeV2,
  level: number,
  tileX: number,
  slab: number
): CapturedCell {
  const cell = cells.find(
    (candidate) =>
      candidate.isoformMode === mode &&
      candidate.level === level &&
      candidate.tileX === tileX &&
      candidate.laneSlabIndex === slab
  );
  if (!cell) throw new Error(`missing ${mode}/${level}/${tileX}/${slab}`);
  return cell;
}

function pixelAt(cell: CapturedCell, x: number, y: number): [number, number, number, number] {
  const offset = (y * cell.widthPx + x) * 4;
  return [
    cell.pixels[offset],
    cell.pixels[offset + 1],
    cell.pixels[offset + 2],
    cell.pixels[offset + 3],
  ];
}

function alphaAt(cell: CapturedCell, x: number, y: number): number {
  return pixelAt(cell, x, y)[3];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
