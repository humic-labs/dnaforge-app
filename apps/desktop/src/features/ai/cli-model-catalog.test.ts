import { describe, expect, it } from 'vitest';
import {
  CLI_CUSTOM_MODEL_SELECT_VALUE,
  CLI_DEFAULT_MODEL_SELECT_VALUE,
  CLI_MODEL_CATALOG_VERSION,
  getCliDefaultModelDisplayLabel,
  getDetectedCliDefaultModel,
  getDetectedCliModels,
  getCliModelCatalogOptions,
  getCliModelDisplayLabel,
  getCliModelSelectValue,
  isCliModelInCatalog,
} from './cli-model-catalog';

describe('CLI model catalog', () => {
  it('keeps the provider default as a real selectable state', () => {
    expect(CLI_MODEL_CATALOG_VERSION).toBe(4);
    expect(getCliModelSelectValue('codex-sdk', null)).toBe(CLI_DEFAULT_MODEL_SELECT_VALUE);
    expect(getCliModelDisplayLabel('claude-agent-sdk', null)).toBe('Provider default model');
    expect(getCliDefaultModelDisplayLabel('codex-sdk', 'gpt-5.5')).toBe('gpt-5.5');
  });

  it('reads detected CLI default models by transport', () => {
    expect(
      getDetectedCliDefaultModel(
        {
          codex: {
            cli: 'installed',
            path: '/usr/local/bin/codex',
            auth: 'authenticated',
            defaultModel: 'gpt-5.5',
            authMode: 'chatgpt',
            authFilePresent: true,
          },
          claudeCode: {
            cli: 'installed',
            path: '/usr/local/bin/claude',
            auth: 'authenticated',
            defaultModel: 'claude-fable-5-preview',
            keychainEntryPresent: true,
            credentialsFilePresent: null,
          },
        },
        'claude-agent-sdk'
      )
    ).toBe('claude-fable-5-preview');
  });

  it('maps live model descriptors to catalog picker values', () => {
    const runtimeModels = [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        reasoningEfforts: ['low', 'high', 'ultra'] as const,
      },
    ];
    expect(getCliModelCatalogOptions('codex-sdk', undefined, runtimeModels)).toEqual([
      expect.objectContaining({ value: 'gpt-6-astra', label: 'GPT-6 Astra' }),
    ]);
    expect(getCliModelSelectValue('codex-sdk', 'gpt-6-astra', undefined, runtimeModels)).toBe(
      'gpt-6-astra'
    );
    expect(isCliModelInCatalog('codex-sdk', 'gpt-6-astra', undefined, runtimeModels)).toBe(true);
    expect(getCliModelDisplayLabel('codex-sdk', 'gpt-6-astra', undefined, runtimeModels)).toBe(
      'GPT-6 Astra'
    );
  });

  it('uses Grok models reported by the installed CLI instead of a hard-coded catalog', () => {
    const runtimeModels = [
      { id: 'grok-4.6', displayName: 'Grok 4.6', reasoningEfforts: ['low', 'high'] as const },
      { id: 'grok-4.5', displayName: 'Grok 4.5', reasoningEfforts: ['low', 'high'] as const },
    ];
    expect(
      getCliModelCatalogOptions('grok-acp', undefined, runtimeModels).map((option) => option.value)
    ).toEqual(['grok-4.6', 'grok-4.5']);
    expect(getCliModelSelectValue('grok-acp', 'grok-4.6', undefined, runtimeModels)).toBe(
      'grok-4.6'
    );
    expect(getCliModelCatalogOptions('grok-acp')).toEqual([]);
  });

  it('does not substitute a built-in Claude alias list when runtime discovery is empty', () => {
    expect(getCliModelCatalogOptions('claude-agent-sdk')).toEqual([]);
    expect(getCliModelSelectValue('claude-agent-sdk', 'fable')).toBe(CLI_CUSTOM_MODEL_SELECT_VALUE);
  });

  it('reads each provider runtime catalog from detection', () => {
    const models = [
      { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', reasoningEfforts: ['high'] as const },
    ];
    expect(
      getDetectedCliModels(
        {
          codex: {
            cli: 'installed',
            path: '/codex',
            auth: 'authenticated',
            defaultModel: 'gpt-6-astra',
            authMode: 'chatgpt',
            authFilePresent: true,
            models: models as any,
          },
          claudeCode: {
            cli: 'missing',
            path: null,
            auth: 'unauthenticated',
            defaultModel: null,
            keychainEntryPresent: null,
            credentialsFilePresent: null,
          },
          grok: {
            cli: 'missing',
            path: null,
            auth: 'unauthenticated',
            defaultModel: null,
          },
        },
        'codex-sdk'
      )
    ).toEqual(models);
  });

  it('keeps unknown CLI-supported model names on the custom path', () => {
    expect(getCliModelSelectValue('claude-agent-sdk', 'claude-opus-4')).toBe(
      CLI_CUSTOM_MODEL_SELECT_VALUE
    );
    expect(isCliModelInCatalog('claude-agent-sdk', 'claude-opus-4')).toBe(false);
    expect(getCliModelDisplayLabel('claude-agent-sdk', 'claude-opus-4')).toBe('claude-opus-4');
  });
});
