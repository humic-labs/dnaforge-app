'use client';

import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { safeFocus } from '@/shared/utils/safeFocus';
import { useFlowManager } from './flow-context';
import { embedRegistry } from '../../embeds/registry';
import type { PickerSize } from '../../embeds/types';

const sizeWidths: Record<PickerSize, string> = {
  sm: 'w-[320px]',
  md: 'w-[400px]',
  lg: 'w-[560px]',
  xl: 'w-[720px]',
};

export function FlowPopup({ returnFocusTarget }: { returnFocusTarget?: HTMLElement | null }) {
  const { activeFlow, advanceFlow, goBack, cancelFlow } = useFlowManager();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(cancelFlow);
  cancelRef.current = cancelFlow;
  const titleId = useId();
  const isOpen = Boolean(activeFlow);
  const returnFocus = useMemo(
    () =>
      isOpen
        ? (returnFocusTarget ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null))
        : null,
    [isOpen, returnFocusTarget]
  );

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
        )
      );
    if (!dialog.contains(document.activeElement)) {
      safeFocus(
        dialog.querySelector<HTMLElement>('input:not(:disabled)') ?? focusable()[0] ?? dialog
      );
    }
    let lastFocused = document.activeElement as HTMLElement | null;
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && dialog.contains(event.target)) {
        lastFocused = event.target;
      } else {
        safeFocus(lastFocused?.isConnected ? lastFocused : (focusable()[0] ?? dialog), {
          preventScroll: true,
        });
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
      } else if (event.key === 'Tab') {
        const controls = focusable();
        const first = controls[0] ?? dialog;
        const last = controls[controls.length - 1] ?? dialog;
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialog.contains(document.activeElement))
        ) {
          event.preventDefault();
          safeFocus(last);
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !dialog.contains(document.activeElement))
        ) {
          event.preventDefault();
          safeFocus(first);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', containFocus);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', containFocus);
      queueMicrotask(() => safeFocus(returnFocus, { preventScroll: true }));
    };
  }, [isOpen, returnFocus]);

  if (!activeFlow) return null;

  const picker = embedRegistry.getPicker(activeFlow.flowName);
  if (!picker) {
    console.warn(`[FlowPopup] Picker not found: ${activeFlow.flowName}`);
    return null;
  }

  const stage = picker.stages[activeFlow.stageIndex];
  if (!stage) {
    console.warn(`[FlowPopup] Stage not found: ${activeFlow.stageIndex}`);
    return null;
  }

  const StageComponent = stage.component;
  const isMultiStage = picker.stages.length > 1;
  const size = embedRegistry.getPickerSize(activeFlow.flowName);
  const widthClass = sizeWidths[size];

  return createPortal(
    <div className="fixed inset-0 z-[10040] flex items-start justify-center p-4 pt-[min(20vh,96px)]">
      {}
      <div className="absolute inset-0 bg-black/20" onClick={cancelFlow} aria-hidden="true" />

      {}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`relative flex max-h-[calc(100dvh-min(20vh,96px)-16px)] max-w-full flex-col bg-bg text-fg border border-border rounded-lg shadow-xl ${widthClass} overflow-hidden`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {}
        <div className="flex shrink-0 items-center justify-between px-4 py-3 border-b border-border bg-bg-subtle">
          <div className="flex items-center gap-2">
            {activeFlow.stageIndex > 0 && (
              <button
                onClick={goBack}
                type="button"
                className="p-1 text-fg-muted hover:text-fg hover:bg-bg-muted rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                aria-label="Go back"
              >
                <ChevronLeftIcon className="w-4 h-4" />
              </button>
            )}
            <span id={titleId} className="text-sm font-medium">
              {stage.name}
            </span>
          </div>
          <button
            onClick={cancelFlow}
            type="button"
            className="p-1 text-fg-muted hover:text-fg hover:bg-bg-muted rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Cancel"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {}
        <div className="min-h-0 overflow-y-auto p-4">
          <StageComponent
            data={activeFlow.data}
            onAdvance={advanceFlow}
            onBack={goBack}
            onCancel={cancelFlow}
          />
        </div>

        {}
        {isMultiStage && (
          <div className="flex shrink-0 justify-center gap-1.5 pb-3">
            {picker.stages.map((_, i) => (
              <div
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i <= activeFlow.stageIndex ? 'bg-accent' : 'bg-border'
                }`}
                aria-label={
                  i < activeFlow.stageIndex
                    ? 'Completed'
                    : i === activeFlow.stageIndex
                      ? 'Current'
                      : 'Upcoming'
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
