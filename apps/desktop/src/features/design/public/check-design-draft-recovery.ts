import { DocumentReadError } from '../../../shared/document-read-failure';
import { sha256Hex } from '../../../shared/sha256-sync';
import { normalizeAssemblySlots } from '../assembly-slots';
import { designContentIdentity } from '../design-recovery';
import { useDesignStore } from '../store';

/** Checks the renderer-owned design draft that the legacy file's opener would show. */
export function checkDesignDraftRecovery(designId: string): string {
  const { designs } = useDesignStore.getState();
  if (!Object.hasOwn(designs, designId)) throw new DocumentReadError('missing-asset', true);
  const draft = designs[designId];
  if (
    !draft ||
    draft.id !== designId ||
    typeof draft.name !== 'string' ||
    !Array.isArray(draft.regions) ||
    !Array.isArray(draft.spacers) ||
    draft.regions.some(
      (region) => !region || typeof region.id !== 'string' || typeof region.sequence !== 'string'
    ) ||
    draft.spacers.some((spacer) => !spacer || typeof spacer.sequence !== 'string')
  )
    throw new DocumentReadError('malformed', true);
  try {
    normalizeAssemblySlots(draft);
    return sha256Hex(designContentIdentity(draft));
  } catch (cause) {
    if (cause instanceof EvalError || cause instanceof ReferenceError || !(cause instanceof Error))
      throw cause;
    throw new DocumentReadError('malformed', true, { cause });
  }
}
