import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appViewsOutputSchema, appViewsSchema, createAppViewsTool } from './app-views';
import { registerCatalogEntity } from '../../../db/workspace-catalog';
import { clearMockData } from '../../../test/platform-mocks';
import { initializeTestSchema } from '../../../test/initializeTestSchema';
import { useCanvasStore } from '../../canvas/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { execTool, resetCanvasStore } from './test-helpers';
import * as workspaceCatalog from '../../../db/workspace-catalog';

describe('saved views use the existing app_views interface', () => {
  it.each([
    { kind: 'list', offset: 0, limit: 20 },
    { kind: 'open', viewId: 'track-view-existing' },
    { kind: 'inspect', tabId: 'tab-existing' },
    { kind: 'inspect-tracks', tabId: 'tab-existing' },
    {
      kind: 'configure-tracks',
      tabId: 'tab-existing',
      expectedRevision: 'current-layout',
      command: { kind: 'set-visibility', trackId: 'promoters', visible: false },
    },
    { kind: 'save', tabId: 'tab-existing', name: 'Genes', expectedRevision: 'current' },
    { kind: 'rename', tabId: 'tab-existing', name: 'New name', expectedRevision: 'current' },
    {
      kind: 'duplicate',
      tabId: 'tab-existing',
      name: 'Independent view',
      expectedRevision: 'current',
    },
  ])('accepts the familiar $kind operation', (operation) => {
    expect(appViewsSchema.safeParse({ operation }).success).toBe(true);
  });

  it('requires an inspected revision before a view can be saved', () => {
    expect(
      appViewsSchema.safeParse({
        operation: { kind: 'save', tabId: 'tab-existing', name: 'Genes' },
      }).success
    ).toBe(false);
  });

  it('keeps ordinary canvas inspection backward compatible', () => {
    expect(appViewsSchema.parse({ operation: { kind: 'inspect' } })).toEqual({
      operation: { kind: 'inspect' },
    });
  });

  it('requires the inspected track revision before changing an annotation layout', () => {
    expect(
      appViewsSchema.safeParse({
        operation: {
          kind: 'configure-tracks',
          tabId: 'tab-existing',
          command: { kind: 'set-visibility', trackId: 'promoters', visible: false },
        },
      }).success
    ).toBe(false);
  });
});

describe('app_views project access', () => {
  const first = { name: 'First project', path: '/projects/first', addedAt: 1 };
  const second = { name: 'Second project', path: '/projects/second', addedAt: 2 };
  const restricted = () => createAppViewsTool([first], { kind: 'project-roots', roots: [first.path] });

  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
    resetCanvasStore();
    for (const [entityId, root] of [['first-file', first.path], ['second-file', second.path]]) {
      await registerCatalogEntity({
        id: entityId,
        type: 'file',
        name: entityId,
        locator: `entity://file/${entityId}`,
        storageType: 'database',
        workspaceRoot: root,
      });
    }
    useWorkspaceStore.setState({ folders: [second] });
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [{ id: 'first-tab', type: 'file', entityId: 'first-file', label: 'First file' }], activeTabId: 'first-tab' },
        destination: { id: 'destination', tabs: [{ id: 'first-copy', type: 'file', entityId: 'first-file', label: 'First file copy' }], activeTabId: 'first-copy' },
        private: { id: 'private', tabs: [{ id: 'second-tab', type: 'file', entityId: 'second-file', label: 'PRIVATE_SECOND_FILE' }], activeTabId: 'second-tab' },
      },
      layout: { type: 'split', direction: 'horizontal', children: [{ type: 'panel', panelId: 'main' }, { type: 'panel', panelId: 'destination' }, { type: 'panel', panelId: 'private' }], sizes: [30, 30, 40] },
      focusedPanelId: 'private',
      recentlyClosed: [],
    });
  });

  it('inspects only owned tabs and layout even when the granted project is hidden', async () => {
    const result = await execTool<Record<string, unknown>>(restricted(), { operation: { kind: 'inspect' } });
    expect(appViewsOutputSchema.safeParse(result).success).toBe(true);
    expect(result.focusedPanelId).toBeNull();
    expect(result.layout).toEqual({ type: 'split', direction: 'horizontal', children: [{ type: 'panel', panelId: 'main' }, { type: 'panel', panelId: 'destination' }], sizes: [50, 50] });
    expect((result.panels as Array<{ id: string }>).map((panel) => panel.id)).toEqual(['main', 'destination']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECOND_FILE');
    expect(JSON.stringify(result)).not.toContain('second-file');
  });

  it.each(['activate', 'move', 'close'] as const)('refuses %s on another project without changing the canvas', async (kind) => {
    const before = useCanvasStore.getState();
    const operation = kind === 'move' ? { kind, tabId: 'second-tab', panelId: 'main' } : { kind, tabId: 'second-tab' };
    const result = await execTool(restricted(), { operation });
    expect(result).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE', stateChanged: false });
    expect(useCanvasStore.getState().panels).toEqual(before.panels);
    expect(useCanvasStore.getState().focusedPanelId).toBe(before.focusedPanelId);
  });

  it.each(['activate', 'move', 'close'] as const)('allows %s on an owned tab while its project is hidden', async (kind) => {
    const operation = kind === 'move' ? { kind, tabId: 'first-tab', panelId: 'destination' } : { kind, tabId: 'first-tab' };
    const result = await execTool(restricted(), { operation });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(useCanvasStore.getState().panels.private.tabs.map((tab) => tab.id)).toEqual(['second-tab']);
  });

  it('refuses moving an owned tab to an unowned panel', async () => {
    const before = useCanvasStore.getState();
    const result = await execTool(restricted(), { operation: { kind: 'move', tabId: 'first-tab', panelId: 'private' } });
    expect(result).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE', stateChanged: false });
    expect(useCanvasStore.getState().panels).toEqual(before.panels);
  });

  it('refuses structural changes that would move another project tabs', async () => {
    const before = useCanvasStore.getState();
    const result = await execTool(restricted(), { operation: { kind: 'join-all' } });
    expect(result).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE', stateChanged: false });
    expect(useCanvasStore.getState().panels).toEqual(before.panels);
  });

  it('refuses reopening a closed tab from another project', async () => {
    useCanvasStore.setState({ recentlyClosed: [{ tab: useCanvasStore.getState().panels.private.tabs[0], panelId: 'main', index: 0 }] });
    const before = useCanvasStore.getState();
    const result = await execTool(restricted(), { operation: { kind: 'reopen-last-closed' } });
    expect(result).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE', stateChanged: false });
    expect(useCanvasStore.getState().recentlyClosed).toEqual(before.recentlyClosed);
  });

  it('preserves app-following inspection across both projects', async () => {
    const result = await execTool<Record<string, unknown>>(createAppViewsTool([first, second], { kind: 'app-following' }), { operation: { kind: 'inspect' } });
    expect(appViewsOutputSchema.safeParse(result).success).toBe(true);
    expect(result.focusedPanelId).toBe('private');
    expect(JSON.stringify(result)).toContain('PRIVATE_SECOND_FILE');
  });

  it('returns a valid empty inspection when no tab belongs to the explicit scope', async () => {
    const result = await execTool<Record<string, unknown>>(createAppViewsTool([], { kind: 'project-roots', roots: [] }), { operation: { kind: 'inspect' } });
    expect(appViewsOutputSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ panels: [], focusedPanelId: null, layout: { type: 'split', children: [], sizes: [] } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECOND_FILE');
  });

  it('allows structural changes when every affected tab has an authorized owner', async () => {
    const { main, destination } = useCanvasStore.getState().panels;
    useCanvasStore.setState({ panels: { main, destination }, layout: { type: 'split', direction: 'horizontal', children: [{ type: 'panel', panelId: 'main' }, { type: 'panel', panelId: 'destination' }], sizes: [50, 50] }, focusedPanelId: 'main' });
    const result = await execTool(restricted(), { operation: { kind: 'join-all' } });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs).map((tab) => tab.id)).toEqual(['first-tab', 'first-copy']);
  });

  it('allows reopening a closed owned tab while its project is hidden', async () => {
    useCanvasStore.setState({ recentlyClosed: [{ tab: { id: 'closed-first', type: 'file', entityId: 'first-file', label: 'First closed file' }, panelId: 'main', index: 0 }] });
    const result = await execTool(restricted(), { operation: { kind: 'reopen-last-closed' } });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(useCanvasStore.getState().recentlyClosed).toEqual([]);
    expect(useCanvasStore.getState().panels.private.tabs.map((tab) => tab.id)).toEqual(['second-tab']);
  });

  it('moves an owned tab into the empty panel returned by a real app_views split', async () => {
    const split = await execTool<{ ok: boolean; panelId: string }>(restricted(), { operation: { kind: 'split', panelId: 'main', direction: 'horizontal' } });
    expect(split.ok).toBe(true);
    expect(split.panelId).not.toBe('');
    expect(useCanvasStore.getState().panels[split.panelId].tabs).toEqual([]);
    const result = await execTool(restricted(), { operation: { kind: 'move', tabId: 'first-tab', panelId: split.panelId } });
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(useCanvasStore.getState().panels[split.panelId].tabs.map((tab) => tab.id)).toEqual(['first-tab']);
    expect(useCanvasStore.getState().panels.private.tabs.map((tab) => tab.id)).toEqual(['second-tab']);
  });

  it('refuses moving an owned tab into a mixed-owner panel', async () => {
    const panels = useCanvasStore.getState().panels;
    useCanvasStore.setState({ panels: { ...panels, destination: { ...panels.destination, tabs: [...panels.destination.tabs, { id: 'foreign-copy', type: 'file', entityId: 'second-file', label: 'PRIVATE_SECOND_FILE' }] } } });
    const before = useCanvasStore.getState();
    const result = await execTool(restricted(), { operation: { kind: 'move', tabId: 'first-tab', panelId: 'destination' } });
    expect(result).toMatchObject({ ok: false, code: 'OUTSIDE_WORKSPACE', stateChanged: false });
    expect(useCanvasStore.getState().panels).toEqual(before.panels);
  });

  it('refuses a replaced tab resource after waiting for project ownership', async () => {
    const original = workspaceCatalog.getCatalogEntity;
    let release!: () => void;
    let waiting!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { waiting = resolve; });
    const lookup = vi.spyOn(workspaceCatalog, 'getCatalogEntity').mockImplementation(async (id) => {
      const result = await original(id);
      if (id === 'first-file') { waiting(); await held; }
      return result;
    });
    try {
      const pending = execTool(restricted(), { operation: { kind: 'close', tabId: 'first-tab' } });
      await entered;
      const panels = useCanvasStore.getState().panels;
      useCanvasStore.setState({ panels: { ...panels, main: { ...panels.main, tabs: [{ ...panels.main.tabs[0], entityId: 'second-file', label: 'PRIVATE_REPLACED_FILE' }] } } });
      release();
      expect(await pending).toMatchObject({ ok: false, code: 'STALE_CANVAS', stateChanged: false });
      expect(useCanvasStore.getState().panels.main.tabs[0]).toMatchObject({ id: 'first-tab', entityId: 'second-file' });
    } finally {
      release();
      lookup.mockRestore();
    }
  });

  it('refuses a replaced closed-tab resource after waiting for project ownership', async () => {
    await registerCatalogEntity({ id: 'first-closed-file', type: 'file', name: 'First closed file', locator: 'entity://file/first-closed-file', storageType: 'database', workspaceRoot: first.path });
    useCanvasStore.setState({ recentlyClosed: [{ tab: { id: 'closed-first', type: 'file', entityId: 'first-closed-file', label: 'First closed file' }, panelId: 'main', index: 0 }] });
    const original = workspaceCatalog.getCatalogEntity;
    let release!: () => void;
    let waiting!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { waiting = resolve; });
    const lookup = vi.spyOn(workspaceCatalog, 'getCatalogEntity').mockImplementation(async (id) => {
      const result = await original(id);
      if (id === 'first-closed-file') { waiting(); await held; }
      return result;
    });
    try {
      const pending = execTool(restricted(), { operation: { kind: 'reopen-last-closed' } });
      await entered;
      useCanvasStore.setState({ recentlyClosed: [{ tab: { id: 'closed-foreign', type: 'file', entityId: 'second-file', label: 'PRIVATE_REPLACED_FILE' }, panelId: 'main', index: 0 }] });
      release();
      expect(await pending).toMatchObject({ ok: false, code: 'STALE_CANVAS', stateChanged: false });
      expect(useCanvasStore.getState().recentlyClosed[0].tab.id).toBe('closed-foreign');
      expect(useCanvasStore.getState().focusedPanelId).toBe('private');
    } finally {
      release();
      lookup.mockRestore();
    }
  });
});
