import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  RendererFeature,
  RendererFeatureContext,
} from '../../../feature-registry/renderer-feature';
import { OPEN_REMOTE_HOSTS_EVENT } from '../../../shared/remote-hosts';
import { isRemoteSshTarget } from '../../../shared/remote-ssh-target';
import { RemoteHostsPanel } from '../RemoteHostsPanel';

const useRemoteHostDraft = create<{ target: string }>(() => ({ target: '' }));

function RemoteHostsActivation({ openView }: RendererFeatureContext) {
  useEffect(() => {
    const openRemoteHosts = (event: Event) => {
      const target: unknown = (event as CustomEvent<{ target?: unknown }>).detail?.target;
      useRemoteHostDraft.setState({
        target: typeof target === 'string' && isRemoteSshTarget(target) ? target : '',
      });
      openView('remote-hosts');
    };
    window.addEventListener(OPEN_REMOTE_HOSTS_EVENT, openRemoteHosts);
    return () => window.removeEventListener(OPEN_REMOTE_HOSTS_EVENT, openRemoteHosts);
  }, [openView]);
  return null;
}

function RemoteHostsView() {
  const target = useRemoteHostDraft((state) => state.target);
  return <RemoteHostsPanel initialTarget={target} />;
}

export const remoteHostsRendererFeature: RendererFeature = {
  id: 'remote-hosts',
  views: [
    {
      view: 'remote-hosts',
      Component: RemoteHostsView,
      screenCategory: 'settings',
      activityButton: {
        label: 'Remote hosts',
        testId: 'remote-hosts-button',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m7 9 3 3-3 3m6 0h4" />
          </svg>
        ),
      },
    },
  ],
  Activation: RemoteHostsActivation,
};
