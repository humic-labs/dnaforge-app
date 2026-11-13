import { useEffect, useState } from 'react';
import {
  type UserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { publicAgentTraceDisplay } from '../../shared/agent-trace-display';
import type { AgentTraceEventShape } from '../../shared/agent-runtime-ipc';
import { useToastStore } from '../../stores/toast-store';
import {
  Button,
  UI_AGENT_TRACE_DETAIL_CLASS,
  UI_AGENT_TRACE_MARKER_CLASS,
  UI_AGENT_TRACE_ROW_CLASS,
  UI_AGENT_TRACE_STATUS_CLASS,
  UI_AGENT_TRACE_TITLE_CLASS,
} from '../ui';

export function AgentTraceRow({ event }: { event: AgentTraceEventShape }) {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const display = publicAgentTraceDisplay(
    {
      ...event.display,
      status: event.display.status ?? event.terminal,
    },
    event.toolCalls
  );
  const status = display.status;
  const accessibleLabel = [display.title, status, display.text].filter(Boolean).join(', ');
  const detailIsCommand = display.kind === 'command';
  useEffect(() => {
    if (display.kind !== 'notification') return;
    const message: UserMessage = display.text
      ? userMessageWithValues('assistant.notificationDetail', {
          title: userMessageValue(display.title),
          detail: userMessageValue(display.text),
        })
      : display.title;
    useToastStore.getState().addToast(message, { definition: 'chat-document-notice' });
  }, [display.kind, display.text, display.title, event.providerItemId, event.sequence]);
  return (
    <div
      className={UI_AGENT_TRACE_ROW_CLASS}
      role="status"
      aria-label={accessibleLabel}
      data-testid="agent-trace-row"
      data-agent-trace-kind={display.kind}
      data-agent-trace-provider-type={event.providerEventType}
      data-agent-trace-tool-call-id={
        event.toolCalls?.length === 1 ? event.toolCalls[0].id : undefined
      }
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span aria-hidden="true" className={UI_AGENT_TRACE_MARKER_CLASS} />
        <span className={UI_AGENT_TRACE_TITLE_CLASS}>{display.title}</span>
        {status && <span className={UI_AGENT_TRACE_STATUS_CLASS}>{status}</span>}
      </div>
      {display.text && (
        <div className={`${UI_AGENT_TRACE_DETAIL_CLASS} ${detailIsCommand ? 'font-mono' : ''}`}>
          {display.text}
        </div>
      )}
      {display.details?.length ? (
        <div className="ml-3.5 mt-1">
          <Button
            type="button"
            aria-expanded={detailsExpanded}
            onClick={() => setDetailsExpanded((expanded) => !expanded)}
          >
            {userMessage(
              detailsExpanded ? 'assistant.actionDetails.hide' : 'assistant.actionDetails.show'
            )}
          </Button>
          {detailsExpanded && (
            <dl data-testid="agent-trace-details" className="mt-1 space-y-1 text-xs">
              {display.details.map((detail, index) => (
                <div key={index} className="flex min-w-0 gap-2">
                  <dt className="shrink-0 font-medium">{detail.label}: </dt>
                  <dd className="min-w-0 break-words">{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </div>
  );
}
