import { renderUserMessagePayload, type UserMessagePayload } from '@waypoint/user-messages';
import { toUserMessage, toOptionalUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import {
  AGENT_APPROVAL_CHOICE_DESCRIPTIONS,
  AGENT_APPROVAL_CHOICE_LABELS,
  AGENT_APPROVAL_CHOICES,
  type AgentApprovalChoice,
  type AgentApprovalPath,
} from '../../../shared/agent-approval';

const CHOICE_TEST_IDS: Record<AgentApprovalChoice, string> = {
  once: 'agent-confirm-allow',
  chat: 'agent-approval-choice-chat',
  always: 'agent-approval-choice-always',
  deny: 'agent-confirm-deny',
  stop: 'agent-approval-choice-stop',
};

export interface AgentApprovalCardProps {
  requestId: string;
  title: UserMessage;
  detail: UserMessage | null;
  command: string | null;
  paths: readonly AgentApprovalPath[];
  ruleLabel: UserMessage;
  ruleMessage?: UserMessagePayload;
  onChoose: (choice: AgentApprovalChoice) => void;
}

export function AgentApprovalCard({
  requestId,
  title: incomingTitle,
  detail: incomingDetail,
  command,
  paths,
  ruleLabel: incomingRuleLabel,
  ruleMessage,
  onChoose,
}: AgentApprovalCardProps) {
  const title = toUserMessage(incomingTitle, 'assistant.approval.permission');
  const detail = toOptionalUserMessage(incomingDetail, 'assistant.approval.detail');
  const ruleLabel = ruleMessage
    ? renderUserMessagePayload(ruleMessage)
    : toUserMessage(incomingRuleLabel, 'assistant.approval.rule');
  const cardRef = useRef<HTMLElement>(null);
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    setHighlighted(0);
    cardRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [requestId]);

  useEffect(() => {
    const focusChoices = (event: globalThis.KeyboardEvent): void => {
      if (!event.altKey || !(event.metaKey || event.ctrlKey) || event.code !== 'KeyA') return;
      event.preventDefault();
      cardRef.current
        ?.querySelector<HTMLElement>('[data-testid="agent-approval-choices"]')
        ?.focus();
    };
    window.addEventListener('keydown', focusChoices);
    return () => window.removeEventListener('keydown', focusChoices);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= AGENT_APPROVAL_CHOICES.length) {
      event.preventDefault();
      onChoose(AGENT_APPROVAL_CHOICES[digit - 1]);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted(
        (current) =>
          (current + step + AGENT_APPROVAL_CHOICES.length) % AGENT_APPROVAL_CHOICES.length
      );
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onChoose(AGENT_APPROVAL_CHOICES[highlighted]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onChoose('deny');
    }
  };

  const optionId = (choice: AgentApprovalChoice) => `agent-approval-${requestId}-${choice}`;

  return (
    <section
      ref={cardRef}
      className="mb-4 rounded-xl border border-amber-500/40 bg-bg px-3.5 py-3"
      data-testid="agent-confirm-inline"
      role="region"
      aria-live="polite"
      aria-label={title}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-amber-500"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-fg">{title}</h2>
          {detail ? <p className="mt-0.5 text-xs text-fg-muted">{detail}</p> : null}

          {command || paths.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {command ? (
                <p
                  className="break-all rounded-md bg-bg-muted px-2 py-1.5 font-mono text-xs text-fg"
                  data-testid="agent-confirm-command"
                >
                  $ {command}
                </p>
              ) : null}
              {paths.map((path) => (
                <p
                  key={path.full}
                  title={path.full}
                  className="break-all rounded-md bg-bg-muted px-2 py-1.5 font-mono text-xs text-fg"
                  data-testid="agent-confirm-path"
                >
                  {path.display}
                </p>
              ))}
            </div>
          ) : null}

          <div
            role="listbox"
            tabIndex={0}
            aria-label="Your answer"
            aria-activedescendant={optionId(AGENT_APPROVAL_CHOICES[highlighted])}
            onKeyDown={onKeyDown}
            className="mt-3 space-y-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            data-testid="agent-approval-choices"
          >
            {AGENT_APPROVAL_CHOICES.map((choice, index) => {
              const active = index === highlighted;
              return (
                <div
                  key={choice}
                  id={optionId(choice)}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onChoose(choice)}
                  onMouseEnter={() => setHighlighted(index)}
                  className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 text-xs ${
                    active ? 'bg-accent/10 text-fg' : 'text-fg hover:bg-bg-muted'
                  }`}
                  data-testid={CHOICE_TEST_IDS[choice]}
                >
                  <span className="w-3 flex-shrink-0 text-fg-muted">{index + 1}</span>
                  <span className="font-medium">{AGENT_APPROVAL_CHOICE_LABELS[choice]}</span>
                  <span className="min-w-0 truncate text-fg-muted">
                    {choice === 'always'
                      ? `${AGENT_APPROVAL_CHOICE_DESCRIPTIONS.always} (${ruleLabel})`
                      : choice === 'chat'
                        ? `${AGENT_APPROVAL_CHOICE_DESCRIPTIONS.chat} (${ruleLabel})`
                        : AGENT_APPROVAL_CHOICE_DESCRIPTIONS[choice]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
