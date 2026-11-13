import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_BLOCKED_ATTRIBUTES,
  TELEMETRY_BLOCKED_CLASS,
  TelemetryBlockedSurface,
} from './TelemetryBlockedSurface';

describe('TelemetryBlockedSurface', () => {
  it('places every PostHog replay/autocapture blocker above sensitive descendants', () => {
    render(
      <TelemetryBlockedSurface as="section" data-testid="blocked-root" className="layout-class">
        <input value="DNA1598_TYPED_SECRET" readOnly />
        <canvas data-testid="scientific-canvas" />
        <span>DNA1598_SEQUENCE_ATGCGT</span>
      </TelemetryBlockedSurface>
    );

    const root = screen.getByTestId('blocked-root');
    expect(root.tagName).toBe('SECTION');
    expect(root).toHaveClass(TELEMETRY_BLOCKED_CLASS, 'layout-class');
    expect(root).toHaveAttribute(
      'data-ph-no-capture',
      TELEMETRY_BLOCKED_ATTRIBUTES['data-ph-no-capture']
    );
    expect(root).toHaveAttribute(
      'data-analytics-block',
      TELEMETRY_BLOCKED_ATTRIBUTES['data-analytics-block']
    );
    expect(screen.getByTestId('scientific-canvas').closest('[data-analytics-block]')).toBe(root);
  });
});
