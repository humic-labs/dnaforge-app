import { describe, expect, it } from 'vitest';
import { testWindowExceedsDisplay } from './test-window-exceeds-display';

describe('testWindowExceedsDisplay', () => {
  it.each([
    ['height exceeds display', 'test', 'linux', { width: 1280, height: 720 }, true],
    ['width exceeds display', 'test', 'linux', { width: 1000, height: 900 }, true],
    ['display fits', 'test', 'linux', { width: 1920, height: 1200 }, false],
    ['display matches', 'test', 'linux', { width: 1200, height: 800 }, false],
    ['production', 'production', 'linux', { width: 1280, height: 720 }, false],
    ['darwin', 'test', 'darwin', { width: 1280, height: 720 }, false],
  ] as const)('%s', (_name, nodeEnv, platform, display, expected) => {
    expect(
      testWindowExceedsDisplay({ NODE_ENV: nodeEnv }, platform, display, {
        width: 1200,
        height: 800,
      })
    ).toBe(expected);
  });
});
