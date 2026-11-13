import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import { Subject } from 'rxjs';

const loading = vi.hoisted(() => ({
  load: vi.fn(),
  ready: vi.fn(),
  duplicates: vi.fn(),
  attachments: vi.fn(),
  contacts: vi.fn(),
}));
vi.mock('molstar/lib/extensions/mvs/load', () => ({
  BuiltinLoadingExtensions: [],
  loadMVS: loading.load,
}));
vi.mock('./viewerReadiness', async (original) => ({
  ...(await original<typeof import('./viewerReadiness')>()),
  waitForPluginInteractionReady: loading.ready,
}));
vi.mock('./nucleotidePresentation', async (original) => ({
  ...(await original<typeof import('./nucleotidePresentation')>()),
  registerMolecularRenderProfileVisuals: vi.fn(),
}));
vi.mock('./molViewSpecGeometry', async (original) => ({
  ...(await original<typeof import('./molViewSpecGeometry')>()),
  findDuplicateMolViewSpecGeometry: loading.duplicates,
}));
vi.mock('./molecularConnections', async (original) => ({
  ...(await original<typeof import('./molecularConnections')>()),
  requireMolecularAttachmentCoverage: loading.attachments,
  requireMolViewSpecNativeContactOwners: loading.contacts,
}));

import {
  activeMolViewSpecScene,
  activeMolViewSpecSnapshotIndex,
  loadMolViewSpecScene,
  sameLoadedMolViewSpecScene,
  selectMolViewSpecSnapshot,
  validateMolViewSpecViewGeometry,
  captureMolViewSpecView,
  acceptSavedMolViewSpecView,
  commitCurrentMolViewSpecCamera,
} from './molViewSpec';

type Entry = { key?: string; snapshot: { id: string } };

function nativePlugin() {
  let entries: Entry[] = [];
  let current: string | undefined;
  const snapshot = {
    get state() {
      return { entries: Object.assign([...entries], { toArray: () => [...entries] }) };
    },
    get current() {
      return entries.find((entry) => entry.snapshot.id === current);
    },
    getEntry: (id: string) => entries.find((entry) => entry.snapshot.id === id),
    setCurrent: (id: string) => {
      current = id;
    },
    getStateSnapshot: async () => ({ entries: [...entries], current }),
    setStateSnapshot: async (state: { entries: Entry[]; current?: string }) => {
      entries = [...state.entries];
      current = state.current;
    },
  };
  const plugin = molstarPluginFixture({
    state: {
      getSnapshot: () => ({}),
      setSnapshot: vi.fn(async () => undefined),
      data: {
        events: {
          changed: new Subject<
            Parameters<PluginContext['state']['data']['events']['changed']['next']>[0]
          >(),
        },
        cells: new Map([
          ['source', { obj: new PluginStateObject.Data.String('data_story\n#'), state: {} }],
        ]),
      },
    },
    managers: { snapshot, asset: { set: vi.fn() } },
    commands: {
      dispatch: async (_command: unknown, params: { id: string }) => snapshot.setCurrent(params.id),
    },
  });
  return {
    plugin,
    entries: () => entries,
    replace: (replacement: Entry[]) => {
      entries = replacement;
      current = replacement[0]?.snapshot.id;
    },
  };
}

function story(withKeys = true) {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure()
    .component({ selector: 'all' })
    .representation({ type: 'cartoon' });
  const single = builder.getState();
  return MVSData.toMVSJ({
    kind: 'multiple',
    metadata: single.metadata,
    snapshots: [0, 1].map((index) => ({
      root: structuredClone(single.root),
      metadata: {
        title: `View ${index + 1}`,
        linger_duration_ms: 1000,
        ...(withKeys ? { key: `view:${index}` } : {}),
      },
    })),
  });
}

describe('saved story native cache validity', () => {
  beforeEach(() => {
    loading.load.mockReset();
    loading.ready.mockReset().mockResolvedValue({ structureCount: 1, representationCount: 1 });
    loading.duplicates.mockReset().mockReturnValue([]);
    loading.attachments.mockReset();
    loading.contacts.mockReset();
  });

  it('cancels an obsolete scene without logging a native failure or restoring over its successor', async () => {
    const f = nativePlugin();
    let current = true;
    loading.load.mockImplementation(async () => {
      current = false;
    });
    loading.ready.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadMolViewSpecScene(f.plugin, story(), () => current)).rejects.toMatchObject({
        code: 'VIEW_CHANGED',
      });
      expect(error).not.toHaveBeenCalled();
      expect(f.plugin.state.setSnapshot).not.toHaveBeenCalled();
      expect(activeMolViewSpecScene(f.plugin)).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });

  it('opens a single saved view even when its reused pane retains older story entries', async () => {
    const f = nativePlugin();
    const document = MVSData.fromMVSJ(story());
    if (document.kind !== 'multiple') throw Error('Expected the story fixture');
    const scene = MVSData.toMVSJ({
      root: document.snapshots[0].root,
      metadata: document.metadata,
    });
    loading.load.mockResolvedValue(undefined);
    await loadMolViewSpecScene(f.plugin, scene);
    f.replace([{ snapshot: { id: 'older:0' } }, { snapshot: { id: 'older:1' } }]);
    f.plugin.managers.snapshot.setCurrent('older:1' as never);

    expect(activeMolViewSpecSnapshotIndex(f.plugin)).toBe(0);
    await expect(selectMolViewSpecSnapshot(f.plugin, 0)).resolves.toMatchObject({ index: 0 });
    await expect(selectMolViewSpecSnapshot(f.plugin, 1)).rejects.toMatchObject({
      code: 'MVS_STORY_STEP_INVALID',
    });
  });

  it.each(['missing-view', 'wrong-key', 'legacy-replacement'] as const)(
    'reloads the complete saved story after %s instead of selecting stale native snapshots',
    async (stale) => {
      const f = nativePlugin();
      const scene = story(stale !== 'legacy-replacement');
      let loadCount = 0;
      loading.load.mockImplementation(async (_plugin, document) => {
        loadCount += 1;
        f.replace(
          document.snapshots.map((step: { metadata: { key?: string } }, index: number) => ({
            key: step.metadata.key,
            snapshot: { id: `load:${loadCount}:view:${index}` },
          }))
        );
      });
      await loadMolViewSpecScene(f.plugin, scene);
      expect(sameLoadedMolViewSpecScene(activeMolViewSpecScene(f.plugin), scene)).toBe(true);
      const old = f.entries();
      f.replace(
        stale === 'missing-view'
          ? old.slice(0, 1)
          : old.map((entry, index) => ({
              ...entry,
              ...(stale === 'wrong-key' ? { key: `other:${index}` } : {}),
              snapshot: {
                id: stale === 'legacy-replacement' ? `other:${index}` : entry.snapshot.id,
              },
            }))
      );
      expect(sameLoadedMolViewSpecScene(activeMolViewSpecScene(f.plugin), scene)).toBe(false);

      if (!sameLoadedMolViewSpecScene(activeMolViewSpecScene(f.plugin), scene))
        await loadMolViewSpecScene(f.plugin, scene);
      await selectMolViewSpecSnapshot(f.plugin, 1);
      expect(loadCount).toBe(2);
      expect(f.entries()).toHaveLength(2);
      expect(activeMolViewSpecSnapshotIndex(f.plugin)).toBe(1);
      expect(sameLoadedMolViewSpecScene(activeMolViewSpecScene(f.plugin), scene)).toBe(true);
    }
  );

  it.each([false, true])(
    'checks every saved view without presenting another view or losing live edits (invalid later view: %s)',
    async (invalid) => {
      const f = nativePlugin();
      loading.load.mockImplementation(async (_plugin, document) => {
        f.replace(
          document.snapshots.map((step: { metadata: { key: string } }, index: number) => ({
            key: step.metadata.key,
            snapshot: {
              id: `saved:${index}`,
              geometry: `saved-geometry:${index}`,
              camera: {
                current: { position: [index, 0, 30] },
                transitionStyle: 'animate',
                transitionDurationInMs: 800,
              },
            },
          }))
        );
      });
      await loadMolViewSpecScene(f.plugin, story());
      const entriesBefore = JSON.stringify(f.entries());
      f.plugin.managers.snapshot.setCurrent('saved:1' as never);
      let geometry = 'live-edited-geometry';
      const initialCamera = { position: [12, 8, 40], target: [0, 0, 0], up: [0, 1, 0] };
      let camera = structuredClone(initialCamera);
      let paused = false;
      let manualReset = false;
      const listeners = new Set<() => void>();
      const presented: unknown[] = [];
      const present = () => {
        if (paused) return;
        presented.push({
          id: f.plugin.managers.snapshot.current?.snapshot.id,
          geometry,
          camera: structuredClone(camera),
        });
        for (const listener of listeners) listener();
      };
      Object.assign(f.plugin, {
        animationLoop: { isAnimating: true },
        canvas3d: {
          props: { camera: { manualReset: false } },
          pause: () => {
            paused = true;
          },
          resume: () => {
            paused = false;
            present();
          },
          animate: vi.fn(),
          commit: present,
          requestDraw: present,
          didDraw: {
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return { unsubscribe: () => listeners.delete(listener) };
            },
          },
          setProps: (props: { camera?: { manualReset: boolean } }) => {
            if (props.camera) manualReset = props.camera.manualReset;
          },
          camera: {
            getSnapshot: () => structuredClone(camera),
            setState: (value: typeof camera) => {
              camera = structuredClone(value);
              present();
            },
            transition: { inTransition: false },
          },
        },
      });
      Object.assign(f.plugin.state, {
        getSnapshot: () => ({
          id: 'live-state',
          geometry,
          camera: { current: structuredClone(camera) },
        }),
      });
      vi.mocked(f.plugin.state.setSnapshot).mockImplementation(async (value) => {
        const snapshot = value;
        if (!('geometry' in snapshot) || typeof snapshot.geometry !== 'string')
          throw Error('Missing test geometry snapshot.');
        geometry = snapshot.geometry;
        if (snapshot.camera?.current) camera = structuredClone(snapshot.camera.current);
        present();
      });
      Object.assign(f.plugin.commands, {
        dispatch: async (_command: unknown, { id }: { id: string }) => {
          const entry = f.plugin.managers.snapshot.getEntry(id as never)!;
          f.plugin.managers.snapshot.setCurrent(id as never);
          await f.plugin.state.setSnapshot(entry.snapshot);
        },
      });
      const checked: string[] = [];
      loading.duplicates.mockImplementation(() => {
        const id = f.plugin.managers.snapshot.current!.snapshot.id;
        checked.push(id);
        return invalid && id === 'saved:1'
          ? [
              {
                type: 'cartoon',
                largerType: 'cartoon',
                repeatedElementCount: 1,
                largerComponent: 'Primary',
                smallerComponent: 'Duplicate',
              },
            ]
          : [];
      });
      loading.ready.mockImplementation(async () => {
        present();
        return { structureCount: 1, representationCount: 1 };
      });
      const validation = validateMolViewSpecViewGeometry(f.plugin);
      if (invalid)
        await expect(validation).rejects.toMatchObject({ code: 'MVS_DUPLICATE_GEOMETRY' });
      else await validation;
      expect(checked).toEqual(['saved:0', 'saved:1']);
      expect(loading.attachments).toHaveBeenCalledTimes(2);
      expect(loading.contacts).toHaveBeenCalledTimes(invalid ? 1 : 2);
      expect(presented.length).toBeGreaterThan(0);
      for (const frame of presented)
        expect(frame).toEqual({
          id: 'saved:1',
          geometry: 'live-edited-geometry',
          camera: initialCamera,
        });
      expect(geometry).toBe('live-edited-geometry');
      expect(camera).toEqual(initialCamera);
      expect(paused).toBe(false);
      expect(manualReset).toBe(false);
      expect(JSON.stringify(f.entries())).toBe(entriesBefore);
    }
  );

  it.each([false, true])(
    'preserves legacy story capture while enforcing a declared current legend contract (%s)',
    async (declaresCurrentContract) => {
      const f = nativePlugin();
      loading.load.mockImplementation(async (_plugin, document) => {
        f.replace(
          document.snapshots.map((step: { metadata: { key: string } }, index: number) => ({
            key: step.metadata.key,
            snapshot: { id: `legacy:${index}` },
          }))
        );
      });
      const document = JSON.parse(story());
      if (declaresCurrentContract)
        document.snapshots[0].root.custom = {
          dnaforge_display_group_contract: 'automatic-display-groups-v1',
        };
      const scene = JSON.stringify(document);
      await loadMolViewSpecScene(f.plugin, scene);
      Object.assign(f.plugin, {
        canvas3d: {
          camera: {
            getSnapshot: () => ({
              target: [0, 0, 0],
              position: [0, 0, 30],
              up: [0, 1, 0],
              minNear: 1,
              mode: 'perspective',
              fov: Math.PI / 4,
            }),
          },
        },
      });
      const entries = JSON.stringify(f.entries());
      const capture = () => captureMolViewSpecView(f.plugin, { cameraPolicy: 'preserve-authored' });
      if (declaresCurrentContract) expect(capture).toThrow('without a valid legend');
      else {
        expect(capture().scene).toBe(scene);
        expect(capture().initialSnapshotIndex).toBe(0);
      }
      expect(activeMolViewSpecScene(f.plugin)).toBe(scene);
      expect(JSON.stringify(f.entries())).toBe(entries);
    }
  );

  it('retains all authored view cameras during ordinary Save and publishes only explicit framing changes', async () => {
    const f = nativePlugin();
    loading.load.mockImplementation(async (_plugin, document) => {
      f.replace(
        document.snapshots.map((step: { metadata: { key: string } }, index: number) => ({
          key: step.metadata.key,
          snapshot: { id: `saved:${index}`, camera: { current: { position: [index, 0, 30] } } },
        }))
      );
    });
    const authored = JSON.parse(story());
    for (const step of authored.snapshots) {
      step.root.custom = { dnaforge_display_group_contract: 'automatic-display-groups-v1' };
      step.root.children[0].children[0].children[0].children[0].children[0].custom = {
        dnaforge_display_group: {
          id: 'all-atoms',
          label: 'All atoms',
          color: '#224466',
          residual: false,
        },
      };
    }
    const scene = JSON.stringify(authored);
    await loadMolViewSpecScene(f.plugin, scene);
    f.plugin.managers.snapshot.setCurrent('saved:1' as never);
    const camera = {
      target: [0, 0, 0],
      position: [12, 8, 40],
      up: [0, 1, 0],
      minNear: 1,
      mode: 'perspective',
      fov: Math.PI / 4,
    };
    Object.assign(f.plugin, {
      canvas3d: { camera: { getSnapshot: () => structuredClone(camera) } },
    });
    const stored = JSON.stringify(f.entries());
    const policy = { cameraPolicy: 'preserve-authored' as const };
    const retained = captureMolViewSpecView(f.plugin, policy);
    expect(retained.scene).toBe(scene);
    expect(retained.initialSnapshotIndex).toBe(1);
    expect(acceptSavedMolViewSpecView(f.plugin, retained, retained.scene, policy)).toBe(true);
    expect(JSON.stringify(f.entries())).toBe(stored);
    expect(camera.position).toEqual([12, 8, 40]);

    const committed = commitCurrentMolViewSpecCamera(f.plugin);
    expect(JSON.parse(committed.scene).snapshots[0]).toEqual(JSON.parse(scene).snapshots[0]);
    expect(JSON.parse(committed.scene).snapshots[1]).not.toEqual(JSON.parse(scene).snapshots[1]);
    expect(f.entries()[0]).toEqual(JSON.parse(stored)[0]);
    expect(f.entries()[1].snapshot).toMatchObject({ camera: { current: camera } });
    expect(captureMolViewSpecView(f.plugin, policy).scene).toBe(committed.scene);
  });
});
