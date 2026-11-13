import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebar } from '../../hooks/useSidebar';
import { readSidebarState } from '../../shared/ui-persistence';
import { WorkspaceSidebar } from './WorkspaceSidebar';

function renderSidebar(props: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}) {
  const onWidthCommit = vi.fn();
  const defaults = {
    visible: true,
    width: 260,
    filesPanelActive: true,
    files: <div data-testid="files-content">Files</div>,
    tools: null,
    onWidthCommit,
  };
  const view = render(<WorkspaceSidebar {...defaults} {...props} />);
  return {
    ...view,
    onWidthCommit,
    rerenderSidebar(next: Partial<ComponentProps<typeof WorkspaceSidebar>>) {
      view.rerender(<WorkspaceSidebar {...defaults} {...props} {...next} />);
    },
  };
}

function sidebar() {
  return screen.getByTestId('files-sidebar');
}

function width() {
  return Number.parseFloat(sidebar().style.width);
}

function beginResize(clientX = 260) {
  const handle = sidebar().nextElementSibling;
  expect(handle, 'the sidebar owns its immediate sibling resize handle').not.toBeNull();
  expect(handle).toHaveClass('cursor-col-resize');
  expect(handle).toHaveStyle({ marginLeft: '-2px' });
  fireEvent.mouseDown(handle!, { clientX });
}

function moveResize(clientX: number) {
  fireEvent.mouseMove(document, { clientX });
}

function releaseResize() {
  fireEvent.mouseUp(document);
}

describe('WorkspaceSidebar local resize ownership', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('changes the live width before release without reconciling the parent or files', () => {
    let parentRenders = 0;
    let fileRenders = 0;
    const onWidthCommit = vi.fn();
    function Files() {
      fileRenders += 1;
      return <div>Files</div>;
    }
    function Parent() {
      parentRenders += 1;
      return (
        <WorkspaceSidebar
          visible
          width={260}
          filesPanelActive
          tools={null}
          files={<Files />}
          onWidthCommit={onWidthCommit}
        />
      );
    }
    render(<Parent />);
    const before = { parentRenders, fileRenders };
    beginResize();
    moveResize(310);
    expect(width()).toBe(310);
    moveResize(360);
    expect(width()).toBe(360);
    expect({ parentRenders, fileRenders }).toEqual(before);
    expect(onWidthCommit).not.toHaveBeenCalled();
    releaseResize();
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(360);
  });

  it('clamps sidebar width during resize', () => {
    const { onWidthCommit } = renderSidebar();
    beginResize();
    moveResize(0);
    expect(width()).toBe(180);
    moveResize(1000);
    expect(width()).toBe(500);
    expect(onWidthCommit).not.toHaveBeenCalled();
    releaseResize();
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(500);
  });

  it('stops resizing on mouseup and commits the latest width once', () => {
    const { onWidthCommit } = renderSidebar();
    beginResize(100);
    moveResize(180);
    expect(width()).toBe(340);
    releaseResize();
    moveResize(1000);
    releaseResize();
    expect(width()).toBe(340);
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(340);
  });

  it('commits the latest width once on blur and ignores later moves or release', () => {
    const { onWidthCommit } = renderSidebar();
    beginResize(100);
    moveResize(180);
    fireEvent.blur(window);
    moveResize(1000);
    releaseResize();
    fireEvent.blur(window);
    expect(width()).toBe(340);
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(340);
  });

  it('keeps the current live width when unrelated parent props rerender', () => {
    const { rerenderSidebar, onWidthCommit } = renderSidebar();
    beginResize();
    moveResize(360);
    rerenderSidebar({ tools: <div>Updated tools</div> });
    expect(width()).toBe(360);
    moveResize(380);
    releaseResize();
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(380);
  });

  it('aborts an old drag when an external width arrives and adopts the new width', () => {
    const { rerenderSidebar, onWidthCommit } = renderSidebar();
    beginResize();
    moveResize(360);
    expect(width()).toBe(360);
    rerenderSidebar({ width: 420 });
    expect(width()).toBe(420);
    moveResize(1000);
    releaseResize();
    fireEvent.blur(window);
    expect(width()).toBe(420);
    expect(onWidthCommit).not.toHaveBeenCalled();
  });

  it('commits the latest live width once when hidden and adopts that width on reopening', () => {
    const { rerenderSidebar, onWidthCommit } = renderSidebar();
    beginResize();
    moveResize(360);
    rerenderSidebar({ visible: false });
    expect(sidebar()).toHaveAttribute('aria-hidden', 'true');
    expect(sidebar().nextElementSibling).toBeNull();
    moveResize(1000);
    releaseResize();
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(360);
    rerenderSidebar({ visible: true, width: 360 });
    expect(width()).toBe(360);
    beginResize(360);
    moveResize(400);
    releaseResize();
    expect(onWidthCommit).toHaveBeenCalledTimes(2);
    expect(onWidthCommit).toHaveBeenLastCalledWith(400);
  });

  it('does not create a second resize owner when another drag starts', () => {
    const { onWidthCommit } = renderSidebar();
    beginResize(100);
    moveResize(140);
    expect(width()).toBe(300);
    beginResize(140);
    moveResize(180);
    expect(width()).toBe(340);
    releaseResize();
    expect(onWidthCommit).toHaveBeenCalledExactlyOnceWith(340);
  });

  it('removes its active listeners on unmount without committing an abandoned drag', () => {
    const view = renderSidebar();
    const documentAdded = vi.spyOn(document, 'addEventListener');
    const documentRemoved = vi.spyOn(document, 'removeEventListener');
    const windowAdded = vi.spyOn(window, 'addEventListener');
    const windowRemoved = vi.spyOn(window, 'removeEventListener');
    try {
      beginResize();
      moveResize(360);
      const documentListeners = documentAdded.mock.calls.filter(
        ([name]) => name === 'mousemove' || name === 'mouseup'
      );
      const blurListeners = windowAdded.mock.calls.filter(([name]) => name === 'blur');
      expect(documentListeners.map(([name]) => name).sort()).toEqual(['mousemove', 'mouseup']);
      expect(blurListeners).toHaveLength(1);
      view.unmount();
      for (const [name, listener] of documentListeners) {
        expect(
          documentRemoved.mock.calls.some((call) => call[0] === name && call[1] === listener)
        ).toBe(true);
      }
      for (const [name, listener] of blurListeners) {
        expect(
          windowRemoved.mock.calls.some((call) => call[0] === name && call[1] === listener)
        ).toBe(true);
      }
      moveResize(1000);
      releaseResize();
      fireEvent.blur(window);
      expect(view.onWidthCommit).not.toHaveBeenCalled();
    } finally {
      documentAdded.mockRestore();
      documentRemoved.mockRestore();
      windowAdded.mockRestore();
      windowRemoved.mockRestore();
    }
  });

  it('persists the width the user RELEASED at, not the pre-drag width', () => {
    function Parent() {
      const state = useSidebar({ toolboxBadge: null });
      return (
        <>
          <output data-testid="committed-width">{state.sidebarWidth}</output>
          <WorkspaceSidebar
            visible={state.sidebarVisible}
            width={state.sidebarWidth}
            filesPanelActive
            tools={null}
            files={<div>Files</div>}
            onWidthCommit={state.commitSidebarWidth}
          />
        </>
      );
    }
    render(<Parent />);
    beginResize(100);
    moveResize(180);
    expect(width()).toBe(340);
    expect(screen.getByTestId('committed-width')).toHaveTextContent('260');
    expect(readSidebarState().sidebarWidth).toBe(260);
    releaseResize();
    expect(screen.getByTestId('committed-width')).toHaveTextContent('340');
    expect(readSidebarState().sidebarWidth).toBe(340);
  });

  it('preserves the released width through Settings and Files', () => {
    function Parent() {
      const state = useSidebar({ toolboxBadge: null });
      return (
        <>
          <button onClick={() => state.handleViewChange('settings')}>Settings view</button>
          <button onClick={() => state.handleViewChange('files')}>Files view</button>
          <WorkspaceSidebar
            visible={state.sidebarVisible}
            width={state.sidebarWidth}
            filesPanelActive
            tools={null}
            files={<div>Files</div>}
            onWidthCommit={state.commitSidebarWidth}
          />
        </>
      );
    }
    render(<Parent />);
    beginResize(100);
    moveResize(180);
    releaseResize();
    expect(width()).toBe(340);
    expect(readSidebarState().sidebarWidth).toBe(340);
    fireEvent.click(screen.getByRole('button', { name: 'Settings view' }));
    expect(width()).toBe(340);
    expect(sidebar()).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Files view' }));
    expect(width()).toBe(340);
    expect(readSidebarState().sidebarWidth).toBe(340);
  });

  it('persists the latest drag width when Home hides the sidebar and restores it in Files', () => {
    function Parent() {
      const state = useSidebar({ toolboxBadge: null });
      return (
        <>
          <button onClick={() => state.handleViewChange('home')}>Home</button>
          <button onClick={() => state.handleViewChange('files')}>Files view</button>
          <WorkspaceSidebar
            visible={state.sidebarVisible}
            width={state.sidebarWidth}
            filesPanelActive
            tools={null}
            files={<div>Files</div>}
            onWidthCommit={state.commitSidebarWidth}
          />
        </>
      );
    }
    render(<Parent />);
    beginResize(100);
    moveResize(180);
    expect(width()).toBe(340);
    expect(readSidebarState().sidebarWidth).toBe(260);
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(sidebar()).toHaveAttribute('aria-hidden', 'true');
    expect(readSidebarState().sidebarWidth).toBe(340);
    moveResize(1000);
    releaseResize();
    fireEvent.click(screen.getByRole('button', { name: 'Files view' }));
    expect(width()).toBe(340);
    expect(readSidebarState().sidebarWidth).toBe(340);
  });
});
