import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentUserInputRequest,
  AgentUserInputResponse,
} from '../../../shared/agent-confirm-types';
import { InlineAgentConfirmationHost, InlineAgentQuestion } from './InlineAgentConfirmation';
import { useAgentUserInputStore } from './agent-user-input-store';

const respondUserInput = vi.hoisted(() => vi.fn());

vi.mock('../../../platform', () => ({
  platform: () => ({ agentConfirm: { respondUserInput } }),
}));

const baseRequest: AgentUserInputRequest = {
  requestId: 'question-request-1',
  conversationId: 'conversation-1',
  provider: 'claude-agent-sdk',
  questions: [
    {
      id: 'assembly-method',
      header: 'Assembly',
      prompt: 'Which assembly method should the agent use?',
      options: [
        { id: 'gibson', label: 'Gibson', description: 'Overlap-based assembly' },
        { id: 'golden-gate', label: 'Golden Gate', description: 'Type IIS assembly' },
      ],
      multiSelect: false,
      allowFreeText: true,
      defaultOptionIds: ['gibson'],
    },
  ],
};

describe('InlineAgentQuestion', () => {
  afterEach(() => {
    cleanup();
    useAgentUserInputStore.getState().clear();
    respondUserInput.mockReset();
  });

  it('uses the existing inline confirmation surface and submits stable option IDs', () => {
    const onSubmit = vi.fn<(response: AgentUserInputResponse) => void>();
    render(<InlineAgentQuestion request={baseRequest} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const card = screen.getByTestId('agent-confirm-inline');
    expect(card).toHaveTextContent('Which assembly method should the agent use?');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('radio', { name: /Gibson/ })).toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: /Golden Gate/ }));
    fireEvent.click(screen.getByTestId('agent-question-submit'));

    expect(onSubmit).toHaveBeenCalledWith({
      outcome: 'submitted',
      answers: {
        'assembly-method': { selectedOptionIds: ['golden-gate'] },
      },
    });
  });

  it('supports multi-select and free-text answers in the same request', () => {
    const onSubmit = vi.fn<(response: AgentUserInputResponse) => void>();
    render(
      <InlineAgentQuestion
        request={{
          ...baseRequest,
          questions: [
            {
              id: 'enzymes',
              header: 'Enzymes',
              prompt: 'Which enzymes are available?',
              options: [
                { id: 'bsai', label: 'BsaI', description: 'Four-base overhangs' },
                { id: 'bsmbi', label: 'BsmBI', description: 'Alternative Type IIS enzyme' },
              ],
              multiSelect: true,
              allowFreeText: false,
            },
            {
              id: 'constraint',
              header: 'Constraint',
              prompt: 'Add an optional constraint',
              options: [],
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /BsaI/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /BsmBI/ }));
    fireEvent.change(screen.getByLabelText('Add an optional constraint'), {
      target: { value: 'Keep the destination vector unchanged' },
    });
    fireEvent.click(screen.getByTestId('agent-question-submit'));

    expect(onSubmit).toHaveBeenCalledWith({
      outcome: 'submitted',
      answers: {
        enzymes: { selectedOptionIds: ['bsai', 'bsmbi'] },
        constraint: {
          selectedOptionIds: [],
          text: 'Keep the destination vector unchanged',
        },
      },
    });
  });

  it('uses a password control for provider-declared secret input', () => {
    render(
      <InlineAgentQuestion
        request={{
          ...baseRequest,
          questions: [
            {
              id: 'token',
              header: 'Credential',
              prompt: 'Enter the temporary token',
              options: [],
              multiSelect: false,
              allowFreeText: true,
              secret: true,
            },
          ],
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByLabelText('Enter the temporary token')).toHaveAttribute('type', 'password');
  });

  it('reports explicit cancellation without manufacturing an answer', () => {
    const onCancel = vi.fn<(response: AgentUserInputResponse) => void>();
    render(<InlineAgentQuestion request={baseRequest} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId('agent-question-cancel'));

    expect(onCancel).toHaveBeenCalledWith({ outcome: 'cancelled', answers: {} });
  });

  it('routes the answer from the owning chat host over the shared confirmation bridge', () => {
    useAgentUserInputStore.getState().present(baseRequest);
    render(<InlineAgentConfirmationHost conversationId="conversation-1" scoped isActive />);

    fireEvent.click(screen.getByTestId('agent-question-submit'));

    expect(respondUserInput).toHaveBeenCalledWith('question-request-1', {
      outcome: 'submitted',
      answers: {
        'assembly-method': { selectedOptionIds: ['gibson'] },
      },
    });
    expect(useAgentUserInputStore.getState().request).toBeNull();
  });
});
