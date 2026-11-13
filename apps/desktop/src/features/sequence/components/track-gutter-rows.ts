import type { LaneBand, LaneScreenBands } from './lane-screen-bands';

export interface GutterRow {
  id: string;
  kind: 'cytoband' | 'reference' | 'data';
  label: string;
  visible: boolean;
  removable: boolean;
  togglable: boolean;
  trackId?: string;
  bucket?: string;
  reorderable?: boolean;
  requestedHeightPx?: number;
  band?: LaneBand;
  color?: string;
}

interface BuildLaneGutterRowsInput {
  bands: LaneScreenBands;
  referenceLabel?: string;
  cytobandVisible?: boolean;
  annotationVisibleCount: number;
  dataLanes: ReadonlyArray<{
    dataset: { trackId: string; label: string; kind?: string; trackPx?: number; color?: number };
    visible: boolean;
    bucket: string;
    removable?: boolean;
    togglable?: boolean;
    reorderable?: boolean;
  }>;
}

export function unionReferenceBand(bands: LaneScreenBands): LaneBand {
  if (bands.reference) return bands.reference;
  const parts: LaneBand[] = [];
  if (bands.annotation) parts.push(bands.annotation);
  if (bands.sequence) parts.push(bands.sequence);
  if (parts.length === 0) return { topPx: 0, heightPx: 28 };
  const topPx = Math.min(...parts.map((p) => p.topPx));
  const bottomPx = Math.max(...parts.map((p) => p.topPx + p.heightPx));
  return { topPx, heightPx: Math.max(28, bottomPx - topPx) };
}

export function buildLaneGutterRows(input: BuildLaneGutterRowsInput): GutterRow[] {
  const rows: GutterRow[] = [];
  if (input.cytobandVisible !== undefined) {
    const bandId = Object.keys(input.bands.dataBounds).find((id) => id.startsWith('cytoband-'));
    const band = bandId ? input.bands.dataBounds[bandId] : undefined;
    if (band || !input.cytobandVisible) {
      rows.push({
        id: 'lane:cytoband',
        kind: 'cytoband',
        label: 'Chromosomes',
        visible: input.cytobandVisible,
        removable: false,
        togglable: true,
        band: input.cytobandVisible ? band : undefined,
      });
    }
  }
  const hasReferenceBand = Boolean(
    input.bands.reference || input.bands.annotation || input.bands.sequence
  );

  rows.push({
    id: 'lane:reference',
    kind: 'reference',
    label: input.referenceLabel ?? 'Reference',
    visible: input.annotationVisibleCount > 0,
    removable: false,
    togglable: true,
    band: hasReferenceBand ? unionReferenceBand(input.bands) : undefined,
  });

  for (const lane of input.dataLanes) {
    rows.push({
      id: `${lane.bucket}:${lane.dataset.trackId}`,
      kind: 'data',
      label: lane.dataset.label,
      visible: lane.visible,
      removable: lane.removable ?? true,
      togglable: lane.togglable ?? true,
      trackId: lane.dataset.trackId,
      bucket: lane.bucket,
      reorderable: lane.reorderable ?? false,
      requestedHeightPx:
        Number.isFinite(lane.dataset.trackPx) && (lane.dataset.trackPx ?? 0) > 0
          ? lane.dataset.trackPx
          : undefined,
      band: input.bands.dataBounds[lane.dataset.trackId],
      ...(lane.dataset.color === undefined
        ? {}
        : { color: `#${lane.dataset.color.toString(16).padStart(6, '0')}` }),
    });
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const at = a.row.band?.topPx ?? Number.POSITIVE_INFINITY;
      const bt = b.row.band?.topPx ?? Number.POSITIVE_INFINITY;
      return at === bt ? a.index - b.index : at - bt;
    })
    .map((e) => e.row);
}
