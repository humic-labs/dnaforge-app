import {
  renderUserMessagePayload,
  toUserMessage,
  toOptionalUserMessage,
  userMessage,
} from '@waypoint/user-messages';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { platform } from '../../../platform';
import type {
  AgentUserInputRequest,
  AgentUserInputResponse,
  DestructiveFileConfirmRequest,
} from '../../../shared/agent-confirm-types';
import { useToastStore } from '../../../stores/toast-store';
import { useAgentUserInputStore } from './agent-user-input-store';
import { useDestructiveConfirmStore } from './destructive-confirm-store';
import { AgentApprovalCard } from './AgentApprovalCard';
import {
  AGENT_APPROVAL_QUESTION_ID,
  approvalChoiceAllows,
  publicAgentApprovalRule,
  type AgentApprovalChoice,
} from '../../../shared/agent-approval';

interface ConfirmationHostRegistration {
  id: symbol;
  conversationId: string | null;
  scoped: boolean;
  isActive: boolean;
}

const confirmationHosts = new Map<symbol, ConfirmationHostRegistration>();
const confirmationHostListeners = new Set<() => void>();
let confirmationHostVersion = 0;

function publishConfirmationHostChange(): void {
  confirmationHostVersion += 1;
  for (const listener of confirmationHostListeners) listener();
}

function subscribeToConfirmationHosts(listener: () => void): () => void {
  confirmationHostListeners.add(listener);
  return () => confirmationHostListeners.delete(listener);
}

function getConfirmationHostVersion(): number {
  return confirmationHostVersion;
}

function selectConfirmationHost(request: { conversationId?: string | null }): symbol | null {
  const visibleHosts = [...confirmationHosts.values()].filter((host) => host.isActive);
  if (request.conversationId) {
    return visibleHosts.find((host) => host.conversationId === request.conversationId)?.id ?? null;
  }
  return visibleHosts.find((host) => !host.scoped)?.id ?? null;
}

function respondToCurrentUserInput(requestId: string, response: AgentUserInputResponse): boolean {
  const current = useAgentUserInputStore.getState().request;
  if (!current || current.requestId !== requestId) return false;
  try {
    platform().agentConfirm?.respondUserInput?.(requestId, response);
  } finally {
    useAgentUserInputStore.getState().clear();
  }
  return true;
}

function respondToCurrentRequest(requestId: string, choice: AgentApprovalChoice): boolean {
  const current = useDestructiveConfirmStore.getState().request;
  if (!current || current.requestId !== requestId) return false;
  try {
    platform().agentConfirm?.respond?.(requestId, {
      allow: approvalChoiceAllows(choice),
      choice,
    });
  } finally {
    useDestructiveConfirmStore.getState().clear();
  }
  return true;
}

function denyRequestAfterLastHostCloses(requestId: string): void {
  queueMicrotask(() => {
    const current = useDestructiveConfirmStore.getState().request;
    if (!current || current.requestId !== requestId) return;
    if (confirmationHosts.size > 0) return;
    try {
      if (!respondToCurrentRequest(requestId, 'deny')) return;
      useToastStore
        .getState()
        .addToast(userMessage('notice.agent-request-denied-because-its-chat-was-closed'), {
          definition: 'inline-agent-confirmation-agent-request-denied-because-its-chat-was-closed',
        });
    } catch (error) {
      console.error('[AgentConfirm] Failed to deny request after its chat closed:', error);
    }
  });
}

function cancelUserInputAfterLastHostCloses(requestId: string): void {
  queueMicrotask(() => {
    const current = useAgentUserInputStore.getState().request;
    if (
      !current ||
      current.provider === 'application' ||
      current.requestId !== requestId ||
      confirmationHosts.size > 0
    )
      return;
    try {
      if (!respondToCurrentUserInput(requestId, { outcome: 'cancelled', answers: {} })) return;
      useToastStore
        .getState()
        .addToast(userMessage('notice.agent-turn-cancelled-because-its-chat-was-closed'), {
          definition: 'inline-agent-confirmation-agent-turn-cancelled-because-its-chat-was-closed',
        });
    } catch (error) {
      console.error('[AgentConfirm] Failed to cancel question after its chat closed:', error);
    }
  });
}

export function destructiveApprovalCard(request: DestructiveFileConfirmRequest) {
  const isShellCommand = request.toolName === 'Bash' || request.toolName === 'ProcessStart';
  const rule = request.rule ? publicAgentApprovalRule(request.rule) : null;
  return {
    title: userMessage(isShellCommand ? 'assistant.approval.command' : 'assistant.approval.file'),
    detail: isShellCommand
      ? userMessage(
          request.risk === 'destructive'
            ? 'approval.commandDestructive'
            : request.risk === 'read-only'
              ? 'approval.commandReadOnly'
              : request.risk === 'mutating'
                ? 'approval.commandMutating'
                : 'approval.commandUnknown'
        )
      : request.operationMessage
        ? renderUserMessagePayload(request.operationMessage, 'assistant.approval.detail')
        : toUserMessage(request.operation, 'assistant.approval.detail'),
    command: request.displayCommand ?? request.command ?? null,
    paths: request.resolvedPath
      ? [{ display: request.displayPath ?? request.resolvedPath, full: request.resolvedPath }]
      : [],
    ruleLabel:
      rule?.label ?? userMessage(isShellCommand ? 'approval.commandRule' : 'approval.fileRule'),
    ruleMessage: rule?.catalogMessage,
  };
}

type DraftAnswers = Record<string, { selectedOptionIds: string[]; text: string }>;

function initialQuestionAnswers(request: AgentUserInputRequest): DraftAnswers {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      {
        selectedOptionIds: (question.defaultOptionIds ?? []).filter((id) =>
          question.options.some((option) => option.id === id)
        ),
        text: '',
      },
    ])
  );
}

export function InlineAgentQuestion({
  request,
  onSubmit,
  onCancel,
}: {
  request: AgentUserInputRequest;
  onSubmit: (response: AgentUserInputResponse) => void;
  onCancel: (response: AgentUserInputResponse) => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const initialAnswers = useMemo(() => initialQuestionAnswers(request), [request]);
  const [answers, setAnswers] = useState<DraftAnswers>(initialAnswers);

  useEffect(() => {
    setAnswers(initialAnswers);
    cardRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [initialAnswers, request.requestId]);

  const chooseOption = (questionId: string, optionId: string, multiSelect: boolean): void => {
    setAnswers((current) => {
      const answer = current[questionId] ?? { selectedOptionIds: [], text: '' };
      const selectedOptionIds = multiSelect
        ? answer.selectedOptionIds.includes(optionId)
          ? answer.selectedOptionIds.filter((id) => id !== optionId)
          : [...answer.selectedOptionIds, optionId]
        : [optionId];
      return { ...current, [questionId]: { ...answer, selectedOptionIds } };
    });
  };

  const submit = (): void => {
    const submitted = Object.fromEntries(
      request.questions.map((question) => {
        const answer = answers[question.id] ?? { selectedOptionIds: [], text: '' };
        const text = answer.text.trim();
        return [
          question.id,
          {
            selectedOptionIds: answer.selectedOptionIds,
            ...(text ? { text } : {}),
          },
        ];
      })
    );
    onSubmit({ outcome: 'submitted', answers: submitted });
  };

  const complete = request.questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer && (answer.selectedOptionIds.length > 0 || answer.text.trim()));
  });

  return (
    <section
      ref={cardRef}
      className="mb-4 rounded-xl border border-accent/30 bg-accent/5 px-3.5 py-3"
      data-testid="agent-confirm-inline"
      role="region"
      aria-live="polite"
      aria-label="Agent question"
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-accent" />
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <h2 className="text-sm font-medium text-fg">Agent needs your input</h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              Your answer continues the current agent turn.
            </p>
          </div>

          {request.questions.map((question) => {
            const answer = answers[question.id] ?? { selectedOptionIds: [], text: '' };
            const inputType = question.multiSelect ? 'checkbox' : 'radio';
            return (
              <fieldset key={question.id} className="space-y-2">
                <legend className="text-xs font-medium text-fg">
                  <span className="mr-2 text-fg-muted">{question.header}</span>
                  {question.prompt}
                </legend>
                {question.options.map((option) => (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg px-2.5 py-2 text-xs hover:bg-bg-muted"
                  >
                    <input
                      type={inputType}
                      name={`agent-question-${request.requestId}-${question.id}`}
                      checked={answer.selectedOptionIds.includes(option.id)}
                      onChange={() => chooseOption(question.id, option.id, question.multiSelect)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block font-medium text-fg">{option.label}</span>
                      <span className="block text-fg-muted">{option.description}</span>
                      {option.preview ? (
                        <span className="mt-1 block font-mono text-fg-muted">{option.preview}</span>
                      ) : null}
                    </span>
                  </label>
                ))}
                {question.allowFreeText ? (
                  <input
                    type={question.secret ? 'password' : 'text'}
                    aria-label={
                      question.options.length === 0
                        ? question.prompt
                        : `Other answer for ${question.header}`
                    }
                    value={answer.text}
                    onChange={(event) => {
                      const text = event.currentTarget.value;
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: { ...answer, text },
                      }));
                    }}
                    placeholder={question.options.length === 0 ? 'Type your answer' : 'Other…'}
                    className="w-full rounded-md border border-border bg-bg px-2.5 py-2 text-xs text-fg outline-none focus:border-accent"
                  />
                ) : null}
              </fieldset>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onCancel({ outcome: 'cancelled', answers: {} })}
              className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-bg-muted"
              data-testid="agent-question-cancel"
            >
              Cancel turn
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!complete}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="agent-question-submit"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function InlineAgentConfirmationHost({
  conversationId,
  scoped,
  isActive = true,
}: {
  conversationId: string | null;
  scoped: boolean;
  isActive?: boolean;
}) {
  const destructiveRequest = useDestructiveConfirmStore((state) => state.request);
  const userInputRequest = useAgentUserInputStore((state) => state.request);
  const request =
    userInputRequest?.provider === 'application' ? null : (userInputRequest ?? destructiveRequest);
  const hostTokenRef = useRef<symbol>(Symbol('agent-confirm-host'));
  const latestRegistrationRef = useRef({ conversationId, scoped, isActive });
  latestRegistrationRef.current = { conversationId, scoped, isActive };
  useSyncExternalStore(
    subscribeToConfirmationHosts,
    getConfirmationHostVersion,
    getConfirmationHostVersion
  );

  useLayoutEffect(() => {
    const latest = latestRegistrationRef.current;
    const registration: ConfirmationHostRegistration = {
      id: hostTokenRef.current,
      ...latest,
    };
    confirmationHosts.set(registration.id, registration);
    publishConfirmationHostChange();
    return () => {
      confirmationHosts.delete(registration.id);
      publishConfirmationHostChange();
      const pendingRequest = useDestructiveConfirmStore.getState().request;
      if (pendingRequest) denyRequestAfterLastHostCloses(pendingRequest.requestId);
      const pendingUserInput = useAgentUserInputStore.getState().request;
      if (pendingUserInput) cancelUserInputAfterLastHostCloses(pendingUserInput.requestId);
    };
  }, []);

  useLayoutEffect(() => {
    const registration = confirmationHosts.get(hostTokenRef.current);
    if (!registration) return;
    confirmationHosts.set(hostTokenRef.current, {
      ...registration,
      conversationId,
      scoped,
      isActive,
    });
    publishConfirmationHostChange();
  }, [conversationId, isActive, scoped]);

  const isPresenter = Boolean(request && selectConfirmationHost(request) === hostTokenRef.current);

  const respond = useCallback((requestId: string, choice: AgentApprovalChoice) => {
    respondToCurrentRequest(requestId, choice);
  }, []);

  if (!request || !isPresenter) return null;

  if (userInputRequest?.approval) {
    const approval = userInputRequest.approval;
    return (
      <AgentApprovalCard
        requestId={userInputRequest.requestId}
        title={approval.title}
        detail={toOptionalUserMessage(approval.detail)}
        command={approval.command}
        paths={approval.paths}
        ruleLabel={approval.rule.label}
        ruleMessage={approval.rule.catalogMessage}
        onChoose={(choice) =>
          respondToCurrentUserInput(userInputRequest.requestId, {
            outcome: 'submitted',
            answers: { [AGENT_APPROVAL_QUESTION_ID]: { selectedOptionIds: [choice] } },
          })
        }
      />
    );
  }

  if (userInputRequest) {
    return (
      <InlineAgentQuestion
        request={userInputRequest}
        onSubmit={(response) => respondToCurrentUserInput(userInputRequest.requestId, response)}
        onCancel={(response) => respondToCurrentUserInput(userInputRequest.requestId, response)}
      />
    );
  }

  const confirmation = destructiveRequest as DestructiveFileConfirmRequest;
  return (
    <AgentApprovalCard
      requestId={confirmation.requestId}
      {...destructiveApprovalCard(confirmation)}
      onChoose={(choice) => respond(confirmation.requestId, choice)}
    />
  );
}
