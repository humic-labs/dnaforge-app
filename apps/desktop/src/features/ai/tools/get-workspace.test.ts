import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';
import { describe, it, expect, beforeEach } from 'vitest';
import { getWorkspaceTool } from './get-workspace';
import { useCanvasStore } from '../../canvas/store';
import { resetCanvasStore, mockUUID, execTool as executeTool } from './test-helpers';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolResultDisplay } from '../../../components/chat/ToolResultDisplay';

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
  it('preserves RNA and protein identities from open tabs through expanded tool results', async () => {
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          activeTabId: 'rna-tab',
          tabs: [
            {
              id: 'rna-tab',
              type: 'primer',
              entityId: 'rna-oligo',
              label: 'RNA primer',
              artifactDocument: {
                kind: 'primer',
                persistence: 'persisted',
                workspaceRoot: '/lab',
                destinationPath: '/lab/primer.primer.json',
                orderType: 'rna',
              },
            },
            {
              id: 'protein-tab',
              type: 'record',
              entityKind: 'protein',
              entityId: 'native-protein',
              label: 'Native protein',
            },
          ],
        },
      },
    });
    const output = await execTool<{ panels: Array<{ tabs: unknown[] }> }>(getWorkspaceTool, {});
    render(createElement(ToolResultDisplay, {
      toolName: 'get_workspace',
      content: JSON.stringify({ input: {}, output }),
    }));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('RNA primer').parentElement?.querySelector('svg')).toHaveAttribute(
      'data-entity-color-family', 'rna'
    );
    expect(screen.getByText('Native protein').parentElement?.querySelector('svg')).toHaveAttribute(
      'data-entity-color-family', 'protein'
    );
  });

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
});

import { getWorkspaceOutputSchema } from './get-workspace';

async function execTool<T>(...args: Parameters<typeof executeTool>): Promise<T> {
  const result = await executeTool<T>(...args);
  if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
    assertMcpOutput(getWorkspaceOutputSchema, result);
  }
  return result;
}
