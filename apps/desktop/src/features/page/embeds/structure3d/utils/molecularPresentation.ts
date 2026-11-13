import { getConnection } from '../../../../../db';
import { z } from 'zod';
import {
  createEntityReference,
  prepareEntityReferenceRow,
  getEntityReference,
  type DBEntityReference,
} from '../../../../../db/entity-references';
import { getCurrentWorkspaceScope } from '../../../../../stores/workspaceStore';
import {
  molecularViewFromReferenceData,
  molecularViewSchema,
  validateMolecularViewCoordinates,
  type MolecularView,
} from './molecularView';
import { ensureMolViewSpecViewIds } from './molViewSpecStory';

export async function readMolecularPresentation(referenceId: string) {
  const reference = await getEntityReference(referenceId);
  const view =
    reference?.entity_type === 'structure' && reference.status === 'created'
      ? molecularViewFromReferenceData(reference.data)
      : null;
  if (!reference || !view) throw Error('The saved presentation is missing or unsupported.');
  await validateMolecularViewCoordinates(view);
  return { reference, view };
}

async function presentationFamily(referenceId: string) {
  const initial = await readMolecularPresentation(referenceId);
  const family = initial.view.presentation?.id ?? initial.reference.id;
  const seen = new Set<string>();
  let current = initial;
  for (;;) {
    if (seen.has(current.reference.id))
      throw Error('The saved presentation has an invalid revision chain.');
    seen.add(current.reference.id);
    if ((current.view.presentation?.id ?? current.reference.id) !== family)
      throw Error('The saved presentation revision belongs to another history.');
    const parent = current.view.presentation?.parentReferenceId;
    if (!parent) return { ...initial, family };

    if (!(await getEntityReference(parent))) return { ...initial, family };
    const previous = await readMolecularPresentation(parent);
    current = previous;
  }
}

export async function prepareMolecularPresentationRevision(
  snapshot: MolecularView,
  parentRevision: { referenceId: string; snapshot: MolecularView } | null,
  changeSummary?: string
): Promise<DBEntityReference> {
  await validateMolecularViewCoordinates(snapshot);
  const parent = parentRevision
    ? {
        view: parentRevision.snapshot,
        reference: { id: parentRevision.referenceId },
        family: parentRevision.snapshot.presentation?.id ?? parentRevision.referenceId,
      }
    : null;
  const sourceVersions = (view: MolecularView) =>
    JSON.stringify([
      [view.coordinates.format, view.coordinates.sha256],
      ...(view.version === 2
        ? view.pinnedAssets.map((asset) => [asset.name, asset.format, asset.sha256])
        : []),
    ]);
  if (
    parent?.view.scientificReview &&
    snapshot.scientificReview &&
    sourceVersions(parent.view) !== sourceVersions(snapshot)
  ) {
    const oldReceipts = new Set(parent.view.scientificReview.screenshots.map((shot) => shot.id));
    if (snapshot.scientificReview.screenshots.some((shot) => oldReceipts.has(shot.id)))
      throw Error('Changed molecular sources require fresh scientific-review screenshots.');
  }
  const saved = molecularViewSchema.parse({
    ...snapshot,

    scene: snapshot.scientificReview ? snapshot.scene : ensureMolViewSpecViewIds(snapshot.scene),
    presentation: {
      id: parent?.family ?? crypto.randomUUID(),
      ...(parent ? { parentReferenceId: parent.reference.id } : {}),
      ...(changeSummary?.trim() ? { changeSummary: changeSummary.trim() } : {}),
    },
  });
  return prepareEntityReferenceRow({
    entityType: 'structure',
    displayLabel: saved.title,
    locator: `entity://structure/saved-view:${crypto.randomUUID()}`,
    data: saved,
    deepLinkParams: null,
    source: 'ai',
    workspaceScope: getCurrentWorkspaceScope(),
    workspaceRootPath: null,
  });
}

export async function importMolecularPresentationSnapshot(
  referenceId: string,
  snapshot: MolecularView,
  workspaceRoot: string | null = null
): Promise<DBEntityReference> {
  z.string().uuid().parse(referenceId);
  const frozen = molecularViewSchema.parse(snapshot);
  await validateMolecularViewCoordinates(frozen);
  const resolveExisting = async () => {
    const existing = await getEntityReference(referenceId);
    if (!existing) return null;
    const value =
      existing.entity_type === 'structure' ? molecularViewFromReferenceData(existing.data) : null;
    if (!value || existing.status !== 'created' || JSON.stringify(value) !== JSON.stringify(frozen))
      throw new Error(
        'The molecular snapshot reference ID belongs to different immutable content.'
      );
    return existing;
  };
  const existing = await resolveExisting();
  if (existing) return existing;
  try {
    return await createEntityReference(
      {
        entityType: 'structure',
        displayLabel: frozen.title,
        locator: `entity://structure/saved-view:${referenceId}`,
        data: frozen,
        deepLinkParams: null,
        source: 'user',
        workspaceScope: getCurrentWorkspaceScope(),
        workspaceRootPath: workspaceRoot,
      },
      { id: referenceId, now: frozen.createdAt }
    );
  } catch (error) {
    const concurrent = await resolveExisting();
    if (concurrent) return concurrent;
    throw error;
  }
}

export async function getMolecularPresentationHistory(
  referenceId: string
): Promise<DBEntityReference[]> {
  const { family } = await presentationFamily(referenceId);
  const db = await getConnection();
  const rows = await db.select<DBEntityReference[]>(
    `SELECT * FROM entity_references WHERE entity_type = 'structure' AND status = 'created'
     AND (id = ? OR CASE WHEN json_valid(data) THEN json_extract(data, '$.presentation.id') END = ?)
     ORDER BY created_at ASC, id ASC`,
    [family, family]
  );
  return rows.filter((row) => {
    const view = molecularViewFromReferenceData(row.data);
    return view && (view.presentation?.id ?? row.id) === family;
  });
}

function chainPalettes(value: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) for (const child of value) chainPalettes(child, found);
  else if (value && typeof value === 'object') {
    const custom = (value as { custom?: Record<string, unknown> }).custom;
    const list = (
      custom?.molstar_color_theme_params as
        | { palette?: { params?: { list?: { kind?: unknown; colors?: unknown } } } }
        | undefined
    )?.palette?.params?.list;
    if (
      custom?.molstar_color_theme_name === 'chain-id' &&
      list?.kind === 'set' &&
      Array.isArray(list.colors)
    )
      found.push(list.colors);
    for (const child of Object.values(value)) chainPalettes(child, found);
  }
  return found;
}

function alignTrimmedChainPalettes(left: unknown, right: unknown) {
  const leftPalettes = chainPalettes(left);
  const rightPalettes = chainPalettes(right);
  if (leftPalettes.length !== rightPalettes.length) return;
  leftPalettes.forEach((colors, index) => {
    const other = rightPalettes[index];
    const [shorter, longer] = colors.length <= other.length ? [colors, other] : [other, colors];
    if (shorter.every((color, position) => color === longer[position]))
      longer.splice(shorter.length);
  });
}

export function samePresentationAppearance(a: string, b: string): boolean {
  const normalize = (document: {
    kind?: string;
    snapshots?: Array<{ root: unknown; metadata?: { title?: string } }>;
    root?: unknown;
    metadata?: { title?: string };
  }) => {
    const sort = (value: unknown): unknown => {
      if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
      if (Array.isArray(value)) return value.map(sort);
      if (value && typeof value === 'object') {
        let object: object = value;

        const node = value as { kind?: string; params?: Record<string, unknown> };
        if (node.kind === 'camera' && node.params) {
          const { position, target } = node.params;
          const up = node.params.up ?? [0, 1, 0];
          const vector = (v: unknown): v is number[] =>
            Array.isArray(v) &&
            v.length === 3 &&
            v.every((n) => typeof n === 'number' && Number.isFinite(n));
          if (vector(position) && vector(target) && vector(up)) {
            const direction = position.map((v, i) => v - target[i]);
            const lengthSquared = direction.reduce((sum, v) => sum + v * v, 0);
            if (lengthSquared > 0) {
              const dot = up.reduce((sum, v, i) => sum + v * direction[i], 0) / lengthSquared;
              const orthogonal = up.map((v, i) => v - dot * direction[i]);
              const length = Math.hypot(...orthogonal);
              if (length > 1e-12)
                object = {
                  ...node,
                  params: {
                    ...node.params,
                    up: orthogonal.map((v) => v / length),
                    near: node.params.near ?? 1,
                  },
                };
            }
          }
        }
        return Object.fromEntries(
          Object.entries(object)
            .filter(([key]) => key !== 'metadata')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, sort(child)])
        );
      }
      return value;
    };
    return JSON.stringify(
      document.kind === 'multiple'
        ? (document.snapshots ?? []).map((step) => ({
            title: step.metadata?.title,
            root: sort(step.root),
          }))
        : [{ title: document.metadata?.title, root: sort(document.root) }]
    );
  };
  try {
    const left = JSON.parse(a);
    const right = JSON.parse(b);
    alignTrimmedChainPalettes(left, right);
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}
