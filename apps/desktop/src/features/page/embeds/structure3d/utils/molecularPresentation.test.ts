import { beforeAll, describe, expect, it } from 'vitest';
import { initializeTestSchema } from '../../../../../test/initializeTestSchema';
import { createEntityReference, getEntityReference } from '../../../../../db/entity-references';
import { getConnection } from '../../../../../db';
import {
  coordinateDigest,
  molecularViewFromReferenceData,
  type MolecularView,
} from './molecularView';
import {
  getMolecularPresentationHistory,
  prepareMolecularPresentationRevision,
  readMolecularPresentation,
  samePresentationAppearance,
  importMolecularPresentationSnapshot,
} from './molecularPresentation';

it('treats a legacy camera and its rendered orthogonal up vector as the same saved appearance', () => {
  const scene = (up: number[], near?: number) =>
    JSON.stringify({
      kind: 'single',
      root: {
        kind: 'root',
        children: [
          {
            kind: 'camera',
            params: {
              position: [50.14, -100, 35],
              target: [50.14, 19.65, 47.36],
              up,
              ...(near === undefined ? {} : { near }),
            },
          },
        ],
      },
    });
  const legacy = scene([0, 0, -1]);
  expect(
    samePresentationAppearance(legacy, scene([0, 0.10275449561038315, -0.9947067475552058], 1))
  ).toBe(true);
  expect(samePresentationAppearance(legacy, scene([1, 0, 0], 1))).toBe(false);
  expect(samePresentationAppearance(legacy, scene([0, 0, -1], 3))).toBe(false);
});
it('treats a chain palette trimmed to the chains present as the same appearance', () => {
  const scene = (color: string, colors: number[]) =>
    JSON.stringify({
      kind: 'single',
      root: {
        kind: 'root',
        children: [
          {
            kind: 'color',
            params: { color },
            custom: {
              molstar_color_theme_name: 'chain-id',
              molstar_color_theme_params: {
                asymId: 'auth',
                palette: { name: 'colors', params: { list: { kind: 'set', colors } } },
              },
            },
          },
        ],
      },
    });
  const loaded = scene('#e6194b', [15079755, 2924588, 2062335, 16744206]);
  expect(samePresentationAppearance(loaded, scene('#e6194b', [15079755]))).toBe(true);
  expect(samePresentationAppearance(loaded, scene('#3cb44b', [2924588]))).toBe(false);
  expect(samePresentationAppearance(loaded, scene('#e6194b', [2924588]))).toBe(false);
});
beforeAll(initializeTestSchema);

async function cachePreparedRevision(
  snapshot: MolecularView,
  parentId: string | null,
  changeSummary?: string
) {
  const parent = parentId ? await readMolecularPresentation(parentId) : null;
  const prepared = await prepareMolecularPresentationRevision(
    snapshot,
    parent ? { referenceId: parent.reference.id, snapshot: parent.view } : null,
    changeSummary
  );
  await importMolecularPresentationSnapshot(
    prepared.id,
    molecularViewFromReferenceData(prepared.data)!
  );
  return (await getEntityReference(prepared.id))!;
}

async function view(title = 'Pocket', text = 'ATOM pinned coordinates'): Promise<MolecularView> {
  return {
    kind: 'molecular-view',
    version: 1,
    title,
    caption: '',
    scene: JSON.stringify({ kind: 'single', root: { kind: 'root', children: [] } }),
    coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
    source: {},
    evidence: [],
    preview: 'data:image/png;base64,AAAA',
    createdAt: Date.now(),
  };
}
describe('derived molecular revision caches and legacy history compatibility', () => {
  it('prepares a frozen revision without publishing database presentation authority', async () => {
    const prepared = await prepareMolecularPresentationRevision(await view(), null);
    expect(await getEntityReference(prepared.id)).toBeNull();
  });
  it('can continue a portable captured result whose earlier external history is unavailable', async () => {
    const id = crypto.randomUUID();
    const family = crypto.randomUUID();
    const captured = {
      ...(await view()),
      presentation: { id: family, parentReferenceId: crypto.randomUUID() },
    };
    await importMolecularPresentationSnapshot(id, captured);
    const saved = await cachePreparedRevision(await view('Continued capture'), id);
    expect(molecularViewFromReferenceData(saved.data)?.presentation).toEqual({
      id: family,
      parentReferenceId: id,
    });
    expect(new Set((await getMolecularPresentationHistory(saved.id)).map((row) => row.id))).toEqual(
      new Set([id, saved.id])
    );
  });
  it('links new saves and a branch from an earlier save without changing any old snapshot', async () => {
    const first = await cachePreparedRevision(await view(), null);
    const original = first.data;
    const second = await cachePreparedRevision(await view('Edited pocket'), first.id);
    const branch = await cachePreparedRevision(await view('Different explanation'), first.id);
    const a = molecularViewFromReferenceData(first.data)!;
    const b = molecularViewFromReferenceData(second.data)!;
    const c = molecularViewFromReferenceData(branch.data)!;
    expect(b.presentation?.parentReferenceId).toBe(first.id);
    expect(c.presentation?.parentReferenceId).toBe(first.id);
    expect(b.presentation?.id).toBe(a.presentation?.id);
    expect(c.presentation?.id).toBe(a.presentation?.id);
    const history = await getMolecularPresentationHistory(second.id);
    expect(new Set(history.map((entry) => entry.id))).toEqual(
      new Set([first.id, second.id, branch.id])
    );
    expect(history.find((entry) => entry.id === first.id)?.data).toBe(original);
  });

  it('adopts an existing saved view as the root without rewriting its historical data', async () => {
    const snapshot = await view();
    const legacy = await createEntityReference({
      entityType: 'structure',
      displayLabel: snapshot.title,
      locator: `entity://structure/saved-view:${crypto.randomUUID()}`,
      deepLinkParams: null,
      data: snapshot,
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });
    const saved = await cachePreparedRevision(await view('New explanation'), legacy.id);
    expect(molecularViewFromReferenceData(saved.data)?.presentation).toEqual({
      id: legacy.id,
      parentReferenceId: legacy.id,
    });
    expect((await getMolecularPresentationHistory(saved.id)).map((entry) => entry.id)).toContain(
      legacy.id
    );
  });

  it('rejects a missing parent but permits updating source data within one document history', async () => {
    await expect(cachePreparedRevision(await view(), crypto.randomUUID())).rejects.toThrow(
      /saved|parent/i
    );
    const first = await cachePreparedRevision(await view(), null);
    const updated = await cachePreparedRevision(
      await view('Improved source', 'DIFFERENT coordinates'),
      first.id
    );
    expect(molecularViewFromReferenceData(updated.data)?.presentation?.id).toBe(
      molecularViewFromReferenceData(first.data)?.presentation?.id
    );
    expect(molecularViewFromReferenceData(first.data)?.coordinates.text).toBe(
      'ATOM pinned coordinates'
    );
    expect(await getMolecularPresentationHistory(updated.id)).toHaveLength(2);
  });

  it('retains a valid history beyond 256 immutable saves', async () => {
    const family = crypto.randomUUID();
    let parentReferenceId: string | undefined;
    const snapshot = await view();
    for (let index = 0; index < 260; index++) {
      const saved = await createEntityReference({
        entityType: 'structure',
        displayLabel: 'Long history',
        locator: `entity://structure/saved-view:${crypto.randomUUID()}`,
        deepLinkParams: null,
        data: {
          ...snapshot,
          presentation: { id: family, ...(parentReferenceId ? { parentReferenceId } : {}) },
        },
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: null,
      });
      parentReferenceId = saved.id;
    }
    expect(await getMolecularPresentationHistory(parentReferenceId!)).toHaveLength(260);
  });

  it('still rejects a corrupted cycle in an otherwise matching history', async () => {
    const a = await cachePreparedRevision(await view(), null);
    const b = await cachePreparedRevision(await view('Second'), a.id);
    const corrupt = molecularViewFromReferenceData(a.data)!;
    corrupt.presentation!.parentReferenceId = b.id;
    await (
      await getConnection()
    ).execute('UPDATE entity_references SET data = ? WHERE id = ?', [
      JSON.stringify(corrupt),
      a.id,
    ]);
    await expect(getMolecularPresentationHistory(b.id)).rejects.toThrow(/revision chain/i);
  });

  it('rehydrates an exact native history ID idempotently and rejects content collisions', async () => {
    const referenceId = crypto.randomUUID();
    const snapshot = await view('Portable exact result');
    const imported = await importMolecularPresentationSnapshot(
      referenceId,
      snapshot,
      '/workspace/copied'
    );
    expect(imported.id).toBe(referenceId);
    expect(imported.workspace_root_path).toBe('/workspace/copied');
    expect(imported.locator).toBe(`entity://structure/saved-view:${referenceId}`);
    expect(await importMolecularPresentationSnapshot(referenceId, snapshot)).toEqual(imported);
    await expect(
      importMolecularPresentationSnapshot(referenceId, { ...snapshot, title: 'Different result' })
    ).rejects.toThrow(/immutable content/i);
  });

  it('does not carry visual-review receipts onto changed source data', async () => {
    const snapshot = await view();
    const digest = await coordinateDigest(snapshot.scene);
    const receiptId = crypto.randomUUID();
    snapshot.scientificReview = {
      version: 1,
      sceneDigestSha256: digest,
      savedSceneDigestSha256: digest,
      question: 'What does this source show?',
      steps: [
        {
          index: 0,
          screenshotReceiptId: receiptId,
          claim: 'Shown',
          evidence: 'Visible',
          limitation: 'One source',
          groups: [],
        },
      ],
      continuity: { assessment: 'Continuous', limitation: 'One state' },
      revision: { findings: [], changes: [], unresolved: [] },
      screenshots: [
        {
          id: receiptId,
          sceneDigestSha256: digest,
          index: 0,
          imageDigestSha256: digest,
          cameraDigestSha256: digest,
          stepCamera: { target: [0, 0, 0], position: [0, 0, 10], up: [0, 1, 0] },
          capturedAt: 1,
        },
      ],
    };
    const first = await cachePreparedRevision(snapshot, null);
    const updated = await view('Updated data', 'NEW coordinates');
    await expect(
      cachePreparedRevision({ ...updated, scientificReview: snapshot.scientificReview }, first.id)
    ).rejects.toThrow(/fresh.*screenshots/i);
    await expect(cachePreparedRevision(updated, first.id)).resolves.toBeTruthy();
  });
});
