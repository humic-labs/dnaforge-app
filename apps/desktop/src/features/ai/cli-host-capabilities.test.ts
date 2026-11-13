import { describe, expect, it } from 'vitest';
import {
  CLI_HOST_CAPABILITY_DESCRIPTORS,
  getCliHostCapabilityDescriptor,
  getCliPersonalityOptions,
  getCliReasoningEffortOptions,
  getCliServiceTierOptions,
  getCliSupportedReasoningEfforts,
  normalizeCliPersonalityForModel,
  normalizeCliServiceTierForModel,
  normalizeCliReasoningEffortForModel,
} from './cli-host-capabilities';

describe('CLI host capability descriptors', () => {
  it('keeps provider effort options transport-specific', () => {
    expect(getCliSupportedReasoningEfforts('codex-sdk')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliSupportedReasoningEfforts('claude-agent-sdk')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getCliSupportedReasoningEfforts('grok-acp')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('uses the selected model effort set and replaces an unsupported saved value', () => {
    const models = [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const,
        defaultReasoningEffort: 'medium' as const,
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
        defaultReasoningEffort: 'medium' as const,
      },
    ];
    expect(
      getCliReasoningEffortOptions('codex-sdk', 'gpt-6-astra', models).map((option) => option.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(normalizeCliReasoningEffortForModel('ultra', 'gpt-5.5', models, 'high')).toBe('high');
  });

  it('does not invent reasoning controls for a runtime model that advertises none', () => {
    const models = [
      {
        id: 'haiku',
        displayName: 'Haiku 4.5',
        reasoningEfforts: [] as const,
        isDefault: true,
      },
    ];

    expect(getCliReasoningEffortOptions('claude-agent-sdk', 'haiku', models)).toEqual([]);
    expect(
      normalizeCliReasoningEffortForModel('high', 'haiku', models, 'high', 'claude-agent-sdk')
    ).toBeNull();
  });

  it('exposes service tiers only for the selected model and clears stale values', () => {
    const models = [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        reasoningEfforts: ['high'] as const,
        serviceTiers: [{ id: 'priority', label: 'Fast', description: 'Priority processing' }],
        defaultServiceTier: null,
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        reasoningEfforts: ['high'] as const,
        serviceTiers: [],
        defaultServiceTier: null,
      },
    ];

    expect(getCliServiceTierOptions('gpt-6-astra', models)).toEqual([
      { value: '', label: 'Standard (provider default)' },
      { value: 'priority', label: 'Fast', description: 'Priority processing' },
    ]);
    expect(normalizeCliServiceTierForModel('priority', 'gpt-6-astra', models)).toBe('priority');
    expect(normalizeCliServiceTierForModel('priority', 'gpt-5.5', models)).toBeNull();
    expect(getCliServiceTierOptions('gpt-5.5', models)).toEqual([]);
  });

  it('exposes personality only for Codex models that advertise it', () => {
    const models = [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        reasoningEfforts: ['high'] as const,
        supportsPersonality: true,
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        reasoningEfforts: ['high'] as const,
        supportsPersonality: false,
      },
    ];

    expect(getCliPersonalityOptions('codex-sdk', 'gpt-6-astra', models)).toEqual([
      { value: '', label: 'Provider default style' },
      { value: 'friendly', label: 'Friendly' },
      { value: 'pragmatic', label: 'Pragmatic' },
      { value: 'none', label: 'No personality' },
    ]);
    expect(getCliPersonalityOptions('claude-agent-sdk', 'gpt-6-astra', models)).toEqual([]);
    expect(getCliPersonalityOptions('codex-sdk', 'gpt-5.5', models)).toEqual([]);
    expect(normalizeCliPersonalityForModel('pragmatic', 'codex-sdk', 'gpt-6-astra', models)).toBe(
      'pragmatic'
    );
    expect(normalizeCliPersonalityForModel('pragmatic', 'codex-sdk', 'gpt-5.5', models)).toBeNull();
  });

  it('uses Claude output styles advertised by the installed runtime', () => {
    const models = [
      {
        id: 'claude-opus-4-7',
        displayName: 'Claude Opus 4.7',
        reasoningEfforts: ['high'] as const,
        styles: [
          { id: 'concise', label: 'Concise' },
          { id: 'explanatory', label: 'Explanatory' },
        ],
        defaultStyle: 'concise',
      },
    ];

    expect(getCliPersonalityOptions('claude-agent-sdk', 'claude-opus-4-7', models)).toEqual([
      { value: '', label: 'Provider default (Concise)' },
      { value: 'concise', label: 'Concise' },
      { value: 'explanatory', label: 'Explanatory' },
    ]);
    expect(
      normalizeCliPersonalityForModel('explanatory', 'claude-agent-sdk', 'claude-opus-4-7', models)
    ).toBe('explanatory');
  });

  it('uses the checked interaction matrix instead of a drifting prose control table', () => {
    for (const descriptor of Object.values(CLI_HOST_CAPABILITY_DESCRIPTORS)) {
      expect(descriptor.version).toBe(2);
      expect(descriptor.defaultReasoningEffort).toBe('high');
      expect(descriptor.interactionMatrix).toBe('agent-interaction-matrix-v1');
      expect('controls' in descriptor).toBe(false);
      expect(getCliReasoningEffortOptions(descriptor.transport)).not.toContainEqual(
        expect.objectContaining({ value: '' })
      );
    }
  });

  it('keeps the model picker contract on every route', () => {
    expect(getCliHostCapabilityDescriptor('codex-sdk').modelControl).toBe('catalog-custom');
    expect(getCliHostCapabilityDescriptor('claude-agent-sdk').modelControl).toBe('catalog-custom');
    expect(getCliHostCapabilityDescriptor('grok-acp').modelControl).toBe('catalog-custom');
  });
});
