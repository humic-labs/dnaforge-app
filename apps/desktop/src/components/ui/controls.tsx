import {
  MenuRow,
  MenuTrigger,
  MenuSearchInput,
  MenuStatus,
  useMenu,
} from '@waypoint/ui-components';
import {
  forwardRef,
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
import { PortalMenu } from '../PortalMenu';
import {
  UI_DANGER_BUTTON_CLASS,
  UI_APPBAR_ACTION_CLASS,
  UI_ICON_BUTTON_CLASS,
  UI_LINK_BUTTON_CLASS,
  UI_PRIMARY_BUTTON_CLASS,
  UI_PROSE_WRAP_CLASS,
  UI_READONLY_FIELD_CLASS,
  UI_SECONDARY_BUTTON_CLASS,
  UI_SEGMENTED_SURFACE_CLASS,
  segmentedOptionClass,
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
      className={`${props.readOnly ? UI_READONLY_FIELD_CLASS : 'wp-form-density wp-menu-trigger wp-menu-search-input'}${monospace ? ' !font-mono' : ''}`}
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

export function VerticalRangeField(
  props: Omit<
    ComponentPropsWithoutRef<'input'>,
    'type' | 'style' | 'className' | 'aria-orientation'
  >
) {
  return (
    <input
      {...withoutAppearance(props)}
      type="range"
      data-ui-control="range"
      aria-orientation="vertical"
      className="h-16 w-4 cursor-pointer [direction:rtl] [writing-mode:vertical-lr]"
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
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return options.filter((option) => {
      const text = `${option.searchText ?? (typeof option.label === 'string' ? option.label : option.value)} ${option.description ?? ''}`;
      return !searchable || !query || text.toLowerCase().includes(query);
    });
  }, [options, search, searchable]);
  const items = useMemo(
    () =>
      filteredOptions.map((option) => ({
        id: option.value,
        textValue:
          option.searchText ?? (typeof option.label === 'string' ? option.label : option.value),
        disabled: option.disabled,
      })),
    [filteredOptions]
  );
  const menu = useMenu({
    items,
    selectedId: value,
    defaultOpen: defaultOpen && !disabled,
    onClose: () => setSearch(''),
    onActivate: (itemId) => {
      if (itemId !== value) onValueChange(itemId);
      onSelect?.(itemId);
    },
  });
  const open = menu.isOpen;
  const selected = options.find((option) => option.value === value) ?? options[0];
  const activeDescendant =
    open && menu.activeId !== null
      ? `${listboxId}-option-${encodeURIComponent(menu.activeId)}`
      : undefined;

  useEffect(() => {
    if (disabled) menu.close('anchor-lost');
  }, [disabled, menu.close]);

  const openFromTrigger = () => {
    if (disabled || options.length === 0) return;
    setSearch('');
    menu.openMenu(value);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      !open &&
      (event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' ')
    ) {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      openFromTrigger();
      return;
    }
    menu.handleKeyDown(event);
  };

  return (
    <div className={`relative min-w-0 ${containerClassName}`.trim()}>
      <MenuTrigger
        ref={triggerRef}
        density="form"
        open={open}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-required={required || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        title={title}
        disabled={disabled || options.length === 0}
        data-testid={testId}
        data-settings-control="select"
        data-ui-control="select"
        data-value={value}
        onClick={() => (open ? menu.close('trigger') : openFromTrigger())}
        onKeyDown={handleKeyDown}
      >
        <span className="min-w-0 truncate">
          {selected?.selectedLabel ?? selected?.label ?? value}
        </span>
      </MenuTrigger>
      <PortalMenu
        id={searchable ? undefined : listboxId}
        open={open}
        menu={menu}
        initialFocusRef={searchable ? searchRef : undefined}
        anchorRef={triggerRef}
        onRequestClose={menu.close}
        role={searchable ? 'dialog' : 'listbox'}
        aria-label={ariaLabel}
        horizontalAlign="start"
        preferredSide="bottom"
        surfaceVariant="settings"
        data-testid={testId ? `${testId}-menu` : undefined}
        dataAttributes={menuAttributes}
        privateContent={privateContent}
      >
        {searchable ? (
          <div className="sticky top-0 z-10 bg-bg p-1">
            <MenuSearchInput
              density="form"
              ref={searchRef}
              type="search"
              aria-label={searchLabel}
              placeholder={searchLabel}
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
        ) : null}
        {loading ? <MenuStatus>Loading…</MenuStatus> : null}
        <div
          id={searchable ? listboxId : undefined}
          role={searchable ? 'listbox' : 'presentation'}
          aria-label={searchable ? ariaLabel : undefined}
        >
          {filteredOptions.map((option) => {
            const selectedOption = option.value === value;
            const active = option.value === menu.activeId;
            return (
              <MenuRow
                key={option.value}
                active={active}
                selected={selectedOption}
                description={option.description}
                id={`${listboxId}-option-${encodeURIComponent(option.value)}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selectedOption}
                disabled={option.disabled}
                title={option.title}
                data-testid={option.testId}
                data-value={option.value}
                onMouseMove={() => menu.point(option.value, 'root')}
                onClick={() => menu.activate(option.value, 'root')}
              >
                {option.label}
              </MenuRow>
            );
          })}
          {!loading && filteredOptions.length === 0 ? (
            <MenuStatus>{emptyMessage}</MenuStatus>
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
