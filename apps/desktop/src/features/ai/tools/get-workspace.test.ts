import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { describe, it, expect, beforeEach } from 'vitest';
import { createGetWorkspaceTool, getWorkspaceTool } from './get-workspace';
import { useCanvasStore } from '../../canvas/store';
import { resetCanvasStore, mockUUID, execTool as executeTool } from './test-helpers';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { bindCatalogEntityToFile, registerCatalogEntity, registerWorkspaceFile } from '../../../db/workspace-catalog';
import { clearMockData } from '../../../test/platform-mocks';
import { initializeTestSchema } from '../../../test/initializeTestSchema';

mockUUID();

beforeEach(() => {
  resetCanvasStore();
  useWorkspaceStore.setState({
    folders: [],
    activeWorkspaceFile: null,
    expandedPaths: new Set(),
    selectedPath: null,
    isLoading: false,
    error: null,
  });
});

describe('get_workspace tool', () => {
  it('returns workspace state with no tabs', async () => {
    const result = await execTool<{ focusedPanelId: string | null; panels: any[] }>(
      getWorkspaceTool,
      {}
    );

    expect(result.focusedPanelId).toBe('main');
    expect(result.panels).toHaveLength(1);
    expect(result.panels[0].tabs).toHaveLength(0);
  });

  it('includes open workspace folders', async () => {
    useWorkspaceStore.setState({
      folders: [{ name: 'Lab Data', path: '/home/user/lab', addedAt: 1, pinned: true }],
    });

    const result = await execTool<{
      workspaceId: string;
      workspaceFile: string | null;
      folders: any[];
    }>(getWorkspaceTool, {});

    expect(result.workspaceId).toBe('folders:["/home/user/lab"]');
    expect(result.workspaceFile).toBeNull();
    expect(result.folders).toEqual([{ name: 'Lab Data', path: '/home/user/lab', pinned: true }]);
  });

  it('reports the saved workspace file as the authoritative workspace identity', async () => {
    useWorkspaceStore.setState({
      activeWorkspaceFile: '/home/user/lab/project.waypoint-workspace',
      folders: [{ name: 'Lab Data', path: '/home/user/lab', addedAt: 1 }],
    });

    const result = await execTool<{ workspaceId: string; workspaceFile: string | null }>(
      getWorkspaceTool,
      {}
    );

    expect(result).toMatchObject({
      workspaceId: 'file:/home/user/lab/project.waypoint-workspace',
      workspaceFile: '/home/user/lab/project.waypoint-workspace',
    });
  });

  it('separates authoring projects from pinned source folders', async () => {
    useWorkspaceStore.setState({
      folders: [
        { name: 'Test Fixtures', path: '/fixtures', addedAt: 1, pinned: true },
        { name: 'My Project', path: '/projects/one', addedAt: 2 },
        { name: 'My Project', path: '/projects/two', addedAt: 3 },
      ],
    });
    const result = await execTool<{ projects: unknown[]; referenceFolders: unknown[] }>(getWorkspaceTool, {});
    expect(result.projects).toEqual([
      { name: 'My Project', path: '/projects/one' },
      { name: 'My Project', path: '/projects/two' },
    ]);
    expect(result.referenceFolders).toEqual([{ name: 'Test Fixtures', path: '/fixtures' }]);
  });

  it('includes all open tabs in response', async () => {
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [
            { id: 't1', type: 'sequence', entityId: 'test.gb', label: 'Test' },
            { id: 't2', type: 'page', entityId: 'p1', label: 'Page' },
          ],
          activeTabId: 't1',
        },
      },
      focusedPanelId: 'main',
      layout: { type: 'panel', panelId: 'main' },
    });

    const result = await execTool<{ panels: any[] }>(getWorkspaceTool, {});

    expect(result.panels[0].tabs).toHaveLength(2);
    expect(result.panels[0].tabs[0]).toEqual({
      id: 't1',
      type: 'sequence',
      entityId: 'test.gb',
      label: 'Test',
    });
  });

  it('includes activeTabId for each panel', async () => {
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ id: 't1', type: 'sequence', entityId: 'a.gb', label: 'A' }],
          activeTabId: 't1',
        },
      },
      focusedPanelId: 'main',
      layout: { type: 'panel', panelId: 'main' },
    });

    const result = await execTool<{ panels: any[] }>(getWorkspaceTool, {});

    expect(result.panels[0].activeTabId).toBe('t1');
  });

  it('handles multiple panels', async () => {
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [], activeTabId: null },
        side: { id: 'side', tabs: [], activeTabId: null },
      },
      focusedPanelId: 'main',
      layout: { type: 'panel', panelId: 'main' },
    });

    const result = await execTool<{ panels: any[] }>(getWorkspaceTool, {});

    expect(result.panels).toHaveLength(2);
  });

  it('returns correct focusedPanelId', async () => {
    useCanvasStore.setState({
      panels: {
        main: { id: 'main', tabs: [], activeTabId: null },
        side: { id: 'side', tabs: [], activeTabId: null },
      },
      focusedPanelId: 'side',
      layout: { type: 'panel', panelId: 'main' },
    });

    const result = await execTool<{ focusedPanelId: string | null }>(getWorkspaceTool, {});

    expect(result.focusedPanelId).toBe('side');
  });

  describe('explicit project access', () => {
    const first = { name: 'First project', path: '/projects/first', addedAt: 1 };
    const second = { name: 'Second project', path: '/projects/second', addedAt: 2 };

    beforeEach(async () => {
      clearMockData();
      await initializeTestSchema();
      await registerCatalogEntity({
        id: 'first-notebook',
        type: 'notebook',
        name: 'First notebook',
        locator: 'entity://notebook/first-notebook',
        storageType: 'database',
        workspaceRoot: first.path,
      });
      await registerWorkspaceFile({ path: '/projects/first/shared.py', workspaceRoot: first.path });
      const sequence = await registerCatalogEntity({
        id: 'first-sequence-catalog',
        type: 'sequence',
        name: 'Native sequence',
        locator: 'entity://sequence/first-sequence-catalog',
        storageType: 'file',
        workspaceRoot: first.path,
      });
      await bindCatalogEntityToFile({
        entityId: sequence.id,
        path: '/projects/first/native-sequence.gb',
        workspaceRoot: first.path,
        objectUuid: 'native-sequence-document',
      });
      await registerCatalogEntity({
        id: '/projects/first/looks-allowed.py',
        type: 'file',
        name: 'Second project file',
        locator: 'entity://file/second-file',
        storageType: 'database',
        workspaceRoot: second.path,
      });
      useCanvasStore.setState({
        panels: {
          main: {
            id: 'main',
            tabs: [
              { id: 'first-notebook-tab', type: 'page', entityId: 'first-notebook', label: 'First notebook' },
              { id: 'first-file-tab', type: 'text', entityId: '/projects/first/shared.py', label: 'Shared file' },
              { id: 'first-sequence-tab', type: 'sequence', entityId: 'native-sequence-document', label: 'Native sequence', sequenceDocument: { kind: 'indexed-sequence', documentId: 'native-sequence-document' } },
              { id: 'second-file-tab', type: 'text', entityId: '/projects/first/looks-allowed.py', label: 'PRIVATE_SECOND_FILE' },
              { id: 'unknown-tab', type: 'chat', entityId: 'unknown-conversation', label: 'PRIVATE_UNKNOWN_CHAT' },
            ],
            activeTabId: 'second-file-tab',
          },
          second: {
            id: 'second',
            tabs: [
              { id: 'second-only-tab', type: 'file', entityId: '/projects/first/looks-allowed.py', label: 'PRIVATE_SECOND_FILE' },
            ],
            activeTabId: 'second-only-tab',
          },
        },
        focusedPanelId: 'second',
        layout: { type: 'panel', panelId: 'main' },
      });
    });

    it.each([true, false])('returns only catalog-owned tabs when the granted project is displayed: %s', async (displayFirst) => {
      useWorkspaceStore.setState({ folders: displayFirst ? [first, second] : [second] });
      const result = await execTool<{
        projects: Array<{ path: string }>;
        folders: Array<{ path: string }>;
        panels: Array<{ id: string; tabs: Array<{ id: string }>; activeTabId: string | null }>;
        focusedPanelId: string | null;
      }>(createGetWorkspaceTool(['read-workspace'], [first, second], { kind: 'project-roots', roots: [first.path] }), {});

      expect(result.projects.map((project) => project.path)).toEqual([first.path]);
      expect(result.folders.map((folder) => folder.path)).toEqual(displayFirst ? [first.path] : []);
      expect(result.panels).toEqual([
        {
          id: 'main',
          tabs: [
            { id: 'first-notebook-tab', type: 'page', entityId: 'first-notebook', label: 'First notebook' },
            { id: 'first-file-tab', type: 'text', entityId: '/projects/first/shared.py', label: 'Shared file' },
            { id: 'first-sequence-tab', type: 'sequence', entityId: 'native-sequence-document', label: 'Native sequence' },
          ],
          activeTabId: null,
        },
      ]);
      expect(result.focusedPanelId).toBeNull();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    });

    it('does not expose canvas metadata to an empty explicit project scope', async () => {
      useWorkspaceStore.setState({ folders: [first, second] });
      const result = await execTool<{ panels: unknown[]; focusedPanelId: string | null }>(
        createGetWorkspaceTool(['read-workspace'], [], { kind: 'project-roots', roots: [] }),
        {}
      );

      expect(result.panels).toEqual([]);
      expect(result.focusedPanelId).toBeNull();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    });
  });
});

import { getWorkspaceOutputSchema } from './get-workspace';

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
    assertMcpOutput(getWorkspaceOutputSchema, result);
  }
  return result;
}
