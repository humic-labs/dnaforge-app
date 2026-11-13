import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchPanel } from './SearchPanel';
import { searchMountedCatalogEntityPage } from '../db/catalog-reference-search';
import { beginWorkflowAction } from '../lib/workflow-telemetry';
import { dispatchOpenExactCatalogEntity } from '../features/page/editor/native-entity-links';

const complete = vi.fn();
const fail = vi.fn();
const presented = {
  kind: 'document',
  result: {
    status: 'presented',
    panelId: 'main',
    tabId: 'page',
    tabType: 'page',
    disposition: 'created',
    content: 'ready',
  },
} satisfies Parameters<
  NonNullable<Parameters<typeof dispatchOpenExactCatalogEntity>[0]['onResult']>
>[0];
const { stableFolders } = vi.hoisted(() => ({
  stableFolders: [{ path: '/workspace', name: 'Workspace' }],
}));

vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: { folders: { path: string }[] }) => unknown) =>
    selector({ folders: stableFolders }),
}));

vi.mock('../db/catalog-reference-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/catalog-reference-search')>()),
  searchMountedCatalogEntityPage: vi.fn(),
}));

vi.mock('../features/page/editor/native-entity-links', () => ({
  dispatchOpenExactCatalogEntity: vi.fn(),
}));

vi.mock('../lib/workflow-telemetry', () => ({
  beginWorkflowAction: vi.fn(() => ({
    actionId: 'search-action',
    consumed: false,
    complete: (...args: unknown[]) => {
      complete(...args);
      return true;
    },
    fail,
    cancel: vi.fn(),
  })),
  observeWorkflowAction: vi.fn(),
}));

describe('SearchPanel query and open receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dispatchOpenExactCatalogEntity).mockReset().mockReturnValue(true);
  });

  it('records a successful user search without sending the query', async () => {
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [
        {
          entityId: 'repo::page-1',
          entityType: 'notebook',
          name: 'Result',
          workspaceRoot: '/workspace',
          workspaceName: 'Workspace',
        },
      ],
      nextPosition: null,
    });
    render(<SearchPanel />);

    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'private customer term' },
    });

    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', resultCount: 1 })
      )
    );
    expect(beginWorkflowAction).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: 'search', action: 'search' })
    );
    expect(beginWorkflowAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.anything() })
    );
  });

  it('records which ranked result was opened without sending its name', async () => {
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [
        {
          entityId: 'repo::page-1',
          entityType: 'notebook',
          name: 'Private notebook',
          workspaceRoot: '/workspace',
          workspaceName: 'Workspace',
        },
        {
          entityId: 'repo::page-2',
          entityType: 'notebook',
          name: 'Second private notebook',
          workspaceRoot: '/workspace',
          workspaceName: 'Workspace',
        },
      ],
      nextPosition: null,
    });
    render(<SearchPanel />);
    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'private' },
    });
    fireEvent.click(await screen.findByText('Second private notebook'));

    expect(beginWorkflowAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workflow: 'search',
        action: 'open',
        resultCount: 2,
        resultRank: 2,
      })
    );
    expect(complete).toHaveBeenCalledTimes(1);
    act(() => vi.mocked(dispatchOpenExactCatalogEntity).mock.lastCall?.[0].onResult?.(presented));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'ready', outcomeKind: 'catalog_presented' })
    );
    expect(JSON.stringify(vi.mocked(beginWorkflowAction).mock.calls)).not.toContain('private');
  });

  it('counts a zero-result search as a successful no-match', async () => {
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [],
      nextPosition: null,
    });
    render(<SearchPanel />);

    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'not-found' },
    });

    await waitFor(() =>
      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'no_match', resultCount: 0 })
      )
    );
  });

  it('does not treat the empty recent-items state as a search', async () => {
    render(<SearchPanel />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 175));
    });

    expect(searchMountedCatalogEntityPage).not.toHaveBeenCalled();
    expect(beginWorkflowAction).not.toHaveBeenCalled();
  });

  it('records an operational search failure with a bounded error class', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(searchMountedCatalogEntityPage).mockRejectedValue(
      new TypeError('secret query failed')
    );
    render(<SearchPanel />);

    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'sensitive' },
    });

    await waitFor(() =>
      expect(fail).toHaveBeenCalledWith(
        'TypeError',
        expect.objectContaining({ searchActivityRole: 'continuation' })
      )
    );
    expect(complete).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
  it('cannot select previous results during the next query debounce', async () => {
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [
        {
          entityId: 'repo::old',
          entityType: 'notebook',
          name: 'Old result',
          workspaceRoot: '/workspace',
          workspaceName: 'Workspace',
        },
      ],
      nextPosition: null,
    });
    render(<SearchPanel />);
    const input = screen.getByPlaceholderText('Search pages, sequences, primers...');
    fireEvent.change(input, { target: { value: 'old' } });
    await screen.findByRole('button', { name: 'Open Old result (page)' });
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatchOpenExactCatalogEntity).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Open Old result (page)' })).toBeNull();
  });

  it('clears old results immediately when the query becomes blank', async () => {
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [
        {
          entityId: 'repo::old',
          entityType: 'notebook',
          name: 'Old result',
          workspaceRoot: '/workspace',
          workspaceName: 'Workspace',
        },
      ],
      nextPosition: null,
    });
    render(<SearchPanel />);
    const input = screen.getByPlaceholderText('Search pages, sequences, primers...');
    fireEvent.change(input, { target: { value: 'old' } });
    await screen.findByRole('button', { name: 'Open Old result (page)' });
    const count = vi.mocked(beginWorkflowAction).mock.calls.length;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(dispatchOpenExactCatalogEntity).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Open Old result (page)' })).toBeNull();
    expect(beginWorkflowAction).toHaveBeenCalledTimes(count);
  });

  it('does not present a failed query as an empty successful result', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(searchMountedCatalogEntityPage).mockRejectedValue(new Error('private query'));
    render(<SearchPanel />);
    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'secret' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Search could not finish');
    expect(screen.queryByText('No results found for "secret"')).toBeNull();
    spy.mockRestore();
  });

  it('correlates distinct queries to one episode and marks its first current result once', async () => {
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [],
      nextPosition: null,
    });
    render(<SearchPanel />);
    const input = screen.getByPlaceholderText('Search pages, sequences, primers...');
    fireEvent.change(input, { target: { value: 'first private query' } });
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'second private query' } });
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    const first = vi.mocked(beginWorkflowAction).mock.calls[0][0];
    const second = vi.mocked(beginWorkflowAction).mock.calls[1][0];
    expect(first).toEqual(
      expect.objectContaining({
        searchEpisodeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        searchQueryRevision: 1,
      })
    );
    expect(second).toEqual(
      expect.objectContaining({ searchEpisodeId: first.searchEpisodeId, searchQueryRevision: 2 })
    );
    expect(complete.mock.calls[0][0]).toEqual(
      expect.objectContaining({ searchActivityRole: 'first_result' })
    );
    expect(complete.mock.calls[1][0]).toEqual(
      expect.objectContaining({ searchActivityRole: 'continuation' })
    );
  });

  it('records selection separately and waits for exact open acknowledgement', async () => {
    let acknowledge: Parameters<typeof dispatchOpenExactCatalogEntity>[0]['onResult'];
    vi.mocked(dispatchOpenExactCatalogEntity).mockImplementation((detail) => {
      acknowledge = detail.onResult;
      return true;
    });
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [
        {
          entityId: 'repo::page',
          entityType: 'notebook',
          name: 'Selected',
          workspaceRoot: '/workspace',
          workspaceName: 'Workspace',
        },
      ],
      nextPosition: null,
    });
    render(<SearchPanel />);
    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'selected' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Selected (page)' }));
    expect(beginWorkflowAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workflow: 'search',
        action: 'open',
        searchEpisodeId: expect.any(String),
      })
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(acknowledge).toBeTypeOf('function');
    act(() => acknowledge?.(presented));
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'ready', outcomeKind: 'catalog_presented' })
    );
  });
  it('keeps a late older result out of the current query and marks only its execution as superseded', async () => {
    let finishOld:
      | ((value: Awaited<ReturnType<typeof searchMountedCatalogEntityPage>>) => void)
      | undefined;
    vi.mocked(searchMountedCatalogEntityPage)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockResolvedValueOnce({
        results: [
          {
            entityId: 'repo::new',
            entityType: 'notebook',
            name: 'New result',
            workspaceRoot: '/workspace',
            workspaceName: 'Workspace',
          },
        ],
        nextPosition: null,
      });
    render(<SearchPanel />);
    const input = screen.getByPlaceholderText('Search pages, sequences, primers...');
    fireEvent.change(input, { target: { value: 'old' } });
    await waitFor(() => expect(searchMountedCatalogEntityPage).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'new' } });
    await screen.findByRole('button', { name: 'Open New result (page)' });
    await act(async () =>
      finishOld?.({
        results: [
          {
            entityId: 'repo::old',
            entityType: 'notebook',
            name: 'Old result',
            workspaceRoot: '/workspace',
            workspaceName: 'Workspace',
          },
        ],
        nextPosition: null,
      })
    );
    expect(screen.queryByRole('button', { name: 'Open Old result (page)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open New result (page)' })).toBeVisible();
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchActivityRole: 'superseded' })
    );
    expect(
      complete.mock.calls.filter(([value]) => value.searchActivityRole === 'first_result')
    ).toHaveLength(1);
  });

  it('retries a failed execution and starts a new episode only after a blank query', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(searchMountedCatalogEntityPage)
      .mockRejectedValueOnce(new Error('private message'))
      .mockResolvedValue({ results: [], nextPosition: null });
    render(<SearchPanel />);
    const input = screen.getByPlaceholderText('Search pages, sequences, primers...');
    fireEvent.change(input, { target: { value: 'private name' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry search' }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const previous = vi.mocked(beginWorkflowAction).mock.calls[0][0].searchEpisodeId;
    expect(vi.mocked(beginWorkflowAction).mock.calls[1][0].searchEpisodeId).toBe(previous);
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchActivityRole: 'first_result' })
    );
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: 'private name' } });
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(vi.mocked(beginWorkflowAction).mock.calls[2][0].searchEpisodeId).not.toBe(previous);
    expect(vi.mocked(beginWorkflowAction).mock.calls[2][0].searchQueryRevision).toBe(1);
    expect(spy.mock.calls.flat().join(' ')).not.toContain('private message');
    spy.mockRestore();
  });

  it('keeps a Registry focus request distinct from a presented document', async () => {
    vi.mocked(dispatchOpenExactCatalogEntity).mockImplementation((detail) => {
      detail.onResult?.({ kind: 'registry_record' });
      return true;
    });
    vi.mocked(searchMountedCatalogEntityPage).mockResolvedValue({
      results: [
        {
          entityId: 'repo::strain',
          entityType: 'record',
          name: 'Strain',
          workspaceRoot: '/workspace',
          workspaceName: 'Workspace',
        },
      ],
      nextPosition: null,
    });
    render(<SearchPanel />);
    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'strain' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Strain (record)' }));
    expect(complete).toHaveBeenLastCalledWith({
      status: 'needs_action',
      outcomeKind: 'catalog_registry_requested',
      usableResult: false,
      valueDelivered: false,
    });
  });
});
