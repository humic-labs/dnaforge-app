import { useEffect } from 'react';
import type { RendererFeature } from '../../../feature-registry/renderer-feature';
import { installTelemetryAbandonmentOnExit } from '../../../lib/analytics-operation';

function JourneyTelemetryActivation() {
  useEffect(() => {
    return installTelemetryAbandonmentOnExit();
  }, []);
  return null;
}

export const journeyTelemetryRendererFeature: RendererFeature = {
  id: 'journey-telemetry',
  Activation: JourneyTelemetryActivation,
};
