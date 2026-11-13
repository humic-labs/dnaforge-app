import { describe, it, expect } from 'vitest';
import {
  isApplePlatform,
  formatShortcut,
  formatShortcutParts,
  matchesShortcut,
  hasCommandModifier,
  hasPlatformCommandModifier,
  isAppleControlPrimaryClick,
} from './shortcuts';

const MAC = 'MacIntel';
const WIN = 'Win32';

function key(
  overrides: Partial<KeyboardEvent>
): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> {
  return {
    key: overrides.key ?? '',
    metaKey: overrides.metaKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
  };
}

describe('isApplePlatform', () => {
  it.each(['MacIntel', 'iPhone', 'iPad', 'MacARM'])('%s → Apple', (p) => {
    expect(isApplePlatform(p)).toBe(true);
  });
  it.each(['Win32', 'Linux x86_64', ''])('%s → not Apple', (p) => {
    expect(isApplePlatform(p)).toBe(false);
  });
});

describe('formatShortcut — OS-sensitive DISPLAY', () => {
  it('cmd+c renders ⌘C on Apple, Ctrl+C on Windows/Linux', () => {
    expect(formatShortcut(['cmd', 'c'], MAC)).toBe('⌘C');
    expect(formatShortcut(['cmd', 'c'], WIN)).toBe('Ctrl+C');
  });

  it('cmd+shift+c is a joined symbol run on Apple, +-separated elsewhere', () => {
    expect(formatShortcut(['cmd', 'shift', 'c'], MAC)).toBe('⌘⇧C');
    expect(formatShortcut(['cmd', 'shift', 'c'], WIN)).toBe('Ctrl+Shift+C');
  });

  it('cmd+s → ⌘S / Ctrl+S', () => {
    expect(formatShortcut(['cmd', 's'], MAC)).toBe('⌘S');
    expect(formatShortcut(['cmd', 's'], WIN)).toBe('Ctrl+S');
  });

  it('explicit apple/standard chords resolve per platform', () => {
    const def = { apple: ['cmd', 'alt', 'c'] as const, standard: ['ctrl', 'c'] as const };
    expect(formatShortcut(def, MAC)).toBe('⌘⌥C');
    expect(formatShortcut(def, WIN)).toBe('Ctrl+C');
  });

  it('undefined in → undefined out', () => {
    expect(formatShortcut(undefined, MAC)).toBeUndefined();
  });

  it('handles digits and punctuation as-is (⌘⇧8, ⌘⇧.)', () => {
    expect(formatShortcut(['cmd', 'shift', '8'], MAC)).toBe('⌘⇧8');
    expect(formatShortcut(['cmd', 'shift', '8'], WIN)).toBe('Ctrl+Shift+8');
    expect(formatShortcut(['cmd', 'shift', '.'], MAC)).toBe('⌘⇧.');
    expect(formatShortcut(['cmd', ','], MAC)).toBe('⌘,');
  });

  it('uses macOS glyphs / standard words for named keys (arrows, enter)', () => {
    expect(formatShortcut(['cmd', 'arrowleft'], MAC)).toBe('⌘←');
    expect(formatShortcut(['cmd', 'arrowleft'], WIN)).toBe('Ctrl+←');
    expect(formatShortcut(['cmd', 'enter'], MAC)).toBe('⌘↩');
    expect(formatShortcut(['cmd', 'enter'], WIN)).toBe('Ctrl+Enter');
  });

  it('reads Command, then Option, then Shift, then Control', () => {
    expect(formatShortcut(['cmd', 'alt', 'shift', 'ctrl', 'k'], MAC)).toBe('⌘⌥⇧⌃K');
  });

  it('splits a chord into one label per key', () => {
    expect(formatShortcutParts(['cmd', 'shift', 'c'], MAC)).toEqual(['⌘', '⇧', 'C']);
    expect(formatShortcutParts(['cmd', 'shift', 'c'], WIN)).toEqual(['Ctrl', 'Shift', 'C']);
    expect(formatShortcutParts(undefined, MAC)).toBeUndefined();
  });
});

describe('hasCommandModifier — ⌘ on Apple ↔ Ctrl elsewhere', () => {
  it('macOS: metaKey satisfies, ctrlKey does NOT', () => {
    expect(hasCommandModifier(key({ metaKey: true }), MAC)).toBe(true);
    expect(hasCommandModifier(key({ ctrlKey: true }), MAC)).toBe(false);
  });
  it('Windows/Linux: ctrlKey satisfies, metaKey does NOT', () => {
    expect(hasCommandModifier(key({ ctrlKey: true }), WIN)).toBe(true);
    expect(hasCommandModifier(key({ metaKey: true }), WIN)).toBe(false);
  });
});

describe('matchesShortcut — OS-sensitive MATCHING', () => {
  it('cmd+c matches ⌘C on macOS and Ctrl+C on Windows — and NOT the wrong modifier', () => {
    expect(matchesShortcut(key({ key: 'c', metaKey: true }), ['cmd', 'c'], MAC)).toBe(true);
    expect(matchesShortcut(key({ key: 'c', ctrlKey: true }), ['cmd', 'c'], MAC)).toBe(false);

    expect(matchesShortcut(key({ key: 'c', ctrlKey: true }), ['cmd', 'c'], WIN)).toBe(true);
    expect(matchesShortcut(key({ key: 'c', metaKey: true }), ['cmd', 'c'], WIN)).toBe(false);
  });

  it('a chord without shift does NOT fire when Shift is held', () => {
    expect(
      matchesShortcut(key({ key: 'c', metaKey: true, shiftKey: true }), ['cmd', 'c'], MAC)
    ).toBe(false);
    expect(
      matchesShortcut(key({ key: 'c', metaKey: true, shiftKey: true }), ['cmd', 'shift', 'c'], MAC)
    ).toBe(true);
  });

  it('the non-modifier key must match', () => {
    expect(matchesShortcut(key({ key: 'x', metaKey: true }), ['cmd', 'c'], MAC)).toBe(false);
    expect(matchesShortcut(key({ key: 's', metaKey: true }), ['cmd', 's'], MAC)).toBe(true);
  });

  it('is case-insensitive on the key (Shift can uppercase event.key)', () => {
    expect(matchesShortcut(key({ key: 'C', metaKey: true }), ['cmd', 'c'], MAC)).toBe(true);
  });

  it('rejects an EXTRA command-tier modifier (exactness on the command tier too)', () => {
    expect(
      matchesShortcut(key({ key: 'c', metaKey: true, ctrlKey: true }), ['cmd', 'c'], MAC)
    ).toBe(false);
    expect(
      matchesShortcut(key({ key: 'c', ctrlKey: true, metaKey: true }), ['cmd', 'c'], WIN)
    ).toBe(false);
  });

  it('literal ctrl on Apple requires Control WITHOUT Command', () => {
    expect(matchesShortcut(key({ key: 'c', ctrlKey: true }), ['ctrl', 'c'], MAC)).toBe(true);
    expect(
      matchesShortcut(key({ key: 'c', ctrlKey: true, metaKey: true }), ['ctrl', 'c'], MAC)
    ).toBe(false);
  });
});

describe('hasPlatformCommandModifier — pointer/loose-typed sibling', () => {
  it('resolves ⌘ on Apple ↔ Ctrl elsewhere, tolerating missing fields', () => {
    expect(hasPlatformCommandModifier({ metaKey: true }, MAC)).toBe(true);
    expect(hasPlatformCommandModifier({ ctrlKey: true }, MAC)).toBe(false);
    expect(hasPlatformCommandModifier({ ctrlKey: true }, WIN)).toBe(true);
    expect(hasPlatformCommandModifier({ metaKey: true }, WIN)).toBe(false);
    expect(hasPlatformCommandModifier({}, MAC)).toBe(false);
  });
});

describe('isAppleControlPrimaryClick — macOS Control-click gesture', () => {
  it('fires only for primary button + Control on Apple', () => {
    expect(isAppleControlPrimaryClick({ button: 0, ctrlKey: true }, MAC)).toBe(true);
    expect(isAppleControlPrimaryClick({ button: 0, ctrlKey: true }, WIN)).toBe(false);
    expect(isAppleControlPrimaryClick({ button: 2, ctrlKey: true }, MAC)).toBe(false);
    expect(isAppleControlPrimaryClick({ button: 0, ctrlKey: false }, MAC)).toBe(false);
  });
});
