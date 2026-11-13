import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UI_POPOVER_LAYER_CLASS } from '../../../components/ui/styles';

export interface FieldMappingOption {
  value: string;
  label: string;
  custom?: boolean;
  required?: boolean;
}

export function FieldMappingPicker({
  columnName,
  value,
  mappingMode,
  options,
  columnsByField,
  isDuplicate,
  onChange,
  onIgnore,
}: {
  columnName: string;
  value: string;
  mappingMode: 'mapped' | 'source_only' | 'ignored';
  options: readonly FieldMappingOption[];
  columnsByField: Map<string, string[]>;
  isDuplicate: boolean;
  onChange: (value: string | null) => void;
  onIgnore: () => void;
}) {
  const presentationEvents = usePresentationListener();

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const current = value === '' ? undefined : options.find((o) => o.value === value);
  const isMapped = value !== '';
  const isIgnored = mappingMode === 'ignored';
  const currentLabel = current?.label ?? (isIgnored ? 'Ignored' : 'Custom field');
  const takenByOther = (optionValue: string): boolean =>
    (columnsByField.get(optionValue) ?? []).some((claimant) => claimant !== columnName);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const pad = 8;
      const width = Math.max(t.width, 216);
      const menuH = menuRef.current?.offsetHeight ?? 0;
      const left = Math.max(pad, Math.min(t.left, window.innerWidth - width - pad));
      let top = t.bottom + 4;
      if (menuH && top + menuH > window.innerHeight - pad) top = Math.max(pad, t.top - menuH - 4);
      setPos({ left, top, width });
    };
    place();
    const onViewportChange = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      place();
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        !triggerRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    presentationEvents.add(document, 'keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      presentationEvents.remove(document, 'keydown', onKey);
    };
  }, [open, presentationEvents]);

  const pick = (next: string) => {
    setOpen(false);
    onChange(next === '' ? null : next);
  };

  const triggerClass = isDuplicate
    ? 'border-error bg-error/5 text-error'
    : isMapped
      ? 'border-accent/50 bg-accent/5 text-fg hover:border-accent'
      : isIgnored
        ? 'border-dashed border-border bg-bg-subtle/60 text-fg-subtle hover:border-accent'
        : 'border-dashed border-border bg-bg text-fg-muted hover:border-accent';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={`lims-import-colmap-${columnName}`}
        data-value={value}
        data-mapped={isMapped}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={isDuplicate}
        aria-label={`Map column ${columnName} to a registry field`}
        onClick={() => setOpen((v) => !v)}
        className={`mt-0.5 flex h-7 w-full min-w-0 items-center gap-1.5 rounded border px-2 text-xs outline-none focus:border-accent ${triggerClass}`}
      >
        <FieldMarker
          mapped={isMapped}
          className={isDuplicate ? 'text-error' : isMapped ? 'text-accent' : 'text-fg-subtle'}
        />
        <span className="min-w-0 flex-1 truncate text-left">{currentLabel}</span>
        {isMapped && current?.custom && (
          <span
            data-testid={`lims-import-colmap-${columnName}-customtag`}
            className="flex-shrink-0 rounded border border-border bg-bg-subtle px-1 py-px text-[9px] uppercase tracking-wide text-fg-subtle"
          >
            custom
          </span>
        )}
        <Chevron open={open} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            data-testid={`lims-import-colmenu-${columnName}`}
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width }}
            className={`${UI_POPOVER_LAYER_CLASS} max-h-72 overflow-y-auto rounded border border-border bg-bg py-1 text-fg shadow-lg`}
          >
            {options.map((option) => (
              <PickerRow
                key={option.value}
                testId={`lims-import-colopt-${columnName}-${option.value}`}
                label={option.label}
                custom={option.custom}
                required={option.required}
                selected={value === option.value}
                takenByOther={takenByOther(option.value)}
                onClick={() => pick(option.value)}
              />
            ))}
            <div className="my-1 border-t border-border/60" />
            <PickerRow
              testId={`lims-import-colopt-${columnName}-note`}
              label="Keep as custom field"
              muted
              selected={mappingMode === 'source_only'}
              onClick={() => pick('')}
            />
            <PickerRow
              testId={`lims-import-colopt-${columnName}-ignore`}
              label="Ignore this column"
              muted
              selected={mappingMode === 'ignored'}
              onClick={() => {
                setOpen(false);
                onIgnore();
              }}
            />
          </div>,
          document.body
        )}
    </>
  );
}

function PickerRow({
  testId,
  label,
  custom = false,
  required = false,
  selected,
  takenByOther = false,
  muted = false,
  onClick,
}: {
  testId: string;
  label: string;
  custom?: boolean;
  required?: boolean;
  selected: boolean;
  takenByOther?: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-testid={testId}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-bg-subtle hover:text-accent ${
        selected ? 'text-accent' : muted ? 'text-fg-muted' : 'text-fg'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">
        {label}
        {required && (
          <span data-testid={`${testId}-required`} className="ml-1 font-semibold text-error">
            *
          </span>
        )}
      </span>
      {custom && (
        <span
          data-testid={`${testId}-custom`}
          title="A custom field you added to this type (not a built-in registry field)"
          className="flex-shrink-0 rounded border border-border bg-bg-subtle px-1 py-px text-[9px] uppercase tracking-wide text-fg-subtle"
        >
          custom
        </span>
      )}
      {}
      {selected ? (
        <CheckboxGlyph
          testId={`${testId}-check`}
          title="Mapped here"
          className="ml-auto flex-shrink-0 text-accent"
        />
      ) : takenByOther ? (
        <CheckboxGlyph
          testId={`${testId}-inuse`}
          title="Already mapped by another column"
          className="ml-auto flex-shrink-0 text-fg-subtle"
        />
      ) : null}
    </button>
  );
}

function CheckboxGlyph({
  testId,
  title,
  className = '',
}: {
  testId?: string;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      data-testid={testId}
      viewBox="0 0 14 14"
      width="13"
      height="13"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      {title ? <title>{title}</title> : null}
      <rect x="1.5" y="1.5" width="11" height="11" rx="3" />
      <path d="M4.2 7.2 6.2 9.2 9.9 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FieldMarker({ mapped, className = '' }: { mapped: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="11"
      height="11"
      className={`flex-shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {mapped ? (
        <path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="currentColor" stroke="none" />
      ) : (
        <circle cx="6" cy="6" r="4" strokeDasharray="2 1.6" />
      )}
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M3 4.5 6 7.5 9 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
