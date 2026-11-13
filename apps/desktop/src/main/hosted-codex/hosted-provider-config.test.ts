import { describe, expect, it } from 'vitest';

import {
  buildHostedProviderConfig,
  HOSTED_API_KEY_ENV,
  HostedProviderConfigError,
} from './hosted-provider-config';

const base = { baseUrl: 'http://127.0.0.1:4321', model: 'gpt-5-codex' };

describe('buildHostedProviderConfig', () => {
  describe('the route', () => {
    it('adds the version segment the child appends its path to', () => {
      expect(buildHostedProviderConfig(base)).toContain('base_url = "http://127.0.0.1:4321/v1"');
    });

    it('does not double the segment when the origin already ends in a slash', () => {
      const config = buildHostedProviderConfig({ ...base, baseUrl: 'http://127.0.0.1:4321/' });
      expect(config).toContain('base_url = "http://127.0.0.1:4321/v1"');
      expect(config).not.toContain('//v1');
    });

    it('asks for the wire protocol the gateway actually serves', () => {
      expect(buildHostedProviderConfig(base)).toContain('wire_api = "responses"');
    });

    it('names the variable the credential is injected under', () => {
      expect(buildHostedProviderConfig(base)).toContain(`env_key = "${HOSTED_API_KEY_ENV}"`);
    });
  });

  describe('retry ownership', () => {
    it('silences the child inside the provider table, not at top level', () => {
      const config = buildHostedProviderConfig(base);
      const providerTable = config.slice(config.indexOf('[model_providers.'));
      const preamble = config.slice(0, config.indexOf('[model_providers.'));

      expect(providerTable).toContain('request_max_retries = 0');
      expect(providerTable).toContain('stream_max_retries = 0');
      expect(preamble).not.toContain('request_max_retries');
      expect(preamble).not.toContain('stream_max_retries');
    });
  });

  describe('the isolation guarantee', () => {
    it('declares the route and nothing else', () => {
      const config = buildHostedProviderConfig(base);
      const keys = config
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => (line.startsWith('[') ? line : (line.split('=')[0] ?? '').trim()));

      expect(new Set(keys)).toEqual(
        new Set([
          'model',
          'model_provider',
          '[model_providers.hosted]',
          'name',
          'base_url',
          'env_key',
          'wire_api',
          'request_max_retries',
          'stream_max_retries',
        ])
      );
    });

    it('names the credential rather than carrying it', () => {
      const config = buildHostedProviderConfig(base);
      expect(config).toContain(`env_key = "${HOSTED_API_KEY_ENV}"`);
      expect(config).not.toMatch(/^\s*api_key\s*=/imu);
      expect(Object.keys(base)).toEqual(['baseUrl', 'model']);
    });
  });

  describe('what it refuses', () => {
    it('refuses a host that is not loopback', () => {
      expect(() => buildHostedProviderConfig({ ...base, baseUrl: 'http://example.com' })).toThrow(
        HostedProviderConfigError
      );
    });

    it('refuses a scheme that is not http', () => {
      expect(() =>
        buildHostedProviderConfig({ ...base, baseUrl: 'https://127.0.0.1:4321' })
      ).toThrow(HostedProviderConfigError);
    });

    it('refuses a value that would break out of its TOML string', () => {
      expect(() =>
        buildHostedProviderConfig({ ...base, model: 'x"\nbase_url = "http://evil.test' })
      ).toThrow(HostedProviderConfigError);
    });

    it('refuses an empty model', () => {
      expect(() => buildHostedProviderConfig({ ...base, model: '' })).toThrow(
        HostedProviderConfigError
      );
    });
  });
});
