import {
  SidecarSessionUnavailableError,
  type SidecarSessionAuthority,
  type SidecarSessionSnapshot,
} from '../sidecar-session-authority';
import type { CliMcpBridgeConfig } from './cli-mcp';

export type CliMcpBridgeProvider = (
  signal?: AbortSignal
) => CliMcpBridgeConfig | null | Promise<CliMcpBridgeConfig | null>;

export function createReadyCliMcpBridgeProvider(
  authority: SidecarSessionAuthority,
  buildConfig: (snapshot: SidecarSessionSnapshot) => Omit<CliMcpBridgeConfig, 'assertCurrent'>
): (signal?: AbortSignal) => Promise<CliMcpBridgeConfig> {
  return async (signal) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SidecarSessionUnavailableError(authority.snapshot().state);
      const snapshot = await authority.waitForReadySnapshot(remaining, signal);
      signal?.throwIfAborted();
      if (!authority.isCurrent(snapshot)) continue;
      return {
        ...buildConfig(snapshot),
        assertCurrent: () => {
          signal?.throwIfAborted();
          if (!authority.isCurrent(snapshot)) {
            throw new Error(
              'SIDECAR_SESSION_CHANGED: the compute service session changed before the agent launched. Retry the turn.'
            );
          }
        },
      };
    }
  };
}
