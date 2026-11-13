import { commitChatTurnTerminalState, type DBChatTurn } from '../../../db';

export const ABANDONED_TURN_REASON = 'App exited before the turn completed.';

export async function recoverInterruptedChatTurns(
  conversationId: string,
  turns: DBChatTurn[],
  now = Date.now
): Promise<DBChatTurn[]> {
  const recovered: DBChatTurn[] = [];
  for (const turn of turns) {
    if (turn.status !== 'running') {
      recovered.push(turn);
      continue;
    }
    const completedAt = now();
    const result = await commitChatTurnTerminalState({
      turn_id: turn.id,
      conversation_id: conversationId,
      status: 'interrupted',
      terminal_reason: ABANDONED_TURN_REASON,
      error: null,
      completed_at: completedAt,
      messages: [],
    });
    recovered.push(
      result.committed
        ? {
            ...turn,
            status: 'interrupted',
            terminal_reason: ABANDONED_TURN_REASON,
            completed_at: completedAt,
          }
        : turn
    );
  }
  return recovered;
}
