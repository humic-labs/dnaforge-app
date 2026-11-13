import { userMessage } from '@waypoint/user-messages';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { EmptyStateChatComposer } from './EmptyStateChatComposer';

const noopRenderers = {
  renderAssistantRouteSelector: () => null,
  renderModelControls: () => null,
  renderRunningRouteStatus: () => null,
  renderRouteConfigurationPrompt: () => null,
  renderRouteCheckingStatus: () => null,
};

function baseProps(overrides: Partial<React.ComponentProps<typeof EmptyStateChatComposer>> = {}) {
  return {
    input: '',
    onInputChange: vi.fn(),
    onKeyDown: vi.fn(),
    onSend: vi.fn(),
    sendDisabled: false,
    sendTitle: 'Send (Enter)',
    isLoading: false,
    inputRef: createRef<HTMLTextAreaElement>(),
    onSuggestionClick: vi.fn(),
    ...noopRenderers,
    ...overrides,
  };
}

describe('EmptyStateChatComposer', () => {
  it('renders the greeting title without a default subtitle', () => {
    render(<EmptyStateChatComposer {...baseProps()} />);
    expect(screen.getByText('What can I help with?')).toBeInTheDocument();
    expect(
      screen.queryByText('Ask about your sequences, design primers, or explore experiments')
    ).not.toBeInTheDocument();
  });

  it('supports overriding the greeting and placeholder (Home reuses the same component with different copy)', () => {
    render(
      <EmptyStateChatComposer
        {...baseProps()}
        greetingTitle="Custom title"
        greetingSubtitle="Custom subtitle"
        placeholder="Custom placeholder"
      />
    );
    expect(screen.getByText('Custom title')).toBeInTheDocument();
    expect(screen.getByText('Custom subtitle')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Custom placeholder')).toBeInTheDocument();
  });

  it('renders an error via the shared ai-error testid', () => {
    render(<EmptyStateChatComposer {...baseProps({ error: 'Something failed' })} />);
    expect(screen.getByTestId('ai-error')).toHaveTextContent(userMessage('assistant.failed'));
  });

  it('renders the default suggestion chips and calls onSuggestionClick', () => {
    const onSuggestionClick = vi.fn();
    render(<EmptyStateChatComposer {...baseProps({ onSuggestionClick })} />);
    const arabinoseDesign = 'Design an inducible E. coli expression construct';
    const yeastDesign = 'Build a yeast fluorescent reporter with the YTK kit';
    expect(screen.getByText(arabinoseDesign)).toBeInTheDocument();
    expect(screen.getByText(yeastDesign)).toBeInTheDocument();
    fireEvent.click(screen.getByText(yeastDesign));
    expect(onSuggestionClick).toHaveBeenCalledWith(yeastDesign);
  });

  it('keeps the default suggestions short enough to sit on one row', () => {
    render(<EmptyStateChatComposer {...baseProps({})} />);
    const chips = screen
      .getAllByRole('button')
      .filter((b) => /^(Design|Build) /.test(b.textContent ?? ''));
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect((chip.textContent ?? '').length).toBeLessThanOrEqual(52);
    }
    const combined = chips.reduce((n, c) => n + (c.textContent ?? '').length, 0);
    expect(combined).toBeLessThanOrEqual(100);
  });

  it('supports overriding the suggestion list', () => {
    render(<EmptyStateChatComposer {...baseProps({ suggestions: ['Custom suggestion'] })} />);
    expect(screen.getByText('Custom suggestion')).toBeInTheDocument();
    expect(screen.queryByText('Design primers')).not.toBeInTheDocument();
  });

  it('reflects sendDisabled on the send button', () => {
    render(<EmptyStateChatComposer {...baseProps({ sendDisabled: true })} />);
    expect(screen.getByTestId('chat-send-button')).toBeDisabled();
  });

  it('calls onInputChange and onSend', () => {
    const onInputChange = vi.fn();
    const onSend = vi.fn();
    render(<EmptyStateChatComposer {...baseProps({ onInputChange, onSend })} />);
    fireEvent.change(screen.getByTestId('ai-input'), { target: { value: 'hello' } });
    expect(onInputChange).toHaveBeenCalledWith('hello');
    fireEvent.click(screen.getByTestId('chat-send-button'));
    expect(onSend).toHaveBeenCalled();
  });

  it('hides the composer box entirely when hideInput is set', () => {
    render(<EmptyStateChatComposer {...baseProps({ hideInput: true })} />);
    expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument();
  });

  it("omits the attach button when onAttachFile is not provided (Home's usage)", () => {
    render(<EmptyStateChatComposer {...baseProps()} />);
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-attach-button')).not.toBeInTheDocument();
  });

  it("renders the attach button and attached files when provided (FullChatView's usage)", () => {
    const onAttachFile = vi.fn();
    const onRemoveFile = vi.fn();
    render(
      <EmptyStateChatComposer
        {...baseProps({
          onAttachFile,
          onRemoveFile,
          attachedFiles: [
            { id: 'f1', name: 'plasmid.gb', path: '/a/plasmid.gb', size: 100, content: '' },
          ],
        })}
      />
    );
    expect(screen.getByTestId('chat-attach-button')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-attach-button'));
    expect(onAttachFile).toHaveBeenCalled();
    expect(screen.getByText('plasmid.gb')).toBeInTheDocument();
  });

  it('renders the route/model render-prop functions in the toolbar', () => {
    render(
      <EmptyStateChatComposer
        {...baseProps({
          renderAssistantRouteSelector: () => <span data-testid="stub-route-selector" />,
          renderModelControls: () => <span data-testid="stub-model-controls" />,
        })}
      />
    );
    expect(screen.getByTestId('stub-route-selector')).toBeInTheDocument();
    expect(screen.getByTestId('stub-model-controls')).toBeInTheDocument();
  });
});

it('opens a staged reference in a new chat and keeps removal independent', () => {
  const onReferenceClick = vi.fn();
  const onRemoveComposeReference = vi.fn();
  const reference = {
    id: 'empty-chat-reference',
    entity_type: 'sequence',
    display_label: 'pUC19',
    locator: 'entity://sequence/catalog-puc19',
    data: null,
    deep_link_params: null,
    source: 'user',
    status: 'created',
    created_at: 1,
    updated_at: 1,
  };
  render(
    <EmptyStateChatComposer
      {...baseProps({
        composeReferences: [reference],
        onReferenceClick,
        onRemoveComposeReference,
      })}
    />
  );
  fireEvent.click(screen.getByTestId(`ref-chip-${reference.id}`));
  expect(onReferenceClick).toHaveBeenCalledWith(reference);
  fireEvent.click(screen.getByRole('button', { name: 'Remove pUC19' }));
  expect(onRemoveComposeReference).toHaveBeenCalledWith(reference.id);
  expect(onReferenceClick).toHaveBeenCalledOnce();
});
