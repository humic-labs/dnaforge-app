import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TAB_PORTAL_HOST_ATTACHED_EVENT } from '../../../../../shared/tab-portal-contract';
import type { MolstarViewerProps } from '../MolstarViewer';
import { coordinateDigest, type MolecularView } from '../utils/molecularView';
import { MolecularViewPreview } from './MolecularViewPreview';
import { WorkspaceVisibilityContext } from '../../../../canvas/workspace-visibility';

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));
vi.mock('../molstar/cache', () => ({
  acquireCachedViewerLease: mocks.acquire,
  releaseCachedViewerLease: mocks.release,
  getPaneRendererHostCacheKey: (id: string) => `inset-cache:${id}`,
}));
vi.mock('../LazyMolstarViewer', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    LazyMolstarViewer: (props: MolstarViewerProps) => {
      mocks.viewer(props);
      useEffect(() => props.onLoad?.(), [props.onLoad]);
      return (
        <button onClick={() => props.onCameraChange?.('{"position":[1,2,3]}')}>
          Inspect mock camera
        </button>
      );
    },
  };
});

let observers: Set<VisibilityObserver>;
class VisibilityObserver {
  target: Element | null = null;
  observations = 0;
  constructor(readonly callback: IntersectionObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.target = target;
    this.observations += 1;
    observers.add(this);
  }
  disconnect() {
    observers.delete(this);
  }
}
function visibility(visible: boolean) {
  act(() => {
    for (const observer of observers) {
      observer.callback(
        [{ isIntersecting: visible, target: observer.target } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver
      );
    }
  });
}
async function savedView(): Promise<MolecularView> {
  const text = 'HEADER    pinned structure preview';
  return {
    kind: 'molecular-view',
    version: 1,
    title: 'Saved ligand pocket',
    caption: '',
    coordinates: { format: 'cif', text, sha256: await coordinateDigest(text) },
    scene: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
    cameraSnapshot: '{"position":[0,0,10]}',
    source: {},
    evidence: [],
    preview: 'data:image/png;base64,iVBORw0KGgo=',
    createdAt: 1,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.clearAllMocks();
  observers = new Set();
  vi.stubGlobal('IntersectionObserver', VisibilityObserver);
});

describe('interactive saved molecular preview', () => {
  it('suspends an intersecting chat preview during a workspace takeover and restores its camera', async () => {
    const view = await savedView();
    const original = JSON.stringify(view);
    const renderPreview = (visible: boolean) => (
      <WorkspaceVisibilityContext.Provider value={visible}>
        <MolecularViewPreview view={view} referenceId="saved-a" />
      </WorkspaceVisibilityContext.Provider>
    );
    const { rerender } = render(renderPreview(true));
    visibility(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect mock camera' }));
    const cacheKey = mocks.acquire.mock.lastCall![0];
    rerender(renderPreview(false));
    expect(screen.queryByTestId('molecular-view-inset-saved-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('molecular-view-preview-saved-a')).not.toBeVisible();
    expect(mocks.release).toHaveBeenCalledWith(cacheKey);
    rerender(renderPreview(true));
    await screen.findByRole('button', { name: 'Inspect mock camera' });
    expect(mocks.viewer.mock.lastCall![0].cameraSnapshot).toBe('{"position":[1,2,3]}');
    expect(JSON.stringify(view)).toBe(original);
  });

  it('keeps the preview key controlled by the chat card active view', async () => {
    const view = await savedView();
    view.scene = JSON.stringify({
      kind: 'multiple',
      snapshots: [
        { root: { kind: 'root' }, metadata: { title: 'Overview' } },
        { root: { kind: 'root' }, metadata: { title: 'Detail' } },
      ],
    });
    const changed = vi.fn();
    const { rerender } = render(
      <MolecularViewPreview
        view={view}
        referenceId="saved-a"
        activeSnapshotIndex={1}
        onSnapshotIndexChange={changed}
      />
    );
    expect(screen.getByTestId('molecular-view-key-title')).toHaveTextContent('Detail');
    rerender(
      <MolecularViewPreview
        view={view}
        referenceId="saved-a"
        activeSnapshotIndex={0}
        onSnapshotIndexChange={changed}
      />
    );
    expect(screen.getByTestId('molecular-view-key-title')).toHaveTextContent('Overview');
    fireEvent.click(screen.getByRole('button', { name: 'Next view' }));
    expect(changed).toHaveBeenCalledWith(1);
    expect(screen.getByTestId('molecular-view-key-title')).toHaveTextContent('Overview');
  });

  it('mounts the existing viewer only when visible, with verified pinned bytes and an independent identity', async () => {
    const view = await savedView();
    render(<MolecularViewPreview view={view} referenceId="saved-a" />);
    expect(mocks.viewer).not.toHaveBeenCalled();
    expect(screen.getByRole('img')).toHaveAttribute('src', view.preview);
    visibility(true);
    await screen.findByRole('button', { name: 'Inspect mock camera' });
    const props = mocks.viewer.mock.lastCall![0] as MolstarViewerProps;
    expect(props).toMatchObject({
      structureData: view.coordinates.text,
      structureDataFormat: 'mmcif',
      structureKeyOverride: 'molecular-view:saved-a',
      molViewSpec: view.scene,
      cameraSnapshot: view.cameraSnapshot,
      scrollZoom: false,
      deferWhileScrolling: true,
    });
    expect(props.rendererHostId).toMatch(/^chat-inset:saved-a:/);
    await waitFor(() =>
      expect(screen.getByTestId('molecular-view-inset-saved-a')).toHaveAttribute(
        'data-preview-state',
        'loaded'
      )
    );
  });

  it('releases offscreen viewers and preserves local camera inspection without modifying the saved reference', async () => {
    const view = await savedView();
    const immutable = JSON.stringify(view);
    render(<MolecularViewPreview view={view} referenceId="saved-a" />);
    visibility(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect mock camera' }));
    const cacheKey = mocks.acquire.mock.lastCall![0];
    visibility(false);
    expect(screen.queryByTestId('molecular-view-inset-saved-a')).not.toBeInTheDocument();
    expect(mocks.release).toHaveBeenCalledWith(cacheKey);
    visibility(true);
    await screen.findByRole('button', { name: 'Inspect mock camera' });
    expect(mocks.viewer.mock.lastCall![0].cameraSnapshot).toBe('{"position":[1,2,3]}');
    expect(JSON.stringify(view)).toBe(immutable);
  });

  it('switches story steps in the same inline viewer without changing the saved reference', async () => {
    const view = await savedView();
    const coloredRoot = (color: string, label: string) => ({
      kind: 'root',
      children: [
        {
          kind: 'representation',
          children: [
            {
              kind: 'color',
              params: { color },
              custom: { dnaforge_legend_label: label },
            },
          ],
        },
      ],
    });
    view.scene = JSON.stringify({
      kind: 'multiple',
      metadata: { version: '1.0', timestamp: '2026-09-30T00:00:00Z' },
      snapshots: [
        {
          root: coloredRoot('#3366cc', 'Whole protein'),
          metadata: { title: 'Overview', linger_duration_ms: 1000 },
        },
        {
          root: coloredRoot('#cc6633', 'Ligand pocket'),
          metadata: { title: 'Pocket', linger_duration_ms: 1000 },
        },
      ],
    });
    view.initialSnapshotIndex = 1;
    const immutable = JSON.stringify(view);
    render(<MolecularViewPreview view={view} referenceId="saved-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse 2 views' }));
    expect(screen.getByRole('option', { name: /Pocket/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('structure-color-legend')).toHaveTextContent('Ligand pocket');
    expect(screen.getByTestId('structure-color-legend')).not.toHaveTextContent('Whole protein');
    visibility(true);
    await screen.findByRole('button', { name: 'Inspect mock camera' });
    expect(mocks.viewer.mock.lastCall![0].molViewSpecSnapshotIndex).toBe(1);
    const selectionRevision = mocks.viewer.mock.lastCall![0].molViewSpecSelectionRevision ?? 0;
    fireEvent.click(screen.getByRole('option', { name: /Pocket/ }));
    expect(mocks.viewer.mock.lastCall![0].molViewSpecSelectionRevision).toBeGreaterThan(
      selectionRevision
    );
    expect(mocks.viewer.mock.lastCall![0].molViewSpecSnapshotIndex).toBe(1);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse 2 views' }));
    fireEvent.click(screen.getByRole('option', { name: /Overview/ }));
    expect(mocks.viewer.mock.lastCall![0].molViewSpecSnapshotIndex).toBe(0);
    expect(screen.getByTestId('structure-color-legend')).toHaveTextContent('Whole protein');
    expect(screen.getByTestId('structure-color-legend')).not.toHaveTextContent('Ligand pocket');
    expect(JSON.stringify(view)).toBe(immutable);
  });

  it('renews visibility observation when its stable chat host is reattached to a pane', async () => {
    const view = await savedView();
    const rendered = render(
      <div id="tab-content-chat-a">
        <MolecularViewPreview view={view} referenceId="saved-a" />
      </div>
    );
    visibility(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect mock camera' }));
    const observer = [...observers][0];
    const host = rendered.container.querySelector('#tab-content-chat-a')!;
    visibility(false);
    act(() => host.dispatchEvent(new CustomEvent(TAB_PORTAL_HOST_ATTACHED_EVENT)));
    expect(observer.observations).toBe(2);
    visibility(true);
    await screen.findByRole('button', { name: 'Inspect mock camera' });
    expect(mocks.viewer.mock.lastCall![0].cameraSnapshot).toBe('{"position":[1,2,3]}');
    rendered.unmount();
    act(() => host.dispatchEvent(new CustomEvent(TAB_PORTAL_HOST_ATTACHED_EVENT)));
    expect(observer.observations).toBe(2);
  });

  it('reports corrupted coordinates before creating any native viewer', async () => {
    const view = await savedView();
    view.coordinates.sha256 = '0'.repeat(64);
    render(<MolecularViewPreview view={view} referenceId="saved-a" />);
    visibility(true);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      userMessage('failure.saved-structure-data-could-not-be-verified')
    );
    expect(mocks.viewer).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('keeps disabled previews static and isolates duplicate appearances of one saved reference', async () => {
    const view = await savedView();
    const disabled = render(
      <MolecularViewPreview view={view} referenceId="saved-a" enabled={false} />
    );
    visibility(true);
    expect(mocks.viewer).not.toHaveBeenCalled();
    disabled.unmount();
    render(
      <>
        <MolecularViewPreview view={view} referenceId="saved-a" />
        <MolecularViewPreview view={view} referenceId="saved-a" />
      </>
    );
    visibility(true);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Inspect mock camera' })).toHaveLength(2)
    );
    const ids = new Set(mocks.viewer.mock.calls.map(([props]) => props.rendererHostId));
    expect(ids.size).toBe(2);
  });
});
