import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { MolstarLoadingContext } from 'molstar/lib/extensions/mvs/load';
import {
  alphaForNode,
  collectAnnotationReferences,
  colorThemeForNode,
} from 'molstar/lib/extensions/mvs/load-helpers';
import { convertMvsToMolstar } from 'molstar/lib/extensions/mvs/tree/molstar/conversion';
import type { MolstarSubtree } from 'molstar/lib/extensions/mvs/tree/molstar/molstar-tree';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { PluginStateObject } from 'molstar/lib/mol-plugin-state/objects';
import type { MolstarPlugin } from './cache';
import { MolViewSpecSceneError } from './molViewSpecError';
import { assignMolViewSpecStructureRefs } from './molViewSpecStructureIdentity';

type Node = {
  kind: string;
  ref?: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: Node[];
};

function walk(node: Node, visit: (node: Node, path: string) => void, path = 'root'): void {
  visit(node, path);
  node.children?.forEach((child, index) => walk(child, visit, `${path}/${index}`));
}

export function bindMolViewSpecRepresentations(document: MVSData): {
  document: MVSData;
  refs: Map<string, string>;
} {
  const copy = structuredClone(document);
  const states = copy.kind === 'multiple' ? copy.snapshots : [copy];
  const refs = new Map<string, string>();
  const occupied = new Set<string>();
  for (const state of states) walk(state.root, (node) => node.ref && occupied.add(node.ref));
  states.forEach((state, step) => {
    walk(state.root, (node, path) => {
      if (node.kind !== 'representation') return;
      if (!node.ref) {
        const base = `dnaforge:representation:${step}:${path}`;
        let ref = base;
        while (occupied.has(ref)) ref += ':';
        node.ref = ref;
        occupied.add(ref);
      }
      refs.set(`${step}:${path}`, node.ref);
    });
  });
  return { document: copy, refs };
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, normalize(value)])
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}

const localAppearanceKinds = new Set(['color', 'opacity']);
function geometry(node: Node): Node {
  const { custom, ...content } = node;
  const retained = Object.fromEntries(
    Object.entries(custom ?? {}).filter(
      ([key]) =>
        !(node.kind === 'root' && key === 'dnaforge_display_group_contract') &&
        !(node.kind === 'representation' && key === 'dnaforge_display_group')
    )
  );
  return {
    ...content,
    ...(Object.keys(retained).length ? { custom: retained } : {}),
    ...(node.children
      ? {
          children: node.children
            .filter(
              (child) => node.kind !== 'representation' || !localAppearanceKinds.has(child.kind)
            )
            .map(geometry),
        }
      : {}),
  };
}

export function isMolViewSpecAppearanceUpdate(previous: MVSData, next: MVSData): boolean {
  if (previous.kind === 'multiple' || next.kind === 'multiple') return false;
  const baseline = structuredClone(previous);
  const proposed = structuredClone(next);
  assignMolViewSpecStructureRefs(baseline);
  assignMolViewSpecStructureRefs(proposed);
  return canonical(geometry(baseline.root)) === canonical(geometry(proposed.root));
}

export async function updateMolViewSpecAppearance(
  plugin: MolstarPlugin,
  previous: MVSData,
  next: MVSData,
  refs: ReadonlyMap<string, string>,
  sourceUrl: string,
  isCurrent: () => boolean,
  nativeRefs?: ReadonlyMap<string, string>
): Promise<boolean> {
  if (!isMolViewSpecAppearanceUpdate(previous, next)) return false;
  if (previous.kind === 'multiple' || next.kind === 'multiple') return false;
  const bound = bindMolViewSpecRepresentations(next);
  if (bound.document.kind === 'multiple') return false;
  const converted = convertMvsToMolstar(bound.document.root, sourceUrl);
  const context = MolstarLoadingContext.create();
  collectAnnotationReferences(converted, context);
  const representations = new Map<string, MolstarSubtree<'representation'>>();
  walk(converted, (node) => {
    if (node.kind === 'representation' && node.ref)
      representations.set(node.ref, node as MolstarSubtree<'representation'>);
  });
  const oldNodes = new Map<string, Node>();
  walk(previous.root, (node, path) => {
    if (node.kind === 'representation') oldNodes.set(`0:${path}`, node);
  });
  const patches: Array<{
    ref: string;
    node: MolstarSubtree<'representation'>;
  }> = [];
  let bindingsComplete = true;
  walk(next.root, (node, path) => {
    if (node.kind !== 'representation') return;
    const key = `0:${path}`;
    const nativeTag = refs.get(key);
    const compiled = representations.get(bound.refs.get(key) ?? '');
    if (!nativeTag || !compiled) {
      bindingsComplete = false;
      return;
    }
    const cells = [...plugin.state.data.cells.values()].filter(
      (cell) =>
        (nativeRefs
          ? cell.transform.ref === nativeRefs.get(nativeTag)
          : cell.transform.tags?.includes(`mvs-ref:${nativeTag}`)) &&
        PluginStateObject.Molecule.Structure.Representation3D.is(cell.obj)
    );
    if (!cells.length) {
      bindingsComplete = false;
      return;
    }
    if (canonical(oldNodes.get(key)) !== canonical(node))
      for (const cell of cells) patches.push({ ref: cell.transform.ref, node: compiled });
  });
  if (!isCurrent())
    throw new MolViewSpecSceneError(
      'VIEW_CHANGED',
      'The structure view changed before its appearance update.'
    );
  if (!bindingsComplete) return false;
  if (!patches.length) return true;

  const update = plugin.build();
  const inverse: Array<(builder: typeof update) => void> = [];
  for (const patch of patches) {
    const colorTheme = colorThemeForNode(patch.node, context);
    const alpha = alphaForNode(patch.node);
    update
      .to(patch.ref)
      .update(StateTransforms.Representation.StructureRepresentation3D, (params) => {
        inverse.push((builder) =>
          builder
            .to(patch.ref)
            .update(StateTransforms.Representation.StructureRepresentation3D, () => params)
        );
        return {
          ...params,
          colorTheme,
          type: { ...params.type, params: { ...params.type.params, alpha } },
        };
      });
  }
  const restore = async () => {
    try {
      const rollback = plugin.build();
      inverse.forEach((operation) => operation(rollback));
      await rollback.commit({ revertOnError: true });
      if (
        patches.some(
          (patch) =>
            !plugin.state.data.cells.get(patch.ref) ||
            plugin.state.data.cells.get(patch.ref)?.status === 'error'
        )
      )
        throw new Error('The original representation is unavailable.');
    } catch {
      throw new MolViewSpecSceneError(
        'MVS_APPEARANCE_ROLLBACK_FAILED',
        'The appearance update failed and its prior native state could not be restored. Inspect the view before continuing.',
        'unknown'
      );
    }
  };
  try {
    await update.commit({ revertOnError: true });
  } catch (error) {
    await restore();
    throw error;
  }
  if (!isCurrent()) {
    await restore();
    throw new MolViewSpecSceneError(
      'VIEW_CHANGED',
      'The structure view changed during its appearance update. Its prior appearance was restored.'
    );
  }
  const failed = patches.find(
    (patch) => plugin.state.data.cells.get(patch.ref)?.status === 'error'
  );
  if (failed) {
    await restore();
    throw new MolViewSpecSceneError(
      'MVS_APPEARANCE_FAILED',
      'The molecular appearance update could not render. Its prior appearance was restored.'
    );
  }

  const entry = plugin.managers.snapshot.current;
  if (entry)
    plugin.managers.snapshot.replace(
      entry.snapshot.id,
      { ...entry.snapshot, data: plugin.state.data.getSnapshot() },
      entry
    );
  plugin.canvas3d?.requestDraw();
  return true;
}
