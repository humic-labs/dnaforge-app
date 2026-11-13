import { useEffect, useState } from 'react';
import { isWorkspaceCloudSyncFeatureEnabled, onFeatureFlagsReady } from '../../lib/analytics';

export function useWorkspaceCloudSyncEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => isWorkspaceCloudSyncFeatureEnabled());
  useEffect(() => {
    setEnabled(isWorkspaceCloudSyncFeatureEnabled());
    return onFeatureFlagsReady(() => setEnabled(isWorkspaceCloudSyncFeatureEnabled()));
  }, []);
  return enabled;
}
