import { userMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolResultDisplay } from './ToolResultDisplay';

describe('ToolResultDisplay', () => {
  it('renders tool use as a compact transcript row instead of a card', () => {
    render(
      <ToolResultDisplay
        toolName="list_files"
        content={JSON.stringify({
          input: { path: '.' },
          output: {
            entries: [
              { name: 'construct.gb', type: 'file', isBiologyFile: true },
              { name: 'notes.md', type: 'file', isBiologyFile: false },
            ],
          },
        })}
      />
    );

    const row = screen.getByTestId('tool-result');
    expect(row).toHaveAttribute('data-tool-status', 'completed');
    expect(row).toHaveClass('text-xs', 'text-accent/80', 'dark:text-accent/70');
    expect(row).not.toHaveClass('bg-bg-muted', 'rounded', 'border', 'overflow-hidden');
    const summary = screen.getByTestId('tool-result-summary');
    expect(summary).toHaveClass('text-accent/85', 'dark:text-accent/75');
    expect(summary).toHaveTextContent('Listed 2 items in "project root" (1 biology files)');
    expect(screen.getByText(userMessage('assistant.listFiles'))).toBeInTheDocument();
  });

  it('keeps details inspectable without making the collapsed row a box', () => {
    render(
      <ToolResultDisplay
        toolName="read_file"
        content={JSON.stringify({
          input: { path: 'plasmids/pUC19.gb' },
          output: {
            format: 'genbank',
            length: 2686,
            annotations: [{ name: 'bla', type: 'CDS' }],
            circular: true,
          },
        })}
      />
    );

    expect(screen.queryByTestId('tool-result-details')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));

    const details = screen.getByTestId('tool-result-details');
    expect(details).toHaveTextContent('Format: genbank');
    expect(details).toHaveTextContent('CDS: bla');
  });

  it('exposes a failed terminal status for errored tool results', () => {
    render(
      <ToolResultDisplay
        toolName="get_design"
        content={JSON.stringify({
          input: { designId: 'design-1' },
          output: { error: 'Design not found' },
          isError: true,
        })}
      />
    );

    expect(screen.getByTestId('tool-result')).toHaveAttribute('data-tool-status', 'failed');
    expect(screen.getByTestId('tool-result-summary')).toHaveTextContent(
      userMessage('assistant.failed')
    );
  });

  it('renders structured filesystem errors safely', () => {
    render(
      <ToolResultDisplay
        toolName="list_files"
        content={JSON.stringify({
          input: { path: 'DNAForge Samples/sequences/plasmids/missing-vector-99.gb' },
          output: {
            error: {
              code: 'HANDLER_ERROR',
              domain: 'core',
              message:
                "Error invoking remote method 'fs:readDir': Error: ENOENT: no such file or directory, scandir '/Users/alice/private-workspace/missing-vector-99.gb'",
              retriable: false,
            },
          },
          isError: true,
        })}
      />
    );

    const summary = screen.getByTestId('tool-result-summary');
    expect(summary).toHaveTextContent(userMessage('assistant.failed'));
    expect(summary).not.toHaveTextContent('[object Object]');
    expect(summary).not.toHaveTextContent('/Users/alice/private-workspace');
  });

  it('shows a completed view again without rerunning the agent tool', async () => {
    const reactivate = vi.fn().mockResolvedValue({ ok: true });
    render(
      <ToolResultDisplay
        toolName="highlight_range"
        content={JSON.stringify({
          input: { documentId: 'fixture:sequence:puc19', start: 683, end: 688 },
          output: { ok: true },
          isError: false,
        })}
        allowReactivation
        reactivate={reactivate}
      />
    );

    fireEvent.click(screen.getByTestId('tool-result-reactivate'));

    expect(reactivate).toHaveBeenCalledWith('highlight_range', {
      input: { documentId: 'fixture:sequence:puc19', start: 683, end: 688 },
      output: { ok: true },
      isError: false,
    });
    expect(await screen.findByText('Shown')).toBeInTheDocument();
  });

  it('keeps mutations and failed calls inspect-only', () => {
    const reactivate = vi.fn();
    const { rerender } = render(
      <ToolResultDisplay
        toolName="finalize_design_assembly"
        content={JSON.stringify({ input: {}, output: { ok: true } })}
        allowReactivation
        reactivate={reactivate}
      />
    );
    expect(screen.queryByTestId('tool-result-reactivate')).not.toBeInTheDocument();

    rerender(
      <ToolResultDisplay
        toolName="open_tab"
        content={JSON.stringify({ input: {}, output: { error: 'missing' }, isError: true })}
        allowReactivation
        reactivate={reactivate}
      />
    );
    expect(screen.queryByTestId('tool-result-reactivate')).not.toBeInTheDocument();
    expect(reactivate).not.toHaveBeenCalled();
  });

  it('keeps read-only surfaces and unsuccessful view receipts inert', () => {
    const reactivate = vi.fn();
    const successfulContent = JSON.stringify({
      input: { path: '/workspace/pUC19.gb', start: 683, end: 688 },
      output: { ok: true },
      isError: false,
    });
    const { rerender } = render(
      <ToolResultDisplay
        toolName="highlight_range"
        content={successfulContent}
        reactivate={reactivate}
      />
    );
    expect(screen.queryByTestId('tool-result-reactivate')).not.toBeInTheDocument();

    rerender(
      <ToolResultDisplay
        toolName="highlight_range"
        content={JSON.stringify({ input: {}, output: { ok: false, error: 'invalid range' } })}
        allowReactivation
        reactivate={reactivate}
      />
    );
    expect(screen.queryByTestId('tool-result-reactivate')).not.toBeInTheDocument();

    rerender(
      <ToolResultDisplay
        toolName="open_tab"
        content={JSON.stringify({ input: {}, output: { tabId: 'tab-1' } })}
        allowReactivation
        reactivate={reactivate}
      />
    );
    expect(screen.queryByTestId('tool-result-reactivate')).not.toBeInTheDocument();
    expect(reactivate).not.toHaveBeenCalled();
  });
});

it.each([
  'platform.trackViews.list is not available in the hosted browser runtime.',
  'UCSC tracks: VITE_API_URL is not set',
])('keeps an unflagged feature-search failure out of its summary: %s', (error) => {
  render(
    <ToolResultDisplay toolName="find_features" content={JSON.stringify({ output: { error } })} />
  );
  expect(screen.getByTestId('tool-result-summary')).toHaveTextContent(
    userMessage('assistant.failed')
  );
  expect(screen.getByTestId('tool-result-summary')).not.toHaveTextContent(error);
});
