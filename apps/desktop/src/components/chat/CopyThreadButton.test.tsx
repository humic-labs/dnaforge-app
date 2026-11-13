import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyThreadButton } from './CopyThreadButton';

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CopyThreadButton , ', () => {
  it('copies text Markdown only on click, writes it, and resets success feedback', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const createTextMarkdown = vi.fn(async () => '# Readable thread');
    const createDetailedMarkdown = vi.fn(async () => '# Detailed retained thread');
    setClipboard({ writeText });

    render(
      <CopyThreadButton
        createTextMarkdown={createTextMarkdown}
        createDetailedMarkdown={createDetailedMarkdown}
      />
    );

    const button = screen.getByTestId('copy-thread-button');
    const tooltipTrigger = button.parentElement;
    if (!tooltipTrigger) throw new Error('Copy transcript tooltip trigger is missing');

    expect(createTextMarkdown).not.toHaveBeenCalled();
    expect(createDetailedMarkdown).not.toHaveBeenCalled();
    expect(button).toHaveAccessibleName('Copy transcript');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Shift+F10 ContextMenu');
    expect(button).toHaveTextContent(/^$/);

    fireEvent.mouseEnter(tooltipTrigger);
    act(() => vi.advanceTimersByTime(300));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Copy transcript Right-click to copy with metadata');
    expect(tooltip).not.toHaveTextContent('Copy transcript.');
    expect(tooltip).toHaveClass(
      'border-border-hover',
      'bg-bg-subtle/95',
      'font-normal',
      'leading-snug',
      'shadow-lg'
    );

    fireEvent.mouseLeave(tooltipTrigger);
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(createTextMarkdown).toHaveBeenCalledTimes(1);
    expect(createDetailedMarkdown).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('# Readable thread');
    expect(screen.getByRole('status')).toHaveTextContent('Transcript copied!');
    expect(button).toHaveAccessibleName('Transcript copied');

    act(() => vi.advanceTimersByTime(2_000));
    expect(button).toHaveAccessibleName('Copy transcript');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('directly copies detailed Markdown on context click without opening a menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const createTextMarkdown = vi.fn(async () => '# Readable thread');
    const createDetailedMarkdown = vi.fn(async () => '# Detailed retained thread');
    setClipboard({ writeText });
    render(
      <CopyThreadButton
        createTextMarkdown={createTextMarkdown}
        createDetailedMarkdown={createDetailedMarkdown}
      />
    );
    const button = screen.getByTestId('copy-thread-button');
    const contextMenu = createEvent.contextMenu(button);

    await act(async () => {
      fireEvent(button, contextMenu);
      await Promise.resolve();
    });

    expect(contextMenu.defaultPrevented).toBe(true);
    expect(createTextMarkdown).not.toHaveBeenCalled();
    expect(createDetailedMarkdown).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('# Detailed retained thread');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveAccessibleName('Transcript with metadata copied');
    expect(screen.getByRole('status')).toHaveTextContent('Transcript with metadata copied!');
  });

  it('directly copies detailed Markdown for both keyboard context gestures', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const createDetailedMarkdown = vi.fn(async () => '# Detailed retained thread');
    setClipboard({ writeText });
    render(
      <CopyThreadButton
        createTextMarkdown={() => '# Readable thread'}
        createDetailedMarkdown={createDetailedMarkdown}
      />
    );
    const button = screen.getByTestId('copy-thread-button');

    await act(async () => {
      fireEvent.keyDown(button, { key: 'F10', shiftKey: true });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(button, { key: 'ContextMenu' });
      await Promise.resolve();
    });

    expect(createDetailedMarkdown).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(1, '# Detailed retained thread');
    expect(writeText).toHaveBeenNthCalledWith(2, '# Detailed retained thread');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('shows an actionable error when clipboard permission is missing', async () => {
    setClipboard(undefined);

    render(
      <CopyThreadButton
        createTextMarkdown={() => '# Thread'}
        createDetailedMarkdown={() => '# Detailed thread'}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-thread-button'));
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not copy. Check clipboard permission, then try again.'
    );
    expect(screen.getByTestId('copy-thread-button')).toHaveAccessibleName(
      'Try copying transcript again'
    );
  });

  it('keeps retry available after a rejected clipboard write', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(undefined);
    setClipboard({ writeText });

    render(
      <CopyThreadButton
        createTextMarkdown={() => '# Thread'}
        createDetailedMarkdown={() => '# Detailed thread'}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-thread-button'));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-thread-button'));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Transcript copied!');
  });

  it('does not write a partial transcript when async preparation fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const createDetailedMarkdown = vi.fn().mockRejectedValue(new Error('reference read failed'));
    setClipboard({ writeText });

    render(
      <CopyThreadButton
        createTextMarkdown={() => '# Thread'}
        createDetailedMarkdown={createDetailedMarkdown}
      />
    );

    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId('copy-thread-button'));
      await Promise.resolve();
    });

    expect(createDetailedMarkdown).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not prepare the complete thread. Reopen the chat, then try again.'
    );
    expect(screen.getByTestId('copy-thread-button')).toHaveAccessibleName(
      'Try copying transcript again'
    );
  });
});
