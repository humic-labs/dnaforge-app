import { useEffect } from 'react';

import { platform } from '../../../platform';
import { useAgentUserInputStore } from './agent-user-input-store';
import { useDestructiveConfirmStore } from './destructive-confirm-store';
import { SafeAgentApprovalDialog } from '../../../components/SafeAgentApprovalDialog';

export function AgentConfirmController() {
  const present = useDestructiveConfirmStore((state) => state.present);
  const clear = useDestructiveConfirmStore((state) => state.clear);
  const presentUserInput = useAgentUserInputStore((state) => state.present);
  const clearUserInput = useAgentUserInputStore((state) => state.clear);
  const userInput = useAgentUserInputStore((state) => state.request);

  useEffect(() => {
    const confirm = platform().agentConfirm;
    if (!confirm?.onRequest) return;
    const unsubscribeRequest = confirm.onRequest((incoming) => {
      const pendingUserInput = useAgentUserInputStore.getState().request;
      if (pendingUserInput) {
        confirm.respondUserInput?.(pendingUserInput.requestId, {
          outcome: 'cancelled',
          answers: {},
          reason: 'superseded',
        });
        clearUserInput();
      }
      const current = useDestructiveConfirmStore.getState().request;
      if (current && current.requestId !== incoming.requestId) {
        try {
          confirm.respond(current.requestId, { allow: false });
        } catch (error) {
          console.error('[AgentConfirm] Failed to deny superseded request:', error);
        }
      }
      present(incoming);
    });
    const unsubscribeCancel =
      confirm.onCancel?.((requestId) => {
        if (useDestructiveConfirmStore.getState().request?.requestId === requestId) {
          clear();
        }
      }) ?? (() => {});
    const unsubscribeUserInputRequest =
      confirm.onUserInputRequest?.((incoming) => {
        const currentApproval = useDestructiveConfirmStore.getState().request;
        if (currentApproval) {
          try {
            confirm.respond(currentApproval.requestId, { allow: false });
          } finally {
            clear();
          }
        }
        const currentQuestion = useAgentUserInputStore.getState().request;
        if (currentQuestion && currentQuestion.requestId !== incoming.requestId) {
          confirm.respondUserInput?.(currentQuestion.requestId, {
            outcome: 'cancelled',
            answers: {},
            reason: 'superseded',
          });
        }
        presentUserInput(incoming);
      }) ?? (() => {});
    const unsubscribeUserInputCancel =
      confirm.onUserInputCancel?.((requestId) => {
        if (useAgentUserInputStore.getState().request?.requestId === requestId) {
          clearUserInput();
        }
      }) ?? (() => {});
    return () => {
      unsubscribeRequest();
      unsubscribeCancel();
      unsubscribeUserInputRequest();
      unsubscribeUserInputCancel();
    };
  }, [clear, clearUserInput, present, presentUserInput]);

  if (userInput?.provider !== 'application') return null;
  const question = userInput.questions[0];
  if (!question) return null;
  const respond = (allow: boolean) => {
    if (useAgentUserInputStore.getState().request?.requestId !== userInput.requestId) return;
    platform().agentConfirm.respondUserInput?.(userInput.requestId, {
      outcome: allow ? 'submitted' : 'cancelled',
      answers: allow ? { [question.id]: { selectedOptionIds: ['confirm'] } } : {},
    });
    clearUserInput();
  };
  return (
    <SafeAgentApprovalDialog
      key={userInput.requestId}
      title={question.header}
      body={<p className="whitespace-pre-line text-sm text-fg-muted">{question.prompt}</p>}
      allowLabel="Continue once"
      denyLabel="Cancel"
      onAllow={() => respond(true)}
      onDeny={() => respond(false)}
      testId="administration-approval"
      allowTestId="administration-approval-confirm"
      denyTestId="administration-approval-cancel"
    />
  );
}
