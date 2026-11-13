import type { OrganizationSavedSequenceSnapshot } from './org-registry-saved-sequence-snapshot-contract';
import { isDeepStrictEqual } from 'node:util';
import {
  registeredRecordResolutionIdentity,
  type RegisteredRecordResolutionRequest,
  type RegisteredRecordResolutionPublicationResult,
  type VerifiedRegisteredRecordResolution,
} from './org-registry-local-mutations';
import { readCheckedOrganizationRecordReview } from './org-registry-record-review';
import {
  prepareSequenceKeepSavedPublication,
  readRetainedSequenceKeepSavedPublication,
  type RegisteredSequencePackagePublicationContext,
} from './sequence-package-registry-publication';
import { publishSequenceKeepSavedPublicationInMain } from './sequence-package-revision-publication';
export { readPendingSequenceKeepSavedIdentity } from './sequence-package-registry-publication';

export async function publishReviewedSequencePackageResolution(
  context: RegisteredSequencePackagePublicationContext,
  input: {
    workspaceRoot: string;
    packageRoot: string;
    request: RegisteredRecordResolutionRequest;
    organizationSnapshot?: OrganizationSavedSequenceSnapshot;
    verifiedAccessGeneration: string;
  }
): Promise<RegisteredRecordResolutionPublicationResult> {
  const identity = registeredRecordResolutionIdentity(input.request);
  const verified = { ...identity, verifiedAccessGeneration: input.verifiedAccessGeneration };
  const prior = await resumeReviewedSequencePackageResolution(context, verified);
  if (prior) return prior;
  if (identity.choice === 'use_remote' && !input.organizationSnapshot)
    throw Object.assign(
      new Error(
        'The exact saved package for this organization version is unavailable. Registry fields cannot replace sequence bytes or package history.'
      ),
      { code: 'SAVED_VERSION_UNAVAILABLE' }
    );
  const assertAccount = async () => {
    if ((await context.getActiveAccountId()) !== identity.accountId)
      throw new Error('Sign in with the registered sequence account before resolving it.');
  };
  await assertAccount();
  const checked = await readCheckedOrganizationRecordReview(
    context.db,
    identity,
    assertAccount,
    context.runDatabase
  );
  if (!checked.sequence || checked.review.binding.authority !== 'sequence_package')
    throw new Error('This review does not belong to a managed sequence package.');
  if (
    checked.displayed.sourceRevision !== identity.sourceRevision ||
    !isDeepStrictEqual(checked.review, input.request.review)
  )
    throw Object.assign(
      new Error(
        'The saved sequence or organization review changed. Review the current versions again.'
      ),
      { code: 'REVIEW_CHANGED' }
    );
  await prepareSequenceKeepSavedPublication(context, { ...input, checked: checked.sequence });
  await publishSequenceKeepSavedPublicationInMain(context, verified);
  const completed = await readRetainedSequenceKeepSavedPublication(context, verified);
  if (!completed?.result) throw new Error('The reviewed sequence publication is still pending.');
  await assertAccount();
  return { entity: completed.result, replayed: false };
}

export async function resumeReviewedSequencePackageResolution(
  context: RegisteredSequencePackagePublicationContext,
  input: VerifiedRegisteredRecordResolution
): Promise<RegisteredRecordResolutionPublicationResult | null> {
  const retained = await readRetainedSequenceKeepSavedPublication(context, input);
  if (!retained) return null;
  if (retained.result) return { entity: retained.result, replayed: true };
  await publishSequenceKeepSavedPublicationInMain(context, input);
  const completed = await readRetainedSequenceKeepSavedPublication(context, input);
  if (!completed?.result) throw new Error('The approved sequence choice is still pending.');
  return { entity: completed.result, replayed: true };
}
