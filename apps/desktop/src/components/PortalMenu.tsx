import { scheduleFocus } from '../shared/utils/safeFocus';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { UI_POPOVER_LAYER_CLASS, UI_SUBMENU_LAYER_CLASS } from './ui/styles';
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

export interface PortalMenuProps {
  id?: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onRequestClose: () => void;
  role?: 'listbox' | 'menu' | 'dialog';
  horizontalAlign?: 'start' | 'end';
  preferredSide?: 'top' | 'bottom';
  allowFlip?: boolean;
  placement?: 'dropdown' | 'submenu';
  surfaceRef?: RefObject<HTMLDivElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  insideRefs?: readonly RefObject<HTMLElement | null>[];
  closeOnEscape?: boolean;
  className?: string;
  surfaceVariant?: 'default' | 'settings';
  privateContent?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
  dataAttributes?: Record<`data-${string}`, string | undefined>;
  children: ReactNode;
}

export function PortalMenu({
  id,
  open,
  anchorRef,
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
  className = '',
  surfaceVariant = 'default',
  privateContent = false,
  'aria-label': ariaLabel,
  'data-testid': testId,
  dataAttributes,
  children,
}: PortalMenuProps) {
  const parent = usePresentationScope();
  const presentation = usePresentationOverlay(role === 'dialog' ? 'modal' : 'keyboard');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  const insideRefsRef = useRef(insideRefs);
  insideRefsRef.current = insideRefs;
  const assignMenuRef = useCallback(
    (node: HTMLDivElement | null) => {
      menuRef.current = node;
      if (node) presentation.setReturnFocus(anchorRef.current);
      if (surfaceRef) {
        (surfaceRef as { current: HTMLDivElement | null }).current = node;
      }
    },
    [surfaceRef, presentation.setReturnFocus, anchorRef]
  );

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    let placed = false;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      if (placed && rect.width === 0 && rect.height === 0) {
        closeRef.current();
        return;
      }
      setPlacement(
        computePlacement(rect, horizontalAlign, placementMode, preferredSide, allowFlip)
      );
      placed = true;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, horizontalAlign, placementMode, preferredSide, allowFlip]);

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
    const top =
      placementMode !== 'submenu'
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
  }, [placement, placementMode]);

  const mounted = open && placement !== null;
  useLayoutEffect(() => {
    if (mounted) return scheduleFocus(initialFocusRef?.current);
  }, [mounted, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        anchorRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        insideRefsRef.current.some((ref) => ref.current?.contains(target))
      ) {
        return;
      }
      closeRef.current();
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
        presentation.setReturnFocus(anchorRef.current);
        closeRef.current();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [
    open,
    anchorRef,
    closeOnEscape,
    presentation.id,
    presentation.owner,
    presentation.setReturnFocus,
  ]);

  useEffect(() => {
    if (!open) return;
    return presentation.owner.subscribe(() => {
      if (!parent.owner.allows(parent.id, 'presentation')) closeRef.current();
    });
  }, [open, presentation.owner, parent.owner, parent.id]);

  if (!open || !placement) return null;

  return createPortal(
    <PresentationScopeContext.Provider value={presentation.scope}>
      <div
        {...dataAttributes}
        id={id}
        ref={presentation.bindRef(assignMenuRef, 'menu')}
        data-presentation-surface={presentation.id}
        role={role}
        aria-label={ariaLabel}
        data-testid={testId}
        data-ph-no-capture={privateContent || undefined}
        data-analytics-block={privateContent || undefined}
        data-ph-mask={privateContent || undefined}
        data-placement={
          placement.top != null ? 'below' : placement.bottom != null ? 'above' : 'side'
        }
        className={`fixed ${placementMode === 'submenu' ? UI_SUBMENU_LAYER_CLASS : UI_POPOVER_LAYER_CLASS} overflow-y-auto ${
          surfaceVariant === 'settings'
            ? 'rounded-md bg-bg shadow-xl'
            : 'rounded-lg border border-border bg-bg-subtle shadow-lg'
        } ${privateContent ? 'ph-no-capture rr-block' : ''} ${className}`}
        style={{
          ...(placement.left != null ? { left: placement.left } : { right: placement.right }),
          ...(placement.top != null ? { top: placement.top } : { bottom: placement.bottom }),
          minWidth: placement.minWidth,
          maxWidth: placement.maxWidth,
          maxHeight: placement.maxHeight,
        }}
      >
        {children}
      </div>
    </PresentationScopeContext.Provider>,
    anchorRef.current?.closest('dialog[open]') ?? document.body
  );
}
