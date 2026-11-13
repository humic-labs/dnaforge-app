import { userMessageValue, userMessageWithValues } from '@waypoint/user-messages';
import { describe, expect, it, vi } from 'vitest';

import {
  collectCodexModelCatalog,
  mapClaudeModelCatalog,
  mapGrokAcpModelCatalog,
  mapGrokModelCatalog,
  validateModelSelection,
} from '../model-catalog';

describe('runtime CLI model catalogs', () => {
  it('collects every visible Codex model across App Server pages with its own options', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-6-astra',
            displayName: 'GPT-6 Astra',
            description: 'Frontier agentic coding model.',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast responses' },
              { reasoningEffort: 'medium', description: 'Balanced' },
              { reasoningEffort: 'high', description: 'Deeper reasoning' },
              { reasoningEffort: 'xhigh', description: 'Very deep reasoning' },
              { reasoningEffort: 'max', description: 'Maximum reasoning' },
              { reasoningEffort: 'ultra', description: 'Most reasoning' },
            ],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority processing' }],
            defaultServiceTier: null,
          },
          {
            id: 'internal-review',
            displayName: 'Internal review',
            description: 'Hidden helper.',
            hidden: true,
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
            supportsPersonality: false,
            serviceTiers: [],
            defaultServiceTier: null,
          },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'gpt-5.5',
            displayName: 'GPT-5.5',
            description: 'Previous generation.',
            hidden: false,
            isDefault: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'high', description: 'Deep' },
            ],
            defaultReasoningEffort: 'low',
            inputModalities: ['text', 'image'],
            supportsPersonality: true,
            serviceTiers: [],
            defaultServiceTier: null,
          },
        ],
        nextCursor: null,
      });

    await expect(collectCodexModelCatalog(request)).resolves.toEqual([
      expect.objectContaining({
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'medium',
        serviceTiers: [{ id: 'priority', label: 'Fast', description: 'Priority processing' }],
        isDefault: true,
      }),
      expect.objectContaining({
        id: 'gpt-5.5',
        reasoningEfforts: ['low', 'high'],
        supportsPersonality: true,
      }),
    ]);
    expect(request).toHaveBeenNthCalledWith(1, 'model/list', {
      cursor: null,
      limit: 100,
      includeHidden: false,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'model/list', {
      cursor: 'page-2',
      limit: 100,
      includeHidden: false,
    });
  });

  it('rejects an absent, malformed, repeated-id or truncated Codex catalog', async () => {
    await expect(
      collectCodexModelCatalog(vi.fn().mockResolvedValue({ data: null }))
    ).rejects.toThrow(/invalid/i);
    await expect(
      collectCodexModelCatalog(
        vi.fn().mockResolvedValue({ data: [{ id: 'one' }, { id: 'one' }], nextCursor: null })
      )
    ).rejects.toThrow(/duplicate/i);
    let page = 0;
    const request = vi.fn(async () => ({
      data: [{ id: `model-${page}` }],
      nextCursor: `page-${++page}`,
    }));
    await expect(collectCodexModelCatalog(request)).rejects.toThrow(/incomplete/i);
    expect(request).toHaveBeenCalledTimes(20);
  });

  it('cannot validate an override or default against an empty catalog', () => {
    expect(validateModelSelection([], 'gpt-6.1-sol', null, null)).toMatch(/models.*unavailable/i);
    expect(validateModelSelection([], null, null, null)).toMatch(/models.*unavailable/i);
  });

  it('accepts any exact model the current runtime advertises without a historical blacklist', () => {
    expect(
      validateModelSelection(
        [{ id: 'gpt-6.1-sol', displayName: 'New model', reasoningEfforts: [], isDefault: true }],
        'gpt-6.1-sol',
        null,
        null
      )
    ).toBeNull();
  });

  it('turns the installed Claude SDK descriptors into versioned labels and explains Default', () => {
    const models = mapClaudeModelCatalog(
      [
        {
          value: 'default',
          displayName: 'Default (recommended)',
          description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsFastMode: true,
        },
        {
          value: 'opus[1m]',
          displayName: 'Opus (1M context)',
          description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsFastMode: true,
        },
        {
          value: 'claude-fable-5-1[1m]',
          displayName: 'Fable',
          description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsFastMode: false,
        },
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          description: 'Sonnet 5 · Efficient for routine tasks',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsFastMode: false,
        },
        {
          value: 'haiku',
          displayName: 'Haiku',
          description: 'Haiku 4.5 · Fastest for quick answers',
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsFastMode: false,
        },
      ],
      {
        outputStyles: ['concise', 'explanatory'],
        defaultStyle: 'concise',
      }
    );

    expect(models.map((model) => [model.id, model.displayName])).toEqual([
      ['default', 'Default — Opus 5 (1M context)'],
      ['opus[1m]', 'Opus 5 (1M context)'],
      ['claude-fable-5-1[1m]', 'Fable 5.1'],
      ['sonnet', 'Sonnet 5'],
      ['haiku', 'Haiku 4.5'],
    ]);
    expect(models[0]).toMatchObject({
      isDefault: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      serviceTiers: [{ id: 'fast', label: 'Fast' }],
      styles: [
        { id: 'concise', label: 'Concise' },
        { id: 'explanatory', label: 'Explanatory' },
      ],
      defaultStyle: 'concise',
    });
  });

  it('versions an unknown future Claude family from provider metadata without a family table', () => {
    expect(
      mapClaudeModelCatalog([
        {
          value: 'claude-nova-6-2',
          displayName: 'Nova',
          description: 'Nova 6.2 · A future provider-advertised model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'ultra'],
          supportsFastMode: false,
        },
      ])[0]
    ).toMatchObject({ id: 'claude-nova-6-2', displayName: 'Nova 6.2' });
  });

  it('rejects stale model-specific effort and service-tier choices before a turn', () => {
    const models = [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        reasoningEfforts: ['low', 'high', 'ultra'] as const,
        serviceTiers: [{ id: 'priority', label: 'Fast' }],
        isDefault: true,
      },
    ];

    expect(validateModelSelection(models, 'gpt-6-astra', 'ultra', 'priority')).toBeNull();
    expect(validateModelSelection(models, 'gpt-6-astra', 'medium', null)).toMatch(
      /does not support the “medium” reasoning effort/
    );
    expect(validateModelSelection(models, 'gpt-6-astra', 'high', 'economy')).toMatch(
      /does not support the “economy” service tier/
    );
    expect(validateModelSelection(models, 'removed-model', 'high', null)).toBe(
      userMessageWithValues('assistant.modelUnavailable', {
        model: userMessageValue('removed-model'),
      })
    );
    expect(
      validateModelSelection(
        [{ id: 'haiku', displayName: 'Haiku 4.5', reasoningEfforts: [] }],
        'haiku',
        'high',
        null
      )
    ).toMatch(/does not support the “high” reasoning effort/);
  });

  it('accepts personality only for a model that advertises support', () => {
    const models = [
      {
        id: 'gpt-personality',
        displayName: 'GPT Personality',
        reasoningEfforts: ['high'] as const,
        supportsPersonality: true,
      },
      {
        id: 'gpt-plain',
        displayName: 'GPT Plain',
        reasoningEfforts: ['high'] as const,
        supportsPersonality: false,
      },
    ];

    expect(validateModelSelection(models, 'gpt-personality', 'high', null, 'friendly')).toBeNull();
    expect(validateModelSelection(models, 'gpt-plain', 'high', null, 'friendly')).toMatch(
      /does not support response personality/
    );
  });

  it('projects Grok names and model-specific effort levels from ACP metadata', () => {
    expect(
      mapGrokAcpModelCatalog({
        _meta: {
          modelState: {
            currentModelId: 'grok-future-5.2',
            availableModels: [
              {
                modelId: 'grok-future-5.2',
                name: 'Grok Future 5.2',
                description: 'Future runtime model',
                _meta: {
                  reasoningEffort: 'ultra',
                  reasoningEfforts: [
                    { value: 'ultra', label: 'Ultra' },
                    { value: 'medium', label: 'Medium', default: true },
                  ],
                },
              },
              {
                modelId: 'grok-4.5',
                name: 'Grok 4.5',
                _meta: {
                  reasoningEffort: 'high',
                  reasoningEfforts: [{ value: 'high', label: 'High' }],
                },
              },
            ],
          },
        },
      })
    ).toEqual([
      expect.objectContaining({
        id: 'grok-future-5.2',
        displayName: 'Grok Future 5.2',
        reasoningEfforts: ['ultra', 'medium'],
        defaultReasoningEffort: 'medium',
        isDefault: true,
      }),
      expect.objectContaining({
        id: 'grok-4.5',
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        isDefault: false,
      }),
    ]);
  });

  it('does not invent Grok effort levels when only model ids are available', () => {
    expect(mapGrokModelCatalog(['grok-4.6', 'grok-new'])).toEqual([
      expect.objectContaining({ id: 'grok-4.6', reasoningEfforts: [] }),
      expect.objectContaining({ id: 'grok-new', reasoningEfforts: [] }),
    ]);
  });

  it('preserves duplicate Grok ACP model ids so catalog integrity rejects the response', () => {
    expect(
      mapGrokAcpModelCatalog({
        _meta: {
          modelState: {
            currentModelId: 'grok-4.6',
            availableModels: [
              { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { reasoningEfforts: [] } },
              { modelId: 'grok-4.6', name: 'Grok duplicate', _meta: { reasoningEfforts: [] } },
            ],
          },
        },
      }).map((model) => model.id)
    ).toEqual(['grok-4.6', 'grok-4.6']);
  });
});
