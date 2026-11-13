import { documentLifecycle } from '../../../shared/document-lifecycle';
import { CommandScopeProvider } from '../../../commands/CommandScopeProvider';
import { DocumentSaveCommands } from '../../../test/document-save-commands';
import type { ReactElement, ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render as renderReact,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackViewActions } from './TrackViewActions';
import { trackViewFixture } from '../../../shared/track-view-fixture';
import type { Tab } from '../../canvas/types';
import { getTrackViewControl } from '../track-view-control';
import { saveTargetForTab } from '../../canvas/public/artifact-document-lifecycle';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  updateTab: vi.fn(),
  open: vi.fn(),
  toast: vi.fn(),
  focusedPanelId: 'panel',
  activeTabId: 'tab-1',
  locations: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({ trackViews: { locations: mocks.locations } }),
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ folders: [{ path: '/project', name: 'My project' }] }),
}));
vi.mock('../../../components/WorkspaceFolderPicker', () => ({
  WorkspaceFolderPicker: ({ onSelectFolder }: { onSelectFolder: (path: string) => void }) => (
    <button
      type="button"
      data-testid="track-view-save-location-picker"
      onClick={() => onSelectFolder('/project/views')}
    >
      Views folder
    </button>
  ),
}));
vi.mock('../track-view-library', () => ({ saveTrackView: mocks.save }));
vi.mock('../open-track-view', () => ({ openTrackView: mocks.open }));
vi.mock('../../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.toast }) },
}));
vi.mock('../../canvas/store', () => ({
  useCanvasStore: {
    getState: () => ({
      focusedPanelId: mocks.focusedPanelId,
      panels: { panel: { id: 'panel', activeTabId: mocks.activeTabId, tabs: [props(true).tab] } },
      updateTab: mocks.updateTab,
    }),
  },
}));

function render(ui: ReactElement) {
  return renderReact(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <CommandScopeProvider>
        <DocumentSaveCommands />
        {children}
      </CommandScopeProvider>
    ),
  });
}

function props(saved = false, isActive = true) {
  const document = trackViewFixture();
  return {
    tab: {
      id: 'tab-1',
      entityId: saved ? document.id : 'assembly:sacCer3',
      label: document.name,
      type: 'sequence',
      sequenceDocument: {
        kind: 'indexed-sequence',
        documentId: saved ? document.id : 'assembly:sacCer3',
      },
      isDirty: !saved,
      ...(saved
        ? { trackView: { document, revision: 'a'.repeat(64), path: '/library/view.json' } }
        : {}),
    } as Tab,
    referenceName: document.reference.name,
    capture: () => document,
    isActive,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.focusedPanelId = 'panel';
  mocks.activeTabId = 'tab-1';
  mocks.locations.mockResolvedValue({ defaultDirectory: '/library', homeDirectory: '/home' });
  mocks.save.mockImplementation(async ({ document }) => ({
    saved: { document, revision: 'b'.repeat(64), path: '/library/view.json' },
  }));
});

describe('Track view actions', () => {
  it('accepts a view-owned save request without handling biological sequence commands', async () => {
    const input = props(true);
    render(<TrackViewActions {...input} />);
    await act(async () => {
      expect(
        await documentLifecycle.save({ kind: 'sequence-document', documentId: input.tab.entityId })
      ).toBe(false);
    });
    expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => {
      expect(await documentLifecycle.save({ kind: 'tab', tabId: input.tab.id }, input.tab.id)).toBe(
        true
      );
    });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
  });

  it('shares the native save owner with agent callers and fences changed live views', async () => {
    let snapshot = trackViewFixture();
    const initial = props(true);
    const { unmount } = render(<TrackViewActions {...initial} capture={() => snapshot} />);
    const control = getTrackViewControl(initial.tab.id);
    expect(control).not.toBeNull();
    const inspected = control!.inspect();
    snapshot = {
      ...snapshot,
      viewport: { ...snapshot.viewport, start0: snapshot.viewport.start0 + 1 },
    };
    const stale = await control!.save({
      name: 'Stale overwrite',
      mode: 'save',
      expectedRevision: inspected.revision,
    });
    expect(stale).toMatchObject({ ok: false });
    expect(mocks.save).not.toHaveBeenCalled();
    const current = control!.inspect();
    let result;
    await act(async () => {
      result = await control!.save({
        name: 'Current view',
        mode: 'save',
        expectedRevision: current.revision,
      });
    });
    expect(result).toMatchObject({
      ok: true,
      saved: { document: { name: 'Current view', viewport: snapshot.viewport } },
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    unmount();
    expect(getTrackViewControl(initial.tab.id)).toBeNull();
  });

  it('preserves the name a person is typing when an agent requests a save', async () => {
    const initial = props(true);
    render(<TrackViewActions {...initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track view actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save As…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Track view name' }), {
      target: { value: 'Human pending name' },
    });
    const control = getTrackViewControl(initial.tab.id)!;
    const result = await control.save({
      name: 'Agent replacement',
      mode: 'save',
      expectedRevision: control.inspect().revision,
    });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Track view name' })).toHaveValue(
      'Human pending name'
    );
  });

  it.each(['same owner', 'duplicate owners'])(
    'keeps concurrent close requests correlated for %s',
    async (ownership) => {
      const input = props(true);
      const sibling = { ...props(true), tab: { ...input.tab, id: 'tab-2' } };
      const pending = Promise.withResolvers<unknown>();
      mocks.save.mockReturnValue(pending.promise);
      const completions: { requestId: string; sourceTabId: string; success: boolean }[] = [];
      try {
        render(
          <>
            <TrackViewActions {...input} />
            {ownership === 'duplicate owners' && <TrackViewActions {...sibling} />}
          </>
        );
        const send = (requestId: string, sourceTabId: string) => {
          void documentLifecycle
            .save(
              saveTargetForTab(sourceTabId === sibling.tab.id ? sibling.tab : input.tab),
              sourceTabId
            )
            .then((success) => completions.push({ requestId, sourceTabId, success }));
        };
        await act(async () => {
          send('track-a', input.tab.id);
        });
        await act(async () => {
          send('track-b', ownership === 'duplicate owners' ? sibling.tab.id : input.tab.id);
        });
        await act(async () => {
          pending.resolve({
            saved: {
              document: input.capture(),
              revision: 'b'.repeat(64),
              path: '/library/view.json',
            },
          });
        });
        expect(completions.map((result) => result.requestId).sort()).toEqual([
          'track-a',
          'track-b',
        ]);
        expect(completions.find((result) => result.requestId === 'track-a')).toMatchObject({
          success: true,
          sourceTabId: input.tab.id,
        });
        expect(completions.find((result) => result.requestId === 'track-b')).toMatchObject({
          success: true,
          sourceTabId: ownership === 'duplicate owners' ? sibling.tab.id : input.tab.id,
        });
        expect(mocks.save).toHaveBeenCalledTimes(ownership === 'duplicate owners' ? 2 : 1);
      } finally {
        cleanup();
      }
    }
  );

  it('uses a high-contrast, heavier ellipsis trigger', () => {
    render(<TrackViewActions {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Track view actions' });
    const icon = trigger.querySelector('svg');
    expect(icon).toHaveClass('h-5', 'w-5', 'text-fg');
    expect(icon?.querySelector('path')).toHaveAttribute('stroke-width', '3');
  });

  it('shows Save view and Save As without a duplicate editable-view Export command', () => {
    render(<TrackViewActions {...props(true)} />);
    expect(screen.getByRole('button', { name: 'Save view' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Track view actions' }));
    expect(screen.getByRole('menuitem', { name: 'Save As…' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Export view' })).not.toBeInTheDocument();
  });

  it('keeps the accessible label without a tooltip wrapper', () => {
    render(<TrackViewActions {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Track view actions' });
    const hoverTarget = trigger.parentElement;
    if (!hoverTarget) throw new Error('Track view action hover target is missing');

    fireEvent.mouseEnter(hoverTarget);

    expect(trigger).toHaveAttribute('aria-label', 'Track view actions');
    expect(hoverTarget).toHaveClass('relative');
    expect(hoverTarget).not.toHaveClass('inline-flex');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('keeps the viewer clear and cancels first-save naming without creating an entity', () => {
    render(<TrackViewActions {...props()} />);
    expect(screen.queryByRole('textbox', { name: 'Track view name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Save Track view' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(screen.getByRole('textbox', { name: 'Track view name' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Track view name' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Track view name' })).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('saves only the active entity using its existing revision through Ctrl+S', async () => {
    mocks.activeTabId = 'other-tab';
    const { rerender } = render(<TrackViewActions {...props(true, false)} />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.activeTabId = 'tab-1';
    rerender(<TrackViewActions {...props(true)} />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0][0]).toMatchObject({
      expectedRevision: 'a'.repeat(64),
      document: { id: trackViewFixture().id, name: trackViewFixture().name },
    });
    expect(screen.queryByRole('textbox', { name: 'Track view name' })).not.toBeInTheDocument();
  });

  it('names a copy without overwriting the existing entity', async () => {
    render(<TrackViewActions {...props(true)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track view actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save As…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Track view name' }), {
      target: { value: 'Independent copy' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Track view', exact: true })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Track view', exact: true }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    const request = mocks.save.mock.calls[0][0];
    expect(request.expectedRevision).toBeNull();
    expect(request.document.id).not.toBe(trackViewFixture().id);
    expect(request.document.name).toBe('Independent copy');
    expect(mocks.updateTab).not.toHaveBeenCalled();
  });

  it('does not save a visible view in an unfocused split panel', () => {
    mocks.focusedPanelId = 'another-panel';
    render(<TrackViewActions {...props(true)} />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('opens an in-app save modal and preserves it until explicit cancellation', () => {
    render(<TrackViewActions {...props()} />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(screen.getByRole('textbox', { name: 'Track view name' })).toHaveFocus();
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('dialog', { name: 'Save Track view' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Track view name' })).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('uses the project picker for save-on-close and reports success only after the write', async () => {
    const complete = vi.fn();
    render(<TrackViewActions {...props()} />);
    act(() => {
      void documentLifecycle.save(saveTargetForTab(props().tab), props().tab.id).then(complete);
    });
    expect(screen.getByRole('dialog', { name: 'Save Track view' })).toBeVisible();
    await screen.findByTestId('track-view-save-location-picker');
    fireEvent.click(screen.getByRole('button', { name: 'Views folder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Track view name' }), {
      target: { value: 'My saved view' },
    });
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save Track view', exact: true }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[0][0]).toMatchObject({
      destination: {
        workspaceRoot: '/project',
        path: '/project/views/My saved view.dnaforge-track-view.json',
      },
    });
    expect(complete).toHaveBeenCalledWith(true);
    expect(mocks.updateTab).toHaveBeenCalledWith(
      'panel',
      'tab-1',
      expect.objectContaining({ trackView: expect.anything() })
    );
  });

  it('cancels save-on-close without writing or declaring the view saved', async () => {
    const complete = vi.fn();
    render(<TrackViewActions {...props()} />);
    act(() => {
      void documentLifecycle.save(saveTargetForTab(props().tab), props().tab.id).then(complete);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.save).not.toHaveBeenCalled();
    await waitFor(() => expect(complete).toHaveBeenCalledWith(false));
  });

  it('keeps an older saved view clean when opening discovers its reference identity', () => {
    const initial = props(true);
    const upgraded = {
      ...initial.capture(),
      reference: {
        ...(initial.capture().reference as Record<string, unknown>),
        sequenceIdentity: 'a'.repeat(64),
      },
    };
    render(<TrackViewActions {...initial} capture={() => upgraded} />);
    expect(mocks.updateTab).not.toHaveBeenCalled();
  });

  it('marks a saved view dirty when its viewport changes', () => {
    const input = props(true);
    render(
      <TrackViewActions
        {...input}
        capture={() => ({ ...input.capture(), viewport: { start0: 200, end0: 900 } })}
      />
    );
    expect(mocks.updateTab).toHaveBeenCalledWith('panel', 'tab-1', { isDirty: true });
  });

  it('marks a saved view clean again when undo restores its saved configuration', () => {
    const saved = props(true);
    const edited = {
      ...saved,
      tab: { ...saved.tab, isDirty: true },
      capture: () => ({ ...saved.capture(), viewport: { start0: 200, end0: 900 } }),
    };
    const { rerender } = render(<TrackViewActions {...edited} />);
    expect(documentLifecycle.dirty(saveTargetForTab(edited.tab), edited.tab.id)).toBe(true);
    mocks.updateTab.mockClear();

    rerender(<TrackViewActions {...edited} capture={saved.capture} />);

    expect(documentLifecycle.dirty(saveTargetForTab(edited.tab), edited.tab.id)).toBe(false);
  });

  it('waits for view restoration before treating a viewport difference as an edit', () => {
    const input = props(true);
    const capture = () => ({ ...input.capture(), viewport: { start0: 200, end0: 900 } });
    const { rerender } = render(
      <TrackViewActions {...input} capture={capture} readyForDirtyCheck={false} />
    );
    expect(mocks.updateTab).not.toHaveBeenCalled();
    rerender(<TrackViewActions {...input} readyForDirtyCheck />);
    expect(mocks.updateTab).not.toHaveBeenCalled();
    rerender(<TrackViewActions {...input} capture={capture} readyForDirtyCheck />);
    expect(mocks.updateTab).toHaveBeenCalledWith('panel', 'tab-1', { isDirty: true });
  });

  it('does not close away edits made while a previous save was writing', async () => {
    const input = props(true);
    let current = input.capture();
    let finish: (value: unknown) => void = () => undefined;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const complete = vi.fn();
    render(<TrackViewActions {...input} capture={() => current} />);
    act(() => {
      void documentLifecycle.save(saveTargetForTab(input.tab), input.tab.id).then(complete);
    });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    current = { ...current, viewport: { start0: 500, end0: 900 } };
    finish({
      saved: {
        document: mocks.save.mock.calls[0][0].document,
        revision: 'b'.repeat(64),
        path: '/project/view.dnaforge-track-view.json',
      },
    });
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await waitFor(() => expect(complete).toHaveBeenCalledWith(false));
    expect(mocks.updateTab.mock.calls.at(-1)?.[2]).toMatchObject({ isDirty: true });
  });

  it('keeps a rejected rename editable and retries against the existing revision', async () => {
    mocks.save.mockRejectedValueOnce(new Error('This Track view changed on disk.'));
    render(<TrackViewActions {...props(true)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Track view actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Track view name' }), {
      target: { value: 'Renamed view' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename', exact: true }));
    await screen.findByRole('alert');
    expect(mocks.updateTab).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Track view name' })).toHaveValue('Renamed view');
    fireEvent.click(screen.getByRole('button', { name: 'Rename', exact: true }));
    await waitFor(() => expect(mocks.updateTab).toHaveBeenCalledOnce());
    expect(mocks.save.mock.calls[1][0]).toMatchObject({
      expectedRevision: 'a'.repeat(64),
      document: { id: trackViewFixture().id, name: 'Renamed view' },
    });
    expect(screen.queryByRole('textbox', { name: 'Track view name' })).not.toBeInTheDocument();
  });

  it('does not duplicate a pending save when the shortcut repeats', async () => {
    let finish!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<TrackViewActions {...props(true)} />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    finish({
      saved: { document: trackViewFixture(), revision: 'b'.repeat(64), path: '/library/view.json' },
    });
    await waitFor(() => expect(mocks.updateTab).toHaveBeenCalledOnce());
  });
});
