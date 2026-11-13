// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  getNativeWheelInput,
  installNativeWheelMetadataSource,
  shouldAnimateWheel,
  type NativeWheelMetadata,
} from './wheel-motion';

it('metadata decorates the original browser event without selecting or consuming its target', () => {
  let emit: (packet: NativeWheelMetadata) => void = () => undefined;
  const dispose = installNativeWheelMetadataSource(document, (listener) => {
    emit = listener;
    return () => undefined;
  });
  const target = document.createElement('div');
  document.body.append(target);
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 17 });
  emit({
    precise: false,
    phase: 0,
    momentumPhase: 0,
    ordinal: 1,
    timestamp: performance.timeOrigin + event.timeStamp,
  });
  let received: Event | null = null;
  target.addEventListener('wheel', (next) => {
    received = next;
  });
  target.dispatchEvent(event);
  expect(received).toBe(event);
  expect(event.defaultPrevented).toBe(false);
  expect(event.deltaY).toBe(17);
  expect(getNativeWheelInput(event)?.ordinal).toBe(1);
  expect(shouldAnimateWheel(event, document)).toBe(true);
  dispose();
  target.remove();
});

it('unknown, late and ambiguous packets cannot invent exact phase or event identity', () => {
  let emit: (packet: NativeWheelMetadata) => void = () => undefined;
  const dispose = installNativeWheelMetadataSource(document, (listener) => {
    emit = listener;
    return () => undefined;
  });
  const makeEvent = (time: number) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 4 });
    Object.defineProperty(event, 'timeStamp', { value: time });
    return event;
  };
  const unknown = makeEvent(100);
  document.dispatchEvent(unknown);
  expect(shouldAnimateWheel(unknown, document)).toBe(false);
  emit({
    precise: false,
    phase: 1,
    momentumPhase: 0,
    ordinal: 1,
    timestamp: performance.timeOrigin + 100,
  });
  expect(getNativeWheelInput(unknown)).toBeUndefined();
  for (const [ordinal, precise] of [
    [2, false],
    [3, true],
  ] as const)
    emit({ precise, phase: 1, momentumPhase: 0, ordinal, timestamp: performance.timeOrigin + 200 });
  const ambiguous = makeEvent(200);
  document.dispatchEvent(ambiguous);
  expect(getNativeWheelInput(ambiguous)).toBeUndefined();
  expect(shouldAnimateWheel(ambiguous, document)).toBe(false);
  expect(ambiguous.defaultPrevented).toBe(false);
  dispose();
});
