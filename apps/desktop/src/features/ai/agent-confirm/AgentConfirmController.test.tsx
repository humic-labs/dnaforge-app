import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentUserInputRequest,
  DestructiveFileConfirmRequest,
} from '../../../shared/agent-confirm-types';
import { AgentConfirmController } from './AgentConfirmController';
import { useAgentUserInputStore } from './agent-user-input-store';
import { useDestructiveConfirmStore } from './destructive-confirm-store';

let requestListener: ((request: DestructiveFileConfirmRequest) => void) | null = null;
let cancelListener: ((requestId: string) => void) | null = null;
let userInputRequestListener: ((request: AgentUserInputRequest) => void) | null = null;
let userInputCancelListener: ((requestId: string) => void) | null = null;
let exposeCancelSubscription = true;
const respond = vi.fn();
const respondUserInput = vi.fn();

vi.mock('../../../platform', () => ({
  platform: () => ({
    agentConfirm: {
      onRequest: (listener: (request: DestructiveFileConfirmRequest) => void) => {
        requestListener = listener;
        return () => {
          requestListener = null;
        };
      },
      ...(exposeCancelSubscription
        ? {
            onCancel: (listener: (requestId: string) => void) => {
              cancelListener = listener;
              return () => {
                cancelListener = null;
              };
            },
          }
        : {}),
      respond,
      onUserInputRequest: (listener: (request: AgentUserInputRequest) => void) => {
        userInputRequestListener = listener;
        return () => {
          userInputRequestListener = null;
        };
      },
      onUserInputCancel: (listener: (requestId: string) => void) => {
        userInputCancelListener = listener;
        return () => {
          userInputCancelListener = null;
        };
      },
      respondUserInput,
    },
  }),
}));

function request(requestId: string): DestructiveFileConfirmRequest {
  return {
    requestId,
    toolName: 'Write',
    operation: 'Overwrite file',
    resolvedPath: '/workspace/example.txt',
  };
}

describe('AgentConfirmController cancellation', () => {
  it('presents an exact application decision with no chat view and only confirms by its explicit button', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        this.open = true;
      },
    });
    try {
      render(<AgentConfirmController />);
      const question: AgentUserInputRequest = {
        requestId: 'native-decision',
        provider: 'application',
        questions: [
          {
            id: 'administration:action-one:revision-two',
            header: 'Publish share',
            prompt: 'Publish exactly the reviewed private project.',
            options: [
              { id: 'confirm', label: 'Continue once', description: 'This revision only.' },
              { id: 'cancel', label: 'Cancel', description: 'Leave unchanged.' },
            ],
            multiSelect: false,
            allowFreeText: false,
          },
        ],
      };
      act(() => userInputRequestListener?.(question));
      expect(screen.getByTestId('administration-approval')).toBeTruthy();
      expect(respondUserInput).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('administration-approval-confirm'));
      expect(respondUserInput).toHaveBeenCalledExactlyOnceWith('native-decision', {
        outcome: 'submitted',
        answers: { 'administration:action-one:revision-two': { selectedOptionIds: ['confirm'] } },
      });
      expect(useAgentUserInputStore.getState().request).toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    }
  });
  beforeEach(() => {
    requestListener = null;
    cancelListener = null;
    exposeCancelSubscription = true;
    respond.mockReset();
    respondUserInput.mockReset();
    useDestructiveConfirmStore.setState({ request: null });
    useAgentUserInputStore.setState({ request: null });
  });

  afterEach(() => {
    cleanup();
    useDestructiveConfirmStore.setState({ request: null });
    useAgentUserInputStore.setState({ request: null });
  });

  it('clears only the exact approval dismissed by main', () => {
    render(<AgentConfirmController />);
    act(() => requestListener?.(request('request-1')));
    act(() => cancelListener?.('request-1'));
    expect(useDestructiveConfirmStore.getState().request).toBeNull();

    act(() => requestListener?.(request('request-2')));
    act(() => cancelListener?.('stale-request'));
    expect(useDestructiveConfirmStore.getState().request?.requestId).toBe('request-2');
  });

  it('keeps the controller available when a partial bridge omits cancel subscription', () => {
    exposeCancelSubscription = false;

    expect(() => render(<AgentConfirmController />)).not.toThrow();
    act(() => requestListener?.(request('request-without-cancel-channel')));

    expect(useDestructiveConfirmStore.getState().request?.requestId).toBe(
      'request-without-cancel-channel'
    );
  });

  it('presents a structured question and clears only its matching cancellation', () => {
    render(<AgentConfirmController />);
    const question: AgentUserInputRequest = {
      requestId: 'question-1',
      provider: 'codex-sdk',
      questions: [
        {
          id: 'method',
          header: 'Method',
          prompt: 'Which method?',
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    };

    act(() => userInputRequestListener?.(question));
    act(() => userInputCancelListener?.('stale-question'));
    expect(useAgentUserInputStore.getState().request?.requestId).toBe('question-1');
    act(() => userInputCancelListener?.('question-1'));
    expect(useAgentUserInputStore.getState().request).toBeNull();
  });

  it('cancels a superseded question instead of leaving two prompt surfaces active', () => {
    render(<AgentConfirmController />);
    const makeQuestion = (requestId: string): AgentUserInputRequest => ({
      requestId,
      provider: 'claude-agent-sdk',
      questions: [
        {
          id: 'q',
          header: 'Question',
          prompt: 'Choose',
          options: [{ id: 'a', label: 'A', description: 'A' }],
          multiSelect: false,
          allowFreeText: false,
        },
      ],
    });

    act(() => userInputRequestListener?.(makeQuestion('question-old')));
    act(() => userInputRequestListener?.(makeQuestion('question-new')));

    expect(respondUserInput).toHaveBeenCalledWith('question-old', {
      outcome: 'cancelled',
      answers: {},
      reason: 'superseded',
    });
    expect(useAgentUserInputStore.getState().request?.requestId).toBe('question-new');
  });
});
