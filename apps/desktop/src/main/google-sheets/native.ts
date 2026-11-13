import { app, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { createGoogleSheetsReader } from './api';
import { createGoogleSheetsController } from './controller';
import { createGoogleSheetsCredentialStore } from './credential-store';
import { getGoogleSheetsOwner } from './native-owner';
import { createGoogleSheetsOAuth, parseGoogleSheetsOAuthConfig } from './oauth';

export function createNativeGoogleSheetsController() {
  const registration = app.isPackaged
    ? {
        clientId:
          typeof __DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID__ === 'string'
            ? __DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID__
            : undefined,
        clientSecret:
          typeof __DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_SECRET__ === 'string'
            ? __DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_SECRET__
            : undefined,
      }
    : (() => {
        const config = loadConfig(app.getAppPath());
        return {
          clientId: config.DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID,
          clientSecret: config.DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_SECRET,
        };
      })();
  const { clientId, clientSecret } = registration;
  const oauthConfig = parseGoogleSheetsOAuthConfig({
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  });
  return createGoogleSheetsController({
    oauth: oauthConfig ? createGoogleSheetsOAuth({ fetch, config: oauthConfig }) : null,
    reader: createGoogleSheetsReader({ fetch }),
    owner: getGoogleSheetsOwner,
    openExternal: (url) => {
      const destination = new URL(url);
      if (
        destination.origin !== 'https://accounts.google.com' ||
        destination.pathname !== '/o/oauth2/v2/auth' ||
        destination.username ||
        destination.password ||
        destination.hash
      )
        throw new Error('Google Sheets refused an unexpected authorization destination.');
      return shell.openExternal(destination.toString());
    },
    store: createGoogleSheetsCredentialStore({
      directory: join(app.getPath('userData'), 'integrations', 'google-sheets'),
      cipher: {
        available: () =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (bytes) => safeStorage.decryptString(bytes),
      },
    }),
  });
}
