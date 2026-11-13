import {
  isUserMessagePayload,
  renderUserMessagePayload,
  userMessage,
  userMessageValue,
  userMessageWithValues,
  type UserMessage,
} from '@waypoint/user-messages';
import type { ImportReviewReceipt } from '../../shared/import-review';
import type { RegisterImportedSequenceResult } from '../../shared/workspace-git-types';

export function importReceiptMessage(
  receipt: ImportReviewReceipt | undefined,
  includeLinks = true
): UserMessage {
  if (!receipt) return userMessage('registry.receipt.unconfirmed');
  const imported = userMessageValue(receipt?.imported ?? 0);
  const links = userMessageValue(receipt?.insertedLinks ?? 0);
  const skipped = userMessageValue(receipt?.skipped ?? 0);
  if (!(receipt.failed || receipt.partialEffects?.length || receipt.userMessagePayload))
    return includeLinks
      ? userMessageWithValues('registry.receipt.summaryWithLinks', { imported, links, skipped })
      : userMessageWithValues('registry.receipt.summary', { imported, skipped });
  const fallback =
    receipt.changed === true ? 'registry.receipt.savedIncomplete' : 'registry.receipt.unconfirmed';
  const detail = userMessageValue(
    isUserMessagePayload(receipt.userMessagePayload)
      ? renderUserMessagePayload(receipt.userMessagePayload, fallback)
      : userMessage(fallback)
  );
  return includeLinks
    ? userMessageWithValues('registry.receipt.detailsWithLinks', {
        imported,
        links,
        skipped,
        detail,
      })
    : userMessageWithValues('registry.receipt.details', { imported, skipped, detail });
}

export function sequenceRegistrationFailureMessage(
  result: Pick<RegisterImportedSequenceResult, 'userMessagePayload'>
): UserMessage {
  return isUserMessagePayload(result.userMessagePayload)
    ? renderUserMessagePayload(result.userMessagePayload, 'registry.receipt.registrationFailed')
    : userMessage('registry.receipt.registrationFailed');
}
