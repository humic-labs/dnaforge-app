import { mainIpc, sendRendererIpc } from '../shared/ipc-contract';
import { type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  AGENT_CONFIRM_DESTRUCTIVE_FILE_CANCEL_CHANNEL,
  AGENT_CONFIRM_DESTRUCTIVE_FILE_CHANNEL,
  AGENT_USER_INPUT_CANCEL_CHANNEL,
  AGENT_USER_INPUT_CHANNEL,
  agentConfirmResponseChannel,
  agentUserInputResponseChannel,
  type AgentUserInputRequest,
  type AgentUserInputResponse,
  type AgentUserInputCancellationReason,
  type DestructiveFileConfirmRequest,
  type DestructiveFileConfirmResponse,
} from '../shared/agent-confirm-types';
import { isAgentApprovalChoice, type AgentApprovalChoice } from '../shared/agent-approval';
import { appendConversationLedgerShadowEvent } from './conversation-ledger/writer';

const DEFAULT_CONFIRM_TIMEOUT_MS = 30 * 60_000;

export function confirmDestructiveFileWithRenderer(
  mainWindow: BrowserWindow | null,
  request: Omit<DestructiveFileConfirmRequest, 'requestId'>,
  timeoutMs: number = DEFAULT_CONFIRM_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<AgentApprovalChoice> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve('deny');
  if (signal?.aborted) return Promise.resolve('deny');

  const requestId = randomUUID();
  const channel = agentConfirmResponseChannel(requestId);

  return new Promise<AgentApprovalChoice>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      mainIpc.removeListener(channel, listener);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    };
    const dismissRenderer = (): void => {
      try {
        sendRendererIpc(mainWindow.webContents, AGENT_CONFIRM_DESTRUCTIVE_FILE_CANCEL_CHANNEL, {
          requestId,
        });
      } catch {}
    };
    const settle = (choice: AgentApprovalChoice, dismiss = false): void => {
      if (settled) return;
      settled = true;
      if (dismiss) dismissRenderer();
      cleanup();
      resolve(choice);
    };
    const listener = (
      _event: unknown,
      response: DestructiveFileConfirmResponse | undefined
    ): void => {
      settle(
        isAgentApprovalChoice(response?.choice)
          ? response.choice
          : response?.allow === true
            ? 'once'
            : 'deny'
      );
    };

    timer = setTimeout(() => settle('deny', true), timeoutMs);
    mainIpc.once(channel, listener);

    try {
      const payload: DestructiveFileConfirmRequest = { ...request, requestId };
      sendRendererIpc(mainWindow.webContents, AGENT_CONFIRM_DESTRUCTIVE_FILE_CHANNEL, payload);
      if (signal) {
        abortListener = () => settle('deny', true);
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }
    } catch {
      settle('deny');
    }
  });
}

const cancelledUserInput = (reason: AgentUserInputCancellationReason): AgentUserInputResponse => ({
  outcome: 'cancelled',
  answers: {},
  reason,
});

function validateUserInputResponse(
  request: Omit<AgentUserInputRequest, 'requestId'>,
  value: unknown
): AgentUserInputResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as { outcome?: unknown; answers?: unknown; reason?: unknown };
  if (response.outcome === 'cancelled') {
    if (response.reason === 'superseded') return cancelledUserInput('superseded');
    if (response.reason === undefined || response.reason === 'user_cancelled')
      return cancelledUserInput('user_cancelled');
    return null;
  }
  if (response.outcome !== 'submitted') return null;
  if (
    !response.answers ||
    typeof response.answers !== 'object' ||
    Array.isArray(response.answers)
  ) {
    return null;
  }

  const questions = new Map(request.questions.map((question) => [question.id, question]));
  const rawAnswers = response.answers as Record<string, unknown>;
  if (Object.keys(rawAnswers).some((questionId) => !questions.has(questionId))) return null;

  const answers: AgentUserInputResponse['answers'] = {};
  for (const question of request.questions) {
    const raw = rawAnswers[question.id];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const candidate = raw as { selectedOptionIds?: unknown; text?: unknown };
    if (!Array.isArray(candidate.selectedOptionIds)) return null;
    const selectedOptionIds = candidate.selectedOptionIds;
    if (!selectedOptionIds.every((id): id is string => typeof id === 'string')) return null;
    if (!question.multiSelect && selectedOptionIds.length > 1) return null;
    const allowedIds = new Set(question.options.map((option) => option.id));
    if (selectedOptionIds.some((id) => !allowedIds.has(id))) return null;
    if (candidate.text !== undefined && typeof candidate.text !== 'string') return null;
    const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
    if (text && !question.allowFreeText) return null;
    if (selectedOptionIds.length === 0 && !text) return null;
    answers[question.id] = {
      selectedOptionIds: [...new Set(selectedOptionIds)],
      ...(text ? { text } : {}),
    };
  }
  return { outcome: 'submitted', answers };
}

export function requestAgentUserInputWithRenderer(
  mainWindow: BrowserWindow | null,
  request: Omit<AgentUserInputRequest, 'requestId'>,
  timeoutMs: number = DEFAULT_CONFIRM_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<AgentUserInputResponse> {
  const requestId = randomUUID();
  const recordOutcome = (response: AgentUserInputResponse): AgentUserInputResponse => {
    if (request.conversationId)
      void appendConversationLedgerShadowEvent({
        conversation_id: request.conversationId,
        source: 'system',
        provider: request.provider,
        model: null,
        stream_event_type: 'agent.user-input.resolved',
        payload: {
          requestId,
          kind: request.approval?.kind ?? 'question',
          outcome: response.outcome,
          ...(response.reason ? { reason: response.reason } : {}),
        },
      });
    return response;
  };
  if (signal?.aborted) return Promise.resolve(recordOutcome(cancelledUserInput('turn_aborted')));
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve(recordOutcome(cancelledUserInput('renderer_unavailable')));
  }

  const channel = agentUserInputResponseChannel(requestId);
  return new Promise<AgentUserInputResponse>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      mainIpc.removeListener(channel, listener);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    };
    const dismissRenderer = (): void => {
      try {
        sendRendererIpc(mainWindow.webContents, AGENT_USER_INPUT_CANCEL_CHANNEL, { requestId });
      } catch {}
    };
    const settle = (response: AgentUserInputResponse, dismiss = false): void => {
      if (settled) return;
      settled = true;
      if (dismiss) dismissRenderer();
      cleanup();
      resolve(recordOutcome(response));
    };
    const listener = (_event: unknown, value: unknown): void => {
      settle(validateUserInputResponse(request, value) ?? cancelledUserInput('invalid_response'));
    };

    timer = setTimeout(() => settle(cancelledUserInput('timeout'), true), timeoutMs);
    mainIpc.once(channel, listener);
    try {
      sendRendererIpc(mainWindow.webContents, AGENT_USER_INPUT_CHANNEL, { ...request, requestId });
      if (signal) {
        abortListener = () => settle(cancelledUserInput('turn_aborted'), true);
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) abortListener();
      }
    } catch {
      settle(cancelledUserInput('delivery_failed'));
    }
  });
}
