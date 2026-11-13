import { useEffect, useState } from 'react';
import { isDesktopSignInFeatureEnabled, onFeatureFlagsReady } from '../../lib/analytics';

export function useDesktopSignInEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => isDesktopSignInFeatureEnabled());
  useEffect(() => {
    setEnabled(isDesktopSignInFeatureEnabled());
    return onFeatureFlagsReady(() => setEnabled(isDesktopSignInFeatureEnabled()));
  }, []);
  return enabled;
}
