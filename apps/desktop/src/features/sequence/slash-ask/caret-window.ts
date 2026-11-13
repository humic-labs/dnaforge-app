export const SLASH_ASK_CARET_WINDOW_CODONS = 10;

const BP_PER_CODON = 3;

export function computeCaretWindow(
  caret1Based: number,
  sequenceLength: number,
  _isCircular: boolean
): { start: number; end: number } {
  const half = SLASH_ASK_CARET_WINDOW_CODONS * BP_PER_CODON;
  const clampedCaret = Math.min(Math.max(Math.round(caret1Based), 1), Math.max(sequenceLength, 1));

  let start = clampedCaret - half;
  const frameOffset = (((start - 1) % BP_PER_CODON) + BP_PER_CODON) % BP_PER_CODON;
  start -= frameOffset;
  if (start < 1) start = 1;

  const span = 2 * SLASH_ASK_CARET_WINDOW_CODONS * BP_PER_CODON;
  let end = start + span - 1;
  if (end > sequenceLength) end = sequenceLength;

  return { start, end };
}
