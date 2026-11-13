import type { DirectionalBlock } from './transcript-glyph-vertices';

export function blocksOverlappingRange(
  allBlocks: ReadonlyArray<DirectionalBlock>,
  startBp: number,
  endBp: number
): DirectionalBlock[] {
  const out: DirectionalBlock[] = [];
  for (const block of allBlocks) {
    if (block.startBp < endBp && block.endBp > startBp) out.push(block);
  }
  return out;
}
