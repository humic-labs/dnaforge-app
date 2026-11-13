// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { WindowZoomResult } from '../shared/window-zoom';
import { installAnalyticsFirehose } from '../lib/analytics-firehose';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
const ports = vi.hoisted(() => ({
  desktopRuntime: true,
  read: vi.fn<(key: string) => Promise<string | null>>(),
  write: vi.fn<(key: string, value: string) => Promise<void>>(),
  apply: vi.fn<(factor: number) => Promise<WindowZoomResult>>(),
  capture: vi.fn<(event: string, properties: Record<string, unknown>) => boolean>(() => true),
}));
vi.mock('../db', () => ({ getSetting: ports.read, setSetting: ports.write }));
vi.mock('../platform', () => ({ platform: () => ({ window: { setZoomLevel: ports.apply } }) }));
vi.mock('../utils/environment', () => ({
  isBrowserOnly: () => !ports.desktopRuntime,
  isDesktopRuntime: () => ports.desktopRuntime,
}));
vi.mock('../lib/analytics', () => ({
  trackRendererEvent: ports.capture,
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
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const originalStorageSet = Storage.prototype.setItem;
function rejectLocalWriteOnce(targetKey: string): void {
  let pending = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string
  ) {
    if (pending && this === localStorage && key === targetKey) {
      pending = false;
      throw new Error('quota sentinel');
    }
    originalStorageSet.call(this, key, value);
  });
}
async function mount() {
  const { AppearanceSection } = await import('./AppearanceSettingsSection');
  const { DarkModeProvider } = await import('../shared/context/DarkModeContext');
  return render(
    <DarkModeProvider>
      <AppearanceSection />
    </DarkModeProvider>
  );
}
function choose(name: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}
beforeEach(() => {
  ports.desktopRuntime = true;
  vi.resetModules();
  localStorage.clear();
  ports.capture.mockReset().mockReturnValue(true);
  ports.read.mockReset().mockImplementation(async (key) => (key === 'display_zoom' ? '1' : 'auto'));
  ports.write.mockReset().mockResolvedValue(undefined);
  ports.apply.mockReset().mockImplementation(async (factor) => ({ status: 'applied', factor }));
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: () => {},
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
  document.documentElement.classList.remove('dark');
});
describe('real appearance section, controls and owners', () => {
  it('shows actual applied-but-unsaved display selection through close/reopen and deliberate Retry', async () => {
    let actual = 1;
    ports.apply.mockImplementation(async (factor) => {
      actual = factor;
      return { status: 'applied', factor };
    });
    const view = await mount();
    const zoom = await import('../lib/applyZoomLevel');
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('saved'));
    ports.write.mockRejectedValueOnce(new Error('private storage sentinel'));
    choose('Display Scale', '125%');
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('unsaved'));
    expect(screen.getByTestId('appearance-display-status')).toHaveTextContent('Could not save');
    expect(actual).toBe(1.25);
    expect(screen.getByRole('combobox', { name: 'Display Scale' })).toHaveTextContent('125%');
    expect(screen.queryByText(/private storage sentinel/)).not.toBeInTheDocument();
    view.unmount();
    await mount();
    expect(screen.getByRole('combobox', { name: 'Display Scale' })).toHaveTextContent('125%');
    fireEvent.click(screen.getByRole('button', { name: 'Retry display' }));
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('saved'));
    expect(actual).toBe(1.25);
    expect(ports.write.mock.calls.filter(([key]) => key === 'display_zoom')).toEqual([
      ['display_zoom', '1.25'],
      ['display_zoom', '1.25'],
    ]);
  });

  it('shows desired B and last confirmed A when held native A acknowledges after B intent and B application refuses', async () => {
    let actual = 1;
    ports.apply.mockImplementation(async (factor) => {
      actual = factor;
      return { status: 'applied', factor };
    });
    await mount();
    const zoom = await import('../lib/applyZoomLevel');
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('saved'));
    expect(screen.queryByTestId('appearance-display-readback')).not.toBeInTheDocument();
    const a = held<WindowZoomResult>();
    ports.apply
      .mockImplementationOnce((factor) => {
        actual = factor;
        return a.promise;
      })
      .mockResolvedValueOnce({ status: 'refused', reason: 'window_unavailable' });
    choose('Display Scale', '125%');
    await waitFor(() => expect(ports.apply).toHaveBeenLastCalledWith(1.25));
    expect(actual).toBe(1.25);
    choose('Display Scale', '150%');
    expect(screen.getByRole('combobox', { name: 'Display Scale' })).toHaveTextContent('150%');
    await act(async () => {
      a.resolve({ status: 'applied', factor: 1.25 });
    });
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('apply_failed'));
    expect(actual).toBe(1.25);
    expect(screen.getByRole('combobox', { name: 'Display Scale' })).toHaveTextContent('150%');
    expect(screen.getByTestId('appearance-display-readback')).toHaveTextContent(
      'Requested scale: 150%.'
    );
    expect(screen.getByTestId('appearance-display-readback')).toHaveTextContent(
      'Last confirmed scale: 125%.'
    );
    expect(screen.getByRole('button', { name: 'Retry display' })).toBeInTheDocument();
    expect(ports.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry display' }));
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('saved'));
    expect(actual).toBe(1.5);
    expect(ports.write).toHaveBeenCalledWith('display_zoom', '1.5');
    expect(screen.getByRole('combobox', { name: 'Display Scale' })).toHaveTextContent('150%');
    expect(screen.queryByTestId('appearance-display-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appearance-display-readback')).not.toBeInTheDocument();
    const payloads = JSON.stringify(ports.capture.mock.calls);
    expect(payloads).not.toContain('150%');
    expect(payloads).not.toContain('125%');
  });

  it('shows an unconfirmed current scale when native application has never acknowledged a factor', async () => {
    ports.apply.mockResolvedValue({ status: 'refused', reason: 'window_unavailable' });
    await mount();
    const zoom = await import('../lib/applyZoomLevel');
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('apply_failed'));
    expect(screen.getByTestId('appearance-display-readback')).toHaveTextContent(
      'Requested scale: 100%.'
    );
    expect(screen.getByTestId('appearance-display-readback')).toHaveTextContent(
      'Current scale is unconfirmed.'
    );
    expect(screen.getByTestId('appearance-display-readback')).not.toHaveTextContent(
      'Last confirmed scale:'
    );
    expect(screen.getByRole('button', { name: 'Retry display' })).toBeInTheDocument();
    expect(ports.write).not.toHaveBeenCalled();
  });

  it('protects real selections and downstream WebGL policy from two held old hydration responses', async () => {
    const display = held<string | null>();
    const webgl = held<string | null>();
    ports.read.mockImplementation((key) =>
      key === 'display_zoom' ? display.promise : webgl.promise
    );
    await mount();
    const zoom = await import('../lib/applyZoomLevel');
    const policy = await import('../features/sequence/webgl-performance-preference');
    choose('Display Scale', '125%');
    choose('WebGL Performance', 'Quality');
    await waitFor(() => expect(policy.useWebGLPreferenceStore.getState().phase).toBe('saved'));
    await act(async () => {
      display.resolve('2');
      webgl.resolve('auto');
    });
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('saved'));
    expect(screen.getByRole('combobox', { name: 'Display Scale' })).toHaveTextContent('125%');
    expect(screen.getByRole('combobox', { name: 'WebGL Performance' })).toHaveTextContent(
      'Quality'
    );
    expect(policy.useWebGLPreferenceStore.getState().value).toBe('quality');
    expect(ports.apply.mock.calls).toEqual([[1.25]]);
  });

  it('does not count menu/focus/unchanged commits as accepted changes and preserves disabled Reduced Motion', async () => {
    await mount();
    const zoom = await import('../lib/applyZoomLevel');
    await waitFor(() => expect(zoom.useDisplayZoomStore.getState().phase).toBe('saved'));
    ports.capture.mockClear();
    const select = screen.getByRole('combobox', { name: 'WebGL Performance' });
    fireEvent.focus(select);
    fireEvent.keyDown(select, { key: ' ' });
    expect(screen.getByRole('listbox', { name: 'WebGL Performance' })).toBeInTheDocument();
    fireEvent.keyDown(select, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('theme-toggle-light'));
    fireEvent.click(screen.getByTestId('assembly-color-scheme-tailwind'));
    expect(
      ports.capture.mock.calls.filter(([, p]) => p.outcome_kind === 'preference_accepted')
    ).toHaveLength(0);
    expect(ports.write).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: 'Reduced Motion' })).toBeDisabled();
    fireEvent.keyDown(select, { key: ' ' });
    fireEvent.keyDown(select, { key: 'ArrowDown' });
    fireEvent.keyDown(select, { key: 'Enter' });
    await waitFor(() =>
      expect(ports.write).toHaveBeenCalledWith('sequence_webgl_performance_preference', 'quality')
    );
    expect(
      ports.capture.mock.calls.filter(([, p]) => p.outcome_kind === 'preference_accepted')
    ).toHaveLength(1);
  });

  it('offers honest theme/palette storage recovery through the actual controls and captures no choice payload', async () => {
    ports.desktopRuntime = false;
    await act(async () => {
      await mount();
    });
    rejectLocalWriteOnce('waypoint-theme-mode');
    fireEvent.click(screen.getByTestId('theme-toggle-dark'));
    await waitFor(() =>
      expect(screen.getByTestId('appearance-theme-status')).toHaveTextContent('Could not save')
    );
    expect(document.documentElement).toHaveClass('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Retry theme' }));
    await waitFor(() =>
      expect(screen.queryByTestId('appearance-theme-status')).not.toBeInTheDocument()
    );
    rejectLocalWriteOnce('waypoint-assembly-color-scheme');
    fireEvent.click(screen.getByTestId('assembly-color-scheme-carbon'));
    await waitFor(() =>
      expect(screen.getByTestId('appearance-palette-status')).toHaveTextContent('Could not save')
    );
    expect(screen.getByTestId('assembly-color-scheme-carbon')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry palette' }));
    await waitFor(() =>
      expect(screen.queryByTestId('appearance-palette-status')).not.toBeInTheDocument()
    );
    for (const [, properties] of ports.capture.mock.calls) {
      for (const forbidden of [
        'value',
        'choice',
        'key',
        'storage_key',
        'preference_value',
        'selected_value',
      ])
        expect(properties).not.toHaveProperty(forbidden);
      expect(JSON.stringify(properties)).not.toContain('quota sentinel');
    }
  });

  it('keeps valid custom native factors visible and private selector options marked in their real portal', async () => {
    ports.read.mockImplementation(async (key) => (key === 'display_zoom' ? '1.2' : 'auto'));
    await mount();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Display Scale' })).toHaveTextContent('120%')
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'WebGL Performance' }));
    const menu = screen.getByRole('listbox', { name: 'WebGL Performance' });
    expect(menu).toHaveClass('ph-no-capture', 'rr-block');
    expect(menu).toHaveAttribute('data-analytics-block');
    expect(menu).toHaveAttribute('data-ph-mask');
    expect(
      sanitizeSdkEvent(
        {
          event: '$autocapture',
          properties: {
            $elements: [
              { tag_name: 'button', attr__data_value: 'quality' },
              { tag_name: 'div', attr__data_ph_no_capture: 'true' },
            ],
          },
        },
        'desktop'
      )
    ).toBeNull();
  });

  it('excludes appearance choices through actual authored ingress on the coherent F27 candidate', async () => {
    await mount();
    fireEvent.click(screen.getByRole('combobox', { name: 'WebGL Performance' }));
    const capture = vi.fn();
    const dispose = installAnalyticsFirehose({ capture, isEnabled: () => true });
    try {
      fireEvent.click(screen.getByRole('option', { name: 'Quality' }));
      fireEvent.click(screen.getByTestId('theme-toggle-dark'));
      const text = JSON.stringify(capture.mock.calls);
      expect(text).not.toContain('Quality');
      expect(text).not.toContain('quality');
      expect(text).not.toContain('theme-toggle-dark');
    } finally {
      dispose();
    }
  });
});
