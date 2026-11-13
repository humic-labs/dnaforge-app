import { OverlayBinding } from './overlay-binding';
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  useCallback,
  useRef,
  type Ref,
  type RefCallback,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import {
  presentationOwner,
  type PresentationCapture,
  type PresentationInput,
  type PresentationOwner,
} from './ownership';

export interface PresentationScope {
  id: string;
  owner: PresentationOwner;
}
export const PresentationScopeContext = createContext<PresentationScope>({
  id: 'window',
  owner: presentationOwner,
});
export const usePresentationScope = (): PresentationScope => useContext(PresentationScopeContext);

export function usePresentationSurface({
  id: requestedId,
  parentId,
  active = true,
  capture = 'none',
  focused,
}: {
  id?: string;
  parentId?: string;
  active?: boolean;
  capture?: PresentationCapture;
  focused?: boolean;
} = {}) {
  const parent = usePresentationScope();
  const generatedId = useId();
  const id = requestedId ?? generatedId;
  const owner = parent.owner;
  const parentSurfaceId = parentId ?? parent.id;
  const activeRef = useRef(active);
  activeRef.current = active;
  useLayoutEffect(() => {
    owner.dispatch({
      type: 'attach',
      id,
      parentId: parentSurfaceId,
      active: activeRef.current,
      capture,
    });
  }, [owner, id, parentSurfaceId, capture]);
  useLayoutEffect(() => () => owner.dispatch({ type: 'detach', id }), [owner, id]);
  useLayoutEffect(() => {
    owner.dispatch({ type: active ? 'activate' : 'suspend', id });
  }, [owner, id, active]);
  const visible = useSyncExternalStore(owner.subscribe, () => owner.allows(id, 'presentation'));
  useLayoutEffect(() => {
    if (focused !== undefined) owner.dispatch({ type: focused && visible ? 'focus' : 'blur', id });
  }, [owner, id, focused, visible]);
  const scope = useMemo(() => ({ id, owner }), [id, owner]);
  const bindRef = useCallback(
    (node: HTMLElement | null) => {
      node?.toggleAttribute('inert', !visible);
    },
    [visible]
  );
  return { ...scope, scope, visible, bindRef };
}

export function usePresentationEligibility(input: PresentationInput = 'keyboard'): boolean {
  const { owner, id } = usePresentationScope();
  return useSyncExternalStore(owner.subscribe, () => owner.allows(id, input));
}

export function PresentationBoundary({
  children,
  layout = 'contents',
  ...options
}: {
  children: ReactNode;
  layout?: 'contents' | 'fill' | 'flex';
  id?: string;
  parentId?: string;
  active?: boolean;
  capture?: PresentationCapture;
  focused?: boolean;
}) {
  const surface = usePresentationSurface(options);
  return (
    <PresentationScopeContext.Provider value={surface.scope}>
      <div
        data-presentation-surface={surface.id}
        ref={surface.bindRef}
        className={
          layout === 'fill'
            ? 'h-full w-full'
            : layout === 'flex'
              ? 'flex flex-col flex-1 min-h-0'
              : 'contents'
        }
        aria-hidden={!surface.visible}
        style={{ display: surface.visible ? undefined : 'none' }}
        onFocusCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-presentation-surface]') === event.currentTarget
          )
            surface.owner.dispatch({ type: 'focus', id: surface.id });
        }}
        onPointerDownCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-presentation-surface]') === event.currentTarget
          )
            surface.owner.dispatch({ type: 'focus', id: surface.id });
        }}
      >
        {children}
      </div>
    </PresentationScopeContext.Provider>
  );
}

export function PresentationHost({
  children,
  element,
  ...options
}: {
  children: ReactNode;
  element: HTMLElement;
  id?: string;
  parentId?: string;
  active?: boolean;
  capture?: PresentationCapture;
  focused?: boolean;
}) {
  const surface = usePresentationSurface(options);
  useLayoutEffect(() => {
    element.dataset.presentationSurface = surface.id;
    element.toggleAttribute('inert', !surface.visible);
    element.setAttribute('aria-hidden', String(!surface.visible));
    element.style.contentVisibility = surface.visible ? '' : 'hidden';
    const focus = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-presentation-surface]') === element
      )
        surface.owner.dispatch({ type: 'focus', id: surface.id });
    };
    element.addEventListener('focusin', focus, true);
    element.addEventListener('pointerdown', focus, true);
    return () => {
      element.removeEventListener('focusin', focus, true);
      element.removeEventListener('pointerdown', focus, true);
      delete element.dataset.presentationSurface;
      element.removeAttribute('inert');
      element.removeAttribute('aria-hidden');
      element.style.contentVisibility = '';
    };
  }, [element, surface.id, surface.owner, surface.visible]);
  return (
    <PresentationScopeContext.Provider value={surface.scope}>
      {children}
    </PresentationScopeContext.Provider>
  );
}

export function usePresentationOverlay(capture: Exclude<PresentationCapture, 'none'>) {
  const parent = usePresentationScope();
  const id = useId();
  const parentId = useRef(parent.id);
  parentId.current = parent.id;
  const binding = useMemo(
    () => new OverlayBinding(parent.owner, parentId.current, id, capture),
    [parent.owner, id, capture]
  );
  const { callbacks, refs } = useMemo(
    () => ({
      callbacks: new Map<string, RefCallback<HTMLElement>>(),
      refs: new Map<string, Ref<HTMLElement> | undefined>(),
    }),
    [binding]
  );
  const scope = useMemo(() => ({ id, owner: parent.owner }), [id, parent.owner]);
  const bindRef = useCallback(
    <T extends HTMLElement>(ref: Ref<T> | undefined, key: string): RefCallback<T> => {
      refs.set(key, ref as Ref<HTMLElement> | undefined);
      let callback = callbacks.get(key);
      if (!callback) {
        callback = (node) => {
          const original = refs.get(key);
          if (typeof original === 'function') original(node);
          else if (original) (original as MutableRefObject<HTMLElement | null>).current = node;
          binding.bind(key, node);
        };
        callbacks.set(key, callback);
      }
      return callback as RefCallback<T>;
    },
    [binding, callbacks, refs]
  );
  useLayoutEffect(() => binding.setParent(parent.id), [binding, parent.id]);
  const visible = useSyncExternalStore(parent.owner.subscribe, () =>
    parent.owner.allows(id, 'presentation')
  );
  return { ...scope, scope, bindRef, visible, setReturnFocus: binding.setReturnFocus };
}

export function usePresentationListener(scope?: PresentationScope) {
  const inherited = usePresentationScope();
  const { id, owner } = scope ?? inherited;
  return useMemo(() => {
    const handlers = new WeakMap<(event: KeyboardEvent) => void, EventListener>();
    return {
      add(
        target: Window | Document,
        type: 'keydown' | 'keyup',
        handler: (event: KeyboardEvent) => void,
        options?: boolean | AddEventListenerOptions
      ) {
        const wrapped: EventListener = (event) => {
          if (!event.defaultPrevented && owner.allowsEvent(id, 'keyboard', event))
            handler(event as KeyboardEvent);
        };
        handlers.set(handler, wrapped);
        if (options === undefined) target.addEventListener(type, wrapped);
        else target.addEventListener(type, wrapped, options);
      },
      remove(
        target: Window | Document,
        type: 'keydown' | 'keyup',
        handler: (event: KeyboardEvent) => void,
        options?: boolean | EventListenerOptions
      ) {
        const wrapped = handlers.get(handler);
        if (wrapped) {
          if (options === undefined) target.removeEventListener(type, wrapped);
          else target.removeEventListener(type, wrapped, options);
        }
        handlers.delete(handler);
      },
    };
  }, [id, owner]);
}
