import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PortalMenu } from '@/components/PortalMenu';
import { safeFocus } from '@/shared/utils/safeFocus';

export function ColorPalette({
  label,
  colors,
  value,
  onPick,
  onClear,
  disabled = false,
  className,
  testId,
  children,
}: {
  label: string;
  colors: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  value?: string | null;
  onPick: (color: string) => void;
  onClear: () => void;
  disabled?: boolean;
  className: string;
  testId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    safeFocus(triggerRef.current, { preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      safeFocus(
        menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
          menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
      )
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        className={`${className} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      <PortalMenu
        open={open && !disabled}
        anchorRef={triggerRef}
        surfaceRef={menuRef}
        onRequestClose={close}
        role="menu"
        aria-label={label}
        horizontalAlign="start"
        preferredSide="bottom"
        className="p-2"
      >
        <div
          onKeyDown={(event) => {
            const controls = Array.from(
              menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []
            );
            const index = controls.indexOf(document.activeElement as HTMLElement);
            let next: number;
            switch (event.key) {
              case 'ArrowRight':
                next = (index + 1) % controls.length;
                break;
              case 'ArrowLeft':
                next = (index - 1 + controls.length) % controls.length;
                break;
              case 'ArrowDown':
                next = Math.min(index + 4, controls.length - 1);
                break;
              case 'ArrowUp':
                next = Math.max(index - 4, 0);
                break;
              case 'Home':
                next = 0;
                break;
              case 'End':
                next = controls.length - 1;
                break;
              case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
              case 'Tab':
                setOpen(false);
                return;
              default:
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            safeFocus(controls[next]);
          }}
        >
          <div className="grid grid-cols-4 gap-1.5">
            {colors.map((color) => (
              <button
                key={color.value}
                type="button"
                role="menuitemradio"
                aria-label={color.name}
                aria-checked={value === color.value}
                title={color.name}
                data-testid={
                  testId
                    ? `${testId.replace(/-colors$/, '')}-${color.name.toLowerCase()}`
                    : undefined
                }
                className="h-6 w-6 rounded-sm border border-border hover:border-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={{ backgroundColor: color.value }}
                onClick={() => {
                  onPick(color.value);
                  close();
                }}
              />
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            aria-label={`Remove ${label === 'Highlight color' ? 'highlight' : label.toLowerCase()}`}
            data-testid={testId ? `${testId.replace(/-colors$/, '')}-none` : undefined}
            className="mt-2 w-full rounded px-2 py-1 text-left text-xs text-fg-muted hover:bg-bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => {
              onClear();
              close();
            }}
          >
            Reset color
          </button>
        </div>
      </PortalMenu>
    </>
  );
}
