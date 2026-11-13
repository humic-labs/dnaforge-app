import { Structure, StructureElement, Unit } from 'molstar/lib/mol-model/structure';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import type { Structure as MVSStructure } from 'molstar/lib/extensions/mvs/tree/mvs/mvs-builder';
import type {
  ComponentExpressionT as ComponentExpression,
  HexColorT,
} from 'molstar/lib/extensions/mvs/tree/mvs/param-types';
import type { MolstarLoadingExtension } from 'molstar/lib/extensions/mvs/load';
import { UpdateTarget } from 'molstar/lib/extensions/mvs/load-generic';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { formatMolScript } from 'molstar/lib/mol-script/language/expression-formatter';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra';
import type { MolstarPlugin } from './cache';
import { DISPLAY_GROUP_CONTRACT } from './molecularDisplayGroups';

const NATIVE_CAPTURE_CONTRACT = 'native-molecular-capture-v1';
const supportedColors = new Set([
  'uniform',
  'chain-id',
  'element-symbol',
  'residue-name',
  'secondary-structure',
  'molecule-type',
  'hydrophobicity',
  'occupancy',
  'uncertainty',
  'sequence-id',
  'entity-id',
  'polymer-id',
  'mvs-multilayer',
]);
const supportedRepresentations = {
  cartoon: 'cartoon',
  backbone: 'backbone',
  'ball-and-stick': 'ball_and_stick',
  line: 'line',
  spacefill: 'spacefill',
  carbohydrate: 'carbohydrate',
  'molecular-surface': 'surface',
  'gaussian-surface': 'surface',
} as const;

function unsupported(reason: string): never {
  throw Object.assign(new Error(`This native view cannot be saved exactly: ${reason}`), {
    code: 'MVS_NATIVE_CAPTURE_UNSUPPORTED',
  });
}

function json<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'function' || typeof entry === 'bigint' || typeof entry === 'symbol')
        unsupported('a native parameter is not portable.');
      if (typeof entry === 'number' && !Number.isFinite(entry))
        unsupported('a native parameter is not finite.');
      return ArrayBuffer.isView(entry) ? Array.from(entry as unknown as ArrayLike<number>) : entry;
    })
  ) as T;
}

function atomKey(unit: Unit.Atomic, atom: number): string {
  const instance = unit.conformation.operator.instanceId;
  if (!instance) unsupported('a coordinate instance has no stable instance ID.');
  return `${instance}\0${unit.model.atomicHierarchy.atomSourceIndex.value(atom)}`;
}

export function nativeMolecularSelector(
  selected: Structure,
  source: Structure
): ComponentExpression[] {
  const atoms = new Map<string, ComponentExpression>();
  const chains = new Map<string, { selector: ComponentExpression; atoms: Set<string> }>();
  const residues = new Map<string, { selector: ComponentExpression; atoms: Set<string> }>();
  const add = (map: typeof chains, key: string, selector: ComponentExpression, atom: string) => {
    const group = map.get(key) ?? { selector, atoms: new Set<string>() };
    group.atoms.add(atom);
    map.set(key, group);
  };
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit))
      unsupported('coarse coordinates are not supported by native capture.');
    const h = unit.model.atomicHierarchy;
    for (const atom of Array.from(unit.elements)) {
      const key = atomKey(unit, atom);
      const instance_id = unit.conformation.operator.instanceId!;
      const label_asym_id = h.chains.label_asym_id.value(unit.chainIndex[atom]);
      const residue_index = h.residueSourceIndex.value(unit.residueIndex[atom]);
      atoms.set(key, { atom_index: h.atomSourceIndex.value(atom), instance_id });
      add(chains, `${instance_id}\0${label_asym_id}`, { label_asym_id, instance_id }, key);
      add(residues, `${instance_id}\0${residue_index}`, { residue_index, instance_id }, key);
    }
  }
  const remaining = new Set<string>();
  for (const unit of selected.units) {
    if (!Unit.isAtomic(unit)) unsupported('a component uses coarse coordinates.');
    for (const atom of Array.from(unit.elements)) {
      const key = atomKey(unit, atom);
      if (!atoms.has(key))
        unsupported('a component is not bound to the captured coordinate source.');
      remaining.add(key);
    }
  }
  const result: ComponentExpression[] = [];
  for (const group of [...chains.values(), ...residues.values()]) {
    if (![...group.atoms].every((key) => remaining.has(key))) continue;
    result.push(group.selector);
    for (const key of group.atoms) remaining.delete(key);
  }
  for (const key of remaining) result.push(atoms.get(key)!);
  return result;
}

function validateColor(theme: { name?: string; params?: Record<string, unknown> }): void {
  if (!theme.name || !supportedColors.has(theme.name))
    unsupported(`color theme "${theme.name ?? 'unknown'}" has no exact native export.`);
  if (theme.name !== 'mvs-multilayer') return;
  const layers = theme.params?.layers;
  if (!Array.isArray(layers)) unsupported('the native layered color theme is incomplete.');
  for (const layer of layers) {
    if (
      !layer ||
      typeof layer !== 'object' ||
      !['static', 'expression'].includes(layer.selection?.name)
    )
      unsupported('the native color theme depends on an external annotation or transient bundle.');
    validateColor(layer.theme);
    if (/atom-property\.core\.(?:unit-id|model-id)/.test(JSON.stringify(layer.selection)))
      unsupported('the native color theme uses transient model or unit IDs.');
  }
}

type NativeState = {
  contract: typeof NATIVE_CAPTURE_CONTRACT;
  sizeTheme: { name: string; params: Record<string, unknown> };
  transparency: { selector: ComponentExpression[]; value: number }[];
  overpaint: { selector: ComponentExpression[]; color: number; clear: boolean }[];
  strength: {
    overpaintStrength: number;
    transparencyStrength: number;
    emissiveStrength: number;
    substanceStrength: number;
  };
};

export function appendNativeMolecularRepresentations(
  plugin: MolstarPlugin,
  target: MVSStructure
): void {
  const entries = plugin.managers.structure.hierarchy.current.structures;
  if (entries.length !== 1)
    unsupported('several independently loaded structures require an authored comparison.');
  const entry = entries[0];
  const source = entry.transform?.cell.obj?.data ?? entry.cell.obj?.data;
  if (!source || source.models.length !== 1)
    unsupported('the native view must use one exact model.');
  for (const cell of plugin.state.data.cells.values())
    if (
      cell.obj &&
      (PluginStateObject.Shape.Representation3D.is(cell.obj) ||
        PluginStateObject.Volume.Representation3D.is(cell.obj))
    )
      unsupported('the native view contains an independent shape or volume.');
  let count = 0;
  for (const component of entry.components) {
    const selected = component.cell.obj?.data;
    if (!selected?.elementCount) continue;
    const selector = nativeMolecularSelector(selected, source);
    const label =
      String(component.cell.obj?.label ?? 'Molecular component')
        .trim()
        .slice(0, 80) || 'Molecular component';
    const componentTarget = target.component({ selector });
    for (const ref of component.representations) {
      const native = ref.cell.obj?.data.repr;
      const params = ref.cell.params?.values;
      const type = params?.type?.name;
      if (!native || !type) unsupported('a molecular representation is not ready.');
      if (!(type in supportedRepresentations))
        unsupported(`representation "${type}" has no exact native export.`);
      if (native.state.transform && !Mat4.isIdentity(native.state.transform))
        unsupported('a representation has an independent spatial transform.');
      if (native.state.unitTransforms) unsupported('a representation has per-unit transforms.');
      for (const effect of ['substance', 'clipping', 'emissive'] as const)
        if (native.state[effect]?.layers.length)
          unsupported(`native ${effect} layers are not supported.`);
      if (
        !params?.sizeTheme ||
        !['uniform', 'physical', 'uncertainty'].includes(params.sizeTheme.name)
      )
        unsupported('the native size theme is not portable.');
      validateColor(params.colorTheme);
      const props = json({ ...params.type.params, ...native.props });
      const alpha = Number(props.alpha ?? 1) * Number(native.state.alphaFactor ?? 1);
      if (!Number.isFinite(alpha)) unsupported('native opacity is invalid.');
      props.alpha = alpha;
      const hidden =
        entry.cell.state?.isHidden ||
        component.cell.state?.isHidden ||
        ref.cell.state?.isHidden ||
        native.state.visible === false;
      if (
        !hidden &&
        alpha > 0 &&
        ['ball-and-stick', 'spacefill', 'line', 'molecular-surface', 'gaussian-surface'].includes(
          type
        ) &&
        !(props.ignoreHydrogens === true && (props.ignoreHydrogensVariant ?? 'all') === 'all') &&
        selected.units.some(
          (unit) =>
            Unit.isAtomic(unit) &&
            Array.from(unit.elements).some((atom) =>
              ['H', 'D', 'T'].includes(unit.model.atomicHierarchy.atoms.type_symbol.value(atom))
            )
        )
      )
        unsupported('visible hydrogens would be changed by the saved-scene hydrogen policy.');
      const toSelector = (loci: unknown) => {
        if (!StructureElement.Loci.is(loci))
          unsupported('a native effect uses non-molecular geometry.');
        return nativeMolecularSelector(StructureElement.Loci.toStructure(loci), source);
      };
      const state: NativeState = {
        contract: NATIVE_CAPTURE_CONTRACT,
        sizeTheme: json(params.sizeTheme),
        transparency: (native.state.transparency?.layers ?? []).map((layer) => ({
          selector: toSelector(layer.loci),
          value: layer.value,
        })),
        overpaint: (native.state.overpaint?.layers ?? []).map((layer) => ({
          selector: toSelector(layer.loci),
          color: layer.color,
          clear: layer.clear,
        })),
        strength: {
          overpaintStrength: native.state.themeStrength?.overpaint ?? 1,
          transparencyStrength: native.state.themeStrength?.transparency ?? 1,
          emissiveStrength: 1,
          substanceStrength: 1,
        },
      };
      const first = selected.units.find(Unit.isAtomic);
      let color = params.colorTheme.params?.value;
      if (!Number.isInteger(color) && first && 'color' in native.theme.color)
        color = native.theme.color.color(
          StructureElement.Location.create(selected, first, first.elements[0]),
          false
        );
      if (!Number.isInteger(color) || color < 0 || color > 0xffffff)
        unsupported('the native color palette cannot be described exactly.');
      const swatch: HexColorT = `#${color.toString(16).padStart(6, '0')}`;
      const id = `native:${ref.cell.transform.ref}`;
      componentTarget
        .representation({
          type: supportedRepresentations[type as keyof typeof supportedRepresentations],
          ...(type === 'molecular-surface' ? { surface_type: 'molecular' as const } : {}),
          ...(type === 'gaussian-surface' ? { surface_type: 'gaussian' as const } : {}),
          size_factor:
            params.sizeTheme.name === 'uniform'
              ? Number(params.sizeTheme.params.value ?? 1)
              : Number(params.sizeTheme.params.scale ?? 1),
          custom: {
            dnaforge_render_profile: 'native',
            molstar_representation_params: props,
            dnaforge_native_capture: state,
            ...(hidden ? { is_hidden: true } : {}),
            dnaforge_display_group: { id, label, color: swatch, residual: false },
          },
        })
        .color({
          color: swatch,
          custom: {
            molstar_color_theme_name: params.colorTheme.name,
            molstar_color_theme_params: json(params.colorTheme.params),
            dnaforge_legend_label: label,
            dnaforge_selection_id: id,
          },
        });
      count++;
    }
  }
  if (!count) unsupported('there are no ready molecular representations to capture.');
}

export const MolecularNativeCaptureExtension: MolstarLoadingExtension<undefined> = {
  id: 'dnaforge/native-molecular-capture',
  description: 'Replay the native size theme and molecular masks retained by a raw-view save.',
  createExtensionContext: () => undefined,
  action: (target, node) => {
    if (node.kind !== 'representation' || node.custom?.dnaforge_native_capture === undefined)
      return;
    const state = node.custom.dnaforge_native_capture as NativeState;
    if (
      state.contract !== NATIVE_CAPTURE_CONTRACT ||
      !['uniform', 'physical', 'uncertainty'].includes(state.sizeTheme?.name)
    )
      unsupported('the saved native representation contract is invalid.');
    target.update
      .to(target.selector)
      .update({ ...target.transformParams, sizeTheme: state.sizeTheme });
    const script = (selector: ComponentExpression[]) => {
      const selection = componentPropsFromSelector(selector);
      if (selection.name !== 'expression')
        unsupported('a saved native mask has no exact molecular selector.');
      return { language: 'mol-script' as const, expression: formatMolScript(selection.params) };
    };
    if (state.transparency.length)
      UpdateTarget.apply(
        target,
        StateTransforms.Representation.TransparencyStructureRepresentation3DFromScript,
        {
          layers: state.transparency.map((layer) => ({
            script: script(layer.selector),
            value: layer.value,
          })),
        }
      );
    if (state.overpaint.length)
      UpdateTarget.apply(
        target,
        StateTransforms.Representation.OverpaintStructureRepresentation3DFromScript,
        {
          layers: state.overpaint.map((layer) => ({
            script: script(layer.selector),
            color: layer.color as never,
            clear: layer.clear,
          })),
        }
      );
    if (state.transparency.length || state.overpaint.length)
      UpdateTarget.apply(
        target,
        StateTransforms.Representation.ThemeStrengthRepresentation3D,
        state.strength
      );
  },
};

export const NATIVE_CAPTURE_ROOT_CUSTOM = {
  dnaforge_render_profile: 'native',
  dnaforge_native_capture: NATIVE_CAPTURE_CONTRACT,
  dnaforge_display_group_contract: DISPLAY_GROUP_CONTRACT,
};
