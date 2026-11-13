import { describe, expect, it, vi } from 'vitest';

const { mockExecute, mockCreateChatTurnWithUserMessage, mockCommitChatTurnTerminalState } =
  vi.hoisted(() => ({
    mockExecute: vi.fn(),
    mockCreateChatTurnWithUserMessage: vi.fn().mockResolvedValue(undefined),
    mockCommitChatTurnTerminalState: vi.fn().mockResolvedValue({ committed: true }),
  }));

vi.mock('../platform', () => ({
  platform: () => ({
    db: {
      execute: mockExecute,
      select: vi.fn(),
      createChatTurnWithUserMessage: mockCreateChatTurnWithUserMessage,
      commitChatTurnTerminalState: mockCommitChatTurnTerminalState,
    },
  }),
}));

import {
  commitChatTurnTerminalState,
  createChatTurnWithUserMessage,
  type DBChatTurn,
  type DBMessage,
} from './index';

describe('chat turn persistence', () => {
  it('delegates initial turn/message creation to one atomic platform bridge call', async () => {
    const turn: DBChatTurn = {
      id: 'turn-1',
      conversation_id: 'conv-1',
      route_kind: 'cli',
      host_id: 'codex-cli',
      provider: null,
      model: null,
      transport: 'codex-sdk',
      authority_profile_id: 'codex-sdk:native-cli',
      permission_mode: 'native-cli',
      route_snapshot_json: '{"kind":"cli","transport":"codex-sdk"}',
      status: 'running',
      terminal_reason: null,
      error: null,
      started_at: 10,
      completed_at: null,
    };
    const message: DBMessage = {
      id: 'msg-1',
      conversation_id: 'conv-1',
      turn_id: null,
      role: 'user',
      content: 'Start a long chat',
      tool_name: null,
      tool_call_id: null,
      created_at: 11,
    };

    await createChatTurnWithUserMessage({ turn, message });

    expect(mockCreateChatTurnWithUserMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateChatTurnWithUserMessage).toHaveBeenCalledWith({ turn, message });
    expect(mockExecute).not.toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockExecute).not.toHaveBeenCalledWith('COMMIT');
    expect(mockExecute).not.toHaveBeenCalledWith('ROLLBACK');
  });

  it('delegates terminal state and transcript writes to one atomic platform bridge call', async () => {
    const input = {
      turn_id: 'turn-1',
      conversation_id: 'conv-1',
      status: 'completed' as const,
      terminal_reason: 'completed',
      error: null,
      completed_at: 20,
      messages: [],
    };

    await expect(commitChatTurnTerminalState(input)).resolves.toEqual({ committed: true });
    expect(mockCommitChatTurnTerminalState).toHaveBeenCalledWith(input);
  });
});
