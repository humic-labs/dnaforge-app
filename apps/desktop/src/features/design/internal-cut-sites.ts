import type { AssemblyIssue } from '../assembly/public/issues/assembly-issues';
import { selectAssemblyBoundaryMap } from './assembly-boundaries';
import { getEffectiveDesignRegions } from './restriction-digest';
import type { SequenceDesign } from './types';
import { INTERNAL_CUT_SITE_STYLE } from '@waypoint/sequence-utils';
import type { ColoredCutSite, RestrictionEnzyme } from '@waypoint/sequence-utils';

export function regionComposedOffsets(design: SequenceDesign): Map<string, number> {
  const displayRegions = getEffectiveDesignRegions(design);
  const boundariesByJunction = selectAssemblyBoundaryMap(design);
  const offsets = new Map<string, number>();
  let position = 0;
  displayRegions.forEach((region, index) => {
    offsets.set(region.id, position);
    position += region.sequence.length;
    position += boundariesByJunction.get(index)?.spacer?.sequence.length ?? 0;
  });
  return offsets;
}

export interface InternalCutSiteMarker {
  id: string;
  regionId: string;
  start: number;
  end: number;
  strand: 'forward' | 'reverse';
}

export function collectInternalCutSiteMarkers(
  design: SequenceDesign,
  issues: readonly AssemblyIssue[]
): InternalCutSiteMarker[] {
  const offsets = regionComposedOffsets(design);
  const markers: InternalCutSiteMarker[] = [];
  for (const issue of issues) {
    if (issue.kind !== 'gg-internal-site' || !issue.internalSites) continue;
    if (issue.scope.type !== 'part') continue;
    const regionId = issue.scope.regionId;
    const regionStart = offsets.get(regionId);
    if (regionStart === undefined) continue;
    for (const site of issue.internalSites) {
      markers.push({
        id: `internal-cut-site:${regionId}:${site.start}:${site.strand}`,
        regionId,
        start: regionStart + site.start,
        end: regionStart + site.end,
        strand: site.strand,
      });
    }
  }
  return markers.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function markerScrollPosition(marker: InternalCutSiteMarker): number {
  return marker.start + 1;
}

export function markerHighlightRange(marker: InternalCutSiteMarker): {
  start: number;
  end: number;
  wraps: false;
} {
  return { start: marker.start, end: marker.end - 1, wraps: false };
}

function internalMarkerEnzyme(
  name: string,
  recognition: string,
  cutPositionTop: number,
  cutPositionBottom: number
): RestrictionEnzyme {
  return {
    name,
    recognition_sequence: recognition,
    recognition_sequence_length: recognition.length,
    cut_position_top: cutPositionTop,
    cut_position_bottom: cutPositionBottom,
    overhang_type: '5_prime',
    overhang_length: cutPositionBottom - cutPositionTop,
    enzyme_type: 'Type_IIS',
    prototype: null,
    source_organism: null,
    methylation_site: null,
    methylation_sensitivity: null,
    optimal_temperature: null,
    heat_inactivation: null,
    suppliers: [],
    rebase_id: null,
    isoschizomers: [],
    neoschizomers: [],
  };
}

export interface InternalCutGeometry {
  cutPositionTop: number;
  cutPositionBottom: number;
}

export function internalCutSiteMarkersToColoredCutSites(
  markers: InternalCutSiteMarker[],
  enzymeName: string,
  recognitionSequence: string,
  cutGeometry: InternalCutGeometry
): ColoredCutSite[] {
  const { cutPositionTop: cpt, cutPositionBottom: cpb } = cutGeometry;
  const enzyme = internalMarkerEnzyme(enzymeName, recognitionSequence, cpt, cpb);
  return markers.map((marker) => {
    const { cutPositionTop, cutPositionBottom } =
      marker.strand === 'forward'
        ? { cutPositionTop: marker.start + cpt, cutPositionBottom: marker.start + cpb }
        : { cutPositionTop: marker.end - cpb, cutPositionBottom: marker.end - cpt };
    return {
      enzyme,
      cutPositionTop,
      cutPositionBottom,
      recognitionStart: marker.start,
      recognitionEnd: marker.end,
      strand: marker.strand,
      color: INTERNAL_CUT_SITE_STYLE.colorHex,
      isInternalCutSite: true,
    };
  });
}

export function stepCutSiteIndex(
  count: number,
  current: number | null,
  direction: 'next' | 'prev'
): number | null {
  if (count <= 0) return null;
  if (current === null || current < 0 || current >= count) {
    return direction === 'next' ? 0 : count - 1;
  }
  return direction === 'next' ? (current + 1) % count : (current - 1 + count) % count;
}
