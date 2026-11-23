import type { ChatSendOptions } from './chat-store-types';

export type ChatCancellationReason =
  | 'user_stop'
  | 'queue_advance'
  | 'conversation_deleted'
  | 'unknown';

export type SubmissionEffects = Pick<ChatSendOptions, 'onStarted' | 'onNotStarted'>;

type ExecutionPhase =
  | 'claimed'
  | 'preparing'
  | 'running'
  | 'streaming'
  | 'settling'
  | 'unsettled'
  | 'settled';
type Execution = {
  phase: ExecutionPhase;
  turnId: string | null;
  controller: AbortController | null;
  cancellation: ChatCancellationReason | null;
};

export class ConversationExecution {
  private execution: Execution | null = null;
  private drain: symbol | null = null;
  private advanceTarget: string | null = null;
  private submissions = new Map<string, SubmissionEffects>();
  private deleted = false;

  get isDeleted(): boolean {
    return this.deleted;
  }
  get isClaimed(): boolean {
    return this.execution !== null;
  }
  get isDraining(): boolean {
    return this.drain !== null;
  }
  get target(): string | null {
    return this.advanceTarget;
  }

  claim() {
    if (this.execution || this.deleted) return null;
    const execution: Execution = {
      phase: 'claimed',
      turnId: null,
      controller: null,
      cancellation: null,
    };
    this.execution = execution;
    return {
      isCurrent: () => this.execution === execution,
      acceptTurn: (turnId: string) => {
        if (this.execution !== execution || this.deleted) return;
        execution.turnId = turnId;
        execution.phase = 'running';
      },
      release: () => {
        if (this.execution !== execution) return;
        if (execution.turnId && execution.phase !== 'settled' && !this.deleted) {
          execution.phase = 'unsettled';
          execution.controller = null;
          return;
        }
        this.execution = null;
      },
    };
  }

  attachController(controller: AbortController): void {
    const execution = this.execution;
    if (!execution) return;
    execution.controller = controller;
    execution.phase = 'preparing';
    if (this.deleted || execution.cancellation) {
      controller.abort(this.deleted ? 'conversation_deleted' : execution.cancellation);
    }
  }

  cancel(reason: ChatCancellationReason): boolean {
    const execution = this.execution;
    if (!execution) return false;
    execution.cancellation = reason;
    execution.controller?.abort(reason);
    return true;
  }

  detachController(): void {
    if (!this.execution) return;
    this.execution.controller = null;
    this.execution.cancellation = null;
  }

  providerPhase(controller: AbortController, phase: 'streaming' | 'settling'): boolean {
    const execution = this.execution;
    if (!execution || execution.controller !== controller || this.deleted) return false;
    if (execution.phase === 'settled' || execution.phase === 'unsettled') return false;
    execution.phase = phase;
    return true;
  }

  beginSettlement(turnId: string): void {
    if (this.execution?.turnId !== turnId || this.deleted) return;
    if (this.execution.phase !== 'settled') this.execution.phase = 'settling';
  }

  committed(turnId: string): void {
    if (this.execution?.turnId !== turnId || this.deleted) return;
    this.execution.phase = 'settled';
    this.execution.turnId = null;
  }

  projection() {
    const execution = this.execution;
    return {
      isLoading: !!execution && execution.phase !== 'claimed',
      isStreaming: execution?.phase === 'streaming',
      activeTurnId: execution?.turnId ?? null,
    };
  }

  beginDrain(): (() => void) | null {
    if (this.drain || this.deleted) return null;
    const token = Symbol();
    this.drain = token;
    return () => {
      if (this.drain === token) this.drain = null;
    };
  }

  requestAdvance(messageId: string): void {
    this.advanceTarget = messageId;
  }
  clearAdvance(): void {
    this.advanceTarget = null;
  }

  submitted(messageId: string, effects: SubmissionEffects): void {
    this.submissions.set(messageId, effects);
  }

  takeSubmission(messageId: string): SubmissionEffects | undefined {
    const effects = this.submissions.get(messageId);
    this.submissions.delete(messageId);
    return effects;
  }

  disposeQueue(): void {
    this.submissions.clear();
    this.advanceTarget = null;
  }

  markDeleted(): void {
    this.deleted = true;
    this.cancel('conversation_deleted');
  }

  restoreAfterRejectedDelete(): void {
    this.deleted = false;
  }
}

const conversations = new Map<string, ConversationExecution>();

export function conversationExecution(conversationId: string): ConversationExecution {
  let execution = conversations.get(conversationId);
  if (!execution) {
    execution = new ConversationExecution();
    conversations.set(conversationId, execution);
  }
  return execution;
}

export function resetConversationExecutionsForTests(): void {
  conversations.clear();
}

export function claimConversationExecution(key: string, conversationId: string) {
  if (conversationExecution(key).isClaimed) return null;
  const owner = conversationExecution(conversationId);
  const claim = owner.claim();
  if (!claim) return null;
  conversations.set(key, owner);
  return {
    ...claim,
    release: () => {
      claim.release();
      if (key !== conversationId && !owner.isClaimed && conversations.get(key) === owner) {
        conversations.delete(key);
      }
    },
  };
}
