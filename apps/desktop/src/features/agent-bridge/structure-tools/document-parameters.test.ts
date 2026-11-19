import { describe, it, expect } from 'vitest';
import { molecularParameterEditSchema } from './document-parameter-contract';
import {
  editMolecularDocumentParameters,
  inspectMolecularDocumentParameters,
  molecularSceneDigest,
  retainsMolecularDataColors,
  rebaseMolecularDataParameters,
  requireAppliedMolecularParameterEdits,
} from './document-parameters';

const scene = JSON.stringify({
  metadata: { version: '1', timestamp: '2026-10-28T00:00:00Z', key: 'protein-view' },
  root: {
    kind: 'root',
    children: [
      {
        kind: 'download',
        params: { url: 'structure.cif' },
        children: [
          {
            kind: 'parse',
            params: { format: 'mmcif' },
            children: [
              {
                kind: 'structure',
                params: { type: 'model' },
                children: [
                  {
                    kind: 'component',
                    params: { selector: 'polymer' },
                    children: [
                      {
                        kind: 'representation',
                        params: { type: 'cartoon' },
                        children: [{ kind: 'color', params: { color: '#ff0000' } }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
});

describe('discoverable molecular document parameters', () => {
  it('pages only camera parameters for the requested perspective and keeps the whole-scene digest', async () => {
    const base = JSON.parse(scene);
    const story = JSON.stringify({
      kind: 'multiple',
      metadata: base.metadata,
      snapshots: Array.from({ length: 6 }, (_, index) => ({
        metadata: { key: `view-${index}` },
        root: {
          ...base.root,
          children: [
            ...base.root.children,
            { kind: 'camera', params: { target: [0, 0, 0], position: [0, index, 50], up: [0, 1, 0] } },
          ],
        },
      })),
    });
    const first = await inspectMolecularDocumentParameters(story, {
      nodeKind: 'camera',
      snapshotIndex: 4,
      limit: 1,
    });
    expect(first.sceneSha256).toBe(await molecularSceneDigest(story));
    expect(first.total).toBe(4);
    expect(first.nextOffset).toBe(1);
    const rest = await inspectMolecularDocumentParameters(story, {
      nodeKind: 'camera',
      snapshotIndex: 4,
      offset: 1,
    });
    const parameters = [...first.parameters, ...rest.parameters];
    expect(parameters.every((parameter) => parameter.path.startsWith('/snapshots/4/'))).toBe(true);
    expect(parameters.map((parameter) => parameter.name)).toEqual(['target', 'position', 'up', 'near']);
    expect(parameters.find((parameter) => parameter.name === 'position')?.value).toEqual([0, 4, 50]);
    expect(rest.nextOffset).toBeNull();
  });

  it('rejects an ignored parameter after rendering-policy compilation instead of claiming success', async () => {
    const parameters = await inspectMolecularDocumentParameters(scene, { limit: 256 });
    const color = parameters.parameters.find(
      (parameter) => parameter.nodeKind === 'color' && parameter.name === 'color'
    )!;
    expect(() =>
      requireAppliedMolecularParameterEdits(scene, [{ path: color.path, value: '#ff0000' }])
    ).not.toThrow();
    expect(() =>
      requireAppliedMolecularParameterEdits(scene, [{ path: color.path, value: '#112233' }])
    ).toThrow(/construction policy overrides/);
  });
  it('retains the compiled display policy in the data baseline after a parameter edit', async () => {
    const data = JSON.parse(scene);
    const representation = data.root.children[0].children[0].children[0].children[0].children[0];
    representation.children[0].custom = { dnaforge_legend_generated: false };
    representation.children.push({
      kind: 'color',
      params: { color: '#112233', selector: { label_asym_id: 'A', label_seq_id: 1 } },
    });
    const current = JSON.stringify(data);
    const parameters = await inspectMolecularDocumentParameters(scene, { limit: 256 });
    const scale = parameters.parameters.find(
      (parameter) => parameter.nodeKind === 'representation' && parameter.name === 'size_factor'
    )!;
    const edits = [{ path: scale.path, value: 1.15 }];
    const compiled = JSON.parse(
      await editMolecularDocumentParameters(current, await molecularSceneDigest(current), edits)
    );
    compiled.root.custom = {
      dnaforge_render_profile: { id: 'dnaforge-detail', version: 12 },
      dnaforge_surface_ownership_contract: 'single-side-v1',
    };
    const rebased = JSON.parse(
      await rebaseMolecularDataParameters(scene, current, edits, JSON.stringify(compiled))
    );
    expect(rebased.root.custom).toEqual(compiled.root.custom);
    expect(JSON.stringify(rebased)).not.toContain('#112233');
    expect(JSON.stringify(rebased)).toContain('"size_factor":1.15');
  });
  it('rebases a native allocated structure reference while rejecting a genuine source identity change', async () => {
    const current = JSON.parse(scene);
    current.root.children[0].children[0].children[0].ref = 'dnaforge:structure:root.0.0.0';
    const parameters = await inspectMolecularDocumentParameters(scene, { limit: 256 });
    const scale = parameters.parameters.find(
      (parameter) => parameter.nodeKind === 'representation' && parameter.name === 'size_factor'
    )!;
    const edits = [{ path: scale.path, value: 1.15 }];
    const rebased = await rebaseMolecularDataParameters(scene, JSON.stringify(current), edits);
    expect(rebased).toContain('"size_factor":1.15');
    expect(rebased).toContain('dnaforge:structure:root.0.0.0');
    current.root.children[0].children[0].children[0].ref = 'different-source';
    await expect(
      rebaseMolecularDataParameters(scene, JSON.stringify(current), edits)
    ).rejects.toThrow(/baseline disagrees/);
  });
  it('retains data colors when scene validation allocates selection identities', () => {
    const before = JSON.parse(scene),
      after = JSON.parse(scene);
    const color = (value: typeof before) =>
      value.root.children[0].children[0].children[0].children[0].children[0].children[0];
    color(before).custom = {
      dnaforge_legend_label: 'Protein chain A',
      dnaforge_legend_generated: true,
    };
    color(after).custom = {
      ...color(before).custom,
      dnaforge_selection_id: 'selection:new-native-group',
    };
    expect(retainsMolecularDataColors(JSON.stringify(before), JSON.stringify(after))).toBe(true);
    color(after).params.color = '#445566';
    expect(retainsMolecularDataColors(JSON.stringify(before), JSON.stringify(after))).toBe(false);
  });
  it('retains data color bindings and rebases an independent parameter for later variation switches', async () => {
    const parsed = JSON.parse(scene);
    const parameters = await inspectMolecularDocumentParameters(scene, { limit: 256 });
    const scale = parameters.parameters.find(
      (p) => p.nodeKind === 'representation' && p.name === 'size_factor'
    )!;
    expect(scale).toBeDefined();
    const representation = parsed.root.children[0].children[0].children[0].children[0].children[0];
    representation.children.push({
      kind: 'color',
      params: { color: '#112233', selector: { label_asym_id: 'A', label_seq_id: 1 } },
    });
    const dataScene = JSON.stringify(parsed);
    const edits = [{ path: scale.path, value: 1.25 }];
    const changed = await editMolecularDocumentParameters(
      dataScene,
      await molecularSceneDigest(dataScene),
      edits
    );
    expect(retainsMolecularDataColors(dataScene, changed)).toBe(true);
    const rebased = await rebaseMolecularDataParameters(scene, dataScene, edits);
    expect(rebased).toContain('"size_factor":1.25');
    expect(rebased).not.toContain('#112233');
    await expect(
      rebaseMolecularDataParameters(scene.replace('structure.cif', 'other.cif'), dataScene, edits)
    ).rejects.toThrow(/baseline disagrees/);
  });
  it('discovers installed parameter types, current values and defaults without a color-only allowlist', async () => {
    const result = await inspectMolecularDocumentParameters(scene, { limit: 256 });
    expect(
      result.parameters.find((p) => p.nodeKind === 'color' && p.name === 'color')
    ).toMatchObject({ value: '#ff0000', viewId: 'protein-view', valueSchema: expect.any(Object) });
    const color = result.parameters.find((p) => p.nodeKind === 'color' && p.name === 'color')!;
    expect(
      molecularParameterEditSchema.safeParse({ path: color.path, value: '#112233' }).success
    ).toBe(true);
    expect(
      molecularParameterEditSchema.safeParse({
        path: '/Users/example/protein.cif',
        value: '#112233',
      }).success
    ).toBe(false);
    expect(
      result.parameters.some((p) => p.nodeKind === 'representation' && p.name !== 'type')
    ).toBe(true);
    expect(result.sceneSha256).toBe(await molecularSceneDigest(scene));
    expect(result.nextOffset).toBe(null);
  });
  it('applies a script-produced value at a discovered path while retaining coordinates and other parameters', async () => {
    const result = await inspectMolecularDocumentParameters(scene, { limit: 256 });
    const color = result.parameters.find((p) => p.nodeKind === 'color' && p.name === 'color')!;
    const updated = await editMolecularDocumentParameters(scene, result.sceneSha256, [
      { path: color.path, value: '#112233' },
    ]);
    expect(updated).toContain('#112233');
    expect(updated.replace('#112233', '#ff0000')).toBe(scene);
    expect(scene).toContain('#ff0000');
  });
  it('rejects stale content, unsupported paths and invalid values before changing a document', async () => {
    const result = await inspectMolecularDocumentParameters(scene, { limit: 256 });
    const color = result.parameters.find((p) => p.nodeKind === 'color' && p.name === 'color')!;
    await expect(
      editMolecularDocumentParameters(scene, '0'.repeat(64), [
        { path: color.path, value: '#ffffff' },
      ])
    ).rejects.toThrow(/changed/);
    await expect(
      editMolecularDocumentParameters(scene, result.sceneSha256, [
        { path: '/root/params/__proto__', value: { bad: true } },
      ])
    ).rejects.toThrow(/Invalid/);
    await expect(
      editMolecularDocumentParameters(scene, result.sceneSha256, [
        { path: color.path, value: { arbitrary: 'invalid color' } },
      ])
    ).rejects.toThrow(/Invalid color/);
  });
});
