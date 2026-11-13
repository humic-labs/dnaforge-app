import type { CoverageGpuAtlas, CoverageGpuAtlasChromosome } from '@waypoint/genome-data';

export const COVERAGE_GPU_ATLAS_CONTRACT = 'coverage-gpu-atlas.v1' as const;
export const COVERAGE_GPU_ATLAS_MAX_CHROMOSOMES = 64;

export interface CoverageGpuAtlasLayerInput {
  readonly chrom: string;
  readonly globalStartBp: number;
  readonly globalEndBp: number;
  readonly binSizeBp: number;
  readonly bins: Float32Array;
}

export interface BuildCoverageGpuAtlasInput {
  readonly sourceIdentity: string;
  readonly assemblyFingerprint: string;
  readonly statistic: string;
  readonly payloadRevision: string;
  readonly assemblyEndBp: number;
  readonly baseBinSizeBp: number;
  readonly depthPercentiles: CoverageGpuAtlas['depthPercentiles'];
  readonly layers: ReadonlyArray<CoverageGpuAtlasLayerInput>;
}

function requireAtlas(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`coverage GPU atlas: ${message}`);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nextPowerOfTwo(value: number): number {
  let out = 1;
  while (out < value) out *= 2;
  return out;
}

function mipRowCount(baseBinCount: number): number {
  let count = baseBinCount;
  let rows = 1;
  while (count > 1) {
    count = Math.ceil(count / 2);
    rows += 1;
  }
  return rows;
}

function validatePercentiles(percentiles: CoverageGpuAtlas['depthPercentiles']): void {
  const values = [
    percentiles.p50,
    percentiles.p90,
    percentiles.p95,
    percentiles.p99,
    percentiles.max,
  ];
  requireAtlas(
    values.every((value) => Number.isFinite(value) && value >= 0),
    'invalid depth scale'
  );
  requireAtlas(
    percentiles.p50 <= percentiles.p90 &&
      percentiles.p90 <= percentiles.p95 &&
      percentiles.p95 <= percentiles.p99 &&
      percentiles.p99 <= percentiles.max,
    'depth percentiles are not monotone'
  );
}

export function buildCoverageGpuAtlas(input: BuildCoverageGpuAtlasInput): CoverageGpuAtlas {
  requireAtlas(input.sourceIdentity.length > 0, 'anonymous source identity');
  requireAtlas(input.assemblyFingerprint.length > 0, 'anonymous assembly identity');
  requireAtlas(input.statistic.length > 0, 'anonymous statistic');
  requireAtlas(input.payloadRevision.length > 0, 'anonymous payload revision');
  requireAtlas(positiveSafeInteger(input.assemblyEndBp), 'invalid assembly end');
  requireAtlas(positiveSafeInteger(input.baseBinSizeBp), 'invalid base bin size');
  requireAtlas(
    input.layers.length > 0 && input.layers.length <= COVERAGE_GPU_ATLAS_MAX_CHROMOSOMES,
    'invalid chromosome count'
  );
  validatePercentiles(input.depthPercentiles);

  let expectedStart = 0;
  let maxBins = 0;
  let textureHeight = 0;
  const seen = new Set<string>();
  for (const layer of input.layers) {
    requireAtlas(layer.chrom.trim().length > 0 && !seen.has(layer.chrom), 'duplicate chromosome');
    seen.add(layer.chrom);
    requireAtlas(
      layer.globalStartBp === expectedStart &&
        Number.isSafeInteger(layer.globalEndBp) &&
        layer.globalEndBp > layer.globalStartBp,
      'layers must exactly and contiguously cover the ordered assembly'
    );
    requireAtlas(layer.binSizeBp === input.baseBinSizeBp, 'mixed base resolutions');
    const expectedBins = Math.ceil((layer.globalEndBp - layer.globalStartBp) / input.baseBinSizeBp);
    requireAtlas(
      layer.bins.length === expectedBins && expectedBins > 0,
      'layer bin count mismatch'
    );
    for (const value of layer.bins) {
      requireAtlas(Number.isFinite(value) && value >= 0, 'non-finite or negative depth');
    }
    expectedStart = layer.globalEndBp;
    maxBins = Math.max(maxBins, expectedBins);
    textureHeight += mipRowCount(expectedBins);
  }
  requireAtlas(expectedStart === input.assemblyEndBp, 'partial assembly authority');

  const textureWidth = nextPowerOfTwo(maxBins);
  requireAtlas(
    Number.isSafeInteger(textureWidth * textureHeight) && textureWidth * textureHeight > 0,
    'texture dimensions overflow'
  );
  const data = new Float32Array(textureWidth * textureHeight);
  const chromosomes: CoverageGpuAtlasChromosome[] = [];
  let row = 0;
  for (const layer of input.layers) {
    const rowStart = row;
    let source = layer.bins;
    data.set(source, row * textureWidth);
    row += 1;
    while (source.length > 1) {
      const pooled = new Float32Array(Math.ceil(source.length / 2));
      for (let index = 0; index < pooled.length; index += 1) {
        const left = source[index * 2] ?? 0;
        const rightIndex = index * 2 + 1;
        pooled[index] = rightIndex < source.length ? (left + source[rightIndex]!) * 0.5 : left;
      }
      data.set(pooled, row * textureWidth);
      source = pooled;
      row += 1;
    }
    chromosomes.push(
      Object.freeze({
        chrom: layer.chrom,
        globalStartBp: layer.globalStartBp,
        globalEndBp: layer.globalEndBp,
        baseBinCount: layer.bins.length,
        rowStart,
        rowCount: row - rowStart,
      })
    );
  }

  const authorityKey = JSON.stringify([
    COVERAGE_GPU_ATLAS_CONTRACT,
    input.sourceIdentity,
    input.assemblyFingerprint,
    input.statistic,
    input.payloadRevision,
  ]);
  return Object.freeze({
    contract: COVERAGE_GPU_ATLAS_CONTRACT,
    authorityKey,
    sourceIdentity: input.sourceIdentity,
    assemblyFingerprint: input.assemblyFingerprint,
    statistic: input.statistic,
    payloadRevision: input.payloadRevision,
    assemblyStartBp: 0,
    assemblyEndBp: input.assemblyEndBp,
    baseBinSizeBp: input.baseBinSizeBp,
    textureWidth,
    textureHeight,
    data,
    depthPercentiles: Object.freeze({ ...input.depthPercentiles }),
    chromosomes: Object.freeze(chromosomes),
  });
}

export function coverageGpuAtlasEligible(
  atlas: CoverageGpuAtlas,
  spanBp: number,
  viewportPx: number
): boolean {
  return (
    atlas.contract === COVERAGE_GPU_ATLAS_CONTRACT &&
    spanBp > 0 &&
    viewportPx > 0 &&
    atlas.baseBinSizeBp * viewportPx <= spanBp
  );
}

export function coverageGpuAtlasMipLevel(
  atlas: CoverageGpuAtlas,
  spanBp: number,
  viewportPx: number,
  chromosome: CoverageGpuAtlasChromosome
): number {
  const bpPerPixel = spanBp / Math.max(1, viewportPx);
  const physical = Math.max(1, bpPerPixel / atlas.baseBinSizeBp);
  return Math.min(chromosome.rowCount - 1, Math.max(0, Math.floor(Math.log2(physical))));
}

export function coverageGpuAtlasChromosomeAt(
  atlas: CoverageGpuAtlas,
  bp: number
): CoverageGpuAtlasChromosome | null {
  let low = 0;
  let high = atlas.chromosomes.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (atlas.chromosomes[mid]!.globalEndBp <= bp) low = mid + 1;
    else high = mid;
  }
  const chromosome = atlas.chromosomes[low];
  return chromosome && bp >= chromosome.globalStartBp && bp < chromosome.globalEndBp
    ? chromosome
    : null;
}

export function sampleCoverageGpuAtlas(
  atlas: CoverageGpuAtlas,
  bp: number,
  spanBp: number,
  viewportPx: number,
  fixedChromosome?: CoverageGpuAtlasChromosome
): number {
  const chromosome = fixedChromosome ?? coverageGpuAtlasChromosomeAt(atlas, bp);
  if (!chromosome) return 0;
  const physical = Math.max(1, spanBp / Math.max(1, viewportPx) / atlas.baseBinSizeBp);
  const continuousLevel = Math.min(chromosome.rowCount - 1, Math.max(0, Math.log2(physical)));
  const level0 = Math.floor(continuousLevel);
  const level1 = Math.min(chromosome.rowCount - 1, level0 + 1);
  const mix = continuousLevel - level0;
  const sampleLevel = (level: number): number => {
    const binSize = atlas.baseBinSizeBp * 2 ** level;
    const count = Math.ceil(chromosome.baseBinCount / 2 ** level);
    const clampedBp = Math.max(
      chromosome.globalStartBp,
      Math.min(chromosome.globalEndBp - Number.EPSILON, bp)
    );
    const position = (clampedBp - chromosome.globalStartBp) / binSize - 0.5;
    let index0 = Math.floor(position);
    let fraction = position - index0;
    if (index0 < 0) {
      index0 = 0;
      fraction = 0;
    } else if (index0 >= count - 1) {
      index0 = count - 1;
      fraction = 0;
    }
    const index1 = Math.min(count - 1, index0 + 1);
    const row = (chromosome.rowStart + level) * atlas.textureWidth;
    const left = atlas.data[row + index0] ?? 0;
    const right = atlas.data[row + index1] ?? left;
    return left + (right - left) * fraction;
  };
  const left = sampleLevel(level0);
  return left + (sampleLevel(level1) - left) * mix;
}

export function sampleCoverageGpuAtlasSmoothed(
  atlas: CoverageGpuAtlas,
  bp: number,
  spanBp: number,
  viewportPx: number
): number {
  const chromosome = coverageGpuAtlasChromosomeAt(atlas, bp);
  if (!chromosome) return 0;
  const bpPerPixel = spanBp / Math.max(1, viewportPx);
  const weights = [0.06, 0.24, 0.4, 0.24, 0.06] as const;
  let depth = 0;
  for (let tap = -2; tap <= 2; tap += 1) {
    depth +=
      sampleCoverageGpuAtlas(atlas, bp + tap * bpPerPixel, spanBp, viewportPx, chromosome) *
      weights[tap + 2]!;
  }
  return depth;
}

export function coverageGpuAtlasLogColorFill(
  depth: number,
  cutoffDepth: number,
  maximumDepth: number,
  maxFill: number
): number {
  if (!(depth > 0) || !(maxFill > 0)) return 0;
  const knee = Math.max(1, cutoffDepth);
  if (depth <= knee) return maxFill * 0.55 * Math.max(0, Math.min(1, depth / knee));
  const maximum = Math.max(knee + 1, maximumDepth);
  const position = Math.max(0, Math.min(1, Math.log(depth / knee) / Math.log(maximum / knee)));
  return maxFill * Math.max(0, Math.min(1, 0.55 + 0.45 * position));
}

export function coverageGpuAtlasHeightCutoffFill(
  depth: number,
  cutoffDepth: number,
  maxFill: number
): number {
  if (!(depth > 0) || !(cutoffDepth > 0) || !(maxFill > 0)) return 0;
  return (
    maxFill * Math.max(0, Math.min(1, Math.log1p(depth) / Math.log1p(Math.max(1, cutoffDepth))))
  );
}

export function coverageGpuAtlasEdgeCoverage(
  fill: number,
  bandY: number,
  bandHeightCssPx: number,
  rendererResolution = 1
): number {
  if (
    !Number.isFinite(fill) ||
    !Number.isFinite(bandY) ||
    !Number.isFinite(bandHeightCssPx) ||
    !Number.isFinite(rendererResolution) ||
    bandHeightCssPx <= 0 ||
    rendererResolution <= 0
  ) {
    return 0;
  }
  const edgeDistancePx = (fill - bandY) * bandHeightCssPx * rendererResolution;
  return Math.max(0, Math.min(1, edgeDistancePx + 0.5));
}
