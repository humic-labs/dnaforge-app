import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const installers = vi.hoisted(() => ({
  uninstallAbandonment: vi.fn(),
  installTelemetryAbandonmentOnExit: vi.fn(),
}));
installers.installTelemetryAbandonmentOnExit.mockImplementation(
  () => installers.uninstallAbandonment
);

vi.mock('../../../lib/analytics-operation', () => ({
  installTelemetryAbandonmentOnExit: installers.installTelemetryAbandonmentOnExit,
}));

import { journeyTelemetryRendererFeature } from './feature';

describe('journey telemetry renderer feature', () => {
  it('installs abandonment telemetry while mounted and removes it on unmount', () => {
    const Activation = journeyTelemetryRendererFeature.Activation;
    if (!Activation) throw new Error('journey telemetry needs an activation');
    const { unmount } = render(<Activation openView={() => {}} />);
    expect(installers.installTelemetryAbandonmentOnExit).toHaveBeenCalledOnce();
    unmount();
    expect(installers.uninstallAbandonment).toHaveBeenCalledOnce();
  });
});
