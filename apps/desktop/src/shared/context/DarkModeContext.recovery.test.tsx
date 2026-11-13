// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { DarkModeProvider, useDarkMode, resetThemePreferenceForTests } from './DarkModeContext';
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: () => true,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => null,
  subscribeAnalyticsCaptureReady: () => () => {},
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
}));
let system = false;
let change: ((event: MediaQueryListEvent) => void) | null = null;
const originalGet = Storage.prototype.getItem;
const originalSet = Storage.prototype.setItem;
function rejectThemeStorageOnce(method: 'get' | 'set'): void {
  let pending = true;
  if (method === 'get')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string
    ) {
      if (pending && this === localStorage && key === 'waypoint-theme-mode') {
        pending = false;
        throw new Error('synthetic storage read refusal');
      }
      return originalGet.call(this, key);
    });
  else
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      if (pending && this === localStorage && key === 'waypoint-theme-mode') {
        pending = false;
        throw new Error('synthetic storage write refusal');
      }
      originalSet.call(this, key, value);
    });
}
class MediaChange extends Event implements MediaQueryListEvent {
  readonly media = '(prefers-color-scheme: dark)';
  constructor(readonly matches: boolean) {
    super('change');
  }
}
function Probe() {
  const theme = useDarkMode();
  return (
    <div>
      <output data-testid="mode">
        {theme.themeMode}:{theme.darkMode ? 'dark' : 'light'}:{theme.persistence.phase}
      </output>
      <button onClick={() => theme.setThemeMode('dark')}>Dark</button>
      <button onClick={() => theme.setThemeMode('light')}>Light</button>
      <button onClick={() => theme.setThemeMode('system')}>System</button>
      <button onClick={theme.retryPersistence}>Retry</button>
    </div>
  );
}
function mount() {
  return render(
    <DarkModeProvider>
      <Probe />
    </DarkModeProvider>
  );
}
beforeEach(() => {
  resetThemePreferenceForTests();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  system = false;
  change = null;
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return system;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      change = listener;
    },
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('theme actual document application and local storage recovery', () => {
  it('retains applied unsaved mode through provider remount, preserves durable value and retries once', () => {
    localStorage.setItem('waypoint-theme-mode', 'light');
    const view = mount();
    rejectThemeStorageOnce('set');
    fireEvent.click(screen.getByText('Dark'));
    expect(document.documentElement).toHaveClass('dark');
    expect(screen.getByTestId('mode')).toHaveTextContent('dark:dark:unsaved');
    expect(localStorage.getItem('waypoint-theme-mode')).toBe('light');
    view.unmount();
    mount();
    expect(screen.getByTestId('mode')).toHaveTextContent('dark:dark:unsaved');
    fireEvent.click(screen.getByText('Dark'));
    expect(localStorage.getItem('waypoint-theme-mode')).toBe('light');
    fireEvent.click(screen.getByText('Retry'));
    expect(localStorage.getItem('waypoint-theme-mode')).toBe('dark');
    expect(screen.getByTestId('mode')).toHaveTextContent('dark:dark:saved');
  });

  it('contains a denied storage read and permits explicit reload without a rendering crash', () => {
    localStorage.setItem('waypoint-theme-mode', 'dark');
    rejectThemeStorageOnce('get');
    mount();
    expect(screen.getByTestId('mode')).toHaveTextContent('light:light:read_failed');
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.getByTestId('mode')).toHaveTextContent('dark:dark:saved');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('keeps missing browser storage temporary, never durable, while preserving a usable root theme', () => {
    vi.stubGlobal('localStorage', undefined);
    mount();
    fireEvent.click(screen.getByText('Dark'));
    expect(screen.getByTestId('mode')).toHaveTextContent('dark:dark:temporary');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('follows system only in System mode and hydrates a fresh durable choice after a healthy remount', () => {
    const view = mount();
    fireEvent.click(screen.getByText('System'));
    act(() => {
      system = true;
      change?.(new MediaChange(true));
    });
    expect(document.documentElement).toHaveClass('dark');
    fireEvent.click(screen.getByText('Light'));
    act(() => {
      system = false;
      change?.(new MediaChange(false));
    });
    expect(document.documentElement).not.toHaveClass('dark');
    expect(screen.getByTestId('mode')).toHaveTextContent('light:light:saved');
    view.unmount();
    localStorage.setItem('waypoint-theme-mode', 'dark');
    mount();
    expect(screen.getByTestId('mode')).toHaveTextContent('dark:dark:saved');
  });

  it.each(['MacIntel', 'Win32'])(
    'routes the real %s keyboard shortcut through the same apply/save owner',
    (platform) => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
      mount();
      fireEvent.keyDown(window, {
        key: 'd',
        shiftKey: true,
        metaKey: platform === 'MacIntel',
        ctrlKey: platform !== 'MacIntel',
      });
      expect(document.documentElement).toHaveClass('dark');
      expect(localStorage.getItem('waypoint-theme-mode')).toBe('dark');
      fireEvent.keyDown(window, {
        key: 'd',
        shiftKey: true,
        metaKey: platform === 'MacIntel',
        ctrlKey: platform !== 'MacIntel',
      });
      expect(document.documentElement).not.toHaveClass('dark');
      expect(localStorage.getItem('waypoint-theme-mode')).toBe('light');
      fireEvent.keyDown(window, {
        key: 'd',
        shiftKey: false,
        metaKey: platform === 'MacIntel',
        ctrlKey: platform !== 'MacIntel',
      });
      expect(localStorage.getItem('waypoint-theme-mode')).toBe('light');
    }
  );
});
