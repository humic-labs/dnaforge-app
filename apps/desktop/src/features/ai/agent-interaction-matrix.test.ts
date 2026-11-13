import { describe, expect, it } from 'vitest';

import {
  AGENT_INTERACTION_MATRIX,
  AGENT_INTERACTION_MODES,
  type AgentInteractionCell,
} from './agent-interaction-matrix';

const PROVIDERS = ['claude-agent-sdk', 'codex-sdk', 'grok-acp'] as const;

function requiresException(cell: AgentInteractionCell): boolean {
  return cell.agentSupport !== 'not-advertised' && (cell.bridge !== 'full' || cell.ui !== 'full');
}

describe('agent interaction capability matrix', () => {
  it('has one complete provider cell for every audited interaction mode', () => {
    expect(AGENT_INTERACTION_MODES.length).toBeGreaterThanOrEqual(35);
    expect(new Set(AGENT_INTERACTION_MODES.map((mode) => mode.id)).size).toBe(
      AGENT_INTERACTION_MODES.length
    );

    for (const mode of AGENT_INTERACTION_MODES) {
      const row = AGENT_INTERACTION_MATRIX[mode.id];
      expect(row.label).toBe(mode.label);
      expect(Object.keys(row.providers).sort()).toEqual([...PROVIDERS].sort());
      for (const provider of PROVIDERS) {
        const cell = row.providers[provider];
        expect(cell.evidence.source.length).toBeGreaterThan(0);
        expect(cell.evidence.token.length).toBeGreaterThan(0);
        expect(cell.userLoss.length).toBeGreaterThan(0);
      }
    }
  });

  it('makes every carried native gap an owned, user-readable, removable exception', () => {
    for (const row of Object.values(AGENT_INTERACTION_MATRIX)) {
      for (const [provider, cell] of Object.entries(row.providers)) {
        if (!requiresException(cell)) continue;
        expect(cell.exception, `${provider}/${row.id}`).toEqual({
          owner: expect.any(String),
          userVisibleReason: expect.any(String),
          removalCondition: expect.any(String),
        });
        expect(cell.exception?.owner.trim().length, `${provider}/${row.id} owner`).toBeGreaterThan(
          0
        );
        expect(
          cell.exception?.userVisibleReason.trim().length,
          `${provider}/${row.id} reason`
        ).toBeGreaterThan(0);
        expect(
          cell.exception?.removalCondition.trim().length,
          `${provider}/${row.id} removal condition`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('does not confuse adjacent protocol tokens with an interactive capability', () => {
    expect(AGENT_INTERACTION_MATRIX['command.slash'].providers['codex-sdk'].agentSupport).toBe(
      'not-advertised'
    );
    expect(
      AGENT_INTERACTION_MATRIX['memory.native_reset'].providers['claude-agent-sdk'].agentSupport
    ).toBe('not-advertised');
    expect(AGENT_INTERACTION_MATRIX['auth.logout'].providers['claude-agent-sdk'].agentSupport).toBe(
      'not-advertised'
    );
  });

  it('records the completed capability workflows as full bridge and UI coverage', () => {
    const full = (
      id: keyof typeof AGENT_INTERACTION_MATRIX,
      provider: (typeof PROVIDERS)[number]
    ) =>
      expect(AGENT_INTERACTION_MATRIX[id].providers[provider]).toMatchObject({
        bridge: 'full',
        ui: 'full',
      });

    for (const provider of PROVIDERS) {
      full('command.custom', provider);
      full('skill.invoke', provider);
      full('memory.manage', provider);
      full('plugin.manage', provider);
      full('session.fork', provider);
      full('session.history', provider);
      full('attachment.input', provider);
      full('output.structured', provider);
    }
    full('command.slash', 'claude-agent-sdk');
    full('command.slash', 'grok-acp');
    full('memory.native_reset', 'codex-sdk');
    full('memory.native_reset', 'grok-acp');
  });

  it('records Grok commands as runtime-discovered ACP metadata', () => {
    expect(AGENT_INTERACTION_MATRIX['command.slash'].providers['grok-acp']).toMatchObject({
      agentSupport: 'native',
      evidence: {
        source: 'grok-acp-runtime-meta',
        token: 'availableCommands',
      },
    });
  });
});
