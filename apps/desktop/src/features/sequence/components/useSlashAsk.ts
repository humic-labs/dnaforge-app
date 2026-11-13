import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { useEffect, useRef } from 'react';
import { canOpenSlashAsk } from '../slash-ask/gate';
import {
  buildSlashAskPayload,
  type SlashAskRangePayload,
  type SlashAskSelectionSnapshot,
} from '../slash-ask/build-payload';

export interface UseSlashAskArgs {
  isEditMode: boolean;
  getSelectionSnapshot: () => SlashAskSelectionSnapshot;
  onTrigger: (payload: SlashAskRangePayload) => void;
  disabled?: boolean;
}

function hasOpenDialog(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[aria-modal="true"]') !== null;
}

export function useSlashAsk({
  isEditMode,
  getSelectionSnapshot,
  onTrigger,
  disabled,
}: UseSlashAskArgs): void {
  const presentationEvents = usePresentationListener();

  const isEditModeRef = useRef(isEditMode);
  isEditModeRef.current = isEditMode;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const snapshotRef = useRef(getSelectionSnapshot);
  snapshotRef.current = getSelectionSnapshot;
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;
  const inFlightRef = useRef(false);
  const inFlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      if (e.defaultPrevented) return;
      if (disabledRef.current) return;
      if (inFlightRef.current) {
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const gateOk = canOpenSlashAsk({
        isEditMode: isEditModeRef.current,
        activeElement: document.activeElement,
        hasOpenDialog: hasOpenDialog(),
      });
      if (!gateOk) return;

      const payload = buildSlashAskPayload(snapshotRef.current());
      if (!payload) return;

      e.preventDefault();
      inFlightRef.current = true;
      if (inFlightTimerRef.current) clearTimeout(inFlightTimerRef.current);
      inFlightTimerRef.current = setTimeout(() => {
        inFlightRef.current = false;
        inFlightTimerRef.current = null;
      }, 500);
      onTriggerRef.current(payload);
    };

    presentationEvents.add(document, 'keydown', handler);
    return () => {
      presentationEvents.remove(document, 'keydown', handler);
      if (inFlightTimerRef.current) clearTimeout(inFlightTimerRef.current);
    };
  }, [presentationEvents]);
}
