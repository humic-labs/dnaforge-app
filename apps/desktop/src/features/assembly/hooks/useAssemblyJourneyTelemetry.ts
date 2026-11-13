import { useEffect, useRef } from 'react';
import { useCanvasStore } from '../../canvas/public/store';
import type { SequenceDesign } from '../../design/public/types';
import {
  assemblyInputObservation,
  observeAssemblyInputs,
  observeVisibleAssemblyReopen,
} from '../journey-telemetry';

export function useAssemblyJourneyTelemetry(
  design:
    | Pick<SequenceDesign, 'id' | 'regions' | 'constructId' | 'parentAcceptedAssemblyVersionId'>
    | undefined
): void {
  const active = useCanvasStore((state) =>
    Object.values(state.panels).some((panel) =>
      panel.tabs.some(
        (tab) =>
          panel.activeTabId === tab.id &&
          (tab.entityId === design?.id || tab.assemblyEditDesignId === design?.id)
      )
    )
  );
  const lastInput = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !design) return;
    const observation = assemblyInputObservation(design);
    const key = `${design.id}:${observation.resultCount}:${observation.selectedCount}`;
    if (key !== lastInput.current) {
      lastInput.current = key;
      observeAssemblyInputs(design);
    }
    observeVisibleAssemblyReopen(design);
  }, [active, design]);
}
