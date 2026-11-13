import { MolViewSpecSceneError } from '../molstar/molViewSpecError';

export function molViewSpecStorySteps(
  scene: string | undefined
): { index: number; title: string; description?: string; id?: string }[] {
  if (!scene) return [];
  try {
    const document = JSON.parse(scene) as {
      kind?: string;
      snapshots?: { metadata?: { title?: unknown; description?: unknown; key?: unknown } }[];
    };
    if (document.kind !== 'multiple' || !Array.isArray(document.snapshots)) return [];
    return document.snapshots.map((snapshot, index) => ({
      index,
      ...(typeof snapshot.metadata?.key === 'string' && snapshot.metadata.key.trim()
        ? { id: snapshot.metadata.key }
        : {}),
      title:
        typeof snapshot.metadata?.title === 'string' && snapshot.metadata.title.trim()
          ? snapshot.metadata.title
          : `View ${index + 1}`,
      ...(typeof snapshot.metadata?.description === 'string' && snapshot.metadata.description.trim()
        ? { description: snapshot.metadata.description }
        : {}),
    }));
  } catch {
    return [];
  }
}

export function ensureMolViewSpecViewIds(scene: string): string {
  const document = JSON.parse(scene);
  const views = document.kind === 'multiple' ? document.snapshots : [document];
  if (!Array.isArray(views) || !views.length)
    throw new Error('A molecular scene requires at least one view.');
  const ids = new Set<string>();
  let changed = false;
  for (const view of views) {
    if (!view || typeof view !== 'object' || !view.root)
      throw new Error('A molecular view requires its scene root.');
    const key = view.metadata?.key;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 1000))
      throw new Error('A molecular view identity must be a nonempty string.');
    const id = key ?? `view:${crypto.randomUUID()}`;
    if (ids.has(id)) throw new Error('Molecular view identities must be unique.');
    ids.add(id);
    if (key === undefined) {
      view.metadata = { ...view.metadata, key: id };
      changed = true;
    }
  }
  return changed ? JSON.stringify(document) : scene;
}

type SelectionNode = {
  kind?: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: SelectionNode[];
};

function preserveNamedSelectionIds(root: unknown, previous?: unknown): void {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, stable(child)])
          )
        : value;
  const colors = (tree: unknown) => {
    const found: { node: SelectionNode; target: string; group: string }[] = [];
    const visit = (node: SelectionNode, context: Record<string, unknown> = {}) => {
      const scope = { ...context };
      if (node.kind === 'download') scope.resource = node.params?.url;
      if (node.kind === 'parse') scope.parse = node.params;
      if (node.kind === 'structure') scope.structure = node.params;
      if (node.kind === 'transform')
        scope.transforms = [...((scope.transforms as unknown[]) ?? []), node.params];
      if (node.kind === 'component') scope.component = node.params?.selector ?? 'all';
      const label = node.custom?.dnaforge_legend_label;
      if (node.kind === 'color' && typeof label === 'string' && label.trim()) {
        found.push({
          node,
          target: JSON.stringify(stable([scope, node.params?.selector ?? 'all'])),
          group: JSON.stringify([
            node.custom?.dnaforge_display_group_id ?? label,
            node.custom?.dnaforge_binding_scope,
            node.params?.color,
          ]),
        });
      }
      for (const child of node.children ?? []) visit(child, scope);
    };
    if (tree && typeof tree === 'object') visit(tree as SelectionNode);
    return found;
  };
  const previousIds = new Map<string, Set<string>>();
  for (const color of colors(previous)) {
    const id = color.node.custom?.dnaforge_selection_id;
    if (typeof id !== 'string' || !id) continue;
    const ids = previousIds.get(color.target) ?? new Set<string>();
    ids.add(id);
    previousIds.set(color.target, ids);
  }
  const groups = new Map<string, string>();
  const retained = new Map<SelectionNode, string>();
  const next = colors(root);
  for (const color of next) {
    const existing = color.node.custom?.dnaforge_selection_id;
    const previous = previousIds.get(color.target);
    const id =
      previous?.size === 1
        ? [...previous][0]
        : typeof existing === 'string' && existing
          ? existing
          : undefined;
    if (id) {
      groups.set(color.group, id);
      retained.set(color.node, id);
    }
  }
  for (const color of next) {
    const id =
      retained.get(color.node) ?? groups.get(color.group) ?? `selection:${crypto.randomUUID()}`;
    groups.set(color.group, id);
    color.node.custom = { ...color.node.custom, dnaforge_selection_id: id };
  }
}

function identifyNamedSelections(scene: string): string {
  const document = JSON.parse(scene);
  const views = document.kind === 'multiple' ? document.snapshots : [document];
  for (const view of views) preserveNamedSelectionIds(view.root);
  return JSON.stringify(document);
}

export type MolViewSpecViewAction = 'edit-current' | 'add' | 'replace';

export function preserveEquivalentGeneratedLegendEntries(
  current: string,
  proposed: string
): string {
  type View = { root?: unknown };
  type Scene = View & { kind?: string; snapshots?: View[] };
  const before = JSON.parse(current) as Scene;
  const after = JSON.parse(proposed) as Scene;
  const oldViews = before.kind === 'multiple' ? (before.snapshots ?? []) : [before];
  const nextViews = after.kind === 'multiple' ? (after.snapshots ?? []) : [after];
  if (oldViews.length !== nextViews.length) return proposed;
  const physical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(physical);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key]) =>
              ![
                'dnaforge_selection_id',
                'dnaforge_legend_generated',
                'dnaforge_legend_label',
              ].includes(key)
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, physical(child)])
      );
    return value;
  };
  let retained = false;
  for (const [index, view] of nextViews.entries()) {
    if (JSON.stringify(physical(view.root)) !== JSON.stringify(physical(oldViews[index].root)))
      continue;
    view.root = structuredClone(oldViews[index].root);
    retained = true;
  }
  return retained ? JSON.stringify(after) : proposed;
}

function resolveViewAction(
  current: string,
  proposed: string,
  action: MolViewSpecViewAction | undefined
): MolViewSpecViewAction {
  if (action) return action;
  if (!current || JSON.parse(current).kind !== 'multiple') return 'replace';
  if (JSON.parse(proposed).kind === 'multiple')
    throw new Error(
      'Replacing an existing multi-view scene requires explicit viewAction:"replace".'
    );
  return 'edit-current';
}

export function editMolViewSpecPresentation(
  current: string,
  proposed: string,
  action: MolViewSpecViewAction | undefined,
  activeIndex: number
): { scene: string; activeIndex: number; action: MolViewSpecViewAction } {
  type Snapshot = { root: unknown; metadata?: Record<string, unknown> };
  type Document = {
    kind?: string;
    root?: unknown;
    metadata?: Record<string, unknown>;
    snapshots?: Snapshot[];
  };
  let next: Document;
  try {
    next = JSON.parse(proposed) as Document;
  } catch {
    throw new MolViewSpecSceneError('MVS_INVALID_SCENE', 'The molecular scene is not valid JSON.');
  }
  action = resolveViewAction(current, proposed, action);
  if (action === 'replace')
    return {
      scene: identifyNamedSelections(ensureMolViewSpecViewIds(proposed)),
      activeIndex: 0,
      action,
    };
  const before = JSON.parse(current) as Document;
  if (next.kind === 'multiple' || !next.root)
    throw Error('An edit or addition requires one single named view.');
  const snapshots =
    before.kind === 'multiple'
      ? [...(before.snapshots ?? [])]
      : [
          {
            root: before.root,
            metadata: { ...before.metadata, title: before.metadata?.title ?? 'Structure overview' },
          },
        ];
  if (!snapshots.length || activeIndex < 0 || activeIndex >= snapshots.length)
    throw Error('The active presentation view is unavailable.');
  const replacement: Snapshot = {
    root: next.root,
    metadata: {
      ...next.metadata,
      key:
        action === 'edit-current'
          ? (snapshots[activeIndex].metadata?.key ?? `view:${crypto.randomUUID()}`)
          : `view:${crypto.randomUUID()}`,
      title:
        next.metadata?.title ??
        (action === 'edit-current' ? snapshots[activeIndex].metadata?.title : undefined),
    },
  };
  preserveNamedSelectionIds(
    replacement.root,
    action === 'edit-current' ? snapshots[activeIndex].root : undefined
  );
  if (action === 'add') snapshots.push(replacement);
  else snapshots[activeIndex] = replacement;
  if (before.kind !== 'multiple' && action === 'edit-current')
    return {
      scene: JSON.stringify({ ...next, metadata: { ...next.metadata, ...replacement.metadata } }),
      activeIndex: 0,
      action,
    };
  const { root: _root, ...rest } = before;
  return {
    scene: JSON.stringify({ ...rest, kind: 'multiple', snapshots }),
    activeIndex: action === 'add' ? snapshots.length - 1 : activeIndex,
    action,
  };
}

export function preserveUneditedMolViewSpecSnapshots(
  current: string,
  compiled: string,
  action: MolViewSpecViewAction | undefined,
  activeIndex: number
): string {
  action = resolveViewAction(current, compiled, action);
  if (action === 'replace') return identifyNamedSelections(ensureMolViewSpecViewIds(compiled));
  const before = JSON.parse(current);
  let after = JSON.parse(compiled);
  if (before.kind === 'multiple' && after.kind !== 'multiple' && action === 'edit-current')
    after = JSON.parse(editMolViewSpecPresentation(current, compiled, action, activeIndex).scene);
  if (before.kind !== 'multiple' && action !== 'add') {
    after.metadata = { ...after.metadata, key: before.metadata?.key ?? after.metadata?.key };
    preserveNamedSelectionIds(after.root, before.root);
    return ensureMolViewSpecViewIds(JSON.stringify(after));
  }
  const original =
    before.kind === 'multiple'
      ? before.snapshots
      : [
          {
            root: before.root,
            metadata: { ...before.metadata, title: before.metadata?.title ?? 'Structure overview' },
          },
        ];
  if (
    after.kind !== 'multiple' ||
    after.snapshots.length !== original.length + (action === 'add' ? 1 : 0)
  )
    throw Error('The edited presentation changed the number of retained perspectives.');
  for (let index = 0; index < original.length; index++)
    if (action === 'add' || index !== activeIndex) after.snapshots[index] = original[index];
    else if (original[index].metadata?.key)
      after.snapshots[index].metadata = {
        ...after.snapshots[index].metadata,
        key: original[index].metadata.key,
      };
  const editedIndex = action === 'add' ? after.snapshots.length - 1 : activeIndex;
  preserveNamedSelectionIds(
    after.snapshots[editedIndex].root,
    action === 'edit-current' ? original[activeIndex].root : undefined
  );
  return JSON.stringify(after);
}
