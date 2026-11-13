'use client';

import { useCallback } from 'react';
import type { Loci } from 'molstar/lib/mol-model/loci';
import type { MolstarPlugin } from '../molstar/cache';
import { rememberViewerOverview } from '../molstar/viewerSelection';
import { activeMolViewSpecScene } from '../molstar/molViewSpec';

type FocusPlugin = {
  managers?: {
    structure?: { focus?: { setFromLoci?: (loci: Loci) => void; clear?: () => void } };
    camera?: {
      focusLoci?: (
        loci: Loci,
        opts: { minRadius: number; extraRadius: number; durationMs: number }
      ) => void;
    };
  };
};

export function useFocusClick(plugin: unknown) {
  return useCallback(
    (loci: Loci) => {
      const p = plugin as FocusPlugin | null | undefined;
      if (!p?.managers) return;
      try {
        rememberViewerOverview(plugin as MolstarPlugin);
        if (activeMolViewSpecScene(plugin as MolstarPlugin)) {
          p.managers.structure?.focus?.clear?.();
        } else {
          p.managers.structure?.focus?.setFromLoci?.(loci);
        }
        p.managers.camera?.focusLoci?.(loci, {
          minRadius: 8,
          extraRadius: 4,
          durationMs: 250,
        });
      } catch (e) {
        console.warn('[useFocusClick] Failed to focus on loci:', e);
      }
    },
    [plugin]
  );
}
