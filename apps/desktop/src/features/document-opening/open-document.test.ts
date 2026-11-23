import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDocument, resolveFileDocumentKind } from './open-document';
import { cancelledDocumentOpen } from '../canvas/public/document-presentation';
import { useCanvasStore } from '../canvas/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { finishGenomeViewFileOpen } from '../sequence/public/genome-view-open-request';

const mocks = vi.hoisted(() => ({
  sequence: vi.fn(),
  structure: vi.fn(),
  projects: vi.fn(),
  stat: vi.fn(),
  checkDocument: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      stat: mocks.stat,
    },
    workspace: { checkDocument: mocks.checkDocument },
  }),
}));
vi.mock('../workspace-loader/public/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: mocks.projects,
}));
vi.mock('../sequence/openSequenceFile', () => ({ openSequenceFileResult: mocks.sequence }));
vi.mock('../structure-files/openStructureFile', () => ({
  openStructureFileResult: mocks.structure,
}));

describe('common document opening', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.projects.mockResolvedValue([]);
    mocks.stat.mockResolvedValue({ isFile: true, isDirectory: false });
    mocks.checkDocument.mockResolvedValue({ state: 'unchecked' });
    useWorkspaceStore.setState({ folders: [] });
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });
  });

  it.each([
    ['/ws/a.entity.json', 'entity'],
    ['/ws/Genome view.dnaforge-track-view.json', 'track-view'],
    ['/ws/a.primer.json', 'primer'],
    ['/ws/Notes/.forge/notebook.json', 'page'],
    ['/ws/a.wpdesign.json', 'design'],
    ['/ws/a.gb', 'sequence'],
    ['/ws/a.cif', 'structure'],
    ['/ws/a.faa', 'protein'],
    ['/ws/a.fasta', 'sequence'],
    ['/ws/a.txt', 'text'],
  ])('resolves %s deterministically to %s', (path, kind) => {
    expect(resolveFileDocumentKind({ kind: 'file', path })).toBe(kind);
  });

  it.each(['Results.pdf', 'Results.csv', 'Results.gb', 'Results.pdb', 'Results.entity.json'])(
    'preserves the file tree classification for notebook package %s',
    (name) => {
      expect(resolveFileDocumentKind({ kind: 'file', path: `/ws/${name}`, tabType: 'page' })).toBe(
        'page'
      );
    }
  );

  it('does not treat a protein view hint as native identity for an ambiguous FASTA file', () => {
    expect(resolveFileDocumentKind({ kind: 'file', path: '/ws/a.fasta', tabType: 'protein' })).toBe(
      'sequence'
    );
  });

  it('does not route a known corrupt format to an unrelated handler', async () => {
    mocks.structure.mockRejectedValue(new Error('Corrupt coordinates'));
    expect(
      await openDocument({ target: { kind: 'file', path: '/ws/bad.pdb', tabType: 'sequence' } })
    ).toEqual({ status: 'failed', message: 'DNAForge couldn’t open this file.' });
    expect(mocks.sequence).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });

  it.each([
    'sample.primer.json',
    'sample.wpnote.json',
    'sample.wpdesign.json',
    'sample.entity.json',
    'sample.dnaforge-track-view.json',
    'sample.dnaforge-protocol.json',
    'sample.faa',
    'sample.gb',
    'sample.pdb',
    'sample.pdf',
    'sample.png',
    'sample.csv',
    'sample.xlsx',
    'sample.html',
  ])('blocks %s before a typed tab opens when the current reader refuses it', async (name) => {
    const message = 'DNAForge couldn’t open this file.';
    mocks.checkDocument.mockResolvedValue({
      state: 'blocked', code: 'unknown', recognized: false, reason: message,
    });
    expect(await openDocument({ target: { kind: 'file', path: `/ws/${name}` } }))
      .toEqual({ status: 'blocked', message });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
    expect(mocks.sequence).not.toHaveBeenCalled();
    expect(mocks.structure).not.toHaveBeenCalled();
  });

  it('checks the real PDF reader even when a caller supplies a PDF hint for an extensionless file', async () => {
    mocks.checkDocument.mockResolvedValue({
      state: 'blocked', code: 'unsupported-format', recognized: false,
      reason: 'This format cannot be opened in DNAForge.',
    });
    await expect(openDocument({ target: { kind: 'file', path: '/ws/blob', tabType: 'pdf' } }))
      .resolves.toMatchObject({ status: 'blocked' });
    expect(mocks.checkDocument).toHaveBeenCalledWith(expect.objectContaining({
      path: '/ws/blob', literalKind: 'pdf',
    }));
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });

  it('keeps a proven missing file distinct when the filesystem bridge cannot preserve the error code', async () => {
    mocks.stat.mockRejectedValue(new Error('The underlying bridge failed.'));
    const message = 'The file could not be found.';
    mocks.checkDocument.mockResolvedValue({
      state: 'blocked', code: 'missing', recognized: false, reason: message,
    });
    await expect(openDocument({ target: { kind: 'file', path: '/ws/absent.pdf' } }))
      .resolves.toEqual({ status: 'blocked', message });
  });

  it('cancels during filesystem classification while another caller still opens', async () => {
    const metadata = Promise.withResolvers<{ isFile: boolean; isDirectory: boolean }>();
    mocks.stat.mockImplementationOnce(() => metadata.promise);
    const controller = new AbortController();
    const first = openDocument({
      target: { kind: 'file', path: '/ws/shared.gb' },
      signal: controller.signal,
    });
    const presented = { status: 'presented', tabType: 'sequence', content: 'loading' };
    mocks.sequence.mockResolvedValue(presented);
    const second = openDocument({ target: { kind: 'file', path: '/ws/shared.gb' } });
    expect(await second).toEqual(presented);
    let cancelled: unknown;
    void first.then((result) => {
      cancelled = result;
    });
    controller.abort();
    try {
      await vi.waitFor(() => expect(cancelled).toEqual(cancelledDocumentOpen()), { timeout: 200 });
    } finally {
      metadata.resolve({ isFile: true, isDirectory: false });
      await first;
    }
    expect(mocks.sequence).toHaveBeenCalledTimes(1);
  });

  it('shows a saved genome view tab in the same turn as the Files open gesture', async () => {
    const opened = openDocument({
      target: { kind: 'track-view', id: '/ws/Project genes.dnaforge-track-view.json' },
      source: 'file_tree',
    });

    const panel = useCanvasStore.getState().panels.main;
    expect(panel.tabs).toHaveLength(1);
    expect(panel.activeTabId).toBe(panel.tabs[0].id);
    expect(panel.tabs[0]).toMatchObject({
      type: 'sequence',
      label: 'Project genes',
      loadStatus: 'pending',
    });

    finishGenomeViewFileOpen(null);
    await expect(opened).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('opens a saved primer with its owning project and shared persisted-document context', async () => {
    useWorkspaceStore.setState({
      folders: [
        { path: '/other', name: 'Other', addedAt: 0 },
        { path: '/ws', name: 'Lab', addedAt: 0 },
      ],
    });
    expect(
      await openDocument({ target: { kind: 'file', path: '/ws/primers/a.primer.json' } })
    ).toMatchObject({ status: 'presented', tabType: 'primer' });
    expect(useCanvasStore.getState().panels.main.tabs[0].artifactDocument).toEqual({
      kind: 'primer',
      persistence: 'persisted',
      workspaceRoot: '/ws',
      destinationPath: '/ws/primers',
      artifactPath: '/ws/primers/a.primer.json',
    });
  });

  it('retains source, per-caller cancellation and explicit blocked outcomes', async () => {
    const controller = new AbortController();
    mocks.sequence.mockResolvedValue({ status: 'blocked', message: 'Too large' });
    expect(
      await openDocument({
        target: { kind: 'file', path: '/ws/a.gb' },
        source: 'file_tree',
        signal: controller.signal,
      })
    ).toEqual({ status: 'blocked', message: 'Too large' });
    expect(mocks.sequence).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSurface: 'file_tree', signal: controller.signal })
    );
    controller.abort();
    expect(
      await openDocument({ target: { kind: 'file', path: '/ws/a.gb' }, signal: controller.signal })
    ).toMatchObject({ status: 'cancelled' });
    expect(mocks.sequence).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported views and does not let record requests bypass the sequence guard', async () => {
    expect(
      await openDocument({ target: { kind: 'file', path: '/ws/raw', tabType: 'chat' } })
    ).toMatchObject({ status: 'unsupported' });
    expect(
      await openDocument({
        target: { kind: 'record', entityId: 'catalog-id', tabType: 'sequence' },
      } as never)
    ).toMatchObject({ status: 'unsupported' });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });

  it('applies fresh navigation to a reused tab without duplicating it', async () => {
    const request = {
      target: { kind: 'record', tabType: 'page', entityId: 'ws::notes' },
      label: 'Notes',
      navigation: { scrollTop: 42 },
    } as const;
    const first = await openDocument(request);
    const firstNavigation = useCanvasStore.getState().panels.main.tabs[0].viewState;
    expect(await openDocument(request)).toMatchObject({ ...first, disposition: 'reused' });
    const tabs = useCanvasStore.getState().panels.main.tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].viewState?.sequenceNavigationRequestId).not.toBe(
      firstNavigation?.sequenceNavigationRequestId
    );
    expect(tabs[0].viewState).toMatchObject({ scrollTop: 42 });
  });
});
