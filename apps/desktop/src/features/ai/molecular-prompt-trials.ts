import { z } from 'zod';
import {
  MOLECULAR_BENCHMARK_CASES,
  molecularBenchmarkCase,
  molecularComparisonInstructions,
  molecularComparisonProfile,
  type MolecularBenchmarkCaseId,
  type MolecularComparisonProfileId,
} from './molecular-comparison-profiles';
import { MVS_AGENT_SCENE_POLICY } from '../page/public/embeds/structure3d/molstar/agentScenePolicy';
import { molecularRenderProfileSelectionSchema } from '../page/public/embeds/structure3d/molstar/molecularRenderProfile';
import { molecularRoundReviewSchema } from '../../shared/molecular-round-review';
import type { AgentCliModelReasoningEffort } from '../../platform';
import { getCliSupportedReasoningEfforts } from './cli-host-capabilities';
import {
  molecularDocumentReferenceFromHref,
  molecularDocumentReferenceSchema,
} from '../../shared/molecular-document-reference';

export const molecularTrialReasoningEffortSchema = z.custom<AgentCliModelReasoningEffort>(
  (value) =>
    typeof value === 'string' &&
    getCliSupportedReasoningEfforts('codex-sdk').includes(value as AgentCliModelReasoningEffort),
  'Protein trial reasoning effort must be a supported Codex effort.'
);

const fixtureSchema = z
  .object({
    pdbId: z.string().regex(/^[0-9A-Za-z]{4}$/),
    referenceId: z.string().uuid(),
    savedViewId: z.string().startsWith('saved-view:').optional(),
    structureViewId: z.string().startsWith('molecular-draft:').optional(),
    documentDraftId: z.string().uuid().optional(),
    sourceDocumentReference: molecularDocumentReferenceSchema.optional(),
    coordinateSha256: z.string().regex(/^[0-9a-f]{64}$/),
    initialSceneSha256: z.string().regex(/^[0-9a-f]{64}$/),
    initialCameraSignature: z.string().max(10_000),
    structureSignature: z.string().max(1000).optional(),
    resourceStructureSignature: z.string().max(10_000).optional(),
  })
  .superRefine((fixture, context) => {
    if (
      fixture.structureViewId
        ? fixture.savedViewId !== undefined ||
          !fixture.documentDraftId ||
          fixture.structureViewId !== `molecular-draft:${fixture.documentDraftId}`
        : !fixture.savedViewId || fixture.documentDraftId !== undefined
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'A trial requires one exact owned document draft or a historical saved-view identity.',
      });
  });

export function molecularTrialFixtureTarget(fixture: {
  structureViewId?: string;
  savedViewId?: string;
}): string {
  const target = fixture.structureViewId ?? fixture.savedViewId;
  if (!target) throw Error('The trial fixture has no owned runtime target.');
  return target;
}

export function molecularTrialArgumentTargets(input: Record<string, unknown>): string[] {
  const targets = ['structureViewId', 'viewerId', 'structureRef', 'bindingId'].flatMap((key) =>
    typeof input[key] === 'string' && input[key] ? [input[key] as string] : []
  );
  const reference = molecularDocumentReferenceSchema.safeParse(input.documentReference);
  if (input.documentReference !== undefined && !reference.success)
    throw Error('The trial document reference is invalid.');
  if (reference.success) targets.push(`molecular-draft:${reference.data.documentId}`);
  return targets.map((target) => {
    const document = molecularDocumentReferenceFromHref(target);
    return document ? `molecular-draft:${document.documentId}` : target;
  });
}

export const molecularRoundSlotSchema = z.object({
  caseId: z.enum(
    MOLECULAR_BENCHMARK_CASES.map((item) => item.id) as [
      MolecularBenchmarkCaseId,
      ...MolecularBenchmarkCaseId[],
    ]
  ),
  variantId: z.string().min(1).max(100),
  replicate: z.number().int().positive(),
});
export type MolecularRoundSlot = z.infer<typeof molecularRoundSlotSchema>;

const trialSchema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  caseId: z.enum(
    MOLECULAR_BENCHMARK_CASES.map((item) => item.id) as [
      MolecularBenchmarkCaseId,
      ...MolecularBenchmarkCaseId[],
    ]
  ),
  profileId: z.string().min(1).max(100),
  profileLabel: z.string().min(1).max(100).optional(),
  question: z.string().min(1),
  context: z.string().min(1),
  promptInstructions: z.string().min(1),
  fixtures: z.array(fixtureSchema).min(1).max(4),
  startedAt: z.number().int().nonnegative(),
  roundReview: molecularRoundReviewSchema.optional(),
  startRecordId: z.string().uuid().optional(),
  experiment: z
    .object({
      id: z.string().uuid(),
      mode: z.enum(['full-round', 'experiment']).optional(),
      recoveryOfExperimentId: z.string().uuid().optional(),
      replicate: z.number().int().positive(),
      replicateCount: z.number().int().positive(),

      requiredSlots: z.array(molecularRoundSlotSchema).min(1).optional(),
    })
    .refine((value) => value.replicate <= value.replicateCount)
    .optional(),
  execution: z
    .object({
      kind: z.literal('background-worker'),
      jobId: z.string().uuid(),
      renderProfile: molecularRenderProfileSelectionSchema,
      startPolicyVersion: z.literal(1).optional(),
      reasoningEffort: molecularTrialReasoningEffortSchema.optional(),
    })
    .strict()
    .refine((value) => value.reasoningEffort === undefined || value.startPolicyVersion === 1, {
      message: 'Reasoning effort overrides require a fresh protein trial.',
    })
    .optional(),
});

const scenePolicySchema = z
  .object({
    id: z.string().min(1),
    enforcedConstraints: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            errorCode: z.string().min(1),
            enforcement: z.string().min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

const sentPromptSnapshotSchema = z
  .object({
    version: z.literal(1),
    conversationId: z.string().uuid(),
    turnId: z.string().uuid(),
    bridgeTurnId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    agentConfiguration: z
      .object({
        transport: z.string(),
        model: z.string().nullable(),
        reasoningEffort: z.string().nullable(),
        serviceTier: z.string().nullable(),
        personality: z.string().nullable(),
      })
      .strict()
      .optional(),
    channel: z.enum(['cli-seed', 'hosted-system', 'hosted-codex-developer']),
    prompt: z.string().min(1),
    continuationPrompt: z.string().min(1).nullable().optional(),
    additionalAgentInstructions: z.string().nullable(),
    scenePolicy: scenePolicySchema.optional(),
    capturedAt: z.number().int().nonnegative(),
  })
  .strict();

export type MolecularPromptTrial = z.infer<typeof trialSchema>;
export type MolecularPromptTrialFixture = MolecularPromptTrial['fixtures'][number];
export type MolecularTrialSentPromptSnapshot = z.infer<typeof sentPromptSnapshotSchema>;
export type MolecularPromptVariant = { id: string; label: string; instructions: string };

export function parseMolecularTrialSentPromptSnapshot(
  value: unknown
): MolecularTrialSentPromptSnapshot | null {
  const parsed = sentPromptSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const TRIAL_STORAGE_PREFIX = 'dnaforge:protein-prompt-trial-v1:';
const SENT_PROMPT_STORAGE_PREFIX = 'dnaforge:protein-trial-sent-prompt-v1:';
const FIXTURE_SELECTION_KEY = 'dnaforge:protein-prompt-fixtures-v1';
const ACTIVE_TRIAL_PREFIX = 'dnaforge:protein-active-trial-v1:';
const TURN_TRIAL_PREFIX = 'dnaforge:protein-trial-turn-v1:';

export function readMolecularPromptTrialForTurn(turnId?: string): MolecularPromptTrial | null {
  if (!turnId || typeof localStorage === 'undefined') return null;
  const conversationId = localStorage.getItem(`${TURN_TRIAL_PREFIX}${turnId}`);
  return conversationId && localStorage.getItem(`${ACTIVE_TRIAL_PREFIX}${conversationId}`)
    ? readMolecularPromptTrial(conversationId)
    : null;
}

export function clearMolecularPromptTrialIsolation(conversationId: string): void {
  const snapshot = readMolecularTrialSentPromptSnapshot(conversationId);
  if (snapshot) {
    localStorage.removeItem(`${TURN_TRIAL_PREFIX}${snapshot.turnId}`);
    if (snapshot.bridgeTurnId)
      localStorage.removeItem(`${TURN_TRIAL_PREFIX}${snapshot.bridgeTurnId}`);
  }
  localStorage.removeItem(`${SENT_PROMPT_STORAGE_PREFIX}${conversationId}`);
  localStorage.removeItem(`${ACTIVE_TRIAL_PREFIX}${conversationId}`);
}

export function parseMolecularPromptTrial(value: unknown): MolecularPromptTrial | null {
  const result = trialSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function readMolecularPromptTrial(
  conversationId: string | null | undefined
): MolecularPromptTrial | null {
  if (!conversationId) return null;
  try {
    const raw = localStorage.getItem(`${TRIAL_STORAGE_PREFIX}${conversationId}`);
    const trial = raw ? parseMolecularPromptTrial(JSON.parse(raw)) : null;
    return trial?.conversationId === conversationId ? trial : null;
  } catch {
    return null;
  }
}

export function writeMolecularPromptTrial(trial: MolecularPromptTrial): void {
  const validated = trialSchema.parse(trial);
  const key = `${TRIAL_STORAGE_PREFIX}${validated.conversationId}`;
  if (localStorage.getItem(key))
    throw new Error('This conversation already has a fixed protein trial.');
  localStorage.setItem(key, JSON.stringify(validated));
  if (validated.experiment)
    localStorage.setItem(`${ACTIVE_TRIAL_PREFIX}${validated.conversationId}`, '1');
}

export function writeMolecularTrialSentPromptSnapshot(
  snapshot: MolecularTrialSentPromptSnapshot
): void {
  if (!readMolecularPromptTrial(snapshot.conversationId)) return;
  if (snapshot.channel === 'cli-seed' && !snapshot.continuationPrompt?.trim())
    throw new Error('A CLI trial requires its exact continuation prompt before dispatch.');
  const validated = sentPromptSnapshotSchema.parse({
    ...snapshot,
    continuationPrompt: snapshot.continuationPrompt ?? null,
    scenePolicy: MVS_AGENT_SCENE_POLICY,
  });
  localStorage.setItem(
    `${SENT_PROMPT_STORAGE_PREFIX}${validated.conversationId}`,
    JSON.stringify(validated)
  );
  if (localStorage.getItem(`${ACTIVE_TRIAL_PREFIX}${validated.conversationId}`)) {
    localStorage.setItem(`${TURN_TRIAL_PREFIX}${validated.turnId}`, validated.conversationId);
    if (validated.bridgeTurnId)
      localStorage.setItem(
        `${TURN_TRIAL_PREFIX}${validated.bridgeTurnId}`,
        validated.conversationId
      );
  }
}

export function readMolecularTrialSentPromptSnapshot(
  conversationId: string | null | undefined
): MolecularTrialSentPromptSnapshot | null {
  if (!conversationId) return null;
  try {
    const raw = localStorage.getItem(`${SENT_PROMPT_STORAGE_PREFIX}${conversationId}`);
    const parsed = raw ? parseMolecularTrialSentPromptSnapshot(JSON.parse(raw)) : null;
    return parsed?.conversationId === conversationId ? parsed : null;
  } catch {
    return null;
  }
}

export function readMolecularFixtureSelection(
  caseId: MolecularBenchmarkCaseId
): Record<string, string> {
  try {
    const raw = localStorage.getItem(FIXTURE_SELECTION_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
    return data[caseId] ?? {};
  } catch {
    return {};
  }
}

export function writeMolecularFixtureSelection(
  caseId: MolecularBenchmarkCaseId,
  pdbId: string,
  referenceId: string
): void {
  const raw = localStorage.getItem(FIXTURE_SELECTION_KEY);
  const data = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
  data[caseId] = { ...(data[caseId] ?? {}), [pdbId]: referenceId };
  localStorage.setItem(FIXTURE_SELECTION_KEY, JSON.stringify(data));
}

export function createMolecularPromptTrial(input: {
  conversationId: string;
  caseId: MolecularBenchmarkCaseId;
  profileId?: MolecularComparisonProfileId;
  variant?: MolecularPromptVariant;
  fixtures: MolecularPromptTrialFixture[];
  startedAt?: number;
  experiment?: MolecularPromptTrial['experiment'];
  execution?: MolecularPromptTrial['execution'];
  roundReview?: MolecularPromptTrial['roundReview'];
}): MolecularPromptTrial {
  const benchmark = molecularBenchmarkCase(input.caseId);
  if (!benchmark) throw new Error('Unknown protein benchmark case.');
  if (
    input.fixtures.length !== benchmark.fixtureIds.length ||
    benchmark.fixtureIds.some((pdbId) => !input.fixtures.some((fixture) => fixture.pdbId === pdbId))
  ) {
    throw new Error('Every fixed structure needs one pinned coordinate fixture.');
  }
  for (const [index, pdbId] of benchmark.fixtureIds.entries()) {
    const fixture = input.fixtures.find((item) => item.pdbId === pdbId);
    if (fixture?.structureSignature !== JSON.stringify([benchmark.structureModes[index]])) {
      throw new Error(`The pinned ${pdbId} view has the wrong model or assembly.`);
    }
  }
  const viewBindings = input.fixtures
    .map(
      (fixture) =>
        `${fixture.pdbId}: runtime document ${molecularTrialFixtureTarget(fixture)}, coordinate SHA-256 ${fixture.coordinateSha256}.`
    )
    .join('\n');
  const variant = input.variant;
  if (!variant && !input.profileId) throw new Error('Choose a prompt variant.');
  if (
    variant &&
    (!variant.id.trim() ||
      variant.id.length > 100 ||
      !variant.label.trim() ||
      variant.label.length > 100 ||
      (variant.id !== 'dnaforge' && !variant.instructions.trim()) ||
      new TextEncoder().encode(variant.instructions).length > 8_000)
  )
    throw new Error('The edited prompt variant needs a name and at most 8,000 bytes of guidance.');
  const profileId = variant?.id ?? input.profileId!;
  const instructions = variant
    ? `${molecularComparisonInstructions('dnaforge', input.caseId)}${
        variant.instructions.trim()
          ? `\nPrompt module ${variant.id}:\n${variant.instructions.trim()}`
          : ''
      }`
    : molecularComparisonInstructions(input.profileId!, input.caseId);
  const comparisonInstructions =
    input.fixtures.length > 1
      ? 'This task compares the supplied structures, already loaded together in one shared viewer. Develop one ordered comparison scene here and save that comparison once. Keep corresponding group identities and colors consistent across its steps. The constructor retains all pinned sources and their common placements across steps; hide a complete structure with custom.is_hidden:true instead of unloading it. When superposition helps explain the difference, use mol_align_structures on scientifically justified corresponding regions; for conformational changes prefer invariant regions. Inspect the source-derived correspondence and fit. Co-loading alone is not alignment.'
      : '';
  const promptInstructions = `${instructions}\nPinned coordinate fixtures for this conversation:\n${viewBindings}\n${comparisonInstructions}\nUse mol_list_structures to find the already open viewer, then mol_get_scene on its exact structureViewId. Use mol_activate_view to select an already-open view before controlling it; retry mol_get_scene if its saved scene is still loading. Keep the primary coordinate resource and the fixed models or assemblies, and use only the returned pinned resource names. The starting scenes only carry the benchmark coordinates; author and inspect a new depiction before mol_save_view. A PyMOL-style within selection in mol_select_residues, followed by mol_get_state, can identify nearby residues from the pinned coordinates. Clear the temporary selection after reading it. If you use mol_focus to find a camera, put the verified position, target, and up vector into an explicit MolViewSpec camera node before saving. For any named clickable color groups, call mol_get_scene with includeColorGroupSelections:true after the last scene edit and before saving that view; compare each resolved selection with the focal evidence. This is a controlled comparison: use only ${[...TRIAL_ALLOWED_TOOLS].join(', ')}. For scientific features absent from the coordinates, protein_get_context is limited to source:'protein-mcp', operation:'annotations', a pinned PDB identifier and an author chain verified in the loaded inventory. Its result is factual evidence, with recorded provider provenance; it is not a scene or permission to import coordinates. Feature positions may use UniProt numbering: verify their correspondence to the loaded sequence and residue numbering before rendering them. Do not use arbitrary scientific searches, other providers, web, shell or file tools. If the fixed context or coordinates are insufficient, report the blocker. Do not expose private saved-view IDs or hashes in the answer.`;
  return trialSchema.parse({
    version: 1,
    conversationId: input.conversationId,
    caseId: input.caseId,
    profileId,
    ...(variant ? { profileLabel: variant.label.trim() } : {}),
    question: benchmark.question,
    context: benchmark.context,
    promptInstructions,
    fixtures: input.fixtures,
    startedAt: input.startedAt ?? Date.now(),
    ...(input.experiment ? { experiment: input.experiment } : {}),
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.roundReview ? { roundReview: input.roundReview } : {}),
  });
}

export function trialPromptLabel(trial: MolecularPromptTrial): string {
  return `${molecularBenchmarkCase(trial.caseId)?.title ?? trial.caseId} · ${trial.profileLabel ?? molecularComparisonProfile(trial.profileId).label}`;
}

export function molecularSceneCameraSignature(scene: string): string {
  try {
    const cameras: unknown[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (object.kind === 'camera') cameras.push(object.params ?? null);
      for (const child of Object.values(object)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (typeof child === 'object') visit(child);
      }
    };
    visit(JSON.parse(scene));
    return JSON.stringify(cameras);
  } catch {
    return '[]';
  }
}

export function molecularSceneStructureSignature(scene: string): string {
  try {
    const structures = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const object = value as Record<string, unknown>;
      if (object.kind === 'structure') {
        const params = (object.params ?? {}) as Record<string, unknown>;
        const mode =
          params.type === 'assembly'
            ? `assembly:${String(params.assembly_id ?? '')}`
            : String(params.type ?? 'unknown');
        structures.add(mode);
      }
      for (const child of Object.values(object)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (typeof child === 'object') visit(child);
      }
    };
    visit(JSON.parse(scene));
    return JSON.stringify([...structures].sort());
  } catch {
    return '[]';
  }
}

const TRIAL_ALLOWED_TOOLS = new Set([
  'protein_get_context',
  'mol_list_structures',
  'mol_get_state',
  'mol_activate_view',
  'mol_get_scene',
  'mol_select_residues',
  'mol_focus',
  'mol_apply_scene',
  'mol_align_structures',
  'mol_show_interaction_context',
  'mol_select_story_step',
  'mol_capture_screenshot',
  'mol_save_view',
]);

export function molecularTrialAllowedTools(): string[] {
  return [...TRIAL_ALLOWED_TOOLS];
}

type TrialToolMessage = { role: string; content: string; tool_name?: string | null };
type TrialToolCall = { name: string; args: Record<string, unknown> };

function trialToolCalls(messages: ReadonlyArray<TrialToolMessage>): TrialToolCall[] {
  const calls: TrialToolCall[] = [];
  const argsOf = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_name) {
      try {
        const parsed = argsOf(JSON.parse(message.content));
        calls.push({ name: message.tool_name, args: argsOf(parsed.input) });
      } catch {
        calls.push({ name: message.tool_name, args: {} });
      }
    }
    if (message.role !== 'activity') continue;
    try {
      const activity = JSON.parse(message.content) as {
        event?: {
          toolCalls?: Array<{ name?: string; input?: unknown }>;
          raw?: { item?: { type?: string; tool?: string; arguments?: unknown } };
        };
      };
      for (const call of activity.event?.toolCalls ?? []) {
        if (call.name) calls.push({ name: call.name, args: argsOf(call.input) });
      }
      const raw = activity.event?.raw?.item;
      if (raw?.type === 'mcp_tool_call' && raw.tool)
        calls.push({ name: raw.tool, args: argsOf(raw.arguments) });
    } catch {}
  }
  return calls;
}

export function molecularTrialUnexpectedTools(messages: ReadonlyArray<TrialToolMessage>): string[] {
  return [...new Set(trialToolCalls(messages).map((call) => call.name))]
    .filter((name) => !TRIAL_ALLOWED_TOOLS.has(name))
    .sort();
}

export function molecularTrialWrongViewTargets(
  messages: ReadonlyArray<TrialToolMessage>,
  allowedStructureViewIds: readonly string[]
): string[] {
  const allowed = new Set(allowedStructureViewIds);
  return [
    ...new Set(
      trialToolCalls(messages).flatMap(({ name, args }) => {
        return molecularTrialArgumentTargets(args)
          .filter((target) => !allowed.has(target))
          .map((target) => `${name} → ${target}`);
      })
    ),
  ].sort();
}

function sceneHasNamedColorGroups(scene: string): boolean {
  try {
    let found = false;
    const visit = (value: unknown): void => {
      if (found || !value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      const custom = node.custom as Record<string, unknown> | undefined;
      if (node.kind === 'color' && typeof custom?.dnaforge_legend_label === 'string') {
        found = true;
        return;
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (typeof child === 'object') visit(child);
      }
    };
    visit(JSON.parse(scene));
    return found;
  } catch {
    return false;
  }
}

export function molecularTrialUncheckedNamedGroups(
  messages: ReadonlyArray<TrialToolMessage>,
  views: readonly { structureViewId: string; scene: string }[]
): string[] {
  const calls = trialToolCalls(messages);
  return views.flatMap(({ structureViewId, scene }) => {
    if (!sceneHasNamedColorGroups(scene)) return [];
    const targetsView = (call: TrialToolCall) =>
      molecularTrialArgumentTargets(call.args).includes(structureViewId);
    let lastSave = -1;
    for (let index = 0; index < calls.length; index++)
      if (calls[index].name === 'mol_save_view' && targetsView(calls[index])) lastSave = index;
    if (lastSave < 0) return [structureViewId];
    let lastEdit = -1;
    for (let index = 0; index < lastSave; index++)
      if (
        targetsView(calls[index]) &&
        (calls[index].name === 'mol_apply_scene' ||
          calls[index].name === 'mol_align_structures' ||
          calls[index].name === 'mol_show_interaction_context')
      )
        lastEdit = index;
    const checked = calls.some(
      (call, index) =>
        index > lastEdit &&
        index < lastSave &&
        call.name === 'mol_get_scene' &&
        targetsView(call) &&
        call.args.includeColorGroupSelections === true
    );
    return checked ? [] : [structureViewId];
  });
}
