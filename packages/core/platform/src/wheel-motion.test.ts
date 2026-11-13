import { describe, expect, it } from 'vitest';
import { WheelMotion } from './wheel-motion';

describe('shared wheel motion', () => {
  const clamp = (value: number) => Math.max(0, Math.min(4000, value));
  it('responds on the first refresh and finishes the complete tick', () => {
    const motion = new WheelMotion();
    motion.add(120, 100, 0, clamp);
    let position = motion.advance(100, 16.7, clamp)!;
    motion.commit(position);
    expect(position).toBeGreaterThan(100);
    expect(position).toBeLessThan(220);
    position = motion.advance(position, 180, clamp)!;
    expect(position).toBe(220);
    expect(motion.pending).toBe(false);
  });
  it('preserves same-direction subframe packets and rebased distance', () => {
    const motion = new WheelMotion();
    let position = 100;
    let now = 0;
    for (const direction of [1, 1, 1]) {
      for (let i = 0; i < 90; i++) {
        motion.add(direction * 8, position, now, clamp);
        now += 4;
        if (i % 4 === 3) {
          position = motion.advance(position, now, clamp)!;
          motion.commit(position);
        }
      }
    }
    position += 1000;
    expect(motion.advance(position, now + 180, clamp)).toBe(3260);
  });
  it('reverses on the next frame instead of repaying opposing unfinished motion', () => {
    const motion = new WheelMotion();
    motion.add(120, 100, 0, clamp);
    const displayed = motion.advance(100, 16, clamp)!;
    motion.commit(displayed);
    motion.add(-40, displayed, 17, clamp);
    const reversed = motion.advance(displayed, 32, clamp)!;
    expect(reversed).toBeLessThan(displayed);
    motion.commit(reversed);
    expect(motion.advance(reversed, 200, clamp)).toBeCloseTo(displayed - 40, 10);
  });
  it('a direct touchpad takeover discards mouse easing without retaining debt', () => {
    const motion = new WheelMotion();
    motion.add(120, 100, 0, clamp);
    motion.cancel();
    expect(motion.advance(108, 16.7, clamp)).toBeNull();
    motion.add(1, 108, 20, clamp);
    expect(motion.advance(108, 36.7, clamp)).toBe(109);
  });
  it('clamped ticks do not delay a small reverse gesture', () => {
    const motion = new WheelMotion();
    motion.add(-1000, 0, 0, clamp);
    expect(motion.pending).toBe(false);
    motion.add(1, 0, 1, clamp);
    expect(motion.advance(0, 17, clamp)).toBe(1);
  });
});
