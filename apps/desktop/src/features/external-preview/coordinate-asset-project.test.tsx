import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openExternalPreview } from '../../lib/open-external-preview';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public/store';
import { openDocument } from '../document-opening/public/open-document';
import { SourceFileViewer } from './SourceFileViewer';

const native = vi.hoisted(() => ({
  openPreview: vi.fn(),
  adoptPreview: vi.fn(),
  readPreviewPresentation: vi.fn(),
  syncPreviewTabs: vi.fn(),
  releasePreview: vi.fn(),
  savePreview: vi.fn(),
  describeProjectPreviewPackage: vi.fn(),
  readProjectPreviewPresentation: vi.fn(),
}));
const view = vi.hoisted(() => ({ molecule: vi.fn(), looseBytes: vi.fn(), registered: vi.fn() }));
vi.mock('../../platform', () => ({
  platform: () => ({
    fileAssociations: native,
    fs: {
      stat: async () => ({ isFile: true, isDirectory: false }),
      readFileBounded: view.looseBytes,
      readDir: async () => [],
    },
    workspace: { listRegisteredProjects: view.registered },
  }),
}));
vi.mock('../page/public/embeds/structure3d/LazyMolstarViewer', () => ({
  LazyMolstarViewer: (props: unknown) => {
    view.molecule(props);
    return <div data-testid="molecular-viewport" />;
  },
}));

function ActiveTab() {
  const tab = useCanvasStore((state) => {
    const panel = state.panels.main;
    return panel.tabs.find((item) => item.id === panel.activeTabId);
  });
  return tab?.sourceFileView ? (
    <SourceFileViewer key={tab.entityId} view={tab.sourceFileView} tabId={tab.id} />
  ) : null;
}

beforeEach(() => {
  vi.resetAllMocks();
  useCanvasStore.getState().reset();
  useWorkspaceStore.setState({
    folders: [{ path: '/project', name: 'Existing project', pinned: false, addedAt: 0 }],
  });
});
afterEach(cleanup);

it.each([
  { kind: 'existing', format: 'pdb' },
  { kind: 'new', format: 'bcif' },
  { kind: 'existing', format: 'cif' },
])(
  'opens, imports into a $kind project, and reopens a packaged $format coordinate asset',
  async ({ kind, format }) => {
    const name = 'model.' + format;
    const bytes = new Uint8Array(
      await readFile(
        resolve(__dirname, '../../../../../test-fixtures/structure-complexes/rcsb/1FS0.' + format)
      )
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    const receipt = {
      version: 1,
      familyId: 'structure',
      packageId: 'preview',
      sourcePath: '/unmounted/' + name,
      sourceFileName: name,
      contentHash: digest,
    };
    const owner = kind === 'existing' ? '/project' : '/new-project';
    const marker = owner + '/model/.forge/source-document.json';
    const expectedRead = {
      path: marker,
      workspaceRoot: owner,
      expectedPackageId: 'installed',
      expectedSourceSha256: digest,
    };
    const presentation = {
      familyId: 'structure',
      sourceSha256: digest,
      coordinateAsset: { format, bytes },
    };
    native.openPreview.mockResolvedValue(receipt);
    native.adoptPreview.mockResolvedValue(receipt);
    native.readPreviewPresentation.mockResolvedValue(presentation);
    native.savePreview.mockResolvedValue({
      destPath: marker,
      workspaceRoot: owner,
      records: [],
      createdNewWorkspace: kind === 'new',
    });
    view.registered.mockResolvedValue([{ path: owner }]);
    native.describeProjectPreviewPackage.mockResolvedValue({
      presentation: 'coordinate-asset',
      familyId: 'structure',
      entryPath: marker,
      sourceFileName: name,
      packageId: 'installed',
      contentHash: digest,
    });
    native.readProjectPreviewPresentation.mockResolvedValue(presentation);
    function expectCoordinatesInViewer() {
      const { structureData, structureDataFormat } = view.molecule.mock.lastCall![0];
      expect(structureDataFormat).toBe(format === 'pdb' ? 'pdb' : 'mmcif');
      if (format === 'bcif') expect(structureData).toBeInstanceOf(Uint8Array);
      else expect(typeof structureData).toBe('string');
      expect(createHash('sha256').update(structureData).digest('hex')).toBe(digest);
    }
    const tabId = await openExternalPreview(receipt.sourcePath);
    expect(tabId).toBeTruthy();
    render(<ActiveTab />);
    expect(await screen.findByTestId('molecular-viewport')).toBeVisible();
    expectCoordinatesInViewer();
    const props = view.molecule.mock.lastCall![0];
    act(() => {
      props.onPluginReady({
        managers: {
          structure: {
            hierarchy: {
              current: {
                structures: [{ cell: { obj: { data: { elementCount: 1, models: [] } } } }],
              },
            },
          },
        },
      });
      props.onLoad();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import to Project…' }));
    if (kind === 'existing') fireEvent.click(screen.getByText('Existing project'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(native.readProjectPreviewPresentation).toHaveBeenCalledWith(expectedRead)
    );
    expect(await screen.findByTestId('molecular-viewport')).toBeVisible();
    expectCoordinatesInViewer();
    expect(screen.queryByTestId('external-preview-frame')).toBeNull();
    expect(useCanvasStore.getState().panels.main.activeTabId).toBe(tabId);
    expect(native.savePreview).toHaveBeenCalledWith({
      receipt,
      destination:
        kind === 'existing'
          ? { kind: 'existing-workspace', rootPath: owner }
          : { kind: 'new-workspace', name: 'model' },
    });

    act(() => useCanvasStore.getState().closeTab('main', tabId!));
    expect(screen.queryByTestId('molecular-viewport')).toBeNull();
    await act(async () => {
      expect(
        await openDocument({ target: { kind: 'file', path: marker }, source: 'file_tree' })
      ).toMatchObject({
        status: 'presented',
      });
    });
    expect(await screen.findByTestId('molecular-viewport')).toBeVisible();
    expectCoordinatesInViewer();
    expect(native.describeProjectPreviewPackage).toHaveBeenCalledTimes(2);
    expect(native.readProjectPreviewPresentation).toHaveBeenCalledTimes(2);
    expect(native.readProjectPreviewPresentation).toHaveBeenLastCalledWith(expectedRead);
    expect(native.openPreview).toHaveBeenCalledTimes(1);
    expect(view.looseBytes).not.toHaveBeenCalled();
  }
);
