import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LimsPendingRef } from '../../shared/lims';
import { subscribeLimsRegistrationChanged } from './events';
import { queryLimsPendingRefs } from './operations';
import { actionablePendingRefs, unconnectedEntityIds } from './unconnected-registry';

function sameActionableRefs(
  current: readonly LimsPendingRef[],
  next: readonly LimsPendingRef[]
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (ref, index) =>
        ref.key === next[index]?.key &&
        ref.status === next[index]?.status &&
        ref.candidates.length === next[index]?.candidates.length
    )
  );
}

export function useActionablePendingRefs(): {
  refs: LimsPendingRef[];
  entityIds: string[];
  reload: () => Promise<void>;
} {
  const [refs, setRefs] = useState<LimsPendingRef[]>([]);
  const reload = useCallback(async () => {
    let next: LimsPendingRef[] = [];
    try {
      next = actionablePendingRefs(await queryLimsPendingRefs());
    } catch {
      next = [];
    }
    setRefs((current) => (sameActionableRefs(current, next) ? current : next));
  }, []);
  useEffect(() => {
    void reload();
    return subscribeLimsRegistrationChanged(() => {
      void reload();
    });
  }, [reload]);
  const entityIds = useMemo(() => unconnectedEntityIds(refs), [refs]);
  return { refs, entityIds, reload };
}
