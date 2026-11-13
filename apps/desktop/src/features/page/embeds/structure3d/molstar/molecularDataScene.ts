import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import type { Structure } from 'molstar/lib/mol-model/structure';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import type { MolstarPlugin } from './cache';
import type { MolecularDataMapping, MolecularDataSelector } from '../utils/molecularData';
import { MolViewSpecSceneError } from './molViewSpecError';
import { visibleStructureAtomKeys } from './structureColors';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { displayGroupSchema, resolveMolecularDisplayGroups } from './molecularDisplayGroups';
import { molecularSceneSelections } from './molecularSceneSelections';
import { resolveMolViewSpecStructureRef } from './molViewSpecStructureIdentity';

type ColorRow = { row: number; selector: MolecularDataSelector; color: string };
type Node = {
  kind: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: Node[];
};

export function molecularDataSceneForPlugin(
  plugin: MolstarPlugin,
  baseScene: string,
  colors: readonly ColorRow[],
  currentScene: string,
  background?: { selector: MolecularDataSelector; color: string }
): string {
  return MVSData.toMVSJ(
    resolveMolecularDisplayGroups(
      MVSData.fromMVSJ(molecularDataScene(baseScene, colors, currentScene, background)),
      undefined,
      (structure) =>
        structure.ref
          ? molecularSceneSelections(resolveMolViewSpecStructureRef(plugin, structure.ref))
          : undefined
    )
  );
}

export function molecularDataScene(
  baseScene: string,
  colors: readonly ColorRow[],
  currentScene?: string,
  background?: { selector: MolecularDataSelector; color: string }
): string {
  const document = JSON.parse(baseScene) as { kind?: string; root?: Node };
  if (document.kind === 'multiple' || !document.root)
    throw new MolViewSpecSceneError(
      'DATA_SINGLE_VIEW_REQUIRED',
      'Data layers currently require an authored single view. Choose a single view before applying data.'
    );
  const grouped = new Map<string, MolecularDataSelector[]>();
  for (const row of colors) {
    const group = grouped.get(row.color) ?? [];
    group.push(row.selector);
    grouped.set(row.color, group);
  }
  let count = 0;
  const visit = (node: Node) => {
    if (node.kind === 'representation') {
      count++;
      const designation = displayGroupSchema.safeParse(node.custom?.dnaforge_display_group);
      node.children = [
        ...(node.children ?? []),
        ...(background ? [{ kind: 'color', params: background }] : []),
        ...Array.from(grouped, ([color, selectors]) => ({
          kind: 'color',
          params: {
            color,
            selector: selectors.flatMap((selector) =>
              Array.isArray(selector) ? selector : [selector]
            ),
          },
          custom: {
            dnaforge_display_group_role: 'data',
            ...(designation.success
              ? { dnaforge_legend_label: designation.data.label, dnaforge_legend_generated: true }
              : { dnaforge_molecular_data_color: true }),
          },
        })),
      ];
    } else node.children?.forEach(visit);
  };
  visit(document.root);
  if (!count)
    throw new MolViewSpecSceneError(
      'DATA_REPRESENTATION_REQUIRED',
      'The authored scene has no molecular representation to color.'
    );
  if (currentScene) {
    const current = JSON.parse(currentScene) as { kind?: string; root?: Node };
    if (current.kind === 'multiple' || !current.root)
      throw new MolViewSpecSceneError(
        'DATA_SINGLE_VIEW_REQUIRED',
        'Data layers currently require an authored single view.'
      );
    const geometry = (document.root.children ?? []).filter((node) => node.kind !== 'camera');
    const currentChildren = current.root.children ?? [];
    if (geometry.length !== currentChildren.filter((node) => node.kind !== 'camera').length)
      throw new MolViewSpecSceneError(
        'DATA_BASE_SCENE_CHANGED',
        'The authored geometry changed. Choose a data view based on the current scene.'
      );
    let index = 0;
    document.root.children = currentChildren.map((node) =>
      node.kind === 'camera' ? node : geometry[index++]
    );
  }
  const scene = JSON.stringify(document);
  if (scene.length > 500_000)
    throw new MolViewSpecSceneError(
      'DATA_SCENE_TOO_LARGE',
      'This mapped view exceeds the current 500 KB scene limit. Publish a smaller selection or fewer distinct colors.'
    );
  return scene;
}

type ResolvedTarget = { row: number; elements: string[] };
type CachedMapping = { structures: Structure[]; targets: ResolvedTarget[] };
const mappings = new WeakMap<MolstarPlugin, Map<string, CachedMapping>>();

export function resolveMolecularDataMapping(plugin: MolstarPlugin, mapping: MolecularDataMapping) {
  const structures = plugin.managers.structure.hierarchy.current.structures.map(
    (item) => item.cell.obj!.data
  );
  if (!structures.length)
    throw new MolViewSpecSceneError(
      'PLUGIN_NOT_READY',
      'The molecular coordinates are not loaded.'
    );
  let cache = mappings.get(plugin);
  if (!cache) {
    cache = new Map();
    mappings.set(plugin, cache);
  }
  let resolved = cache.get(mapping.revision);
  if (
    !resolved ||
    resolved.structures.length !== structures.length ||
    resolved.structures.some((structure, index) => structure !== structures[index])
  ) {
    resolved = {
      structures,
      targets: mapping.targets.map((target) => {
        const elements = new Set<string>();
        structures.forEach((structure, index) => {
          const selection = substructureFromSelector(
            structure,
            componentPropsFromSelector(target.selector)
          );
          for (const unit of selection.units)
            for (let atom = 0; atom < OrderedSet.size(unit.elements); atom++)
              elements.add(`${index}:${unit.id}:${OrderedSet.getAt(unit.elements, atom)}`);
        });
        return { row: target.row, elements: [...elements] };
      }),
    };
    if (cache.size >= 40) cache.delete(cache.keys().next().value!);
    cache.set(mapping.revision, resolved);
  }
  const mappedRows = new Set(
    resolved.targets.filter((target) => target.elements.length).map((target) => target.row)
  );
  const missingRows = new Set(
    resolved.targets
      .filter((target) => !target.elements.length && !mappedRows.has(target.row))
      .map((target) => target.row)
  );
  return {
    targets: resolved.targets,
    mappedRows: [...mappedRows],
    unresolved: [
      ...mapping.unresolved,
      ...[...missingRows].map((row) => ({
        row,
        reason: 'The declared target has no coordinates in this loaded model.',
      })),
    ],
  };
}

export function requireDisjointMolecularDataRows(
  resolved: ReturnType<typeof resolveMolecularDataMapping>,
  rows: readonly ColorRow[]
): void {
  const activeRows = new Set(rows.map((row) => row.row));
  const owners = new Map<string, number>();
  for (const target of resolved.targets) {
    if (!activeRows.has(target.row)) continue;
    for (const element of target.elements) {
      const owner = owners.get(element);
      if (owner !== undefined && owner !== target.row)
        throw new MolViewSpecSceneError(
          'DATA_OVERLAPPING_OBSERVATIONS',
          `Data rows ${owner + 1} and ${target.row + 1} overlap the same atoms. Select a condition/replicate or publish an explicitly aggregated result.`
        );
      owners.set(element, target.row);
    }
  }
}

export function molecularDataVisibility(
  plugin: MolstarPlugin,
  resolved: ReturnType<typeof resolveMolecularDataMapping>,
  colors: readonly ColorRow[]
) {
  const visible = visibleStructureAtomKeys(plugin);
  const activeRows = new Set(colors.map((color) => color.row));
  const renderedRows = new Set(
    resolved.targets
      .filter(
        (target) =>
          activeRows.has(target.row) && target.elements.some((element) => visible.has(element))
      )
      .map((target) => target.row)
  );
  return {
    renderedRows: [...renderedRows],
    unrenderedRows: resolved.mappedRows.filter(
      (row) => activeRows.has(row) && !renderedRows.has(row)
    ),
  };
}
