import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_AGENT_PERMISSION_CATALOG as CATALOG,
  BUILT_IN_AGENT_PERMISSIONS,
} from '../../../shared/agent-permissions';
import { chatPermissions, lastTurnPermissions, withPermissions } from './chat-permissions';
import type { ChatTurnSummary } from './chat-store-types';

function turn(id: string, startedAt: number, routeSnapshotJson: string): ChatTurnSummary {
  return {
    id,
    conversationId: 'conv-1',
    routeKind: 'cli',
    hostId: 'codex',
    provider: null,
    model: null,
    transport: 'codex-sdk',
    authorityProfileId: 'codex-sdk:native-workspace-write',
    permissionMode: 'native-cli',
    routeSnapshotJson,
    status: 'completed',
    terminalReason: null,
    error: null,
    startedAt,
    completedAt: startedAt + 1,
  };
}

describe('chat permissions', () => {
  it('keeps the words a chat last ran with, ignoring turns recorded without them', () => {
    const turns = {
      a: turn('a', 1, JSON.stringify({ kind: 'cli', permissions: { claude: 'plan' } })),
      b: turn('b', 3, JSON.stringify({ kind: 'cli', permissions: { claude: 'acceptEdits' } })),
      c: turn('c', 5, JSON.stringify({ kind: 'cli', approvalMode: 'full' })),
      d: turn('d', 2, 'not json'),
    };
    expect(lastTurnPermissions(turns)).toEqual({ claude: 'acceptEdits' });
    expect(chatPermissions({ turns }, CATALOG).claude).toBe('acceptEdits');
  });

  it('prefers words switched in the chat box and falls back to the defaults', () => {
    const turns = {
      a: turn('a', 1, JSON.stringify({ permissions: { codex: ':read-only' } })),
    };
    expect(
      chatPermissions({ turns, permissions: { codex: ':danger-full-access' } }, CATALOG).codex
    ).toBe(':danger-full-access');
    expect(chatPermissions({ turns: {} }, CATALOG)).toEqual(BUILT_IN_AGENT_PERMISSIONS);
    expect(chatPermissions(undefined, CATALOG, { grok: 'auto' }).grok).toBe('auto');
  });

  it('skips words the installed CLI no longer offers', () => {
    const turns = {
      a: turn('a', 1, JSON.stringify({ permissions: { claude: 'plan' } })),
    };
    expect(
      chatPermissions({ turns, permissions: { claude: 'retiredMode' } }, CATALOG, {
        claude: 'acceptEdits',
      }).claude
    ).toBe('plan');
    expect(chatPermissions(undefined, CATALOG, { claude: 'retiredMode' }).claude).toBe(
      CATALOG.defaults.claude
    );
  });

  it('records the words inside the turn route snapshot', () => {
    expect(
      JSON.parse(
        withPermissions(
          JSON.stringify({ kind: 'cli', transport: 'codex-sdk' }),
          BUILT_IN_AGENT_PERMISSIONS
        )
      )
    ).toEqual({ kind: 'cli', transport: 'codex-sdk', permissions: BUILT_IN_AGENT_PERMISSIONS });
  });
});
