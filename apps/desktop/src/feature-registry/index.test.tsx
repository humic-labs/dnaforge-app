import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OPEN_REMOTE_HOSTS_EVENT } from '../shared/remote-hosts';

vi.mock('../features/remote-hosts/RemoteHostsPanel', () => ({
  RemoteHostsPanel: ({ initialTarget }: { initialTarget: string }) => (
    <div data-testid="remote-hosts-panel">{initialTarget || '(empty)'}</div>
  ),
}));

vi.mock('../features/release-notes/public/feature', () => ({
  releaseNotesRendererFeature: { id: 'release-notes', Activation: () => null },
  openReleaseNotes: vi.fn(),
}));

vi.mock('../features/page/public/feature', () => ({
  pageReferencesRendererFeature: { id: 'page-references', Activation: () => null },
}));

vi.mock('../components/OriginalProjectRecoveryDialog', () => ({
  OriginalProjectRecoveryDialog: () => <div data-testid="original-project-recovery-dialog" />,
}));

import {
  assertUniqueRendererFeatures,
  isRendererFeatureView,
  RENDERER_FEATURES,
  RendererFeatureActivations,
  rendererFeatureActivityButtons,
  rendererFeatureScreenCategory,
  rendererFeatureView,
  rendererFeatureViewIds,
  isRendererFeatureSidebarView,
  rendererFeatureSidebarView,
} from '.';

describe('renderer feature registry', () => {
  it('owns the original project recovery activation exactly once', () => {
    render(<RendererFeatureActivations openView={vi.fn()} />);
    expect(screen.getAllByTestId('original-project-recovery-dialog')).toHaveLength(1);
  });

  it('lists remote hosts as the owner of the remote-hosts view, and nothing else', () => {
    expect(RENDERER_FEATURES.map((feature) => feature.id)).toContain('remote-hosts');
    expect(RENDERER_FEATURES.map((feature) => feature.id)).toContain('release-notes');
    expect(RENDERER_FEATURES.map((feature) => feature.id)).toContain('page-references');
    expect(RENDERER_FEATURES.map((feature) => feature.id)).toContain('journey-telemetry');
    expect(isRendererFeatureView('remote-hosts')).toBe(true);
    expect(isRendererFeatureView('files')).toBe(false);
    expect(rendererFeatureView('files')).toBeNull();
  });

  it('opens the remote hosts view with the requested SSH target when asked to sign in', () => {
    const openView = vi.fn();
    render(<RendererFeatureActivations openView={openView} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_REMOTE_HOSTS_EVENT, { detail: { target: 'me@cluster.example' } })
      );
    });
    expect(openView).toHaveBeenCalledWith('remote-hosts');
    render(<>{rendererFeatureView('remote-hosts')}</>);
    expect(screen.getByTestId('remote-hosts-panel').textContent).toBe('me@cluster.example');
  });

  it('opens the view with an empty draft when the request names no valid SSH target', () => {
    const openView = vi.fn();
    render(<RendererFeatureActivations openView={openView} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(OPEN_REMOTE_HOSTS_EVENT, { detail: { target: 'not a target;' } })
      );
    });
    expect(openView).toHaveBeenCalledWith('remote-hosts');
    render(<>{rendererFeatureView('remote-hosts')}</>);
    expect(screen.getByTestId('remote-hosts-panel').textContent).toBe('(empty)');
  });

  it('stops listening when the shell unmounts', () => {
    const openView = vi.fn();
    const { unmount } = render(<RendererFeatureActivations openView={openView} />);
    unmount();
    window.dispatchEvent(new CustomEvent(OPEN_REMOTE_HOSTS_EVENT, { detail: {} }));
    expect(openView).not.toHaveBeenCalled();
  });

  it('lists the remote hosts view, its activity button and its screen category', () => {
    expect(rendererFeatureViewIds()).toEqual(['remote-hosts']);
    expect(rendererFeatureScreenCategory('remote-hosts')).toBe('settings');
    expect(rendererFeatureActivityButtons()).toEqual([
      expect.objectContaining({
        view: 'remote-hosts',
        label: 'Remote hosts',
        testId: 'remote-hosts-button',
      }),
      expect.objectContaining({
        view: 'ai',
        label: 'AI Tools',
        testId: 'ai-tools-button',
        command: 'app.focusCommandInput',
      }),
    ]);
  });

  it('registers AI as a sidebar without taking over the canvas', () => {
    expect(isRendererFeatureSidebarView('ai')).toBe(true);
    expect(isRendererFeatureView('ai')).toBe(false);
    expect(rendererFeatureView('ai')).toBeNull();
    expect(rendererFeatureViewIds(undefined, 'sidebar')).toEqual(['ai']);
    expect(rendererFeatureSidebarView('ai')).not.toBeNull();
    expect(rendererFeatureSidebarView('remote-hosts')).toBeNull();
  });

  it('rejects a repeated feature id or two features claiming one view', () => {
    const View = () => null;
    const view = {
      view: 'remote-hosts' as const,
      Component: View,
      screenCategory: 'settings' as const,
    };
    expect(() => assertUniqueRendererFeatures([{ id: 'a' }, { id: 'a' }])).toThrow(
      'Renderer feature "a" is registered twice.'
    );
    expect(() =>
      assertUniqueRendererFeatures([
        { id: 'a', views: [view] },
        { id: 'b', views: [view] },
      ])
    ).toThrow('Renderer features "a" and "b" both claim the "remote-hosts" view.');
    expect(() => assertUniqueRendererFeatures(RENDERER_FEATURES)).not.toThrow();
  });
});
