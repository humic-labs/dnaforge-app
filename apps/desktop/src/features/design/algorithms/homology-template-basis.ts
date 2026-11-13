import type { HomologyEncoding, HomologyTemplateBasis } from '../types';

export interface HomologyProjection {
  start: number;
  end: number;
  sequence: string;
}

export function extractHomologyProjection(
  composedSequence: string,
  encoding: HomologyEncoding,
  basis: HomologyTemplateBasis
): HomologyProjection {
  const seqLen = composedSequence.length;
  const onLeft = Math.max(0, encoding.onLeft);
  const onRight = Math.max(0, encoding.onRight);
  const leftStart = basis.leftHomologyEnd - onLeft;
  const leftSequence = circularSlice(composedSequence, leftStart, onLeft);
  const rightSequence = circularSlice(composedSequence, basis.rightHomologyStart, onRight);
  const start = onLeft > 0 ? leftStart : basis.rightHomologyStart;
  const end = onRight > 0 ? basis.rightHomologyStart + onRight : basis.leftHomologyEnd;

  return {
    start: normalizePosition(start, seqLen),
    end: normalizePosition(end, seqLen),
    sequence: leftSequence + rightSequence,
  };
}

function circularSlice(sequence: string, start: number, length: number): string {
  if (sequence.length === 0 || length <= 0) return '';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += sequence[normalizePosition(start + i, sequence.length)] ?? '';
  }
  return result;
}

function normalizePosition(position: number, length: number): number {
  if (length <= 0) return 0;
  return ((Math.round(position) % length) + length) % length;
}
