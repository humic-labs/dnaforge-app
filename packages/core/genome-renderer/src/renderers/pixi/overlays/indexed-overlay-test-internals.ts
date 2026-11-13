import type { IndexedAnnotationOverlay } from './annotation-overlay';

export function overlayPresenterInternals(overlay: IndexedAnnotationOverlay): object {
  const owners: object[] = [
    overlay.getPrepackedControllerForTest(),
    overlay.getCompiledBroadControllerForTest(),
    overlay.getRetainedLinearPresenterForTest(),
    overlay.getLayoutStateForTest(),
    overlay.getSearchFocusControllerForTest(),
    overlay.getHitTestControllerForTest(),
    overlay.getImmediateDrawControllerForTest(),
    overlay.getInteractionOutlineControllerForTest(),
    overlay.getBodyFrameControllerForTest(),
    overlay.getResidentPageControllerForTest(),
  ];

  const ownerFor = (prop: PropertyKey): object | undefined =>
    owners.find((owner) => Object.prototype.hasOwnProperty.call(owner, prop));

  return new Proxy(overlay, {
    get(target, prop, receiver) {
      const owner = ownerFor(prop);
      if (owner) return Reflect.get(owner, prop, owner);
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      const owner = ownerFor(prop);
      if (owner) {
        Reflect.set(owner, prop, value, owner);
        return true;
      }
      Reflect.set(target, prop, value, target);
      return true;
    },
  });
}
