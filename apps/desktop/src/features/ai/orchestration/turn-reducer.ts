export type TurnTerminalStatus = 'completed' | 'stopped' | 'cancelled' | 'interrupted' | 'failed';

export type TurnReductionStatus = 'created' | 'running' | TurnTerminalStatus;
export type ToolLifecycleStatus = 'requested' | 'running' | 'completed' | 'failed';

export type NormalizedTurnEvent =
  | { turnId: string; sequence: number; kind: 'running' }
  | { turnId: string; sequence: number; kind: 'assistant-message'; messageId?: string }
  | {
      turnId: string;
      sequence: number;
      kind: 'tool';
      toolCallId: string;
      toolStatus: ToolLifecycleStatus;
    }
  | { turnId: string; sequence: number; kind: TurnTerminalStatus };

export interface ReducedToolCall {
  id: string;
  status: ToolLifecycleStatus;
  sequence: number;
}

export interface TurnReductionState {
  turnId: string;
  status: TurnReductionStatus;
  lastSequence: number;
  terminalSequence: number | null;
  toolCalls: ReadonlyMap<string, ReducedToolCall>;
}

const TERMINAL = new Set<TurnReductionStatus>([
  'completed',
  'stopped',
  'cancelled',
  'interrupted',
  'failed',
]);

function isTerminalStatus(value: NormalizedTurnEvent['kind']): value is TurnTerminalStatus {
  return TERMINAL.has(value as TurnReductionStatus);
}

const TOOL_RANK: Record<ToolLifecycleStatus, number> = {
  requested: 0,
  running: 1,
  completed: 2,
  failed: 2,
};

export function createTurnReductionState(turnId: string): TurnReductionState {
  return {
    turnId,
    status: 'created',
    lastSequence: -1,
    terminalSequence: null,
    toolCalls: new Map(),
  };
}

export function reduceTurnEvent(
  state: TurnReductionState,
  event: NormalizedTurnEvent
): TurnReductionState {
  if (event.turnId !== state.turnId || event.sequence <= state.lastSequence) return state;
  if (TERMINAL.has(state.status)) return state;

  if (event.kind === 'tool') {
    const current = state.toolCalls.get(event.toolCallId);
    const nextToolCalls = new Map(state.toolCalls);
    if (!current || TOOL_RANK[event.toolStatus] >= TOOL_RANK[current.status]) {
      nextToolCalls.set(event.toolCallId, {
        id: event.toolCallId,
        status: event.toolStatus,
        sequence: event.sequence,
      });
    }
    return { ...state, lastSequence: event.sequence, toolCalls: nextToolCalls };
  }

  if (isTerminalStatus(event.kind)) {
    return {
      ...state,
      status: event.kind,
      lastSequence: event.sequence,
      terminalSequence: event.sequence,
    };
  }

  return {
    ...state,
    status: event.kind === 'running' ? 'running' : state.status,
    lastSequence: event.sequence,
  };
}
