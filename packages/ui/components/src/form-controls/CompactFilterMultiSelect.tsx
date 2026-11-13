import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { CompactFilterSelectOption } from './CompactFilterSelect';

interface MenuPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const MENU_VIEWPORT_MARGIN = 8;

export interface CompactFilterMultiSelectProps<T extends string> {
  values: readonly T[];
  options: readonly CompactFilterSelectOption<T>[];
  onChange: (values: T[]) => void;
  ariaLabel: string;
  allLabel: string;
  className?: string;
  disabled?: boolean;
  density?: 'compact' | 'default';
  menuAlign?: 'start' | 'end';
  testId?: string;
}

export function CompactFilterMultiSelect<T extends string>({
  values,
  options,
  onChange,
  ariaLabel,
  allLabel,
  className = '',
  disabled = false,
  density = 'compact',
  menuAlign = 'start',
  testId,
}: CompactFilterMultiSelectProps<T>): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPlacement, setMenuPlacement] = useState<MenuPlacement | null>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) {
      setMenuPlacement(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const place = (): void => {
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.min(rect.width, viewportWidth);
      const alignedLeft = menuAlign === 'end' ? rect.right - width : rect.left;
      setMenuPlacement({
        top: rect.bottom,
        left: Math.min(Math.max(0, alignedLeft), viewportWidth - width),
        width,
        maxHeight: Math.max(80, window.innerHeight - rect.bottom - MENU_VIEWPORT_MARGIN),
      });
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(trigger);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [menuAlign, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const selected = new Set(values);
  const summary =
    values.length === 0
      ? allLabel
      : values.length === 1
        ? (options.find((option) => option.value === values[0])?.label ?? values[0])
        : `${values.length} selected`;

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-testid={testId}
        data-compact-filter-multiselect="true"
        onClick={() => setOpen((current) => !current)}
        className={`relative z-[1] flex w-full cursor-pointer items-center justify-between gap-1 border bg-bg pl-2 pr-1.5 text-fg shadow-sm outline-none hover:border-fg-muted focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? 'rounded-t-md rounded-b-none border-accent border-b-0 shadow-none'
            : 'rounded-md border-border'
        } ${density === 'compact' ? 'h-6 py-0.5 text-[11px]' : 'h-7 py-1 text-[13px]'}`}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          className="shrink-0 text-fg-muted"
        >
          <path
            d="M2.5 4L5 6.5L7.5 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && menuPlacement
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={ariaLabel}
              data-compact-filter-menu="true"
              data-menu-align={menuAlign}
              onMouseDown={(event) => event.stopPropagation()}
              className="fixed z-[10060] box-border overflow-y-auto rounded-b-md rounded-t-none border border-t-0 border-accent bg-bg p-1.5 text-xs shadow-lg"
              style={menuPlacement}
            >
              <div className="mb-1 flex items-center justify-end border-b border-border pb-1">
                <button
                  type="button"
                  className="text-fg-subtle hover:text-fg hover:underline disabled:opacity-40"
                  disabled={values.length === 0}
                  onClick={() => onChange([])}
                >
                  Clear
                </button>
              </div>
              <div className="max-h-52 space-y-0.5 overflow-y-auto pr-1">
                {options.map((option) => {
                  const checked = selected.has(option.value);
                  return (
                    <label
                      key={option.value}
                      className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-fg hover:bg-bg-muted hover:text-accent ${
                        option.disabled ? 'pointer-events-none opacity-40' : ''
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 accent-accent"
                        data-testid={testId ? `${testId}-option-${option.value}` : undefined}
                        checked={checked}
                        disabled={option.disabled}
                        onChange={() =>
                          onChange(
                            checked
                              ? values.filter((value) => value !== option.value)
                              : [...values, option.value]
                          )
                        }
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
