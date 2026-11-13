import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';

import { type BrowserWindow } from 'electron';
import {
  startSignIn,
  cancelSignIn,
  reopenSignIn,
  chooseOAuth,
  chooseSso,
  startEmailSignIn,
  submitEmailCode,
  signOut,
  getActiveSession,
  getAuthState,
  subscribeAuthState,
  setMainWindowFocuser,
  updateProfile,
} from '../auth/controller';
import { authContract } from '../../shared/ipc/auth.contract';
import { focusWindowUnlessBackground } from '../background-window-mode';

let unsubscribe: (() => void) | null = null;

export function registerAuthHandlers(getWindow: () => BrowserWindow | null): void {
  handleGroup(authContract, {
    startSignIn: () => startSignIn(),
    cancelSignIn: () => cancelSignIn(),
    reopenSignIn: () => reopenSignIn(),
    chooseOAuth: (_event, provider?: unknown) =>
      chooseOAuth(typeof provider === 'string' ? provider : undefined),
    chooseSso: (_event, email?: unknown) =>
      chooseSso(typeof email === 'string' ? email : undefined),
    startEmailSignIn: (_event, email: unknown) =>
      startEmailSignIn(typeof email === 'string' ? email : ''),
    submitEmailCode: (_event, code: unknown) =>
      submitEmailCode(typeof code === 'string' ? code : ''),
    signOut: (_event, accountId?: unknown) =>
      signOut(typeof accountId === 'string' ? accountId : undefined),
    getActiveSession: () => getActiveSession(),
    getState: () => getAuthState(),
    updateProfile: (_event, input: unknown) => {
      const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      return updateProfile({
        displayName:
          'displayName' in body
            ? typeof body.displayName === 'string' || body.displayName === null
              ? (body.displayName as string | null)
              : undefined
            : undefined,
        avatarBase64: typeof body.avatarBase64 === 'string' ? body.avatarBase64 : undefined,
        avatarContentType:
          typeof body.avatarContentType === 'string' ? body.avatarContentType : undefined,
        clearAvatar: body.clearAvatar === true,
      });
    },
  });

  setMainWindowFocuser(() => {
    focusWindowUnlessBackground(getWindow());
  });

  unsubscribe?.();
  unsubscribe = subscribeAuthState((state) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) sendRendererIpc(w.webContents, 'auth:state-changed', state);
  });
}
