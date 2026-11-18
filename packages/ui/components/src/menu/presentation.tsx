import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { INTERACTION_CLASS, menuDensityStyle, type MenuDensity, type MenuTone } from './appearance';

function controlProps<T extends object>(props: T): Omit<T, 'className' | 'style'> {
  const clean = { ...props };
  delete (clean as Record<string, unknown>).className;
  delete (clean as Record<string, unknown>).style;
  return clean;
}

export interface MenuSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  density?: MenuDensity;
  content?: 'menu' | 'panel';
  selection?: boolean;
  icons?: boolean;
  shortcuts?: boolean;
  submenus?: boolean;
}

export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface(
  {
    density = 'compact',
    content = 'menu',
    selection = true,
    icons = false,
    shortcuts = false,
    submenus = false,
    className = '',
    style,
    ...props
  },
  ref
) {
  return (
    <div
      {...props}
      ref={ref}
      className={`wp-menu ${className}`.trim()}
      style={{ ...style, ...menuDensityStyle(density) }}
      data-menu-density={density}
      data-menu-content={content}
      data-menu-selection={selection}
      data-menu-icons={icons}
      data-menu-shortcuts={shortcuts}
      data-menu-submenus={submenus}
    />
  );
});

export interface MenuCaretProps {
  direction?: 'down' | 'right' | 'up';
}

export function MenuCaret({ direction = 'down' }: MenuCaretProps) {
  return (
    <svg
      className="wp-menu-caret"
      data-direction={direction}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3 4.5 3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface MenuTriggerProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'style'
> {
  density?: MenuDensity;
  variant?: 'field' | 'toolbar';
  open?: boolean;
  icon?: ReactNode;
  iconOnly?: boolean;
}

export const MenuTrigger = forwardRef<HTMLButtonElement, MenuTriggerProps>(function MenuTrigger(
  {
    density = 'compact',
    variant = 'field',
    open = false,
    icon,
    iconOnly = false,
    children,
    ...props
  },
  ref
) {
  return (
    <button
      type="button"
      aria-expanded={open}
      {...controlProps(props)}
      ref={ref}
      className="wp-menu-trigger"
      style={menuDensityStyle(density)}
      data-menu-density={density}
      data-variant={variant}
      data-open={open}
      data-icon-only={iconOnly}
    >
      {icon ? (
        <span className="wp-menu-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="wp-menu-trigger-label">{children}</span>
      <span className="wp-menu-trigger-caret">
        <MenuCaret direction={open ? 'up' : 'down'} />
      </span>
    </button>
  );
});

export interface MenuNativeSelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'style' | 'size'
> {
  density?: MenuDensity;
}

export interface MenuSearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'style' | 'size'
> {
  density?: MenuDensity;
}

export const MenuSearchInput = forwardRef<HTMLInputElement, MenuSearchInputProps>(
  function MenuSearchInput({ density = 'compact', type = 'search', ...props }, ref) {
    return (
      <input
        {...controlProps(props)}
        ref={ref}
        type={type}
        className="wp-menu-trigger wp-menu-search-input"
        style={menuDensityStyle(density)}
        data-menu-density={density}
      />
    );
  }
);

export const MenuNativeSelect = forwardRef<HTMLSelectElement, MenuNativeSelectProps>(
  function MenuNativeSelect({ density = 'compact', disabled = false, ...props }, ref) {
    return (
      <span
        className="wp-menu-native-select"
        style={menuDensityStyle(density)}
        data-disabled={disabled}
      >
        <select
          {...controlProps(props)}
          ref={ref}
          disabled={disabled}
          className="wp-menu-trigger wp-menu-native-select-control"
          data-menu-density={density}
          data-variant="field"
        />
        <span className="wp-menu-native-select-caret">
          <MenuCaret />
        </span>
      </span>
    );
  }
);

interface MenuRowContentProps {
  icon?: ReactNode;
  description?: ReactNode;
  shortcut?: ReactNode;
  submenu?: boolean;
  children?: ReactNode;
}

interface MenuRowStateProps extends MenuRowContentProps {
  active?: boolean;
  selected?: boolean;
  tone?: MenuTone;
}

export interface MenuRowProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'>, MenuRowStateProps {}

function MenuRowContent({ icon, description, shortcut, submenu, children }: MenuRowContentProps) {
  return (
    <>
      <span className="wp-menu-row-icon wp-menu-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="wp-menu-row-content">
        <span className="wp-menu-row-label">{children}</span>
        {description ? <span className="wp-menu-row-description">{description}</span> : null}
      </span>
      <span className="wp-menu-row-shortcut" aria-hidden="true">
        {shortcut}
      </span>
      <span className="wp-menu-row-selection" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="m2.5 6 2.25 2.25 4.75-4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="wp-menu-row-submenu" aria-hidden="true">
        {submenu ? <MenuCaret direction="right" /> : null}
      </span>
    </>
  );
}

export const MenuRow = forwardRef<HTMLButtonElement, MenuRowProps>(function MenuRow(
  {
    active = false,
    selected = false,
    tone = 'default',
    icon,
    description,
    shortcut,
    submenu = false,
    children,
    ...props
  },
  ref
) {
  return (
    <button
      type="button"
      {...controlProps(props)}
      ref={ref}
      className="wp-menu-row"
      data-active={active}
      data-selected={selected}
      data-tone={tone}
    >
      <MenuRowContent icon={icon} description={description} shortcut={shortcut} submenu={submenu}>
        {children}
      </MenuRowContent>
    </button>
  );
});

export interface MenuLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'style'>, MenuRowStateProps {
  disabled?: boolean;
}

export const MenuLink = forwardRef<HTMLAnchorElement, MenuLinkProps>(function MenuLink(
  {
    active = false,
    selected = false,
    tone = 'default',
    disabled = false,
    icon,
    description,
    shortcut,
    submenu = false,
    children,
    href,
    tabIndex,
    onClick,
    ...props
  },
  ref
) {
  return (
    <a
      {...controlProps(props)}
      ref={ref}
      href={disabled ? undefined : href}
      tabIndex={disabled ? -1 : tabIndex}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault();
        else onClick?.(event);
      }}
      className="wp-menu-row"
      data-active={active}
      data-selected={selected}
      data-tone={tone}
    >
      <MenuRowContent icon={icon} description={description} shortcut={shortcut} submenu={submenu}>
        {children}
      </MenuRowContent>
    </a>
  );
});

export function MenuSeparator(props: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>) {
  return <div {...controlProps(props)} role="separator" className="wp-menu-separator" />;
}

export function MenuStatus(props: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>) {
  return <div role="status" {...controlProps(props)} className="wp-menu-status" />;
}

export interface MenuRowGroupProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'className' | 'style'
> {
  active?: boolean;
}

export function MenuRowGroup({ active = false, ...props }: MenuRowGroupProps) {
  return <div {...controlProps(props)} className="wp-menu-row-group" data-active={active} />;
}

export type MenuRowActionProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'style'
>;

export const MenuRowAction = forwardRef<HTMLButtonElement, MenuRowActionProps>(
  function MenuRowAction(props, ref) {
    return (
      <button
        type="button"
        {...controlProps(props)}
        ref={ref}
        className={`wp-menu-row-action ${INTERACTION_CLASS}`}
      />
    );
  }
);

export function MenuSectionLabel(
  props: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>
) {
  return <div {...controlProps(props)} className="wp-menu-section-label" />;
}
