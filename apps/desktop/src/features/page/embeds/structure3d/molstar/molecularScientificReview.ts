import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import { ensureMolViewSpecViewIds } from '../utils/molViewSpecStory';
import { molViewSpecColorGroups, type MolViewSpecColorGroup } from './molViewSpecLegend';
import {
  molecularScientificReviewInputSchema,
  molecularScientificReviewSchema,
  molecularScientificReviewScreenshotSchema as screenshotSchema,
  molecularQuestionCoverageGuidance,
  type MolecularScientificReview,
  type MolecularScientificReviewScreenshot as ScreenshotReceipt,
} from './molecularScientificReviewSchema';

type ReviewGroup = Pick<MolViewSpecColorGroup, 'id' | 'label'>;

const screenshots = new WeakMap<
  object,
  {
    sceneDigestSha256: string;
    steps: Map<number, { receipt: ScreenshotReceipt; groups?: ReviewGroup[] }>;
  }
>();

export function invalidateMolecularScientificReview(plugin: object): void {
  screenshots.delete(plugin);
}

export async function molecularScientificDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reviewError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function stepCamera(scene: string, index: number) {
  const document = JSON.parse(scene);
  const root = document.kind === 'multiple' ? document.snapshots[index]?.root : document.root;
  const camera = root?.children?.find((node: { kind?: string }) => node.kind === 'camera')?.params;
  if (!camera)
    reviewError(
      'MVS_SCIENTIFIC_REVIEW_CAMERA_REQUIRED',
      `Write the verified camera into final story step ${index} before reviewing it.`
    );
  return screenshotSchema.shape.stepCamera.parse(camera);
}

function renderedStepCamera(camera: ScreenshotReceipt['stepCamera']) {
  const direction = Vec3.sub(
    Vec3(),
    Vec3.fromArray(Vec3(), camera.target, 0),
    Vec3.fromArray(Vec3(), camera.position, 0)
  );
  const up = Vec3.orthogonalize(Vec3(), direction, Vec3.fromArray(Vec3(), camera.up, 0));
  return { ...camera, up: Array.from(up) };
}

export async function molecularScientificReviewInventory(
  scene: string,
  plugin?: object,
  activeStep?: { index: number; groups: readonly ReviewGroup[] }
) {
  const document = JSON.parse(scene);
  const roots: Array<{ root: unknown; metadata?: { title?: string } }> =
    document.kind === 'multiple' ? document.snapshots : [{ root: document.root }];
  const sceneDigestSha256 = await molecularScientificDigest(scene);
  const recorded = plugin ? screenshots.get(plugin) : undefined;
  return {
    version: 1 as const,
    sceneDigestSha256,
    requiredForTrials: true,
    questionCoverageRequiredForTrials: true,
    guidance:
      'For trial saves, provide scientificReview for this exact scene: every step needs a fresh mol_capture_screenshot receipt, its question claim, coordinate evidence and limitation, and a biologicalRole for every exact group ID below. Assess continuity across steps. Captures and schema coverage do not establish biological truth. ' +
      molecularQuestionCoverageGuidance,
    steps: roots.map((snapshot, index) => ({
      index,
      title: snapshot.metadata?.title ?? `View ${index + 1}`,
      groups: (
        (activeStep?.index === index ? activeStep.groups : undefined) ??
        (recorded?.sceneDigestSha256 === sceneDigestSha256
          ? recorded.steps.get(index)?.groups
          : undefined) ??
        molViewSpecColorGroups(scene, index)
      ).map(({ id, label }) => ({ id, label })),
    })),
  };
}

export async function recordMolecularScientificScreenshot(
  plugin: object,
  scene: string,
  index: number,
  camera: unknown,
  image: string,
  capturedScene = scene,
  nativeGroups?: readonly ReviewGroup[]
): Promise<ScreenshotReceipt> {
  const sceneDigestSha256 = await molecularScientificDigest(scene);
  let recorded = screenshots.get(plugin);
  if (recorded?.sceneDigestSha256 !== sceneDigestSha256) {
    recorded = { sceneDigestSha256, steps: new Map() };
    screenshots.set(plugin, recorded);
  }
  const receipt = screenshotSchema.parse({
    id: crypto.randomUUID(),
    sceneDigestSha256,
    index,
    cameraDigestSha256: await molecularScientificDigest(JSON.stringify(camera)),
    stepCamera: stepCamera(capturedScene, index),
    imageDigestSha256: await molecularScientificDigest(image),
    capturedAt: Date.now(),
  });
  recorded.steps.set(index, {
    receipt,
    groups: nativeGroups?.map(({ id, label }) => ({ id, label })),
  });
  return receipt;
}

export async function prepareMolecularScientificReviewForSave(
  plugin: object,
  review: unknown,
  scene: string,
  savedScene: string,
  activeIndex: number,
  camera: unknown
): Promise<{ scene: string; scientificReview: MolecularScientificReview | undefined }> {
  if (review === undefined) return { scene: savedScene, scientificReview: undefined };
  const parsed = molecularScientificReviewInputSchema.parse(review);
  const sceneDigestSha256 = await molecularScientificDigest(scene);
  if (parsed.sceneDigestSha256 !== sceneDigestSha256)
    reviewError('MVS_SCIENTIFIC_REVIEW_STALE', 'The scene changed after its scientific review.');
  const recorded = screenshots.get(plugin);
  const document = JSON.parse(savedScene);
  const roots: Array<{ children?: Array<{ kind: string; params?: unknown }> }> =
    document.kind === 'multiple'
      ? document.snapshots.map((snapshot: { root: unknown }) => snapshot.root)
      : [document.root];
  for (const [index, root] of roots.entries()) {
    const assessment = parsed.steps.find((step) => step.index === index);
    const receipt = recorded?.steps.get(index)?.receipt;
    if (
      !assessment ||
      !receipt ||
      recorded?.sceneDigestSha256 !== sceneDigestSha256 ||
      receipt.id !== assessment.screenshotReceiptId
    )
      reviewError(
        'MVS_SCIENTIFIC_REVIEW_SCREENSHOT_REQUIRED',
        `Capture and review a fresh screenshot of final step ${index}.`
      );
    root.children ??= [];
    if (!root.children.some((node) => node.kind === 'camera'))
      root.children.push({ kind: 'camera', params: structuredClone(receipt.stepCamera) });
  }
  const canonicalScene = ensureMolViewSpecViewIds(JSON.stringify(document));
  const scientificReview = await validateMolecularScientificReview(
    plugin,
    parsed,
    scene,
    canonicalScene,
    activeIndex,
    camera
  );
  return { scene: canonicalScene, scientificReview };
}

export async function validateMolecularScientificReview(
  plugin: object,
  review: unknown,
  scene: string,
  savedScene: string,
  activeIndex: number,
  camera: unknown
): Promise<MolecularScientificReview | undefined> {
  if (review === undefined) return undefined;
  const parsed = molecularScientificReviewInputSchema.parse(review);
  const inventory = await molecularScientificReviewInventory(scene, plugin);
  if (parsed.sceneDigestSha256 !== inventory.sceneDigestSha256)
    reviewError('MVS_SCIENTIFIC_REVIEW_STALE', 'The scene changed after its scientific review.');
  if (
    parsed.steps.length !== inventory.steps.length ||
    new Set(parsed.steps.map((step) => step.index)).size !== inventory.steps.length
  )
    reviewError('MVS_SCIENTIFIC_REVIEW_INCOMPLETE', 'Review every final story step exactly once.');
  if (parsed.questionCoverage) {
    const stepIndices = new Set(inventory.steps.map((step) => step.index));
    for (const item of [
      ...parsed.questionCoverage.directEvidence,
      ...parsed.questionCoverage.supportingEvidence,
    ])
      if (!stepIndices.has(item.stepIndex))
        reviewError(
          'MVS_SCIENTIFIC_REVIEW_COVERAGE_STEP_INVALID',
          `Question coverage refers to nonexistent final story step ${item.stepIndex}.`
        );
  }
  const recorded = screenshots.get(plugin);
  const verified: ScreenshotReceipt[] = [];
  for (const step of inventory.steps) {
    const assessment = parsed.steps.find((item) => item.index === step.index);
    if (!assessment)
      reviewError('MVS_SCIENTIFIC_REVIEW_INCOMPLETE', `Missing review for step ${step.index}.`);
    const actualGroups = new Set(step.groups.map((group) => group.id));
    if (
      assessment.groups.length !== actualGroups.size ||
      new Set(assessment.groups.map((group) => group.id)).size !== actualGroups.size ||
      assessment.groups.some((group) => !actualGroups.has(group.id))
    )
      reviewError(
        'MVS_SCIENTIFIC_REVIEW_INCOMPLETE',
        `Assess the biological role of every exact display group in step ${step.index}.`
      );
    const receipt = recorded?.steps.get(step.index)?.receipt;
    if (
      !receipt ||
      recorded?.sceneDigestSha256 !== inventory.sceneDigestSha256 ||
      receipt.id !== assessment.screenshotReceiptId
    )
      reviewError(
        'MVS_SCIENTIFIC_REVIEW_SCREENSHOT_REQUIRED',
        `Capture and review a fresh screenshot of final step ${step.index}.`
      );
    if (
      step.index === activeIndex &&
      receipt.cameraDigestSha256 !== (await molecularScientificDigest(JSON.stringify(camera)))
    )
      reviewError(
        'MVS_SCIENTIFIC_REVIEW_STALE',
        'The active camera changed after its reviewed screenshot.'
      );
    const savedCamera = renderedStepCamera(stepCamera(savedScene, step.index));
    const reviewedCamera = renderedStepCamera(receipt.stepCamera);
    for (const key of ['target', 'position', 'up'] as const)
      if (savedCamera[key].some((value, i) => Math.abs(value - reviewedCamera[key][i]) > 0.000001))
        reviewError(
          'MVS_SCIENTIFIC_REVIEW_STALE',
          `The saved camera for step ${step.index} differs from its reviewed screenshot. Apply the verified camera to the final scene and capture again.`
        );
    verified.push(receipt);
  }
  return molecularScientificReviewSchema.parse({
    ...parsed,
    savedSceneDigestSha256: await molecularScientificDigest(savedScene),
    screenshots: verified,
  });
}
