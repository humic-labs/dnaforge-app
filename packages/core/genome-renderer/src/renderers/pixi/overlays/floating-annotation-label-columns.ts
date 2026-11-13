import {
  FLOATING_LABEL_TERMINAL_TICK_PX,
  FLOATING_LABEL_TEXT_GAP_PX,
  type FloatingAnnotationLabelCandidate,
  type FloatingAnnotationLabelDecision,
  type FloatingAnnotationLabelLeader,
  type FloatingAnnotationLabelObstacle,
  type FloatingLabelBounds,
  type FloatingLabelPoint,
} from './floating-annotation-label-layout';

export interface FloatingLabelColumnRing {
  readonly center: FloatingLabelPoint;
  readonly radius: number;
}

export interface FloatingLabelColumnViewport {
  readonly width: number;
  readonly height: number;
}

export const FLOATING_LABEL_COLUMN_LINE_GAP_PX = 3;
export const FLOATING_LABEL_COLUMN_EDGE_MARGIN_PX = 4;
export const FLOATING_LABEL_COLUMN_MAX_LEADER_PX = 160;
const CENTER_LINE_GAP_PX = 2;

type Side = 1 | -1;

interface ColumnEntry {
  readonly candidate: FloatingAnnotationLabelCandidate;
  readonly side: Side;
  readonly preferredCenterY: number;
  readonly preferredHalfWidth: number;
  readonly order: number;
}

interface ColumnPlacement {
  readonly entry: ColumnEntry;
  readonly centerY: number;
  readonly bounds: FloatingLabelBounds;
  readonly leader: FloatingAnnotationLabelLeader;
}

function lowerPriority(
  left: FloatingAnnotationLabelCandidate,
  right: FloatingAnnotationLabelCandidate
): boolean {
  const leftRank = left.stableOrder[0];
  const rightRank = right.stableOrder[0];
  return leftRank > rightRank || (leftRank === rightRank && left.featureId > right.featureId);
}

export function distributeWithMinimumSpacing(
  preferred: readonly number[],
  spacing: readonly number[],
  low: number,
  high: number
): number[] {
  const count = preferred.length;
  if (count === 0) return [];
  const offsets: number[] = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    offsets.push(total);
    if (index < count - 1) total += spacing[index];
  }
  const blocks: Array<{ sum: number; count: number }> = [];
  for (let index = 0; index < count; index += 1) {
    blocks.push({ sum: preferred[index] - offsets[index], count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (previous.sum / previous.count <= last.sum / last.count) break;
      blocks.pop();
      previous.sum += last.sum;
      previous.count += last.count;
    }
  }
  const lowest = low;
  const highest = high - total;
  const positions: number[] = [];
  let index = 0;
  for (const block of blocks) {
    const value = Math.min(Math.max(block.sum / block.count, lowest), Math.max(lowest, highest));
    for (let member = 0; member < block.count; member += 1) {
      positions.push(value + offsets[index]);
      index += 1;
    }
  }
  return positions;
}

function ringHalfWidthAt(ring: FloatingLabelColumnRing, y: number): number {
  const dy = y - ring.center.y;
  return Math.sqrt(Math.max(0, ring.radius * ring.radius - dy * dy));
}

function innerEdgeX(
  ring: FloatingLabelColumnRing,
  entry: ColumnEntry,
  yMin: number,
  yMax: number
): number {
  const nearestY = Math.min(Math.max(ring.center.y, yMin), yMax);
  const halfWidth = Math.max(
    ringHalfWidthAt(ring, nearestY),
    entry.preferredHalfWidth,
    CENTER_LINE_GAP_PX
  );
  return ring.center.x + entry.side * halfWidth;
}

function columnLeader(
  anchor: FloatingLabelPoint,
  side: Side,
  bounds: FloatingLabelBounds,
  centerY: number
): FloatingAnnotationLabelLeader {
  const end = {
    x:
      side > 0
        ? bounds.xMin - FLOATING_LABEL_TEXT_GAP_PX
        : bounds.xMax + FLOATING_LABEL_TEXT_GAP_PX,
    y: centerY,
  };
  const elbow = { x: end.x - side * FLOATING_LABEL_TERMINAL_TICK_PX, y: centerY };
  return {
    attachment: side > 0 ? 'left' : 'right',
    start: anchor,
    elbow,
    end,
    length: Math.hypot(elbow.x - anchor.x, elbow.y - anchor.y) + FLOATING_LABEL_TERMINAL_TICK_PX,
  };
}

function stackAwayFromEquator(
  entries: readonly ColumnEntry[],
  direction: 1 | -1,
  equatorLimit: number | null
): number[] {
  const centers: number[] = [];
  entries.forEach((entry, index) => {
    const preferred = entry.preferredCenterY;
    if (index === 0) {
      centers.push(
        equatorLimit === null
          ? preferred
          : direction < 0
            ? Math.min(preferred, equatorLimit)
            : Math.max(preferred, equatorLimit)
      );
      return;
    }
    const previous = entries[index - 1];
    const spacing =
      (previous.candidate.textHeight + entry.candidate.textHeight) / 2 +
      FLOATING_LABEL_COLUMN_LINE_GAP_PX;
    const pushed = centers[index - 1] + direction * spacing;
    centers.push(direction < 0 ? Math.min(preferred, pushed) : Math.max(preferred, pushed));
  });
  return centers;
}

function placeEntry(
  entry: ColumnEntry,
  centerY: number,
  ring: FloatingLabelColumnRing
): ColumnPlacement {
  const height = entry.candidate.textHeight;
  const yMin = centerY - height / 2;
  const yMax = centerY + height / 2;
  const textGap = FLOATING_LABEL_TEXT_GAP_PX + FLOATING_LABEL_TERMINAL_TICK_PX;
  const inner = innerEdgeX(ring, entry, yMin, yMax) + entry.side * textGap;
  const width = entry.candidate.textWidth;
  const bounds =
    entry.side > 0
      ? { xMin: inner, xMax: inner + width, yMin, yMax }
      : { xMin: inner - width, xMax: inner, yMin, yMax };
  return {
    entry,
    centerY,
    bounds,
    leader: columnLeader(entry.candidate.anchor, entry.side, bounds, centerY),
  };
}

function overlaps(left: FloatingLabelBounds, right: FloatingLabelBounds): boolean {
  return (
    left.xMin < right.xMax &&
    left.xMax > right.xMin &&
    left.yMin < right.yMax &&
    left.yMax > right.yMin
  );
}

function violates(
  placement: ColumnPlacement,
  viewport: FloatingLabelColumnViewport,
  obstacles: readonly FloatingAnnotationLabelObstacle[]
): boolean {
  const bounds = placement.bounds;
  if (
    bounds.xMin < 0 ||
    bounds.xMax > viewport.width ||
    bounds.yMin < FLOATING_LABEL_COLUMN_EDGE_MARGIN_PX ||
    bounds.yMax > viewport.height - FLOATING_LABEL_COLUMN_EDGE_MARGIN_PX ||
    placement.leader.length > FLOATING_LABEL_COLUMN_MAX_LEADER_PX
  ) {
    return true;
  }
  const ownBody = `body:${placement.entry.candidate.featureId}`;
  return obstacles.some((obstacle) => obstacle.owner !== ownBody && overlaps(bounds, obstacle));
}

function touching(previous: ColumnPlacement, next: ColumnPlacement): boolean {
  const gap = Math.max(
    next.bounds.yMin - previous.bounds.yMax,
    previous.bounds.yMin - next.bounds.yMax
  );
  return gap <= FLOATING_LABEL_COLUMN_LINE_GAP_PX + 1e-6;
}

function spreadAcrossHalf(
  entries: readonly ColumnEntry[],
  direction: 1 | -1,
  equatorLimit: number | null,
  ring: FloatingLabelColumnRing,
  viewport: FloatingLabelColumnViewport
): number[] {
  const ascending = direction > 0 ? [...entries] : [...entries].reverse();
  const spacing = ascending
    .slice(0, -1)
    .map(
      (entry, index) =>
        (entry.candidate.textHeight + ascending[index + 1].candidate.textHeight) / 2 +
        FLOATING_LABEL_COLUMN_LINE_GAP_PX
    );
  const firstHeight = ascending[0].candidate.textHeight;
  const lastHeight = ascending[ascending.length - 1].candidate.textHeight;
  const viewportLow = FLOATING_LABEL_COLUMN_EDGE_MARGIN_PX + firstHeight / 2;
  const viewportHigh = viewport.height - FLOATING_LABEL_COLUMN_EDGE_MARGIN_PX - lastHeight / 2;
  const equator = equatorLimit ?? ring.center.y;
  const low = direction > 0 ? Math.max(viewportLow, equator) : viewportLow;
  const high = direction > 0 ? viewportHigh : Math.min(viewportHigh, equator);
  const centers = distributeWithMinimumSpacing(
    ascending.map((entry) => entry.preferredCenterY),
    spacing,
    low,
    high
  );
  return direction > 0 ? centers : centers.reverse();
}

function halfCapacity(
  entries: readonly ColumnEntry[],
  direction: 1 | -1,
  equatorLimit: number | null,
  ring: FloatingLabelColumnRing,
  viewport: FloatingLabelColumnViewport
): number {
  if (entries.length === 0) return 0;
  const height = entries.reduce(
    (maximum, entry) => Math.max(maximum, entry.candidate.textHeight),
    0
  );
  const equator = equatorLimit ?? ring.center.y;
  const span =
    direction > 0
      ? viewport.height - FLOATING_LABEL_COLUMN_EDGE_MARGIN_PX - Math.min(equator, ring.center.y)
      : Math.max(equator, ring.center.y) - FLOATING_LABEL_COLUMN_EDGE_MARGIN_PX;
  const pitch = height + FLOATING_LABEL_COLUMN_LINE_GAP_PX;
  return Math.max(0, Math.floor((span + FLOATING_LABEL_COLUMN_LINE_GAP_PX) / pitch));
}

function solveHalf(
  entries: readonly ColumnEntry[],
  direction: 1 | -1,
  equatorLimit: number | null,
  ring: FloatingLabelColumnRing,
  viewport: FloatingLabelColumnViewport,
  obstacles: readonly FloatingAnnotationLabelObstacle[],
  dropped: Map<number, 'column-capacity' | 'blocked-fixed-slot'>
): ColumnPlacement[] {
  const capacity = halfCapacity(entries, direction, equatorLimit, ring, viewport);
  let active = [...entries];
  if (active.length > capacity) {
    const kept = new Set(
      [...active]
        .sort((left, right) =>
          lowerPriority(left.candidate, right.candidate)
            ? 1
            : lowerPriority(right.candidate, left.candidate)
              ? -1
              : 0
        )
        .slice(0, capacity)
    );
    for (const entry of active) {
      if (!kept.has(entry)) dropped.set(entry.candidate.featureId, 'column-capacity');
    }
    active = active.filter((entry) => kept.has(entry));
  }
  for (;;) {
    if (active.length === 0) return [];
    const outward = stackAwayFromEquator(active, direction, equatorLimit).map((center, index) =>
      placeEntry(active[index], center, ring)
    );
    const violatingFlags = outward.map((placement) => violates(placement, viewport, obstacles));
    if (!violatingFlags.includes(true)) return outward;
    const spread = spreadAcrossHalf(active, direction, equatorLimit, ring, viewport).map(
      (center, index) => placeEntry(active[index], center, ring)
    );
    if (!spread.some((placement) => violates(placement, viewport, obstacles))) return spread;
    const victims = new Set<ColumnEntry>();
    let index = 0;
    while (index < outward.length) {
      let last = index;
      while (last < outward.length - 1 && touching(outward[last], outward[last + 1])) last += 1;
      let blockViolates = false;
      let victim = outward[index];
      for (let member = index; member <= last; member += 1) {
        if (violatingFlags[member]) blockViolates = true;
        if (lowerPriority(outward[member].entry.candidate, victim.entry.candidate)) {
          victim = outward[member];
        }
      }
      if (blockViolates) {
        victims.add(victim.entry);
        dropped.set(
          victim.entry.candidate.featureId,
          last > index ? 'column-capacity' : 'blocked-fixed-slot'
        );
      }
      index = last + 1;
    }
    active = active.filter((entry) => !victims.has(entry));
  }
}

function orientation(p: FloatingLabelPoint, q: FloatingLabelPoint, r: FloatingLabelPoint): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

function segmentsCross(
  a: FloatingLabelPoint,
  b: FloatingLabelPoint,
  c: FloatingLabelPoint,
  d: FloatingLabelPoint
): boolean {
  return (
    orientation(c, d, a) * orientation(c, d, b) < 0 &&
    orientation(a, b, c) * orientation(a, b, d) < 0
  );
}

function leadersCross(left: ColumnPlacement, right: ColumnPlacement): boolean {
  const a = left.leader;
  const b = right.leader;
  return (
    segmentsCross(a.start, a.elbow, b.start, b.elbow) ||
    segmentsCross(a.start, a.elbow, b.elbow, b.end) ||
    segmentsCross(a.elbow, a.end, b.start, b.elbow) ||
    segmentsCross(a.elbow, a.end, b.elbow, b.end)
  );
}

const UNCROSS_NEIGHBOURHOOD = 12;
const UNCROSS_MAX_PASSES = 4;

function leaderBounds(placement: ColumnPlacement): FloatingLabelBounds {
  const { start, elbow, end } = placement.leader;
  return {
    xMin: Math.min(start.x, elbow.x, end.x),
    xMax: Math.max(start.x, elbow.x, end.x),
    yMin: Math.min(start.y, elbow.y, end.y),
    yMax: Math.max(start.y, elbow.y, end.y),
  };
}

function crossingsWith(
  placements: readonly ColumnPlacement[],
  bounds: readonly FloatingLabelBounds[],
  index: number
): number {
  const own = bounds[index];
  let count = 0;
  const first = Math.max(0, index - UNCROSS_NEIGHBOURHOOD);
  const last = Math.min(placements.length - 1, index + UNCROSS_NEIGHBOURHOOD);
  for (let other = first; other <= last; other += 1) {
    if (other === index) continue;
    const candidate = bounds[other];
    if (
      candidate.xMax < own.xMin ||
      candidate.xMin > own.xMax ||
      candidate.yMax < own.yMin ||
      candidate.yMin > own.yMax
    ) {
      continue;
    }
    if (leadersCross(placements[index], placements[other])) count += 1;
  }
  return count;
}

function uncrossLeaders(
  placements: readonly ColumnPlacement[],
  ring: FloatingLabelColumnRing,
  viewport: FloatingLabelColumnViewport,
  obstacles: readonly FloatingAnnotationLabelObstacle[]
): ColumnPlacement[] {
  const current = [...placements].sort((left, right) => left.centerY - right.centerY);
  const bounds = current.map(leaderBounds);
  for (let pass = 0; pass < UNCROSS_MAX_PASSES; pass += 1) {
    const involved = current.map((_, index) => crossingsWith(current, bounds, index) > 0);
    if (!involved.some(Boolean)) break;
    let improved = false;
    for (let index = 0; index + 1 < current.length; index += 1) {
      if (!involved[index] && !involved[index + 1]) continue;
      const upper = current[index];
      const lower = current[index + 1];
      if (upper.entry.candidate.textHeight !== lower.entry.candidate.textHeight) continue;
      const pairCrosses = (left: ColumnPlacement, right: ColumnPlacement) =>
        leadersCross(left, right) ? 1 : 0;
      const before =
        crossingsWith(current, bounds, index) +
        crossingsWith(current, bounds, index + 1) -
        pairCrosses(upper, lower);
      if (before === 0) continue;
      const movedUp = placeEntry(lower.entry, upper.centerY, ring);
      const movedDown = placeEntry(upper.entry, lower.centerY, ring);
      if (violates(movedUp, viewport, obstacles) || violates(movedDown, viewport, obstacles)) {
        continue;
      }
      const upperBounds = bounds[index];
      const lowerBounds = bounds[index + 1];
      current[index] = movedUp;
      current[index + 1] = movedDown;
      bounds[index] = leaderBounds(movedUp);
      bounds[index + 1] = leaderBounds(movedDown);
      const after =
        crossingsWith(current, bounds, index) +
        crossingsWith(current, bounds, index + 1) -
        pairCrosses(movedUp, movedDown);
      if (after < before) {
        improved = true;
        involved[index] = true;
        involved[index + 1] = true;
        continue;
      }
      current[index] = upper;
      current[index + 1] = lower;
      bounds[index] = upperBounds;
      bounds[index + 1] = lowerBounds;
    }
    if (!improved) break;
  }
  return current;
}

function solveSide(
  entries: readonly ColumnEntry[],
  ring: FloatingLabelColumnRing,
  viewport: FloatingLabelColumnViewport,
  obstacles: readonly FloatingAnnotationLabelObstacle[]
): { placed: ColumnPlacement[]; dropped: Map<number, 'column-capacity' | 'blocked-fixed-slot'> } {
  const dropped = new Map<number, 'column-capacity' | 'blocked-fixed-slot'>();
  const byEquatorDistance = (left: ColumnEntry, right: ColumnEntry) =>
    Math.abs(left.preferredCenterY - ring.center.y) -
      Math.abs(right.preferredCenterY - ring.center.y) || left.order - right.order;
  const lowerEntries = entries
    .filter((entry) => entry.preferredCenterY > ring.center.y)
    .sort(byEquatorDistance);
  const upperEntries = entries
    .filter((entry) => entry.preferredCenterY <= ring.center.y)
    .sort(byEquatorDistance);
  const lower = solveHalf(lowerEntries, 1, null, ring, viewport, obstacles, dropped);
  const equatorLimit =
    lower.length > 0 && upperEntries.length > 0
      ? lower[0].bounds.yMin -
        FLOATING_LABEL_COLUMN_LINE_GAP_PX -
        upperEntries[0].candidate.textHeight / 2
      : null;
  const upper = solveHalf(upperEntries, -1, equatorLimit, ring, viewport, obstacles, dropped);
  return { placed: uncrossLeaders([...upper, ...lower], ring, viewport, obstacles), dropped };
}

export function planCircularColumnLabels(
  candidates: readonly FloatingAnnotationLabelCandidate[],
  ring: FloatingLabelColumnRing,
  viewport: FloatingLabelColumnViewport,
  obstacles: readonly FloatingAnnotationLabelObstacle[] = []
): FloatingAnnotationLabelDecision[] {
  const entries: ColumnEntry[] = [];
  const invalid: FloatingAnnotationLabelCandidate[] = [];
  const ordered = [...candidates].sort(
    (left, right) =>
      left.stableOrder[0] - right.stableOrder[0] ||
      left.stableOrder[1] - right.stableOrder[1] ||
      left.featureId - right.featureId
  );
  ordered.forEach((candidate, order) => {
    const dx = candidate.anchor.x - ring.center.x;
    const dy = candidate.anchor.y - ring.center.y;
    const distance = Math.hypot(dx, dy);
    if (
      !Number.isFinite(distance) ||
      distance <= 1e-9 ||
      !(candidate.textWidth > 0) ||
      !(candidate.textHeight > 0)
    ) {
      invalid.push(candidate);
      return;
    }
    entries.push({
      candidate,
      side: dx >= 0 ? 1 : -1,
      preferredCenterY: ring.center.y + (dy / distance) * ring.radius,
      preferredHalfWidth: (Math.abs(dx) / distance) * ring.radius,
      order,
    });
  });

  const decisions = new Map<number, FloatingAnnotationLabelDecision>();
  const candidateById = new Map(
    entries.map((entry) => [entry.candidate.featureId, entry.candidate])
  );
  for (const side of [1, -1] as const) {
    const { placed, dropped } = solveSide(
      entries.filter((entry) => entry.side === side),
      ring,
      viewport,
      obstacles
    );
    for (const placement of placed) {
      const candidate = placement.entry.candidate;
      decisions.set(candidate.featureId, {
        featureId: candidate.featureId,
        text: candidate.text,
        anchor: candidate.anchor,
        bodyBounds: candidate.bodyBounds,
        status: 'placed',
        x: (placement.bounds.xMin + placement.bounds.xMax) / 2,
        y: placement.centerY,
        bounds: placement.bounds,
        leader: placement.leader,
        slot: { outwardRow: 0, tangentStep: 0, outwardClearance: 0 },
        testedSlotCount: 1,
        assignmentOptions: candidate.placementOptions,
      });
    }
    for (const [featureId, reason] of dropped) {
      const candidate = candidateById.get(featureId);
      if (!candidate) continue;
      decisions.set(featureId, {
        featureId,
        text: candidate.text,
        anchor: candidate.anchor,
        bodyBounds: candidate.bodyBounds,
        status: 'rejected',
        reason,
        slot: null,
        testedSlotCount: 1,
        blockers: [],
      });
    }
  }
  for (const candidate of invalid) {
    decisions.set(candidate.featureId, {
      featureId: candidate.featureId,
      text: candidate.text,
      anchor: candidate.anchor,
      bodyBounds: candidate.bodyBounds,
      status: 'rejected',
      reason: 'invalid-geometry',
      slot: null,
      testedSlotCount: 0,
      blockers: [],
    });
  }
  return ordered.flatMap((candidate) => {
    const decision = decisions.get(candidate.featureId);
    return decision ? [decision] : [];
  });
}
