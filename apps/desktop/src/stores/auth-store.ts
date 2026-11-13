import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { create } from 'zustand';
import { publishDesktopAuthSnapshot } from '../features/auth/public/auth-state';
import type { DesktopAuthState, DesktopPublicSession } from '../shared/auth-types';
import { useToastStore } from './toast-store';
import { useHostedContributionStore } from './hosted-contribution-store';

interface AuthBridge {
  startSignIn(): Promise<{ ok: boolean; reason?: string }>;
  cancelSignIn(): Promise<void>;
  reopenSignIn(): Promise<void>;
  chooseOAuth(provider: string): Promise<void>;
  chooseSso(email: string): Promise<void>;
  startEmailSignIn(email: string): Promise<void>;
  submitEmailCode(code: string): Promise<void>;
  signOut(accountId?: string): Promise<void>;
  getActiveSession(): Promise<DesktopPublicSession | null>;
  getState?(): Promise<DesktopAuthState>;
  updateProfile?(input: {
    displayName?: string | null;
    avatarBase64?: string;
    avatarContentType?: string;
    clearAvatar?: boolean;
  }): Promise<{ ok: boolean; message?: string }>;
  onAuthStateChanged(cb: (state: DesktopAuthState) => void): () => void;
}

function authBridge(): AuthBridge | undefined {
  return (window as Window & { electronAPI?: { auth?: AuthBridge } }).electronAPI?.auth;
}

export function hasDesktopAuthBridge(): boolean {
  return Boolean(authBridge());
}

interface AuthStore {
  state: DesktopAuthState;
  initialized: boolean;
  hydrated: boolean;
  init: () => void;
  startSignIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  reopenSignIn: () => Promise<void>;
  chooseOAuth: (provider: string) => Promise<void>;
  chooseSso: (email: string) => Promise<void>;
  startEmailSignIn: (email: string) => Promise<void>;
  submitEmailCode: (code: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (input: {
    displayName?: string | null;
    avatarBase64?: string;
    avatarContentType?: string;
    clearAvatar?: boolean;
  }) => Promise<{ ok: boolean; message?: string }>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  state: { status: 'signed-out' },
  initialized: false,
  hydrated: false,

  init: () => {
    if (get().initialized) return;
    const auth = authBridge();
    if (!auth) return;

    set({ initialized: true });

    auth.onAuthStateChanged((state) => {
      set({ state, hydrated: isHydrationTerminalState(state) ? true : get().hydrated });
      if (state.status === 'error') {
        useToastStore
          .getState()
          .addToast(toUserMessage(state, 'operation.failed'), { definition: 'sign-in-error' });
      } else if (state.status === 'unavailable') {
        useToastStore
          .getState()
          .addToast(
            userMessage(
              'notice.encrypted-storage-is-unavailable-on-this-system-sign-in-is-not-support'
            ),
            { definition: 'sign-in-encryption-unavailable' }
          );
      } else if (state.status === 'signed-in' && state.justSignedIn) {
        const who = state.session.email ?? state.session.displayName ?? 'your account';
        useToastStore
          .getState()
          .addToast(
            userMessageWithValues('notice.signed-in-as-value', { value0: userMessageValue(who) }),
            { definition: 'auth-store-signed-in-as-example' }
          );
      }
    });

    const hydrate = async () => {
      if (typeof auth.getState === 'function') {
        try {
          set({ state: await auth.getState(), hydrated: true });
          return;
        } catch {}
      }
      try {
        const session = await auth.getActiveSession();
        set({
          state: session ? { status: 'signed-in', session } : { status: 'signed-out' },
          hydrated: true,
        });
      } catch {
        set({ state: { status: 'signed-out' }, hydrated: true });
      }
    };
    void hydrate();
  },

  startSignIn: async () => {
    const auth = authBridge();
    if (!auth) {
      useToastStore
        .getState()
        .addToast(userMessage('notice.sign-in-is-unavailable-in-this-environment'), {
          definition: 'auth-store-sign-in-is-unavailable-in-this-environment',
        });
      return;
    }
    await auth.startSignIn();
    if (typeof auth.getState === 'function') {
      try {
        set({ state: await auth.getState() });
      } catch {}
    }
  },
  cancelSignIn: async () => {
    await authBridge()?.cancelSignIn();
  },
  reopenSignIn: async () => {
    await authBridge()?.reopenSignIn();
  },
  chooseOAuth: async (provider: string) => {
    await authBridge()?.chooseOAuth(provider);
  },
  chooseSso: async (email: string) => {
    await authBridge()?.chooseSso?.(email);
  },
  startEmailSignIn: async (email: string) => {
    await authBridge()?.startEmailSignIn(email);
  },
  submitEmailCode: async (code: string) => {
    await authBridge()?.submitEmailCode(code);
  },
  signOut: async () => {
    await authBridge()?.signOut();
  },
  updateProfile: async (input) => {
    const auth = authBridge();
    if (!auth?.updateProfile) return { ok: false, message: 'Profile update unavailable.' };
    return auth.updateProfile(input);
  },
}));

function isHydrationTerminalState(state: DesktopAuthState): boolean {
  return (
    state.status === 'signed-out' ||
    state.status === 'signed-in' ||
    state.status === 'error' ||
    state.status === 'unavailable'
  );
}

useAuthStore.subscribe(({ state, hydrated }) => {
  if (!hydrated) return;
  useHostedContributionStore
    .getState()
    .setSession(state.status === 'signed-in' ? state.session : null);
});

publishDesktopAuthSnapshot(useAuthStore.getState());
useAuthStore.subscribe(publishDesktopAuthSnapshot);
