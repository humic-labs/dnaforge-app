import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageReferencesRendererFeature } from './feature';

const state = vi.hoisted(() => ({
  folders: [{ path: '/fixture/project' }],
  install: vi.fn(),
}));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: (select: (value: { folders: typeof state.folders }) => unknown) =>
    select({ folders: state.folders }),
}));
vi.mock('../entity-ref/install-entity-reference-handler', () => ({
  installEntityReferenceHandler: state.install,
}));
const { Activation } = pageReferencesRendererFeature;

beforeEach(() => {
  state.folders = [{ path: '/fixture/project' }];
  state.install.mockReset();
  state.install.mockReturnValue(vi.fn());
});

describe('registered page reference lifecycle', () => {
  it('installs against the actual mounted roots and shell navigation', () => {
    const openView = vi.fn();
    render(<Activation openView={openView} />);
    expect(state.install).toHaveBeenCalledOnce();
    expect(state.install).toHaveBeenCalledWith({
      folders: state.folders,
      handleViewChange: openView,
    });
  });

  it('releases the old handler when mounted roots change', () => {
    const cleanup = vi.fn();
    state.install.mockReturnValueOnce(cleanup);
    const openView = vi.fn();
    const view = render(<Activation openView={openView} />);
    state.folders = [{ path: '/fixture/other-project' }];
    view.rerender(<Activation openView={openView} />);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(state.install).toHaveBeenLastCalledWith({
      folders: state.folders,
      handleViewChange: openView,
    });
  });

  it('releases native reference custody when the shell unmounts', () => {
    const cleanup = vi.fn();
    state.install.mockReturnValueOnce(cleanup);
    const view = render(<Activation openView={vi.fn()} />);
    view.unmount();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
