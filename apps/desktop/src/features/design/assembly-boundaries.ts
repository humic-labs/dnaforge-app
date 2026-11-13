import type { DesignRegion, DesignSpacer, SequenceDesign } from './types';

export interface AssemblyBoundary {
  id: string;
  junctionIndex: number;
  leftRegion: DesignRegion;
  rightRegion: DesignRegion | null;
  spacer: DesignSpacer | null;
  duplicateSpacers: DesignSpacer[];
}

export interface ProductLayoutPartSegment {
  kind: 'part';
  layoutId: string;
  regionIndex: number;
  region: DesignRegion;
  start: number;
  end: number;
}

export interface ProductLayoutSpacerSegment {
  kind: 'spacer';
  layoutId: string;
  junctionIndex: number;
  boundaryId: string;
  spacer: DesignSpacer;
  start: number;
  end: number;
}

export type ProductLayoutSegment = ProductLayoutPartSegment | ProductLayoutSpacerSegment;
export type ProductLayoutBoundarySideKind = ProductLayoutSegment['kind'] | 'none';

export interface ProductLayoutBoundaryItem {
  kind: 'boundary';
  id: string;
  junctionIndex: number;
  partInsertIndex: number;
  spacerJunctionIndex: number | null;
  leftKind: ProductLayoutBoundarySideKind;
  rightKind: ProductLayoutBoundarySideKind;
  leftRegionIndex: number | null;
  rightRegionIndex: number | null;
  canAddPart: boolean;
  canAddSpacer: boolean;
  moveSpacerAfterInsertedPartJunctionIndex: number | null;
  isTerminal: boolean;
}

export type ProductLayoutItem = ProductLayoutSegment | ProductLayoutBoundaryItem;

export function computeAssemblyBoundaryCount(design: Pick<SequenceDesign, 'regions' | 'topology'>) {
  if (design.regions.length < 2) return 0;
  return design.topology === 'circular' ? design.regions.length : design.regions.length - 1;
}

export function selectAssemblyBoundaries(design: SequenceDesign): AssemblyBoundary[] {
  const boundaryCount = computeAssemblyBoundaryCount(design);
  const spacersByJunction = spacersByJunctionIndex(design.spacers ?? []);
  const stableJunctions = design.assemblyWorkbench?.junctions ?? [];

  return Array.from({ length: boundaryCount }, (_, junctionIndex) => {
    const leftRegion = design.regions[junctionIndex];
    const rightRegion = design.regions[(junctionIndex + 1) % design.regions.length] ?? null;
    const spacers = spacersByJunction.get(junctionIndex) ?? [];
    const stableJunction = stableJunctions.find((junction) => junction.slot === junctionIndex);

    return {
      id:
        stableJunction?.id ??
        stableBoundaryId(design.id, leftRegion?.id ?? null, rightRegion?.id ?? null),
      junctionIndex,
      leftRegion,
      rightRegion,
      spacer: spacers[0] ?? null,
      duplicateSpacers: spacers.slice(1),
    };
  }).filter((boundary) => boundary.leftRegion);
}

export function selectAssemblyBoundaryMap(design: SequenceDesign): Map<number, AssemblyBoundary> {
  return new Map(
    selectAssemblyBoundaries(design).map((boundary) => [boundary.junctionIndex, boundary])
  );
}

export function selectProductLayout(design: SequenceDesign): ProductLayoutSegment[] {
  const boundaries = selectAssemblyBoundaryMap(design);
  const segments: ProductLayoutSegment[] = [];
  const duplicatedRegionIds = duplicatedIds(design.regions.map((region) => region.id ?? null));
  let position = 0;

  for (let regionIndex = 0; regionIndex < design.regions.length; regionIndex++) {
    const region = design.regions[regionIndex];
    const partStart = position;
    position += region.sequence.length;
    segments.push({
      kind: 'part',
      layoutId: productRegionLayoutId(region, regionIndex, duplicatedRegionIds),
      regionIndex,
      region,
      start: partStart,
      end: position,
    });

    const spacer = boundaries.get(regionIndex)?.spacer;
    if (spacer) {
      const layoutSpacer = spacerWithLayoutId(design.id, spacer);
      const spacerStart = position;
      position += layoutSpacer.sequence.length;
      segments.push({
        kind: 'spacer',
        layoutId: productSpacerLayoutId(layoutSpacer),
        junctionIndex: regionIndex,
        boundaryId: boundaries.get(regionIndex)?.id ?? `boundary:${regionIndex}`,
        spacer: layoutSpacer,
        start: spacerStart,
        end: position,
      });
    }
  }

  return segments;
}

export function selectProductLayoutItems(design: SequenceDesign): ProductLayoutItem[] {
  const segments = selectProductLayout(design);
  const items: ProductLayoutItem[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const previous = segments[index - 1] ?? null;
    if (previous) {
      items.push(productLayoutBoundaryItem(design.id, previous, segment));
    }
    items.push(segment);
  }

  const terminalBoundary = productLayoutTerminalBoundaryItem(design, segments);
  if (terminalBoundary) {
    items.push(terminalBoundary);
  }

  return items;
}

export function designWithSelectedPendingSpacer(design: SequenceDesign): SequenceDesign {
  const junctionIndex = design.selectedJunctionIndex;
  if (junctionIndex === null || junctionIndex < 0) return design;
  if ((design.spacers ?? []).some((spacer) => spacer.junctionIndex === junctionIndex)) {
    return design;
  }

  return {
    ...design,
    spacers: [
      ...(design.spacers ?? []),
      {
        id: pendingSpacerId(design.id, junctionIndex),
        junctionIndex,
        sequence: '',
      },
    ],
  };
}

export function findProductLayoutBoundary(
  design: SequenceDesign,
  boundaryId: string
): ProductLayoutBoundaryItem | null {
  return (
    selectProductLayoutItems(design).find(
      (item): item is ProductLayoutBoundaryItem =>
        item.kind === 'boundary' && item.id === boundaryId
    ) ?? null
  );
}

export function productLayoutSegmentId(item: ProductLayoutSegment): string {
  return `${item.kind}:${productLayoutSegmentEntityId(item)}`;
}

function duplicatedIds(ids: readonly (string | null)[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) duplicated.add(id);
    else seen.add(id);
  }
  return duplicated;
}

function productRegionLayoutId(
  region: DesignRegion,
  regionIndex: number,
  duplicatedRegionIds: ReadonlySet<string>
): string {
  if (!region.id) return `region-${regionIndex}`;
  return duplicatedRegionIds.has(region.id) ? `${region.id}:${regionIndex}` : region.id;
}

function productSpacerLayoutId(spacer: DesignSpacer): string {
  return spacer.id ?? `spacer:${spacer.junctionIndex}`;
}

function pendingSpacerId(designId: string, junctionIndex: number): string {
  return stableId('pending-spacer', designId, String(junctionIndex));
}

function spacersByJunctionIndex(spacers: readonly DesignSpacer[]): Map<number, DesignSpacer[]> {
  const map = new Map<number, DesignSpacer[]>();
  for (const spacer of spacers) {
    if (!Number.isInteger(spacer.junctionIndex) || spacer.junctionIndex < 0) continue;
    const existing = map.get(spacer.junctionIndex);
    if (existing) existing.push(spacer);
    else map.set(spacer.junctionIndex, [spacer]);
  }
  return map;
}

function stableBoundaryId(
  designId: string,
  leftRegionId: string | null,
  rightRegionId: string | null
): string {
  return stableId('boundary', designId, leftRegionId ?? 'start', rightRegionId ?? 'end');
}

function productLayoutBoundaryItem(
  designId: string,
  left: ProductLayoutSegment,
  right: ProductLayoutSegment,
  options?: { isTerminal?: boolean; regionCount?: number }
): ProductLayoutBoundaryItem {
  const leftPartIndex = left.kind === 'part' ? left.regionIndex : left.junctionIndex;
  const rightPartIndex = right.kind === 'part' ? right.regionIndex : right.junctionIndex + 1;
  const partInsertIndex = options?.isTerminal
    ? (options.regionCount ?? Math.max(leftPartIndex + 1, rightPartIndex))
    : left.kind === 'spacer' && right.kind === 'part'
      ? right.regionIndex
      : left.kind === 'part'
        ? left.regionIndex + 1
        : rightPartIndex;
  const spacerJunctionIndex =
    left.kind === 'part' && right.kind === 'part' ? left.regionIndex : null;
  const moveSpacerAfterInsertedPartJunctionIndex =
    left.kind === 'part' && right.kind === 'spacer' ? right.junctionIndex : null;

  return {
    kind: 'boundary',
    id: productBoundaryId(designId, left, right),
    junctionIndex: Math.max(0, Math.min(leftPartIndex, rightPartIndex - 1)),
    partInsertIndex,
    spacerJunctionIndex,
    leftKind: left.kind,
    rightKind: right.kind,
    leftRegionIndex: left.kind === 'part' ? left.regionIndex : null,
    rightRegionIndex: right.kind === 'part' ? right.regionIndex : null,
    canAddPart: true,
    canAddSpacer:
      left.kind === 'part' && right.kind === 'part' && left.region.id !== right.region.id,
    moveSpacerAfterInsertedPartJunctionIndex,
    isTerminal: Boolean(options?.isTerminal),
  };
}

function productLayoutTerminalBoundaryItem(
  design: SequenceDesign,
  segments: readonly ProductLayoutSegment[]
): ProductLayoutBoundaryItem | null {
  const left = segments[segments.length - 1];
  if (!left) return null;

  if (design.topology === 'circular' && segments.length > 1) {
    return productLayoutBoundaryItem(design.id, left, segments[0], {
      isTerminal: true,
      regionCount: design.regions.length,
    });
  }

  return {
    kind: 'boundary',
    id: stableId('product-boundary', design.id, productLayoutSegmentEntityId(left), 'end'),
    junctionIndex: left.kind === 'part' ? left.regionIndex : left.junctionIndex,
    partInsertIndex: design.regions.length,
    spacerJunctionIndex: null,
    leftKind: left.kind,
    rightKind: 'none',
    leftRegionIndex: left.kind === 'part' ? left.regionIndex : null,
    rightRegionIndex: null,
    canAddPart: true,
    canAddSpacer: false,
    moveSpacerAfterInsertedPartJunctionIndex: null,
    isTerminal: true,
  };
}

function productBoundaryId(
  designId: string,
  left: ProductLayoutSegment,
  right: ProductLayoutSegment
): string {
  return stableId(
    'product-boundary',
    designId,
    left.kind,
    productLayoutSegmentEntityId(left),
    right.kind,
    productLayoutSegmentEntityId(right)
  );
}

function productLayoutSegmentEntityId(item: ProductLayoutSegment): string {
  return item.layoutId;
}

function spacerWithLayoutId(designId: string, spacer: DesignSpacer): DesignSpacer {
  if (spacer.id) return spacer;
  return {
    ...spacer,
    id: stableId('spacer', designId, 'junction', String(spacer.junctionIndex)),
  };
}

function stableId(...parts: string[]): string {
  return parts.map((part) => String(part).replace(/[^a-zA-Z0-9_-]/g, '_')).join(':');
}
