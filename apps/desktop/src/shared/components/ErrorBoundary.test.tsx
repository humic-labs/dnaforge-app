import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { sanitizeClosedBetaProperties } from '../analytics-allowlist';

const { trackRendererEventMock } = vi.hoisted(() => ({ trackRendererEventMock: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ trackRendererEvent: trackRendererEventMock }));

const Boom = (): ReactElement => {
  throw new Error('boom-from-render');
};

const TypedBoom = (): ReactElement => {
  const err = new Error('typed');
  err.name = 'RangeError';
  throw err;
};

async function emittedProps(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(trackRendererEventMock).toHaveBeenCalled(), { timeout: 5000 });
  const call = trackRendererEventMock.mock.calls.find((c) => c[0] === 'error_boundary_triggered');
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

describe('ErrorBoundary —  auto-telemetry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the fallback AND emits a class that SURVIVES the real sanitizer', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    const props = await emittedProps();
    expect(props).toMatchObject({ feature_area: 'reliability', error_class: 'error' });
    const sanitized = sanitizeClosedBetaProperties(props, {}) as Record<string, unknown>;
    expect(sanitized.error_class).toBe('error');
    consoleSpy.mockRestore();
  });

  it('also fires the consent-free phone-home signal so opted-out users still report', async () => {
    const reportRendererError = vi.fn();
    (window as unknown as { electronAPI?: unknown }).electronAPI = { reportRendererError };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    await waitFor(() =>
      expect(reportRendererError).toHaveBeenCalledWith({ errorClass: 'Error', source: 'error' })
    );
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    consoleSpy.mockRestore();
  });

  it('normalizes a PascalCase error name to snake_case (RangeError -> range_error)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <TypedBoom />
      </ErrorBoundary>
    );

    const props = await emittedProps();
    expect(props.error_class).toBe('range_error');
    const sanitized = sanitizeClosedBetaProperties(props, {}) as Record<string, unknown>;
    expect(sanitized.error_class).toBe('range_error');
    expect(JSON.stringify(trackRendererEventMock.mock.calls)).not.toContain('typed');
    consoleSpy.mockRestore();
  });
});
