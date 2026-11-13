import { useEffect, useRef } from 'react';

const changedBetweenViews = (before: unknown, after: unknown) =>
  before !== undefined && after !== undefined && before !== after;

export function useResetSelectionOnViewChange(
  scene: string | undefined,
  snapshotIndex: number | undefined,
  recipeId: string | null | undefined,
  sourceKey: string,
  clearSelection: () => void,
  ready = true
) {
  const previous = useRef({ scene, snapshotIndex, recipeId, sourceKey, ready });
  useEffect(() => {
    const last = previous.current;
    const sameSource = last.sourceKey === sourceKey;
    previous.current = sameSource
      ? {
          scene: scene ?? last.scene,
          snapshotIndex: snapshotIndex ?? last.snapshotIndex,
          recipeId,
          sourceKey,
          ready,
        }
      : { scene, snapshotIndex, recipeId, sourceKey, ready };
    const initialAttachment =
      sameSource &&
      last.scene === undefined &&
      scene !== undefined &&
      (last.snapshotIndex ?? 0) === (snapshotIndex ?? 0);
    if (!ready || !last.ready) return;
    if (
      !sameSource ||
      (!initialAttachment && last.recipeId !== recipeId) ||
      changedBetweenViews(last.scene, scene) ||
      changedBetweenViews(last.snapshotIndex, snapshotIndex)
    )
      clearSelection();
  }, [scene, snapshotIndex, recipeId, sourceKey, clearSelection, ready]);
}
