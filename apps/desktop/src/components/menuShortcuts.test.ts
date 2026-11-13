import { afterEach, describe, expect, it } from 'vitest';
import { formatShortcutHint, isApplePlatform } from './menuShortcuts';

function mockNavigatorPlatform(platform: string, userAgentDataPlatform?: string): void {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
  });
  Object.defineProperty(navigator, 'userAgentData', {
    value: userAgentDataPlatform ? { platform: userAgentDataPlatform } : undefined,
    configurable: true,
  });
}

describe('menu shortcut formatting', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: undefined,
      configurable: true,
    });
  });

  it('uses macOS menu glyphs on Apple platforms', () => {
    expect(formatShortcutHint(['shift', 'cmd', 'n'], 'MacIntel')).toBe('⌘⇧N');
    expect(formatShortcutHint(['alt', 'cmd', 'n'], 'MacIntel')).toBe('⌘⌥N');
    expect(formatShortcutHint(['shift', 'alt', 'cmd', 'c'], 'MacIntel')).toBe('⌘⌥⇧C');
    expect(formatShortcutHint(['enter'], 'MacIntel')).toBe('↩');
    expect(formatShortcutHint(['delete'], 'MacIntel')).toBe('⌫');
    expect(formatShortcutHint({ apple: ['cmd', 'delete'], standard: ['delete'] }, 'MacIntel')).toBe(
      '⌘⌫'
    );
  });

  it('uses conventional Ctrl-based labels on non-Apple platforms', () => {
    expect(formatShortcutHint(['shift', 'cmd', 'n'], 'Win32')).toBe('Ctrl+Shift+N');
    expect(formatShortcutHint(['shift', 'cmd', 'f'], 'Linux x86_64')).toBe('Ctrl+Shift+F');
    expect(formatShortcutHint(['cmd', 'k'], 'Win32')).toBe('Ctrl+K');
    expect(formatShortcutHint(['cmd', 'v'], 'Win32')).toBe('Ctrl+V');
    expect(formatShortcutHint(['shift', 'alt', 'cmd', 'c'], 'Win32')).toBe('Ctrl+Shift+Alt+C');
    expect(formatShortcutHint(['enter'], 'Win32')).toBe('Enter');
    expect(formatShortcutHint(['delete'], 'Linux x86_64')).toBe('Del');
    expect(formatShortcutHint({ apple: ['cmd', 'delete'], standard: ['delete'] }, 'Win32')).toBe(
      'Del'
    );
  });

  it('deduplicates Ctrl when a shortcut contains both semantic cmd and ctrl', () => {
    expect(formatShortcutHint(['ctrl', 'cmd', 'f'], 'Win32')).toBe('Ctrl+F');
  });

  it('detects Apple platforms from navigator-style platform names', () => {
    expect(isApplePlatform('MacIntel')).toBe(true);
    expect(isApplePlatform('iPhone')).toBe(true);
    expect(isApplePlatform('Win32')).toBe(false);
  });

  it('uses navigator.platform over userAgentData for displayed shortcut labels', () => {
    mockNavigatorPlatform('MacIntel', 'Windows');

    expect(formatShortcutHint(['cmd', 'f'])).toBe('⌘F');
  });
});
