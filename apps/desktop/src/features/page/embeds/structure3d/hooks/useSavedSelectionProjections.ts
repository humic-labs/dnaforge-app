'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  HighlightGroup,
  SavedSelectionViewRef,
  StructureCoordinateArtifactRef,
} from '../types';
import { loadSavedSelectionProjectionsFromFolders } from '../utils/savedSelectionPersistence';

const EMPTY_GROUPS: HighlightGroup[] = [];

export function useSavedSelectionProjections(
  workspaceFolders: ReadonlyArray<{ path: string }>,
  refs: ReadonlyArray<SavedSelectionViewRef> | undefined,
  structureArtifactRef: StructureCoordinateArtifactRef | undefined
): { groups: HighlightGroup[]; errors: string[] } {
  const refsKey = useMemo(() => JSON.stringify(refs ?? []), [refs]);
  const [state, setState] = useState<{ groups: HighlightGroup[]; errors: string[] }>({
    groups: EMPTY_GROUPS,
    errors: [],
  });

  useEffect(() => {
    let cancelled = false;
    const currentRefs = refs ?? [];
    if (currentRefs.length === 0) {
      setState({ groups: EMPTY_GROUPS, errors: [] });
      return () => {
        cancelled = true;
      };
    }
    if (workspaceFolders.length === 0) {
      setState({
        groups: EMPTY_GROUPS,
        errors: currentRefs.map(
          (ref) => `${ref.selectionId}: project unavailable for saved selection`
        ),
      });
      return () => {
        cancelled = true;
      };
    }
    void loadSavedSelectionProjectionsFromFolders(
      workspaceFolders,
      currentRefs,
      structureArtifactRef
    ).then((result) => {
      if (cancelled) return;
      setState({
        groups: result.groups,
        errors: result.errors.map(({ ref, error }) => `${ref.selectionId}: ${error}`),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceFolders, refsKey, refs, structureArtifactRef]);

  return state;
}
