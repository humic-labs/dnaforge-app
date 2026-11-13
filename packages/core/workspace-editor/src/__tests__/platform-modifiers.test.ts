import { describe, expect, it } from 'vitest';
import {
  hasPlatformCommandModifier,
  isAppleControlPrimaryClick,
  isApplePlatform,
} from '../platform-modifiers';

describe('platform modifier helpers', () => {
  it('uses Command as the platform command modifier on Apple platforms', () => {
    expect(isApplePlatform('MacIntel')).toBe(true);
    expect(hasPlatformCommandModifier({ metaKey: true, ctrlKey: false }, 'MacIntel')).toBe(true);
    expect(hasPlatformCommandModifier({ metaKey: false, ctrlKey: true }, 'MacIntel')).toBe(false);
  });

  it('uses Ctrl as the platform command modifier on Windows/Linux platforms', () => {
    expect(isApplePlatform('Win32')).toBe(false);
    expect(hasPlatformCommandModifier({ metaKey: false, ctrlKey: true }, 'Win32')).toBe(true);
    expect(hasPlatformCommandModifier({ metaKey: true, ctrlKey: false }, 'Win32')).toBe(false);
  });

  it('only treats Ctrl+primary click as a secondary click on Apple platforms', () => {
    expect(isAppleControlPrimaryClick({ button: 0, ctrlKey: true }, 'MacIntel')).toBe(true);
    expect(isAppleControlPrimaryClick({ button: 0, ctrlKey: true }, 'Win32')).toBe(false);
    expect(isAppleControlPrimaryClick({ button: 2, ctrlKey: false }, 'MacIntel')).toBe(false);
  });
});
