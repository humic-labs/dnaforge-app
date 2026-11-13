import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBEntityReference } from '../../../db/entity-references';
import { useCanvasStore } from '../../canvas/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { initPlatform, platform } from '../../../platform';
import { presentResolvedReference } from './navigate';
import * as documentOpening from '../../document-opening/public/open-document';

describe('saved file reference navigation', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });
    useWorkspaceStore.setState({
      folders: [{ path: '/workspace/Engineering', name: 'Engineering', addedAt: 0 }],
      activeWorkspaceFile: null,
    });
  });

  it('opens a notebook CSV reference through native file inference as a table', async () => {
    await initPlatform();
    const path = '/workspace/Engineering/analyses/tamb-gibson-v2/primers-to-order.csv';
    const stat = vi.spyOn(platform().fs, 'stat').mockResolvedValue({
      canonicalPath: path,
      size: 150,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 1,
      mtimeNs: '1000000',
      ctimeNs: '1000000',
    });
    const open = vi.spyOn(documentOpening, 'openDocument');
    const ref: DBEntityReference = {
      id: 'c48be95c-a982-4265-a76f-6a4a8b344689',
      entity_type: 'file',
      display_label: 'Primer ordering table',
      locator: 'git://Engineering/analyses/tamb-gibson-v2/primers-to-order.csv',
      workspace_root_path: '/workspace/Engineering',
      deep_link_params: null,
      data: null,
      source: 'ai',
      status: 'created',
      created_at: 1,
      updated_at: 1,
    };
    try {
      const result = await presentResolvedReference(ref);
      expect(result).toMatchObject({ tabType: 'table', entityId: path, created: true });
      expect(open).toHaveBeenCalledWith({
        target: { kind: 'file', path },
        label: ref.display_label,
        placement: { kind: 'panel', panelId: 'main' },
      });
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([
        expect.objectContaining({ type: 'table', entityId: path }),
      ]);
    } finally {
      open.mockRestore();
      stat.mockRestore();
    }
  });
});
