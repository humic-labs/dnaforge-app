import type { DesktopAuthState, DesktopPublicSession } from '../auth-types';
import { defineGroup, invoke, event } from './contract';

export const authContract = defineGroup('auth', {
  startSignIn: invoke<[], { ok: boolean; reason?: string }>(),
  cancelSignIn: invoke<[], void>(),
  reopenSignIn: invoke<[], void>(),
  chooseOAuth: invoke<[provider: string], void>(),
  chooseSso: invoke<[email: string], void>(),
  startEmailSignIn: invoke<[email: string], void>(),
  submitEmailCode: invoke<[code: string], void>(),
  signOut: invoke<[accountId?: string], void>(),
  getActiveSession: invoke<[], DesktopPublicSession | null>(),
  getState: invoke<[], DesktopAuthState>(),
  updateProfile: invoke<
    [
      input: {
        displayName?: string | null;
        avatarBase64?: string;
        avatarContentType?: string;
        clearAvatar?: boolean;
      },
    ],
    { ok: boolean; message?: string }
  >(),
  onAuthStateChanged: event<[state: DesktopAuthState]>().channel('auth:state-changed'),
});
