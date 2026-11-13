import type { Feature } from '../../../types';

type PathWindow = {
  readonly isArcMode: boolean;
  readonly sequenceVisible: boolean;
  readonly viewStartBp: number;
  readonly viewEndBp: number;
  readonly pixelsPerBp: number;
};

type FeatureBin = number[];
type Range = readonly [number, number];

const TARGET_BIN_COUNT = 4096;
const MIN_BIN_SIZE_BP = 512;
const SCREEN_MARGIN_PX = 64;
const MIN_MARGIN_BP = 32;

function mod(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function featureRanges(feature: Feature, genomeLength: number, circular: boolean): Range[] {
  const start = Math.max(0, Math.min(genomeLength, feature.start));
  const rawEnd = Math.max(0, Math.min(genomeLength, feature.end));
  if (rawEnd > start) return [[start, rawEnd]];
  if (!circular) return [];
  return [
    [start, genomeLength],
    [0, rawEnd],
  ];
}

function intervalOverlapsAnyRange(start: number, end: number, ranges: readonly Range[]): boolean {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (start < range[1] && end > range[0]) return true;
  }
  return false;
}

function featureOverlapsAnyRange(
  feature: Feature,
  ranges: readonly Range[],
  genomeLength: number,
  circular: boolean
): boolean {
  const start = Math.max(0, Math.min(genomeLength, feature.start));
  const rawEnd = Math.max(0, Math.min(genomeLength, feature.end));
  if (rawEnd > start) return intervalOverlapsAnyRange(start, rawEnd, ranges);
  if (!circular) return false;
  return (
    intervalOverlapsAnyRange(start, genomeLength, ranges) ||
    intervalOverlapsAnyRange(0, rawEnd, ranges)
  );
}

function splitQueryRanges(
  startBp: number,
  endBp: number,
  genomeLength: number,
  circular: boolean
): Range[] {
  if (genomeLength <= 0) return [];
  if (!circular) {
    const start = Math.max(0, Math.min(genomeLength, startBp));
    const end = Math.max(0, Math.min(genomeLength, endBp));
    return end > start ? [[start, end]] : [];
  }

  const span = Math.max(0, endBp - startBp);
  if (span >= genomeLength) return [[0, genomeLength]];
  const start = mod(startBp, genomeLength);
  const end = start + span;
  if (end <= genomeLength) return [[start, end]];
  return [
    [start, genomeLength],
    [0, end - genomeLength],
  ];
}

export class FeatureWindowIndex {
  private readonly genomeLength: number;
  private readonly circular: boolean;
  private readonly features: readonly Feature[];
  private readonly bins: FeatureBin[];
  private readonly binSize: number;
  private readonly visitStamp: Uint32Array;
  private queryStamp = 0;

  constructor(params: { genomeLength: number; circular: boolean; features: readonly Feature[] }) {
    this.genomeLength = Math.max(0, params.genomeLength);
    this.circular = params.circular;
    this.features = params.features;
    this.binSize =
      this.genomeLength > 0
        ? Math.max(MIN_BIN_SIZE_BP, Math.ceil(this.genomeLength / TARGET_BIN_COUNT))
        : MIN_BIN_SIZE_BP;
    const binCount =
      this.genomeLength > 0 ? Math.max(1, Math.ceil(this.genomeLength / this.binSize)) : 1;
    this.bins = Array.from({ length: binCount }, () => []);
    this.visitStamp = new Uint32Array(params.features.length);

    params.features.forEach((feature, index) => {
      for (const [start, end] of featureRanges(feature, this.genomeLength, this.circular)) {
        this.addFeatureRange(index, start, end);
      }
    });
  }

  candidatesForPath(
    path: PathWindow,
    subset: readonly Feature[] = this.features,
    screenMarginPx = SCREEN_MARGIN_PX,
    options: { forceWindowing?: boolean } = {}
  ): readonly Feature[] {
    if (
      (!options.forceWindowing && !path.sequenceVisible) ||
      (!options.forceWindowing && !path.isArcMode) ||
      this.genomeLength <= 0 ||
      !Number.isFinite(path.viewStartBp) ||
      !Number.isFinite(path.viewEndBp)
    ) {
      return subset;
    }

    const span = Math.max(0, path.viewEndBp - path.viewStartBp);
    if (span <= 0 || span >= this.genomeLength * 0.7) return subset;

    const pixelsPerBp = Math.max(0.001, path.pixelsPerBp);
    const marginBp = Math.ceil(Math.max(MIN_MARGIN_BP, Math.max(0, screenMarginPx) / pixelsPerBp));
    const expandedStart = path.viewStartBp - marginBp;
    const expandedEnd = path.viewStartBp + span + marginBp;
    const ranges = splitQueryRanges(expandedStart, expandedEnd, this.genomeLength, this.circular);
    if (ranges.length === 0) return subset;

    const subsetIds =
      subset === this.features ? null : new Set(subset.map((feature) => feature.id));
    this.queryStamp = (this.queryStamp + 1) >>> 0 || 1;
    const stamp = this.queryStamp;
    const hits: number[] = [];
    for (const range of ranges) {
      const startBin = Math.max(0, Math.floor(range[0] / this.binSize));
      const endBin = Math.min(
        this.bins.length - 1,
        Math.floor(Math.max(range[0], range[1] - 1) / this.binSize)
      );
      for (let bin = startBin; bin <= endBin; bin++) {
        const members = this.bins[bin];
        for (let member = 0; member < members.length; member += 1) {
          const index = members[member];
          if (this.visitStamp[index] === stamp) continue;
          const feature = this.features[index];
          if (subsetIds && !subsetIds.has(feature.id)) continue;
          if (!featureOverlapsAnyRange(feature, ranges, this.genomeLength, this.circular)) continue;
          this.visitStamp[index] = stamp;
          hits.push(index);
        }
      }
    }

    if (hits.length === 0) return [];
    hits.sort((left, right) => left - right);
    const out: Feature[] = new Array(hits.length);
    for (let position = 0; position < hits.length; position += 1) {
      out[position] = this.features[hits[position]];
    }
    return out;
  }

  private addFeatureRange(index: number, start: number, end: number): void {
    if (end <= start || this.genomeLength <= 0) return;
    const startBin = Math.max(0, Math.floor(start / this.binSize));
    const endBin = Math.min(
      this.bins.length - 1,
      Math.floor(Math.max(start, end - 1) / this.binSize)
    );
    for (let bin = startBin; bin <= endBin; bin++) {
      this.bins[bin].push(index);
    }
  }
}
