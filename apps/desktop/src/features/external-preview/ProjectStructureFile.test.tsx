import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SourceFileView } from '../../shared/external-preview';
import type { PreviewProps } from './use-preview-source';
import { useCanvasStore } from '../canvas/public/store';
import { notifyWorkspaceReconciled } from '../../services/workspace-reconciled-event';
import { SourceFileViewer } from './SourceFileViewer';

const api = vi.hoisted(() => ({
  resolve: vi.fn(),
  open: vi.fn(),
  exists: vi.fn(),
  registered: vi.fn(),
  save: vi.fn(),
  bytes: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fileAssociations: { savePreview: api.save },
    fs: { exists: api.exists, readFileBounded: api.bytes },
    molecularDocuments: { resolveImportedCoordinate: api.resolve },
    workspace: {
      listRegisteredProjects: api.registered,
    },
  }),
}));
vi.mock('../molecular-documents/public/open', () => ({ openMolecularDocument: api.open }));
vi.mock('./StructurePreview', async (load) => {
  const actual = await load<typeof import('./StructurePreview')>();
  function AcceptedPreview({ onSnapshot, controls }: PreviewProps) {
    useEffect(() => {
      onSnapshot?.('a'.repeat(64));
    }, [onSnapshot]);
    return (
      <>
        {controls?.action}
        {controls?.destination}
      </>
    );
  }
  return {
    StructurePreview: (props: PreviewProps) =>
      props.controls ? <AcceptedPreview {...props} /> : <actual.StructurePreview {...props} />,
  };
});
vi.mock('../page/public/embeds/structure3d/LazyMolstarViewer', () => ({
  LazyMolstarViewer: () => <span>Raw coordinates displayed</span>,
}));
vi.mock('./FastaPreview', () => ({ FastaPreview: () => null }));
vi.mock('./ChromatogramPreview', () => ({ ChromatogramPreview: () => null }));

import { useWorkspaceStore } from '../../stores/workspaceStore';

const loosePath = '/project/structure.pdb';
const product = '/project/structure 2.dnaforge-molecular.json';
const legacy: SourceFileView = { path: loosePath, location: 'project', format: 'structure' };
const digest = 'a'.repeat(64);
beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaceStore.setState({ folders: [] });
  useCanvasStore.setState({
    panels: { main: { id: 'main', tabs: [], activeTabId: null } },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
  api.registered.mockResolvedValue([{ path: '/project' }]);
  api.open.mockResolvedValue({ status: 'presented' });
});
afterEach(cleanup);

it.each(['existing', 'new'])(
  'opens the canonical path returned by a %s project import in its original tab',
  async (kind) => {
    const source: NonNullable<import('../canvas/types').Tab['sourceFileView']> = {
      receipt: {
        version: 1,
        packageId: 'test',
        sourcePath: '/external/structure.pdb',
        sourceFileName: 'structure.pdb',
        familyId: 'structure',
        contentHash: digest,
      },
      path: '/external/structure.pdb',
      format: 'structure',
      location: 'external',
    };
    useWorkspaceStore.setState({
      folders: [{ path: '/project', name: 'Existing project', pinned: false, addedAt: 0 }],
    });
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'file',
      entityId: 'source-view:external:' + source.path,
      label: 'structure.pdb',
      sourceFileView: source,
      readOnly: true,
    });
    function TabBody() {
      const view = useCanvasStore((s) => s.panels.main.tabs[0].sourceFileView!);
      return <SourceFileViewer key={view.path} view={view} tabId={tabId} />;
    }
    api.save.mockResolvedValue({ destPath: product, workspaceRoot: '/project', records: [] });
    render(<TabBody />);
    fireEvent.click(screen.getByRole('button', { name: 'Import to Project…' }));
    if (kind === 'existing') fireEvent.click(screen.getByText('Existing project'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.open).toHaveBeenCalledWith(
        product,
        expect.objectContaining({
          workspaceRoot: '/project',
          replaceProjectSource: { tabId, sourcePath: product },
        })
      )
    );
    expect(api.save).toHaveBeenCalledWith({
      receipt: source.receipt,
      destination: expect.objectContaining({
        kind: kind === 'existing' ? 'existing-workspace' : 'new-workspace',
      }),
    });
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.bytes).not.toHaveBeenCalled();
  }
);

it('restores a legacy loose path using completed migration evidence and the registered project', async () => {
  api.resolve.mockResolvedValue({ path: product, workspaceRoot: '/project' });
  render(<SourceFileViewer tabId="old" view={legacy} />);
  await waitFor(() =>
    expect(api.open).toHaveBeenCalledWith(
      product,
      expect.objectContaining({
        workspaceRoot: '/project',
        replaceProjectSource: { tabId: 'old', sourcePath: loosePath },
      })
    )
  );
  expect(api.resolve).toHaveBeenCalledWith({
    path: loosePath,
    workspaceRoot: '/project',
    expectedSourceSha256: undefined,
  });
  expect(api.exists).not.toHaveBeenCalled();
  expect(api.bytes).not.toHaveBeenCalled();
});

it('leaves missing and ambiguous structure imports unresolved without guessing a sibling', async () => {
  api.resolve.mockResolvedValue(null);
  api.exists.mockResolvedValue(false);
  render(<SourceFileViewer tabId="old" view={legacy} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not identify a unique saved structure'
  );
  expect(api.open).not.toHaveBeenCalled();
  expect(api.bytes).not.toHaveBeenCalled();
  api.resolve.mockRejectedValue(new Error('Ambiguous import history'));
  api.exists.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not open');
  expect(api.exists).toHaveBeenCalledTimes(1);
  expect(api.bytes).not.toHaveBeenCalled();
});

it('opens a surviving unconverted structure only when its original digest still matches', async () => {
  const bytes = new TextEncoder().encode('ATOM      1\n');
  api.bytes.mockResolvedValue(bytes);
  api.resolve.mockResolvedValue(null);
  api.exists.mockResolvedValue(true);
  const { sha256Hex } = await import('../../shared/sha256');
  const { unmount } = render(
    <SourceFileViewer
      tabId="raw"
      view={{ ...legacy, expectedSourceSha256: await sha256Hex(bytes) }}
    />
  );
  expect(await screen.findByText('Raw coordinates displayed')).toBeVisible();
  unmount();
  render(<SourceFileViewer tabId="changed" view={{ ...legacy, expectedSourceSha256: digest }} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('has changed since import');
  expect(screen.queryByText('Raw coordinates displayed')).toBeNull();
  expect(api.open).not.toHaveBeenCalled();
});

it('retargets a loose file if startup reconciliation subsequently packages it, ignoring stale reads', async () => {
  let finishEarlierLookup!: (value: null) => void;
  api.resolve
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(
      new Promise<null>((resolve) => {
        finishEarlierLookup = resolve;
      })
    )
    .mockResolvedValue({ path: product, workspaceRoot: '/project' });
  api.exists.mockResolvedValue(true);
  api.bytes.mockResolvedValue(new TextEncoder().encode('ATOM      1\n'));
  render(<SourceFileViewer tabId="restored" view={legacy} />);
  expect(await screen.findByText('Raw coordinates displayed')).toBeVisible();
  act(() => notifyWorkspaceReconciled('/other-project'));
  expect(api.resolve).toHaveBeenCalledTimes(1);
  act(() => notifyWorkspaceReconciled('/project'));
  await waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2));
  act(() => notifyWorkspaceReconciled('/project'));
  await waitFor(() =>
    expect(api.open).toHaveBeenCalledWith(
      product,
      expect.objectContaining({
        replaceProjectSource: { tabId: 'restored', sourcePath: loosePath },
      })
    )
  );
  await act(async () => finishEarlierLookup(null));
  expect(api.exists).toHaveBeenCalledTimes(1);
  expect(api.bytes).toHaveBeenCalledTimes(1);
});
