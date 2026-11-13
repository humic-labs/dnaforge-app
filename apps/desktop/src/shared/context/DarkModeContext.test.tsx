import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DarkModeProvider, useDarkMode, resetThemePreferenceForTests } from './DarkModeContext';

const STORAGE_KEY = 'waypoint-theme-mode';

function ThemeProbe() {
  const { darkMode, themeMode, setThemeMode } = useDarkMode();
  return (
    <div>
      <output data-testid="theme-state">
        {themeMode}:{darkMode ? 'dark' : 'light'}
      </output>
      {(['system', 'light', 'dark'] as const).map((mode) => (
        <button key={mode} type="button" onClick={() => setThemeMode(mode)}>
          {mode}
        </button>
      ))}
    </div>
  );
}

describe('DarkModeProvider', () => {
  let systemDark = false;
  let systemListener: ((event: MediaQueryListEvent) => void) | null = null;

  beforeEach(() => {
    resetThemePreferenceForTests();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    systemDark = false;
    systemListener = null;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return systemDark;
        },
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addEventListener: vi.fn(
          (_event: string, listener: (event: MediaQueryListEvent) => void) => {
            systemListener = listener;
          }
        ),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('persists explicit choices and applies them to the document root', () => {
    render(
      <DarkModeProvider>
        <ThemeProbe />
      </DarkModeProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'dark' }));
    expect(screen.getByTestId('theme-state')).toHaveTextContent('dark:dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(screen.getByTestId('theme-state')).toHaveTextContent('light:light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });

  it('tracks operating-system changes while System is selected', () => {
    localStorage.setItem(STORAGE_KEY, 'system');
    render(
      <DarkModeProvider>
        <ThemeProbe />
      </DarkModeProvider>
    );

    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:light');
    expect(systemListener).not.toBeNull();

    act(() => {
      systemDark = true;
      systemListener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(screen.getByTestId('theme-state')).toHaveTextContent('system:dark');
    expect(document.documentElement).toHaveClass('dark');
  });
});
