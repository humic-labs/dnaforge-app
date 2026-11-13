export const HOSTED_PROVIDER_ID = 'hosted';

export const HOSTED_API_KEY_ENV = 'HOSTED_API_KEY';

export class HostedProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedProviderConfigError';
  }
}

function assertTomlSafe(label: string, value: string): void {
  if (value.length === 0) {
    throw new HostedProviderConfigError(`${label} must not be empty`);
  }
  if (/["\\\n\r]/u.test(value)) {
    throw new HostedProviderConfigError(
      `${label} must not contain a quote, backslash, or newline: ${JSON.stringify(value)}`
    );
  }
}

function assertLoopback(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new HostedProviderConfigError(`base URL is not a URL: ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.protocol !== 'http:') {
    throw new HostedProviderConfigError(
      `base URL must be http on loopback, got ${parsed.protocol}`
    );
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') {
    throw new HostedProviderConfigError(`base URL must be loopback, got ${parsed.hostname}`);
  }
}

export function buildHostedProviderConfig(options: {
  readonly baseUrl: string;
  readonly model: string;
}): string {
  assertTomlSafe('base URL', options.baseUrl);
  assertTomlSafe('model', options.model);
  assertLoopback(options.baseUrl);
  const providerBaseUrl = `${options.baseUrl.replace(/\/+$/u, '')}/v1`;

  return [
    '# Written by DNAForge. The Codex home is private to one run.',
    `model = "${options.model}"`,
    `model_provider = "${HOSTED_PROVIDER_ID}"`,
    '',
    `[model_providers.${HOSTED_PROVIDER_ID}]`,
    'name = "DNAForge Hosted"',
    `base_url = "${providerBaseUrl}"`,
    `env_key = "${HOSTED_API_KEY_ENV}"`,
    '# Plain HTTP POST /v1/responses. The default provider would use WebSocket,',
    '# which the gateway does not serve.',
    'wire_api = "responses"',
    '# Measured: the child otherwise makes six attempts at a failing endpoint.',
    '# These belong here and not at top level, where they parse but do nothing.',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
}
