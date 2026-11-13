import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusWindowUnlessBackground } from './background-window-mode';

beforeEach(() => {
  vi.stubEnv('DNAFORGE_FOREGROUND_WINDOW', '1');
  vi.stubEnv('DNAFORGE_BACKGROUND_WINDOW', '0');
});
afterEach(() => vi.unstubAllEnvs());

describe('explicit user window activation', () => {
  it('reveals a hidden window before focusing an explicit user open request', () => {
    const calls: string[] = [];
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => false,
      restore: vi.fn(),
      show: () => {
        calls.push('show');
      },
      focus: () => {
        calls.push('focus');
      },
    };
    focusWindowUnlessBackground(window);
    expect(calls).toEqual(['show', 'focus']);
  });

  it('does not re-show an already visible window for an explicit request', () => {
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    focusWindowUnlessBackground(window);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
