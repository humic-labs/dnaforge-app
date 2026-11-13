import { beforeEach, expect, it, vi } from 'vitest';
import { openDesignDocument } from './open-design-document';
import { useDesignStore } from './store';
import {
  acceptDesignArtifact,
  captureDesignRecovery,
  useDesignRecoveryStore,
} from './design-recovery';

const present = vi.hoisted(() => vi.fn());
vi.mock('../canvas/present-document', () => ({ presentDocument: present }));
vi.mock('../../lib/readable-content-telemetry', () => ({
  registerPendingReadableContent: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  useDesignRecoveryStore.setState({ records: {} });
  useDesignStore.setState({ designs: {}, activeDesignId: null });
  present.mockReset().mockReturnValue({ status: 'presented', tabId: 'design-tab' });
});

it('presents the recovered draft name when the opened file still has an older name', () => {
  const id = useDesignStore.getState().createDesign('Published name');
  const published = useDesignStore.getState().designs[id];
  acceptDesignArtifact(published);
  captureDesignRecovery({ ...published, name: 'Recovered name' }, published);

  openDesignDocument({
    artifact: {
      schema: 'waypoint.design.v1',
      kind: 'assembly-design',
      id,
      name: 'Published name',
      design: published,
      raw: {},
    },
    entityId: id,
    label: 'old-filename.wpdesign.json',
    placement: { kind: 'focused' },
  });

  expect(useDesignStore.getState().designs[id].name).toBe('Recovered name');
  expect(present).toHaveBeenCalledWith(
    { type: 'design', entityId: id, label: 'Recovered name' },
    { kind: 'focused' },
    'ready'
  );
});

it('refuses a stale local-storage pointer instead of opening an empty design tab', () => {
  const result = openDesignDocument({
    artifact: {
      schema: 'waypoint.design.v1',
      kind: 'assembly-design',
      id: 'missing-design',
      name: 'Missing design',
      design: null,
      raw: {},
    },
    entityId: 'missing-design',
    label: 'Missing design',
    placement: { kind: 'focused' },
  });

  expect(result).toEqual({
    status: 'failed',
    message: 'Design "Missing design" is not available on this installation.',
  });
  expect(present).not.toHaveBeenCalled();
});
