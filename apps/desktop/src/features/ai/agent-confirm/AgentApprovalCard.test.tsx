import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentApprovalCard } from './AgentApprovalCard';

function renderCard(onChoose = vi.fn()) {
  render(
    <>
      <textarea aria-label="Chat composer" autoFocus />
      <AgentApprovalCard
        requestId="req-1"
        title="Codex wants to run a command"
        detail={null}
        command="blastn -query My Project/in.fa"
        paths={[{ display: 'My Project/analyses', full: '/data/projects/a/analyses' }]}
        ruleLabel="blastn commands"
        onChoose={onChoose}
      />
    </>
  );
  return onChoose;
}

describe('AgentApprovalCard', () => {
  afterEach(cleanup);

  it('never takes focus when it appears', () => {
    renderCard();
    expect(document.activeElement).toBe(screen.getByLabelText('Chat composer'));
  });

  it('jumps to the choices with Option-Command-A', () => {
    renderCard();
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', altKey: true, metaKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('agent-approval-choices'));
  });

  it('moves with the arrow keys and confirms with Enter once focused', () => {
    const onChoose = renderCard();
    const choices = screen.getByTestId('agent-approval-choices');
    choices.focus();
    fireEvent.keyDown(choices, { key: 'ArrowDown' });
    fireEvent.keyDown(choices, { key: 'ArrowDown' });
    fireEvent.keyDown(choices, { key: 'ArrowUp' });
    fireEvent.keyDown(choices, { key: 'Enter' });
    expect(onChoose).toHaveBeenLastCalledWith('chat');
  });

  it('picks directly with 1 to 5 and denies with Escape', () => {
    const onChoose = renderCard();
    const choices = screen.getByTestId('agent-approval-choices');
    fireEvent.keyDown(choices, { key: '3' });
    expect(onChoose).toHaveBeenLastCalledWith('always');
    fireEvent.keyDown(choices, { key: '5' });
    expect(onChoose).toHaveBeenLastCalledWith('stop');
    fireEvent.keyDown(choices, { key: 'Escape' });
    expect(onChoose).toHaveBeenLastCalledWith('deny');
  });

  it('shows project names and keeps the full path on hover', () => {
    renderCard();
    const path = screen.getByTestId('agent-confirm-path');
    expect(path).toHaveTextContent('My Project/analyses');
    expect(path).toHaveAttribute('title', '/data/projects/a/analyses');
    expect(screen.getByTestId('agent-confirm-command')).toHaveTextContent(
      'blastn -query My Project/in.fa'
    );
  });
});
