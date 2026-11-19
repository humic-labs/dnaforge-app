import {
  coordinateDigest,
  validateMolecularViewCoordinates,
  type MolecularView,
} from '../page/public/embeds/structure3d/molecularView';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import {
  molecularSceneCameraSignature,
  molecularSceneStructureSignature,
  type MolecularPromptTrialFixture,
} from './molecular-prompt-trials';
import { textCoordinates } from '../../shared/binary-coordinates';

export type MolecularTrialPinnedInput = {
  fixture: MolecularPromptTrialFixture;
  view: MolecularView;
};

type FreshCoordinateSource = {
  uri: string;
  format: 'pdb' | 'cif';
  params: Record<string, unknown>;
};

function fixedStructureParams(scene: string, uri: string): Record<string, unknown> {
  const document = JSON.parse(scene);
  const found = new Map<string, Record<string, unknown>>();
  const visit = (
    node: { kind?: string; params?: Record<string, unknown>; children?: (typeof node)[] },
    resource?: string
  ) => {
    if (node.kind === 'download') resource = String(node.params?.url);
    if (node.kind === 'structure' && resource === uri) {
      const p = node.params ?? {};
      if (p.type !== 'model' && p.type !== 'assembly')
        throw new Error('Fresh trials require a fixed model or biological assembly.');
      const params: Record<string, unknown> = { type: p.type };
      for (const key of ['model_index', 'block_index', 'block_header'])
        if (p[key] !== undefined && p[key] !== null) params[key] = p[key];
      if (p.type === 'assembly') {
        if (typeof p.assembly_id !== 'string' || !p.assembly_id)
          throw new Error('Fresh trials require an explicit biological assembly.');
        params.assembly_id = p.assembly_id;
      }
      found.set(JSON.stringify(params), params);
    }
    for (const child of node.children ?? []) visit(child, resource);
  };
  if (document.kind === 'multiple') for (const step of document.snapshots) visit(step.root);
  else visit(document.root);
  if (found.size !== 1)
    throw new Error('A fresh coordinate source must have one fixed model identity.');
  return [...found.values()][0];
}

export function freshMolecularTrialScene(sources: readonly FreshCoordinateSource[]): string {
  return JSON.stringify({
    kind: 'single',
    metadata: {
      version: '1',
      timestamp: '1970-01-01T00:00:00.000Z',
      title: 'Fresh pinned coordinates',
    },
    root: {
      kind: 'root',
      ...(sources.length > 1
        ? {
            custom: {
              dnaforge_comparison: { layout: 'shared-scene', sources: sources.map((s) => s.uri) },
            },
          }
        : {}),
      children: sources.map((source, index) => ({
        kind: 'download',
        params: { url: source.uri },
        children: [
          {
            kind: 'parse',
            params: { format: source.format === 'cif' ? 'mmcif' : 'pdb' },
            children: [
              {
                kind: 'structure',
                ref: `dnaforge:comparison:${index + 1}`,
                params: source.params,
              },
            ],
          },
        ],
      })),
    },
  });
}

export async function assertFreshMolecularTrialAttributes(
  attrs: Partial<Structure3dAttrs>
): Promise<void> {
  if (typeof attrs.molViewSpec !== 'string' || typeof attrs.sourceId !== 'string')
    throw new Error('Fresh authoring requires a canonical coordinate-only scene.');
  const assets = attrs.molViewSpecAssets ?? [];
  const root = JSON.parse(attrs.molViewSpec);
  const primaryUri = root.root?.children?.[0]?.params?.url;
  if (primaryUri !== 'structure.cif' && primaryUri !== 'structure.pdb')
    throw new Error('Fresh authoring requires one pinned primary coordinate resource.');
  const sources: FreshCoordinateSource[] = [
    {
      uri: primaryUri,
      format: primaryUri.endsWith('.cif') ? 'cif' : 'pdb',
      params: fixedStructureParams(attrs.molViewSpec, primaryUri),
    },
    ...assets.map((asset) => ({
      uri: asset.name,
      format: textCoordinates(asset).format,
      params: fixedStructureParams(attrs.molViewSpec!, asset.name),
    })),
  ];
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, ordered(v)])
          )
        : value;
  if (
    JSON.stringify(ordered(root)) !==
      JSON.stringify(ordered(JSON.parse(freshMolecularTrialScene(sources)))) ||
    attrs.cameraSnapshot ||
    attrs.view ||
    attrs.description ||
    (attrs.molViewSpecSnapshotIndex ?? 0) !== 0 ||
    (attrs.highlightGroups?.length ?? 0) ||
    (attrs.residueColorLayers?.length ?? 0) ||
    attrs.label !== 'Fresh pinned coordinates' ||
    assets.some((asset, index) => asset.label !== `Pinned source ${index + 2}`)
  )
    throw new Error(
      'Fresh authoring refuses prior scenes, cameras, styles, contacts, groups and story context. Use saved-view-replay only for observation.'
    );
  for (const [text, digest] of [
    [attrs.sourceId, attrs.coordinateSha256],
    ...assets.map((asset) => [asset.text, asset.sha256]),
  ])
    if ((await coordinateDigest(text!)) !== digest)
      throw new Error('Fresh coordinate digest does not match its pinned bytes.');
}

export async function prepareMolecularTrialFixtures(
  title: string,
  sources: readonly MolecularTrialPinnedInput[]
): Promise<MolecularTrialPinnedInput[]> {
  if (!sources.length || sources.length > 4)
    throw new Error('A controlled trial requires one to four pinned coordinate sources.');
  for (const { fixture, view } of sources) {
    if (fixture.coordinateSha256 !== view.coordinates.sha256)
      throw new Error('The trial fixture and its primary coordinate digest disagree.');
    if (sources.length > 1 && view.version !== 1)
      throw new Error(
        'Pin original single-resource views before composing a controlled comparison.'
      );
    await validateMolecularViewCoordinates(view);
  }
  const first = sources[0];
  const resources = sources.map(({ view }, index) => {
    const { format } = textCoordinates(view.coordinates);
    return {
      uri: index === 0 ? `structure.${format}` : `asset-${index + 1}.${format}`,
      format,
      params: fixedStructureParams(view.scene, `structure.${format}`),
    };
  });
  const scene = freshMolecularTrialScene(resources);
  const base = {
    kind: 'molecular-view' as const,
    title: 'Fresh pinned coordinates',
    caption: '',
    scene,
    coordinates: structuredClone(first.view.coordinates),
    source: structuredClone(first.view.source),
    evidence: [],
    preview:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    createdAt: Date.now(),
  };
  const view: MolecularView =
    sources.length === 1
      ? { ...base, version: 1 }
      : {
          ...base,
          version: 2,
          primarySourceReferenceId: first.fixture.referenceId,
          pinnedAssets: sources.slice(1).map(({ view, fixture }, index) => ({
            ...structuredClone(textCoordinates(view.coordinates)),
            name: resources[index + 1].uri,
            label: `Pinned source ${index + 2}`,
            sourceReferenceId: fixture.referenceId,
          })),
        };
  return Promise.all(
    sources.map(async (source) => {
      return {
        view,
        fixture: {
          ...source.fixture,
          initialSceneSha256: await coordinateDigest(view.scene),
          initialCameraSignature: molecularSceneCameraSignature(view.scene),
          structureSignature: molecularSceneStructureSignature(view.scene),
          resourceStructureSignature: molecularSceneResourceStructureSignature(view.scene),
        },
      };
    })
  );
}

export function molecularSceneResourceStructureSignature(scene: string): string {
  const document = JSON.parse(scene);
  const bindings = new Map<string, Set<string>>();
  type SceneNode = { kind?: string; params?: Record<string, unknown>; children?: SceneNode[] };
  const visit = (node: SceneNode, resource?: string) => {
    if (node.kind === 'download') resource = String(node.params?.url);
    if (node.kind === 'structure') {
      if (!resource) throw new Error('A trial structure has no pinned coordinate resource.');
      const p = node.params ?? {};
      const identity = JSON.stringify({
        type: p.type,
        model_index: p.model_index ?? 0,
        block_index: p.block_index ?? 0,
        block_header: p.block_header ?? null,
        assembly_id: p.type === 'assembly' ? (p.assembly_id ?? null) : null,
      });
      const identities = bindings.get(resource) ?? new Set<string>();
      identities.add(identity);
      bindings.set(resource, identities);
    }
    for (const child of node.children ?? []) visit(child, resource);
  };
  if (document.kind === 'multiple') for (const step of document.snapshots) visit(step.root);
  else visit(document.root);
  return JSON.stringify(
    Object.fromEntries(
      [...bindings]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, values]) => [name, [...values].sort()])
    )
  );
}

export function molecularTrialSceneResourcesChanged(scene: string, baseline: string): boolean {
  try {
    const expected = JSON.parse(baseline) as Record<string, string[]>;
    const actual = JSON.parse(molecularSceneResourceStructureSignature(scene)) as Record<
      string,
      string[]
    >;
    const primary = Object.keys(expected).find(
      (name) => name === 'structure.pdb' || name === 'structure.cif'
    );
    if (!primary || !actual[primary]?.length) return true;
    return Object.entries(actual).some(
      ([name, values]) => !expected[name] || values.some((v) => !expected[name].includes(v))
    );
  } catch {
    return true;
  }
}
