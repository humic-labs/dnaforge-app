import { lineTrackBoundaries } from './line-track-layout';
import type { LayoutSnapshot2D, WorkspaceEditorConfig } from './types';

export const SCREEN_TRACK_SETTLE_MS = 48;

export interface ScreenTrackFrame {
  anchorBp: number;
  time: number;

  bands: Map<number, readonly number[]>;
  targets: Map<number, readonly number[]>;

  gaps: Map<number, number>;

  stripes: Map<number, number>;

  stripeTopOffsets: Map<number, number>;
  rowGapPx: number;
  topPaddingPx: number;
  bottomPaddingPx: number;

  settleBy: number | null;
}

export interface VisibleRowSlots {
  min: number;
  max: number;
}

function anchorIndex(layout: LayoutSnapshot2D, bp: number): number {
  const summary = layout.summary!;
  return Math.floor((bp - summary.topBp) / summary.cpr) + summary.topBufferCount;
}

export function captureScreenTracks(
  layout: LayoutSnapshot2D,
  config: WorkspaceEditorConfig,
  anchorBp: number,
  time: number
): ScreenTrackFrame {
  const focal = anchorIndex(layout, anchorBp);
  return {
    anchorBp,
    time,
    rowGapPx: layout.summary!.rowGapPx,
    topPaddingPx: layout.summary!.topPaddingPx - (layout.viewportOriginOffset ?? 0),
    bottomPaddingPx: bottomPadding(layout),
    settleBy: null,
    bands: new Map(
      layout.lines.map((row) => [
        row.lineIndex - focal,
        row.trackMorph?.painted ?? lineTrackBoundaries(row, config),
      ])
    ),
    targets: new Map(
      layout.lines.map((row) => [row.lineIndex - focal, lineTrackBoundaries(row, config)])
    ),
    gaps: new Map(
      layout.lines.map((row) => [
        row.lineIndex - focal,
        layout.summary!.rowYOffsets[row.lineIndex + 1] -
          layout.summary!.rowYOffsets[row.lineIndex] -
          layout.summary!.rowHeights[row.lineIndex],
      ])
    ),
    stripes: new Map(
      layout.lines.map((row) => {
        const painted = row.trackMorph?.painted ?? lineTrackBoundaries(row, config);
        return [row.lineIndex - focal, painted[painted.length - 1] - (row.stripeInsetPx ?? 0)];
      })
    ),
    stripeTopOffsets: new Map(
      layout.lines
        .filter((row) => !!row.stripeTopOffsetPx)
        .map((row) => [row.lineIndex - focal, row.stripeTopOffsetPx!])
    ),
  };
}

function topsRelativeToAnchoredDna(
  bands: Map<number, readonly number[]>,
  gaps: Map<number, number>
): Map<number, number> {
  const result = new Map<number, number>();
  const focal = bands.get(0);
  if (!focal) return result;
  const anchorTop = -focal[5];
  result.set(0, anchorTop);
  let y = anchorTop;
  for (let slot = 1; bands.has(slot) && bands.has(slot - 1); slot++) {
    const prior = bands.get(slot - 1)!;
    y += prior[prior.length - 1] + (gaps.get(slot - 1) ?? 0);
    result.set(slot, y);
  }
  y = anchorTop;
  for (let slot = -1; bands.has(slot); slot--) {
    const row = bands.get(slot)!;
    y -= row[row.length - 1] + (gaps.get(slot) ?? 0);
    result.set(slot, y);
  }
  return result;
}

function bottomPadding(layout: LayoutSnapshot2D): number {
  const summary = layout.summary!;
  const last = summary.totalRows - 1;
  return last < 0
    ? 0
    : summary.rowYOffsets[last + 1] - summary.rowYOffsets[last] - summary.rowHeights[last];
}

export function morphScreenTracks(
  target: LayoutSnapshot2D,
  config: WorkspaceEditorConfig,
  previous: ScreenTrackFrame,
  anchorBp: number,
  time: number,
  _visibleSlots?: VisibleRowSlots,
  options?: { fastZoomInternal?: boolean }
): { layout: LayoutSnapshot2D; frame: ScreenTrackFrame; pending: boolean } {
  if (!target.summary) return { layout: target, frame: previous, pending: false };
  const elapsed = Math.max(0, time - previous.time);
  const focal = anchorIndex(target, anchorBp);
  const bands = new Map<number, readonly number[]>();
  const targets = new Map<number, readonly number[]>();
  const gaps = new Map<number, number>();
  const stripes = new Map<number, number>();
  const stripeTopOffsets = new Map<number, number>();
  const gapOverrides = new Map<number, number>();
  const stripeInsets = new Map<number, number>();
  const stripeTopOverrides = new Map<number, number>();
  const overrides = new Map<number, readonly number[]>();
  const prepared = target.lines.map((row) => {
    const key = row.lineIndex - focal;
    const natural = lineTrackBoundaries(row, config);
    const goal = row.trackMorph?.painted ?? natural;
    targets.set(key, goal);
    const prior = previous.bands.get(key);
    const priorGap = previous.gaps.get(key) ?? previous.rowGapPx;
    if (!prior || prior.length !== goal.length) {
      return {
        row,
        key,
        goal,
        natural,
        prior: null,
        priorGap,
        fixed: () => false,
        deltas: [],
        fixedDistance: 0,
        distance: 0,
      };
    }

    const oldTarget = previous.targets.get(key) ?? prior;
    const fixed = (i: number) =>
      i === 5 ||
      ((i === 6 || i === 7 || i === 9) &&
        oldTarget[i + 1] > oldTarget[i] &&
        goal[i + 1] > goal[i] &&
        Math.abs(prior[i + 1] - prior[i] - (oldTarget[i + 1] - oldTarget[i])) <= 0.02);
    const deltas = goal
      .slice(1)
      .map((end, i) => (fixed(i) ? 0 : end - goal[i] - (prior[i + 1] - prior[i])));
    const fixedDistance = goal
      .slice(1)
      .reduce(
        (sum, end, i) => sum + (fixed(i) ? Math.abs(end - goal[i] - (prior[i + 1] - prior[i])) : 0),
        0
      );
    const distance = deltas.reduce((sum, delta) => sum + Math.abs(delta), 0);
    return { row, key, goal, natural, prior, priorGap, fixed, deltas, fixedDistance, distance };
  });
  const summary = target.summary;
  const gapDelta = summary.rowGapPx - previous.rowGapPx;
  const topDelta = summary.topPaddingPx - previous.topPaddingPx;
  const bottomDelta = bottomPadding(target) - previous.bottomPaddingPx;
  const maxGapDebt = prepared.reduce(
    (max, item) => Math.max(max, Math.abs(summary.rowGapPx - item.priorGap)),
    0
  );
  const maxStripeDebt = prepared.reduce((max, item) => {
    const priorHeight = item.prior?.[item.prior.length - 1] ?? 0;
    const priorStripe = previous.stripes.get(item.key);
    return Math.max(max, Math.max(0, priorHeight - (priorStripe ?? priorHeight)));
  }, 0);
  const spacingDistance = Math.max(
    Math.abs(gapDelta),
    Math.abs(topDelta),
    Math.abs(bottomDelta),
    maxGapDebt,
    maxStripeDebt
  );
  const maxFixedDistance = prepared.reduce((max, row) => Math.max(max, row.fixedDistance), 0);
  const maxLaneDistance = prepared.reduce((max, row) => Math.max(max, row.distance), 0);
  const distance = spacingDistance + maxLaneDistance;

  const needsMotion =
    distance > 0.00001 || maxFixedDistance > 0.00001 || previous.stripeTopOffsets.size > 0;
  const settleBy = needsMotion ? (previous.settleBy ?? time + SCREEN_TRACK_SETTLE_MS) : null;
  const blend = !needsMotion
    ? 1
    : previous.settleBy === null
      ? 0
      : Math.min(1, elapsed / Math.max(0.00001, settleBy! - previous.time));
  const rowGapPx = previous.rowGapPx + gapDelta * blend;
  const topPaddingPx = previous.topPaddingPx + topDelta * blend;
  const bottomPaddingPx = previous.bottomPaddingPx + bottomDelta * blend;
  for (const { row, key, goal, natural, prior, priorGap, fixed, deltas } of prepared) {
    if (!prior) {
      bands.set(key, goal);
      gaps.set(
        key,
        row.lineIndex === summary.totalRows - 1 ? bottomPadding(target) : summary.rowGapPx
      );
      stripes.set(key, goal[goal.length - 1]);
      continue;
    }
    const painted = [0];
    for (let i = 0; i < goal.length - 1; i++) {
      const size = fixed(i) ? goal[i + 1] - goal[i] : prior[i + 1] - prior[i] + deltas[i] * blend;

      const contentFloor = i <= 4 || i === 8 ? natural[i + 1] - natural[i] : 0;
      painted.push(painted[i] + Math.max(0, contentFloor, size));
    }
    bands.set(key, painted);
    const priorStripe = previous.stripes.get(key) ?? prior[prior.length - 1];
    const paintedHeight = painted[painted.length - 1];
    const stripeHeight = Math.min(
      paintedHeight,
      priorStripe + (goal[goal.length - 1] - priorStripe) * blend
    );
    stripes.set(key, stripeHeight);
    const stripeInset = paintedHeight - stripeHeight;
    if (stripeInset > 0.00001) stripeInsets.set(row.lineIndex, stripeInset);
    const goalGap =
      row.lineIndex === summary.totalRows - 1 ? bottomPadding(target) : summary.rowGapPx;
    const previousPitch = prior[prior.length - 1] + priorGap;
    const goalPitch = goal[goal.length - 1] + goalGap;
    const desiredPitch = previousPitch + (goalPitch - previousPitch) * blend;

    const gap = Math.max(0, desiredPitch - painted[painted.length - 1]);
    gaps.set(key, gap);
    if (Math.abs(gap - goalGap) > 0.00001) gapOverrides.set(row.lineIndex, gap);
    if (painted.some((y, i) => Math.abs(y - goal[i]) > 0.00001))
      overrides.set(row.lineIndex, painted);
  }

  if (options?.fastZoomInternal || previous.stripeTopOffsets.size > 0) {
    const previousTops = topsRelativeToAnchoredDna(previous.bands, previous.gaps);
    const currentTops = topsRelativeToAnchoredDna(bands, gaps);
    const goalGaps = new Map(
      prepared.map((item) => [
        item.key,
        item.row.lineIndex === summary.totalRows - 1 ? bottomPadding(target) : summary.rowGapPx,
      ])
    );
    const goalTops = topsRelativeToAnchoredDna(targets, goalGaps);
    for (const row of target.lines) {
      const slot = row.lineIndex - focal;
      const before = previousTops.get(slot);
      const after = currentTops.get(slot);
      if (before === undefined || after === undefined) continue;
      const oldVisualTop = before + (previous.stripeTopOffsets.get(slot) ?? 0);
      const goalTop = goalTops.get(slot) ?? after;
      const visualTop = oldVisualTop + (goalTop - oldVisualTop) * blend;
      const offset = Math.abs(visualTop - after) < 0.00001 ? 0 : visualTop - after;
      if (offset !== 0) {
        stripeTopOffsets.set(slot, offset);
        stripeTopOverrides.set(row.lineIndex, offset);
      }
    }
  }
  const pending =
    (needsMotion && blend < 1) ||
    gapOverrides.size > 0 ||
    stripeInsets.size > 0 ||
    stripeTopOverrides.size > 0;
  const frame = {
    anchorBp,
    time,
    bands,
    targets,
    gaps,
    stripes,
    stripeTopOffsets,
    rowGapPx,
    topPaddingPx,
    bottomPaddingPx,
    settleBy: pending ? settleBy : null,
  };
  const globalSpacingChanged =
    Math.abs(gapDelta) > 0.00001 || Math.abs(topDelta) > 0.00001 || Math.abs(bottomDelta) > 0.00001;
  if (
    !overrides.size &&
    !gapOverrides.size &&
    !stripeInsets.size &&
    !stripeTopOverrides.size &&
    !globalSpacingChanged
  )
    return { layout: target, frame, pending };
  const heightChanges = [...overrides]
    .map(([index, painted]) => ({
      index,
      height: painted[painted.length - 1],
      delta: painted[painted.length - 1] - summary.rowHeights[index],
    }))
    .filter((change) => change.delta !== 0)
    .sort((a, b) => a.index - b.index);

  const spacingChanged = globalSpacingChanged || gapOverrides.size > 0;
  let heights = summary.rowHeights,
    offsets = summary.rowYOffsets,
    totalHeight = target.totalHeight;
  if (heightChanges.length || spacingChanged) {
    if (heightChanges.length) {
      heights = Float64Array.from(summary.rowHeights);
      for (const change of heightChanges) heights[change.index] = change.height;
    }
    offsets = globalSpacingChanged
      ? new Float64Array(summary.rowYOffsets.length)
      : Float64Array.from(summary.rowYOffsets);
    if (globalSpacingChanged) {
      let index = 0,
        y = topPaddingPx;
      offsets[0] = y;
      const fillUniformGaps = (end: number) => {
        for (; index < end; index++) {
          y = y + heights[index] + rowGapPx;
          offsets[index + 1] = y;
        }
      };
      const changedGaps = [...gapOverrides]
        .filter(([row]) => row >= 0 && row < summary.totalRows)
        .sort((a, b) => a[0] - b[0]);
      for (const [row, gap] of changedGaps) {
        fillUniformGaps(row);
        y = y + heights[row] + gap;
        offsets[row + 1] = y;
        index = row + 1;
      }
      fillUniformGaps(summary.totalRows - 1);
      if (index < summary.totalRows) {
        y = y + heights[index] + bottomPaddingPx;
        offsets[index + 1] = y;
      }
    } else {
      const pitchDeltas = new Map<number, number>();
      for (const change of heightChanges) pitchDeltas.set(change.index, change.delta);
      for (const [index, gap] of gapOverrides)
        pitchDeltas.set(
          index,
          (pitchDeltas.get(index) ?? 0) +
            gap -
            (index < summary.totalRows - 1 ? summary.rowGapPx : bottomPadding(target))
        );
      const changes = [...pitchDeltas].sort((a, b) => a[0] - b[0]);
      let shift = 0;
      for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
        shift += changes[changeIndex][1];

        if (shift === 0) continue;
        const end = changes[changeIndex + 1]?.[0] ?? summary.totalRows;
        for (let i = changes[changeIndex][0] + 1; i <= end; i++) offsets[i] += shift;
      }
    }

    const tail = target.totalHeight - summary.rowYOffsets[summary.totalRows];
    totalHeight = offsets[summary.totalRows] + tail;
  }
  const lines = target.lines.map((row) => {
    const painted = overrides.get(row.lineIndex);
    const stripeInsetPx = stripeInsets.get(row.lineIndex);
    const stripeTopOffsetPx = stripeTopOverrides.get(row.lineIndex);
    return {
      ...row,
      y: offsets[row.lineIndex],
      ...(stripeInsetPx ? { stripeInsetPx } : {}),
      ...(stripeTopOffsetPx ? { stripeTopOffsetPx } : {}),
      ...(painted
        ? {
            heightScale: heights[row.lineIndex] / (row.naturalHeight ?? heights[row.lineIndex]),
            trackMorph: { natural: lineTrackBoundaries(row, config), painted },
          }
        : {}),
    };
  });
  return {
    frame,
    pending,
    layout: {
      ...target,
      lines,
      totalHeight,
      realRowsStartY: offsets[summary.topBufferCount],
      bottomBufferStartY: offsets[summary.topBufferCount + summary.realRowCount],
      summary:
        heightChanges.length || spacingChanged
          ? {
              ...summary,
              rowGapPx,
              topPaddingPx,
              rowHeights: heights,
              rowYOffsets: offsets,
              avgRowHeight: totalHeight / Math.max(1, summary.totalRows),
            }
          : summary,
    },
  };
}
