import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', () => ({
  commitChatTurnTerminalState: vi.fn(),
}));

import { commitChatTurnTerminalState, type DBChatTurn } from '../../../db';
import { recoverInterruptedChatTurns } from './chat-turn-repository';

describe('chat turn repository', () => {
  beforeEach(() => {
    vi.mocked(commitChatTurnTerminalState).mockReset();
    vi.mocked(commitChatTurnTerminalState).mockResolvedValue({ committed: true });
  });

  it('atomically marks only abandoned running turns interrupted', async () => {
    const completed = turn('turn-completed', 'completed');
    const running = turn('turn-running', 'running');

    const recovered = await recoverInterruptedChatTurns('conv-1', [completed, running], () => 99);

    expect(commitChatTurnTerminalState).toHaveBeenCalledTimes(1);
    expect(commitChatTurnTerminalState).toHaveBeenCalledWith({
      turn_id: 'turn-running',
      conversation_id: 'conv-1',
      status: 'interrupted',
      terminal_reason: 'App exited before the turn completed.',
      error: null,
      completed_at: 99,
      messages: [],
    });
    expect(recovered).toEqual([
      completed,
      expect.objectContaining({
        id: 'turn-running',
        status: 'interrupted',
        terminal_reason: 'App exited before the turn completed.',
        completed_at: 99,
      }),
    ]);
  });

  it('does not invent an interrupted projection when another terminal commit already won', async () => {
    vi.mocked(commitChatTurnTerminalState).mockResolvedValue({ committed: false });
    const running = turn('turn-running', 'running');

    await expect(recoverInterruptedChatTurns('conv-1', [running], () => 99)).resolves.toEqual([
      running,
    ]);
  });
});

function turn(id: string, status: DBChatTurn['status']): DBChatTurn {
  return {
    id,
    conversation_id: 'conv-1',
    route_kind: 'provider',
    host_id: 'direct-api',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    transport: null,
    authority_profile_id: null,
    permission_mode: null,
    route_snapshot_json: '{}',
    status,
    terminal_reason: status === 'completed' ? 'completed' : null,
    error: null,
    started_at: 1,
    completed_at: status === 'completed' ? 2 : null,
  };
}
