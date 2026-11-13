import { selectProductLayout } from './assembly-boundaries';
import { isRestrictionDigestRegion } from './restriction-digest';
import type { SequenceDesign } from './types';

export function selectGoldenGateDigestEnd(
  design: SequenceDesign,
  regionIndex: number,
  end: 'upstream' | 'downstream'
) {
  const region = design.regions[regionIndex];
  if (
    design.assemblyMethod !== 'goldengate' ||
    !region?.sequence.length ||
    region.isPlaceholder ||
    !isRestrictionDigestRegion(region)
  )
    return undefined;
  const overhang = region.rdOverhangs?.[end] ?? region.rdEnds?.[end]?.overhang;
  const kind = region.rdEnds?.[end]?.overhangType;
  if (!overhang || kind === '3_prime' || kind === 'blunt') return undefined;
  if (end === 'upstream' && !region.sequence.toUpperCase().startsWith(overhang.toUpperCase()))
    return undefined;
  return {
    overhang: end === 'upstream' ? region.sequence.slice(0, overhang.length) : overhang,
    enzyme: region.rdSourceEnzymeName ?? region.rdSourceEnzyme ?? design.goldenGateConfig?.enzyme,
    junctionIndex:
      end === 'downstream'
        ? regionIndex
        : regionIndex > 0
          ? regionIndex - 1
          : design.topology === 'circular'
            ? design.regions.length - 1
            : undefined,
  };
}

export interface GoldenGateScarPreview {
  junctionIndex?: number;
  overhangStart: number;
  overhang: string;
  enzyme?: string;
}

export function selectGoldenGateScarPreviews(design: SequenceDesign): GoldenGateScarPreview[] {
  if (design.assemblyMethod !== 'goldengate') return [];
  const previews = new Map<number, GoldenGateScarPreview>(
    (design.goldenGateJunctions ?? []).map((junction) => [
      junction.junctionIndex,
      {
        junctionIndex: junction.junctionIndex,
        overhangStart: junction.overhangStart,
        overhang: junction.overhang,
        enzyme: design.goldenGateConfig?.enzyme,
      },
    ])
  );
  for (const segment of selectProductLayout(design)) {
    if (segment.kind !== 'part') continue;
    const { regionIndex } = segment;
    const upstream = selectGoldenGateDigestEnd(design, regionIndex, 'upstream');
    if (!upstream) continue;
    const { junctionIndex } = upstream;
    previews.set(junctionIndex ?? -1, {
      junctionIndex,
      overhangStart: segment.start,
      overhang: upstream.overhang,
      enzyme: upstream.enzyme,
    });
  }
  return [...previews.values()].sort((a, b) => (a.junctionIndex ?? -1) - (b.junctionIndex ?? -1));
}
