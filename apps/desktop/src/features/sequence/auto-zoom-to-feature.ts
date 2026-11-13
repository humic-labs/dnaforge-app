export interface ViewportRange {
  start: number;
  end: number;
}

const MIN_OCCUPANCY = 0.01;
const MAX_OCCUPANCY = 0.5;
const TARGET_OCCUPANCY = 0.3;
const MIN_VIEWPORT_BP = 10;

export interface AutoZoomInput {
  featureStart: number;
  featureEnd: number;
  viewport: ViewportRange;
  genomeLength: number;
}

export function autoZoomToFeature(input: AutoZoomInput): ViewportRange {
  const featureStart = Math.max(0, Math.floor(input.featureStart));
  const featureEnd = Math.max(featureStart + 1, Math.ceil(input.featureEnd));
  const featureWidth = featureEnd - featureStart;
  const viewportWidth = Math.max(1, input.viewport.end - input.viewport.start);
  const occupancy = featureWidth / viewportWidth;

  let newWidth = viewportWidth;
  if (occupancy < MIN_OCCUPANCY) {
    newWidth = featureWidth / TARGET_OCCUPANCY;
  } else if (occupancy > MAX_OCCUPANCY) {
    newWidth = featureWidth / TARGET_OCCUPANCY;
  } else {
    newWidth = viewportWidth;
  }

  newWidth = Math.max(MIN_VIEWPORT_BP, Math.floor(newWidth));
  newWidth = Math.min(newWidth, Math.max(featureWidth + 2, Math.floor(input.genomeLength)));

  const featureCenter = (featureStart + featureEnd) / 2;
  let start = Math.floor(featureCenter - newWidth / 2);
  let end = start + newWidth;

  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > input.genomeLength) {
    const overflow = end - input.genomeLength;
    end = input.genomeLength;
    start = Math.max(0, start - overflow);
  }
  return { start, end };
}
