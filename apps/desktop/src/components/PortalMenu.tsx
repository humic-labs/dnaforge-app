import {
  MenuSurface,
  menuShouldRestoreFocus,
  useMenu,
  type MenuCloseReason,
  type MenuController,
  type MenuLayout,
  type MenuSurfaceProps,
} from '@waypoint/ui-components';
import { scheduleFocus } from '../shared/utils/safeFocus';
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { UI_POPOVER_LAYER, UI_SUBMENU_LAYER } from './ui/styles';
import {
  PresentationScopeContext,
  usePresentationOverlay,
  usePresentationScope,
} from '../presentation/PresentationSurface';

interface MenuPlacement {
  right?: number;
  left?: number;
  top?: number;
  bottom?: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
}

const MENU_MARGIN = 8;

function tabDestination(
  anchor: HTMLElement | null,
  scope: ParentNode | null | undefined,
  backwards: boolean,
  exclude?: (target: Node) => boolean
): HTMLElement | null {
  if (!anchor || !scope) return null;
  const candidates = Array.from(
    scope.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"],audio[controls],video[controls],summary'
    )
  )
    .filter((element) => {
      if (element.tabIndex < 0 || element.matches(':disabled') || exclude?.(element)) return false;
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        if (current.hidden || current.inert || current.hasAttribute('inert')) return false;
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    })
    .map((element, index) => ({ element, index }))
    .sort(
      (a, b) =>
        (a.element.tabIndex || Infinity) - (b.element.tabIndex || Infinity) || a.index - b.index
    )
    .map(({ element }) => element);
  const index = candidates.indexOf(anchor);
  return index < 0 ? null : (candidates[index + (backwards ? -1 : 1)] ?? null);
}

function computePlacement(
  rect: DOMRect,
  horizontalAlign: 'start' | 'end',
  placement: 'dropdown' | 'submenu',
  preferredSide: 'top' | 'bottom',
  allowFlip: boolean
): MenuPlacement {
  const GAP = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (placement === 'submenu') {
    const spaceRight = vw - rect.right - GAP - MENU_MARGIN;
    const spaceLeft = rect.left - GAP - MENU_MARGIN;
    const opensRight = spaceRight >= 256 || spaceRight >= spaceLeft;
    return {
      ...(opensRight
        ? { left: Math.max(MENU_MARGIN, rect.right + GAP) }
        : { right: Math.max(MENU_MARGIN, vw - rect.left + GAP) }),
      top: Math.max(MENU_MARGIN, Math.min(rect.top, vh - MENU_MARGIN)),
      minWidth: 0,
      maxWidth: Math.max(0, Math.min(vw - 2 * MENU_MARGIN, opensRight ? spaceRight : spaceLeft)),
      maxHeight: Math.max(0, vh - 2 * MENU_MARGIN),
    };
  }
  const spaceAbove = rect.top - GAP - MENU_MARGIN;
  const spaceBelow = vh - rect.bottom - GAP - MENU_MARGIN;
  const openAbove = allowFlip
    ? preferredSide === 'top'
      ? spaceAbove >= 200 || spaceAbove >= spaceBelow
      : spaceBelow < 200 && spaceAbove > spaceBelow
    : preferredSide === 'top';
  const vertical = openAbove
    ? {
        bottom: Math.max(MENU_MARGIN, vh - rect.top + GAP),
        maxHeight: Math.max(0, Math.min(vh * 0.7, spaceAbove)),
      }
    : {
        top: Math.max(MENU_MARGIN, rect.bottom + GAP),
        maxHeight: Math.max(0, Math.min(vh * 0.7, spaceBelow)),
      };
  return {
    ...(horizontalAlign === 'start'
      ? { left: Math.max(MENU_MARGIN, rect.left) }
      : { right: Math.max(MENU_MARGIN, vw - rect.right) }),
    minWidth: rect.width,
    maxWidth: vw - 2 * MENU_MARGIN,
    ...vertical,
  };
}

export interface PortalMenuProps extends Pick<
  MenuSurfaceProps,
  'density' | 'selection' | 'icons' | 'shortcuts' | 'submenus' | 'content'
> {
  id?: string;
  open: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorPoint?: { x: number; y: number };
  onRequestClose: (reason: MenuCloseReason) => void;
  menu?: MenuController;
  menuId?: string;
  role?: 'listbox' | 'menu' | 'dialog';
  horizontalAlign?: 'start' | 'end';
  preferredSide?: 'top' | 'bottom';
  allowFlip?: boolean;
  placement?: 'dropdown' | 'submenu';
  surfaceRef?: RefObject<HTMLDivElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  insideRefs?: readonly RefObject<HTMLElement | null>[];
  closeOnEscape?: boolean;
  layout?: Pick<
    MenuLayout,
    | 'width'
    | 'minWidth'
    | 'maxWidth'
    | 'height'
    | 'maxHeight'
    | 'overflow'
    | 'overflowY'
    | 'display'
    | 'flexDirection'
  >;
  surfaceVariant?: 'default' | 'settings';
  privateContent?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
  dataAttributes?: Record<`data-${string}`, string | undefined>;
  children: ReactNode;
}

const EMPTY_MENU_ITEMS: readonly never[] = [];

function constrainedMenuSize(requested: number | string | undefined, maximum: number) {
  return requested === undefined
    ? maximum
    : `min(${typeof requested === 'number' ? `${requested}px` : requested}, ${maximum}px)`;
}

export function PortalMenu(props: PortalMenuProps) {
  return props.menu ? (
    <PortalMenuSurface {...props} menu={props.menu} />
  ) : (
    <OwnedPortalMenu {...props} />
  );
}

function OwnedPortalMenu(props: PortalMenuProps) {
  const menu = useMenu({ items: EMPTY_MENU_ITEMS, defaultOpen: props.open });
  const current = useRef(menu);
  current.current = menu;
  useLayoutEffect(() => {
    if (props.open && !current.current.isOpen) current.current.openMenu();
    else if (!props.open && current.current.isOpen) current.current.close('handoff');
  }, [props.open]);
  return <PortalMenuSurface {...props} menu={menu} keyboardNavigation={false} />;
}

type BoundPortalMenuProps = PortalMenuProps & {
  menu: MenuController;
  keyboardNavigation?: boolean;
};
type MenuPresentation = ReturnType<typeof usePresentationOverlay>;
const MenuPresentationContext = createContext<{
  stateRef: MenuController['stateRef'];
  presentation: MenuPresentation;
} | null>(null);

function PortalMenuSurface(props: BoundPortalMenuProps) {
  const inherited = useContext(MenuPresentationContext);
  return props.menuId && props.menuId !== 'root' && inherited?.stateRef === props.menu.stateRef ? (
    <BoundPortalMenu {...props} presentation={inherited.presentation} />
  ) : (
    <OwnedMenuPresentation {...props} />
  );
}

function OwnedMenuPresentation(props: BoundPortalMenuProps) {
  const presentation = usePresentationOverlay(props.role === 'dialog' ? 'modal' : 'keyboard');
  return (
    <MenuPresentationContext.Provider value={{ stateRef: props.menu.stateRef, presentation }}>
      <BoundPortalMenu {...props} presentation={presentation} />
    </MenuPresentationContext.Provider>
  );
}

function BoundPortalMenu({
  id,
  open: requestedOpen,
  menu,
  menuId = 'root',
  presentation,
  keyboardNavigation = true,
  anchorRef,
  anchorPoint,
  onRequestClose,
  role = 'listbox',
  horizontalAlign = 'end',
  preferredSide = 'top',
  allowFlip = true,
  placement: placementMode = 'dropdown',
  surfaceRef,
  initialFocusRef,
  insideRefs = [],
  closeOnEscape = true,
  layout,
  surfaceVariant = 'default',
  density,
  selection,
  icons,
  shortcuts,
  submenus,
  content,
  privateContent = false,
  'aria-label': ariaLabel,
  'data-testid': testId,
  dataAttributes,
  children,
}: BoundPortalMenuProps & { presentation: MenuPresentation }) {
  const open =
    requestedOpen &&
    menu.isOpen &&
    (menuId === 'root' || menu.state.levels.some((level) => level.menuId === menuId));
  const parent = usePresentationScope();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const returnAnchorRef = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const requestedOpenRef = useRef(requestedOpen);
  requestedOpenRef.current = requestedOpen;
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  const tabTargetRef = useRef<HTMLElement | null>(null);
  const controllerRef = useRef(menu);
  controllerRef.current = menu;
  const requestClose = useCallback(
    (reason: MenuCloseReason, session: number) => {
      if (menuId === 'root') controllerRef.current.close(reason, session);
      else {
        const state = controllerRef.current.stateRef.current;
        if (
          state.phase === 'closed' ||
          state.session !== session ||
          !state.levels.some((level) => level.menuId === menuId)
        )
          return;
        controllerRef.current.send({ type: 'submenu-close', menuId, session });
        closeRef.current(reason);
      }
    },
    [menuId]
  );
  useLayoutEffect(
    () =>
      menu.subscribeClose((reason) => {
        if (menuId !== 'root') return;
        const tabTarget = reason === 'tab' ? tabTargetRef.current : null;
        if (tabTarget) presentation.setReturnFocus(tabTarget);
        presentation.setReturnFocusPolicy(
          tabTarget ? 'advance' : menuShouldRestoreFocus(reason) ? 'restore' : 'preserve'
        );
        tabTargetRef.current = null;
        if (requestedOpenRef.current) closeRef.current(reason);
      }),
    [menuId, menu.subscribeClose, presentation.setReturnFocus, presentation.setReturnFocusPolicy]
  );
  const insideRefsRef = useRef(insideRefs);
  insideRefsRef.current = insideRefs;
  const assignMenuRef = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      if (node && menuId === 'root') {
        presentation.setReturnFocusPolicy('restore');
        returnAnchorRef.current =
          anchorRef?.current ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        presentation.setReturnFocus(returnAnchorRef.current);
      } else if (
        !node &&
        menuId === 'root' &&
        controllerRef.current.stateRef.current.phase !== 'closed'
      ) {
        presentation.setReturnFocusPolicy('preserve');
      }
      if (surfaceRef) {
        (surfaceRef as { current: HTMLDivElement | null }).current = node;
      }
      menu.bindSurface(node, menuId);
    },
    [
      surfaceRef,
      presentation.setReturnFocus,
      presentation.setReturnFocusPolicy,
      anchorRef,
      menu.bindSurface,
      menuId,
    ]
  );

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const session = menu.state.session;
    let placed = false;
    const place = () => {
      if (anchorPoint) {
        setPlacement({
          left: Math.max(MENU_MARGIN, Math.min(anchorPoint.x, window.innerWidth - MENU_MARGIN)),
          top: Math.max(MENU_MARGIN, Math.min(anchorPoint.y, window.innerHeight - MENU_MARGIN)),
          minWidth: 0,
          maxWidth: window.innerWidth - 2 * MENU_MARGIN,
          maxHeight: window.innerHeight - 2 * MENU_MARGIN,
        });
        controllerRef.current.positioned(session);
        return;
      }
      const rect = anchorRef?.current?.getBoundingClientRect();
      if (!rect) {
        requestClose('anchor-lost', session);
        return;
      }
      if (placed && rect.width === 0 && rect.height === 0) {
        requestClose('anchor-lost', session);
        return;
      }
      setPlacement(
        computePlacement(rect, horizontalAlign, placementMode, preferredSide, allowFlip)
      );
      placed = true;
      controllerRef.current.positioned(session);
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [
    open,
    menu.state.session,
    anchorRef,
    anchorPoint?.x,
    anchorPoint?.y,
    horizontalAlign,
    placementMode,
    preferredSide,
    allowFlip,
    requestClose,
  ]);

  useLayoutEffect(() => {
    if (!placement) return;
    const menu = menuRef.current;
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    const left =
      r.left < MENU_MARGIN
        ? MENU_MARGIN
        : r.right > window.innerWidth - MENU_MARGIN
          ? Math.max(MENU_MARGIN, window.innerWidth - MENU_MARGIN - r.width)
          : null;
    const firstRow =
      placementMode === 'submenu'
        ? menu.querySelector<HTMLElement>(
            '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"]'
          )
        : null;
    const anchor = placementMode === 'submenu' ? anchorRef?.current : null;
    const top = anchor
      ? Math.max(
          MENU_MARGIN,
          Math.min(
            anchor.getBoundingClientRect().top -
              (firstRow ? firstRow.getBoundingClientRect().top - r.top : 0),
            window.innerHeight - MENU_MARGIN - r.height
          )
        )
      : placementMode !== 'submenu' && !anchorPoint
        ? null
        : r.top < MENU_MARGIN
          ? MENU_MARGIN
          : r.bottom > window.innerHeight - MENU_MARGIN
            ? Math.max(MENU_MARGIN, window.innerHeight - MENU_MARGIN - r.height)
            : null;
    if ((left !== null && placement.left !== left) || (top !== null && placement.top !== top)) {
      setPlacement((current) =>
        current
          ? {
              ...current,
              ...(left !== null ? { left, right: undefined } : {}),
              ...(top !== null ? { top, bottom: undefined } : {}),
            }
          : current
      );
    }
  }, [placement, placementMode, anchorPoint, anchorRef]);

  const mayMount =
    menuRef.current !== null || menuId !== 'root' || parent.owner.allows(parent.id, 'keyboard');
  const mounted = open && placement !== null && mayMount;
  useLayoutEffect(() => {
    if (open && !mayMount) requestClose('owner-revoked', menu.state.session);
  }, [open, mayMount, requestClose, menu.state.session]);
  useLayoutEffect(() => {
    if (mounted) return scheduleFocus(initialFocusRef?.current);
  }, [mounted, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const session = menu.state.session;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        anchorRef?.current?.contains(target) ||
        controllerRef.current.containsTarget(target) ||
        insideRefsRef.current.some((ref) => ref.current?.contains(target))
      ) {
        return;
      }
      requestClose('outside-pointer', session);
    };
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        closeOnEscape &&
        !e.defaultPrevented &&
        presentation.owner.allowsEvent(presentation.id, 'keyboard', e)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        requestClose('escape', session);
      }
    };
    let dialogTabPending = false;
    const onFocusIn = (event: FocusEvent) => {
      if (!dialogTabPending) return;
      dialogTabPending = false;
      if (
        !controllerRef.current.containsTarget(event.target as Node) &&
        !insideRefsRef.current.some((ref) => ref.current?.contains(event.target as Node))
      )
        requestClose('tab', session);
    };
    const onTab = (e: KeyboardEvent) => {
      if (
        e.key !== 'Tab' ||
        e.defaultPrevented ||
        !presentation.owner.allowsEvent(presentation.id, 'keyboard', e)
      )
        return;
      if (menuId !== 'root') return;
      const active = document.activeElement;
      if (
        role === 'dialog' &&
        (!(active instanceof HTMLElement) ||
          !menuRef.current?.contains(active) ||
          tabDestination(active, menuRef.current, e.shiftKey))
      ) {
        dialogTabPending = true;
        return;
      }
      if (controllerRef.current.containsTarget(active)) {
        const anchor = anchorRef?.current ?? returnAnchorRef.current;
        const destination = tabDestination(
          anchor,
          anchor?.closest('dialog[open]') ?? anchor?.ownerDocument,
          e.shiftKey,
          (target) =>
            controllerRef.current.containsTarget(target) ||
            insideRefsRef.current.some((ref) => ref.current?.contains(target))
        );
        if (destination) {
          tabTargetRef.current = destination;
          e.preventDefault();
        } else if (role === 'dialog') {
          dialogTabPending = true;
          return;
        }
      }
      requestClose('tab', session);
    };
    const onBlur = () => requestClose('window-blur', session);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onTab, true);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('blur', onBlur);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onTab, true);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('keydown', onKey);
    };
  }, [
    open,
    anchorRef,
    closeOnEscape,
    role,
    presentation.id,
    presentation.owner,
    menuId,
    menu.state.session,
    requestClose,
  ]);

  useEffect(() => {
    if (!open) return;
    return presentation.owner.subscribe(() => {
      if (!parent.owner.allows(parent.id, 'presentation'))
        requestClose('owner-revoked', menu.state.session);
    });
  }, [open, menu.state.session, requestClose, presentation.owner, parent.owner, parent.id]);

  if (!mounted || !placement) return null;

  return createPortal(
    <PresentationScopeContext.Provider value={presentation.scope}>
      <MenuSurface
        {...dataAttributes}
        id={id}
        ref={presentation.bindRef(assignMenuRef, `menu:${menuId}`)}
        data-presentation-surface={presentation.id}
        role={role}
        data-menu-id={menuId}
        density={density ?? (surfaceVariant === 'settings' ? 'form' : 'compact')}
        selection={selection}
        icons={icons}
        shortcuts={shortcuts}
        submenus={submenus}
        content={content ?? (role === 'dialog' ? 'form' : 'menu')}
        privateContent={privateContent}
        onKeyDown={
          keyboardNavigation
            ? (event) => {
                if (role !== 'dialog' || event.key !== 'Tab') menu.handleKeyDown(event);
              }
            : undefined
        }
        aria-label={ariaLabel}
        data-testid={testId ?? dataAttributes?.['data-testid']}
        data-ph-no-capture={privateContent || undefined}
        data-analytics-block={privateContent || undefined}
        data-ph-mask={privateContent || undefined}
        data-placement={
          placement.top != null ? 'below' : placement.bottom != null ? 'above' : 'side'
        }
        layout={{
          overflowY: layout?.overflowY ?? layout?.overflow ?? 'auto',
          ...layout,
          position: 'fixed',
          zIndex: placementMode === 'submenu' ? UI_SUBMENU_LAYER : UI_POPOVER_LAYER,
          left: placement.left,
          right: placement.right,
          top: placement.top,
          bottom: placement.bottom,
          minWidth: layout?.minWidth ?? placement.minWidth,
          maxWidth: constrainedMenuSize(layout?.maxWidth, placement.maxWidth),
          maxHeight: constrainedMenuSize(layout?.maxHeight, placement.maxHeight),
        }}
      >
        {children}
      </MenuSurface>
    </PresentationScopeContext.Provider>,
    (anchorRef?.current ?? returnAnchorRef.current)?.closest('dialog[open]') ?? document.body
  );
}
