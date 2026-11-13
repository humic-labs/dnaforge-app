import { afterEach, describe, expect, it } from 'vitest';
import {
  getNativeWheelInput,
  installNativeWheelMetadataSource,
  type NativeWheelMetadata,
} from '@waypoint/platform/wheel-motion';

afterEach(() => document.body.replaceChildren());

describe('original browser wheel routing', () => {
  it.each(['div', 'button', 'dialog', 'section', 'input'])(
    'metadata preserves the original event and browser target for a %s covering a retained viewer',
    (tag) => {
      const retained = document.createElement('div');
      retained.setAttribute('data-sequence-wheel-zoom-viewport', '');
      retained.inert = true;
      const target = document.createElement(tag);
      document.body.append(retained, target);
      let emit!: (packet: NativeWheelMetadata) => void;
      const dispose = installNativeWheelMetadataSource(document, (listener) => {
        emit = listener;
        return () => undefined;
      });
      const received: Event[] = [];
      const retainedEvents: Event[] = [];
      target.addEventListener('wheel', (event) => received.push(event));
      retained.addEventListener('wheel', (event) => retainedEvents.push(event));
      for (const [index, precise] of [true, false].entries()) {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: precise ? 17 : 120,
        });
        Object.defineProperty(event, 'timeStamp', { value: 100 + index * 10 });
        emit({
          precise,
          phase: precise ? 1 : 0,
          momentumPhase: 0,
          ordinal: index + 1,
          timestamp: performance.timeOrigin + event.timeStamp,
        });
        expect(target.dispatchEvent(event)).toBe(true);
        expect(received[index]).toBe(event);
        expect(event.target).toBe(target);
        expect(event.defaultPrevented).toBe(false);
        expect(getNativeWheelInput(event)?.precise).toBe(precise);
      }
      expect(retainedEvents).toEqual([]);
      dispose();
    }
  );

  it('metadata alone dispatches no replacement input and disposal removes its listener', () => {
    let emit!: (packet: NativeWheelMetadata) => void;
    let unsubscribed = false;
    const dispose = installNativeWheelMetadataSource(document, (listener) => {
      emit = listener;
      return () => {
        unsubscribed = true;
      };
    });
    const target = document.createElement('div');
    document.body.append(target);
    const received: Event[] = [];
    target.addEventListener('wheel', (event) => received.push(event));
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 19 });
    emit({
      precise: true,
      phase: 1,
      momentumPhase: 0,
      ordinal: 1,
      timestamp: performance.timeOrigin + event.timeStamp,
    });
    expect(received).toEqual([]);
    dispose();
    expect(unsubscribed).toBe(true);
    target.dispatchEvent(event);
    expect(received).toEqual([event]);
    expect(getNativeWheelInput(event)).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });
});
