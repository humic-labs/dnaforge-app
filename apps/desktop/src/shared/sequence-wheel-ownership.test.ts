import { describe, expect, it } from 'vitest';
import { browserWheelInput, type SequenceMouseWheelPacket } from './sequence-wheel-ownership';

const packet = (overrides: Partial<SequenceMouseWheelPacket> = {}): SequenceMouseWheelPacket => ({
  x: 864.4,
  y: 225.6,
  deltaX: 0,
  deltaY: 60,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  precise: true,
  phase: 4,
  momentumPhase: 0,
  ordinal: 3,
  ...overrides,
});

describe('browser wheel input for a returned native packet', () => {
  it('keeps the pointer position, distance and precision of a trackpad packet', () => {
    expect(browserWheelInput(packet())).toMatchObject({
      type: 'mouseWheel',
      x: 864,
      y: 226,
      deltaY: -60,
      wheelTicksY: -1.5,
      hasPreciseScrollingDeltas: true,
      modifiers: [],
    });
    expect(browserWheelInput(packet({ deltaX: 24, deltaY: 0 }))).toMatchObject({
      deltaX: -24,
      wheelTicksX: -0.6,
    });
  });

  it('keeps a mouse-wheel tick discrete and carries held modifiers', () => {
    expect(
      browserWheelInput(packet({ deltaY: -120, precise: false, altKey: true, metaKey: true }))
    ).toMatchObject({
      deltaY: 120,
      wheelTicksY: 3,
      hasPreciseScrollingDeltas: false,
      modifiers: ['meta', 'alt'],
    });
  });

  it('refuses packets that cannot scroll anything', () => {
    expect(browserWheelInput(packet({ deltaY: 0 }))).toBeNull();
    expect(browserWheelInput(packet({ x: Number.NaN }))).toBeNull();
    expect(browserWheelInput(packet({ deltaY: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(browserWheelInput(null)).toBeNull();
  });
});
