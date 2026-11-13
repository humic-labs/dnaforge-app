import { bpCoordinateChunk, bpCoordinateDelta } from './bp-coordinate-packing';
import type { DirectionalBlock } from './transcript-glyph-vertices';

export const TRANSCRIPT_GLYPH_INSTANCE_CORNERS = new Float32Array([0, 1, 2, 0, 2, 3, 0, 3, 4]);

export const TRANSCRIPT_GLYPH_INSTANCE_LAYOUT = {
  bpStartChunk: 0,
  bpStartDelta: 1,
  bpEndChunk: 2,
  bpEndDelta: 3,
  offsetCenter: 4,
  halfH: 5,
  dirSign: 6,
  cdsFade: 7,
  color: 8,
  strideFloats: 12,
  strideBytes: 12 * Float32Array.BYTES_PER_ELEMENT,
} as const;

export interface TranscriptGlyphInstances {
  data: Float32Array;
  instanceCount: number;
}

export function packTranscriptGlyphInstances(
  blocks: ReadonlyArray<Omit<DirectionalBlock, 'role'>>
): TranscriptGlyphInstances {
  const { strideFloats: stride } = TRANSCRIPT_GLYPH_INSTANCE_LAYOUT;
  const data = new Float32Array(blocks.length * stride);

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const base = i * stride;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk] = bpCoordinateChunk(block.startBp);
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta] = bpCoordinateDelta(block.startBp);
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk] = bpCoordinateChunk(block.endBp);
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta] = bpCoordinateDelta(block.endBp);
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter] = block.offsetCenter;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH] = block.halfH;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign] = block.dirSign;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.cdsFade] = block.cdsFade;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color] = ((block.color >> 16) & 0xff) / 255;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 1] = ((block.color >> 8) & 0xff) / 255;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 2] = (block.color & 0xff) / 255;
    data[base + TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color + 3] = block.alpha;
  }

  return { data, instanceCount: blocks.length };
}
