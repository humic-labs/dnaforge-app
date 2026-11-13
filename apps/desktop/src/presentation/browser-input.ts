import { installInputOwnership } from '@waypoint/platform/input-ownership';
import { presentationOwner } from './ownership';

export function presentationSurfaceFor(target: Element): string {
  return (
    target.closest<HTMLElement>('[data-presentation-surface]')?.dataset.presentationSurface ??
    'window'
  );
}

export function installPresentationInput(document: Document): () => void {
  const dispose = installInputOwnership(document, {
    allows: (target, input, event) =>
      event
        ? presentationOwner.allowsEvent(presentationSurfaceFor(target), input, event)
        : presentationOwner.allows(presentationSurfaceFor(target), input),
    capture: (target, input) => {
      const lease = presentationOwner.capture(presentationSurfaceFor(target), input);
      return () => target.isConnected && presentationOwner.isCurrent(lease);
    },
    allowsFocus: (target) => presentationOwner.allowsFocus(presentationSurfaceFor(target)),
    captureFocus: (target) => {
      const lease = presentationOwner.captureFocus(presentationSurfaceFor(target));
      return () => target.isConnected && presentationOwner.isCurrent(lease);
    },
    subscribe: presentationOwner.subscribe,
  });
  const captureEvent = (event: Event) => {
    presentationOwner.getSnapshot(event);
  };
  document.defaultView?.addEventListener('keydown', captureEvent, true);
  document.defaultView?.addEventListener('keyup', captureEvent, true);
  let gesture: { current: () => boolean; zoom: boolean } | null = null;
  const onWheel = (event: WheelEvent) => {
    if (!(event.target instanceof Element)) return;
    const momentum = 'momentum' in event && event.momentum === true;
    const modified = (event.ctrlKey || event.metaKey) && !event.shiftKey;
    if (momentum && gesture && (!gesture.current() || (gesture.zoom && !modified))) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const id = presentationSurfaceFor(event.target);
    if (!presentationOwner.allows(id, 'pointer')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!momentum) {
      const lease = presentationOwner.capture(id, 'pointer');
      gesture = {
        current: () => presentationOwner.isCurrent(lease),
        zoom: modified && event.target.closest('[data-sequence-wheel-zoom-viewport]') !== null,
      };
    }
  };
  const onFocus = (event: Event) => {
    if (event.target instanceof Element)
      presentationOwner.dispatch({
        type: 'focus',
        id: presentationSurfaceFor(event.target),
        inputIntent: true,
      });
  };
  const onBlur = () => presentationOwner.dispatch({ type: 'invalidate' });
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('pointerdown', onFocus, true);
  document.defaultView?.addEventListener('blur', onBlur);
  document.defaultView?.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    dispose();
    document.defaultView?.removeEventListener('keydown', captureEvent, true);
    document.defaultView?.removeEventListener('keyup', captureEvent, true);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('pointerdown', onFocus, true);
    document.defaultView?.removeEventListener('blur', onBlur);
    document.defaultView?.removeEventListener('wheel', onWheel, { capture: true });
  };
}
