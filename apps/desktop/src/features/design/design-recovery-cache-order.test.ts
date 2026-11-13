import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDesignStore } from './store';
import { acceptDesignArtifact, useDesignRecoveryStore } from './design-recovery';
import {
  startDesignArtifactMirroring,
  stopDesignArtifactMirroring,
} from './design-artifact-mirror';

vi.mock('../../db/workspace-artifacts', () => ({
  writeDesignArtifactSnapshot: vi.fn().mockRejectedValue(new Error('EACCES')),
}));

beforeEach(() => {
  localStorage.clear();
  useDesignRecoveryStore.setState({ records: {} });
  useDesignStore.setState({ designs: {}, activeDesignId: null });
  vi.useFakeTimers();
});
afterEach(() => {
  stopDesignArtifactMirroring();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('does not replace a newer recoverable cache when its separate publication record failed to persist', async () => {
  const id = useDesignStore.getState().createDesign('A');
  const baseline = useDesignStore.getState().designs[id];
  acceptDesignArtifact(baseline);
  startDesignArtifactMirroring();
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key.startsWith('waypoint-design-recovery-v1:')) throw new Error('journal storage failure');
    return write.call(this, key, value);
  });
  useDesignStore.getState().updateDesign(id, { name: 'Recoverable B' });
  await vi.advanceTimersByTimeAsync(250);
  expect(JSON.parse(localStorage.getItem('waypoint-designs')!).state.designs[id].name).toBe(
    'Recoverable B'
  );
  stopDesignArtifactMirroring();
  vi.restoreAllMocks();
  useDesignRecoveryStore.setState({ records: {} });
  await useDesignStore.persist.rehydrate();
  startDesignArtifactMirroring();
  useDesignStore.getState().upsertDesignFromArtifact(baseline);
  expect(useDesignStore.getState().designs[id].name).toBe('Recoverable B');
});
