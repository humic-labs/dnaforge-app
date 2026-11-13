export class WheelMotion {
  constructor(private readonly snapDistance = 1) {}
  private target: number | null = null;
  private position = 0;
  private owned = 0;
  private frameAt = 0;
  private inputAt = 0;

  get pending(): boolean {
    return this.target !== null;
  }
  get direction(): 1 | -1 {
    return (this.target ?? this.position) >= this.position ? 1 : -1;
  }
  cancel(): void {
    this.target = null;
  }
  commit(actual: number): void {
    this.owned = actual;
  }

  private rebase(actual: number, clamp: (value: number) => number): void {
    const shift = actual - this.owned;
    if (this.target !== null) this.target = clamp(this.target + shift);
    this.position = clamp(this.position + shift);
    this.owned = actual;
  }

  add(delta: number, actual: number, now: number, clamp: (value: number) => number): void {
    if (!Number.isFinite(delta) || !delta) return;
    if (this.target !== null && Math.sign(delta) !== Math.sign(this.target - this.position))
      this.cancel();
    if (this.target === null) {
      this.position = actual;
      this.owned = actual;
      this.frameAt = now;
    } else this.rebase(actual, clamp);
    const destination = clamp((this.target ?? this.position) + delta);
    this.inputAt = now;
    this.target = destination === this.position ? null : destination;
  }

  advance(actual: number, now: number, clamp: (value: number) => number): number | null {
    if (this.target === null) return null;
    this.rebase(actual, clamp);
    const distance = this.target - this.position;
    const elapsed = Math.max(8, Math.min(50, now - this.frameAt));
    this.frameAt = now;
    this.position =
      Math.abs(distance) <= this.snapDistance || now - this.inputAt >= 180
        ? this.target
        : this.position + distance * (1 - Math.exp(-elapsed / 42));
    if (Math.abs(this.target - this.position) <= Math.min(0.01, this.snapDistance / 100))
      this.target = null;
    return this.position;
  }
}

const nativeDocuments = new WeakSet<Document>();
const nativeInputs = new WeakMap<Event, Readonly<NativeWheelInput>>();
const zoomTargets = new WeakMap<HTMLElement, (event: WheelEvent) => void>();

export function registerWheelZoomTarget(
  target: HTMLElement,
  onWheel: (event: WheelEvent) => void
): () => void {
  zoomTargets.set(target, onWheel);
  target.setAttribute('data-sequence-wheel-zoom-target', '');
  return () => {
    if (zoomTargets.get(target) !== onWheel) return;
    zoomTargets.delete(target);
    target.removeAttribute('data-sequence-wheel-zoom-target');
  };
}

export function forwardWheelZoom(event: WheelEvent, target: HTMLElement): boolean {
  const onWheel = zoomTargets.get(target);
  const view = target.ownerDocument.defaultView;
  if (!onWheel || !view || event.defaultPrevented) return false;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const input = new view.WheelEvent('wheel', {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    ctrlKey: event.ctrlKey || !event.metaKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    cancelable: true,
  });
  const native = nativeInputs.get(event);
  if (native) {
    nativeInputs.set(input, native);
    Object.defineProperty(input, 'nativeSequenceWheel', { value: native });
  }
  event.preventDefault();
  event.stopPropagation();
  onWheel(input);
  return true;
}

export interface NativeWheelInput {
  precise: boolean;
  phase: number;
  momentumPhase: number;
  ordinal: number;
}

export function installNativeWheelSource(document: Document): () => void {
  nativeDocuments.add(document);
  return () => nativeDocuments.delete(document);
}

export function shouldAnimateWheel(event: WheelEvent, document: Document): boolean {
  const native = nativeInputs.get(event);
  return native ? !native.precise : event.deltaMode !== 0 || !nativeDocuments.has(document);
}

export function getNativeWheelInput(event: Event): Readonly<NativeWheelInput> | undefined {
  return nativeInputs.get(event);
}

export interface NativeWheelPacket extends NativeWheelInput {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function dispatchNativeWheel<Packet extends NativeWheelPacket>(
  document: Document,
  packet: Packet,
  returnToBrowser?: (packet: Packet) => void
): boolean {
  if (![packet.x, packet.y, packet.deltaX, packet.deltaY].every(Number.isFinite)) return false;
  const target = document.elementFromPoint(packet.x, packet.y);
  if (!target?.closest('[data-sequence-wheel-zoom-viewport]')) {
    if (packet.deltaX || packet.deltaY) returnToBrowser?.(packet);
    return false;
  }
  const view = document.defaultView;
  if (!view) return false;
  const event = new view.WheelEvent('wheel', {
    clientX: packet.x,
    clientY: packet.y,
    deltaX: packet.deltaX,
    deltaY: packet.deltaY,
    deltaMode: 0,
    ctrlKey: packet.ctrlKey ?? false,
    metaKey: packet.metaKey ?? false,
    shiftKey: packet.shiftKey ?? false,
    altKey: packet.altKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  const source = Object.freeze({
    precise: packet.precise,
    phase: packet.phase,
    momentumPhase: packet.momentumPhase,
    ordinal: packet.ordinal,
  });
  nativeInputs.set(event, source);
  Object.defineProperty(event, 'nativeSequenceWheel', { value: source });
  target.dispatchEvent(event);
  return true;
}
