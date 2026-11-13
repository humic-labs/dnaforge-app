import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import type { MolstarLoadingExtension } from 'molstar/lib/extensions/mvs/load';
import { Unit } from 'molstar/lib/mol-model/structure';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { ComponentSelectorT } from 'molstar/lib/extensions/mvs/tree/mvs/param-types';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import type { MolstarPlugin } from './cache';
import { MolViewSpecSceneError } from './molViewSpecError';
import type { StructureCoordinateModelSelection } from '../types';

const representationTypes = {
  cartoon: 'cartoon',
  backbone: 'backbone',
  'ball-and-stick': 'ball_and_stick',
  line: 'line',
  spacefill: 'spacefill',
  carbohydrate: 'carbohydrate',
  'molecular-surface': 'surface',
  'gaussian-surface': 'surface',
} as const;

export function captureNativeMolViewSpec(
  plugin: MolstarPlugin,
  resource: { name: string; format: 'pdb' | 'mmcif' | 'bcif' },
  coordinateModel?: StructureCoordinateModelSelection
) {
  const structures = plugin.managers.structure.hierarchy.current.structures;
  if (structures.length !== 1)
    throw new MolViewSpecSceneError(
      'DATA_NATIVE_VIEW_UNSUPPORTED',
      'This native view must contain one coordinate structure before its appearance can be saved.'
    );
  const native = structures[0];
  const builder = MVSData.createBuilder();
  const parsed = builder.download({ url: resource.name }).parse({ format: resource.format });
  const model = {
    model_index: coordinateModel?.modelIndex ?? 0,
    block_index: coordinateModel?.blockIndex ?? 0,
  };
  const nativeType = native.cell.params?.values.type;
  if (nativeType && !['model', 'assembly', 'auto'].includes(nativeType.name))
    throw new MolViewSpecSceneError(
      'DATA_NATIVE_VIEW_UNSUPPORTED',
      'This native symmetry view requires an explicit scene before data coloring.'
    );
  const assemblyId =
    nativeType?.name === 'assembly'
      ? nativeType.params.id
      : native.cell.obj?.data.units[0]?.conformation.operator.assembly?.id;
  const structure = assemblyId
    ? parsed.assemblyStructure({ ...model, assembly_id: assemblyId })
    : parsed.modelStructure(model);
  const nativeRefs = new Map<string, string>();
  let componentIndex = 0;
  for (const component of native.components) {
    if (!component.representations.length) continue;
    const data = component.cell.obj?.data;
    if (!data)
      throw new MolViewSpecSceneError('VIEW_CHANGED', 'A native component is unavailable.');
    const selectors: Array<{ atom_index: number; instance_id: string }> = [];
    for (const unit of data.units) {
      if (!Unit.isAtomic(unit))
        throw new MolViewSpecSceneError(
          'DATA_NATIVE_VIEW_UNSUPPORTED',
          'Coarse native geometry requires an explicit scene before data coloring.'
        );
      for (let index = 0; index < OrderedSet.size(unit.elements); index++)
        selectors.push({
          atom_index: unit.model.atomicHierarchy.atomSourceIndex.value(
            OrderedSet.getAt(unit.elements, index)
          ),
          instance_id: unit.conformation.operator.instanceId,
        });
    }
    if (!selectors.length) continue;
    const nativeSelection = component.cell.params?.values.type;
    const exported = structure.component({
      selector:
        nativeSelection?.name === 'static' && ComponentSelectorT.is(nativeSelection.params)
          ? nativeSelection.params
          : selectors,
      custom: {
        is_hidden: component.cell.state.isHidden ?? false,
        dnaforge_legend_label: component.cell.obj?.label,
      },
    });
    for (const [index, representation] of component.representations.entries()) {
      const values = representation.cell.params?.values;
      const type = values?.type.name;
      if (!values || !type || !(type in representationTypes))
        throw new MolViewSpecSceneError(
          'DATA_NATIVE_VIEW_UNSUPPORTED',
          `The native ${type ?? 'unknown'} representation cannot be saved faithfully as a molecular scene.`
        );
      const ref = `dnaforge:native-representation:${componentIndex}:${index}`;
      const node = exported.representation({
        type: representationTypes[type as keyof typeof representationTypes],
        ...(type.endsWith('surface')
          ? {
              surface_type:
                type === 'gaussian-surface' ? ('gaussian' as const) : ('molecular' as const),
            }
          : {}),
        ref,
        custom: {
          molstar_representation_params: structuredClone(values.type.params),
          dnaforge_size_theme: structuredClone(values.sizeTheme),
          dnaforge_render_profile: 'native',
          is_hidden: representation.cell.state.isHidden ?? false,
        },
      });
      node.color({
        color: '#909090',
        custom: {
          molstar_color_theme_name: values.colorTheme.name,
          molstar_color_theme_params: structuredClone(values.colorTheme.params),
        },
      });
      node.opacity({ opacity: values.type.params.alpha ?? 1 });
      nativeRefs.set(ref, representation.cell.transform.ref);
    }
    componentIndex++;
  }
  if (!nativeRefs.size)
    throw new MolViewSpecSceneError(
      'DATA_REPRESENTATION_REQUIRED',
      'No loaded representation is available.'
    );
  const document = builder.getState();
  const scene = MVSData.toMVSJ(document);
  if (scene.length > 500_000)
    throw new MolViewSpecSceneError(
      'DATA_SCENE_TOO_LARGE',
      'The current native geometry exceeds the saved scene size limit. Choose a smaller molecular selection.'
    );
  return { document, scene, nativeRefs };
}

export const nativeSizeThemeExtension: MolstarLoadingExtension<Record<string, never>> = {
  id: 'dnaforge/native-size-theme',
  description: 'Restore the size theme retained in a native molecular view.',
  createExtensionContext: () => ({}),
  action: (target, node) => {
    if (node.kind !== 'representation' || !node.custom?.dnaforge_size_theme) return;
    const theme = node.custom.dnaforge_size_theme as { name?: unknown; params?: unknown };
    if (
      typeof theme.name !== 'string' ||
      !theme.params ||
      typeof theme.params !== 'object' ||
      Array.isArray(theme.params)
    )
      throw new MolViewSpecSceneError(
        'MVS_INVALID_SCENE',
        'The captured native size theme is invalid.'
      );
    const sizeTheme = { name: theme.name, params: theme.params as Record<string, unknown> };
    target.update
      .to(target.selector)
      .update(StateTransforms.Representation.StructureRepresentation3D, (params) => ({
        ...params,
        sizeTheme,
      }));
  },
};
