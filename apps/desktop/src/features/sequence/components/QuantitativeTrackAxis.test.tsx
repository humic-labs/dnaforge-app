import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildQuantitativeAxisTicks,
  QuantitativeTrackAxis,
  quantitativeAxisRangeFromDiagnostics,
} from './QuantitativeTrackAxis';

afterEach(cleanup);

describe('quantitative track y-axis', () => {
  it('uses evenly spaced raw values for a linear scale', () => {
    const ticks = buildQuantitativeAxisTicks({ min: 0, max: 100, transform: 'linear' });
    expect(ticks.map((tick) => tick.value)).toEqual([80, 60, 40, 20]);
    expect(ticks.map((tick) => tick.position)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(ticks.every((tick) => tick.position > 0 && tick.position < 1)).toBe(true);
  });

  it('uses canonical 1/2/5 values at visibly nonuniform logarithmic positions', () => {
    const ticks = buildQuantitativeAxisTicks({ min: 0, max: 99, transform: 'log1p' });
    expect(ticks.map((tick) => tick.value)).toEqual([50, 20, 10, 5, 2, 1]);
    expect(ticks.every((tick) => tick.position > 0 && tick.position < 1)).toBe(true);
    expect(ticks[0].position).toBeLessThan(1 / 6);
    expect(ticks[5].position).toBeGreaterThan(5 / 6);
  });

  it('rejects stale renderer diagnostics from a different transform', () => {
    expect(
      quantitativeAxisRangeFromDiagnostics(
        { displayMin: 0, displayMax: 99, scaleTransform: 'log1p' },
        'linear'
      )
    ).toBeNull();
  });

  it('rejects stale renderer diagnostics from a different range mode', () => {
    expect(
      quantitativeAxisRangeFromDiagnostics(
        {
          displayMin: 0,
          displayMax: 99,
          scaleTransform: 'linear',
          scaleMode: 'visible-window',
        },
        'linear',
        'full-global'
      )
    ).toBeNull();
  });

  it('renders a minimal unlabeled axis while retaining accessible scale identity', () => {
    const { rerender } = render(
      <QuantitativeTrackAxis
        trackId="signal"
        label="Signal"
        range={{ min: 0, max: 100, transform: 'linear' }}
      />
    );

    expect(screen.getByTestId('quantitative-y-axis-signal')).toHaveAttribute(
      'aria-label',
      'Linear y-axis for Signal: 0 to 100'
    );
    expect(screen.queryByText('linear')).toBeNull();
    expect(screen.getAllByTestId('quantitative-y-axis-tick')).toHaveLength(4);
    expect(screen.getByTestId('quantitative-y-axis-signal')).toHaveClass(
      'bottom-0',
      'left-0',
      'top-0'
    );
    expect(screen.getByTestId('quantitative-y-axis-spine')).toHaveClass('left-0', 'w-px');
    for (const tick of screen.getAllByTestId('quantitative-y-axis-tick')) {
      expect(tick).toHaveClass('left-0', 'h-px');
    }

    rerender(
      <QuantitativeTrackAxis
        trackId="signal"
        label="Signal"
        range={{ min: 0, max: 99, transform: 'log1p' }}
      />
    );
    expect(screen.getByTestId('quantitative-y-axis-signal')).toHaveAttribute(
      'aria-label',
      'Logarithmic y-axis for Signal: 0 to 99'
    );
    expect(screen.queryByText('log')).toBeNull();
    expect(screen.getAllByTestId('quantitative-y-axis-tick')).toHaveLength(6);
  });
});
