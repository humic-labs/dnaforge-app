import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import modelCatalog from './model-catalog.json';
import {
  assertHostedCodexAppServerConfig,
  assertHostedCodexModelCatalog,
  configureHostedCodexAppServer,
  DISABLED_HOSTED_CODEX_FEATURES,
  HOSTED_CODEX_FEATURE_DECISIONS,
  hostedCodexModelCatalogDigest,
  HOSTED_CODEX_MODEL_CATALOG_FILENAME,
  HOSTED_CODEX_MODEL_PROVIDER_ID,
  HOSTED_CODEX_MODEL_SLUG,
} from './app-server-config';
import {
  assertCodexRuntimeIsolation,
  createCodexRuntimeIsolation,
  CodexRuntimeIsolationError,
} from './runtime-isolation';

let roots: string[] = [];

function configuredRuntime() {
  const root = mkdtempSync(path.join(tmpdir(), 'hosted-app-server-config-'));
  roots.push(root);
  const isolation = createCodexRuntimeIsolation({ rootDir: root, runId: 'turn-1' });
  const config = configureHostedCodexAppServer(isolation, 'http://127.0.0.1:49152/v1');
  return { isolation, config };
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('Hosted Codex App Server config', () => {
  it('writes the pinned model catalog and sealed loopback provider without a bearer', () => {
    const { isolation, config } = configuredRuntime();
    const configToml = readFileSync(config.configPath, 'utf8');
    const writtenCatalog = JSON.parse(readFileSync(config.modelCatalogPath, 'utf8')) as unknown;

    expect(configToml).toContain(`model_provider = "${HOSTED_CODEX_MODEL_PROVIDER_ID}"`);
    expect(configToml).toContain(`model_catalog_json = "${config.modelCatalogPath}"`);
    expect(configToml).toContain('web_search = "disabled"');
    expect(configToml).toContain(`base_url = "${config.providerBaseUrl}"`);
    expect(configToml).toContain('env_key = "OPENAI_API_KEY"');
    expect(configToml).toContain('wire_api = "responses"');
    expect(configToml).toContain('request_max_retries = 0');
    expect(configToml).toContain('stream_max_retries = 0');
    expect(configToml).toContain('requires_openai_auth = false');
    expect(configToml).toContain('supports_websockets = false');
    expect(configToml).toContain('supports_standalone_web_search = false');
    expect(configToml).toContain('default_mode_request_user_input = true');
    expect(configToml).toContain('[tools.experimental_request_user_input]\nenabled = true');
    expect(configToml).toContain('[tools.update_plan]\nenabled = false');
    for (const feature of DISABLED_HOSTED_CODEX_FEATURES) {
      expect(configToml).toContain(`${feature} = false`);
    }
    expect(DISABLED_HOSTED_CODEX_FEATURES).toContain('shell_tool');
    expect(DISABLED_HOSTED_CODEX_FEATURES).toContain('unified_exec');
    expect(DISABLED_HOSTED_CODEX_FEATURES).toContain('multi_agent');
    expect(DISABLED_HOSTED_CODEX_FEATURES).toContain('apps');
    expect(configToml).not.toContain('Bearer ');
    expect(configToml).not.toContain('secret');
    expect(writtenCatalog).toEqual(modelCatalog);
    expect(() => assertHostedCodexAppServerConfig(config)).not.toThrow();
    expect(() =>
      assertCodexRuntimeIsolation(isolation, ['config.toml', HOSTED_CODEX_MODEL_CATALOG_FILENAME])
    ).not.toThrow();
  });

  it('records one owned, removable decision for all 43 reviewed feature flags', () => {
    expect(HOSTED_CODEX_FEATURE_DECISIONS).toHaveLength(43);
    expect(new Set(HOSTED_CODEX_FEATURE_DECISIONS.map((entry) => entry.feature)).size).toBe(43);
    expect(
      HOSTED_CODEX_FEATURE_DECISIONS.find(
        (entry) => entry.feature === 'default_mode_request_user_input'
      )
    ).toMatchObject({ decision: 'enabled' });
    for (const decision of HOSTED_CODEX_FEATURE_DECISIONS) {
      expect(decision).toMatchObject({
        owner: expect.any(String),
        reason: expect.any(String),
        userVisibleReason: expect.any(String),
        removalCondition: expect.any(String),
      });
    }
  });

  it('uses the real pinned schema to disable every Codex-owned execution route', () => {
    expect(modelCatalog.models).toHaveLength(1);
    const model = modelCatalog.models[0];
    expect(model.slug).toBe(HOSTED_CODEX_MODEL_SLUG);
    expect(model.shell_type).toBe('disabled');
    expect(model.apply_patch_tool_type).toBeNull();
    expect(model.supports_search_tool).toBe(false);
    expect(model.experimental_supported_tools).toEqual([]);
    expect(model.node_repl_disabled).toBe(true);
    expect(model.include_apps_usage_instructions).toBe(false);
    expect(model.include_plugin_usage_instructions).toBe(false);
    expect(model.include_skills_usage_instructions).toBe(false);
    expect(model.auto_compact_token_limit).toBe(96_000);
    expect(() => assertHostedCodexModelCatalog(modelCatalog)).not.toThrow();
  });

  it.each([
    ['shell default', { shell_type: 'default' }],
    ['apply patch', { apply_patch_tool_type: 'freeform' }],
    ['search', { supports_search_tool: true }],
    ['experimental native tool', { experimental_supported_tools: ['view_image'] }],
    ['node repl', { node_repl_disabled: false }],
    ['request-size compaction policy', { auto_compact_token_limit: null }],
    ['another model', { slug: 'another-model' }],
  ])('refuses %s catalog drift', (_name, mutation) => {
    const candidate: { models: Array<Record<string, unknown>> } = {
      models: modelCatalog.models.map((model) => ({ ...model })),
    };
    Object.assign(candidate.models[0], mutation);
    expect(() => assertHostedCodexModelCatalog(candidate)).toThrow(CodexRuntimeIsolationError);
  });

  it('refuses extra catalog fields instead of accepting an unknown default', () => {
    const candidate: { models: Array<Record<string, unknown>> } = {
      models: modelCatalog.models.map((model) => ({ ...model })),
    };
    candidate.models[0].future_native_tool = true;
    expect(() => assertHostedCodexModelCatalog(candidate)).toThrow(/reviewed fail-closed/u);
  });

  it('detects config and catalog changes after generation', () => {
    const first = configuredRuntime();
    writeFileSync(
      first.config.configPath,
      `${readFileSync(first.config.configPath, 'utf8')}# drift`
    );
    expect(() => assertHostedCodexAppServerConfig(first.config)).toThrow(
      /config changed after it was generated/u
    );

    const second = configuredRuntime();
    writeFileSync(second.config.modelCatalogPath, '{}\n');
    expect(() => assertHostedCodexAppServerConfig(second.config)).toThrow(
      /catalog changed after it was generated/u
    );
  });

  it.each([
    'https://api.openai.com/v1',
    'http://localhost:49152/v1',
    'http://127.0.0.1:49152',
    'http://127.0.0.1:49152/v1/responses',
    'http://user:pass@127.0.0.1:49152/v1',
  ])('refuses non-canonical provider origin %s', (baseUrl) => {
    const root = mkdtempSync(path.join(tmpdir(), 'hosted-app-server-origin-'));
    roots.push(root);
    const isolation = createCodexRuntimeIsolation({ rootDir: root, runId: 'origin' });
    expect(() => configureHostedCodexAppServer(isolation, baseUrl)).toThrow(
      CodexRuntimeIsolationError
    );
  });

  it('gives the catalog a stable generation identity', () => {
    expect(hostedCodexModelCatalogDigest()).toBe(hostedCodexModelCatalogDigest());
    expect(hostedCodexModelCatalogDigest()).toMatch(/^[0-9a-f]{64}$/u);
  });
});
