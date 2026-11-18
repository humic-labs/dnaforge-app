import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react';
import {
  captureInputOwnership,
  captureFocusOwnership,
  inputTargetAllows,
} from '@waypoint/platform/input-ownership';
import {
  createMenuState,
  transitionMenu,
  type MenuCloseReason,
  type MenuCollections,
  type MenuDirection,
  type MenuEvent,
  type MenuItem,
  type MenuMoveOptions,
  type MenuState,
} from './menu-state';

export interface UseMenuOptions {
  items: readonly MenuItem[];
  menus?: MenuCollections;
  selectedId?: string | null;
  defaultOpen?: boolean;
  onActivate?: (itemId: string, menuId: string) => void;
  onClose?: (reason: MenuCloseReason) => void;
  onFocusItem?: (itemId: string, menuId: string) => void;
}

export type MenuKeyboardEvent = ReactKeyboardEvent<HTMLElement> | KeyboardEvent;
export interface MenuKeyboardOptions extends MenuMoveOptions {
  menuId?: string;
}

export interface MenuController {
  state: MenuState;
  stateRef: MutableRefObject<MenuState>;
  activeId: string | null;
  isOpen: boolean;
  openMenu: (preferredId?: string | null) => void;
  positioned: (session?: number) => void;
  close: (reason: MenuCloseReason, session?: number) => void;
  move: (direction: MenuDirection, menuId?: string, options?: MenuMoveOptions) => void;
  point: (itemId: string, menuId?: string) => void;
  activate: (itemId?: string | null, menuId?: string) => void;
  requestIntent: (candidateId: string | null, delayMs?: number, menuId?: string) => void;
  cancelIntent: () => void;
  send: (event: MenuEvent) => void;
  subscribeClose: (listener: (reason: MenuCloseReason) => void) => () => void;
  bindSurface: (node: HTMLElement | null, menuId?: string) => void;
  containsTarget: (target: Node | null) => boolean;
  handleKeyDown: (event: MenuKeyboardEvent, options?: MenuKeyboardOptions) => boolean;
}

export function useMenu(options: UseMenuOptions): MenuController {
  const collections = useMemo<MenuCollections>(
    () => ({ ...options.menus, root: options.items }),
    [options.items, options.menus]
  );
  const latest = useRef({ options, collections });
  latest.current = { options, collections };
  const [state, setState] = useState<MenuState>(() =>
    options.defaultOpen
      ? transitionMenu(
          createMenuState(),
          { type: 'open', menuId: 'root', preferredId: options.selectedId },
          collections
        ).state
      : createMenuState()
  );
  const stateRef = useRef(state);
  const pendingFocus = useRef<{
    state: MenuState;
    itemId: string;
    menuId: string;
    isCurrent: () => boolean;
  } | null>(null);
  const mounted = useRef(true);
  const surfaces = useRef(new Map<string, HTMLElement>());
  const closeListeners = useRef(new Set<(reason: MenuCloseReason) => void>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef(0);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const send = useCallback(
    (event: MenuEvent) => {
      if (!mounted.current) return;
      const transition = transitionMenu(stateRef.current, event, latest.current.collections);
      if (transition.state !== stateRef.current) {
        pendingFocus.current = null;
        stateRef.current = transition.state;
        setState(transition.state);
      }
      for (const effect of transition.effects) {
        if (effect.type === 'cancel-intent') clearTimer();
        else if (effect.type === 'close') {
          for (const listener of closeListeners.current) listener(effect.reason);
          latest.current.options.onClose?.(effect.reason);
        } else if (effect.type === 'focus-item') {
          const surface = surfaces.current.get(effect.menuId) ?? surfaces.current.get('root');
          pendingFocus.current = {
            state: transition.state,
            itemId: effect.itemId,
            menuId: effect.menuId,
            isCurrent: surface
              ? captureFocusOwnership(surface, { allowDetachedOrigin: true })
              : () => true,
          };
        } else {
          if (stateRef.current.session !== effect.session) continue;
          const item = latest.current.collections[effect.menuId]?.find(
            (candidate) => candidate.id === effect.itemId
          );
          if (item && !item.disabled)
            latest.current.options.onActivate?.(effect.itemId, effect.menuId);
        }
      }
    },
    [clearTimer]
  );
  useLayoutEffect(() => {
    send({ type: 'reconcile', session: stateRef.current.session });
  }, [collections, send]);
  const flushFocus = useCallback(() => {
    const focus = pendingFocus.current;
    const currentState = stateRef.current;
    if (!mounted.current || !focus || focus.state !== currentState || currentState.phase !== 'open')
      return;
    if (!focus.isCurrent()) {
      pendingFocus.current = null;
      return;
    }
    const surface = surfaces.current.get(focus.menuId);
    if (surfaces.current.size > 0 && !surface) return;
    const item = latest.current.collections[focus.menuId]?.find(
      (candidate) => candidate.id === focus.itemId
    );
    if (
      !item ||
      item.disabled ||
      !currentState.levels.some(
        (level) => level.menuId === focus.menuId && level.activeId === focus.itemId
      )
    ) {
      pendingFocus.current = null;
      return;
    }
    if (surface && !inputTargetAllows(surface, 'keyboard')) return;
    pendingFocus.current = null;
    latest.current.options.onFocusItem?.(focus.itemId, focus.menuId);
  }, []);
  useLayoutEffect(() => {
    if (stateRef.current === state) flushFocus();
  }, [state, flushFocus]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
    };
  }, [clearTimer]);
  const subscribeClose = useCallback((listener: (reason: MenuCloseReason) => void) => {
    closeListeners.current.add(listener);
    return () => {
      closeListeners.current.delete(listener);
    };
  }, []);
  const bindSurface = useCallback(
    (node: HTMLElement | null, menuId = 'root') => {
      if (node) {
        surfaces.current.set(menuId, node);
        flushFocus();
        queueMicrotask(flushFocus);
      } else surfaces.current.delete(menuId);
    },
    [flushFocus]
  );
  const containsTarget = useCallback(
    (target: Node | null) =>
      target !== null && [...surfaces.current.values()].some((surface) => surface.contains(target)),
    []
  );

  return useMemo(() => {
    const session = state.session;
    const isOpen = state.phase !== 'closed';
    const current = state.levels[state.levels.length - 1];
    const openMenu = (preferredId = latest.current.options.selectedId) =>
      send({ type: 'open', menuId: 'root', preferredId });
    const close = (reason: MenuCloseReason, expected = session) =>
      send({ type: 'close', session: expected, reason });
    const move = (direction: MenuDirection, menuId?: string, options?: MenuMoveOptions) =>
      send({ type: 'move', session, direction, menuId, ...options });
    const activate = (itemId = current?.activeId, menuId = current?.menuId ?? 'root') => {
      const surface = surfaces.current.get(menuId);
      if (surface && !inputTargetAllows(surface, 'pointer')) return;
      if (itemId !== null && itemId !== undefined)
        send({ type: 'activate', session, menuId, itemId });
    };
    return {
      state,
      stateRef,
      activeId: current?.activeId ?? null,
      isOpen,
      openMenu,
      positioned: (expected = session) => send({ type: 'positioned', session: expected }),
      close,
      move,
      point: (itemId, menuId = current?.menuId ?? 'root') => {
        const surface = surfaces.current.get(menuId);
        if (surface && !inputTargetAllows(surface, 'pointer')) return;
        send({ type: 'point', session, menuId, itemId });
      },
      activate,
      requestIntent: (candidateId, delayMs = 300, menuId = current?.menuId ?? 'root') => {
        if (
          stateRef.current.phase === 'closed' ||
          stateRef.current.session !== session ||
          !mounted.current
        )
          return;
        clearTimer();
        const token = ++request.current;
        const surface = surfaces.current.get(menuId);
        const valid = surface ? captureInputOwnership(surface, 'pointer') : () => true;
        send({ type: 'intent', session, menuId, candidateId, request: token });
        if (
          stateRef.current.intent.phase !== 'waiting' ||
          stateRef.current.intent.request !== token
        )
          return;
        timer.current = setTimeout(() => {
          if (
            stateRef.current.intent.phase !== 'waiting' ||
            stateRef.current.intent.request !== token ||
            stateRef.current.session !== session
          )
            return;
          timer.current = null;
          if (valid()) send({ type: 'intent-resolve', session, request: token });
          else send({ type: 'intent-cancel', session });
        }, delayMs);
      },
      cancelIntent: () => send({ type: 'intent-cancel', session }),
      send,
      subscribeClose,
      bindSurface,
      containsTarget,
      handleKeyDown: (event, navigation = {}) => {
        const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
        if (event.defaultPrevented || nativeEvent.isComposing || nativeEvent.keyCode === 229)
          return false;
        const editable =
          event.target instanceof Element &&
          Boolean(
            event.target.closest('input,textarea,[contenteditable=""],[contenteditable="true"]')
          );
        const menuId =
          navigation.menuId ??
          (event.target instanceof Element
            ? (event.target.closest<HTMLElement>('[data-menu-id]')?.dataset.menuId ?? 'root')
            : 'root');
        const target = surfaces.current.get(menuId) ?? event.currentTarget;
        if (target instanceof Element && !inputTargetAllows(target, 'keyboard', nativeEvent))
          return false;
        const keyboardLevelIndex = state.levels.findIndex((level) => level.menuId === menuId);
        const keyboardLevel = state.levels[keyboardLevelIndex];
        if (event.key === 'Tab') {
          if (isOpen) close('tab');
          return isOpen;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!isOpen) openMenu();
          else move(event.key === 'ArrowDown' ? 'next' : 'previous', menuId, navigation);
        } else if (isOpen && !editable && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault();
          move(event.key === 'Home' ? 'first' : 'last', menuId, navigation);
        } else if (event.key === 'Enter' || (event.key === ' ' && !editable)) {
          event.preventDefault();
          if (isOpen) activate(keyboardLevel?.activeId, menuId);
          else openMenu();
        } else if (isOpen && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (keyboardLevelIndex > 0) send({ type: 'submenu-close', session, menuId });
          else close('escape');
        } else if (isOpen && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
          if (editable) return false;
          event.preventDefault();
          send({
            type: event.key === 'ArrowRight' ? 'submenu-open' : 'submenu-close',
            session,
            menuId,
          });
        } else return false;
        return true;
      },
    };
  }, [state, send, clearTimer, subscribeClose, bindSurface, containsTarget]);
}
