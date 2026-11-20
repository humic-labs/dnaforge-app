import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import {
  binaryCoordinateBytes,
  binaryCoordinateText,
} from '../../../../../shared/binary-coordinates';
import {
  getCurrentMolecularSnapshot,
  parseMolecularDocument,
  serializeMolecularDocument,
  MOLECULAR_DOCUMENT_SCHEMA,
} from '../../../../../shared/molecular-document';
import { createMolecularComparison } from './molecularComparison';
import { preserveSharedComparisonSources } from '../molstar/molViewSpecStructureIdentity';
import {
  coordinateDigest,
  molecularViewSchema,
  validateMolecularViewCoordinates,
  molecularViewSourceDigests,
} from './molecularView';

function scene(resource: string, title: string, format: 'pdb' | 'bcif' = 'pdb'): string {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: resource })
    .parse({ format })
    .modelStructure()
    .component({ selector: 'protein' })
    .representation({ type: 'cartoon' });
  const document = MVSData.createMultistate([
    { root: builder.getState().root, metadata: { title, linger_duration_ms: 1000 } },
  ]);
  return MVSData.toMVSJ(document);
}

async function source(referenceId: string, title: string, text: string) {
  return {
    referenceId,
    view: molecularViewSchema.parse({
      kind: 'molecular-view',
      version: 1,
      title,
      caption: title,
      scene: scene('structure.pdb', 'Overview'),
      coordinates: { format: 'pdb', text, sha256: await coordinateDigest(text) },
      source: { source: 'pdb', sourceId: title },
      evidence: [],
      preview: 'data:image/png;base64,AAAA',
      createdAt: 1,
    }),
  };
}

describe('pinned multi-structure comparison', () => {
  it('stores and restores a pinned BinaryCIF resource byte for byte', async () => {
    const first = await source('00000000-0000-4000-8000-000000000001', 'First', 'ATOM 1\n');
    const bytes = Uint8Array.from([131, 164, 0, 255]);
    const text = binaryCoordinateText(bytes);
    const second = await source('00000000-0000-4000-8000-000000000002', 'Second', text);
    const binary = {
      ...second,
      view: molecularViewSchema.parse({
        ...second.view,
        coordinates: { ...second.view.coordinates, format: 'bcif' },
        scene: scene('structure.bcif', 'Overview', 'bcif'),
      }),
    };
    const view = await createMolecularComparison('Mixed formats', [first, binary], 'shared-scene');
    const document = {
      schema: MOLECULAR_DOCUMENT_SCHEMA,
      id: '00000000-0000-4000-8000-000000000003',
      name: view.title,
      currentReferenceId: first.referenceId,
      history: [{ referenceId: first.referenceId, snapshot: view }],
    };
    const restored = getCurrentMolecularSnapshot(
      parseMolecularDocument(serializeMolecularDocument(document))
    );
    await validateMolecularViewCoordinates(restored);
    expect(molecularViewSourceDigests(restored)).toEqual([
      first.view.coordinates.sha256,
      second.view.coordinates.sha256,
    ]);
    if (restored.version !== 2) throw Error('Expected a multi-source document');
    expect(restored.pinnedAssets[0]).toMatchObject({ name: 'asset-2.bcif', format: 'bcif' });
    expect(binaryCoordinateBytes(restored.pinnedAssets[0].text)).toEqual(bytes);
  });

  it('constructs retained sources and one placement across steps, independently of visibility', async () => {
    const first = await source('00000000-0000-4000-8000-000000000001', 'First', 'ATOM 1\n');
    const second = await source('00000000-0000-4000-8000-000000000002', 'Second', 'ATOM 2\n');
    const view = await createMolecularComparison('Shared', [first, second], 'shared-scene');
    const current = MVSData.fromMVSJ(view.scene);
    if (current.kind !== 'single') throw Error('Expected joint starter');
    const roots = [structuredClone(current.root), structuredClone(current.root)];
    const mobile = roots[0].children![1].children![0].children![0];
    mobile.children ??= [];
    mobile.children.push({
      kind: 'transform',
      params: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] },
    });
    roots[1].children = roots[1].children?.slice(0, 1);
    const result = preserveSharedComparisonSources(
      MVSData.createMultistate(roots.map((root) => ({ root, metadata: {} }))),
      current,
      0
    );
    if (result.kind !== 'multiple') throw Error('Expected story');
    for (const step of result.snapshots) {
      expect(
        step.root.children?.filter((n) => n.kind === 'download').map((n) => n.params.url)
      ).toEqual(['structure.pdb', 'asset-2.pdb']);
      expect(
        step.root.children![1].children![0].children![0].children?.find(
          (n) => n.kind === 'transform'
        )?.params
      ).toEqual(mobile.children.find((n) => n.kind === 'transform')!.params);
    }
    expect(molecularViewSourceDigests({ ...view, scene: MVSData.toMVSJ(result) })).toEqual([
      first.view.coordinates.sha256,
      second.view.coordinates.sha256,
    ]);
    const onlyFirst = {
      ...view,
      scene: MVSData.toMVSJ({
        ...current,
        root: { ...current.root, children: current.root.children?.slice(0, 1) },
      }),
    };
    expect(molecularViewSourceDigests(onlyFirst)).toEqual([first.view.coordinates.sha256]);
    const omittedPlacement = structuredClone(result);
    for (const step of omittedPlacement.snapshots) {
      const node = step.root.children![1].children![0].children![0];
      node.children = node.children?.filter((n) => n.kind !== 'transform');
    }
    const retained = preserveSharedComparisonSources(omittedPlacement, result, 0);
    expect(retained).toEqual(result);
  });
  it('keeps both exact coordinate assets and places their scenes in one ordered MVS story', async () => {
    const first = await source('00000000-0000-4000-8000-000000000001', 'Prefusion', 'ATOM 1\n');
    const second = await source('00000000-0000-4000-8000-000000000002', 'Postfusion', 'ATOM 2\n');
    const comparison = await createMolecularComparison('RSV F comparison', [first, second]);
    expect(comparison.version).toBe(2);
    if (comparison.version !== 2) return;
    expect(comparison.primarySourceReferenceId).toBe(first.referenceId);
    expect(comparison.coordinates.sha256).toBe(first.view.coordinates.sha256);
    expect(comparison.pinnedAssets).toMatchObject([
      {
        name: 'asset-2.pdb',
        label: 'Postfusion',
        sourceReferenceId: second.referenceId,
        sha256: second.view.coordinates.sha256,
      },
    ]);
    const document = MVSData.fromMVSJ(comparison.scene);
    expect(document.kind).toBe('multiple');
    if (document.kind !== 'multiple') return;
    expect(document.snapshots.map((item) => item.metadata.title)).toEqual([
      'Prefusion · Overview',
      'Postfusion · Overview',
    ]);
    expect(
      document.snapshots.map(
        (item) => item.root.children?.find((node) => node.kind === 'download')?.params.url
      )
    ).toEqual(['structure.pdb', 'asset-2.pdb']);
    await expect(validateMolecularViewCoordinates(comparison)).resolves.toBeUndefined();
  });

  it('rejects changed secondary bytes and scenes that reference unpinned resources', async () => {
    const first = await source('00000000-0000-4000-8000-000000000001', 'First', 'ATOM 1\n');
    const second = await source('00000000-0000-4000-8000-000000000002', 'Second', 'ATOM 2\n');
    const changed = molecularViewSchema.parse({
      ...second.view,
      coordinates: { ...second.view.coordinates, text: 'changed' },
    });
    await expect(
      createMolecularComparison('Bad', [first, { ...second, view: changed }])
    ).rejects.toThrow('digest');
    const outside = molecularViewSchema.parse({
      ...second.view,
      scene: scene('https://example.org/other.pdb', 'Other'),
    });
    await expect(
      createMolecularComparison('Bad', [first, { ...second, view: outside }])
    ).rejects.toThrow('resource');
  });

  it('composes multi-resource saved outputs by digest without duplicating their shared assets', async () => {
    const first = await source('00000000-0000-4000-8000-000000000001', 'First', 'ATOM 1\n');
    const second = await source('00000000-0000-4000-8000-000000000002', 'Second', 'ATOM 2\n');
    const forward = await createMolecularComparison('Forward', [first, second]);
    const reverse = await createMolecularComparison('Reverse', [second, first]);
    const combined = await createMolecularComparison('Saved outputs', [
      { referenceId: '00000000-0000-4000-8000-000000000003', view: forward },
      { referenceId: '00000000-0000-4000-8000-000000000004', view: reverse },
    ]);
    expect(combined.version).toBe(2);
    if (combined.version !== 2) return;
    expect(combined.pinnedAssets).toHaveLength(1);
    expect(combined.pinnedAssets[0].sha256).toBe(second.view.coordinates.sha256);
    const document = MVSData.fromMVSJ(combined.scene);
    if (document.kind !== 'multiple') throw new Error('Expected all authored scenes');
    expect(document.snapshots).toHaveLength(4);
    expect(
      document.snapshots.map((s) => s.root.children?.find((n) => n.kind === 'download')?.params.url)
    ).toEqual(['structure.pdb', 'asset-2.pdb', 'asset-2.pdb', 'structure.pdb']);
    await expect(validateMolecularViewCoordinates(combined)).resolves.toBeUndefined();
    expect(forward.scene).not.toBe(combined.scene);
  });

  it('rejects a nested saved asset outside the selected coordinate sources', async () => {
    const first = await source('00000000-0000-4000-8000-000000000001', 'First', 'ATOM 1\n');
    const second = await source('00000000-0000-4000-8000-000000000002', 'Second', 'ATOM 2\n');
    const third = await source('00000000-0000-4000-8000-000000000003', 'Third', 'ATOM 3\n');
    const nested = await createMolecularComparison('Nested', [first, third]);
    await expect(
      createMolecularComparison('Bad', [{ ...first, view: nested }, second])
    ).rejects.toThrow('outside the selected');
  });
});
