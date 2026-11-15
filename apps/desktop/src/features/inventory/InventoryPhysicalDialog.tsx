import { useEffect, type FormEvent, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import {
  PresentationScopeContext,
  usePresentationListener,
  usePresentationOverlay,
} from '../../presentation/PresentationSurface';
import {
  inventoryCanEdit,
  type InventoryController,
  type InventoryControllerState,
} from './inventory-controller';
import { InventoryStatusNotice } from './InventoryStatusNotice';

export function InventoryPhysicalDialog({
  title,
  subtitle,
  controller,
  status,
  onClose,
  onSubmit,
  submitLabel,
  disabled = false,
  children,
}: {
  title: string;
  subtitle?: string;
  controller: InventoryController;
  status: InventoryControllerState;
  onClose(): void;
  onSubmit?(event: FormEvent): void;
  submitLabel?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const overlay = usePresentationOverlay('modal');
  const events = usePresentationListener(overlay.scope);
  const busy = status.kind === 'submitting';
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    events.add(document, 'keydown', key);
    return () => events.remove(document, 'keydown', key);
  }, [events, busy, onClose]);
  return (
    <div
      ref={overlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
    >
      <PresentationScopeContext.Provider value={overlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="inventory-physical-dialog-title"
          data-testid="inventory-physical-dialog"
          className="flex max-h-[calc(100vh-48px)] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        >
          <header className="border-b border-border px-5 py-4">
            <h2 id="inventory-physical-dialog-title" className="text-lg font-semibold text-fg">
              {title}
            </h2>
            {subtitle ? <p className="mt-1 text-xs text-fg-muted">{subtitle}</p> : null}
          </header>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit?.(event);
            }}
          >
            <div className="min-h-0 space-y-4 overflow-y-auto p-5">
              <InventoryStatusNotice controller={controller} status={status} />
              {children}
            </div>
            <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
              <Button disabled={busy} onClick={onClose}>
                {onSubmit ? 'Cancel' : 'Close'}
              </Button>
              {onSubmit ? (
                <Button
                  type="submit"
                  variant="primary"
                  disabled={disabled || !inventoryCanEdit(status)}
                >
                  {busy ? 'Saving…' : (submitLabel ?? title)}
                </Button>
              ) : null}
            </footer>
          </form>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
