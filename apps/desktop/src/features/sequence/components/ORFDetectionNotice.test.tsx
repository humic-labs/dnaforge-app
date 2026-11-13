// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UseORFsResult } from '@waypoint/workspace-editor';
import { ORFDetectionNotice } from './ORFDetectionNotice';

const controls = {
  isVisible: true,
  toggleVisibility: vi.fn(),
  minLength: 100,
  setMinLength: vi.fn(),
  retry: vi.fn(),
};

describe('ORFDetectionNotice', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps pending, a valid empty result and computed results distinct', () => {
    const { rerender } = render(
      <ORFDetectionNotice
        detection={{ ...controls, status: 'pending', error: null, detectedORFs: [] }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Finding open reading frames');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(
      <ORFDetectionNotice
        detection={{ ...controls, status: 'ready-empty', error: null, detectedORFs: [] }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'No open reading frames at this minimum length.'
    );
    rerender(
      <ORFDetectionNotice
        detection={{
          ...controls,
          status: 'ready-results',
          error: null,
          detectedORFs: [{ start: 0, end: 122, frame: 1, strand: '+', length: 123 }],
        }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 open reading frame');
  });

  it.each(['failed', 'cancelled'] as const)('offers deliberate retry for %s', (status) => {
    const detection: UseORFsResult =
      status === 'failed'
        ? { ...controls, status, error: 'worker_error', detectedORFs: [] }
        : { ...controls, status, error: null, detectedORFs: [] };
    render(<ORFDetectionNotice detection={detection} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry ORF detection' }));
    expect(controls.retry).toHaveBeenCalledTimes(1);
    expect(controls.setMinLength).not.toHaveBeenCalled();
    expect(controls.toggleVisibility).not.toHaveBeenCalled();
  });

  it('does not label a hidden detector as an empty successful scan', () => {
    render(
      <ORFDetectionNotice
        detection={{ ...controls, isVisible: false, status: 'idle', error: null, detectedORFs: [] }}
      />
    );
    expect(screen.queryByTestId('orf-detection-status')).toBeNull();
  });
});
