import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ChatComposerDisclosureIcon } from '../ChatComposerDisclosureIcon';
import { PortalMenu } from '../PortalMenu';
import { safeFocus } from '../../shared/utils/safeFocus';
import {
  UI_DANGER_BUTTON_CLASS,
  UI_APPBAR_ACTION_CLASS,
  UI_ENTITY_REFERENCE_CHIP_CLASS,
  UI_FIELD_CLASS,
  UI_ICON_BUTTON_CLASS,
  UI_LINK_BUTTON_CLASS,
  UI_MENU_OPTION_CLASS,
  UI_PRIMARY_BUTTON_CLASS,
  UI_PROSE_WRAP_CLASS,
  UI_READONLY_FIELD_CLASS,
  UI_SECONDARY_BUTTON_CLASS,
  UI_SEGMENTED_SURFACE_CLASS,
  segmentedOptionClass,
  UI_SELECT_CARET_CLASS,
  UI_SELECT_TRIGGER_CLASS,
  UI_SURFACE_CLASS,
  UI_TEXTAREA_CLASS,
} from './styles';

function withoutAppearance<Props>(props: Props) {
  const {
    className: _className,
    style: _style,
    ...nativeProps
  } = props as Props & {
    className?: string;
    style?: CSSProperties;
  };
  return nativeProps;
}

export const ReferenceChipSurface = forwardRef<
  HTMLSpanElement,
  Omit<ComponentPropsWithoutRef<'span'>, 'className' | 'style'> & {
    unavailable?: boolean;
    attachmentPhase?: 'draft' | 'sent';
  }
>(function ReferenceChipSurface({ unavailable = false, attachmentPhase, ...props }, ref) {
  return (
    <span
      {...withoutAppearance(props)}
      ref={ref}
      data-ui-control="reference-chip"
      className={`${UI_ENTITY_REFERENCE_CHIP_CLASS} entity-reference-chip${unavailable ? ' entity-reference-chip--unavailable' : ''}${
        attachmentPhase ? ` entity-reference-chip--${attachmentPhase}` : ''
      }`}
    />
  );
});

export function ColumnResizeHandle({
  onMouseDown,
  testId,
}: {
  onMouseDown: ComponentPropsWithoutRef<'div'>['onMouseDown'];
  testId?: string;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      data-testid={testId}
      className="w-1 hover:w-1 bg-transparent hover:bg-accent/50 cursor-col-resize flex-shrink-0 transition-colors"
      style={{ marginLeft: -2 }}
    />
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<'input'>, 'className' | 'style'> & { monospace?: boolean }
>(function TextField({ monospace = false, ...props }, ref) {
  return (
    <input
      {...withoutAppearance(props)}
      ref={ref}
      data-ui-control="input"
      data-settings-control="input"
      className={`${props.readOnly ? UI_READONLY_FIELD_CLASS : UI_FIELD_CLASS}${monospace ? ' font-mono' : ''}`}
    />
  );
});

export function TextArea({
  monospace = false,
  ...props
}: Omit<ComponentPropsWithoutRef<'textarea'>, 'className' | 'style'> & { monospace?: boolean }) {
  return (
    <textarea
      {...withoutAppearance(props)}
      data-ui-control="textarea"
      data-settings-control="textarea"
      className={`${UI_TEXTAREA_CLASS}${monospace ? ' font-mono' : ''}`}
    />
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'style'> & {
    variant?: 'primary' | 'secondary' | 'danger' | 'icon' | 'link' | 'appbar';
  }
>(function Button({ variant = 'secondary', type = 'button', ...props }, ref) {
  const styles = {
    primary: UI_PRIMARY_BUTTON_CLASS,
    secondary: UI_SECONDARY_BUTTON_CLASS,
    danger: UI_DANGER_BUTTON_CLASS,
    icon: UI_ICON_BUTTON_CLASS,
    link: UI_LINK_BUTTON_CLASS,
    appbar: UI_APPBAR_ACTION_CLASS,
  };
  return (
    <button
      {...withoutAppearance(props)}
      ref={ref}
      type={type}
      data-ui-control="button"
      data-settings-control="button"
      className={styles[variant]}
    />
  );
});

export function Notice({
  tone = 'neutral',
  children,
  actions,
  testId,
}: {
  tone?: 'neutral' | 'error' | 'success' | 'warning';
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  const styles = {
    neutral: `${UI_SURFACE_CLASS} text-fg-muted`,
    error: 'bg-error/5 text-error',
    success: 'bg-success/5 text-fg',
    warning: 'bg-warning/5 text-fg',
  };
  const appearance = `rounded-md px-3 py-2 text-sm leading-5 ${styles[tone]}`;
  const role = tone === 'error' ? 'alert' : 'status';

  if (actions) {
    return (
      <div data-testid={testId} className={`flex flex-wrap items-start gap-2 ${appearance}`}>
        <p role={role} className={`grow basis-64 ${UI_PROSE_WRAP_CLASS}`}>
          {children}
        </p>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">{actions}</div>
      </div>
    );
  }

  return (
    <p role={role} data-testid={testId} className={`${appearance} ${UI_PROSE_WRAP_CLASS}`}>
      {children}
    </p>
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  selectedLabel?: ReactNode;
  description?: string;
  title?: string;
  disabled?: boolean;
  testId?: string;
  searchText?: string;
}

export function Select({
  value,
  options,
  onValueChange,
  ariaLabel,
  id,
  disabled = false,
  required = false,
  testId,
  title,
  containerClassName = '',
  defaultOpen = false,
  searchable = false,
  searchLabel = 'Search options',
  loading = false,
  emptyMessage = 'No matches',
  menuAttributes,
  onSelect,
  privateContent = false,
}: {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  testId?: string;
  title?: string;
  containerClassName?: string;
  defaultOpen?: boolean;
  searchable?: boolean;
  searchLabel?: string;
  loading?: boolean;
  emptyMessage?: string;
  menuAttributes?: Record<`data-${string}`, string | undefined>;
  onSelect?: (value: string) => void;
  privateContent?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen && !disabled);
  const [search, setSearch] = useState('');
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return options.flatMap((option, index) => {
      const text = `${option.searchText ?? (typeof option.label === 'string' ? option.label : option.value)} ${option.description ?? ''}`;
      return !searchable || !query || text.toLowerCase().includes(query) ? [{ option, index }] : [];
    });
  }, [options, search, searchable]);
  const enabledIndexes = useMemo(
    () => filteredOptions.flatMap(({ option, index }) => (option.disabled ? [] : [index])),
    [filteredOptions]
  );
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open && !enabledIndexes.includes(activeIndex))
      setActiveIndex(enabledIndexes[0] ?? selectedIndex);
  }, [activeIndex, enabledIndexes, open, selectedIndex]);

  const close = useCallback(() => setOpen(false), []);
  const openFromTrigger = useCallback(() => {
    if (disabled || options.length === 0) return;
    setActiveIndex(selectedIndex);
    setSearch('');
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (enabledIndexes.length === 0) return;
      setActiveIndex((current) => {
        const currentPosition = enabledIndexes.indexOf(current);
        const start =
          currentPosition >= 0 ? currentPosition : enabledIndexes.indexOf(selectedIndex);
        const next = Math.max(0, Math.min(enabledIndexes.length - 1, start + direction));
        return enabledIndexes[next] ?? selectedIndex;
      });
    },
    [enabledIndexes, selectedIndex]
  );

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      setOpen(false);
      if (option.value !== value) onValueChange(option.value);
      onSelect?.(option.value);
    },
    [onSelect, onValueChange, options, value]
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Tab' && open) {
      close();
      safeFocus(triggerRef.current);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openFromTrigger();
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (!open || enabledIndexes.length === 0) return;
      event.preventDefault();
      setActiveIndex(
        event.key === 'Home'
          ? (enabledIndexes[0] ?? selectedIndex)
          : (enabledIndexes[enabledIndexes.length - 1] ?? selectedIndex)
      );
      return;
    }
    if (event.key === 'Enter' || (event.key === ' ' && event.currentTarget.tagName !== 'INPUT')) {
      event.preventDefault();
      if (open) commit(activeIndex);
      else openFromTrigger();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div className={`relative min-w-0 ${containerClassName}`.trim()}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-required={required || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        title={title}
        disabled={disabled || options.length === 0}
        data-testid={testId}
        data-settings-control="select"
        data-ui-control="select"
        data-value={value}
        onClick={() => (open ? close() : openFromTrigger())}
        onKeyDown={handleKeyDown}
        className={`${UI_SELECT_TRIGGER_CLASS}${open ? ' border-accent' : ''}`}
      >
        <span className="min-w-0 truncate">
          {selected?.selectedLabel ?? selected?.label ?? value}
        </span>
        <span className={UI_SELECT_CARET_CLASS} data-settings-caret="true">
          <ChatComposerDisclosureIcon open={open} />
        </span>
      </button>
      <PortalMenu
        id={searchable ? undefined : listboxId}
        open={open}
        anchorRef={triggerRef}
        initialFocusRef={searchable ? searchRef : undefined}
        onRequestClose={close}
        role={searchable ? 'dialog' : 'listbox'}
        aria-label={ariaLabel}
        horizontalAlign="start"
        preferredSide="bottom"
        surfaceVariant="settings"
        data-testid={testId ? `${testId}-menu` : undefined}
        dataAttributes={menuAttributes}
        className="space-y-0.5 p-1"
        privateContent={privateContent}
      >
        {searchable ? (
          <div className="sticky top-0 z-10 bg-bg p-1">
            <TextField
              ref={searchRef}
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              aria-controls={listboxId}
              aria-activedescendant={`${listboxId}-option-${activeIndex}`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        ) : null}
        {loading ? (
          <span role="status" className="block px-3 py-2 text-sm text-fg-muted">
            Loading…
          </span>
        ) : null}
        <div
          id={searchable ? listboxId : undefined}
          role={searchable ? 'listbox' : 'presentation'}
          aria-label={searchable ? ariaLabel : undefined}
        >
          {filteredOptions.map(({ option, index }) => {
            const selectedOption = option.value === value;
            const active = index === activeIndex;
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selectedOption}
                disabled={option.disabled}
                title={option.title}
                data-testid={option.testId}
                data-value={option.value}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={`${UI_MENU_OPTION_CLASS} ${
                  active
                    ? 'bg-black/[0.07] text-fg dark:bg-white/[0.09]'
                    : 'text-fg-muted hover:bg-black/[0.05] hover:text-fg dark:hover:bg-white/[0.07]'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block text-xs leading-4 text-fg-subtle">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {selectedOption ? (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
          {!loading && filteredOptions.length === 0 ? (
            <span role="status" className="block px-3 py-2 text-sm text-fg-muted">
              {emptyMessage}
            </span>
          ) : null}
        </div>
      </PortalMenu>
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-border-hover'
      }`}
    >
      <span
        className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function SegmentedControl({
  value,
  options,
  onChange,
  testIdPrefix,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  testIdPrefix?: string;
}) {
  return (
    <div className={UI_SEGMENTED_SURFACE_CLASS}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          data-testid={testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined}
          className={segmentedOptionClass(value === option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
