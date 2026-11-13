import { describe, expect, it } from 'vitest';
import { contentOverflowsX, contentOverflowsY } from './content-overflows';

describe('contentOverflowsX/Y', () => {
  it('detects horizontal overflow', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollWidth', { value: 400 });
    Object.defineProperty(el, 'clientWidth', { value: 200 });
    expect(contentOverflowsX(el)).toBe(true);
  });

  it('detects vertical overflow', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 400 });
    Object.defineProperty(el, 'clientHeight', { value: 200 });
    expect(contentOverflowsY(el)).toBe(true);
  });

  it('returns false when content fits', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollWidth', { value: 200 });
    Object.defineProperty(el, 'clientWidth', { value: 200 });
    Object.defineProperty(el, 'scrollHeight', { value: 200 });
    Object.defineProperty(el, 'clientHeight', { value: 200 });
    expect(contentOverflowsX(el)).toBe(false);
    expect(contentOverflowsY(el)).toBe(false);
  });
});
