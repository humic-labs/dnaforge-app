import { useCallback, useEffect, useMemo } from 'react';
import { matchesShortcut } from '@waypoint/ui-components/keyboard';
import type { SequenceChange } from '../diff/sequence-diff';

interface UseChangeNavigationResult {
  jumpToNext: () => number | null;
  jumpToPrev: () => number | null;
  changeCount: number;
}

export function useChangeNavigation(
  changes: SequenceChange[],
  currentPosition: number,
  onScrollToPosition: (position: number) => void
): UseChangeNavigationResult {
  const sortedChanges = useMemo(
    () => [...changes].sort((a, b) => a.position - b.position),
    [changes]
  );

  const jumpToNext = useCallback((): number | null => {
    if (sortedChanges.length === 0) return null;

    const nextChange = sortedChanges.find((c) => c.position > currentPosition);
    const target = nextChange ?? sortedChanges[0];

    onScrollToPosition(target.position);
    return target.position;
  }, [sortedChanges, currentPosition, onScrollToPosition]);

  const jumpToPrev = useCallback((): number | null => {
    if (sortedChanges.length === 0) return null;

    const prevChanges = sortedChanges.filter((c) => c.position < currentPosition);
    const target =
      prevChanges.length > 0
        ? prevChanges[prevChanges.length - 1]
        : sortedChanges[sortedChanges.length - 1];

    onScrollToPosition(target.position);
    return target.position;
  }, [sortedChanges, currentPosition, onScrollToPosition]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, ['cmd', 'shift', 'arrowdown'])) {
        e.preventDefault();
        jumpToNext();
      } else if (matchesShortcut(e, ['cmd', 'shift', 'arrowup'])) {
        e.preventDefault();
        jumpToPrev();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jumpToNext, jumpToPrev]);

  return {
    jumpToNext,
    jumpToPrev,
    changeCount: sortedChanges.length,
  };
}

export function findNextChangePosition(
  changes: Array<{ position: number }>,
  currentPosition: number
): number | null {
  if (changes.length === 0) return null;
  const sorted = [...changes].sort((a, b) => a.position - b.position);
  const next = sorted.find((c) => c.position > currentPosition);
  return (next ?? sorted[0]).position;
}

export function findPrevChangePosition(
  changes: Array<{ position: number }>,
  currentPosition: number
): number | null {
  if (changes.length === 0) return null;
  const sorted = [...changes].sort((a, b) => a.position - b.position);
  const prev = sorted.filter((c) => c.position < currentPosition);
  return prev.length > 0 ? prev[prev.length - 1].position : sorted[sorted.length - 1].position;
}
