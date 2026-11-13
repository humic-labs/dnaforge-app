import { describe, expect, it } from 'vitest';

import type { AgentCapabilityControl } from '../../../shared/agent-capability-controls';
import {
  projectCapabilityIntoLatestUserMessage,
  projectCapabilityInvocation,
} from './execute-cli-turn';

function capability(
  provider: AgentCapabilityControl['provider'],
  kind: AgentCapabilityControl['kind'],
  nativeId: string
): AgentCapabilityControl {
  return {
    id: `${provider}:${kind}:${nativeId}`,
    provider,
    nativeId,
    kind,
    label: nativeId,
    description: 'Fixture capability.',
    scope: 'turn',
    effects: ['instructions'],
    availability: { state: 'supported' },
    stages: {
      advertised: true,
      discoverable: true,
      invocable: true,
      visible: true,
      deterministic: true,
      liveQualified: false,
    },
  };
}

describe('provider capability projection', () => {
  it('projects Claude and Grok commands through their native slash syntax', () => {
    expect(
      projectCapabilityInvocation(
        'claude-agent-sdk',
        capability('claude-agent-sdk', 'command', 'review'),
        'focus on tests'
      )
    ).toBe('/review focus on tests');
    expect(
      projectCapabilityInvocation(
        'grok-acp',
        capability('grok-acp', 'command', 'model'),
        '/model fast'
      )
    ).toBe('/model fast');
  });

  it('projects a Codex skill as an explicit skill mention without duplicating it', () => {
    const skill = capability('codex-sdk', 'skill', 'tdd');
    expect(projectCapabilityInvocation('codex-sdk', skill, 'implement the parser')).toBe(
      '$tdd implement the parser'
    );
    expect(projectCapabilityInvocation('codex-sdk', skill, '$tdd implement the parser')).toBe(
      '$tdd implement the parser'
    );
  });

  it('projects a Grok skill through its provider slash invocation', () => {
    const skill = capability('grok-acp', 'skill', 'review-sequence');
    expect(projectCapabilityInvocation('grok-acp', skill, 'inspect the construct')).toBe(
      '/review-sequence inspect the construct'
    );
    expect(
      projectCapabilityInvocation('grok-acp', skill, '/review-sequence inspect the construct')
    ).toBe('/review-sequence inspect the construct');
  });

  it('preserves app-expanded selection context when projecting a capability', () => {
    const expanded =
      'Inspect this region.\n\n<wp-sel-nonce trust="untrusted-data">descriptor</wp-sel-nonce>';
    const messages = [
      { id: 'assistant-1', role: 'assistant' as const, content: 'Earlier', createdAt: 1 },
      { id: 'user-1', role: 'user' as const, content: expanded, createdAt: 2 },
    ];

    expect(
      projectCapabilityIntoLatestUserMessage(
        'codex-sdk',
        capability('codex-sdk', 'skill', 'tdd'),
        messages
      )
    ).toEqual([
      messages[0],
      {
        ...messages[1],
        content: `$tdd ${expanded}`,
      },
    ]);
  });

  it('rejects cross-provider and browse-only capability kinds', () => {
    expect(() =>
      projectCapabilityInvocation(
        'codex-sdk',
        capability('claude-agent-sdk', 'command', 'review'),
        'changes'
      )
    ).toThrow('different CLI provider');
    expect(() =>
      projectCapabilityInvocation(
        'codex-sdk',
        capability('codex-sdk', 'account', 'account-1'),
        'switch'
      )
    ).toThrow('not turn-invocable');
  });
});
