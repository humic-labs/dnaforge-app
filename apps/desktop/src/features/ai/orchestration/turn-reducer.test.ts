import { describe, expect, it } from 'vitest';
import {
  createTurnReductionState,
  reduceTurnEvent,
  type NormalizedTurnEvent,
  type TurnTerminalStatus,
} from './turn-reducer';

describe('normalized chat turn reducer', () => {
  it.each<TurnTerminalStatus>(['completed', 'stopped', 'cancelled', 'interrupted', 'failed'])(
    'accepts %s exactly once and ignores later events',
    (status) => {
      const started = reduceTurnEvent(createTurnReductionState('turn-1'), event(1, 'running'));
      const terminal = reduceTurnEvent(started, event(2, status));
      const late = reduceTurnEvent(terminal, event(3, 'assistant-message'));
      const secondTerminal = reduceTurnEvent(late, event(4, 'failed'));

      expect(terminal.status).toBe(status);
      expect(terminal.terminalSequence).toBe(2);
      expect(late).toEqual(terminal);
      expect(secondTerminal).toEqual(terminal);
    }
  );

  it('ignores duplicate and out-of-order event sequences', () => {
    const started = reduceTurnEvent(createTurnReductionState('turn-1'), event(2, 'running'));
    const duplicate = reduceTurnEvent(started, event(2, 'assistant-message'));
    const stale = reduceTurnEvent(started, event(1, 'assistant-message'));

    expect(duplicate).toEqual(started);
    expect(stale).toEqual(started);
  });

  it('retains a completed tool lifecycle when a late active update arrives', () => {
    const requested = reduceTurnEvent(
      createTurnReductionState('turn-1'),
      event(1, 'tool', { toolCallId: 'call-1', toolStatus: 'requested' })
    );
    const completed = reduceTurnEvent(
      requested,
      event(2, 'tool', { toolCallId: 'call-1', toolStatus: 'completed' })
    );
    const lateRunning = reduceTurnEvent(
      completed,
      event(3, 'tool', { toolCallId: 'call-1', toolStatus: 'running' })
    );

    expect(lateRunning.toolCalls.get('call-1')?.status).toBe('completed');
    expect(lateRunning.lastSequence).toBe(3);
  });
});

function event(
  sequence: number,
  kind: NormalizedTurnEvent['kind'],
  overrides: Partial<NormalizedTurnEvent> = {}
): NormalizedTurnEvent {
  return {
    turnId: 'turn-1',
    sequence,
    kind,
    ...overrides,
  } as NormalizedTurnEvent;
}
