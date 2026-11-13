// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceSessionCanvasBindings,
  type WorkspaceSessionCanvasState,
} from './canvas-session-bindings';

describe('workspace session canvas bindings', () => {
  it('projects canvas focus, close, and non-workspace focus into the shared session', () => {
    let session = {
      activeWorkspaceId: 'workspace-one' as string | null,
      activeFilePath: null as string | null,
      openFiles: [{ file: { path: 'first.gbk' } }, { file: { path: 'second.gbk' } }],
    };
    const activateFile = vi.fn((path: string) => {
      session = { ...session, activeFilePath: path };
    });
    const deactivateFile = vi.fn(() => {
      session = { ...session, activeFilePath: null };
    });
    const closeFile = vi.fn((path: string) => {
      session = {
        ...session,
        activeFilePath: session.activeFilePath === path ? null : session.activeFilePath,
        openFiles: session.openFiles.filter((opened) => opened.file.path !== path),
      };
    });
    const bindings = createWorkspaceSessionCanvasBindings({
      getState: () => session,
      activateFile,
      deactivateFile,
      closeFile,
    });

    let canvas: WorkspaceSessionCanvasState = {
      focusedPanelId: 'panel-one',
      panels: {
        'panel-one': {
          activeTabId: 'tab-one',
          tabs: [{ id: 'tab-one' }, { id: 'tab-two' }],
        },
      },
    };
    let notify = (): void => undefined;
    bindings.configure({
      getState: () => canvas,
      subscribe: (listener) => {
        notify = listener;
        return () => {
          notify = (): void => undefined;
        };
      },
    });

    bindings.bind('tab-one', 'first.gbk');
    bindings.bind('tab-two', 'second.gbk');
    expect(session.activeFilePath).toBe('first.gbk');

    canvas = {
      ...canvas,
      panels: {
        'panel-one': {
          activeTabId: 'tab-two',
          tabs: [{ id: 'tab-one' }, { id: 'tab-two' }],
        },
      },
    };
    notify();
    expect(session.activeFilePath).toBe('second.gbk');

    canvas = {
      ...canvas,
      panels: {
        'panel-one': {
          activeTabId: 'tab-one',
          tabs: [{ id: 'tab-one' }],
        },
      },
    };
    notify();
    expect(closeFile).toHaveBeenCalledWith('second.gbk');
    expect(session.openFiles.map((opened) => opened.file.path)).toEqual(['first.gbk']);
    expect(session.activeFilePath).toBe('first.gbk');

    canvas = { ...canvas, focusedPanelId: null };
    notify();
    expect(deactivateFile).toHaveBeenCalledOnce();
    expect(session.activeFilePath).toBeNull();
    expect(closeFile).not.toHaveBeenCalledWith('first.gbk');
  });
});
