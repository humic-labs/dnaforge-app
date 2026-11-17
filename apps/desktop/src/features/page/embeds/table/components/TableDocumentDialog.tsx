import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  PresentationScopeContext,
  usePresentationOverlay,
} from '../../../../../presentation/PresentationSurface';
import { safeFocus } from '../../../../../shared/utils/safeFocus';

export function TableDocumentDialog({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const overlay = usePresentationOverlay('modal');
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    safeFocus(container.current?.querySelector<HTMLElement>('input, select, button'));
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) safeFocus(previous);
    };
  }, []);
  return createPortal(
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/40"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <div
          ref={container}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="mx-4 w-full max-w-md rounded-lg border border-border bg-bg p-5 text-fg shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              onClose();
            }
            if (event.key === 'Tab') {
              const fields = [
                ...(container.current?.querySelectorAll<HTMLElement>(
                  'input:not(:disabled), select:not(:disabled), button:not(:disabled)'
                ) ?? []),
              ];
              const first = fields[0];
              const last = fields.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                safeFocus(last);
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                safeFocus(first);
              }
            }
          }}
        >
          <h2 className="mb-4 text-base font-semibold">{title}</h2>
          {children}
        </div>
      </PresentationScopeContext.Provider>
    </div>,
    document.body
  );
}
