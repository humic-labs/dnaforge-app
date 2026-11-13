import { describe, expect, it, vi, afterEach } from 'vitest';
import { findScrollParent } from './findScrollParent';

describe('findScrollParent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('returns the nearest overflow:auto ancestor', () => {
    const outer = document.createElement('div');
    const scroll = document.createElement('div');
    const inner = document.createElement('div');
    outer.appendChild(scroll);
    scroll.appendChild(inner);
    document.body.appendChild(outer);

    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el === scroll) {
        return { overflowY: 'auto', overflow: 'auto' } as CSSStyleDeclaration;
      }
      return { overflowY: 'visible', overflow: 'visible' } as CSSStyleDeclaration;
    });

    expect(findScrollParent(inner)).toBe(scroll);
  });

  it('returns null when no scroll ancestor exists', () => {
    const leaf = document.createElement('div');
    document.body.appendChild(leaf);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowY: 'visible',
      overflow: 'visible',
    } as CSSStyleDeclaration);
    expect(findScrollParent(leaf)).toBeNull();
  });
});
