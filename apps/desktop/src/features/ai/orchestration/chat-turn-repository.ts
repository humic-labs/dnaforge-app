import { commitChatTurnTerminalState, type DBChatTurn, type DBChatTurnStatus } from '../../../db';
import {
  nativeFailureMessage,
  nativeFailureStatus,
  nativeTerminalReason,
  parseNativeTerminalReason,
} from '../../../shared/native-turn-failure';

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
    const failure =
      turn.route_kind === 'cli' ? parseNativeTerminalReason(turn.terminal_reason) : null;
    const status: Exclude<DBChatTurnStatus, 'running'> = failure
      ? nativeFailureStatus(failure)
      : 'interrupted';
    const terminal = {
      status,
      terminal_reason: failure ? nativeTerminalReason(failure) : ABANDONED_TURN_REASON,
      error: failure && status === 'failed' ? nativeFailureMessage(failure) : null,
      completed_at: now(),
    };
    const result = await commitChatTurnTerminalState({
      ...terminal,
      turn_id: turn.id,
      conversation_id: conversationId,
      messages: [],
    });
    recovered.push(result.committed ? { ...turn, ...terminal } : turn);
  }
  return recovered;
}
