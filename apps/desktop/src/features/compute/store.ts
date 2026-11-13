import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { create } from 'zustand';

import { platform } from '../../platform';
import type {
  ComputeConnectResult,
  ComputeDisconnectResult,
  ComputeManifestInstallResult,
  ComputeManifestRemoveResult,
  ComputeProviderSummary,
} from '../../shared/compute-ipc';

type ProviderLoadState =
  | { phase: 'idle' }
  | { phase: 'loading'; request: object }
  | { phase: 'ready' }
  | { phase: 'error'; message: UserMessage };

export interface ComputeStoreState {
  providerLoadState: ProviderLoadState;
  providers: ComputeProviderSummary[];
  loading: boolean;
  loadError: UserMessage | null;
  pendingConnectProviderId: string | null;
  connectDialog: { open: boolean; providerId: string | null };

  refresh(): Promise<void>;
  requestConnect(providerId: string | null): void;
  openConnectDialog(providerId: string | null): void;
  closeConnectDialog(): void;
  connect(providerId: string, secret: string): Promise<ComputeConnectResult>;
  test(providerId: string): Promise<ComputeConnectResult>;
  disconnect(providerId: string): Promise<ComputeDisconnectResult>;
  installManifest(manifestJson: string): Promise<ComputeManifestInstallResult>;
  removeCustomProvider(providerId: string): Promise<ComputeManifestRemoveResult>;
}

export const useComputeStore = create<ComputeStoreState>((set, get) => ({
  providerLoadState: { phase: 'idle' },
  providers: [],
  loading: false,
  loadError: null,
  pendingConnectProviderId: null,
  connectDialog: { open: false, providerId: null },

  async refresh() {
    const request = {};
    const ownsRequest = () => {
      const state = get().providerLoadState;
      return state.phase === 'loading' && state.request === request;
    };
    set({ providerLoadState: { phase: 'loading', request }, loading: true, loadError: null });
    try {
      const providers = await platform().compute.listProviders();
      if (!ownsRequest()) return;
      set({ providerLoadState: { phase: 'ready' }, providers, loading: false, loadError: null });
    } catch (error) {
      if (!ownsRequest()) return;
      const message = toUserMessage(error, 'service.unavailable');
      set({ providerLoadState: { phase: 'error', message }, loading: false, loadError: message });
    }
  },

  requestConnect(providerId) {
    set({ pendingConnectProviderId: providerId ?? '*' });
  },

  openConnectDialog(providerId) {
    set({ connectDialog: { open: true, providerId } });
    if (get().providers.length === 0) void get().refresh();
  },

  closeConnectDialog() {
    set({ connectDialog: { open: false, providerId: null } });
  },

  async connect(providerId, secret) {
    const result = await platform().compute.connect(providerId, secret);
    if (result.ok) {
      set({ pendingConnectProviderId: null });
      await get().refresh();
    }
    return result;
  },

  async test(providerId) {
    const result = await platform().compute.test(providerId);
    await get().refresh();
    return result;
  },

  async disconnect(providerId) {
    const result = await platform().compute.disconnect(providerId);
    await get().refresh();
    return result;
  },

  async installManifest(manifestJson) {
    const result = await platform().compute.installManifest(manifestJson);
    if (result.ok) {
      await get().refresh();
      set({ connectDialog: { open: true, providerId: result.providerId } });
    }
    return result;
  },

  async removeCustomProvider(providerId) {
    const result = await platform().compute.removeCustomProvider(providerId);
    if (result.ok) await get().refresh();
    return result;
  },
}));

export function selectProvider(
  state: ComputeStoreState,
  providerId: string | null
): ComputeProviderSummary | undefined {
  return providerId ? state.providers.find((p) => p.id === providerId) : undefined;
}
