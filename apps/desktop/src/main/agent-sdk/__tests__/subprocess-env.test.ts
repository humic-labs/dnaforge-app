import { describe, expect, it } from 'vitest';
import {
  COMPUTE_PROVIDER_ENV_PREFIXES,
  claudeCliEnv,
  codexCliEnv,
  grokCliEnv,
  sidecarEnv,
  subprocessEnv,
  withBundledToolsOnPath,
} from '../subprocess-env';

it.each(['claude', 'codex', 'grok', 'sidecar'] as const)(
  'keeps the Jev key out of ambient %s environments',
  (target) => {
    const clean = subprocessEnv(target, {
      PATH: '/bin',
      TYPESAFE_API_KEY: 'private',
      Typesafe_Future_Token: 'private',
      JEV_TOKEN: 'private',
    });
    expect(clean).toEqual({ PATH: '/bin' });
  }
);

const AMBIENT = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/Users/test',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy.test:8080',
  NO_PROXY: '127.0.0.1',
  NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
  SSL_CERT_FILE: '/certs/ssl.pem',
  XDG_CONFIG_HOME: '/Users/test/.config',
  CLAUDE_CONFIG_DIR: '/Users/test/.claude',
  CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/test/.claude-secure',
  CODEX_HOME: '/Users/test/.codex',
  ANTHROPIC_API_KEY: 'sk-ant-invalid',
  ANTHROPIC_AUTH_TOKEN: 'ambient-token',
  ANTHROPIC_NEWVAR: 'future-sdk-auth-var',
  CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth',
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'ambient-session',
  CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR: '9',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_REMOTE: '1',
  CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
  CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/tmp/ingress-token',
  OPENAI_API_KEY: 'sk-openai-invalid',
  OPENAI_BASE_URL: 'https://ambient.example/v1',
  OPENAI_NEWVAR: 'future-openai-auth-var',
  CODEX_API_KEY: 'codex-ambient-key',
  CODEX_NEWTOKEN: 'future-codex-auth-var',
  OpenAI_API_KEY: 'sk-openai-mixedcase',
  GOOGLE_API_KEY: 'google-ambient-key',
  XAI_API_KEY: 'xai-ambient-key',
  XAI_NEWVAR: 'future-xai-auth-var',
  GROK_API_URL: 'https://ambient-grok.invalid',
  GROK_NEW_TOKEN: 'future-grok-auth-var',
  DEEPSEEK_API_KEY: 'deepseek-ambient-key',
  DEEPSEEK_NEWVAR: 'future-deepseek-auth-var',
  SENTRY_DSN: 'https://example@sentry.invalid/1',
  SENTRY_ENVIRONMENT: 'production',
  DNAFORGE_MCP_SESSION_TOKEN: 'sidecar-session-secret',
  DNAFORGE_SIDECAR_SESSION_GENERATION: '17',
  DNAFORGE_SIDECAR_OWNER_PID: '1234',
} as const;

const OTHER_PROVIDER_STRIPPED = [
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'XAI_NEWVAR',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_NEWVAR',
] as const;

const SIDECAR_TELEMETRY_STRIPPED = ['SENTRY_DSN', 'SENTRY_ENVIRONMENT'] as const;
const HOST_SIDECAR_SESSION_STRIPPED = [
  'DNAFORGE_MCP_SESSION_TOKEN',
  'DNAFORGE_SIDECAR_SESSION_GENERATION',
  'DNAFORGE_SIDECAR_OWNER_PID',
] as const;

const OPERATIONAL_KEPT = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'XDG_CONFIG_HOME',
] as const;

const CLAUDE_STRIPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_NEWVAR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SEND_KEEPALIVES',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
] as const;

const CODEX_STRIPPED = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_NEWVAR',
  'CODEX_API_KEY',
  'CODEX_NEWTOKEN',
] as const;

const GROK_STRIPPED = ['XAI_API_KEY', 'XAI_NEWVAR', 'GROK_API_URL', 'GROK_NEW_TOKEN'] as const;

describe('subprocessEnv', () => {
  it.each(['claude', 'codex', 'sidecar'] as const)(
    'strips human operation authority from the generic %s environment while preserving discovery',
    (target) => {
      const env = subprocessEnv(target, {
        ...AMBIENT,
        DNAFORGE_HUMAN_OPERATION_TOKEN: 'test-human-operation-token',
        Dnaforge_Human_Operation_Token: 'test-case-insensitive-token',
        DNAFORGE_NATIVE_DOCUMENT_TOKEN: 'test-native-document-token',
        Dnaforge_Native_Document_Token: 'test-native-case-insensitive-token',
        DNAFORGE_NATIVE_DOCUMENT_OWNER_ID: 'test-native-owner',
        DNAFORGE_OPERATION_RUNTIME_DIR: '/test/runtime-registry',
      });
      expect(env).not.toHaveProperty('DNAFORGE_HUMAN_OPERATION_TOKEN');
      expect(env).not.toHaveProperty('Dnaforge_Human_Operation_Token');
      expect(env).not.toHaveProperty('DNAFORGE_NATIVE_DOCUMENT_TOKEN');
      expect(env).not.toHaveProperty('Dnaforge_Native_Document_Token');
      expect(env).not.toHaveProperty('DNAFORGE_NATIVE_DOCUMENT_OWNER_ID');
      expect(env.DNAFORGE_OPERATION_RUNTIME_DIR).toBe('/test/runtime-registry');
    }
  );
  it('strips compute-provider credential channels from every delegated subprocess', () => {
    const withComputeKeys: NodeJS.ProcessEnv = {
      ...AMBIENT,
      TAMARIND_API_KEY: 'placeholder-a',
      tamarind_api_key: 'placeholder-b',
      NVIDIA_API_KEY: 'placeholder-c',
      NVAPI_TOKEN: 'placeholder-d',
      SUBSEQ_API_KEY: 'placeholder-e',
      BOLTZ_API_KEY: 'placeholder-f',
      REPLICATE_API_TOKEN: 'placeholder-g',
      RUNPOD_API_KEY: 'placeholder-h',
      HF_TOKEN: 'placeholder-i',
      HUGGINGFACE_API_KEY: 'placeholder-j',
      BASETEN_API_KEY: 'placeholder-k',
      BIOHUB_API_KEY: 'placeholder-l',
      NVIDIA_VISIBLE_DEVICES: 'all',
    };
    for (const target of ['claude', 'codex', 'grok', 'sidecar'] as const) {
      const env = subprocessEnv(target, withComputeKeys);
      for (const key of [
        'TAMARIND_API_KEY',
        'tamarind_api_key',
        'NVIDIA_API_KEY',
        'NVAPI_TOKEN',
        'SUBSEQ_API_KEY',
        'BOLTZ_API_KEY',
        'REPLICATE_API_TOKEN',
        'RUNPOD_API_KEY',
        'HF_TOKEN',
        'HUGGINGFACE_API_KEY',
        'BASETEN_API_KEY',
        'BIOHUB_API_KEY',
      ]) {
        expect(env, `${target} must not inherit ${key}`).not.toHaveProperty(key);
      }
      expect(env.NVIDIA_VISIBLE_DEVICES).toBe('all');
    }
    expect(COMPUTE_PROVIDER_ENV_PREFIXES).toEqual([
      'TAMARIND_',
      'BOLTZ_',
      'NVIDIA_API_KEY',
      'NVAPI_',
      'REPLICATE_',
      'RUNPOD_',
      'HF_TOKEN',
      'HUGGINGFACE_',
      'HUGGING_FACE_',
      'BASETEN_',
      'BIOHUB_',
      'SUBSEQ_',
    ]);
  });

  it('strips the host-owned sidecar session from every delegated subprocess', () => {
    for (const target of ['claude', 'codex', 'grok', 'sidecar'] as const) {
      const env = subprocessEnv(target, AMBIENT);
      for (const key of HOST_SIDECAR_SESSION_STRIPPED) {
        expect(env).not.toHaveProperty(key);
      }
    }
  });

  describe("target 'grok'", () => {
    const env = subprocessEnv('grok', AMBIENT);

    it('keeps operational environment while stripping xAI and Grok ambient authority', () => {
      for (const key of OPERATIONAL_KEPT) expect(env[key]).toBe(AMBIENT[key]);
      for (const key of GROK_STRIPPED) expect(env).not.toHaveProperty(key);
    });

    it('does not strip unrelated provider channels', () => {
      expect(env.ANTHROPIC_API_KEY).toBe(AMBIENT.ANTHROPIC_API_KEY);
      expect(env.OPENAI_API_KEY).toBe(AMBIENT.OPENAI_API_KEY);
    });
  });

  describe("target 'claude'", () => {
    const env = subprocessEnv('claude', AMBIENT);

    it('keeps operational env and the Claude subscription-session locators', () => {
      for (const key of OPERATIONAL_KEPT) expect(env[key]).toBe(AMBIENT[key]);
      expect(env.CLAUDE_CONFIG_DIR).toBe(AMBIENT.CLAUDE_CONFIG_DIR);
      expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(AMBIENT.CLAUDE_SECURESTORAGE_CONFIG_DIR);
    });

    it('strips every Anthropic / Claude Code ambient auth var (prefix-based)', () => {
      for (const key of CLAUDE_STRIPPED) expect(env).not.toHaveProperty(key);
    });

    it('does NOT strip other providers (per-target isolation; claude reads none of them)', () => {
      expect(env.OPENAI_API_KEY).toBe(AMBIENT.OPENAI_API_KEY);
      expect(env.CODEX_API_KEY).toBe(AMBIENT.CODEX_API_KEY);
      expect(env.GOOGLE_API_KEY).toBe(AMBIENT.GOOGLE_API_KEY);
      expect(env.XAI_API_KEY).toBe(AMBIENT.XAI_API_KEY);
    });
  });

  describe("target 'codex'", () => {
    const env = subprocessEnv('codex', AMBIENT);

    it('keeps operational env and the codex session-home locator', () => {
      for (const key of OPERATIONAL_KEPT) expect(env[key]).toBe(AMBIENT[key]);
      expect(env.CODEX_HOME).toBe(AMBIENT.CODEX_HOME);
    });

    it('strips every OpenAI / Codex ambient auth var (prefix-based) — ', () => {
      for (const key of CODEX_STRIPPED) expect(env).not.toHaveProperty(key);
    });

    it('strips the mixed-case OpenAI key too (case-insensitive — Windows)', () => {
      expect(env).not.toHaveProperty('OpenAI_API_KEY');
    });

    it('does NOT strip other providers (per-target isolation; codex reads none of them)', () => {
      expect(env.ANTHROPIC_API_KEY).toBe(AMBIENT.ANTHROPIC_API_KEY);
      expect(env.GOOGLE_API_KEY).toBe(AMBIENT.GOOGLE_API_KEY);
    });
  });

  describe("target 'sidecar'", () => {
    const env = subprocessEnv('sidecar', AMBIENT);

    it('keeps operational env and both config-dir locators', () => {
      for (const key of OPERATIONAL_KEPT) expect(env[key]).toBe(AMBIENT[key]);
      expect(env.CLAUDE_CONFIG_DIR).toBe(AMBIENT.CLAUDE_CONFIG_DIR);
      expect(env.CODEX_HOME).toBe(AMBIENT.CODEX_HOME);
    });

    it('strips EVERY provider credential and host-owned telemetry channel', () => {
      for (const key of [
        ...CLAUDE_STRIPPED,
        ...CODEX_STRIPPED,
        ...OTHER_PROVIDER_STRIPPED,
        ...SIDECAR_TELEMETRY_STRIPPED,
      ]) {
        expect(env).not.toHaveProperty(key);
      }
      expect(env).not.toHaveProperty('OpenAI_API_KEY');
    });
  });

  describe(': repaired PATH passes through verbatim for every target', () => {
    const REPAIRED_PATH =
      '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/Users/test/.local/bin:/Users/test/.nvm/versions/node/v20.19.4/bin';
    for (const target of ['claude', 'codex', 'grok', 'sidecar'] as const) {
      it(`carries the full repaired PATH unchanged for '${target}'`, () => {
        const env = subprocessEnv(target, { ...AMBIENT, PATH: REPAIRED_PATH });
        expect(env.PATH).toBe(REPAIRED_PATH);
        expect(env.PATH.startsWith('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(true);
      });
    }
  });

  describe('hygiene', () => {
    it('drops non-string values, producing a clean Record<string,string>', () => {
      const env = subprocessEnv('codex', {
        PATH: '/usr/bin',
        UNDEFINED_VAR: undefined,
      } as NodeJS.ProcessEnv);
      expect(env).toEqual({ PATH: '/usr/bin' });
      expect(env).not.toHaveProperty('UNDEFINED_VAR');
    });

    it('does not mutate the source env', () => {
      const base = { ...AMBIENT };
      subprocessEnv('sidecar', base);
      expect(base.ANTHROPIC_API_KEY).toBe(AMBIENT.ANTHROPIC_API_KEY);
      expect(base.OPENAI_API_KEY).toBe(AMBIENT.OPENAI_API_KEY);
    });
  });

  describe('convenience wrappers delegate to the right target', () => {
    it('claudeCliEnv === subprocessEnv("claude")', () => {
      const env = claudeCliEnv(AMBIENT);
      expect(env).toMatchObject({
        PATH: AMBIENT.PATH,
        CLAUDE_CONFIG_DIR: AMBIENT.CLAUDE_CONFIG_DIR,
      });
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env).toEqual(subprocessEnv('claude', AMBIENT));
    });
    it('codexCliEnv === subprocessEnv("codex")', () => {
      const env = codexCliEnv(AMBIENT);
      expect(env).toMatchObject({ PATH: AMBIENT.PATH, CODEX_HOME: AMBIENT.CODEX_HOME });
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env).toEqual(subprocessEnv('codex', AMBIENT));
    });
    it('grokCliEnv === subprocessEnv("grok")', () => {
      const env = grokCliEnv(AMBIENT);
      expect(env).toMatchObject({ PATH: AMBIENT.PATH });
      expect(env).not.toHaveProperty('XAI_API_KEY');
      expect(env).toEqual(subprocessEnv('grok', AMBIENT));
    });
    it('sidecarEnv === subprocessEnv("sidecar")', () => {
      const env = sidecarEnv(AMBIENT);
      expect(env).toMatchObject({ PATH: AMBIENT.PATH });
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env).toEqual(subprocessEnv('sidecar', AMBIENT));
    });
  });
});

describe('withBundledToolsOnPath', () => {
  it('puts the bundled tools ahead of the user PATH once', () => {
    const env = withBundledToolsOnPath({ PATH: '/usr/local/bin:/usr/bin' }, '/App/binaries');
    expect(env.PATH).toBe('/App/binaries:/usr/local/bin:/usr/bin');
    expect(withBundledToolsOnPath(env, '/App/binaries')).toBe(env);
  });

  it('keeps the existing PATH key spelling and leaves env alone without bundled tools', () => {
    expect(withBundledToolsOnPath({ Path: '/usr/bin' }, '/App/binaries')).toEqual({
      Path: '/App/binaries:/usr/bin',
    });
    const env = { PATH: '/usr/bin' };
    expect(withBundledToolsOnPath(env, null)).toBe(env);
    expect(withBundledToolsOnPath({}, '/App/binaries')).toEqual({ PATH: '/App/binaries' });
  });
});
