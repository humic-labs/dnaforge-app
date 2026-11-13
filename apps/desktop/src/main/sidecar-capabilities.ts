import capabilityConfig from './sidecar-capabilities.json';

export const DEFAULT_MCP_GRANT_IDENTITY = capabilityConfig.defaultMcpGrantIdentity;

export const REQUIRED_RENDERER_EXTERNAL_CAPABILITIES =
  capabilityConfig.requiredRendererExternalCapabilities as readonly string[];

export const DEFAULT_MCP_GRANT_CAPABILITIES =
  capabilityConfig.defaultMcpGrantCapabilities as readonly string[];

function parseCapabilities(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupe(capabilities: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const capability of capabilities) {
    if (seen.has(capability)) continue;
    seen.add(capability);
    out.push(capability);
  }
  return out;
}

export function missingRequiredRendererExternalCapabilities(
  rawGrant: string | null | undefined
): string[] {
  const grant = new Set(parseCapabilities(rawGrant));
  return REQUIRED_RENDERER_EXTERNAL_CAPABILITIES.filter((capability) => !grant.has(capability));
}

export function buildSidecarGrantCapabilities(
  rawGrant: string | null | undefined = process.env.DNAFORGE_MCP_GRANT_CAPABILITIES
): string {
  const configured = parseCapabilities(rawGrant);
  return dedupe([
    ...DEFAULT_MCP_GRANT_CAPABILITIES,
    ...configured,
    ...REQUIRED_RENDERER_EXTERNAL_CAPABILITIES,
  ]).join(',');
}
