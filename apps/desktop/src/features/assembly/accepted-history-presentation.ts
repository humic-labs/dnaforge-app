import type { BackboneSegment } from '@waypoint/plasmid-viewer';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';
import { acceptedProductRegionPositions } from './accepted-product-layout';
import {
  ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
  getAssemblyBackboneProvenanceStyleForRegion,
  getAssemblySpacerProvenanceStyle,
  type AssemblyColorSchemeId,
} from '../design/public/colors';

export function acceptedHistoryBackboneSegments(
  entry: AcceptedAssemblySidecarPayload,
  currentProduct: string,
  hoveredPartIndex: number | null,
  schemeId: AssemblyColorSchemeId
): BackboneSegment[] | undefined {
  const input = entry.projectionInput;
  if (
    !input.productSequence ||
    input.productSequence.toUpperCase() !== currentProduct.toUpperCase()
  )
    return undefined;
  const positions = acceptedProductRegionPositions(input);
  const segments: BackboneSegment[] = [];
  input.regions.forEach((region, index) => {
    const position = positions[index];
    segments.push({
      ...position,
      regionId: region.id,
      label: region.sourceSequenceName,
      ...getAssemblyBackboneProvenanceStyleForRegion(
        region,
        index,
        { hovered: index === hoveredPartIndex },
        schemeId
      ),
      rulerStrokeWidth: ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
    });
    const spacer = input.spacers.find((candidate) => candidate.junctionIndex === index);
    if (spacer?.sequence.length) {
      segments.push({
        start: position.end,
        end: position.end + spacer.sequence.length,
        label: spacer.name || 'Spacer',
        ...getAssemblySpacerProvenanceStyle(),
        rulerStrokeWidth: ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
      });
    }
  });
  return segments;
}

export function acceptedAssemblyJunctionIndicators(
  entry: AcceptedAssemblySidecarPayload,
  segments: readonly BackboneSegment[]
): Array<{ position: number; leftColor?: string; rightColor?: string }> {
  const input = entry.projectionInput;
  const positions = acceptedProductRegionPositions(input);
  const colors = input.regions.map(
    (region) => segments.find((segment) => segment.regionId === region.id)?.color
  );
  if (colors.length === 0 || colors.some((color) => !color)) return [];

  const indicators: Array<{ position: number; leftColor?: string; rightColor?: string }> = [];
  for (let index = 0; index < positions.length - 1; index++) {
    const end = positions[index].end;
    const nextStart = positions[index + 1].start;
    const spacer = segments.find((segment) => !segment.regionId && segment.start === end);
    if (nextStart > end && spacer) {
      indicators.push({ position: end, leftColor: colors[index], rightColor: spacer.color });
      indicators.push({
        position: nextStart,
        leftColor: spacer.color,
        rightColor: colors[index + 1],
      });
    } else {
      indicators.push({ position: end, leftColor: colors[index], rightColor: colors[index + 1] });
    }
  }

  const last = positions.length - 1;
  const lastEnd = positions[last].end;
  if (input.topology === 'circular') {
    const closureSpacer = segments.find(
      (segment) => !segment.regionId && segment.start === lastEnd
    );
    if (lastEnd < input.productSequence.length && closureSpacer) {
      indicators.push({
        position: lastEnd,
        leftColor: colors[last],
        rightColor: closureSpacer.color,
      });
      indicators.push({ position: 0, leftColor: closureSpacer.color, rightColor: colors[0] });
    } else {
      indicators.push({ position: 0, leftColor: colors[last], rightColor: colors[0] });
    }
  } else {
    indicators.unshift({ position: 0, rightColor: colors[0] });
    indicators.push({ position: input.productSequence.length, leftColor: colors[last] });
  }
  return indicators;
}
