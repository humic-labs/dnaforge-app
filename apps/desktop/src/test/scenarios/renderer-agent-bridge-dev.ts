type RendererAgentBridgeDevTarget = {
  __test?: {
    rebindRendererAgentBridgeForTest?: () => void | Promise<void>;
  };
};

export async function rebindRendererAgentBridgeForTrustedWorkspaceReplacement(
  target: RendererAgentBridgeDevTarget = window as Window & RendererAgentBridgeDevTarget
): Promise<boolean> {
  const rebind = target.__test?.rebindRendererAgentBridgeForTest;
  if (!rebind) return false;
  await rebind();
  return true;
}
