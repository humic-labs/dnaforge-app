import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import {
  coordinateDigest,
  molecularViewSchema,
} from '../page/public/embeds/structure3d/molecularView';
import {
  prepareMolecularTrialFixtures,
  molecularSceneResourceStructureSignature,
  molecularTrialSceneResourcesChanged,
  assertFreshMolecularTrialAttributes,
} from './molecular-trial-fixtures';

async function pinned(index: number) {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.pdb' })
    .parse({ format: 'pdb' })
    .modelStructure()
    .component({ selector: 'protein' })
    .representation({ type: 'cartoon' });
  const scene = MVSData.toMVSJ(builder.getState());
  const text = `ATOM ${index}\n`;
  const digest = await coordinateDigest(text);
  return {
    fixture: {
      pdbId: `1AB${index}`,
      referenceId: `00000000-0000-4000-8000-00000000000${index}`,
      savedViewId: `saved-view:source-${index}`,
      coordinateSha256: digest,
      initialSceneSha256: await coordinateDigest(scene),
      initialCameraSignature: '[]',
      structureSignature: '["model"]',
    },
    view: molecularViewSchema.parse({
      kind: 'molecular-view',
      version: 1,
      title: `Source ${index}`,
      caption: '',
      scene,
      coordinates: { format: 'pdb', text, sha256: digest },
      source: { sourceId: `1AB${index}` },
      evidence: [],
      preview: 'data:image/png;base64,AAAA',
      createdAt: 1,
    }),
  };
}

describe('controlled trial coordinate preparation', () => {
  it('starts one shared scene with every pinned source without rewriting originals', async () => {
    const sources = await Promise.all([pinned(1), pinned(2)]);
    const before = structuredClone(sources);
    const prepared = await prepareMolecularTrialFixtures('Comparison', sources);
    expect(sources).toEqual(before);
    expect(prepared).toHaveLength(2);
    for (const [index, item] of prepared.entries()) {
      expect(item.view.version).toBe(2);
      expect(item.fixture.coordinateSha256).toBe(sources[index].fixture.coordinateSha256);
      expect(item.view.coordinates.sha256).toBe(sources[0].fixture.coordinateSha256);
      expect(item.fixture.initialSceneSha256).toBe(await coordinateDigest(item.view.scene));
      if (item.view.version !== 2) throw Error('Comparison is unavailable');
      expect(item.view.pinnedAssets[0].sha256).toBe(sources[1].fixture.coordinateSha256);
      expect(item.view.pinnedAssets[0].text).toBe(sources[1].view.coordinates.text);
      const document = MVSData.fromMVSJ(item.view.scene);
      expect(document.kind).toBe('single');
      if (document.kind !== 'single') throw Error('Expected one shared scene');
      expect(
        document.root.children?.filter((n) => n.kind === 'download').map((n) => n.params.url)
      ).toEqual(['structure.pdb', 'asset-2.pdb']);
    }
  });

  it('uses only coordinates and model identity from a prior styled single-source output', async () => {
    const source = await pinned(1);
    const old = JSON.parse(source.view.scene);
    old.root.children.push({
      kind: 'camera',
      params: { position: [5, 6, 7], target: [0, 0, 0], up: [0, 1, 0] },
    });
    old.root.custom = { priorReview: 'Reuse my answer' };
    source.view.scene = JSON.stringify(old);
    source.view.title = 'Old authored answer';
    source.view.caption = 'Prior explanatory text';
    const before = structuredClone(source);
    const [clean] = await prepareMolecularTrialFixtures('Single', [source]);
    expect(source).toEqual(before);
    expect(clean.view.coordinates).toEqual(source.view.coordinates);
    expect(clean.view.scene).not.toContain('camera');
    expect(clean.view.scene).not.toContain('representation');
    expect(clean.view.scene).not.toContain('priorReview');
    expect(clean.view.title).toBe('Fresh pinned coordinates');
    expect(clean.view.caption).toBe('');
    expect(clean.view).not.toHaveProperty('scientificReview');
    expect(clean.fixture.initialSceneSha256).toBe(await coordinateDigest(clean.view.scene));
    await expect(
      assertFreshMolecularTrialAttributes({
        source: 'file',
        sourceId: clean.view.coordinates.text,
        coordinateSha256: clean.view.coordinates.sha256,
        molViewSpec: clean.view.scene,
        label: clean.view.title,
      })
    ).resolves.toBeUndefined();
    await expect(
      assertFreshMolecularTrialAttributes({
        source: 'file',
        sourceId: source.view.coordinates.text,
        coordinateSha256: source.view.coordinates.sha256,
        molViewSpec: source.view.scene,
        label: source.view.title,
      })
    ).rejects.toThrow(/prior scenes/);
  });

  it('rejects a mismatched primary digest before worker preparation', async () => {
    const sources = await Promise.all([pinned(1), pinned(2)]);
    sources[1].fixture.coordinateSha256 = '0'.repeat(64);
    await expect(prepareMolecularTrialFixtures('Bad', sources)).rejects.toThrow(/digest/);
  });

  it('rejects a BinaryCIF asset in a text-only fresh trial', async () => {
    const sources = await Promise.all([pinned(1), pinned(2)]);
    const [{ view }] = await prepareMolecularTrialFixtures('Comparison', sources);
    if (view.version !== 2) throw Error('Expected shared comparison');
    const [asset] = view.pinnedAssets;
    await expect(
      assertFreshMolecularTrialAttributes({
        source: 'file',
        sourceId: view.coordinates.text,
        coordinateSha256: view.coordinates.sha256,
        molViewSpec: view.scene,
        molViewSpecAssets: [{ ...asset, format: 'bcif', text: btoa(asset.text) }],
        label: view.title,
      })
    ).rejects.toThrow(/needs text PDB or mmCIF coordinates/);
  });

  it('checks models per resource while allowing partial scenes and transformed duplicate copies', async () => {
    const sources = await Promise.all([pinned(1), pinned(2)]);
    const [{ view, fixture }] = await prepareMolecularTrialFixtures('Comparison', sources);
    const document = MVSData.fromMVSJ(view.scene);
    if (document.kind !== 'single') throw Error('Expected shared comparison');
    const joint = document.root;
    const first = structuredClone(joint);
    first.children = first.children?.slice(0, 1);
    const asScene = (root: typeof first) =>
      MVSData.toMVSJ({ kind: 'single', metadata: document.metadata, root });
    const baseline = fixture.resourceStructureSignature!;
    expect(molecularTrialSceneResourcesChanged(asScene(first), baseline)).toBe(false);
    expect(molecularTrialSceneResourcesChanged(asScene(joint), baseline)).toBe(false);
    const altered = structuredClone(joint);
    altered.children![1].children![0].children![0].params.model_index = 1;
    expect(molecularTrialSceneResourcesChanged(asScene(altered), baseline)).toBe(true);
    const secondary = structuredClone(joint);
    secondary.children = secondary.children?.slice(1);
    expect(molecularTrialSceneResourcesChanged(asScene(secondary), baseline)).toBe(true);
    const outside = structuredClone(joint);
    outside.children![1].params.url = 'unfixed.pdb';
    expect(molecularTrialSceneResourcesChanged(asScene(outside), baseline)).toBe(true);
    expect(molecularSceneResourceStructureSignature(asScene(joint))).toBe(baseline);
  });
});
