import type { LimsPendingRef } from '../../shared/lims';

const ACTIONABLE_STATUS = new Set<LimsPendingRef['status']>(['open', 'draft', 'ambiguous']);

export function actionablePendingRefs(refs: readonly LimsPendingRef[]): LimsPendingRef[] {
  return refs.filter((ref) => ACTIONABLE_STATUS.has(ref.status));
}

export function unconnectedEntityIds(refs: readonly LimsPendingRef[]): string[] {
  return [...new Set(actionablePendingRefs(refs).map((ref) => ref.referrerEntityId))].sort();
}

export function sourceFieldIsUnconnected(value: string, refs: readonly LimsPendingRef[]): boolean {
  const targets = new Set(
    actionablePendingRefs(refs).map((ref) => ref.targetName.trim().toLowerCase())
  );
  if (targets.size === 0) return false;
  const whole = value.trim().toLowerCase();
  if (targets.has(whole)) return true;
  return value.split(/[;,]/u).some((part) => targets.has(part.trim().toLowerCase()));
}
