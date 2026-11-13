import {
  installNativeWheelMetadataSource,
  type NativeWheelInput,
  type NativeWheelMetadata,
} from './wheel-motion';

const fixtures = new WeakMap<
  Document,
  { emit: (packet: NativeWheelMetadata) => void; dispose: () => void; time: number }
>();

export function installNativeWheelSource(document: Document): () => void {
  let emit: (packet: NativeWheelMetadata) => void = () => undefined;
  const dispose = installNativeWheelMetadataSource(document, (callback) => {
    emit = callback;
    return () => undefined;
  });
  fixtures.set(document, { emit: (packet) => emit(packet), dispose, time: 0 });
  return () => {
    dispose();
    fixtures.delete(document);
  };
}

export function dispatchNativeWheel(
  document: Document,
  packet: NativeWheelInput & {
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }
): boolean {
  const target = document.elementFromPoint(packet.x, packet.y);
  const view = document.defaultView;
  if (!target || !view) return false;
  const dispose = fixtures.has(document) ? undefined : installNativeWheelSource(document);
  const fixture = fixtures.get(document)!;
  fixture.time += 10;
  const event = new view.WheelEvent('wheel', {
    ...packet,
    clientX: packet.x,
    clientY: packet.y,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'timeStamp', { value: fixture.time });
  fixture.emit({ ...packet, timestamp: view.performance.timeOrigin + event.timeStamp });
  target.dispatchEvent(event);
  dispose?.();
  return true;
}
