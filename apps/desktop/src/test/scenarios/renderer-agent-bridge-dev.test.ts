// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import { rebindRendererAgentBridgeForTrustedWorkspaceReplacement } from './renderer-agent-bridge-dev';

describe('Dev-scenario renderer agent bridge capability', () => {
  it('is unavailable when the dev/test bridge is absent', async () => {
    await expect(rebindRendererAgentBridgeForTrustedWorkspaceReplacement({})).resolves.toBe(false);
  });

  it('reinstalls the bridge only through the dev/test capability', async () => {
    const rebindRendererAgentBridgeForTest = vi.fn(async () => undefined);

    await expect(
      rebindRendererAgentBridgeForTrustedWorkspaceReplacement({
        __test: { rebindRendererAgentBridgeForTest },
      })
    ).resolves.toBe(true);
    expect(rebindRendererAgentBridgeForTest).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed reinstall so scenario application fails loudly', async () => {
    const failure = new Error('bridge reinstall failed');

    await expect(
      rebindRendererAgentBridgeForTrustedWorkspaceReplacement({
        __test: {
          rebindRendererAgentBridgeForTest: vi.fn(async () => {
            throw failure;
          }),
        },
      })
    ).rejects.toBe(failure);
  });
});
