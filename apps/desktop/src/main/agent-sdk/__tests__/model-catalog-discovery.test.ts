import { describe, expect, it, vi } from 'vitest';

import { captureModelCatalogDiscovery } from '../model-catalog-discovery';

const model = (id: string) => ({
  id,
  displayName: id,
  reasoningEfforts: [],
});

describe('model catalog discovery integrity', () => {
  it('marks a non-empty provider catalog complete with exact source identity', async () => {
    await expect(
      captureModelCatalogDiscovery({
        source: 'claude-sdk-initialization',
        executablePath: '/usr/local/bin/claude',
        eligible: true,
        probe: async () => [model('default'), model('sonnet')],
      })
    ).resolves.toEqual({
      models: [model('default'), model('sonnet')],
      modelCatalog: {
        status: 'complete',
        source: 'claude-sdk-initialization',
        executablePath: '/usr/local/bin/claude',
        observedModelCount: 2,
        error: null,
      },
    });
  });

  it('does not misreport an empty authenticated catalog as successful discovery', async () => {
    const result = await captureModelCatalogDiscovery({
      source: 'claude-sdk-initialization',
      executablePath: '/usr/local/bin/claude',
      eligible: true,
      probe: async () => [],
    });

    expect(result.models).toEqual([]);
    expect(result.modelCatalog).toMatchObject({
      status: 'failed',
      observedModelCount: 0,
      error: expect.stringMatching(/advertised no models/i),
    });
  });

  it('does not misreport thrown discovery or duplicate model ids as a complete catalog', async () => {
    const failed = await captureModelCatalogDiscovery({
      source: 'grok-acp-initialization',
      executablePath: '/usr/local/bin/grok',
      eligible: true,
      probe: async () => {
        throw new Error('ACP initialization timed out');
      },
    });
    expect(failed.modelCatalog).toMatchObject({
      status: 'failed',
      error: 'ACP initialization timed out',
    });

    const duplicate = await captureModelCatalogDiscovery({
      source: 'grok-acp-initialization',
      executablePath: '/usr/local/bin/grok',
      eligible: true,
      probe: async () => [model('grok-4.6'), model('grok-4.6')],
    });
    expect(duplicate.modelCatalog).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/duplicate model id/i),
    });
  });

  it('records why discovery was not attempted and never invokes the provider', async () => {
    const probe = vi.fn(async () => [model('should-not-run')]);
    await expect(
      captureModelCatalogDiscovery({
        source: 'codex-app-server',
        executablePath: null,
        eligible: false,
        probe,
      })
    ).resolves.toEqual({
      models: [],
      modelCatalog: {
        status: 'not_attempted',
        source: 'codex-app-server',
        executablePath: null,
        observedModelCount: 0,
        error: null,
      },
    });
    expect(probe).not.toHaveBeenCalled();
  });
});
