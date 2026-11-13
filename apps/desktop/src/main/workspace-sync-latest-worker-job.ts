import {
  validateDesktopSyncLatestBundleEnvelope,
  type ValidatedDesktopSyncLatestBundleEnvelope,
} from './workspace-sync-bundle-integrity';

export function parseAndValidateDesktopSyncLatestResponse(
  bytes: Uint8Array
): ValidatedDesktopSyncLatestBundleEnvelope {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Latest cloud bundle response is not valid UTF-8.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Latest cloud bundle response contains malformed JSON.');
  }
  return validateDesktopSyncLatestBundleEnvelope(parsed);
}
