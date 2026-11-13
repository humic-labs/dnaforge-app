import type { DesignSpacer } from './types';

export interface SpacerDuplicateGroup {
  junctionIndex: number;
  keptId: string;
  droppedIds: string[];
}

export function findDuplicateSpacerGroups(
  spacers: readonly DesignSpacer[] | undefined
): SpacerDuplicateGroup[] {
  const byGap = new Map<number, DesignSpacer[]>();
  for (const spacer of spacers ?? []) {
    if (!Number.isInteger(spacer.junctionIndex)) continue;
    const bucket = byGap.get(spacer.junctionIndex);
    if (bucket) bucket.push(spacer);
    else byGap.set(spacer.junctionIndex, [spacer]);
  }

  const groups: SpacerDuplicateGroup[] = [];
  for (const [junctionIndex, bucket] of byGap) {
    if (bucket.length < 2) continue;
    groups.push({
      junctionIndex,
      keptId: bucket[0].id,
      droppedIds: bucket.slice(1).map((spacer) => spacer.id),
    });
  }
  return groups.sort((a, b) => a.junctionIndex - b.junctionIndex);
}

export function dedupeSpacersByJunction(
  spacers: readonly DesignSpacer[] | undefined
): DesignSpacer[] {
  const input = spacers ?? [];
  const seen = new Set<number>();
  const out: DesignSpacer[] = [];
  let changed = false;

  for (const spacer of input) {
    if (Number.isInteger(spacer.junctionIndex)) {
      if (seen.has(spacer.junctionIndex)) {
        changed = true;
        continue;
      }
      seen.add(spacer.junctionIndex);
    }
    out.push(spacer);
  }

  return changed ? out : (input as DesignSpacer[]);
}

export interface SpacerRepositionResult {
  spacers: DesignSpacer[];
  moved: Array<{ id: string; from: number; to: number }>;
  detached: DesignSpacer[];
}

function gapBetween(
  regions: ReadonlyArray<{ id: string }>,
  leftRegionId: string,
  rightRegionId: string,
  circular: boolean,
  currentIndex: number
): number | null {
  const count = regions.length;
  if (count < 2) return null;
  const last = circular ? count - 1 : count - 2;

  for (let i = 0; i <= last; i++) {
    if (regions[i].id === leftRegionId && regions[(i + 1) % count]?.id === rightRegionId) return i;
  }

  let flipped: number | null = null;
  for (let i = 0; i <= last; i++) {
    if (regions[i].id === rightRegionId && regions[(i + 1) % count]?.id === leftRegionId) {
      if (flipped === null || Math.abs(i - currentIndex) < Math.abs(flipped - currentIndex)) {
        flipped = i;
      }
    }
  }
  return flipped;
}

export function repositionSpacersFromAnchors(
  spacers: readonly DesignSpacer[] | undefined,
  regions: ReadonlyArray<{ id: string }>,
  circular = true
): SpacerRepositionResult {
  const moved: SpacerRepositionResult['moved'] = [];
  const detached: DesignSpacer[] = [];
  const next: DesignSpacer[] = [];

  for (const spacer of spacers ?? []) {
    if (!spacer.anchor) {
      next.push(spacer);
      continue;
    }
    const gap = gapBetween(
      regions,
      spacer.anchor.leftRegionId,
      spacer.anchor.rightRegionId,
      circular,
      spacer.junctionIndex
    );
    if (gap === null) {
      detached.push(spacer);
      continue;
    }
    if (gap !== spacer.junctionIndex) {
      moved.push({ id: spacer.id, from: spacer.junctionIndex, to: gap });
      next.push({ ...spacer, junctionIndex: gap });
    } else {
      next.push(spacer);
    }
  }

  return { spacers: dedupeSpacersByJunction(next), moved, detached };
}

export function anchorForGap(
  regions: ReadonlyArray<{ id: string }>,
  junctionIndex: number,
  circular = true
): DesignSpacer['anchor'] | undefined {
  const count = regions.length;
  const lastGap = circular ? count - 1 : count - 2;
  if (count < 2 || junctionIndex < 0 || junctionIndex > lastGap) return undefined;
  const left = regions[junctionIndex];
  const right = regions[(junctionIndex + 1) % count];
  if (!left || !right) return undefined;
  return { leftRegionId: left.id, rightRegionId: right.id };
}

export function reanchorSpacersToCurrentGaps(
  spacers: readonly DesignSpacer[] | undefined,
  regions: ReadonlyArray<{ id: string }>,
  circular = true
): DesignSpacer[] {
  const input = spacers ?? [];
  let changed = false;
  const next = input.map((spacer) => {
    const anchor = anchorForGap(regions, spacer.junctionIndex, circular);
    if (!anchor) return spacer;
    if (
      spacer.anchor?.leftRegionId === anchor.leftRegionId &&
      spacer.anchor.rightRegionId === anchor.rightRegionId
    ) {
      return spacer;
    }
    changed = true;
    return { ...spacer, anchor };
  });
  return changed ? next : (input as DesignSpacer[]);
}

export function backfillSpacerAnchors(
  spacers: readonly DesignSpacer[] | undefined,
  regions: ReadonlyArray<{ id: string }>
): DesignSpacer[] {
  const input = spacers ?? [];
  let changed = false;
  const out = input.map((spacer) => {
    if (spacer.anchor) return spacer;
    const anchor = anchorForGap(regions, spacer.junctionIndex);
    if (!anchor) return spacer;
    changed = true;
    return { ...spacer, anchor };
  });
  return changed ? out : (input as DesignSpacer[]);
}
