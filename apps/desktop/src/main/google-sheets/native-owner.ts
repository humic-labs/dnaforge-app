import { getSelectedAccountContext } from '../auth/session-store';
import type { GoogleSheetsOwner } from './credential-store';
import { GoogleSheetsConnectionError } from './controller';

export async function getGoogleSheetsOwner(): Promise<GoogleSheetsOwner> {
  const context = await getSelectedAccountContext();
  switch (context.kind) {
    case 'account':
      return { kind: 'account', accountId: context.accountId };
    case 'signed-out':
      return { kind: 'device' };
    case 'unavailable':
      throw new GoogleSheetsConnectionError(
        'account-context-unavailable',
        'Account status is unavailable. Reopen DNAForge and try again.'
      );
    default: {
      const exhaustive: never = context;
      throw new Error(`Unknown account context: ${exhaustive}`);
    }
  }
}
