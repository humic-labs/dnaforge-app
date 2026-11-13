import type { AcceptedAssemblyProjectionInput } from './accepted-types';

export function acceptedProductRegionPositions(
  input: Pick<AcceptedAssemblyProjectionInput, 'regions' | 'spacers'>
): { start: number; end: number }[] {
  const positions: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const [regionIndex, region] of input.regions.entries()) {
    positions.push({ start: cursor, end: cursor + region.sequence.length });
    cursor += region.sequence.length;
    cursor +=
      input.spacers.find((spacer) => spacer.junctionIndex === regionIndex)?.sequence.length ?? 0;
  }
  return positions;
}
