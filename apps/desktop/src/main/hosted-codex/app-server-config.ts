import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import modelCatalog from './model-catalog.json';
import { CodexRuntimeIsolationError, type CodexRuntimeIsolation } from './runtime-isolation';

export const HOSTED_CODEX_MODEL_PROVIDER_ID = 'dnaforge-hosted';
export const HOSTED_CODEX_MODEL_SLUG = 'gpt-5-codex';
export const HOSTED_CODEX_MODEL_CATALOG_FILENAME = 'model-catalog.json';

const DISABLED_HOSTED_CODEX_FEATURE_NAMES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'code_mode_interrupt',
  'code_mode_only',
  'collaboration_modes',
  'computer_use',
  'current_time_reminder',
  'deferred_executor',
  'enable_mcp_apps',
  'exec_permission_approvals',
  'external_agent_memory_import',
  'goals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'network_proxy',
  'plugins',
  'recommended_plugins',
  'remote_plugin',
  'request_permissions_tool',
  'respect_system_proxy',
  'shell_snapshot',
  'shell_tool',
  'shell_zsh_fork',
  'skill_mcp_dependency_install',
  'skill_search',
  'standalone_web_search',
  'token_budget',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'unified_exec_zsh_fork',
  'view_image',
] as const;

export interface HostedCodexFeatureDecision {
  readonly feature: string;
  readonly decision: 'enabled' | 'disabled';
  readonly owner: string;
  readonly reason: string;
  readonly userVisibleReason: string;
  readonly removalCondition: string;
}

export const HOSTED_CODEX_FEATURE_DECISIONS: readonly HostedCodexFeatureDecision[] = Object.freeze([
  {
    feature: 'default_mode_request_user_input',
    decision: 'enabled',
    owner: 'Desktop AI',
    reason:
      'The Hosted turn loop answers the exact App Server request through DNAForge’s conversation-scoped question card.',
    userVisibleReason: 'Hosted Codex can ask a structured question without leaving chat.',
    removalCondition:
      'Disable if the pinned App Server stops correlating request_user_input to the active turn or the renderer bridge cannot cancel it on Stop.',
  },
  ...DISABLED_HOSTED_CODEX_FEATURE_NAMES.map((feature) => ({
    feature,
    decision: 'disabled' as const,
    owner: 'AI Platform',
    reason:
      'This capability is not carried through the app-owned Hosted tool, authority, lifecycle, and cancellation boundaries.',
    userVisibleReason: `Hosted Codex does not expose the ${feature} capability in DNAForge.`,
    removalCondition: `Enable ${feature} only after its provider request, authority, visible UI, cancellation, and qualification workflow are implemented and reviewed.`,
  })),
]);

export const DISABLED_HOSTED_CODEX_FEATURES = Object.freeze(
  HOSTED_CODEX_FEATURE_DECISIONS.filter((entry) => entry.decision === 'disabled').map(
    (entry) => entry.feature
  )
);

const CATALOG_BYTES = `${JSON.stringify(modelCatalog, null, 2)}\n`;

export interface HostedCodexAppServerConfig {
  readonly providerBaseUrl: string;
  readonly configPath: string;
  readonly modelCatalogPath: string;
  readonly modelCatalogDigest: string;
}

export function hostedCodexModelCatalogDigest(): string {
  return createHash('sha256').update(CATALOG_BYTES, 'utf8').digest('hex');
}

export function assertHostedCodexModelCatalog(candidate: unknown): void {
  if (canonicalJson(candidate) !== canonicalJson(modelCatalog)) {
    throw new CodexRuntimeIsolationError(
      'invalid_model_catalog',
      'the Hosted Codex model catalog does not match the reviewed fail-closed catalog'
    );
  }

  const model = modelCatalog.models[0];
  if (
    modelCatalog.models.length !== 1 ||
    model.slug !== HOSTED_CODEX_MODEL_SLUG ||
    model.shell_type !== 'disabled' ||
    model.apply_patch_tool_type !== null ||
    model.supports_search_tool !== false ||
    model.experimental_supported_tools.length !== 0 ||
    model.auto_compact_token_limit !== 96_000 ||
    model.node_repl_disabled !== true ||
    model.include_apps_usage_instructions !== false ||
    model.include_plugin_usage_instructions !== false ||
    model.include_skills_usage_instructions !== false
  ) {
    throw new CodexRuntimeIsolationError(
      'unsafe_model_catalog',
      'the Hosted Codex model catalog enables a native capability'
    );
  }
}

export function configureHostedCodexAppServer(
  isolation: CodexRuntimeIsolation,
  baseUrl: string
): HostedCodexAppServerConfig {
  const providerBaseUrl = canonicalProviderBaseUrl(baseUrl);
  const modelCatalogPath = path.join(isolation.codexHome, HOSTED_CODEX_MODEL_CATALOG_FILENAME);
  const configPath = path.join(isolation.codexHome, 'config.toml');

  assertHostedCodexModelCatalog(modelCatalog);
  writeFileSync(modelCatalogPath, CATALOG_BYTES, { mode: 0o600 });
  writeFileSync(configPath, buildConfigToml(providerBaseUrl, modelCatalogPath), { mode: 0o600 });

  const configured = {
    providerBaseUrl,
    configPath,
    modelCatalogPath,
    modelCatalogDigest: hostedCodexModelCatalogDigest(),
  };
  assertHostedCodexAppServerConfig(configured);
  return configured;
}

export function assertHostedCodexAppServerConfig(config: HostedCodexAppServerConfig): void {
  const catalogBytes = readFileSync(config.modelCatalogPath, 'utf8');
  if (catalogBytes !== CATALOG_BYTES) {
    throw new CodexRuntimeIsolationError(
      'model_catalog_changed',
      'the Hosted Codex model catalog changed after it was generated'
    );
  }
  assertHostedCodexModelCatalog(JSON.parse(catalogBytes) as unknown);
  if (hostedCodexModelCatalogDigest() !== config.modelCatalogDigest) {
    throw new CodexRuntimeIsolationError(
      'model_catalog_digest_changed',
      'the Hosted Codex model catalog digest does not match the reviewed bytes'
    );
  }

  const expected = buildConfigToml(config.providerBaseUrl, config.modelCatalogPath);
  if (readFileSync(config.configPath, 'utf8') !== expected) {
    throw new CodexRuntimeIsolationError(
      'app_server_config_changed',
      'the Hosted Codex App Server config changed after it was generated'
    );
  }
}

function buildConfigToml(providerBaseUrl: string, modelCatalogPath: string): string {
  return [
    `model_provider = ${JSON.stringify(HOSTED_CODEX_MODEL_PROVIDER_ID)}`,
    `model_catalog_json = ${JSON.stringify(modelCatalogPath)}`,
    'web_search = "disabled"',
    '',
    '[features]',
    'default_mode_request_user_input = true',
    ...DISABLED_HOSTED_CODEX_FEATURES.map((feature) => `${feature} = false`),
    '',
    '[tools.experimental_request_user_input]',
    'enabled = true',
    '',
    '[tools.update_plan]',
    'enabled = false',
    '',
    `[model_providers.${JSON.stringify(HOSTED_CODEX_MODEL_PROVIDER_ID)}]`,
    'name = "DNAForge Hosted"',
    `base_url = ${JSON.stringify(providerBaseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'supports_standalone_web_search = false',
    '',
  ].join('\n');
}

function canonicalProviderBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CodexRuntimeIsolationError(
      'invalid_provider_url',
      'the Hosted Codex provider URL must be a valid loopback URL'
    );
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/v1'
  ) {
    throw new CodexRuntimeIsolationError(
      'invalid_provider_url',
      'the Hosted Codex provider URL must be an uncredentialed loopback /v1 endpoint'
    );
  }
  return `${parsed.origin}/v1`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new CodexRuntimeIsolationError(
      'invalid_model_catalog',
      'the Hosted Codex model catalog must contain only JSON values'
    );
  }
  return serialized;
}
