import { isBrowserOnly } from '../../utils/environment';

export const MANAGED_WORKSPACES_FLAG_KEY = 'waypoint:managed-workspaces';

export function isManagedWorkspacesEnabled(): boolean {
  if (isBrowserOnly()) return false;
  try {
    return globalThis.localStorage?.getItem(MANAGED_WORKSPACES_FLAG_KEY) !== '0';
  } catch {
    return true;
  }
}
