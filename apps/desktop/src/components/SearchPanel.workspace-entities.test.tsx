import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSearch, mockDispatch, folders, designState } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockDispatch: vi.fn(() => true),
  designState: { designs: {} as Record<string, unknown> },
  folders: [
    { path: '/ws/alpha', name: 'Alpha project', addedAt: 1 },
    { path: '/ws/beta', name: 'Beta project', addedAt: 2 },
  ],
}));

vi.mock('../db/catalog-reference-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/catalog-reference-search')>()),
  searchMountedCatalogEntityPage: mockSearch,
}));

vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: { folders: typeof folders }) => unknown) =>
    selector({ folders }),
}));

vi.mock('../features/design/store', () => ({
  useDesignStore: (selector: (state: typeof designState) => unknown) => selector(designState),
}));

vi.mock('../features/page/editor/native-entity-links', () => ({
  dispatchOpenExactCatalogEntity: mockDispatch,
}));

vi.mock('../lib/workflow-telemetry', () => ({
  beginWorkflowAction: () => ({
    complete: vi.fn(),
    fail: vi.fn(),
  }),
  observeWorkflowAction: vi.fn(),
}));

import { SearchPanel } from './SearchPanel';

function result(
  entityType: string,
  name: string,
  portableEntityId: string,
  workspaceRoot = '/ws/beta',
  workspaceName = 'Beta project'
) {
  return {
    entityId: `repo-beta::${portableEntityId}`,
    entityType,
    name,
    workspaceRoot,
    workspaceName,
  };
}

describe('SearchPanel workspace entities ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    designState.designs = {};
    mockSearch.mockResolvedValue({ results: [], nextPosition: null });
  });

  it('regresses the page-only failure by finding and opening a known catalog plasmid', async () => {
    mockSearch.mockResolvedValue({
      results: [result('sequence', 'pUC19 plasmid', 'puc19')],
      nextPosition: null,
    });
    render(<SearchPanel />);

    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'pUC19' },
    });

    const section = await screen.findByRole('region', { name: 'Sequences' });
    const plasmid = within(section).getByRole('button', { name: /open puc19 plasmid/i });
    expect(plasmid).toBeEnabled();
    expect(mockSearch).toHaveBeenCalledWith({
      limit: 100,
      entityTypes: undefined,
      after: undefined,
      query: 'pUC19',
      workspaceRoots: ['/ws/alpha', '/ws/beta'],
      openLocalDesignIds: [],
    });

    fireEvent.click(plasmid);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'repo-beta::puc19',
        label: 'pUC19 plasmid',
        owningRoot: '/ws/beta',
      })
    );
  });

  it('labels every included catalog type and keeps every result actionable', async () => {
    const inventory = [
      ['notebook', 'Pages', 'page'],
      ['sequence', 'Sequences', 'sequence'],
      ['primer', 'Primers', 'primer'],
      ['design', 'Designs', 'design'],
      ['structure', 'Structures', 'structure'],
      ['protein', 'Proteins', 'protein'],
      ['protocol', 'Protocols', 'protocol'],
      ['protocol_run', 'Protocol runs', 'protocol run'],
      ['alignment', 'Alignments', 'alignment'],
      ['trace', 'Traces', 'trace'],
      ['report', 'Reports', 'report'],
      ['construct', 'Constructs', 'construct'],
      ['sample', 'Samples', 'sample'],
      ['record', 'Records', 'record'],
      ['track-view', 'Track views', 'track view'],
      ['file', 'Files', 'file'],
    ] as const;
    mockSearch.mockResolvedValue({
      results: inventory.map(([entityType, , itemLabel]) =>
        result(entityType, `Known ${itemLabel}`, `${entityType}-result`)
      ),
      nextPosition: null,
    });
    render(<SearchPanel />);

    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'a' },
    });

    for (const [entityType, sectionName, itemLabel] of inventory) {
      const section = await screen.findByRole('region', { name: sectionName });
      const button = within(section).getByRole('button', {
        name: `Open Known ${itemLabel} (${itemLabel})`,
      });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(mockDispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          entityId: `repo-beta::${entityType}-result`,
          label: `Known ${itemLabel}`,
          owningRoot: '/ws/beta',
        })
      );
    }
    expect(mockDispatch).toHaveBeenCalledTimes(inventory.length);
  });

  it('shows the no-match state without leaking entities from unmounted workspaces', async () => {
    render(<SearchPanel />);

    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'not-in-these-projects' },
    });

    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith({
        limit: 100,
        entityTypes: undefined,
        after: undefined,
        query: 'not-in-these-projects',
        workspaceRoots: ['/ws/alpha', '/ws/beta'],
        openLocalDesignIds: [],
      })
    );
    expect(await screen.findByText('No results found for "not-in-these-projects"')).toBeVisible();
  });

  it('supplies the loaded design ids used to exclude stale local-storage pointers', async () => {
    designState.designs = { 'repo-beta::loaded-design': { id: 'repo-beta::loaded-design' } };
    render(<SearchPanel />);

    fireEvent.change(screen.getByPlaceholderText('Search pages, sequences, primers...'), {
      target: { value: 'Loaded design' },
    });

    await waitFor(() =>
      expect(mockSearch).toHaveBeenCalledWith({
        limit: 100,
        entityTypes: undefined,
        after: undefined,
        query: 'Loaded design',
        workspaceRoots: ['/ws/alpha', '/ws/beta'],
        openLocalDesignIds: ['repo-beta::loaded-design'],
      })
    );
  });

  it('opens the first visible result with Enter and closes Search with Escape', async () => {
    const onClose = vi.fn();
    mockSearch.mockResolvedValue({
      results: [
        result('sequence', 'Alphabetical sequence', 'sequence-result'),
        result('notebook', 'Later page', 'page-result'),
      ],
      nextPosition: null,
    });
    render(<SearchPanel onClose={onClose} />);

    const input = screen.getByPlaceholderText('Search pages, sequences, primers...');
    fireEvent.change(input, { target: { value: 'result' } });
    await screen.findByRole('button', { name: 'Open Later page (page)' });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'repo-beta::page-result',
        label: 'Later page',
        owningRoot: '/ws/beta',
      })
    );

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
