import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDesignStore } from '../design/store';
import { usePageStore } from '../page/store';
import { useSequenceStore } from '../sequence/store';
import { useStructureDrawerStore } from '../structure-drawer/state/use-structure-drawer-store';
import { captureDomainStateSnapshot } from './domain-state-snapshot';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('captureDomainStateSnapshot', () => {
  it('returns a snapshot with the four expected store_revisions keys', () => {
    const snapshot = captureDomainStateSnapshot('workspace-A');

    expect(Object.keys(snapshot.store_revisions).sort()).toEqual([
      'design',
      'page',
      'sequence',
      'structureDrawer',
    ]);
    for (const value of Object.values(snapshot.store_revisions)) {
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('passes the workspace_path argument through verbatim, including null and empty string', () => {
    expect(captureDomainStateSnapshot('workspace-A').workspace_path).toBe('workspace-A');
    expect(captureDomainStateSnapshot(null).workspace_path).toBeNull();
    expect(captureDomainStateSnapshot('').workspace_path).toBe('');
  });

  it('emits an ISO-8601 captured_at timestamp', () => {
    const snapshot = captureDomainStateSnapshot('workspace-A');
    expect(snapshot.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    expect(Number.isNaN(new Date(snapshot.captured_at).getTime())).toBe(false);
  });

  it('reflects a +1 store-revision delta when an object-form setState bumps a store', () => {
    const designStateBefore = useDesignStore.getState();
    try {
      const before = captureDomainStateSnapshot('workspace-A');
      useDesignStore.setState({});
      const after = captureDomainStateSnapshot('workspace-A');

      expect(after.store_revisions.design).toBe(before.store_revisions.design + 1);
      expect(after.store_revisions.sequence).toBe(before.store_revisions.sequence);
      expect(after.store_revisions.page).toBe(before.store_revisions.page);
      expect(after.store_revisions.structureDrawer).toBe(before.store_revisions.structureDrawer);
    } finally {
      useDesignStore.setState(designStateBefore, true);
    }
  });

  it('omits a store key when its getState() returns a non-number revision', () => {
    vi.spyOn(usePageStore, 'getState').mockReturnValue({
      pages: {},
      pageList: [],
    } as never);

    const snapshot = captureDomainStateSnapshot('workspace-A');
    expect('page' in snapshot.store_revisions).toBe(false);
    expect(typeof snapshot.store_revisions.sequence).toBe('number');
    expect(typeof snapshot.store_revisions.design).toBe('number');
    expect(typeof snapshot.store_revisions.structureDrawer).toBe('number');
  });

  it('omits a store key when getState() throws', () => {
    vi.spyOn(useSequenceStore, 'getState').mockImplementation(() => {
      throw new Error('store offline');
    });

    expect(() => captureDomainStateSnapshot('workspace-A')).not.toThrow();
    const snapshot = captureDomainStateSnapshot('workspace-A');
    expect('sequence' in snapshot.store_revisions).toBe(false);
  });

  it('omits a store key when revision is NaN', () => {
    vi.spyOn(useDesignStore, 'getState').mockReturnValue({ revision: Number.NaN } as never);

    const snapshot = captureDomainStateSnapshot('workspace-A');
    expect('design' in snapshot.store_revisions).toBe(false);
  });

  it('returns a well-formed snapshot even when every store getState() throws', () => {
    vi.spyOn(useSequenceStore, 'getState').mockImplementation(() => {
      throw new Error('sequence offline');
    });
    vi.spyOn(useDesignStore, 'getState').mockImplementation(() => {
      throw new Error('design offline');
    });
    vi.spyOn(usePageStore, 'getState').mockImplementation(() => {
      throw new Error('page offline');
    });
    vi.spyOn(useStructureDrawerStore, 'getState').mockImplementation(() => {
      throw new Error('structure offline');
    });

    let snapshot: ReturnType<typeof captureDomainStateSnapshot> | undefined;
    expect(() => {
      snapshot = captureDomainStateSnapshot('workspace-A');
    }).not.toThrow();
    expect(snapshot!.store_revisions).toEqual({});
    expect(snapshot!.workspace_path).toBe('workspace-A');
    expect(snapshot!.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  });
});
