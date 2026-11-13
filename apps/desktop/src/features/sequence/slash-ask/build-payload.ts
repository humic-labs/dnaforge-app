import { computeCaretWindow } from './caret-window';

export interface SlashAskSelectionSnapshot {
  sourceRange: { start: number; end: number; wraps?: boolean } | null;
  sourceCaret: number | null;
  sequenceLength: number;
  isCircular: boolean;
}

export interface SlashAskRangePayload {
  range: { start: number; end: number; wraps?: boolean };
  inferredWindow: boolean;
}

export function buildSlashAskPayload(
  snapshot: SlashAskSelectionSnapshot
): SlashAskRangePayload | null {
  if (snapshot.sourceRange) {
    return { range: { ...snapshot.sourceRange }, inferredWindow: false };
  }
  if (snapshot.sourceCaret != null) {
    const window = computeCaretWindow(
      snapshot.sourceCaret,
      snapshot.sequenceLength,
      snapshot.isCircular
    );
    return { range: { start: window.start, end: window.end }, inferredWindow: true };
  }
  return null;
}
