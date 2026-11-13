import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { QueuedChatMessage } from '../../features/ai/orchestration/chat-store-types';
import { QueuedMessageStack } from './QueuedMessageStack';

const messages: QueuedChatMessage[] = [
  {
    id: 'queued-one',
    content: 'First queued message',
    workspacePath: '/workspace',
    referenceIds: [],
    routeSelection: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
    routeSnapshot: {
      routeKind: 'provider',
      hostId: 'direct-api',
      provider: 'openai',
      model: 'gpt-4o',
      transport: null,
      authorityProfileId: null,
      permissionMode: null,
      routeSnapshotJson: JSON.stringify({ kind: 'provider', provider: 'openai', model: 'gpt-4o' }),
    },
    createdAt: 1,
  },
  {
    id: 'queued-two',
    content: 'Second queued message',
    workspacePath: '/workspace',
    referenceIds: [],
    routeSelection: { kind: 'provider', provider: 'openai', model: 'gpt-4o' },
    routeSnapshot: {
      routeKind: 'provider',
      hostId: 'direct-api',
      provider: 'openai',
      model: 'gpt-4o',
      transport: null,
      authorityProfileId: null,
      permissionMode: null,
      routeSnapshotJson: JSON.stringify({ kind: 'provider', provider: 'openai', model: 'gpt-4o' }),
    },
    createdAt: 2,
  },
];

function renderStack(onAdvanceThrough = vi.fn()) {
  return {
    onAdvanceThrough,
    ...render(
      <QueuedMessageStack
        messages={messages}
        referenceMap={new Map()}
        referenceResolution={new Map()}
        onReferenceClick={vi.fn()}
        onAdvanceThrough={onAdvanceThrough}
        onMessageElementChange={vi.fn()}
      />
    ),
  };
}

describe('QueuedMessageStack', () => {
  it('renders the attached FIFO rows with an advance control beside each clock indicator', () => {
    renderStack();

    const stack = screen.getByTestId('queued-chat-stack');
    const rows = within(stack).getAllByTestId('queued-chat-message');
    expect(stack).toHaveClass('mx-4');
    expect(stack).not.toHaveClass('mx-1.5');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('First queued message');
    expect(rows[0]).toHaveClass(
      'w-full',
      'rounded-t-2xl',
      'border-b-0',
      'bg-bg-muted/70',
      'dark:bg-bg-muted'
    );
    expect(rows[0]).not.toHaveClass('bg-accent/10', 'border-accent/30');
    expect(rows[1]).toHaveTextContent('Second queued message');
    expect(rows[1]).not.toHaveClass('rounded-t-2xl');

    for (const [index, row] of rows.entries()) {
      const controls = within(row).getByTestId('queued-chat-controls');
      const indicator = within(controls).getByTestId('queued-chat-indicator');
      const advance = within(controls).getByTestId('advance-queued-message');
      expect(indicator).toHaveAccessibleName(`Queued message ${index + 1} of 2`);
      expect(advance).toHaveAccessibleName(`Advance queue through message ${index + 1} of 2`);
      expect(indicator.nextElementSibling).toBe(advance);
    }
  });

  it('identifies the clicked FIFO target without changing its order', () => {
    const onAdvanceThrough = vi.fn();
    renderStack(onAdvanceThrough);

    fireEvent.click(screen.getAllByTestId('advance-queued-message')[1]);

    expect(onAdvanceThrough).toHaveBeenCalledTimes(1);
    expect(onAdvanceThrough).toHaveBeenCalledWith('queued-two');
  });
});
