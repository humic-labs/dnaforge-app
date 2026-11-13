import { UserMessagePayload } from '@waypoint/user-messages';
export interface DesktopPublicSession {
  accountId: string;
  desktopSessionId: string;
  email?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  channel: string;
  accessTokenExpiresAt: string;
  meaningfulActivityAuthority?: import('./analytics-types').MeaningfulActivityAuthority;
}

export type DesktopAuthState =
  | { status: 'signed-out' }
  | { status: 'starting' }
  | { status: 'choosing'; error?: string; errorMessagePayload?: UserMessagePayload }
  | {
      status: 'email-sent';
      email: string;
      error?: string;
      errorMessagePayload?: UserMessagePayload;
    }
  | { status: 'awaiting-confirmation'; browserOpenFailed?: boolean; providerUrl?: string }
  | { status: 'exchanging' }
  | { status: 'signed-in'; session: DesktopPublicSession; justSignedIn?: boolean }
  | { status: 'error'; reason: string; message: string }
  | { status: 'unavailable'; reason: 'encryption_unavailable' };
