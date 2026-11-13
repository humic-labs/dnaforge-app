import type { CodonDisplay } from '@waypoint/sequence-utils';

export interface HoveredFeatureFacts {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly direction?: number;
  readonly segments?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

function arrowFor(direction: number | undefined): string {
  if (direction === 1) return ' →';
  if (direction === -1) return ' ←';
  return '';
}

function spanOf(feature: HoveredFeatureFacts): number {
  return Math.max(0, feature.end - feature.start + 1);
}

function codingLengthOf(feature: HoveredFeatureFacts): number {
  const segments = feature.segments;
  if (!segments || segments.length === 0) return spanOf(feature);
  let total = 0;
  for (const segment of segments) total += Math.max(0, segment.end - segment.start + 1);
  return total;
}

export function featureSummaryLine(feature: HoveredFeatureFacts): string {
  const coding = codingLengthOf(feature);
  const span = spanOf(feature);
  const length =
    coding === span
      ? `${coding.toLocaleString()} bp`
      : `${coding.toLocaleString()} bp (${span.toLocaleString()} bp span)`;
  return `${feature.type} • ${length}${arrowFor(feature.direction)}`;
}

export function cdsRegionHoverLine(
  feature: HoveredFeatureFacts,
  position: number | null,
  sequenceLength: number
): string | null {
  if (
    feature.type !== 'CDS' ||
    !feature.segments ||
    feature.segments.length < 2 ||
    position === null ||
    !Number.isInteger(position) ||
    sequenceLength <= 0 ||
    position < 0 ||
    position >= sequenceLength
  )
    return null;
  const exons = [...feature.segments].sort(
    (a, b) =>
      ((a.start - feature.start + sequenceLength) % sequenceLength) -
      ((b.start - feature.start + sequenceLength) % sequenceLength)
  );
  const contains = (start: number, end: number) =>
    start <= end ? position >= start && position <= end : position >= start || position <= end;
  for (let i = 0; i < exons.length; i++) {
    if (contains(exons[i].start - 1, exons[i].end - 1))
      return `Exon ${feature.direction === -1 ? exons.length - i : i + 1}`;
  }
  const introns = exons.slice(0, -1).flatMap((exon, i) => {
    const start = exon.end % sequenceLength;
    const nextStart = exons[i + 1].start - 1;
    return start === nextStart
      ? []
      : [{ start, end: (nextStart - 1 + sequenceLength) % sequenceLength }];
  });
  for (let i = 0; i < introns.length; i++) {
    if (contains(introns[i].start, introns[i].end))
      return `Intron ${feature.direction === -1 ? introns.length - i : i + 1}`;
  }
  return null;
}

export function codonNameLine(display: CodonDisplay | undefined | null): string | null {
  if (!display) return null;
  const name = (display as CodonDisplay & { name?: string }).name;
  if (!name) return null;
  return name === display.short ? name : `${display.short} • ${name}`;
}
