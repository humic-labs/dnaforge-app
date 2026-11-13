import type { WorkspaceVersionId } from './identity';
import type { PublicationPlan, RefAdvance, ImmutableRecordWrite, NonEmpty } from './types';
import { deepFreeze } from './immutable';

export type PublicationCommitResult =
  | { readonly kind: 'committed' }
  | { readonly kind: 'ref-mismatch'; readonly actual: WorkspaceVersionId | null };

export interface AtomicPublicationAdapter {
  commitAtomically(plan: PublicationPlan): Promise<PublicationCommitResult>;
}

const ownedPlans = new WeakSet<Readonly<object>>();

export function definePublicationPlan(
  recordWrites: NonEmpty<ImmutableRecordWrite>,
  refAdvance: RefAdvance
): PublicationPlan {
  const plan = deepFreeze({ recordWrites, refAdvance });
  ownedPlans.add(plan);
  return plan;
}

export async function commitPublication(
  adapter: AtomicPublicationAdapter,
  plan: PublicationPlan
): Promise<PublicationCommitResult> {
  if (!ownedPlans.has(plan)) {
    throw new TypeError('PublicationPlan was not created by this package.');
  }
  const result = await adapter.commitAtomically(plan);
  if (
    result.kind !== 'committed' &&
    (result.kind !== 'ref-mismatch' ||
      (result.actual !== null && typeof result.actual !== 'string'))
  ) {
    throw new TypeError('Atomic publication adapter returned an invalid result.');
  }
  return deepFreeze(result);
}
