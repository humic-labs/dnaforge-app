import { describe, expect, it } from 'vitest';
import {
  molecularScientificDigest,
  molecularScientificReviewInventory,
  prepareMolecularScientificReviewForSave,
  recordMolecularScientificScreenshot,
  validateMolecularScientificReview,
  invalidateMolecularScientificReview,
} from './molecularScientificReview';

const camera = { target: [0, 0, 0], position: [0, 0, 30], up: [0, 1, 0], near: 1 };
function scene() {
  const root = {
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
                ref: 'source-1',
                params: { type: 'model' },
                children: [
                  {
                    kind: 'component',
                    params: { selector: 'protein' },
                    children: [
                      {
                        kind: 'representation',
                        params: { type: 'cartoon' },
                        children: [
                          {
                            kind: 'color',
                            params: { color: '#448899' },
                            custom: { dnaforge_legend_label: 'Protein scaffold' },
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
      { kind: 'camera', params: camera },
    ],
  };
  return JSON.stringify({
    kind: 'multiple',
    metadata: { version: '1' },
    snapshots: [
      { root, metadata: { title: 'Context' } },
      { root: structuredClone(root), metadata: { title: 'Relationship' } },
    ],
  });
}

async function draft() {
  const plugin = {};
  const authored = scene();
  const inventory = await molecularScientificReviewInventory(authored);
  const receipts = await Promise.all(
    inventory.steps.map(({ index }) =>
      recordMolecularScientificScreenshot(plugin, authored, index, camera, `native-image-${index}`)
    )
  );
  const review = {
    version: 1 as const,
    sceneDigestSha256: inventory.sceneDigestSha256,
    question: 'How do these components interact?',
    steps: inventory.steps.map((step) => ({
      index: step.index,
      screenshotReceiptId: receipts[step.index].id,
      claim: 'The retained scaffold locates the local relationship.',
      evidence: 'The inspected coordinates provide the surrounding polymer path.',
      limitation: 'Static coordinates do not establish a dynamic mechanism.',
      groups: step.groups.map(({ id }) => ({
        id,
        biologicalRole: 'Surrounding protein scaffold.',
      })),
    })),
    continuity: {
      assessment: 'The same scaffold identity persists across both steps.',
      limitation: 'These views alone do not establish contact energetics.',
    },
    revision: { findings: [], changes: [], unresolved: [] },
  };
  return { plugin, authored, inventory, review };
}

describe('scientific review bound to final molecular scenes', () => {
  it('requires fresh receipts after a source rebind even when scene text is unchanged', async () => {
    const f = await draft();
    invalidateMolecularScientificReview(f.plugin);
    await expect(
      prepareMolecularScientificReviewForSave(f.plugin, f.review, f.authored, f.authored, 0, camera)
    ).rejects.toThrow(/fresh.*screenshot/i);
  });
  it('uses captured native owners for inactive-step inventory and save coverage without changing offline parsing', async () => {
    const f = await draft();
    const document = JSON.parse(f.authored);
    for (const snapshot of document.snapshots) {
      const component = snapshot.root.children[0].children[0].children[0].children[0];
      const owner = component.children[0].children[0];
      owner.custom.dnaforge_molecular_identity = 'Scientific scaffold';
      const surface = structuredClone(component.children[0]);
      surface.params.type = 'surface';
      surface.custom = { dnaforge_presentation_generated: 'binding-site' };
      surface.children[0].custom.dnaforge_binding_scope = 'site';
      component.children.push(surface);
    }
    const authored = JSON.stringify(document);
    const offline = await molecularScientificReviewInventory(authored);
    expect(offline.steps.map((step) => step.groups.length)).toEqual([2, 2]);
    const nativeGroups = [offline.steps[0].groups[0]];
    const active = await molecularScientificReviewInventory(authored, f.plugin, {
      index: 0,
      groups: nativeGroups,
    });
    expect(active.steps.map((step) => step.groups.length)).toEqual([1, 2]);
    const receipts = [];
    for (const step of offline.steps)
      receipts.push(
        await recordMolecularScientificScreenshot(
          f.plugin,
          authored,
          step.index,
          camera,
          `normalized-owner-image-${step.index}`,
          authored,
          nativeGroups
        )
      );
    const captured = await molecularScientificReviewInventory(authored, f.plugin);
    expect(captured.steps.map((step) => step.groups)).toEqual([nativeGroups, nativeGroups]);
    const review = {
      ...f.review,
      sceneDigestSha256: offline.sceneDigestSha256,
      steps: f.review.steps.map((step) => ({
        ...step,
        screenshotReceiptId: receipts[step.index].id,
      })),
    };
    await expect(
      prepareMolecularScientificReviewForSave(f.plugin, review, authored, authored, 1, camera)
    ).resolves.toMatchObject({ scientificReview: { steps: review.steps } });
    await expect(
      validateMolecularScientificReview(
        f.plugin,
        {
          ...review,
          steps: review.steps.map((step) => ({
            ...step,
            groups: offline.steps[step.index].groups.map(({ id }) => ({
              id,
              biologicalRole: 'Scaffold owner.',
            })),
          })),
        },
        authored,
        authored,
        1,
        camera
      )
    ).rejects.toThrow('every exact display group');
    nativeGroups[0].label = 'Caller mutation';
    expect(
      (await molecularScientificReviewInventory(authored, f.plugin)).steps[0].groups[0].label
    ).toBe('Protein scaffold');
    for (const inventory of [
      await molecularScientificReviewInventory(authored),
      await molecularScientificReviewInventory(authored, {}),
      await molecularScientificReviewInventory(authored + ' ', f.plugin),
    ])
      expect(inventory.steps.map((step) => step.groups.length)).toEqual([2, 2]);
  });

  it('saves both verified cameras when only the active story step has a camera node', async () => {
    const f = await draft();
    const document = JSON.parse(f.authored);
    for (const snapshot of document.snapshots)
      snapshot.root.children = snapshot.root.children.filter(
        (node: { kind: string }) => node.kind !== 'camera'
      );
    const authored = JSON.stringify(document);
    const inventory = await molecularScientificReviewInventory(authored);
    const cameras = [camera, { ...camera, position: [30, 0, 0], up: [0, 1, 0] }];
    const receipts = [];
    for (const step of inventory.steps) {
      const captured = structuredClone(document);
      captured.snapshots[step.index].root.children.push({
        kind: 'camera',
        params: cameras[step.index],
      });
      receipts.push(
        await recordMolecularScientificScreenshot(
          f.plugin,
          authored,
          step.index,
          cameras[step.index],
          `final-native-image-${step.index}`,
          JSON.stringify(captured)
        )
      );
    }
    const review = {
      ...f.review,
      sceneDigestSha256: inventory.sceneDigestSha256,
      steps: f.review.steps.map((step) => ({
        ...step,
        screenshotReceiptId: receipts[step.index].id,
      })),
    };
    const saved = structuredClone(document);
    saved.snapshots[0].root.children.push({ kind: 'camera', params: cameras[0] });
    await expect(
      validateMolecularScientificReview(
        f.plugin,
        review,
        authored,
        JSON.stringify(saved),
        0,
        cameras[0]
      )
    ).rejects.toThrow('verified camera into final story step 1');
    const prepared = await prepareMolecularScientificReviewForSave(
      f.plugin,
      review,
      authored,
      JSON.stringify(saved),
      0,
      cameras[0]
    );
    expect(
      JSON.parse(prepared.scene).snapshots.map(
        (snapshot: (typeof saved.snapshots)[0]) =>
          snapshot.root.children.find((node: { kind: string }) => node.kind === 'camera').params
      )
    ).toEqual(cameras);
    expect(prepared.scientificReview?.savedSceneDigestSha256).toBe(
      await molecularScientificDigest(prepared.scene)
    );
    expect(
      document.snapshots.every((snapshot: (typeof saved.snapshots)[0]) =>
        snapshot.root.children.every((node: { kind: string }) => node.kind !== 'camera')
      )
    ).toBe(true);
    saved.snapshots[1].root.children.push({
      kind: 'camera',
      params: { ...cameras[1], position: [35, 0, 0] },
    });
    await expect(
      prepareMolecularScientificReviewForSave(
        f.plugin,
        review,
        authored,
        JSON.stringify(saved),
        0,
        cameras[0]
      )
    ).rejects.toThrow('differs from its reviewed screenshot');
  });

  it('accounts for direct and supporting evidence using actual final steps while preserving honest unanswered requirements', async () => {
    const f = await draft();
    const questionCoverage = {
      relationship: 'The relationship between the supplied components.',
      directEvidence: [{ stepIndex: 1, evidence: 'The opposing regions are visible together.' }],
      supportingEvidence: [
        { stepIndex: 0, evidence: 'The fold locates that relationship.' },
        { stepIndex: 0, evidence: 'The same image identifies the surrounding assembly.' },
      ],
      unanswered: [],
    };
    await expect(
      validateMolecularScientificReview(
        f.plugin,
        { ...f.review, questionCoverage },
        f.authored,
        f.authored,
        1,
        camera
      )
    ).resolves.toMatchObject({ questionCoverage });
    await expect(
      validateMolecularScientificReview(
        f.plugin,
        {
          ...f.review,
          questionCoverage: {
            ...questionCoverage,
            directEvidence: [],
            unanswered: ['Only the supporting mechanism is shown; direct geometry is absent.'],
          },
        },
        f.authored,
        f.authored,
        1,
        camera
      )
    ).resolves.toMatchObject({
      questionCoverage: { directEvidence: [], unanswered: [expect.any(String)] },
    });
    await expect(
      validateMolecularScientificReview(
        f.plugin,
        { ...f.review, questionCoverage: { ...questionCoverage, directEvidence: [] } },
        f.authored,
        f.authored,
        1,
        camera
      )
    ).rejects.toThrow('direct question evidence or an explicit unanswered requirement');
    await expect(
      validateMolecularScientificReview(
        f.plugin,
        {
          ...f.review,
          questionCoverage: {
            ...questionCoverage,
            directEvidence: [{ stepIndex: 4, evidence: 'An image that does not exist.' }],
          },
        },
        f.authored,
        f.authored,
        1,
        camera
      )
    ).rejects.toThrow('final story step 4');
  });

  it('persists each exact step/group role and verified native screenshot without claiming scientific correctness', async () => {
    const f = await draft();
    expect(f.inventory.steps[0].groups).toEqual([
      { id: expect.any(String), label: 'Protein scaffold' },
    ]);
    const verified = await validateMolecularScientificReview(
      f.plugin,
      f.review,
      f.authored,
      f.authored,
      1,
      camera
    );
    expect(verified).toMatchObject({
      question: f.review.question,
      steps: f.review.steps,
      revision: f.review.revision,
      savedSceneDigestSha256: f.inventory.sceneDigestSha256,
      screenshots: [{ index: 0 }, { index: 1 }],
    });
    expect(verified).not.toHaveProperty('scientificallyCorrect');
  });

  it('rejects an omitted step, omitted group, or duplicate group', async () => {
    const f = await draft();
    await expect(
      validateMolecularScientificReview(
        f.plugin,
        { ...f.review, steps: f.review.steps.slice(0, 1) },
        f.authored,
        f.authored,
        1,
        camera
      )
    ).rejects.toThrow('every final story step');
    for (const groups of [[], [f.review.steps[0].groups[0], f.review.steps[0].groups[0]]])
      await expect(
        validateMolecularScientificReview(
          f.plugin,
          { ...f.review, steps: [{ ...f.review.steps[0], groups }, f.review.steps[1]] },
          f.authored,
          f.authored,
          1,
          camera
        )
      ).rejects.toThrow('every exact display group');
  });

  it("rejects fabricated, stale, or another viewer's screenshot receipts", async () => {
    const f = await draft();
    await expect(
      validateMolecularScientificReview({}, f.review, f.authored, f.authored, 1, camera)
    ).rejects.toThrow('fresh screenshot');
    await recordMolecularScientificScreenshot(f.plugin, f.authored, 0, camera, 'new native image');
    await expect(
      validateMolecularScientificReview(f.plugin, f.review, f.authored, f.authored, 1, camera)
    ).rejects.toThrow('fresh screenshot');
  });

  it('invalidates review when the final scene or active camera changes', async () => {
    const f = await draft();
    await expect(
      validateMolecularScientificReview(f.plugin, f.review, f.authored + ' ', f.authored, 1, camera)
    ).rejects.toThrow('scene changed');
    await expect(
      validateMolecularScientificReview(f.plugin, f.review, f.authored, f.authored, 1, {
        ...camera,
        position: [0, 0, 80],
      })
    ).rejects.toThrow('active camera changed');
  });

  it('rejects a screenshot camera that was never applied to an inactive saved step', async () => {
    const f = await draft();
    const changed = JSON.parse(f.authored);
    changed.snapshots[0].root.children.at(-1).params.position = [0, 0, 80];
    const receipt = await recordMolecularScientificScreenshot(
      f.plugin,
      f.authored,
      0,
      { ...camera, position: [0, 0, 80] },
      'temporarily focused image',
      JSON.stringify(changed)
    );
    f.review.steps[0].screenshotReceiptId = receipt.id;
    await expect(
      validateMolecularScientificReview(f.plugin, f.review, f.authored, f.authored, 1, camera)
    ).rejects.toThrow('differs from its reviewed screenshot');
  });

  it('accepts Molstar-normalized orientation without requiring another capture cycle', async () => {
    const f = await draft();
    const document = JSON.parse(f.authored);
    document.snapshots[0].root.children.at(-1).params.up = [0, 3, 4];
    const authored = JSON.stringify(document);
    const inventory = await molecularScientificReviewInventory(authored);
    const captured = JSON.parse(authored);
    captured.snapshots[0].root.children.at(-1).params.up = [0, 1, 0];
    const receipts = await Promise.all(
      [0, 1].map((index) =>
        recordMolecularScientificScreenshot(
          f.plugin,
          authored,
          index,
          camera,
          `normalized-native-image-${index}`,
          JSON.stringify(captured)
        )
      )
    );
    const review = {
      ...f.review,
      sceneDigestSha256: inventory.sceneDigestSha256,
      steps: f.review.steps.map((step) => ({
        ...step,
        screenshotReceiptId: receipts[step.index].id,
      })),
    };
    await expect(
      validateMolecularScientificReview(f.plugin, review, authored, authored, 1, camera)
    ).resolves.toMatchObject({ screenshots: [{ index: 0 }, { index: 1 }] });

    captured.snapshots[0].root.children.at(-1).params.up = [1, 0, 0];
    const rotated = await recordMolecularScientificScreenshot(
      f.plugin,
      authored,
      0,
      { ...camera, up: [1, 0, 0] },
      'rotated-native-image',
      JSON.stringify(captured)
    );
    review.steps[0].screenshotReceiptId = rotated.id;
    await expect(
      validateMolecularScientificReview(f.plugin, review, authored, authored, 1, camera)
    ).rejects.toThrow('differs from its reviewed screenshot');
  });

  it('preserves optional generic saves and rejects empty biological-role statements', async () => {
    const f = await draft();
    await expect(
      validateMolecularScientificReview({}, undefined, f.authored, f.authored, 0, camera)
    ).resolves.toBeUndefined();
    f.review.steps[0].groups[0].biologicalRole = ' ';
    await expect(
      validateMolecularScientificReview(f.plugin, f.review, f.authored, f.authored, 0, camera)
    ).rejects.toThrow();
  });
});
