export function packIntoLanes<T>(
  sorted: Array<{ item: T; ranges: Array<{ start: number; end: number }> }>
): { packed: Array<{ item: T; lane: number }>; laneCount: number } {
  const laneRanges: Array<Array<{ start: number; end: number }>> = [];
  const packed: Array<{ item: T; lane: number }> = [];

  for (const { item, ranges } of sorted) {
    if (ranges.length === 0) continue;

    let sweepStart = ranges[0].start;
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i].start < sweepStart) sweepStart = ranges[i].start;

    let assignedLane = -1;
    for (let lane = 0; lane < laneRanges.length; lane++) {
      const laneOccupied = laneRanges[lane];
      let active = 0;
      for (const occupied of laneOccupied)
        if (occupied.end > sweepStart) laneOccupied[active++] = occupied;
      laneOccupied.length = active;
      let hasOverlap = false;
      for (const myRange of ranges) {
        for (const occupied of laneOccupied) {
          if (myRange.start < occupied.end && occupied.start < myRange.end) {
            hasOverlap = true;
            break;
          }
        }
        if (hasOverlap) break;
      }
      if (!hasOverlap) {
        assignedLane = lane;
        break;
      }
    }

    if (assignedLane === -1) {
      assignedLane = laneRanges.length;
      laneRanges.push([]);
    }

    for (const range of ranges) laneRanges[assignedLane].push(range);
    packed.push({ item, lane: assignedLane });
  }

  return { packed, laneCount: laneRanges.length };
}
