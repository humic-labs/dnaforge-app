import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { DBEntityReference } from '../../db/entity-references';
import type { DBConversation, DBMessage } from '../../db';
import type { PendingAskAiPicker } from '../../features/ai/hooks/useChat';

const h = vi.hoisted(() => ({
  picker: null as PendingAskAiPicker | null,
  newConversation: vi.fn(),
  setPendingDraft: vi.fn(),
  setPendingAskAiPicker: vi.fn(),
  setAskAiInlineChat: vi.fn(),
  switchConversation: vi.fn(),
  sendMessage: vi.fn(),
  retargetChatTab: vi.fn(),
  getConversations: vi.fn(),
  getRecentMessages: vi.fn(),
}));

vi.mock('../../features/ai/hooks/useChat', () => {
  const snapshot = () => ({
    pendingAskAiPicker: h.picker,
    newConversation: h.newConversation,
    setPendingDraft: h.setPendingDraft,
    setPendingAskAiPicker: h.setPendingAskAiPicker,
    setAskAiInlineChat: h.setAskAiInlineChat,
    switchConversation: h.switchConversation,
    sendMessage: h.sendMessage,
  });
  const useChatStore = (selector: (s: unknown) => unknown) => selector(snapshot());
  useChatStore.getState = snapshot;
  return { useChatStore };
});

vi.mock('../../features/canvas/store', () => ({
  useCanvasStore: { getState: () => ({ retargetChatTab: h.retargetChatTab }) },
}));

vi.mock('../../db', () => ({
  getConversations: (...args: unknown[]) => h.getConversations(...args),
  getRecentMessages: (...args: unknown[]) => h.getRecentMessages(...args),
}));

import { AskAiPickerHost } from './AskAiPickerHost';

function makeRef(overrides: Partial<DBEntityReference> = {}): DBEntityReference {
  return {
    id: 'ref-1',
    entity_type: 'sequence_region',
    display_label: 'pUC19.gb 123–456',
    locator: 'git://workspace/pUC19.gb',
    deep_link_params: null,
    data: null,
    source: 'user',
    status: 'created',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function makePicker(overrides: Partial<PendingAskAiPicker> = {}): PendingAskAiPicker {
  return { reference: makeRef(), chatWorkspacePath: '/ws/proj', ...overrides };
}

function makeConv(id: string, updatedAt: number, title = id): DBConversation {
  return {
    id,
    title,
    workspace_path: '/ws/proj',
    pinned: 0,
    provider: null,
    model: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function makeMsg(
  id: string,
  conversationId: string,
  role: DBMessage['role'],
  content: string
): DBMessage {
  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    tool_name: null,
    tool_call_id: null,
    created_at: 1,
  };
}

function activeTestId(): string | null {
  const el = document.querySelector('[data-testid="ask-ai-picker-targets"] [data-active="true"]');
  return el?.getAttribute('data-testid') ?? null;
}

function newBadgeActive(): boolean {
  return screen.queryByTestId('ask-ai-picker-new-badge')?.getAttribute('data-active') === 'true';
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.picker = null;
  h.newConversation.mockResolvedValue('new-conv-id');
  h.getConversations.mockResolvedValue([]);
  h.getRecentMessages.mockResolvedValue([]);
});

describe('AskAiPickerHost  P4)', () => {
  it('renders nothing when there is no staged picker', () => {
    h.picker = null;
    const { container } = render(<AskAiPickerHost />);
    expect(container.firstChild).toBeNull();
  });

  it('flies out anchored at the right-click origin with NO scrim / blur', async () => {
    h.picker = makePicker({ anchor: { x: 320, y: 240 } });
    render(<AskAiPickerHost />);

    const outer = await screen.findByTestId('ask-ai-picker');
    const card = screen.getByTestId('ask-ai-picker-card');

    expect(outer.getAttribute('data-anchored')).toBe('true');
    expect(outer.className).not.toContain('bg-black');
    expect(outer.className).not.toContain('backdrop-blur');
    expect(outer.className).not.toContain('justify-center');
    expect(outer.className).not.toContain('pt-[12vh]');

    expect(card.style.position).toBe('fixed');
    expect(parseInt(card.style.left, 10)).toBeGreaterThanOrEqual(320);
    expect(card.style.top).toBe('240px');
    expect(card.style.width).toBe('640px');
    expect(card.className).not.toContain('max-w-xl');
    expect(card.className).toContain('shadow-lg');
  });

  it('falls back to a centered card when NO anchor is provided (structure / `/` callers)', async () => {
    h.picker = makePicker();
    render(<AskAiPickerHost />);

    const outer = await screen.findByTestId('ask-ai-picker');
    const card = screen.getByTestId('ask-ai-picker-card');

    expect(outer.getAttribute('data-anchored')).toBe('false');
    expect(outer.className).not.toContain('bg-black');
    expect(outer.className).not.toContain('backdrop-blur');
    expect(outer.className).toContain('justify-center');
    expect(card.className).toContain('max-w-xl');
    expect(card.style.position).toBe('');
  });

  it('stages the selection chip in the header and auto-focuses the input', async () => {
    h.picker = makePicker();
    render(<AskAiPickerHost />);

    expect(await screen.findByTestId('ask-ai-picker')).toBeTruthy();
    const header = screen.getByTestId('ask-ai-picker-chip');
    expect(within(header).getByTestId('ref-chip-ref-1')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('ask-ai-picker-input'));
  });

  it('defaults the destination to New at open (badge shown) even with existing conversations, and the badge DISAPPEARS after one ↓', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-a', 300), makeConv('conv-b', 100)]);
    h.getRecentMessages.mockResolvedValue([]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');

    expect(newBadgeActive()).toBe(true);
    expect(activeTestId()).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-targets')).toBeNull();
    expect(screen.getByTestId('ask-ai-picker-confirm-label').textContent).toBe('Start new chat');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-a'));
    expect(newBadgeActive()).toBe(false);
    expect(screen.queryByTestId('ask-ai-picker-new-badge')).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-expand-hint')).toBeNull();
    expect(screen.getByTestId('ask-ai-picker-confirm-label').textContent).toBe('Add to "conv-a"');
  });

  it('with an empty bucket the card stays collapsed at New: no list, no preview, and NO discovery hint', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([]);
    render(<AskAiPickerHost />);

    await screen.findByTestId('ask-ai-picker-input');
    await new Promise((r) => setTimeout(r, 20));

    expect(newBadgeActive()).toBe(true);
    expect(screen.queryByTestId('ask-ai-picker-targets')).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-preview')).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-draft')).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-expand-hint')).toBeNull();
    expect(screen.getByTestId('ask-ai-picker-confirm-label').textContent).toBe('Start new chat');
  });

  it('sorts the existing list by argmax(updated_at) (not pinned-first); ↓ from New lands on the most-recent', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([
      makeConv('conv-old', 100),
      makeConv('conv-new', 300),
      makeConv('conv-mid', 200),
    ]);
    h.getRecentMessages.mockResolvedValue([makeMsg('m1', 'conv-new', 'assistant', 'hi there')]);

    render(<AskAiPickerHost />);
    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');

    expect(newBadgeActive()).toBe(true);
    expect(activeTestId()).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-targets')).toBeNull();
    expect(h.getRecentMessages).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-new'));
    await waitFor(() => expect(h.getRecentMessages).toHaveBeenCalledWith('conv-new', 3));
    expect(h.switchConversation).not.toHaveBeenCalled();
  });

  it('renders the preview as chat messages (markdown + role bubbles), NOT a raw role-labeled dump', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-1', 300)]);
    h.getRecentMessages.mockResolvedValue([
      makeMsg('a1', 'conv-1', 'assistant', 'Here is **conserved** motif `ATG`'),
      makeMsg('u1', 'conv-1', 'user', 'Why conserved?'),
    ]);

    render(<AskAiPickerHost />);
    const input = await screen.findByTestId('ask-ai-picker-input');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-1'));

    const messages = await screen.findAllByTestId('ask-ai-picker-preview-message');
    expect(messages.length).toBe(2);
    expect(messages.map((m) => m.getAttribute('data-role')).sort()).toEqual(['assistant', 'user']);

    expect(screen.getByText('conserved').tagName).toBe('STRONG');
    expect(screen.getByText('ATG').tagName).toBe('CODE');

    expect(screen.queryByText(/^assistant:/)).toBeNull();
    expect(screen.queryByText(/\*\*conserved\*\*/)).toBeNull();

    expect(h.switchConversation).not.toHaveBeenCalled();
  });

  it('renders a tool message in the preview as a ToolResultDisplay chip, not raw JSON', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-1', 300)]);
    h.getRecentMessages.mockResolvedValue([
      {
        ...makeMsg(
          't1',
          'conv-1',
          'tool',
          JSON.stringify({ input: { path: 'pUC19.gb' }, output: { label: 'pUC19.gb' } })
        ),
        tool_name: 'open_tab',
      },
    ]);

    render(<AskAiPickerHost />);
    const input = await screen.findByTestId('ask-ai-picker-input');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-1'));

    const message = await screen.findByTestId('ask-ai-picker-preview-message');
    expect(message.getAttribute('data-role')).toBe('tool');
    expect(screen.getByTestId('tool-result')).toBeTruthy();
    expect(screen.queryByTestId('tool-result-reactivate')).toBeNull();
    expect(screen.queryByText(/"output"/)).toBeNull();
  });

  it('moves the cursor with bare ↑/↓ and updates the preview target', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-new', 300), makeConv('conv-old', 100)]);
    h.getRecentMessages.mockImplementation((id: string) =>
      Promise.resolve([makeMsg(`m-${id}`, id, 'user', `content of ${id}`)])
    );

    render(<AskAiPickerHost />);
    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');

    expect(newBadgeActive()).toBe(true);
    expect(activeTestId()).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-targets')).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-new'));
    await waitFor(() => expect(h.getRecentMessages).toHaveBeenCalledWith('conv-new', 3));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-old'));
    await waitFor(() => expect(h.getRecentMessages).toHaveBeenCalledWith('conv-old', 3));

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-new'));
    expect(newBadgeActive()).toBe(false);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() => expect(newBadgeActive()).toBe(true));
    expect(activeTestId()).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-targets')).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-preview')).toBeNull();
    expect(screen.queryByTestId('ask-ai-picker-draft')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(newBadgeActive()).toBe(true);

    expect(h.switchConversation).not.toHaveBeenCalled();
  });

  it('anchored flyout focuses the input on open and ↑/↓ fired on the ACTIVE element navigate', async () => {
    h.picker = makePicker({ anchor: { x: 320, y: 240 } });
    h.getConversations.mockResolvedValue([makeConv('c-new', 300), makeConv('c-old', 100)]);
    h.getRecentMessages.mockResolvedValue([makeMsg('m', 'c-new', 'user', 'hi')]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');

    expect(document.activeElement).toBe(input);
    expect(newBadgeActive()).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-c-new'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-c-old'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-c-new'));
  });

  it('reclaims focus when the surface underneath steals it, so ↑/↓ keep navigating', async () => {
    const thief = document.createElement('button');
    thief.setAttribute('data-testid', 'focus-thief');
    document.body.appendChild(thief);
    try {
      h.picker = makePicker({ anchor: { x: 320, y: 240 } });
      h.getConversations.mockResolvedValue([makeConv('c-new', 300), makeConv('c-old', 100)]);
      h.getRecentMessages.mockResolvedValue([makeMsg('m', 'c-new', 'user', 'hi')]);
      render(<AskAiPickerHost />);

      const input = await screen.findByTestId('ask-ai-picker-input');
      await screen.findByTestId('ask-ai-picker-expand-hint');
      expect(document.activeElement).toBe(input);

      thief.focus();
      expect(document.activeElement).toBe(thief);

      await waitFor(() => expect(document.activeElement).toBe(input));

      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-c-new'));
    } finally {
      document.body.removeChild(thief);
    }
  });

  it('leaves focus alone when it moves to a target row INSIDE the card (no fighting the user)', async () => {
    h.picker = makePicker({ anchor: { x: 320, y: 240 } });
    h.getConversations.mockResolvedValue([makeConv('c-new', 300)]);
    h.getRecentMessages.mockResolvedValue([makeMsg('m', 'c-new', 'user', 'hi')]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const row = await screen.findByTestId('ask-ai-picker-target-c-new');

    row.focus();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(row);
  });

  const firePointer = (
    el: Element,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    init: { clientX?: number; clientY?: number; button?: number }
  ) => {
    fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  };

  it('drags the anchored flyout by its header and the clamp does not snap it back', async () => {
    h.picker = makePicker({ anchor: { x: 100, y: 240 } });
    render(<AskAiPickerHost />);

    const card = await screen.findByTestId('ask-ai-picker-card');
    const header = screen.getByTestId('ask-ai-picker-chip');
    await waitFor(() => expect(card.style.left).not.toBe(''));

    const startLeft = parseInt(card.style.left, 10);
    const startTop = parseInt(card.style.top, 10);

    firePointer(header, 'pointerdown', { button: 0, clientX: 350, clientY: 250 });
    firePointer(header, 'pointermove', { clientX: 450, clientY: 400 });
    firePointer(header, 'pointerup', { clientX: 450, clientY: 400 });

    expect(parseInt(card.style.left, 10)).toBe(startLeft + 100);
    expect(parseInt(card.style.top, 10)).toBe(startTop + 150);

    fireEvent(window, new Event('resize'));
    await new Promise((r) => setTimeout(r, 0));
    expect(parseInt(card.style.left, 10)).toBe(startLeft + 100);
    expect(parseInt(card.style.top, 10)).toBe(startTop + 150);
  });

  it('does not start a drag from an interactive control inside the header chip', async () => {
    h.picker = makePicker({ anchor: { x: 320, y: 240 } });
    render(<AskAiPickerHost />);

    const card = await screen.findByTestId('ask-ai-picker-card');
    await waitFor(() => expect(card.style.left).not.toBe(''));
    const startLeft = parseInt(card.style.left, 10);
    const startTop = parseInt(card.style.top, 10);

    const button = document.createElement('button');
    screen.getByTestId('ask-ai-picker-chip').appendChild(button);
    firePointer(button, 'pointerdown', { button: 0, clientX: 350, clientY: 250 });
    firePointer(screen.getByTestId('ask-ai-picker-chip'), 'pointermove', {
      clientX: 500,
      clientY: 500,
    });

    expect(parseInt(card.style.left, 10)).toBe(startLeft);
    expect(parseInt(card.style.top, 10)).toBe(startTop);
  });

  it('Enter on New creates a conversation, retargets one tab, and seeds a draft (never sends)', async () => {
    h.picker = makePicker({
      chatWorkspacePath: '/ws/proj',
      sourcePanelId: 'panel-source',
    });
    h.getConversations.mockResolvedValue([]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    await waitFor(() => expect(newBadgeActive()).toBe(true));

    fireEvent.change(input, { target: { value: 'Why is this region conserved?' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    expect(h.newConversation).toHaveBeenCalledWith('/ws/proj');
    expect(h.retargetChatTab).not.toHaveBeenCalled();
    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'new-conv-id',
        workspacePath: '/ws/proj',
        sourcePanelId: 'panel-source',
      })
    );
    expect(h.setPendingDraft).toHaveBeenCalledWith({
      conversationId: 'new-conv-id',
      text: 'Why is this region conserved?',
      references: [h.picker.reference],
    });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.setPendingAskAiPicker).toHaveBeenCalledWith(null);
  });

  it('Enter on an older conversation retargets to that id WITHOUT creating a new conversation', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-new', 300), makeConv('conv-old', 100)]);
    h.getRecentMessages.mockResolvedValue([
      makeMsg('m1', 'conv-old', 'assistant', 'earlier answer'),
    ]);

    render(<AskAiPickerHost />);
    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-old'));

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    expect(h.newConversation).not.toHaveBeenCalled();
    expect(h.retargetChatTab).not.toHaveBeenCalled();
    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-old' })
    );
    expect(h.setPendingDraft).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-old', references: [h.picker.reference] })
    );
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('omits draft text when the question is left blank', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    await waitFor(() => expect(newBadgeActive()).toBe(true));

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    expect(h.setPendingDraft).toHaveBeenCalledWith(expect.objectContaining({ text: undefined }));
  });

  it('Esc cancels the picker without staging or sending anything', async () => {
    h.picker = makePicker();
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(h.setPendingAskAiPicker).toHaveBeenCalledWith(null);
    expect(h.setPendingDraft).not.toHaveBeenCalled();
    expect(h.newConversation).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('CRUX: type-then-arrow and arrow-then-type converge on the SAME destination + text (order-independent)', async () => {
    const makeConvs = () => [makeConv('conv-recent', 300), makeConv('conv-old', 100)];
    h.getConversations.mockResolvedValue(makeConvs());
    h.getRecentMessages.mockResolvedValue([]);

    h.picker = makePicker();
    render(<AskAiPickerHost />);
    let input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');
    expect(newBadgeActive()).toBe(true);

    fireEvent.change(input, { target: { value: 'x' } });
    expect(newBadgeActive()).toBe(true);
    expect(activeTestId()).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-recent'));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    const callA = h.setPendingDraft.mock.calls[0][0];

    cleanup();
    h.setPendingDraft.mockClear();

    h.picker = makePicker();
    render(<AskAiPickerHost />);
    input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-recent'));
    fireEvent.change(input, { target: { value: 'x' } });
    expect(activeTestId()).toBe('ask-ai-picker-target-conv-recent');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    const callB = h.setPendingDraft.mock.calls[0][0];

    expect(callA.conversationId).toBe('conv-recent');
    expect(callB.conversationId).toBe('conv-recent');
    expect(callA.conversationId).toBe(callB.conversationId);
    expect(callA.text).toBe('x');
    expect(callB.text).toBe('x');
    expect(h.newConversation).not.toHaveBeenCalled();
  });

  it('single-click a row SELECTS (no confirm, focus back to input); click the already-active row CONFIRMS', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-a', 300), makeConv('conv-b', 100)]);
    h.getRecentMessages.mockResolvedValue([]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const rowB = await screen.findByTestId('ask-ai-picker-target-conv-b');
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-a'));

    fireEvent.click(rowB);
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-b'));
    expect(h.setPendingDraft).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    fireEvent.click(rowB);
    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    expect(h.retargetChatTab).not.toHaveBeenCalled();
    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-b' })
    );
    expect(h.newConversation).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('double-click a row confirms THAT destination directly (even if it was not pre-selected)', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-a', 300), makeConv('conv-b', 100)]);
    h.getRecentMessages.mockResolvedValue([]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    await screen.findByTestId('ask-ai-picker-expand-hint');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const rowB = await screen.findByTestId('ask-ai-picker-target-conv-b');
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-a'));

    fireEvent.dblClick(rowB);
    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    expect(h.retargetChatTab).not.toHaveBeenCalled();
    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-b' })
    );
    expect(h.newConversation).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('the named confirm button confirms the current destination (New → creates a conversation)', async () => {
    h.picker = makePicker({ chatWorkspacePath: '/ws/proj' });
    h.getConversations.mockResolvedValue([]);
    render(<AskAiPickerHost />);

    await screen.findByTestId('ask-ai-picker-input');
    await waitFor(() => expect(newBadgeActive()).toBe(true));
    expect(screen.getByTestId('ask-ai-picker-confirm-label').textContent).toBe('Start new chat');

    fireEvent.click(screen.getByTestId('ask-ai-picker-confirm'));
    await waitFor(() => expect(h.setPendingDraft).toHaveBeenCalledTimes(1));
    expect(h.newConversation).toHaveBeenCalledWith('/ws/proj');
    expect(h.retargetChatTab).not.toHaveBeenCalled();
    expect(h.setAskAiInlineChat).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'new-conv-id' })
    );
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('the ghosted draft appends below an existing conversation tail (chip + drafted question bubble)', async () => {
    h.picker = makePicker();
    h.getConversations.mockResolvedValue([makeConv('conv-1', 300)]);
    h.getRecentMessages.mockResolvedValue([makeMsg('a1', 'conv-1', 'assistant', 'earlier answer')]);
    render(<AskAiPickerHost />);

    const input = await screen.findByTestId('ask-ai-picker-input');
    fireEvent.change(input, { target: { value: 'ask about this' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(activeTestId()).toBe('ask-ai-picker-target-conv-1'));

    expect(await screen.findByTestId('ask-ai-picker-preview-message')).toBeTruthy();
    const draft = screen.getByTestId('ask-ai-picker-draft');
    expect(draft.getAttribute('data-variant')).toBe('append');
    expect(within(draft).getByTestId('ask-ai-picker-draft-divider')).toBeTruthy();
    expect(within(draft).getByTestId('ask-ai-picker-draft-bubble').textContent).toContain(
      'ask about this'
    );
    expect(h.switchConversation).not.toHaveBeenCalled();
  });
});
