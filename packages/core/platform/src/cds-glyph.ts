export const CDS_MORPH_TIMING = { chevronStart: 0.65, colorRevealEnd: 0.1 } as const;
export const CDS_GLYPH_STYLE = {
  thinBandHeight: 2,
  replacementTopEdgeHeight: 4.5,
  labelHeight: 14,
  labelPadding: 6,
  gap: 4,
  radius: 3,
} as const;

export function cdsConnectorCenterOffset(pillHalfHeight: number, connectorHalfHeight: number) {
  return pillHalfHeight - connectorHalfHeight;
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const ease = (n: number) => {
  const p = clamp(n);
  return p * p * (3 - 2 * p);
};

export function cdsMorphPhases(
  progress: number,
  timing: { chevronStart: number; colorRevealEnd: number } = CDS_MORPH_TIMING
) {
  const p = clamp(progress);
  const cutoff = Math.max(0.01, Math.min(0.99, timing.chevronStart));
  const chevronProgress = ease((p - cutoff) / (1 - cutoff));
  return {
    bandProgress: ease(p / cutoff),
    chevronProgress,
    residueAlpha: chevronProgress,
    colorAlpha: ease(p / Math.max(0.01, timing.colorRevealEnd)),
  };
}

export interface CdsLabelRegion {
  kind: 'cds' | 'exon' | 'intron';
  left: number;
  right: number;
  text?: string;
  rangeStart: number;
  rangeEnd: number;
}
export interface CdsLabelPart {
  kind: CdsLabelRegion['kind'] | 'gene';
  text: string;
  x: number;
  width: number;
  rangeStart: number;
  rangeEnd: number;
}
export interface CdsCompoundLabel {
  level: 'above' | 'inline';
  left: number;
  right: number;
  regions: CdsLabelRegion[];
  parts: CdsLabelPart[];
}

export function planCdsCompoundLabels(
  regions: readonly CdsLabelRegion[],
  geneName: string,
  measure: (text: string) => number,
  viewportLeft: number,
  viewportRight: number
): CdsCompoundLabel[] {
  const visible = regions
    .map((r) => ({
      ...r,
      left: Math.max(r.left, viewportLeft),
      right: Math.min(r.right, viewportRight),
    }))
    .filter((r) => r.right > r.left)
    .sort((a, b) => a.left - b.left);
  if (!visible.length) return [];
  const fit = (group: CdsCompoundLabel): CdsCompoundLabel => {
    const desired = group.parts.map(
      (part) => measure(part.text) + CDS_GLYPH_STYLE.labelPadding * 2
    );
    const left = Math.min(...group.regions.map((r) => r.left));
    const right = Math.max(...group.regions.map((r) => r.right));
    const center = (left + right) / 2;
    const available =
      group.level === 'inline'
        ? right - left
        : 2 * Math.min(center - viewportLeft, viewportRight - center);
    const gap = Math.min(CDS_GLYPH_STYLE.gap, available / Math.max(1, group.parts.length * 2));
    const gapWidth = gap * (group.parts.length - 1);
    const total = desired.reduce((sum, w) => sum + w, 0);
    const width = Math.max(0, Math.min(available, total + gapWidth));
    const ratio = total > 0 ? Math.max(0, width - gapWidth) / total : 0;
    const geneIndex = group.parts.findIndex((part) => part.kind === 'gene');
    const geneWidth =
      geneIndex < 0 ? 0 : Math.min(desired[geneIndex], Math.max(0, width - gapWidth));
    const otherTotal = geneIndex < 0 ? total : total - desired[geneIndex];
    const otherRatio =
      geneIndex < 0
        ? ratio
        : otherTotal > 0
          ? Math.max(0, width - gapWidth - geneWidth) / otherTotal
          : 0;
    group.left = center - width / 2;
    group.right = group.left + width;
    let x = group.left;
    group.parts = group.parts.map((part, i) => {
      const placed = { ...part, x, width: i === geneIndex ? geneWidth : desired[i] * otherRatio };
      x += placed.width + gap;
      return placed;
    });
    return group;
  };
  const groups: CdsCompoundLabel[] = [];
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    const parts: CdsLabelPart[] = [];
    if (i === 0 && geneName)
      parts.push({
        kind: 'gene',
        text: geneName,
        x: 0,
        width: 0,
        rangeStart: r.rangeStart,
        rangeEnd: r.rangeEnd,
      });
    if (r.text && r.right - r.left >= 24)
      parts.push({
        kind: r.kind,
        text: r.text,
        x: 0,
        width: 0,
        rangeStart: r.rangeStart,
        rangeEnd: r.rangeEnd,
      });
    if (!parts.length) continue;
    let group = fit({
      level: r.kind === 'intron' ? 'inline' : 'above',
      left: 0,
      right: 0,
      regions: [r],
      parts,
    });
    while (group.level === 'above') {
      let index = groups.length - 1;
      while (index >= 0 && groups[index].level !== 'above') index--;
      const previous = groups[index];
      if (!previous || previous.right + CDS_GLYPH_STYLE.gap < group.left) break;
      groups.splice(index, 1);
      group = fit({
        level: 'above',
        left: 0,
        right: 0,
        regions: [...previous.regions, ...group.regions],
        parts: [...previous.parts, ...group.parts],
      });
    }
    groups.push(group);
  }
  return groups.sort((a, b) => a.left - b.left);
}
