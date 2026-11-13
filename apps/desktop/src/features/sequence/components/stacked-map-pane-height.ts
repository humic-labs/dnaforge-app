interface FeatureSpan {
  start: number;
  end: number;
}

interface SuggestedStackedMapPaneHeightInput {
  viewportHeight: number;
  sequenceLength: number;
  circular: boolean;
  features: readonly FeatureSpan[];
  primers: number;
}

const MIN_MAP_PANE_HEIGHT = 180;
const MIN_SEQUENCE_PANE_HEIGHT = 96;
const RESIZE_HANDLE_HEIGHT = 4;
const MAX_COUNTED_ANNOTATION_LANES = 8;

function maximumAnnotationOverlap(
  features: readonly FeatureSpan[],
  sequenceLength: number
): number {
  if (features.length === 0) return 0;
  if (features.length > 5_000) return MAX_COUNTED_ANNOTATION_LANES;
  if (!Number.isFinite(sequenceLength) || sequenceLength < 1) return 0;

  const events: Array<{ position: number; change: number }> = [];
  const addSpan = (start: number, end: number) => {
    events.push({ position: start, change: 1 });
    events.push({ position: end + 1, change: -1 });
  };
  for (const feature of features) {
    if (!Number.isFinite(feature.start) || !Number.isFinite(feature.end)) continue;
    const start = Math.max(1, Math.min(sequenceLength, Math.floor(feature.start)));
    const end = Math.max(1, Math.min(sequenceLength, Math.floor(feature.end)));
    if (start <= end) {
      addSpan(start, end);
    } else {
      addSpan(start, sequenceLength);
      addSpan(1, end);
    }
  }
  events.sort((a, b) => a.position - b.position);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.change;
    maximum = Math.max(maximum, active);
  }
  return Math.min(MAX_COUNTED_ANNOTATION_LANES, maximum);
}

export function suggestedStackedMapPaneHeight({
  viewportHeight,
  sequenceLength,
  circular,
  features,
  primers,
}: SuggestedStackedMapPaneHeightInput): number {
  const overlappingLanes = maximumAnnotationOverlap(features, sequenceLength);
  const coreHeight = circular ? 280 : 220;
  const annotationHeight = overlappingLanes > 0 ? 110 + overlappingLanes * 22 : 0;
  const primerHeight = Math.min(3, Math.max(0, primers)) * 12;
  const neededHeight = coreHeight + annotationHeight + primerHeight;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return Math.max(MIN_MAP_PANE_HEIGHT, neededHeight);
  }
  const maximumHeight = Math.max(
    MIN_MAP_PANE_HEIGHT,
    viewportHeight - MIN_SEQUENCE_PANE_HEIGHT - RESIZE_HANDLE_HEIGHT
  );
  return Math.min(maximumHeight, Math.max(MIN_MAP_PANE_HEIGHT, neededHeight));
}
