import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { safeFocus } from '../utils/safeFocus';

export type DownwardSelectOption<T extends string> = {
  value: T;
  label: string;
  labelNode?: ReactNode;
  detail?: UserMessage | null;
  emphasis?: boolean;
  warn?: boolean;
  testId?: string;
  data?: Record<string, string>;
};

export function DownwardSelect<T extends string>({
  value,
  label,
  warn = false,
  warnIcon,
  options,
  onChange,
  disabled = false,
  title,
  testId,
  ariaLabel,
  className,
  privateContent = false,
  searchable = false,
  searchLabel = 'Search options',
}: {
  value: T;
  label: string;
  warn?: boolean;
  warnIcon?: ReactNode;
  options: readonly DownwardSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
  testId?: string;
  ariaLabel?: string;
  className?: string;
  privateContent?: boolean;
  searchable?: boolean;
  searchLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    minWidth: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);

  const PAD = 8;
  const filteredOptions =
    searchable && search.trim()
      ? options.filter((option) => option.label.toLowerCase().includes(search.trim().toLowerCase()))
      : options;

  useEffect(() => {
    if (open && pos && searchable) safeFocus(searchRef.current);
  }, [open, pos, searchable]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const box = triggerRef.current?.getBoundingClientRect();
      if (!box) return;
      const minWidth = Math.max(box.width, 176);
      const maxWidth = Math.max(minWidth, window.innerWidth - PAD * 2);
      const width = Math.min(Math.max(menuRef.current?.offsetWidth ?? 0, minWidth), maxWidth);
      const left = Math.max(PAD, Math.min(box.left, window.innerWidth - width - PAD));
      const maxHeight = Math.max(176, window.innerHeight - box.bottom - PAD * 3);
      setPos({ left, top: box.bottom + 4, minWidth, maxWidth, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !pos) return;
    const box = triggerRef.current?.getBoundingClientRect();
    const width = menuRef.current?.offsetWidth;
    if (!box || !width) return;
    const left = Math.max(PAD, Math.min(box.left, window.innerWidth - width - PAD));
    if (Math.abs(left - pos.left) > 0.5) setPos({ ...pos, left });
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        safeFocus(triggerRef.current);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative min-w-0 max-w-full">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        data-value={value}
        aria-haspopup={searchable ? 'dialog' : 'listbox'}
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setSearch('');
          setOpen((current) => !current);
        }}
        className={
          className ??
          'inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-bg-base py-1 pl-2 pr-5 text-xs shadow-sm outline-none transition-colors hover:border-fg-muted focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50'
        }
      >
        <span className="truncate">{label}</span>
        {warn && warnIcon ? (
          <span data-testid={testId ? `${testId}-warn` : undefined} className="inline-flex">
            {warnIcon}
          </span>
        ) : null}
      </button>
      <div className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-muted">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2.5 4L5 6.5L7.5 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role={searchable ? 'dialog' : 'listbox'}
            data-placement="below"
            data-testid={testId ? `${testId}-menu` : undefined}
            data-ph-no-capture={privateContent || undefined}
            data-analytics-block={privateContent || undefined}
            data-ph-mask={privateContent || undefined}
            aria-label={ariaLabel}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              minWidth: pos.minWidth,
              maxWidth: pos.maxWidth,
              maxHeight: pos.maxHeight,
            }}
            className={`z-[100] overflow-y-auto rounded-md border border-border bg-bg py-1 text-fg shadow-lg ${privateContent ? 'ph-no-capture rr-block' : ''}`}
          >
            {searchable ? (
              <div className="sticky top-0 z-10 border-b border-border bg-bg px-2 pb-2 pt-1">
                <input
                  ref={searchRef}
                  type="search"
                  aria-label={searchLabel}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && filteredOptions[0]) {
                      event.preventDefault();
                      onChange(filteredOptions[0].value);
                      setOpen(false);
                      safeFocus(triggerRef.current);
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      (
                        menuRef.current?.querySelector(
                          '[role="option"]'
                        ) as HTMLButtonElement | null
                      )?.focus();
                    }
                  }}
                  className="h-8 w-full rounded border border-border bg-bg px-2 text-xs text-fg outline-none focus:border-accent"
                />
              </div>
            ) : null}
            <div
              role={searchable ? 'listbox' : 'presentation'}
              aria-label={searchable ? ariaLabel : undefined}
            >
              {filteredOptions.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-testid={option.testId}
                    data-value={option.value}
                    {...option.data}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                      safeFocus(triggerRef.current);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                      event.preventDefault();
                      const rows = Array.from(
                        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
                          []
                      );
                      const index = rows.indexOf(event.currentTarget);
                      rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
                      if (event.key === 'ArrowUp' && index === 0) safeFocus(searchRef.current);
                    }}
                    className={`flex w-full items-center justify-between gap-3 py-1 pl-2 pr-2.5 text-left text-xs ${
                      option.emphasis
                        ? 'bg-accent/10 font-medium text-accent hover:bg-accent/15'
                        : selected
                          ? 'bg-fg/5 text-fg'
                          : 'text-fg hover:bg-fg/5'
                    }`}
                  >
                    <span className="min-w-0 flex-1">{option.labelNode ?? option.label}</span>
                    {option.detail ? (
                      <span
                        className={`inline-flex shrink-0 items-center gap-1 ${
                          option.emphasis ? 'text-accent/80' : 'text-fg-muted'
                        }`}
                      >
                        {option.warn ? warnIcon : null}
                        <span>{toUserMessage(option.detail, 'operation.failed')}</span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-fg-muted">No matches</div>
              ) : null}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
