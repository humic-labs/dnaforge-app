import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_HOST_DESCRIPTORS,
  createDefaultAssistantHostDescriptors,
  getAssistantHostDescriptorForTransport,
  getCliAssistantHostDescriptors,
  getDirectApiHostDescriptor,
} from './assistant-hosts';
import { replaceCustomProviderDefinitions } from './providers';

afterEach(() => replaceCustomProviderDefinitions([]));

describe('assistant host descriptors', () => {
  it('defines first-class built-in hosts for CLI agents, Direct API, and hosted tiers', () => {
    expect(DEFAULT_ASSISTANT_HOST_DESCRIPTORS.map((host) => host.id)).toEqual([
      'dnaforge-hosted-auto',
      'dnaforge-hosted-deep',
      'codex-cli',
      'claude-code',
      'grok-cli',
      'direct-api',
    ]);
    expect(DEFAULT_ASSISTANT_HOST_DESCRIPTORS.map((host) => host.label)).toEqual([
      'Auto',
      'Deep',
      'Codex CLI',
      'Claude Code',
      'Grok Build',
      'Direct API',
    ]);
    expect(DEFAULT_ASSISTANT_HOST_DESCRIPTORS.map((host) => host.kind)).toEqual([
      'hosted-gateway',
      'hosted-gateway',
      'cli-agent',
      'cli-agent',
      'cli-agent',
      'api-host',
    ]);
  });

  it('keeps command-line agent hosts discoverable by transport', () => {
    expect(getCliAssistantHostDescriptors().map((host) => host.target.transport)).toEqual([
      'codex-sdk',
      'claude-agent-sdk',
      'grok-acp',
    ]);
    expect(getAssistantHostDescriptorForTransport('codex-sdk')).toMatchObject({
      id: 'codex-cli',
      kind: 'cli-agent',
      capabilities: {
        modelSelection: 'dynamic',
        supportsEffort: true,
        supportsPermissionMode: false,
        supportsFileWrites: true,
      },
    });
    expect(getAssistantHostDescriptorForTransport('claude-agent-sdk')).toMatchObject({
      id: 'claude-code',
      kind: 'cli-agent',
      capabilities: {
        modelSelection: 'dynamic',
        supportsEffort: true,
        supportsPermissionMode: false,
        supportsFileWrites: true,
      },
    });
    expect(getAssistantHostDescriptorForTransport('grok-acp')).toMatchObject({
      id: 'grok-cli',
      kind: 'cli-agent',
      capabilities: {
        modelSelection: 'dynamic',
        supportsEffort: true,
        supportsPermissionMode: false,
        supportsFileWrites: true,
      },
    });
  });

  it('preserves a validated custom harness identity when restoring a CLI route', () => {
    expect(
      getAssistantHostDescriptorForTransport('codex-sdk')?.restoreSelection?.({
        kind: 'cli',
        transport: 'codex-sdk',
        permissionMode: 'native-cli',
        customHarnessId: 'local-codex',
      })
    ).toEqual({
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
      customHarnessId: 'local-codex',
    });
  });

  it('treats configured model providers as one Direct API host', () => {
    expect(getDirectApiHostDescriptor()).toMatchObject({
      id: 'direct-api',
      kind: 'api-host',
      target: { kind: 'direct-api' },
      capabilities: {
        modelSelection: 'dynamic',
        supportsPermissionMode: false,
      },
    });
  });

  it('restores a persisted custom endpoint through the Direct API host', () => {
    replaceCustomProviderDefinitions([
      {
        id: 'custom:lab-gateway',
        label: 'Lab gateway',
        baseUrl: 'https://models.example.test/v1',
        defaultModel: 'lab-model',
      },
    ]);

    expect(
      getDirectApiHostDescriptor()?.restoreSelection?.({
        kind: 'provider',
        provider: 'custom:lab-gateway',
        model: 'lab-model',
      })
    ).toEqual({
      kind: 'provider',
      provider: 'custom:lab-gateway',
      model: 'lab-model',
    });
  });

  it('omits both Hosted tiers from the Release A descriptor catalog', () => {
    expect(createDefaultAssistantHostDescriptors(false).map((host) => host.id)).toEqual([
      'codex-cli',
      'claude-code',
      'grok-cli',
      'direct-api',
    ]);
  });
});
