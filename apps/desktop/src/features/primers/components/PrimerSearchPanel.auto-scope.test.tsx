import { userMessage } from '@waypoint/user-messages';
/** @vitest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HostedSignUpRequiredError, onHostedKeepWorkRequest } from '../../../hosted/capabilities';
import { PrimerSearchPanel, type PrimerAutoScopeRequest } from './PrimerSearchPanel';

const baseProps = {
  results: [],
  isSearching: false,
  onAttach: vi.fn().mockResolvedValue(undefined),
  sequenceLength: 5000,
  selectionRange: null as { start: number; end: number } | null,
};

describe('PrimerSearchPanel — Attach Primers auto-scope ', () => {
  it('picks "Entire sequence" for a no-selection request WITHOUT running a search', () => {
    const onSearch = vi.fn();
    render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        autoScope={{ nonce: 1, region: null } satisfies PrimerAutoScopeRequest}
      />
    );
    expect((screen.getByTestId('region-mode-select') as HTMLSelectElement).value).toBe('entire');
    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByTestId('primer-search-panel').getAttribute('data-has-searched')).toBe(
      'false'
    );
  });

  it('pre-fills the EDITABLE Custom-region inputs from the selection, WITHOUT running', () => {
    const onSearch = vi.fn();
    render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        autoScope={{ nonce: 1, region: { start: 120, end: 180 } } satisfies PrimerAutoScopeRequest}
      />
    );
    expect((screen.getByTestId('region-mode-select') as HTMLSelectElement).value).toBe('custom');
    expect((screen.getByTestId('region-start-input') as HTMLInputElement).value).toBe('120');
    expect((screen.getByTestId('region-end-input') as HTMLInputElement).value).toBe('180');
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('lets the user edit the pre-filled inputs before running', () => {
    const onSearch = vi.fn();
    render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        autoScope={{ nonce: 1, region: { start: 120, end: 180 } }}
      />
    );
    fireEvent.change(screen.getByTestId('region-end-input'), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('primer-search-button'));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch.mock.calls[0][0]).toMatchObject({ regionStart: 120, regionEnd: 200 });
  });

  it('applies the scope once per nonce (and never runs the search)', () => {
    const onSearch = vi.fn();
    const onAutoScopeConsumed = vi.fn();
    const { rerender } = render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        onAutoScopeConsumed={onAutoScopeConsumed}
        autoScope={{ nonce: 1, region: null }}
      />
    );
    expect(onAutoScopeConsumed).toHaveBeenCalledTimes(1);
    rerender(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        onAutoScopeConsumed={onAutoScopeConsumed}
        autoScope={{ nonce: 1, region: null }}
      />
    );
    expect(onAutoScopeConsumed).toHaveBeenCalledTimes(1);
    rerender(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        onAutoScopeConsumed={onAutoScopeConsumed}
        autoScope={{ nonce: 2, region: { start: 0, end: 10 } }}
      />
    );
    expect(onAutoScopeConsumed).toHaveBeenCalledTimes(2);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('lets the user run the search manually after the scope is applied', () => {
    const onSearch = vi.fn();
    render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        autoScope={{ nonce: 1, region: { start: 120, end: 180 } }}
      />
    );
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('primer-search-button'));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch.mock.calls[0][0]).toMatchObject({ regionStart: 120, regionEnd: 180 });
    expect(screen.getByTestId('primer-search-panel').getAttribute('data-has-searched')).toBe(
      'true'
    );
  });

  it('does not show an empty state before any search has run (after auto-scope only)', () => {
    render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={vi.fn()}
        libraryEmpty
        autoScope={{ nonce: 1, region: null }}
      />
    );
    expect(screen.queryByTestId('primer-search-empty')).toBeNull();
  });

  it('shows the import call-to-action only after a manual search on an empty library', () => {
    render(<PrimerSearchPanel {...baseProps} onSearch={vi.fn()} libraryEmpty />);
    expect(screen.queryByTestId('primer-search-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('primer-search-button'));
    const empty = screen.getByTestId('primer-search-empty');
    expect(empty.textContent).toContain('No primers in your library');
    expect(empty.textContent).toContain('Import');
  });

  it('shows an error/retry state on search failure, not the "no primers bind" message', () => {
    const onSearch = vi.fn();
    render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={onSearch}
        searchError={new Error('Could not reach the primer matcher')}
      />
    );
    const err = screen.getByTestId('primer-search-error');
    expect(err.textContent).toContain(userMessage('primer.failed'));
    expect(screen.queryByTestId('primer-search-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('primer-search-retry'));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('shows the demo sign-up prompt instead of a matcher failure', () => {
    const requests: Array<string | null> = [];
    const stop = onHostedKeepWorkRequest((reason) => requests.push(reason));
    render(
      <PrimerSearchPanel
        {...baseProps}
        onSearch={vi.fn()}
        searchError={new HostedSignUpRequiredError(userMessage('guidance.sign-up-to-run-this'))}
      />
    );
    expect(screen.getByTestId('primer-search-sign-up').textContent).toContain(
      'Sign up to run this'
    );
    expect(screen.queryByTestId('primer-search-error')).toBeNull();
    fireEvent.click(screen.getByTestId('primer-search-sign-up-open'));
    expect(requests).toEqual(['Sign up to run this']);
    stop();
  });
});
