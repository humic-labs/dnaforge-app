import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({
  enabled: true,
  flagsReadyCb: null as null | (() => void),
}));

vi.mock('../../lib/analytics', () => ({
  isWorkspaceCloudSyncFeatureEnabled: () => h.enabled,
  onFeatureFlagsReady: (cb: () => void) => {
    h.flagsReadyCb = cb;
    return () => {
      h.flagsReadyCb = null;
    };
  },
}));

import { useWorkspaceCloudSyncEnabled } from './useWorkspaceCloudSyncEnabled';

function Probe() {
  const enabled = useWorkspaceCloudSyncEnabled();
  return <span data-testid="enabled">{String(enabled)}</span>;
}

beforeEach(() => {
  cleanup();
  h.enabled = true;
  h.flagsReadyCb = null;
});

describe('useWorkspaceCloudSyncEnabled', () => {
  it('reflects the analytics flag helper on mount', () => {
    h.enabled = true;
    render(<Probe />);
    expect(screen.getByTestId('enabled').textContent).toBe('true');
  });

  it('reflects a disabled flag', () => {
    h.enabled = false;
    render(<Probe />);
    expect(screen.getByTestId('enabled').textContent).toBe('false');
  });

  it('re-evaluates when PostHog flags become ready', () => {
    h.enabled = false;
    render(<Probe />);
    expect(screen.getByTestId('enabled').textContent).toBe('false');

    h.enabled = true;
    act(() => {
      h.flagsReadyCb?.();
    });
    expect(screen.getByTestId('enabled').textContent).toBe('true');
  });
});
