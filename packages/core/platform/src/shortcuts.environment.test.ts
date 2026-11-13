import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatShortcut,
  hasCommandModifier,
  hasPlatformCommandModifier,
  isAppleControlPrimaryClick,
  isApplePlatform,
} from './shortcuts';

const NODE_22_NAVIGATOR_ON_MAC = {
  platform: 'MacIntel',
  userAgent: 'Node.js/22',
  language: 'en-US',
  languages: ['en-US'],
  hardwareConcurrency: 8,
};

const NODE_22_NAVIGATOR_ON_LINUX = { ...NODE_22_NAVIGATOR_ON_MAC, platform: 'Linux x86_64' };

const BROWSER_NAVIGATOR_JSDOM = {
  platform: '',
  onLine: true,
  userAgent: 'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/24.1.3',
};

const A_DOCUMENT = { nodeType: 9 };

function withGlobals(globals: { navigator?: unknown; document?: unknown }): void {
  vi.stubGlobal('navigator', globals.navigator);
  vi.stubGlobal('document', globals.document);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isApplePlatform() with no argument', () => {
  it('no navigator and no document (Node 20 anywhere, Electron main) → not Apple', () => {
    withGlobals({});
    expect(isApplePlatform()).toBe(false);
  });

  it('🟥 a Node 22 navigator without a document is not a browser, even on a Mac', () => {
    withGlobals({ navigator: NODE_22_NAVIGATOR_ON_MAC });
    expect(isApplePlatform()).toBe(false);
  });

  it('…and Node 22 on Linux answers identically, so no branch depends on the machine', () => {
    withGlobals({ navigator: NODE_22_NAVIGATOR_ON_LINUX });
    expect(isApplePlatform()).toBe(false);
  });

  it('a real browser on a Mac is Apple, exactly as before', () => {
    withGlobals({ navigator: { platform: 'MacIntel', onLine: true }, document: A_DOCUMENT });
    expect(isApplePlatform()).toBe(true);
  });

  it('a real browser on Windows is not Apple, exactly as before', () => {
    withGlobals({ navigator: { platform: 'Win32', onLine: true }, document: A_DOCUMENT });
    expect(isApplePlatform()).toBe(false);
  });

  it("jsdom's own navigator reports an empty platform → not Apple, exactly as before", () => {
    withGlobals({ navigator: BROWSER_NAVIGATOR_JSDOM, document: A_DOCUMENT });
    expect(isApplePlatform()).toBe(false);
  });

  it('falls back to userAgentData.platform when platform is an empty string', () => {
    withGlobals({
      navigator: { platform: '', userAgentData: { platform: 'macOS' } },
      document: A_DOCUMENT,
    });
    expect(isApplePlatform()).toBe(true);
  });

  it('ignores a reading that is not a usable string instead of trusting it', () => {
    withGlobals({
      navigator: { platform: 42, userAgentData: { platform: null } },
      document: A_DOCUMENT,
    });
    expect(isApplePlatform()).toBe(false);
  });

  it('an explicit platform argument is unaffected by the environment', () => {
    withGlobals({});
    expect(isApplePlatform('MacIntel')).toBe(true);
    expect(isApplePlatform('Win32')).toBe(false);

    withGlobals({ navigator: NODE_22_NAVIGATOR_ON_MAC });
    expect(isApplePlatform('Win32')).toBe(false);
    expect(isApplePlatform('iPhone')).toBe(true);
  });
});

describe('every no-argument entry point inherits that one answer', () => {
  const COPY = ['cmd', 'c'] as const;

  it('answers the Windows/Linux way when no browser is present, Node 22 included', () => {
    withGlobals({ navigator: NODE_22_NAVIGATOR_ON_MAC });
    expect(formatShortcut(COPY)).toBe('Ctrl+C');
    expect(hasCommandModifier({ metaKey: true, ctrlKey: false })).toBe(false);
    expect(hasCommandModifier({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(hasPlatformCommandModifier({ metaKey: true })).toBe(false);
    expect(isAppleControlPrimaryClick({ button: 0, ctrlKey: true })).toBe(false);
  });

  it('answers the Apple way in a real browser on a Mac', () => {
    withGlobals({ navigator: { platform: 'MacIntel' }, document: A_DOCUMENT });
    expect(formatShortcut(COPY)).toBe('⌘C');
    expect(hasCommandModifier({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(hasCommandModifier({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(hasPlatformCommandModifier({ metaKey: true })).toBe(true);
    expect(isAppleControlPrimaryClick({ button: 0, ctrlKey: true })).toBe(true);
  });
});

describe('the ambient environment this suite runs in', () => {
  it('is not a browser, so the real answer cannot depend on the host OS', () => {
    expect(typeof document).toBe('undefined');
    expect(isApplePlatform()).toBe(false);
  });
});
