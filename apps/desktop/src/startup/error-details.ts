import { APP_BUILD } from '../lib/app-build';
import { appBuildLabel } from '../shared/app-build-identity';
import { toUserMessage, type UserMessage } from '@waypoint/user-messages';

export interface ErrorReport {
  summary: UserMessage;
  reference: string;
  copyText: string;
}

function newReference(): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `E-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

export function reportErrorForDisplay(error: unknown, context: string): ErrorReport {
  const raw =
    error instanceof Error
      ? [error.name, error.message, error.stack].filter(Boolean).join('\n')
      : String(error ?? '');
  const reference = newReference();
  console.error(`[ErrorReport ${reference}] ${context}:`, raw);

  const summary = toUserMessage(error, 'operation.failed');
  const copyText = [
    `DNAForge ${appBuildLabel(APP_BUILD)}`,
    `Error: ${summary}`,
    `Reference: ${reference}`,
  ].join('\n');
  return { summary, reference, copyText };
}
