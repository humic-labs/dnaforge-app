import type {
  MolecularPromptTrialResultRecord,
  MolecularPromptTrialStartRecord,
  MolecularSavedViewIndexEntry,
  MolecularPromptTrialFeedback,
} from '../../../../db/molecular-prompt-trials';
import type { MolecularHarnessComparisonRecord } from '../../../../db/molecular-harness-comparisons';
import {
  MOLECULAR_COMPARISON_PROFILES,
  molecularBenchmarkCase,
  molecularComparisonProfile,
} from '../../../ai/public/molecular-comparison-profiles';
import type {
  MolecularTrialSentPromptSnapshot,
  MolecularPromptTrial,
} from '../../../ai/public/molecular-prompt-trials';

export type ProteinRunIndexEntry = {
  id: string;
  kind: 'prompt-trial' | 'harness-outcome' | 'saved-view';
  title: string;
  caseTitle: string;
  question: string | null;
  methodLabel: string;
  promptLabel: string;
  promptSummary: string | null;
  harnessLabel: string;
  routeLabel: string | null;
  provenance: 'prompt-trial' | 'external-harness' | 'prompt-control' | 'unassigned';
  status: string;
  createdAt: number;
  conversationId: string | null;
  conversationCount: number;
  outputIds: string[];
  promptCapture: 'sent-prompt' | 'trial-instructions-only' | 'none';
  promptInstructions: string | null;
  sentPrompt: string | null;
  sentPromptChannel: string | null;
  continuationPrompt: string | null;
  supplementalInstructions: string | null;
  scenePolicy: MolecularTrialSentPromptSnapshot['scenePolicy'] | null;
  evidence: string | null;
  sourceUrl: string | null;
  recordCount: number;
  feedback: MolecularPromptTrialFeedback[];
  resultRecordId?: string;
  experiment?: MolecularPromptTrial['experiment'];
  roundReview?: MolecularPromptTrial['roundReview'];
};

export type ProteinRunIndex = {
  promptTrials: ProteinRunIndexEntry[];
  harnessOutcomes: ProteinRunIndexEntry[];
  otherSavedViews: ProteinRunIndexEntry[];
};

type IndexInput = {
  starts: Pick<MolecularPromptTrialStartRecord, 'id' | 'trial'>[];
  results: (Pick<
    MolecularPromptTrialResultRecord,
    'id' | 'trial' | 'status' | 'referenceIds' | 'recordedAt' | 'observation'
  > &
    Partial<Pick<MolecularPromptTrialResultRecord, 'routeKey' | 'promptSnapshot' | 'feedback'>>)[];
  harnessRecords: MolecularHarnessComparisonRecord[];
  savedViews: MolecularSavedViewIndexEntry[];
};

export type ProteinRunSortKey = 'question' | 'run' | 'prompt' | 'harness' | 'status';
export type ProteinRunSortDirection = 'asc' | 'desc';

export type ProteinTestCaseRow = {
  id: string;
  versions: ProteinRunIndexEntry[];
};

export type ProteinPromptVersion = {
  id: string;
  label: string;
  runs: ProteinRunIndexEntry[];
  experimentId?: string;
};

export function groupProteinRunVersions(row: ProteinTestCaseRow): ProteinPromptVersion[] {
  const groups = new Map<string, ProteinPromptVersion>();
  for (const entry of row.versions) {
    const instructions = entry.promptInstructions ?? '';
    const marker = /\nPrompt module [^\n]+:\n/.exec(instructions);
    const guidance = marker
      ? instructions
          .slice(marker.index + marker[0].length)
          .split('\nPinned coordinate fixtures for this conversation:')[0]
      : instructions.includes('Fixed protein benchmark context (v1):')
        ? ''
        : instructions;
    const key = JSON.stringify([entry.experiment?.id ?? null, entry.promptLabel, guidance]);
    const group = groups.get(key) ?? {
      id: entry.id,
      label:
        entry.experiment?.mode === 'experiment'
          ? `Unscored experiment · ${entry.promptLabel}`
          : entry.promptLabel,
      runs: [],
      experimentId: entry.experiment?.recoveryOfExperimentId ?? entry.experiment?.id,
    };
    group.runs.push(entry);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.runs.sort(
      (a, b) =>
        (a.experiment?.replicate ?? 0) - (b.experiment?.replicate ?? 0) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id)
    );
    group.id = group.runs[0].id;
  }
  for (const [key, group] of groups) {
    const parentId = group.runs[0].experiment?.recoveryOfExperimentId;
    if (!parentId) continue;
    const [, label, guidance] = JSON.parse(key);
    const cutoff = Math.max(...group.runs.map((run) => run.createdAt));
    const slots = new Map<number | undefined, ProteinRunIndexEntry>();
    for (const [candidateKey, candidate] of groups) {
      const [id, candidateLabel, candidateGuidance] = JSON.parse(candidateKey);
      if (
        candidateLabel !== label ||
        candidateGuidance !== guidance ||
        (id !== parentId && candidate.runs[0].experiment?.recoveryOfExperimentId !== parentId)
      )
        continue;
      for (const run of candidate.runs) {
        if (run.createdAt > cutoff) continue;
        const repeat = run.experiment?.replicate,
          previous = slots.get(repeat);
        if (
          !previous ||
          (run.status === 'rendered' && previous.status !== 'rendered') ||
          ((run.status === 'rendered') === (previous.status === 'rendered') &&
            run.createdAt > previous.createdAt)
        )
          slots.set(repeat, run);
      }
    }
    group.runs = [...slots.values()].sort(
      (a, b) => (a.experiment?.replicate ?? 0) - (b.experiment?.replicate ?? 0)
    );
  }
  return [...groups.values()].sort(
    (a, b) =>
      Math.max(...b.runs.map((run) => run.createdAt)) -
      Math.max(...a.runs.map((run) => run.createdAt))
  );
}

export function groupProteinRunsByCase(
  entries: readonly ProteinRunIndexEntry[]
): ProteinTestCaseRow[] {
  const rows = new Map<string, ProteinTestCaseRow>();
  for (const entry of entries) {
    const id = JSON.stringify([entry.caseTitle, entry.question ?? entry.id]);
    let row = rows.get(id);
    if (!row) {
      row = { id, versions: [] };
      rows.set(id, row);
    }
    row.versions.push(entry);
  }
  for (const row of rows.values())
    row.versions = sortProteinRunEntries(row.versions, 'run', 'desc');
  return [...rows.values()];
}

export function sortProteinRunEntries(
  entries: readonly ProteinRunIndexEntry[],
  key: ProteinRunSortKey,
  direction: ProteinRunSortDirection
): ProteinRunIndexEntry[] {
  const textFor = (entry: ProteinRunIndexEntry): string => {
    switch (key) {
      case 'question':
        return entry.question ?? '';
      case 'prompt':
        return entry.promptLabel;
      case 'harness':
        return entry.harnessLabel;
      case 'status':
        return entry.status;
      case 'run':
        return '';
    }
  };
  const factor = direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const primary =
      key === 'run'
        ? a.createdAt - b.createdAt
        : textFor(a).localeCompare(textFor(b), undefined, { numeric: true, sensitivity: 'base' });
    return primary * factor || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  });
}

function routeLabel(routeKey: string | null | undefined): string | null {
  if (!routeKey) return null;
  try {
    const parts: unknown = JSON.parse(routeKey);
    if (!Array.isArray(parts)) return null;
    const [kind, legacyHost, provider, model, transport] = parts;
    const selected = parts.length <= 2 ? [kind, legacyHost] : [kind, transport ?? provider, model];
    const strings = selected.filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0
    );
    return strings.length ? strings.join(' · ') : null;
  } catch {
    return null;
  }
}

function authoredPromptSummary(instructions: string): string | null {
  const firstLine = /\nPrompt module [^\n]+:\n([^\n]+)/.exec(instructions)?.[1]?.trim();
  return firstLine?.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? null;
}

export function buildProteinRunIndex(input: IndexInput): ProteinRunIndex {
  const claimedViews = new Set<string>();
  const viewsById = new Map(input.savedViews.map((view) => [view.id, view]));
  const resultsByStartId = new Map<string, IndexInput['results'][number]>();
  for (const result of [...input.results].sort((a, b) => b.recordedAt - a.recordedAt)) {
    const startId = result.trial.startRecordId;
    if (startId && !resultsByStartId.has(startId)) resultsByStartId.set(startId, result);
  }

  const promptTrials = input.starts.map(({ id, trial }): ProteinRunIndexEntry => {
    const result = resultsByStartId.get(id);
    const profile = molecularComparisonProfile(trial.profileId);
    const sentPrompt =
      result?.promptSnapshot?.conversationId === trial.conversationId
        ? result.promptSnapshot
        : null;
    const outputIds = result?.referenceIds ?? [];
    outputIds.forEach((referenceId) => claimedViews.add(referenceId));
    return {
      id: `prompt:${id}`,
      kind: 'prompt-trial',
      title: molecularBenchmarkCase(trial.caseId)?.title ?? trial.caseId,
      caseTitle: molecularBenchmarkCase(trial.caseId)?.title ?? trial.caseId,
      question: trial.question,
      methodLabel: trial.profileLabel ?? profile.label,
      promptLabel: trial.profileLabel ?? profile.label,
      promptSummary: MOLECULAR_COMPARISON_PROFILES.some((item) => item.id === trial.profileId)
        ? profile.summary
        : authoredPromptSummary(trial.promptInstructions),
      harnessLabel: 'DNAForge MolViewSpec',
      routeLabel: routeLabel(result?.routeKey),
      provenance: 'prompt-trial',
      status: result?.status ?? 'started',
      createdAt: trial.startedAt,
      conversationId: trial.conversationId,
      conversationCount: 1,
      outputIds,
      promptCapture: sentPrompt ? 'sent-prompt' : 'trial-instructions-only',
      promptInstructions: trial.promptInstructions,
      sentPrompt: sentPrompt?.prompt ?? null,
      sentPromptChannel: sentPrompt?.channel ?? null,
      continuationPrompt: sentPrompt?.continuationPrompt ?? null,
      supplementalInstructions: sentPrompt?.additionalAgentInstructions ?? null,
      scenePolicy: sentPrompt?.scenePolicy ?? null,
      evidence: result?.observation ?? null,
      sourceUrl: null,
      recordCount: 1,
      feedback: result?.feedback ?? [],
      resultRecordId: result?.id,
      experiment: trial.experiment,
      roundReview: trial.roundReview,
    };
  });

  const harnessByKey = new Map<string, ProteinRunIndexEntry>();
  for (const batch of [...input.harnessRecords].sort((a, b) => b.createdAt - a.createdAt)) {
    for (const benchmarkCase of batch.comparison.cases) {
      for (const outcome of benchmarkCase.outcomes) {
        const key = outcome.referenceId ?? `${batch.id}:${benchmarkCase.id}:${outcome.id}`;
        if (outcome.referenceId) claimedViews.add(outcome.referenceId);
        const prior = harnessByKey.get(key);
        if (prior) {
          prior.recordCount++;
          continue;
        }
        const view = outcome.referenceId ? viewsById.get(outcome.referenceId) : null;
        harnessByKey.set(key, {
          id: `harness:${key}`,
          kind: 'harness-outcome',
          title: outcome.label,
          caseTitle: benchmarkCase.title,
          question: benchmarkCase.question,
          methodLabel: outcome.label,
          promptLabel: 'Prompt not recorded',
          promptSummary: null,
          harnessLabel:
            outcome.provenance === 'native-code' ? outcome.label : 'DNAForge prompt control',
          routeLabel: null,
          provenance: outcome.provenance === 'native-code' ? 'external-harness' : 'prompt-control',
          status: outcome.testResult?.status ?? 'unverified',
          createdAt: batch.createdAt,
          conversationId: view?.conversationId ?? null,
          conversationCount: view?.conversationCount ?? 0,
          outputIds: outcome.referenceId ? [outcome.referenceId] : [],
          promptCapture: 'none',
          promptInstructions: null,
          sentPrompt: null,
          sentPromptChannel: null,
          continuationPrompt: null,
          supplementalInstructions: null,
          scenePolicy: null,
          evidence: outcome.runEvidence ?? outcome.testResult?.observation ?? null,
          sourceUrl: outcome.sourceUrl ?? null,
          recordCount: 1,
          feedback: [],
        });
      }
    }
  }

  const otherSavedViews = input.savedViews
    .filter((view) => !claimedViews.has(view.id))
    .map(
      (view): ProteinRunIndexEntry => ({
        id: `saved:${view.id}`,
        kind: 'saved-view',
        title: view.label,
        caseTitle: view.pdbId ?? 'Unknown structure',
        question: null,
        methodLabel: 'Saved view · no recorded experiment',
        promptLabel: 'Prompt not recorded',
        promptSummary: null,
        harnessLabel: 'Unknown',
        routeLabel: null,
        provenance: 'unassigned',
        status: 'unassigned',
        createdAt: view.createdAt,
        conversationId: view.conversationId,
        conversationCount: view.conversationCount,
        outputIds: [view.id],
        promptCapture: 'none',
        promptInstructions: null,
        sentPrompt: null,
        sentPromptChannel: null,
        continuationPrompt: null,
        supplementalInstructions: null,
        scenePolicy: null,
        evidence: null,
        sourceUrl: null,
        recordCount: 0,
        feedback: [],
      })
    );

  const newestFirst = (a: ProteinRunIndexEntry, b: ProteinRunIndexEntry) =>
    b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  return {
    promptTrials: promptTrials.sort(newestFirst),
    harnessOutcomes: [...harnessByKey.values()].sort(newestFirst),
    otherSavedViews: otherSavedViews.sort(newestFirst),
  };
}
