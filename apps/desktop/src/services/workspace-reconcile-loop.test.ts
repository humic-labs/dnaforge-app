import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clearMockData, setFileTree, setMockFileContent } from '../test/platform-mocks';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { platform } from '../platform';
import { resolveWorkspaceScope } from '../db/workspace-catalog';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import {
  NATIVE_WORKSPACE_MANIFEST_SCHEMA,
  serializeNativeWorkspaceManifest,
} from '../shared/native-workspace-manifest';
import { queryLimsEntities } from '../features/lims/operations';
import * as analytics from '../lib/analytics';
import { reconcileWorkspaceRoot } from './workspace-reconcile';

describe('Registry projection replay', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
  });
  afterEach(() => vi.restoreAllMocks());
  it('replays the actual Registry projection tick 100 times without duplicate creation or a changed home', async () => {
    setFileTree('/lab', [{ name: 'Imported strain', isDirectory: true }]);
    setMockFileContent(
      '/lab/Imported strain/.forge/benchling-native-record.json',
      '{"kind":"strain"}'
    );
    setMockFileContent(
      '/lab/.forge/catalog.json',
      serializeNativeWorkspaceManifest({
        schema: NATIVE_WORKSPACE_MANIFEST_SCHEMA,
        entities: [
          {
            id: 'repeated-strain',
            type: 'sample',
            name: 'Imported strain',
            path: 'Imported strain/.forge/benchling-native-record.json',
            fileKind: 'benchling-native-record-evidence',
            lims: {
              kind: 'strain',
              name: 'Imported strain',
              fields: { genotypeCanonical: 'deltaX' },
              registrationStatus: 'registered',
            },
          },
        ],
        links: [],
      })
    );
    const track = vi.spyOn(analytics, 'trackRendererEvent').mockReturnValue(true);
    const creates = vi.spyOn(platform().lims, 'registerEntity');
    const initial = await reconcileWorkspaceRoot('/lab');
    expect(initial.errors).toEqual([]);
    const scope = await resolveWorkspaceScope('/lab');
    const id = scopedProjectionId(scope, 'repeated-strain');
    const [before] = await queryLimsEntities({ id, includeArchived: true });
    expect(before).toBeDefined();
    for (let tick = 0; tick < 100; tick += 1) {
      expect((await reconcileWorkspaceRoot('/lab')).errors).toEqual([]);
    }
    expect(creates).toHaveBeenCalledTimes(1);
    expect(await queryLimsEntities({ id, includeArchived: true })).toEqual([before]);
    expect(track.mock.calls.filter(([event]) => event === 'meaningful_activity_completed')).toEqual(
      []
    );
    expect(
      track.mock.calls.filter(([event]) => event === 'workflow_action_observed').length
    ).toBeLessThan(100);
  });
});
