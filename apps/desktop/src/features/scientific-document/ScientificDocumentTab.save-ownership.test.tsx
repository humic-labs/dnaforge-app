import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  read: vi.fn(),
  folders: [{ path: '/ws', name: 'Workspace', addedAt: 1 }],
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { watchFile: async () => {}, unwatchFile: async () => {} },
    on: () => () => {},
  }),
}));
vi.mock('../../db/workspace-catalog', () => ({
  getCatalogEntityForFilePath: async () => null,
  getCatalogWorkspaceRootForFilePath: async () => '/ws',
}));
vi.mock('../canvas/public/store', () => ({
  useCanvasStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ updateTabByEntityId: () => {}, openInFocusedPanel: () => {} }),
    { getState: () => ({ panels: {} }) }
  ),
}));
vi.mock('../design/public', () => ({
  useDesignStore: (select: (state: unknown) => unknown) =>
    select({ upsertDesignFromArtifact: () => {} }),
}));
vi.mock('../page/public', () => ({
  usePageStore: (select: (state: unknown) => unknown) =>
    select({ upsertPageFromArtifact: () => {} }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (select: (state: unknown) => unknown) => select({ folders: h.folders }),
  resolveWorkspaceRevealPath: () => null,
}));
vi.mock('../../services/native-catalog-destination', () => ({
  resolveNativeCatalogDestination: async () => null,
}));
vi.mock('../../services/legacy-migration-sequence-destination', () => ({
  resolveMigrationSequenceDestinationPath: () => {},
}));
vi.mock('../document-opening/public/compat', () => ({ openSequenceFile: () => {} }));
vi.mock('../document-opening/public/open-document', () => ({ openDocument: () => {} }));
vi.mock('./native-package', () => ({
  saveNativeScientificPackage: (...args: unknown[]) => h.save(...args),
}));
vi.mock('../../services/workspace-artifact-open', () => ({ withWorkspaceArtifactOpen: () => {} }));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  isWorkspaceMutationBusyError: () => false,
}));
vi.mock('./services/desktop-scientific-documents', () => ({
  readDesktopScientificDocument: (...args: unknown[]) => h.read(...args),
}));
vi.mock('../../lib/readable-content-telemetry', () => ({
  commitReadableContent: () => {},
  failReadableContent: () => {},
}));
import { ScientificDocumentTab } from './ScientificDocumentTab';
import { documentLifecycle } from '../../shared/document-lifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function protocol(title: string) {
  const rich = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
  return JSON.stringify({
    schema: 'dnaforge.protocol.v1',
    kind: 'protocol',
    id: 'protocol-a',
    title,
    editable: true,
    overview: rich('Original overview'),
    steps: [{ id: 'step-a', ordinal: 1, title: 'Step 1', content: rich('Original step') }],
    inputs: [],
    outputs: [],
    version: { sourceVersionId: 'local-v1' },
  });
}
beforeEach(() => {
  h.save.mockReset().mockResolvedValue(undefined);
  h.read.mockReset().mockImplementation(async ({ filePath }: { filePath: string }) => ({
    ok: true,
    document: {
      content: protocol(filePath.includes('Second') ? 'Second protocol' : 'Original protocol'),
    },
  }));
});
afterEach(cleanup);

describe('scientific draft save ownership', () => {
  it('records the original write failure and retains the unsaved protocol', async () => {
    const filePath = '/ws/First/.forge/protocol.json';
    const failure = new Error('EACCES: protocol write denied');
    h.save.mockRejectedValueOnce(failure);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<ScientificDocumentTab filePath={filePath} />);
      const title = await screen.findByLabelText('Document title');
      fireEvent.change(title, { target: { value: 'Unsaved title' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() =>
        expect(report).toHaveBeenCalledWith('[ScientificDocumentTab] Save failed:', { filePath }, failure)
      );
      expect(title).toHaveValue('Unsaved title');
      expect(screen.getByText('Unsaved', { exact: true })).toBeVisible();
      expect(screen.queryByText('Saved', { exact: true })).toBeNull();
    } finally {
      report.mockRestore();
    }
  });

  it('preserves title and body edits made during saving and saves them against the accepted snapshot', async () => {
    const pending = deferred();
    h.save.mockReturnValueOnce(pending.promise);
    render(<ScientificDocumentTab filePath="/ws/First/.forge/protocol.json" />);
    const title = await screen.findByLabelText('Document title');
    fireEvent.change(title, { target: { value: 'Saved snapshot' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(h.save).toHaveBeenCalledTimes(1);
    fireEvent.change(title, { target: { value: 'Newer title' } });
    fireEvent.change(screen.getByLabelText('Protocol overview'), {
      target: { value: 'Newer overview' },
    });
    fireEvent.change(screen.getByLabelText('Step 1 content'), { target: { value: 'Newer step' } });
    await act(async () => {
      pending.resolve();
    });
    expect(title).toHaveValue('Newer title');
    expect(screen.getByLabelText('Protocol overview')).toHaveValue('Newer overview');
    expect(screen.getByLabelText('Step 1 content')).toHaveValue('Newer step');
    expect(screen.getByText('Unsaved', { exact: true })).toBeVisible();
    expect(screen.queryByText('Saved', { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await screen.findByText('Saved', { exact: true });
    expect(h.save.mock.calls[1][0]).toMatchObject({ document: { title: 'Newer title' } });
    expect(JSON.parse(h.save.mock.calls[1][0].expectedText).title).toBe('Saved snapshot');
    expect(screen.queryByText('Unsaved', { exact: true })).toBeNull();
  });

  it('saves a draft edited during reload against the observed disk revision', async () => {
    const filePath = '/ws/First/.forge/protocol.json';
    render(<ScientificDocumentTab filePath={filePath} />);
    const title = await screen.findByLabelText('Document title');
    const pending = deferred();
    const external = protocol('External revision');
    h.read.mockImplementationOnce(async () => {
      await pending.promise;
      return { ok: true, document: { content: external } };
    });
    const reload = documentLifecycle.reload({ kind: 'file', filePath });
    fireEvent.change(title, { target: { value: 'New local edit' } });
    fireEvent.change(screen.getByLabelText('Protocol overview'), {
      target: { value: 'New local overview' },
    });
    await act(async () => {
      pending.resolve();
      expect(await reload).toBe(false);
    });
    expect(title).toHaveValue('New local edit');
    expect(screen.getByText('Unsaved', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await screen.findByText('Saved', { exact: true });
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedText: external,
        document: expect.objectContaining({ title: 'New local edit' }),
      })
    );
    expect(screen.getByLabelText('Protocol overview')).toHaveValue('New local overview');
  });

  it('ignores save completion from a document that is no longer open in the component', async () => {
    const pending = deferred();
    h.save.mockReturnValueOnce(pending.promise);
    const view = render(<ScientificDocumentTab filePath="/ws/First/.forge/protocol.json" />);
    fireEvent.change(await screen.findByLabelText('Document title'), {
      target: { value: 'Old save' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    view.rerender(<ScientificDocumentTab filePath="/ws/Second/.forge/protocol.json" />);
    await screen.findByDisplayValue('Second protocol');
    await act(async () => {
      pending.resolve();
    });
    expect(screen.getByLabelText('Document title')).toHaveValue('Second protocol');
    expect(screen.queryByText('Saved', { exact: true })).toBeNull();
  });
});
