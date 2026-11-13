import { WheelMotion, shouldAnimateWheel } from '@waypoint/platform/wheel-motion';

export function installAnimatedWheelScroll(
  container: HTMLElement,
  paintViewport: () => void,
  beforeStep?: (direction: 1 | -1) => boolean
): { cancel: () => void; dispose: () => void } {
  const window = container.ownerDocument.defaultView!;
  const motion = new WheelMotion();
  let raf: number | null = null;
  let precisePosition: number | null = null;
  let preciseOwned = 0;
  const clamp = (value: number) =>
    Math.max(0, Math.min(Math.max(0, container.scrollHeight - container.clientHeight), value));
  const cancel = () => {
    if (raf !== null) window.cancelAnimationFrame(raf);
    raf = null;
    precisePosition = null;
    motion.cancel();
  };
  const projectedPosition = () => {
    const actual = container.scrollTop;
    if (precisePosition === null) return actual;
    precisePosition = clamp(precisePosition + actual - preciseOwned);
    preciseOwned = actual;
    return precisePosition;
  };
  const step = (now: number) => {
    raf = null;
    const previous = container.scrollTop;
    if (precisePosition !== null) {
      const position = projectedPosition();
      if (position !== previous && beforeStep?.(position > previous ? 1 : -1)) {
        raf = window.requestAnimationFrame(step);
        return;
      }
      container.scrollTop = position;
      precisePosition = null;
    }
    if (motion.pending && !beforeStep?.(motion.direction)) {
      const position = motion.advance(container.scrollTop, now, clamp);
      if (position !== null) {
        container.scrollTop = position;
        motion.commit(container.scrollTop);
      }
    }
    if (container.scrollTop !== previous) paintViewport();
    if (motion.pending) raf = window.requestAnimationFrame(step);
  };
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) {
      cancel();
      return;
    }
    if (!shouldAnimateWheel(event, container.ownerDocument)) {
      event.preventDefault();
      motion.cancel();
      precisePosition = clamp(projectedPosition() + event.deltaY);
      preciseOwned = container.scrollTop;
      if (raf === null && precisePosition !== preciseOwned)
        raf = window.requestAnimationFrame(step);
      return;
    }
    if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
    const now = window.performance.now();
    motion.add(delta, projectedPosition(), now, clamp);
    if (!motion.pending) return;
    event.preventDefault();

    if (raf === null) step(now);
  };
  const onModifiedWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) cancel();
  };
  container.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('wheel', onModifiedWheel, { capture: true, passive: true });
  window.addEventListener('pointerdown', cancel, { capture: true, passive: true });
  window.addEventListener('keydown', cancel, { capture: true });
  window.addEventListener('resize', cancel, { passive: true });
  return {
    cancel,
    dispose: () => {
      cancel();
      container.removeEventListener('wheel', onWheel);
      window.removeEventListener('wheel', onModifiedWheel, { capture: true });
      window.removeEventListener('pointerdown', cancel, { capture: true });
      window.removeEventListener('keydown', cancel, { capture: true });
      window.removeEventListener('resize', cancel);
    },
  };
}
