import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentLifecycle } from '../../../shared/document-lifecycle';
import { trackViewFixture } from '../../../shared/track-view-fixture';
import { useCanvasStore } from '../../canvas/store';
import { getTrackViewControl } from '../track-view-control';
import { controls } from './track-view-session-test-controls';

const boundary = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn(), toast: vi.fn() }));
vi.mock('../track-view-library', () => ({ saveTrackView: boundary.save }));
vi.mock('../open-track-view', () => ({ openTrackView: boundary.open }));
vi.mock('../../../stores/toast-store', () => ({ useToastStore: { getState: () => ({ addToast: boundary.toast }) } }));
vi.mock('../../../platform', () => ({ platform: () => ({ trackViews: { locations: async () => ({ defaultDirectory: '/project', homeDirectory: '/home' }) } }) }));
vi.mock('../../../components/WorkspaceFolderPicker', () => ({ WorkspaceFolderPicker: () => null }));

function open(saved = true, dirty = false) {
  const document = trackViewFixture();
  const entityId = saved ? document.id : 'assembly:session-reference';
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence', entityId, label: document.name, isDirty: dirty,
    sequenceDocument: { kind: 'indexed-sequence', documentId: entityId },
    ...(saved ? { trackView: { document, revision: 'a'.repeat(64), path: '/project/session.dnaforge-track-view.json', workspaceRoot: '/project' } } : {}),
  });
  const tab = () => useCanvasStore.getState().panels.main.tabs.find(t => t.id === tabId)!;
  return { tabId, tab, document };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.setState({ panels: { main: { id: 'main', tabs: [], activeTabId: null } }, focusedPanelId: 'main' });
  boundary.save.mockImplementation(async ({ document }) => ({ saved: { document, revision: 'b'.repeat(64), path: '/project/session.dnaforge-track-view.json', workspaceRoot: '/project' } }));
});
afterEach(() => { cleanup(); useCanvasStore.getState().closeAllTabs(); });

describe('Track view tab-session acceptance', () => {
  it('can inspect and rename a saved open tab before controls mount', async () => {
    const input = open();
    const owner = getTrackViewControl(input.tabId);
    expect(owner).not.toBeNull();
    const before = owner!.inspect();
    const result = await owner!.save({ mode: 'rename', name: 'Headless rename', expectedRevision: before.revision });
    expect(result).toMatchObject({ ok: true, saved: { document: { name: 'Headless rename', viewport: input.document.viewport } } });
    expect(input.tab().trackView?.document.name).toBe('Headless rename');
  });
  it('keeps the owner and saved baseline when controls unmount', async () => {
    const input = open();
    const ui = controls(input.tab());
    const owner = getTrackViewControl(input.tabId)!;
    expect(owner).not.toBeNull();
    ui.unmount();
    expect(getTrackViewControl(input.tabId)).toBe(owner);
    const result = await owner.save({ mode: 'rename', name: 'Detached rename', expectedRevision: owner.inspect().revision });
    expect(result).toMatchObject({ ok: true });
    expect(input.tab().trackView?.document.name).toBe('Detached rename');
  });
  it('preserves an already dirty saved view while restoration is unready', () => {
    const input = open(true, true);
    controls(input.tab(), () => input.document, false);
    expect(input.tab().isDirty).toBe(true);
    expect(documentLifecycle.dirty({ kind: 'tab', tabId: input.tabId }, input.tabId)).toBe(true);
  });
  it('rejects an agent revision captured before a live configuration change', async () => {
    const input = open();
    let snapshot = input.document;
    controls(input.tab(), () => snapshot);
    const owner = getTrackViewControl(input.tabId)!;
    const before = owner.inspect();
    snapshot = { ...snapshot, viewport: { start0: 200, end0: 900 } };
    const result = await owner.save({ mode: 'save', name: 'Stale', expectedRevision: before.revision });
    expect(result.ok).toBe(false);
    expect(boundary.save).not.toHaveBeenCalled();
  });
  it('keeps edits made during an outstanding native save dirty', async () => {
    const input = open();
    let snapshot = input.document;
    const pending = Promise.withResolvers<unknown>();
    boundary.save.mockReturnValue(pending.promise);
    controls(input.tab(), () => snapshot);
    let saving!: Promise<boolean>;
    act(() => { saving = documentLifecycle.save({ kind: 'tab', tabId: input.tabId }, input.tabId); });
    await waitFor(() => expect(boundary.save).toHaveBeenCalledOnce());
    snapshot = { ...snapshot, viewport: { start0: 500, end0: 1000 } };
    await act(async () => pending.resolve({ saved: { document: boundary.save.mock.calls[0][0].document, revision: 'b'.repeat(64), path: '/project/session.dnaforge-track-view.json' } }));
    expect(await saving).toBe(false);
    expect(input.tab().isDirty).toBe(true);
  });
  it('settles cancelled first-save naming without a native write', async () => {
    const input = open(false, true);
    controls(input.tab());
    let saving!: Promise<boolean>;
    act(() => { saving = documentLifecycle.save({ kind: 'tab', tabId: input.tabId }, input.tabId); });
    await screen.findByRole('dialog', { name: 'Save Track view' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(await saving).toBe(false);
    expect(boundary.save).not.toHaveBeenCalled();
    expect(input.tab().isDirty).toBe(true);
  });
  it('removes command authority when the tab is actually closed', () => {
    const input = open();
    const ui = controls(input.tab());
    act(() => useCanvasStore.getState().closeTab('main', input.tabId));
    ui.unmount();
    expect(getTrackViewControl(input.tabId)).toBeNull();
    expect(documentLifecycle.has({ kind: 'tab', tabId: input.tabId }, input.tabId)).toBe(false);
  });
});
