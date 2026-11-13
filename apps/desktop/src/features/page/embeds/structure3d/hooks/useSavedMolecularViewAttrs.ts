import { useEffect, useState } from 'react';
import { getEntityReference } from '../../../../../db/entity-references';
import type { Structure3dAttrs } from '../types';
import {
  molecularViewAttrs,
  molecularViewFromReferenceData,
  validateMolecularViewCoordinates,
} from '../utils/molecularView';

export function useSavedMolecularViewAttrs(
  entityId: string,
  initialAttrs?: Structure3dAttrs,
  referenceId?: string
): { attrs?: Structure3dAttrs; error?: string } | null {
  const [loaded, setLoaded] = useState<{
    referenceId: string;
    attrs?: Structure3dAttrs;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!referenceId || initialAttrs?.sourceId) return;
    let current = true;
    void (async () => {
      try {
        const reference = await getEntityReference(referenceId);
        if (reference?.locator !== `entity://structure/${entityId}`)
          throw new Error('The saved reference belongs to a different molecular view.');
        const view = molecularViewFromReferenceData(reference?.data ?? null);
        if (!view) throw new Error('This saved molecular view is unavailable.');
        await validateMolecularViewCoordinates(view);
        if (
          initialAttrs?.coordinateSha256 &&
          initialAttrs.coordinateSha256 !== view.coordinates.sha256
        )
          throw new Error('The working view belongs to different molecular coordinates.');
        const original = molecularViewAttrs(entityId, view);
        if (current)
          setLoaded({
            referenceId,
            attrs: {
              ...original,
              ...initialAttrs,
              source: original.source,
              sourceId: original.sourceId,
              coordinateSha256: original.coordinateSha256,
            },
          });
      } catch (reason) {
        if (current)
          setLoaded({
            referenceId,
            error:
              reason instanceof Error ? reason.message : 'Could not open the saved molecular view.',
          });
      }
    })();
    return () => {
      current = false;
    };
  }, [referenceId, entityId, initialAttrs]);
  if (!entityId.startsWith('saved-view:')) return null;
  if (!referenceId && !initialAttrs)
    return { error: 'Reopen this saved molecular view from its reference.' };
  return initialAttrs?.sourceId
    ? { attrs: initialAttrs }
    : loaded?.referenceId === referenceId
      ? loaded
      : {};
}
