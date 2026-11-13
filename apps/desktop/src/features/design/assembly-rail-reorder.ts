import type { DesignRegion, DesignSpacer, SequenceDesign } from './types';
import { repositionSpacersFromAnchors } from './spacer-invariants';

export function reorderByInsertionSlot<T>(
  items: readonly T[],
  fromIndex: number | null,
  insertionSlot: number | null
): T[] {
  if (fromIndex === null || insertionSlot === null) return [...items];
  if (fromIndex < 0 || fromIndex >= items.length) return [...items];

  const boundedSlot = Math.max(0, Math.min(items.length, insertionSlot));
  if (boundedSlot === fromIndex || boundedSlot === fromIndex + 1) return [...items];

  const result = [...items];
  const [moved] = result.splice(fromIndex, 1);
  const adjustedSlot = fromIndex < boundedSlot ? boundedSlot - 1 : boundedSlot;
  result.splice(adjustedSlot, 0, moved);
  return result;
}

export function isGoldenGateFixedRegionOrderCompatible(
  design: Pick<SequenceDesign, 'assemblyMethod' | 'topology'>,
  regions: readonly DesignRegion[]
): boolean {
  if (design.assemblyMethod !== 'goldengate' || regions.length < 2) return true;

  const junctionCount = design.topology === 'circular' ? regions.length : regions.length - 1;
  for (let junctionIndex = 0; junctionIndex < junctionCount; junctionIndex += 1) {
    const left = regions[junctionIndex];
    const right = regions[(junctionIndex + 1) % regions.length];
    const leftOverhang = left.rdOverhangs?.downstream;
    const rightOverhang = right.rdOverhangs?.upstream;
    if (
      left.sourceType === 'rd' &&
      right.sourceType === 'rd' &&
      leftOverhang &&
      rightOverhang &&
      leftOverhang !== rightOverhang
    ) {
      return false;
    }
  }
  return true;
}

export function detectSingleRegionMove(
  oldRegionIds: readonly string[],
  nextRegionIds: readonly string[]
): { sourceIndex: number; insertionSlot: number } | null {
  if (oldRegionIds.length !== nextRegionIds.length) return null;
  if (oldRegionIds.every((id, index) => id === nextRegionIds[index])) return null;

  for (let sourceIndex = 0; sourceIndex < oldRegionIds.length; sourceIndex += 1) {
    for (let insertionSlot = 0; insertionSlot <= oldRegionIds.length; insertionSlot += 1) {
      const candidate = reorderByInsertionSlot(oldRegionIds, sourceIndex, insertionSlot);
      if (candidate.every((id, index) => id === nextRegionIds[index])) {
        return { sourceIndex, insertionSlot };
      }
    }
  }
  return null;
}

export function adjustSpacersForReorder(
  spacers: readonly DesignSpacer[] | undefined,
  reorderedRegions: DesignRegion[],
  move: { sourceIndex: number; insertionSlot: number } | null,
  topology: SequenceDesign['topology']
): DesignSpacer[] {
  const all = spacers ?? [];
  const anchored = all.filter((spacer) => spacer.anchor);
  const legacy = all.filter((spacer) => !spacer.anchor);
  const repositioned = repositionSpacersFromAnchors(
    anchored,
    reorderedRegions,
    topology === 'circular'
  ).spacers;
  const shiftedLegacy = adjustSpacersForSingleRegionMove(
    legacy,
    move,
    reorderedRegions.length,
    topology
  );
  const taken = new Set(repositioned.map((spacer) => spacer.junctionIndex));
  return [
    ...repositioned,
    ...shiftedLegacy.filter((spacer) => !taken.has(spacer.junctionIndex)),
  ].sort((a, b) => a.junctionIndex - b.junctionIndex);
}

function adjustSpacersForSingleRegionMove(
  spacers: readonly DesignSpacer[],
  move: { sourceIndex: number; insertionSlot: number } | null,
  nextRegionCount: number,
  topology: SequenceDesign['topology']
): DesignSpacer[] {
  if (!move) return [...spacers];
  const maxJunction = topology === 'circular' ? nextRegionCount - 1 : nextRegionCount - 2;
  if (maxJunction < 0) return [];

  return spacers
    .map((spacer) => {
      let junctionIndex = spacer.junctionIndex;
      if (move.sourceIndex > junctionIndex && move.insertionSlot <= junctionIndex) {
        junctionIndex += 1;
      } else if (move.sourceIndex <= junctionIndex && move.insertionSlot > junctionIndex + 1) {
        junctionIndex -= 1;
      }
      return {
        ...spacer,
        junctionIndex: Math.max(0, Math.min(maxJunction, junctionIndex)),
      };
    })
    .filter((spacer) => spacer.junctionIndex >= 0 && spacer.junctionIndex <= maxJunction);
}

export function resolveAssemblyMapInsertionSlot(
  ranges: ReadonlyArray<Readonly<{ start: number; end: number }>>,
  targetBp: number
): number | null {
  if (ranges.length === 0 || !Number.isFinite(targetBp)) return null;
  const boundaries = [
    { position: ranges[0].start, slot: 0 },
    ...ranges.slice(1).map((range, index) => ({ position: range.start, slot: index + 1 })),
    { position: ranges[ranges.length - 1].end, slot: ranges.length },
  ];
  return boundaries.reduce((nearest, candidate) =>
    Math.abs(candidate.position - targetBp) < Math.abs(nearest.position - targetBp)
      ? candidate
      : nearest
  ).slot;
}

export function reorderGroupByInsertionSlot<T>(
  items: readonly T[],
  fromIndices: readonly number[],
  insertionSlot: number | null
): T[] {
  if (insertionSlot === null) return [...items];

  const selectedIndices = [...new Set(fromIndices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < items.length)
    .sort((a, b) => a - b);
  if (selectedIndices.length === 0) return [...items];

  const selectedIndexSet = new Set(selectedIndices);
  const boundedSlot = Math.max(0, Math.min(items.length, insertionSlot));
  const moved = selectedIndices.map((index) => items[index]);
  const remaining = items.filter((_item, index) => !selectedIndexSet.has(index));
  const removedBeforeSlot = selectedIndices.filter((index) => index < boundedSlot).length;
  const adjustedSlot = Math.max(0, Math.min(remaining.length, boundedSlot - removedBeforeSlot));

  return [...remaining.slice(0, adjustedSlot), ...moved, ...remaining.slice(adjustedSlot)];
}
