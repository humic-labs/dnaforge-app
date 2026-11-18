import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefCallback,
} from 'react';
import { createPortal } from 'react-dom';
import { focusTargetAllows, inputTargetAllows } from '@waypoint/platform/input-ownership';
import type { MenuDensity } from '../menu/appearance';
import { menuShouldRestoreFocus } from '../menu/menu-state';
import { MenuRow, MenuSeparator, MenuSurface, MenuTrigger } from '../menu/presentation';
import { useMenu } from '../menu/use-menu';
import type { CompactFilterSelectOption } from './CompactFilterSelect';

interface MenuPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const MENU_VIEWPORT_MARGIN = 8;
const CLEAR_ID = 'action:clear';

export interface CompactFilterMultiSelectProps<T extends string> {
  values: readonly T[];
  options: readonly CompactFilterSelectOption<T>[];
  onChange: (values: T[]) => void;
  ariaLabel: string;
  allLabel: string;
  className?: string;
  disabled?: boolean;
  density?: MenuDensity;
  menuAlign?: 'start' | 'end';
  testId?: string;
  rootRef?: RefCallback<HTMLDivElement>;
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
  rootRef,
}: CompactFilterMultiSelectProps<T>): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<MenuPlacement | null>(null);
  const menuId = useId();
  const items = useMemo(
    () => [
      { id: CLEAR_ID, textValue: 'Clear', disabled: values.length === 0, closeOnActivate: false },
      ...options.map((option) => ({
        id: `option:${option.value}`,
        textValue: option.label,
        disabled: option.disabled,
        closeOnActivate: false,
      })),
    ],
    [options, values.length]
  );
  const menu = useMenu({
    items,
    selectedId: values.length > 0 ? `option:${values[0]}` : null,
    onActivate: (id) => {
      if (id === CLEAR_ID) {
        onChange([]);
        return;
      }
      const option = options.find((candidate) => `option:${candidate.value}` === id);
      if (!option) return;
      onChange(
        values.includes(option.value)
          ? values.filter((value) => value !== option.value)
          : [...values, option.value]
      );
    },
    onClose: (reason) => {
      const trigger = triggerRef.current;
      if (menuShouldRestoreFocus(reason) && trigger?.isConnected && focusTargetAllows(trigger)) {
        trigger.focus({ preventScroll: true });
      }
    },
  });
  const {
    isOpen: open,
    state: { session },
    close,
    positioned,
  } = menu;
  const bindMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      rootRef?.(node);
      menu.bindSurface(node);
    },
    [rootRef, menu.bindSurface]
  );

  useEffect(() => {
    if (disabled && open) close('owner-revoked');
  }, [disabled, open, close]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPlacement(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const place = (): void => {
      if (!trigger.isConnected) {
        close('anchor-lost', session);
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.min(rect.width, viewportWidth - 2 * MENU_VIEWPORT_MARGIN);
      const alignedLeft = menuAlign === 'end' ? rect.right - width : rect.left;
      setMenuPlacement({
        top: rect.bottom + 4,
        left: Math.min(
          Math.max(MENU_VIEWPORT_MARGIN, alignedLeft),
          viewportWidth - width - MENU_VIEWPORT_MARGIN
        ),
        width,
        maxHeight: Math.max(80, window.innerHeight - rect.bottom - MENU_VIEWPORT_MARGIN - 4),
      });
      positioned(session);
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
  }, [menuAlign, open, session, close, positioned]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target))
        close('outside-pointer', session);
    };
    const onBlur = () => close('window-blur', session);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, session, close]);

  const selected = new Set(values);
  const summary =
    values.length === 0
      ? allLabel
      : values.length === 1
        ? (options.find((option) => option.value === values[0])?.label ?? values[0])
        : `${values.length} selected`;
  const optionId = (id: string) => `${menuId}-${encodeURIComponent(id)}`;

  return (
    <div ref={containerRef} className={`relative min-w-0 ${className}`}>
      <MenuTrigger
        ref={triggerRef}
        disabled={disabled}
        density={density}
        open={open}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && menu.activeId ? optionId(menu.activeId) : undefined}
        data-testid={testId}
        data-compact-filter-multiselect="true"
        onClick={() => (open ? close('trigger') : menu.openMenu())}
        onKeyDown={menu.handleKeyDown}
      >
        {summary}
      </MenuTrigger>
      {open && menuPlacement
        ? createPortal(
            <MenuSurface
              ref={bindMenu}
              id={menuId}
              role="menu"
              density={density}
              aria-label={ariaLabel}
              data-compact-filter-menu="true"
              data-menu-align={menuAlign}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onKeyDown={menu.handleKeyDown}
              layout={{
                position: 'fixed',
                zIndex: 10060,
                overflowY: 'auto',
                ...menuPlacement,
              }}
            >
              <MenuRow
                id={optionId(CLEAR_ID)}
                role="menuitem"
                active={menu.activeId === CLEAR_ID}
                disabled={values.length === 0}
                onMouseMove={() => menu.point(CLEAR_ID)}
                onClick={(event) => {
                  if (inputTargetAllows(event.currentTarget, 'pointer', event.nativeEvent))
                    menu.activate(CLEAR_ID);
                }}
              >
                Clear
              </MenuRow>
              <MenuSeparator />
              {options.map((option) => {
                const id = `option:${option.value}`;
                return (
                  <MenuRow
                    key={option.value}
                    id={optionId(id)}
                    role="menuitemcheckbox"
                    aria-checked={selected.has(option.value)}
                    active={menu.activeId === id}
                    selected={selected.has(option.value)}
                    disabled={option.disabled}
                    data-testid={testId ? `${testId}-option-${option.value}` : undefined}
                    onMouseMove={() => menu.point(id)}
                    onClick={(event) => {
                      if (inputTargetAllows(event.currentTarget, 'pointer', event.nativeEvent))
                        menu.activate(id);
                    }}
                  >
                    {option.label}
                  </MenuRow>
                );
              })}
            </MenuSurface>,
            triggerRef.current?.closest('dialog[open]') ?? document.body
          )
        : null}
    </div>
  );
}
