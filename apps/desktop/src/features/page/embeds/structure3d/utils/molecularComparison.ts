import { MVSData, type Snapshot } from 'molstar/lib/extensions/mvs/mvs-data';
import { validateMolViewSpecScene } from '../molstar/molViewSpec';
import {
  molecularViewSchema,
  validateMolecularViewCoordinates,
  type MolecularView,
} from './molecularView';

export type MolecularComparisonSource = {
  referenceId: string;
  view: MolecularView;
};

export async function createMolecularComparison(
  title: string,
  sources: readonly MolecularComparisonSource[],
  layout: 'saved-story' | 'shared-scene' = 'saved-story'
): Promise<MolecularView> {
  if (sources.length < 2 || sources.length > 4)
    throw new Error('A comparison needs two to four distinct pinned structures.');
  if (new Set(sources.map(({ referenceId }) => referenceId)).size !== sources.length)
    throw new Error('A comparison cannot include the same source reference twice.');
  if (new Set(sources.map(({ view }) => view.coordinates.sha256)).size !== sources.length)
    throw new Error('A comparison needs distinct coordinate assets.');
  for (const { view } of sources) await validateMolecularViewCoordinates(view);

  const allowed = sources.map(({ view }, index) =>
    index === 0
      ? `structure.${view.coordinates.format}`
      : `asset-${index + 1}.${view.coordinates.format}`
  );
  const assetByDigest = new Map(
    sources.map(({ view }, index) => [
      view.coordinates.sha256,
      { name: allowed[index], format: view.coordinates.format },
    ])
  );
  const snapshots: Snapshot[] = [];
  for (const [index, { view }] of sources.entries()) {
    const originalName = view.coordinates.format === 'cif' ? 'structure.cif' : 'structure.pdb';
    const resources = [
      { name: originalName, ...view.coordinates },
      ...(view.version === 2 ? view.pinnedAssets : []),
    ];
    const replacements = new Map(
      resources.map((asset) => {
        const target = assetByDigest.get(asset.sha256);
        if (!target || target.format !== asset.format)
          throw new Error(
            'A saved scene contains an asset outside the selected coordinate sources.'
          );
        return [asset.name, target.name];
      })
    );
    const document = validateMolViewSpecScene(view.scene, [...replacements.keys()]);
    const states =
      document.kind === 'multiple' ? document.snapshots : MVSData.stateToStates(document).snapshots;
    for (const state of states) {
      const root = structuredClone(state.root);
      const pending: Array<{
        kind: string;
        params?: Record<string, unknown>;
        children?: unknown[];
      }> = [root as (typeof pending)[number]];
      let downloads = 0;
      while (pending.length) {
        const node = pending.pop()!;
        if (node.kind === 'download') {
          const replacement = replacements.get(String(node.params?.url));
          if (!replacement)
            throw new Error(`Scene resource ${String(node.params?.url)} is not pinned.`);
          node.params!.url = replacement;
          downloads += 1;
        }
        if (node.params?.uri !== undefined) {
          const replacement = replacements.get(String(node.params.uri));
          if (!replacement)
            throw new Error(`Scene resource ${String(node.params.uri)} is not pinned.`);
          node.params.uri = replacement;
        }
        pending.push(...((node.children ?? []) as typeof pending));
      }
      if (!downloads) throw new Error('A comparison scene must contain its pinned structure.');
      snapshots.push({
        ...state,
        root,
        metadata: {
          ...state.metadata,
          title: `${view.title} · ${state.metadata.title?.trim() || 'View'}`,
          key: `asset-${index + 1}-scene-${snapshots.length + 1}`,
          transition_duration_ms: 0,
        },
      });
    }
  }
  const first = sources[0];
  const document = MVSData.createMultistate(snapshots, { title });
  let scene = MVSData.toMVSJ(document);
  if (layout === 'shared-scene') {
    const root = structuredClone(snapshots[0].root);
    root.children = root.children?.filter(
      (node) => node.kind !== 'download' && node.kind !== 'camera' && node.kind !== 'focus'
    );
    for (const [index, resource] of allowed.entries()) {
      const state = snapshots.find((s) =>
        s.root.children?.some((n) => n.kind === 'download' && n.params.url === resource)
      );
      const branch = structuredClone(
        state?.root.children?.find((n) => n.kind === 'download' && n.params.url === resource)
      );
      if (!branch) throw new Error('A shared comparison requires every source structure.');
      const visit = (node: { kind: string; ref?: string; children?: unknown[] }) => {
        if (node.ref) node.ref = `comparison-${index + 1}:${node.ref}`;
        if (node.kind === 'structure' && !node.ref) node.ref = `dnaforge:comparison:${index + 1}`;
        for (const child of node.children ?? []) visit(child as typeof node);
      };
      visit(branch);
      root.children ??= [];
      root.children.push(branch);
    }
    root.custom = { ...root.custom, dnaforge_comparison: { layout, sources: allowed } };
    scene = MVSData.toMVSJ({ kind: 'single', metadata: document.metadata, root });
  }
  validateMolViewSpecScene(scene, allowed);
  return molecularViewSchema.parse({
    kind: 'molecular-view',
    version: 2,
    title,
    caption: 'Comparison of pinned coordinate structures and their authored scenes.',
    scene,
    initialSnapshotIndex: first.view.initialSnapshotIndex,
    coordinates: first.view.coordinates,
    primarySourceReferenceId: first.referenceId,
    pinnedAssets: sources.slice(1).map(({ referenceId, view }, index) => ({
      name: allowed[index + 1],
      label: view.title,
      sourceReferenceId: referenceId,
      ...view.coordinates,
    })),
    source: first.view.source,
    evidence: [
      ...new Map(
        sources.flatMap(({ view }) => view.evidence).map((item) => [item.url, item])
      ).values(),
    ].slice(0, 20),
    preview: first.view.preview,
    createdAt: Date.now(),
  });
}
