import { molstarPluginFixture, type ServiceFixture } from '@/test/fixtures/molstar-plugin';
import { describe, expect, it } from 'vitest';
import { StateObject, StateTransformer } from 'molstar/lib/mol-state';
import { Structure } from 'molstar/lib/mol-model/structure';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import { StructureHierarchy } from 'molstar/lib/mol-plugin-state/manager/structure/hierarchy-state';
import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import {
  applySurfaceOverlayRenderPlan,
  selectSurfaceOverlayCells,
  type SurfaceOverlayRepresentationApi,
} from './surfaceOverlay';
import { STRUCTURE_COMPONENT_LABELS } from './componentLabels';

const component = StateTransformer.builderFactory('fixture-surface-test')({
  name: 'component',
  from: PluginStateObject.Root,
  to: PluginStateObject.Molecule.Structure,
  params: { label: PD.Text('') },
})({
  apply: ({ params }) =>
    new PluginStateObject.Molecule.Structure(Structure.Empty, { label: params.label }),
});

class SurfaceFixture extends StateObject.create<
  { repr: { setState: () => void } },
  StateObject.Type
>({ name: 'Surface fixture', typeClass: 'Object' }) {}

const surface = StateTransformer.builderFactory('fixture-surface-test')({
  name: 'surface',
  from: PluginStateObject.Molecule.Structure,
  to: SurfaceFixture,
})({
  apply: () => new SurfaceFixture({ repr: { setState: () => undefined } }),
});

type FixtureStructure = ServiceFixture<
  PluginContext['managers']['structure']['hierarchy']['current']['structures'][number]
>;

async function fixture() {
  const structures: FixtureStructure[] = [];
  const plugin = molstarPluginFixture({});
  const current: ServiceFixture<PluginContext['managers']['structure']['hierarchy']['current']> = {
    ...StructureHierarchy(),
    structures,
  };
  Object.defineProperty(plugin.managers.structure.hierarchy, 'current', {
    value: current,
    configurable: true,
  });
  const builder = plugin.state.data.build();
  const context = builder
    .toRoot()
    .apply(
      component,
      { label: STRUCTURE_COMPONENT_LABELS.rcsbContextPolymer },
      { ref: 'context-component' }
    );
  const query = builder
    .toRoot()
    .apply(
      component,
      { label: STRUCTURE_COMPONENT_LABELS.rcsbQueryPolymer },
      { ref: 'query-component' }
    );
  await builder.commit();
  const contextObject = context.selector.obj;
  const queryObject = query.selector.obj;
  if (!contextObject || !queryObject) throw new Error('Surface fixture components did not load');
  structures.push({
    cell: { obj: contextObject, transform: { ref: context.ref } },
    components: [
      { cell: { obj: contextObject, transform: { ref: context.ref } } },
      { cell: { obj: queryObject, transform: { ref: query.ref } } },
    ],
  });
  const representationApi: SurfaceOverlayRepresentationApi = {
    createStructureRepresentationParams: () => ({}),
    StateTransforms: { Representation: { StructureRepresentation3D: surface } },
  };
  return { plugin, representationApi };
}

describe('surface overlay publication', () => {
  it('publishes the complete context and query surface together', async () => {
    const { plugin, representationApi } = await fixture();
    const published: string[][] = [];
    const subscription = plugin.state.data.events.changed.subscribe(() => {
      published.push(
        selectSurfaceOverlayCells(plugin)
          .map((cell) => {
            const ref = cell.transform?.ref;
            const retained = ref ? plugin.state.data.cells.get(ref) : undefined;
            if (!retained) throw new Error('Published overlay has no state cell');
            return retained.transform.parent;
          })
          .sort()
      );
    });
    try {
      const refs = await applySurfaceOverlayRenderPlan(
        plugin,
        { enabled: true, targetScope: 'broad', typeParams: { alpha: 0.13 } },
        { loadRepresentationApi: async () => representationApi }
      );
      expect(refs).toHaveLength(2);
      expect(published).toEqual([['context-component', 'query-component']]);
    } finally {
      subscription.unsubscribe();
      plugin.dispose();
    }
  });

  it('removes the whole new batch if its owner is cancelled during publication', async () => {
    const { plugin, representationApi } = await fixture();
    let current = true;
    const subscription = plugin.state.data.events.changed.subscribe(() => {
      if (selectSurfaceOverlayCells(plugin).length) current = false;
    });
    try {
      const refs = await applySurfaceOverlayRenderPlan(
        plugin,
        { enabled: true, targetScope: 'broad' },
        {
          isCurrent: () => current,
          loadRepresentationApi: async () => representationApi,
        }
      );
      expect(refs).toEqual([]);
      expect(selectSurfaceOverlayCells(plugin)).toEqual([]);
    } finally {
      subscription.unsubscribe();
      plugin.dispose();
    }
  });
});
