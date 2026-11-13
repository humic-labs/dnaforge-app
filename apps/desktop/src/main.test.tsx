import { describe, it, expect } from 'vitest';
import { shouldEnableTestBridge } from './lib/test-bridge-gate';

describe('shouldEnableTestBridge —  prod gate', () => {
  it('enables in dev builds (electron-vite dev)', () => {
    expect(shouldEnableTestBridge({ DEV: true, MODE: 'development' })).toBe(true);
  });

  it('enables in test-mode builds (electron-vite build --mode test)', () => {
    expect(shouldEnableTestBridge({ DEV: false, MODE: 'test' })).toBe(true);
  });

  it('disables in production / packaged builds', () => {
    expect(shouldEnableTestBridge({ DEV: false, MODE: 'production' })).toBe(false);
  });

  it('disables when env is empty (defensive default)', () => {
    expect(shouldEnableTestBridge({})).toBe(false);
  });

  it('disables when only DEV is unexpectedly truthy-but-not-true', () => {
    expect(shouldEnableTestBridge({ DEV: undefined, MODE: 'production' })).toBe(false);
  });
});
