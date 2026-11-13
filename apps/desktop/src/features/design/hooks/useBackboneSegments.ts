import { useMemo } from 'react';
import {
  getAssemblyBackboneProvenanceStyleForRegion,
  ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
  getAssemblySpacerProvenanceStyle,
  getAssemblyVisualizationHexForRegion,
  type AssemblyColorSchemeId,
} from '../colors';
import { useAssemblyColorScheme } from '../color-scheme-store';
import type { DesignRegion, SequenceDesign } from '../types';
import { getEffectiveDesignRegions } from '../restriction-digest';
import { selectAssemblyBoundaryMap } from '../assembly-boundaries';
import { deriveGoldenGateSlotEnds } from '../golden-gate-schema';
import { schemaSlotForRegion, schemaSlotIndexForRegion } from '../assembly-slots';
import { selectGoldenGateDigestEnd } from '../golden-gate-scar-preview';

interface AssemblyJunctionPosition {
  kind: 'junction';
  position: number;
  insertIndex: number;
  junctionIndex: number;
}

interface AssemblyTerminalPosition {
  kind: 'terminal';
  position: number;
  insertIndex: number;
}

export type JunctionPosition = AssemblyJunctionPosition | AssemblyTerminalPosition;

export interface AssemblyMapPartRange {
  start: number;
  end: number;
  regionId: string;
  regionIndex: number;
}

export interface BackboneSegment {
  start: number;
  end: number;
  color: string;
  label: string;
  strokeWidth?: number;
  rulerStrokeWidth?: number;
  alpha?: number;
  themeStableColor?: boolean;
  regionId?: string;
  scaffold?: import('@waypoint/sequence-utils').AssemblyScaffold;
}

export interface JunctionIndicator {
  position: number;
  leftColor?: string;
  rightColor?: string;
}

interface UseBackboneSegmentsOptions {
  design: SequenceDesign | undefined;
  hoveredSegmentIndex: number | null;
}

interface UseBackboneSegmentsReturn {
  backboneSegments: BackboneSegment[] | undefined;
  junctionIndicators: JunctionIndicator[] | undefined;
  junctionPositions: JunctionPosition[];
  partRanges: AssemblyMapPartRange[];
}

function getRegionColor(
  region: DesignRegion | undefined,
  fallbackIndex: number,
  assemblyColorScheme: AssemblyColorSchemeId
): string {
  return getAssemblyVisualizationHexForRegion(region, fallbackIndex, assemblyColorScheme);
}

const SPACER_STYLE = getAssemblySpacerProvenanceStyle();
const SPACER_COLOR = SPACER_STYLE.color;

export function useBackboneSegments({
  design,
  hoveredSegmentIndex,
}: UseBackboneSegmentsOptions): UseBackboneSegmentsReturn {
  const assemblyColorScheme = useAssemblyColorScheme();

  return useMemo(() => {
    if (!design || design.regions.length === 0) {
      return {
        backboneSegments: undefined,
        junctionIndicators: undefined,
        junctionPositions: [],
        partRanges: [],
      };
    }

    const segments: BackboneSegment[] = [];
    const junctions: JunctionIndicator[] = [];
    const positions: JunctionPosition[] = [];
    const partRanges: AssemblyMapPartRange[] = [];
    const displayRegions = getEffectiveDesignRegions(design);

    const boundariesByJunction = selectAssemblyBoundaryMap(design);

    let position = 0;
    displayRegions.forEach((region, index) => {
      partRanges.push({
        start: position,
        end: position + region.sequence.length,
        regionId: region.id,
        regionIndex: index,
      });
      const isHovered = hoveredSegmentIndex === index;
      const style = getAssemblyBackboneProvenanceStyleForRegion(
        region,
        index,
        {
          hovered: isHovered,
        },
        assemblyColorScheme
      );
      const color = style.color;
      const schemaSlot = schemaSlotForRegion(design, region);
      const precedingIndex =
        index > 0 ? index - 1 : design.topology === 'circular' ? design.regions.length - 1 : -1;
      const followingIndex =
        index + 1 < design.regions.length ? index + 1 : design.topology === 'circular' ? 0 : -1;
      const scaffold =
        region.isPlaceholder && schemaSlot && design.goldenGateSchema
          ? {
              slotId: schemaSlot.id,
              slotIndex: index,
              label: schemaSlot.label,
              enzyme: design.goldenGateConfig?.enzyme,
              ...deriveGoldenGateSlotEnds(
                design.goldenGateSchema,
                schemaSlotIndexForRegion(design, region),
                design.topology
              ),
              exposedDigestEnds: {
                preceding: boundariesByJunction.get(precedingIndex)?.spacer?.sequence.length
                  ? undefined
                  : selectGoldenGateDigestEnd(design, precedingIndex, 'downstream'),
                following: boundariesByJunction.get(index)?.spacer?.sequence.length
                  ? undefined
                  : selectGoldenGateDigestEnd(design, followingIndex, 'upstream'),
              },
            }
          : undefined;
      segments.push({
        start: position,
        end: position + region.sequence.length,
        regionId: region.id,
        color: style.color,
        label: `${region.sourceSequenceName} [${region.sourceStart + 1}-${region.sourceEnd}]`,
        strokeWidth: style.strokeWidth,
        rulerStrokeWidth: ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
        alpha: style.alpha,
        themeStableColor: style.themeStableColor,
        scaffold,
      });

      position += region.sequence.length;

      const spacerLen = boundariesByJunction.get(index)?.spacer?.sequence.length ?? 0;

      if (index < displayRegions.length - 1) {
        const nextColor = getRegionColor(displayRegions[index + 1], index + 1, assemblyColorScheme);

        if (spacerLen > 0) {
          junctions.push({ position, leftColor: color, rightColor: SPACER_COLOR });

          segments.push({
            start: position,
            end: position + spacerLen,
            color: SPACER_STYLE.color,
            label: `Spacer (${spacerLen}bp)`,
            strokeWidth: SPACER_STYLE.strokeWidth,
            rulerStrokeWidth: ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
            alpha: SPACER_STYLE.alpha,
            themeStableColor: SPACER_STYLE.themeStableColor,
          });

          position += spacerLen;
          junctions.push({ position, leftColor: SPACER_COLOR, rightColor: nextColor });
        } else {
          junctions.push({ position, leftColor: color, rightColor: nextColor });
        }
        positions.push({
          kind: 'junction',
          position,
          insertIndex: index + 1,
          junctionIndex: index,
        });
      } else {
        if (spacerLen > 0) {
          segments.push({
            start: position,
            end: position + spacerLen,
            color: SPACER_STYLE.color,
            label: `Spacer (${spacerLen}bp)`,
            strokeWidth: SPACER_STYLE.strokeWidth,
            rulerStrokeWidth: ASSEMBLY_RULER_PROVENANCE_STROKE_WIDTH,
            alpha: SPACER_STYLE.alpha,
            themeStableColor: SPACER_STYLE.themeStableColor,
          });
        }
        position += spacerLen;
      }
    });

    if (displayRegions.length > 0) {
      const firstColor = getRegionColor(displayRegions[0], 0, assemblyColorScheme);
      const lastColor = getRegionColor(
        displayRegions[displayRegions.length - 1],
        displayRegions.length - 1,
        assemblyColorScheme
      );

      if (design.topology === 'circular') {
        const closureSpacerLen =
          boundariesByJunction.get(displayRegions.length - 1)?.spacer?.sequence.length ?? 0;
        if (closureSpacerLen > 0) {
          junctions.push({
            position: position - closureSpacerLen,
            leftColor: lastColor,
            rightColor: SPACER_COLOR,
          });
          junctions.push({ position: 0, leftColor: SPACER_COLOR, rightColor: firstColor });
        } else {
          junctions.push({ position: 0, leftColor: lastColor, rightColor: firstColor });
        }
        positions.push({
          kind: 'junction',
          position: 0,
          insertIndex: 0,
          junctionIndex: displayRegions.length - 1,
        });
      } else {
        junctions.push({ position: 0, rightColor: firstColor });
        positions.push({ kind: 'terminal', position: 0, insertIndex: 0 });
        junctions.push({ position, leftColor: lastColor });
        positions.push({ kind: 'terminal', position, insertIndex: displayRegions.length });
      }
    }

    return {
      backboneSegments: segments,
      junctionIndicators: junctions,
      junctionPositions: positions,
      partRanges,
    };
  }, [assemblyColorScheme, design, hoveredSegmentIndex]);
}
