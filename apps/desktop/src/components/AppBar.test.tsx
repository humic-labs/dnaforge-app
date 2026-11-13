import { render, screen, act, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';

const mockOnHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockRestartSidecar = vi.fn(() => Promise.resolve('restarting'));
const mockPlatform = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!mockOnHandlers[event]) mockOnHandlers[event] = [];
    mockOnHandlers[event].push(handler);
    return () => {
      mockOnHandlers[event] = mockOnHandlers[event].filter((h) => h !== handler);
    };
  }),
  config: {
    getSidecarStatus: vi.fn(() => Promise.resolve('')),
    restartSidecar: mockRestartSidecar,
  },
  runtime: {
    getProvenance: vi.fn(() =>
      Promise.resolve({
        kind: 'electron-main',
        isReleaseBuild: true,
        userDataPath: '/tmp/DNAForge',
      })
    ),
  },
  window: {
    showMenu: vi.fn(async () => {}),
    setTitleBarTheme: vi.fn(async () => {}),
  },
};

vi.mock('../platform', () => ({
  platform: vi.fn(() => mockPlatform),
}));

vi.mock('./FeedbackWidget', () => ({
  FeedbackWidget: ({ appVersion }: { appVersion: string }) => (
    <button type="button" data-testid="feedback-widget">
      Feedback {appVersion}
    </button>
  ),
}));

import { AppBar } from './AppBar';

function mockNavigatorPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

function renderAppBar(props: Partial<ComponentProps<typeof AppBar>> = {}) {
  return render(<AppBar appVersion="1.0.0" {...props} />);
}

function emitSidecarStatus(status: string) {
  const handlers = mockOnHandlers['sidecar:status'] ?? [];
  handlers.forEach((h) => h(status));
}

describe('AppBar', () => {
  beforeEach(() => {
    Object.keys(mockOnHandlers).forEach((k) => delete mockOnHandlers[k]);
    vi.clearAllMocks();
    mockNavigatorPlatform('MacIntel');
  });

  it('does NOT show the sidecar spinner on initial mount', () => {
    renderAppBar();

    expect(screen.queryByText('Starting analysis engine...')).toBeNull();
  });

  it('persistently marks a non-release Electron profile', async () => {
    mockPlatform.runtime.getProvenance.mockResolvedValueOnce({
      kind: 'electron-main',
      isReleaseBuild: false,
      userDataPath: '/tmp/DNAForge-dev',
    });

    renderAppBar();

    await waitFor(() => {
      const badge = screen.getByTestId('appbar-non-release-profile');
      expect(badge).toHaveTextContent('dev');
      expect(badge).toHaveAttribute('title', expect.stringContaining('Dev profile (isolated DB).'));
    });
  });

  it('does not mark an official release profile', async () => {
    renderAppBar();

    await waitFor(() => {
      expect(mockPlatform.runtime.getProvenance).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('appbar-non-release-profile')).not.toBeInTheDocument();
  });

  it('shows and hides the sidecar spinner from sidecar:status events', () => {
    renderAppBar();

    act(() => {
      emitSidecarStatus('starting');
    });
    expect(screen.getByText('Starting analysis engine...')).toBeTruthy();

    act(() => {
      emitSidecarStatus('ready');
    });
    expect(screen.queryByText('Starting analysis engine...')).toBeNull();
  });

  it('shows a restart control when the sidecar fails and calls main-process restart', async () => {
    renderAppBar();

    act(() => {
      emitSidecarStatus('error');
    });

    expect(screen.getByTestId('appbar-sidecar-offline')).toHaveTextContent(
      'Analysis engine offline'
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    });

    expect(mockRestartSidecar).toHaveBeenCalledTimes(1);
  });

  it('right-aligns the Ask AI launcher immediately before feedback', () => {
    renderAppBar();
    const controls = screen.getByTestId('appbar-right-controls');
    expect(within(controls).queryByTestId('appbar-ai-entry')).not.toBeInTheDocument();
    expect(within(controls).getByTestId('feedback-widget')).toBeInTheDocument();
  });

  it('uses Ctrl+/ for the Ask AI shortcut hint on Windows', () => {
    mockNavigatorPlatform('Win32');
    renderAppBar();
    expect(screen.queryByTestId('appbar-ask-ai-button')).not.toBeInTheDocument();
  });

  it('uses the AppBar Ask AI control as a launcher instead of a prompt or route picker', () => {
    renderAppBar();
    expect(screen.queryByTestId('appbar-ask-ai-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appbar-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appbar-assistant-route-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appbar-assistant-route-menu')).not.toBeInTheDocument();
  });

  it('does not duplicate project identity or project management in global chrome', () => {
    renderAppBar();

    expect(screen.queryByTestId('appbar-project-switcher')).not.toBeInTheDocument();
    expect(screen.queryByText(/projects?$/i)).not.toBeInTheDocument();
  });

  it('shows the Windows menus in place of branding and synchronizes caption theme', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { platform: 'win32' },
    });
    try {
      renderAppBar();
      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
        'File',
        'Edit',
        'View',
        'Help',
        'Options',
      ]);
      expect(screen.queryByLabelText('DNAForge')).toBeNull();
      expect(screen.getByTestId('application-top-bar')).toHaveClass('windows-title-bar');
      expect(screen.queryByTestId('appbar-ask-ai-button')).not.toBeInTheDocument();
      await waitFor(() => expect(mockPlatform.window.setTitleBarTheme).toHaveBeenCalledWith(false));
    } finally {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });
});
