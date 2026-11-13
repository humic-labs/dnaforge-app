import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AISettingsBoundary } from './AISettingsBoundary';

const harness = vi.hoisted(() => ({
  initializationStatus: 'pending' as 'pending' | 'loading' | 'ready' | 'error',
  initialize: vi.fn(),
}));

vi.mock('./settings', () => ({
  useAISettingsStore: (selector: (state: typeof harness) => unknown) => selector(harness),
}));

describe('AISettingsBoundary', () => {
  beforeEach(() => {
    harness.initializationStatus = 'pending';
    harness.initialize.mockReset();
  });

  it('initializes settings when a surface mounts before desktop startup has done so', async () => {
    render(
      <AISettingsBoundary>
        <div data-testid="ready-child">Ready</div>
      </AISettingsBoundary>
    );

    await waitFor(() => expect(harness.initialize).toHaveBeenCalledTimes(1));
  });

  it('renders children after initialization is ready', () => {
    harness.initializationStatus = 'ready';
    render(
      <AISettingsBoundary>
        <div data-testid="ready-child">Ready</div>
      </AISettingsBoundary>
    );

    expect(screen.getByTestId('ready-child')).toHaveTextContent('Ready');
    expect(harness.initialize).not.toHaveBeenCalled();
  });
});
