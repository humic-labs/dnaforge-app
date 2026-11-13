import { getChatTurns, getMessageReferencesForMessages, getMessages } from '../../db';
import { getEntityReferencesByIds } from '../../db/entity-references';
import { useCanvasStore } from '../canvas/public/store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { rendererSidecarRequestAuthorityState } from '../../services/sidecar-session';
import type { AgentCliModelReasoningEffort } from '../../platform';
import type {
  ProteinExperimentWorkersApi,
  ProteinExperimentWorkerLease,
  ReviewRoundRequest,
} from '../../shared/protein-experiment-workers';
import { runMolecularExperimentQueue } from './molecular-experiment-queue';
import {
  inspectMolecularRoundCompletion,
  requireMolecularRoundCompletion,
  molecularRoundSlotKey,
} from './molecular-round-completion';
import constructionSources from './molecular-construction-review';
import {
  createMolecularRoundReview,
  molecularRoundReviewSchema,
  requireCurrentMolecularRoundReview,
  type MolecularRoundDecisions,
  type MolecularRoundReview,
} from './molecular-round-review';
import {
  prepareMolecularTrialFixtures,
  molecularTrialSceneResourcesChanged,
} from './molecular-trial-fixtures';
import {
  currentMolecularRenderProfile,
  molecularRenderProfileSelectionSchema,
  type MolecularRenderProfileSelection,
} from '../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import {
  saveMolecularPromptTrialResult,
  saveMolecularPromptTrialStart,
  type MolecularPromptTrialResult,
  listMolecularPromptTrialStarts,
  listMolecularPromptTrialResults,
} from '../../db/molecular-prompt-trials';
import { useChatStore } from './hooks/useChat';
import {
  coordinateDigest,
  molecularViewAttrs,
  molecularViewFromReferenceData,
  molecularViewSourceDigests,
  validateMolecularViewCoordinates,
} from '../page/public/embeds/structure3d/molecularView';
import {
  molecularBenchmarkCase,
  type MolecularBenchmarkCaseId,
} from './molecular-comparison-profiles';
import {
  createMolecularPromptTrial,
  clearMolecularPromptTrialIsolation,
  molecularSceneCameraSignature,
  molecularSceneStructureSignature,
  molecularTrialUnexpectedTools,
  molecularTrialAllowedTools,
  molecularTrialUncheckedNamedGroups,
  molecularTrialWrongViewTargets,
  molecularTrialReasoningEffortSchema,
  molecularTrialFixtureTarget,
  readMolecularTrialSentPromptSnapshot,
  writeMolecularPromptTrial,
  type MolecularPromptTrial,
  type MolecularPromptTrialFixture,
  type MolecularPromptVariant,
  type MolecularTrialSentPromptSnapshot,
} from './molecular-prompt-trials';
import { resolveMolecularDocumentResult } from '../molecular-documents/public/references';

export type MolecularBatchProgress = {
  index: number;
  total: number;
  label: string;
  stage: 'opening' | 'running' | 'recorded';
  status?: MolecularPromptTrialResult['status'];
};

export type MolecularBatchInput = {
  caseId: MolecularBenchmarkCaseId;
  fixtureSelection: Record<string, string>;
  additionalCases?: Array<{
    caseId: MolecularBenchmarkCaseId;
    fixtureSelection: Record<string, string>;
  }>;
  variants: MolecularPromptVariant[];
  reasoningEffortByVariant?: Record<string, AgentCliModelReasoningEffort>;
  repeats?: number;
  attempts?: Array<{ caseId: MolecularBenchmarkCaseId; variantId: string; replicate: number }>;
  experimentId?: string;
  recoveryOfExperimentId?: string;
  concurrency?: number;
  renderProfile?: MolecularRenderProfileSelection;
  roundReview?: MolecularRoundReview;
  admissionMode?: 'full-round' | 'experiment';
  sourceCommit?: string;
  notebookPageId: string;
  onProgress?: (progress: MolecularBatchProgress) => void;
};

let batchInFlight = false;

export function molecularBatchAdmission(
  input: MolecularBatchInput,
  roundReview: MolecularRoundReview,
  experimentId: string,
  requiredSlots: Array<{ caseId: MolecularBenchmarkCaseId; variantId: string; replicate: number }>
): ReviewRoundRequest {
  const mode = input.admissionMode ?? 'full-round';
  if (mode === 'experiment' && requiredSlots.length !== 1)
    throw new Error('ONE_OFF_EXPERIMENT_REQUIRED: An experiment contains one unscored attempt.');
  if (input.sourceCommit !== undefined && !/^[a-f0-9]{40}$/.test(input.sourceCommit))
    throw new Error('ROUND_SOURCE_REQUIRED: Invalid frozen source commit.');
  const slots = requiredSlots.map(molecularRoundSlotKey);
  return {
    runId: experimentId,
    mode,
    slots,
    frozen: JSON.stringify({
      version: 1,
      experimentId,
      mode,
      sourceCommit: input.sourceCommit ?? null,
      variants: input.variants,
      requiredSlots,
      systemPromptSha256: roundReview.systemPromptSha256,
      runPlanSha256: roundReview.runPlanSha256,
      corpusSha256: roundReview.corpusSha256,
      decisions: roundReview.decisions,
    }),
  };
}

function sharedProviderUnavailable(error: string | null | undefined): boolean {
  return /you[’']ve hit your usage limit|not authenticated|access token could not be refreshed/i.test(
    error ?? ''
  );
}

function validateMolecularBatchReasoningEfforts(input: MolecularBatchInput): void {
  const efforts = input.reasoningEffortByVariant;
  if (efforts === undefined) return;
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts))
    throw new Error('Protein trial reasoning efforts must be a map of selected variant IDs.');
  const variantIds = new Set(input.variants.map((variant) => variant.id));
  for (const [variantId, effort] of Object.entries(efforts)) {
    if (!variantIds.has(variantId))
      throw new Error(`Reasoning effort names an unselected prompt variant: ${variantId}.`);
    molecularTrialReasoningEffortSchema.parse(effort);
  }
}

type PinnedBatchInputs = Map<
  MolecularBenchmarkCaseId,
  Awaited<ReturnType<typeof resolveMolecularTrialFixtures>>
>;
async function readPinnedBatchInputs(input: MolecularBatchInput): Promise<PinnedBatchInputs> {
  const cases = [
    { caseId: input.caseId, fixtureSelection: input.fixtureSelection },
    ...(input.additionalCases ?? []),
  ];
  return new Map(
    await Promise.all(
      cases.map(
        async (item) =>
          [
            item.caseId,
            await resolveMolecularTrialFixtures(item.caseId, item.fixtureSelection),
          ] as const
      )
    )
  );
}

export async function prepareMolecularBatchRoundReview(
  input: MolecularBatchInput,
  decisions: MolecularRoundDecisions
): Promise<MolecularRoundReview> {
  validateMolecularBatchReasoningEfforts(input);
  return reviewPinnedBatchInputs(input, decisions, await readPinnedBatchInputs(input));
}

async function reviewPinnedBatchInputs(
  input: MolecularBatchInput,
  decisions: MolecularRoundDecisions,
  pinned: PinnedBatchInputs
): Promise<MolecularRoundReview> {
  const [starts, results, prompt] = await Promise.all([
    listMolecularPromptTrialStarts(),
    listMolecularPromptTrialResults(),
    import('./prompts/system-prompt'),
  ]);
  const selectedProfile = molecularRenderProfileSelectionSchema.parse(
    input.renderProfile ?? 'default'
  );
  return createMolecularRoundReview(
    { starts, results },
    prompt.BASE_SYSTEM_PROMPT,
    {
      cases: [
        { caseId: input.caseId, fixtureSelection: input.fixtureSelection },
        ...(input.additionalCases ?? []),
      ].map((item) => ({
        ...item,
        benchmark: molecularBenchmarkCase(item.caseId),
        fixtures: pinned.get(item.caseId)!.map((source) => source.fixture),
      })),
      variants: input.variants,
      reasoningEffortByVariant: input.reasoningEffortByVariant ?? null,
      repeats: input.repeats ?? 1,
      concurrency: input.concurrency ?? 16,
      attempts: input.attempts ?? null,
      recoveryOfExperimentId: input.recoveryOfExperimentId ?? null,
      admissionMode: input.admissionMode ?? 'full-round',
      sourceCommit: input.sourceCommit ?? null,
      renderProfile:
        selectedProfile === 'default' ? currentMolecularRenderProfile() : selectedProfile,
      allowedTools: molecularTrialAllowedTools(),
      constructionSources,
      harness: [
        createMolecularPromptTrial.toString(),
        validateMolecularBatchReasoningEfforts.toString(),
        readPinnedBatchInputs.toString(),
        reviewPinnedBatchInputs.toString(),
        resolveMolecularTrialFixtures.toString(),
        runMolecularPromptBatch.toString(),
        prepareMolecularTrialFixtures.toString(),
        molecularTrialSceneResourcesChanged.toString(),
        molecularTrialUnexpectedTools.toString(),
        molecularTrialUncheckedNamedGroups.toString(),
        recordTrial.toString(),
        sharedProviderUnavailable.toString(),
        molecularTrialComparisonRouteKey.toString(),
        molecularViewSourceDigests.toString(),
        runMolecularExperimentQueue.toString(),
      ],
    },
    decisions
  );
}

async function waitForTerminalTurn(conversationId: string): Promise<void> {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const turns = await getChatTurns(conversationId);
    if (turns.some((turn) => turn.status !== 'running')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    'The agent turn is still running after 12 minutes. The batch stopped before changing the shared viewer.'
  );
}

export function molecularTrialComparisonRouteKey(
  trial: MolecularPromptTrial,
  routeKey: string | null,
  snapshot: MolecularTrialSentPromptSnapshot | null
): string | null {
  const assignedEffort = trial.execution?.reasoningEffort;
  if (assignedEffort === undefined) return routeKey;
  const configuration = snapshot?.agentConfiguration;
  if (
    !routeKey ||
    configuration?.transport !== 'codex-sdk' ||
    configuration.reasoningEffort !== assignedEffort
  )
    return null;
  try {
    const route: unknown = JSON.parse(routeKey);
    if (
      !Array.isArray(route) ||
      route.length !== 8 ||
      JSON.stringify(route[7]) !== JSON.stringify(configuration)
    )
      return null;
    return JSON.stringify([
      ...route.slice(0, 7),
      { ...configuration, reasoningEffort: 'explicit-trial-contrast' },
    ]);
  } catch {
    return null;
  }
}

async function recordTrial(
  trial: MolecularPromptTrial,
  comparisonAnchors: Map<MolecularBenchmarkCaseId, MolecularPromptTrialResult>,
  stopDispatch: AbortController
): Promise<MolecularPromptTrialResult> {
  const [messages, turns] = await Promise.all([
    getMessages(trial.conversationId),
    getChatTurns(trial.conversationId),
  ]);
  const turn = turns[turns.length - 1];
  if (turn?.status === 'failed' && sharedProviderUnavailable(turn.error)) stopDispatch.abort();
  const sentPrompt = readMolecularTrialSentPromptSnapshot(trial.conversationId);
  const promptSnapshot = sentPrompt?.turnId === turn?.id ? sentPrompt : null;
  if (!promptSnapshot?.scenePolicy)
    throw new Error('The app did not capture this turn’s exact sent prompt and scene rules.');

  const userMessages = messages.filter((message) => message.role === 'user');
  const unexpectedTools = molecularTrialUnexpectedTools(messages);
  const wrongTargets = molecularTrialWrongViewTargets(
    messages,
    trial.fixtures.map(molecularTrialFixtureTarget)
  );
  const referenceIdsByMessage = await getMessageReferencesForMessages(
    messages.map((message) => message.id)
  );
  const referenceIds = [
    ...new Set(messages.flatMap((message) => referenceIdsByMessage.get(message.id) ?? [])),
  ];
  const references = await getEntityReferencesByIds(referenceIds);
  const renderedViews = (
    await Promise.all(
      references.map(async (row) => {
        const view =
          row.entity_type === 'molecular-document'
            ? (await resolveMolecularDocumentResult(row.id)).snapshot
            : row.entity_type === 'structure'
              ? molecularViewFromReferenceData(row.data)
              : null;
        return view ? [{ row, view }] : [];
      })
    )
  ).flat();
  const selectedViews = [
    ...new Map(
      trial.fixtures.flatMap((pinned) => {
        const found = [...renderedViews]
          .reverse()
          .find(
            ({ view }) =>
              trial.fixtures.some((f) => f.coordinateSha256 === view.coordinates.sha256) &&
              molecularViewSourceDigests(view).includes(pinned.coordinateSha256)
          );
        return found ? [[found.row.id, found] as const] : [];
      })
    ).values(),
  ];
  const sourceCoverage = [
    ...new Set(selectedViews.flatMap((item) => molecularViewSourceDigests(item.view))),
  ];
  const coversSources = trial.fixtures.every((fixture) =>
    sourceCoverage.includes(fixture.coordinateSha256)
  );
  const uncheckedNamedGroups = molecularTrialUncheckedNamedGroups(
    messages,
    selectedViews.flatMap((item) =>
      item
        ? [
            {
              structureViewId: molecularTrialFixtureTarget(
                trial.fixtures.find((f) => f.coordinateSha256 === item.view.coordinates.sha256)!
              ),
              scene: item.view.scene,
            },
          ]
        : []
    )
  );
  await Promise.all(
    selectedViews.flatMap((item) => (item ? [validateMolecularViewCoordinates(item.view)] : []))
  );
  const viewIds = selectedViews.flatMap((item) => (item ? [item.row.id] : []));
  const coordinateDigests = selectedViews.flatMap((item) =>
    item ? [item.view.coordinates.sha256] : []
  );
  const sceneChanged =
    selectedViews.length > 0 &&
    (
      await Promise.all(
        selectedViews.map(async (item) =>
          item
            ? (await coordinateDigest(item.view.scene)) !==
              trial.fixtures.find((f) => f.coordinateSha256 === item.view.coordinates.sha256)!
                .initialSceneSha256
            : false
        )
      )
    ).every(Boolean);
  const cameraSignatures = selectedViews.map((item) =>
    item ? molecularSceneCameraSignature(item.view.scene) : '[]'
  );
  const cameraNodePresent =
    cameraSignatures.length > 0 && cameraSignatures.every((signature) => signature !== '[]');
  const cameraChanged = cameraSignatures.some(
    (signature, index) => signature !== trial.fixtures[index].initialCameraSignature
  );
  const fixedDigests = new Set(trial.fixtures.map((fixture) => fixture.coordinateSha256));
  const coordinateResourcesChanged = selectedViews.some(
    (item) =>
      item &&
      item.view.version === 2 &&
      item.view.pinnedAssets.some((asset) => !fixedDigests.has(asset.sha256))
  );
  const structureChanged =
    coordinateResourcesChanged ||
    selectedViews.some((item) => {
      const fixture = trial.fixtures.find(
        (f) => f.coordinateSha256 === item.view.coordinates.sha256
      )!;
      return (
        item &&
        (fixture.resourceStructureSignature
          ? molecularTrialSceneResourcesChanged(item.view.scene, fixture.resourceStructureSignature)
          : fixture.structureSignature &&
            molecularSceneStructureSignature(item.view.scene) !== fixture.structureSignature)
      );
    });
  const routeKey = turn
    ? JSON.stringify([
        turn.route_kind,
        turn.host_id,
        turn.provider,
        turn.model,
        turn.transport,
        turn.authority_profile_id,
        turn.permission_mode,
        promptSnapshot.agentConfiguration ?? null,
      ])
    : null;
  const questionMismatch =
    userMessages.length !== 1 || userMessages[0]?.content.trim() !== trial.question;
  const routeMismatch = turns.length !== 1 || turn?.status !== 'completed';
  const comparisonRouteKey = molecularTrialComparisonRouteKey(trial, routeKey, promptSnapshot);
  const assignedEffortMismatch =
    trial.execution?.reasoningEffort !== undefined && !comparisonRouteKey;
  const priorComparable = comparisonAnchors.get(trial.caseId) ?? null;
  const fixedInputsChanged =
    priorComparable &&
    (priorComparable.trial.question !== trial.question ||
      priorComparable.trial.context !== trial.context ||
      JSON.stringify(priorComparable.trial.fixtures.map((item) => item.coordinateSha256)) !==
        JSON.stringify(trial.fixtures.map((item) => item.coordinateSha256)) ||
      molecularTrialComparisonRouteKey(
        priorComparable.trial,
        priorComparable.routeKey,
        priorComparable.promptSnapshot ?? null
      ) !== comparisonRouteKey ||
      JSON.stringify(priorComparable.trial.execution?.renderProfile ?? 'native') !==
        JSON.stringify(trial.execution?.renderProfile ?? 'native'));
  const status: MolecularPromptTrialResult['status'] =
    questionMismatch ||
    assignedEffortMismatch ||
    fixedInputsChanged ||
    unexpectedTools.length > 0 ||
    wrongTargets.length > 0 ||
    routeMismatch ||
    structureChanged
      ? 'noncomparable'
      : !coversSources ||
          !sceneChanged ||
          !cameraNodePresent ||
          !routeKey ||
          uncheckedNamedGroups.length > 0
        ? 'failed'
        : 'rendered';
  const observation = questionMismatch
    ? 'The chat did not contain exactly the fixed scientific question.'
    : assignedEffortMismatch
      ? 'The actual agent reasoning configuration differs from the frozen trial assignment.'
      : fixedInputsChanged
        ? 'Structure, scientific context, or agent route differs from the other batch runs.'
        : unexpectedTools.length > 0
          ? `The agent added outside context using ${unexpectedTools.join(', ')}.`
          : wrongTargets.length > 0
            ? `The agent controlled a structure outside its isolated run: ${wrongTargets.join(', ')}.`
            : routeMismatch
              ? `The agent turn ended ${turn?.status ?? 'without a recorded status'}.${turn?.error ? ` ${turn.error}` : ''}`
              : structureChanged
                ? 'The authored scene changed the fixed model or biological assembly.'
                : !coversSources
                  ? !viewIds.length
                    ? 'The completed conversation saved no structure view; chat-only output is an incomplete trial.'
                    : 'The saved scene does not include every pinned coordinate structure.'
                  : !sceneChanged
                    ? 'The saved MolViewSpec scene did not change from the fixture.'
                    : !cameraNodePresent
                      ? 'The saved MolViewSpec has no authored camera node.'
                      : !routeKey
                        ? 'No agent route was recorded.'
                        : uncheckedNamedGroups.length > 0
                          ? `Named selectable groups lack final resolved-selection readback for ${uncheckedNamedGroups.join(', ')}.`
                          : 'Saved a new camera-controlled scene on the pinned coordinates; visual quality needs review.';
  const result: MolecularPromptTrialResult = {
    trial,
    status,
    observation,
    referenceIds: viewIds,
    coordinateDigests,
    sourceCoverage,
    cameraNodePresent,
    cameraChanged,
    sceneChanged,
    routeKey,
    promptSnapshot,
    recordedAt: Date.now(),
  };
  if (result.status === 'rendered' && !comparisonAnchors.has(trial.caseId))
    comparisonAnchors.set(trial.caseId, result);
  await saveMolecularPromptTrialResult(result);
  return result;
}

export async function resolveMolecularTrialFixtures(
  caseId: MolecularBenchmarkCaseId,
  selection: Record<string, string>
): Promise<
  Array<{
    fixture: MolecularPromptTrialFixture;
    scene: string;
    view: NonNullable<ReturnType<typeof molecularViewFromReferenceData>>;
  }>
> {
  const benchmark = molecularBenchmarkCase(caseId);
  if (!benchmark) throw new Error('Choose a benchmark question.');
  const ids = benchmark.fixtureIds.map((pdbId) => selection[pdbId]);
  if (ids.some((id) => !id)) throw new Error('Pin one saved coordinate view for each structure.');
  const rows = await getEntityReferencesByIds(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return Promise.all(
    benchmark.fixtureIds.map(async (pdbId, index) => {
      const referenceId = selection[pdbId];
      const row = byId.get(referenceId);
      const document =
        row?.entity_type === 'molecular-document'
          ? await resolveMolecularDocumentResult(row.id)
          : null;
      const view =
        document?.snapshot ??
        (row?.entity_type === 'structure' ? molecularViewFromReferenceData(row.data) : null);
      const savedViewId = document
        ? `saved-view:${document.documentReference.revisionId}`
        : row?.locator?.match(/^entity:\/\/structure\/(saved-view:[^/]+)$/)?.[1];
      if (
        !row ||
        !view ||
        !savedViewId ||
        view.source.sourceId?.toUpperCase() !== pdbId ||
        molecularSceneStructureSignature(view.scene) !==
          JSON.stringify([benchmark.structureModes[index]])
      )
        throw new Error(`Pinned ${pdbId} coordinates or assembly changed.`);
      await validateMolecularViewCoordinates(view);
      return {
        view,
        scene: view.scene,
        fixture: {
          pdbId,
          referenceId,
          savedViewId,
          ...(document ? { sourceDocumentReference: document.documentReference } : {}),
          coordinateSha256: view.coordinates.sha256,
          initialSceneSha256: await coordinateDigest(view.scene),
          initialCameraSignature: molecularSceneCameraSignature(view.scene),
          structureSignature: molecularSceneStructureSignature(view.scene),
        },
      };
    })
  );
}

export async function runMolecularPromptBatch(input: MolecularBatchInput): Promise<{
  completed: number;
  rendered: number;
  experimentId: string;
  conversationIds: string[];
  workerLeases: ProteinExperimentWorkerLease[];
}> {
  const onProgress = input.onProgress;
  input = { ...structuredClone({ ...input, onProgress: undefined }), onProgress };
  if (batchInFlight) throw new Error('A protein prompt batch is already running.');
  const submittedReview = molecularRoundReviewSchema.safeParse(input.roundReview);
  if (!submittedReview.success)
    throw new Error(
      'Review the corpus, system prompt, harness and guidance before starting this round. No agent was dispatched.'
    );
  if (input.variants.length < 1) throw new Error('Select at least one prompt variant.');
  if (new Set(input.variants.map((variant) => variant.id)).size !== input.variants.length)
    throw new Error('Each selected prompt variant must be unique.');
  validateMolecularBatchReasoningEfforts(input);
  const cases = [
    { caseId: input.caseId, fixtureSelection: input.fixtureSelection },
    ...(input.additionalCases ?? []),
  ];
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length)
    throw new Error('Each scientific question must appear once in a batch.');
  const repeats = input.repeats ?? 1;
  if (!Number.isSafeInteger(repeats) || repeats < 1)
    throw new Error('The number of attempts must be a positive integer.');
  const concurrency = input.concurrency ?? 16;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('Experiment concurrency must be an integer between 1 and 16.');
  const workerApi = (
    window as Window & {
      electronAPI?: {
        proteinExperimentWorkers?: ProteinExperimentWorkersApi;
      };
    }
  ).electronAPI?.proteinExperimentWorkers;
  if (!workerApi) throw new Error('Background experiment workers require the current desktop app.');
  if ((await rendererSidecarRequestAuthorityState()) !== 'ready')
    throw new Error(
      'The analysis engine is offline. Restart it before running the comparison. No agent was dispatched.'
    );
  if (!useCanvasStore.getState().findTab('page', input.notebookPageId))
    throw new Error('Open the run notebook before starting a comparison.');
  const profileSelection = molecularRenderProfileSelectionSchema.parse(
    input.renderProfile ?? 'default'
  );
  const renderProfile = structuredClone(
    profileSelection === 'default' ? currentMolecularRenderProfile() : profileSelection
  );
  const experimentId = input.experimentId ?? crypto.randomUUID();
  const plannedJobs = Array.from({ length: repeats }, (_, index) =>
    cases.flatMap((item) =>
      input.variants.map((variant) => ({ ...item, variant, replicate: index + 1 }))
    )
  ).flat();
  const requiredSlots = plannedJobs.map((job) => ({
    caseId: job.caseId,
    variantId: job.variant.id,
    replicate: job.replicate,
  }));
  const slotKey = (caseId: string, variantId: string, replicate: number) =>
    JSON.stringify([caseId, variantId, replicate]);
  const requestedSlots = input.attempts?.map((slot) =>
    slotKey(slot.caseId, slot.variantId, slot.replicate)
  );
  if (
    requestedSlots &&
    (!requestedSlots.length ||
      new Set(requestedSlots).size !== requestedSlots.length ||
      requestedSlots.some(
        (key) =>
          !plannedJobs.some((job) => slotKey(job.caseId, job.variant.id, job.replicate) === key)
      ))
  )
    throw new Error('Requested attempt slots must be unique members of this comparison.');
  const jobs = requestedSlots
    ? requestedSlots.map(
        (key) =>
          plannedJobs.find((job) => slotKey(job.caseId, job.variant.id, job.replicate) === key)!
      )
    : plannedJobs;
  const workspaceState = useWorkspaceStore.getState();
  const workspace = {
    folders: workspaceState.folders.map((folder) => ({ ...folder })),
    activeWorkspaceFile: workspaceState.activeWorkspaceFile,
  };
  if (batchInFlight) throw new Error('A protein prompt batch is already running.');
  batchInFlight = true;
  try {
    const pinnedInputs = await readPinnedBatchInputs(input);
    const roundReview = requireCurrentMolecularRoundReview(
      submittedReview.data,
      await reviewPinnedBatchInputs(input, submittedReview.data.decisions, pinnedInputs)
    );
    const admission = molecularBatchAdmission(input, roundReview, experimentId, requiredSlots);
    await workerApi.checkAdmission(admission);
    if (input.recoveryOfExperimentId) {
      const previous = await inspectMolecularRoundCompletion(
        input.recoveryOfExperimentId,
        requiredSlots
      );
      const incomplete = new Set(previous.incompleteSlots.map(molecularRoundSlotKey));
      if (
        jobs.some(
          (job) =>
            !incomplete.has(
              molecularRoundSlotKey({
                caseId: job.caseId,
                variantId: job.variant.id,
                replicate: job.replicate,
              })
            )
        )
      )
        throw new Error('Repairs may only fill incomplete slots from the original frozen round.');
    }
    const fixturesByCase = new Map(
      await Promise.all(
        cases.map(
          async (item) =>
            [
              item.caseId,
              await prepareMolecularTrialFixtures(
                molecularBenchmarkCase(item.caseId)!.title,
                pinnedInputs.get(item.caseId)!
              ),
            ] as const
        )
      )
    );
    const conversationIds: string[] = [];
    const workerLeases: ProteinExperimentWorkerLease[] = [];
    const priorComparableByCase = new Map<MolecularBenchmarkCaseId, MolecularPromptTrialResult>();
    const stopDispatch = new AbortController();
    const executeJob = async (job: (typeof jobs)[number], offset: number) => {
      const { caseId, variant, replicate } = job;
      const index = offset + 1;
      const label = `${molecularBenchmarkCase(caseId)!.title} · ${variant.label}`;
      const conversationId = crypto.randomUUID();
      const jobId = crypto.randomUUID();
      const pinned = fixturesByCase.get(caseId)!;
      const documentDraftId = crypto.randomUUID();
      const sharedViewId = `molecular-draft:${documentDraftId}`;
      const fixtures = pinned.map((item) => {
        const { savedViewId: _savedViewId, ...fixture } = item.fixture;
        return { ...fixture, structureViewId: sharedViewId, documentDraftId };
      });
      const initial = createMolecularPromptTrial({
        conversationId,
        caseId,
        variant,
        fixtures,
        experiment: {
          id: experimentId,
          mode: admission.mode,
          recoveryOfExperimentId: input.recoveryOfExperimentId,
          replicate,
          replicateCount: repeats,
          requiredSlots,
        },
        execution: {
          kind: 'background-worker',
          jobId,
          renderProfile,
          startPolicyVersion: 1,
          ...(input.reasoningEffortByVariant?.[variant.id] !== undefined
            ? { reasoningEffort: input.reasoningEffortByVariant[variant.id] }
            : {}),
        },
        roundReview,
      });
      const startRecordId = await saveMolecularPromptTrialStart(initial);
      const trial = { ...initial, startRecordId };
      conversationIds.push(conversationId);
      let prepared = false;
      let dispatched = false;
      let terminal = false;
      let saved = false;
      input.onProgress?.({ index, total: jobs.length, label, stage: 'opening' });
      try {
        writeMolecularPromptTrial(trial);
        const lease = await workerApi.prepare({
          admission: {
            ...admission,
            slot: molecularRoundSlotKey({ caseId, variantId: variant.id, replicate }),
          },
          jobId,
          label,
          workspace,
          renderProfile,
          fixtures: fixtures.slice(0, 1).map((fixture, slot) => ({
            structureViewId: molecularTrialFixtureTarget(fixture),
            attrs: {
              ...molecularViewAttrs(molecularTrialFixtureTarget(fixture), pinned[slot].view),
              molecularDocumentDraftId: fixture.documentDraftId,
            },
          })),
        });
        workerLeases.push(lease);
        prepared = true;
        let sendError: string | null = null;
        input.onProgress?.({ index, total: jobs.length, label, stage: 'running' });
        const disposition = await useChatStore
          .getState()
          .sendMessage(trial.question, null, conversationId, [], {
            activateConversation: false,
            onNotStarted: (message) => {
              sendError = message;
            },
          });
        if (disposition !== 'accepted')
          throw new Error(sendError ?? 'The agent could not start this trial.');
        dispatched = true;
        await waitForTerminalTurn(conversationId);
        terminal = true;
        const result = await recordTrial(trial, priorComparableByCase, stopDispatch);
        saved = true;
        input.onProgress?.({
          index,
          total: jobs.length,
          label,
          stage: 'recorded',
          status: result.status,
        });
      } catch (error) {
        if (sharedProviderUnavailable(error instanceof Error ? error.message : String(error)))
          stopDispatch.abort();
        if (dispatched && !terminal) {
          const turns = await getChatTurns(conversationId);
          terminal = !turns.some((turn) => turn.status === 'running');
        }
        const failure: MolecularPromptTrialResult = {
          trial,
          status: 'failed',
          observation: error instanceof Error ? error.message : String(error),
          referenceIds: [],
          coordinateDigests: [],
          cameraNodePresent: false,
          cameraChanged: false,
          sceneChanged: false,
          routeKey: null,
          promptSnapshot: readMolecularTrialSentPromptSnapshot(conversationId),
          recordedAt: Date.now(),
          ...(!prepared && !dispatched
            ? { failure: { stage: 'preparation' as const, agentDispatched: false as const } }
            : {}),
        };
        await saveMolecularPromptTrialResult(failure);
        saved = true;
        input.onProgress?.({
          index,
          total: jobs.length,
          label,
          stage: 'recorded',
          status: 'failed',
        });
      } finally {
        if (prepared && (!dispatched || terminal)) await workerApi.release({ jobId });
        if (saved && (!dispatched || terminal)) clearMolecularPromptTrialIsolation(conversationId);
      }
    };
    const outcomes = await runMolecularExperimentQueue(
      jobs,
      concurrency,
      executeJob,
      stopDispatch.signal
    );
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (failures.length)
      throw new Error(
        `Some experiment records or worker releases failed. Recorded attempts remain in the notebook. ${failures
          .map((outcome) =>
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
          )
          .join('; ')}`
      );
    const completion = await requireMolecularRoundCompletion(
      input.recoveryOfExperimentId ?? experimentId,
      requiredSlots
    );
    return {
      completed: completion.completedSlots.length,
      rendered: completion.completedSlots.length,
      experimentId,
      conversationIds,
      workerLeases,
    };
  } finally {
    batchInFlight = false;
  }
}
