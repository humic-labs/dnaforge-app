import type {
  MolecularPromptTrialResultRecord,
  MolecularPromptTrialStartRecord,
} from '../../../../db/molecular-prompt-trials';

export type ProteinCorpusInput = {
  starts: readonly MolecularPromptTrialStartRecord[];
  results: readonly MolecularPromptTrialResultRecord[];
};

type TrialStatus = MolecularPromptTrialResultRecord['status'];

export type ProteinCorpusAttempt = {
  resultId: string;
  caseId: string;
  versionKey: string;
  versionLabel: string;
  slotKey: string;
  replicate: number | null;
  status: TrialStatus;
  recordedAt: number;
  recovery: boolean;
  promptCaptured: boolean;
  outputCount: number;
  feedbackNotes: number;
};

export type ProteinCorpusSlot = {
  key: string;
  caseId: string;
  versionKey: string;
  attemptIds: string[];
  effectiveStatus: TrialStatus;
  recovered: boolean;
  reviewedRendered: boolean;
  assessment: 'acceptable' | 'needs-work' | 'uncertain' | 'unassessed';
};

export type ProteinCorpusVersion = {
  key: string;
  label: string;
  labels: string[];
  sameGuidanceAs: string[];
  firstRecordedAt: number;
  cases: Array<{
    caseId: string;
    attempts: number;
    startsWithoutResult: number;
    slots: number;
    renderedSlots: number;
    failedSlots: number;
    reviewedRenderedSlots: number;
    acceptableRenderedSlots: number;
    needsWorkRenderedSlots: number;
    uncertainRenderedSlots: number;
    unassessedRenderedSlots: number;
  }>;
  attempts: number;
  startsWithoutResult: number;
  slots: number;
  renderedSlots: number;
  failedSlots: number;
  noncomparableSlots: number;
  recoveredSlots: number;
  reviewedRenderedSlots: number;
  unreviewedRenderedSlots: number;
  assessedRenderedSlots: number;
  acceptableRenderedSlots: number;
  needsWorkRenderedSlots: number;
  uncertainRenderedSlots: number;
  unassessedRenderedSlots: number;
  feedbackNotes: number;
  capturedPromptAttempts: number;
  missingPromptAttempts: number;
  basePromptPrefixes: number;
  renderProfiles: number;
  agentConfigurations: number;
};

export type ProteinCorpusLedger = {
  attempts: ProteinCorpusAttempt[];
  slots: ProteinCorpusSlot[];
  versions: ProteinCorpusVersion[];
  distinctGuidanceBodies: number;
  incompleteStarts: string[];
};

function versionGuidance(instructions: string): string {
  const marker = /\nPrompt module [^\n]+:\n/.exec(instructions);
  if (marker) {
    const start = marker.index + marker[0].length;
    const end = instructions.indexOf('\nPinned coordinate fixtures for this conversation:', start);
    return instructions.slice(start, end < 0 ? undefined : end);
  }
  return instructions.includes('Fixed protein benchmark context (v1):') ? '' : instructions;
}

function versionLabels(records: MolecularPromptTrialResultRecord[]): {
  label: string;
  labels: string[];
} {
  const counts = new Map<string, number>();
  for (const record of records) {
    const label = record.trial.profileLabel ?? record.trial.profileId;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = [...counts].sort(
    ([a, aCount], [b, bCount]) =>
      Number(/isolation failed/i.test(a)) - Number(/isolation failed/i.test(b)) ||
      bCount - aCount ||
      a.localeCompare(b)
  );
  return { label: labels[0][0], labels: labels.map(([label]) => label) };
}

function assessmentForRenderedResult(
  result: MolecularPromptTrialResultRecord
): ProteinCorpusSlot['assessment'] {
  if (result.status !== 'rendered' || result.referenceIds.length === 0) return 'unassessed';
  const latestByView = new Map<
    string,
    NonNullable<(typeof result.feedback)[number]['assessment']>
  >();
  for (const note of result.feedback ?? []) {
    if (note.assessment && result.referenceIds.includes(note.viewReferenceId))
      latestByView.set(note.viewReferenceId, note.assessment);
  }
  const verdicts = result.referenceIds.map((id) => latestByView.get(id));
  if (verdicts.includes('needs-work')) return 'needs-work';
  if (verdicts.some((verdict) => verdict === undefined)) return 'unassessed';
  if (verdicts.includes('uncertain')) return 'uncertain';
  return 'acceptable';
}

export function buildProteinCorpusLedger(input: ProteinCorpusInput): ProteinCorpusLedger {
  const seenResults = new Set<string>();
  const entries = [...input.results].sort(
    (a, b) => a.recordedAt - b.recordedAt || a.id.localeCompare(b.id)
  );
  const attempts: ProteinCorpusAttempt[] = [];
  const slotEntries = new Map<string, MolecularPromptTrialResultRecord[]>();
  const versionEntries = new Map<string, MolecularPromptTrialResultRecord[]>();
  for (const result of entries) {
    if (seenResults.has(result.id)) throw new Error(`Duplicate protein trial result: ${result.id}`);
    seenResults.add(result.id);
    const trial = result.trial;
    const versionKey = JSON.stringify([trial.profileId, versionGuidance(trial.promptInstructions)]);
    const rootExperiment = trial.experiment?.recoveryOfExperimentId ?? trial.experiment?.id;
    const slotKey = rootExperiment
      ? JSON.stringify([rootExperiment, trial.caseId, versionKey, trial.experiment?.replicate])
      : JSON.stringify(['unbatched', result.id]);
    const slot = slotEntries.get(slotKey) ?? [];
    slot.push(result);
    slotEntries.set(slotKey, slot);
    const version = versionEntries.get(versionKey) ?? [];
    version.push(result);
    versionEntries.set(versionKey, version);
    attempts.push({
      resultId: result.id,
      caseId: trial.caseId,
      versionKey,
      versionLabel: trial.profileLabel ?? trial.profileId,
      slotKey,
      replicate: trial.experiment?.replicate ?? null,
      status: result.status,
      recordedAt: result.recordedAt,
      recovery: !!trial.experiment?.recoveryOfExperimentId,
      promptCaptured: !!result.promptSnapshot?.prompt,
      outputCount: result.referenceIds.length,
      feedbackNotes: result.feedback?.length ?? 0,
    });
  }
  const slots: ProteinCorpusSlot[] = [...slotEntries].map(([key, records]) => {
    const effective = records[records.length - 1];
    return {
      key,
      caseId: effective.trial.caseId,
      versionKey: JSON.stringify([
        effective.trial.profileId,
        versionGuidance(effective.trial.promptInstructions),
      ]),
      attemptIds: records.map((result) => result.id),
      effectiveStatus: effective.status,
      recovered:
        effective.status === 'rendered' &&
        records.some((result) => result.id !== effective.id && result.status !== 'rendered'),
      reviewedRendered: records.some(
        (result) =>
          result.status === 'rendered' &&
          (result.feedback ?? []).some((note) => result.referenceIds.includes(note.viewReferenceId))
      ),
      assessment: assessmentForRenderedResult(effective),
    };
  });
  const completedStartIds = new Set(entries.map((result) => result.trial.startRecordId));
  const incomplete = input.starts.filter((start) => !completedStartIds.has(start.id));
  const incompleteByVersion = new Map<string, MolecularPromptTrialStartRecord[]>();
  for (const start of incomplete) {
    const key = JSON.stringify([
      start.trial.profileId,
      versionGuidance(start.trial.promptInstructions),
    ]);
    const group = incompleteByVersion.get(key) ?? [];
    group.push(start);
    incompleteByVersion.set(key, group);
    if (!versionEntries.has(key)) versionEntries.set(key, []);
  }
  const versions: ProteinCorpusVersion[] = [...versionEntries].map(([key, records]) => {
    const missingStarts = incompleteByVersion.get(key) ?? [];
    const ownSlots = slots.filter((slot) => slot.versionKey === key);
    const renderedSlots = ownSlots.filter((slot) => slot.effectiveStatus === 'rendered');
    const reviewedRenderedSlots = renderedSlots.filter((slot) => slot.reviewedRendered).length;
    const cases = [
      ...new Set([
        ...records.map((result) => result.trial.caseId),
        ...missingStarts.map((start) => start.trial.caseId),
      ]),
    ]
      .sort()
      .map((caseId) => {
        const caseSlots = ownSlots.filter((slot) => slot.caseId === caseId);
        return {
          caseId,
          attempts: records.filter((result) => result.trial.caseId === caseId).length,
          startsWithoutResult: missingStarts.filter((start) => start.trial.caseId === caseId)
            .length,
          slots: caseSlots.length,
          renderedSlots: caseSlots.filter((slot) => slot.effectiveStatus === 'rendered').length,
          failedSlots: caseSlots.filter((slot) => slot.effectiveStatus === 'failed').length,
          reviewedRenderedSlots: caseSlots.filter((slot) => slot.reviewedRendered).length,
          acceptableRenderedSlots: caseSlots.filter((slot) => slot.assessment === 'acceptable')
            .length,
          needsWorkRenderedSlots: caseSlots.filter((slot) => slot.assessment === 'needs-work')
            .length,
          uncertainRenderedSlots: caseSlots.filter((slot) => slot.assessment === 'uncertain')
            .length,
          unassessedRenderedSlots: caseSlots.filter(
            (slot) => slot.effectiveStatus === 'rendered' && slot.assessment === 'unassessed'
          ).length,
        };
      });
    const labels = records.length
      ? versionLabels(records)
      : {
          label: missingStarts[0].trial.profileLabel ?? missingStarts[0].trial.profileId,
          labels: [missingStarts[0].trial.profileLabel ?? missingStarts[0].trial.profileId],
        };
    return {
      key,
      ...labels,
      sameGuidanceAs: [],
      firstRecordedAt: records[0]?.recordedAt ?? missingStarts[0].trial.startedAt,
      cases,
      attempts: records.length,
      startsWithoutResult: missingStarts.length,
      slots: ownSlots.length,
      renderedSlots: renderedSlots.length,
      failedSlots: ownSlots.filter((slot) => slot.effectiveStatus === 'failed').length,
      noncomparableSlots: ownSlots.filter((slot) => slot.effectiveStatus === 'noncomparable')
        .length,
      recoveredSlots: ownSlots.filter((slot) => slot.recovered).length,
      reviewedRenderedSlots,
      unreviewedRenderedSlots: renderedSlots.length - reviewedRenderedSlots,
      assessedRenderedSlots: renderedSlots.filter((slot) => slot.assessment !== 'unassessed')
        .length,
      acceptableRenderedSlots: renderedSlots.filter((slot) => slot.assessment === 'acceptable')
        .length,
      needsWorkRenderedSlots: renderedSlots.filter((slot) => slot.assessment === 'needs-work')
        .length,
      uncertainRenderedSlots: renderedSlots.filter((slot) => slot.assessment === 'uncertain')
        .length,
      unassessedRenderedSlots: renderedSlots.filter((slot) => slot.assessment === 'unassessed')
        .length,
      feedbackNotes: records.reduce((sum, result) => sum + (result.feedback?.length ?? 0), 0),
      capturedPromptAttempts: records.filter((result) => !!result.promptSnapshot?.prompt).length,
      missingPromptAttempts: records.filter(
        (result) => !result.promptSnapshot?.prompt && result.failure?.stage !== 'preparation'
      ).length,
      basePromptPrefixes: new Set(
        records.flatMap((result) => {
          const prompt = result.promptSnapshot?.prompt;
          if (!prompt) return [];
          const marker = prompt.indexOf('Fixed protein benchmark context (v1):');
          return marker < 0 ? [] : [prompt.slice(0, marker)];
        })
      ).size,
      renderProfiles: new Set(
        records.flatMap((result) =>
          result.trial.execution?.renderProfile
            ? [JSON.stringify(result.trial.execution.renderProfile)]
            : []
        )
      ).size,
      agentConfigurations: new Set(
        records.flatMap((result) =>
          result.promptSnapshot?.agentConfiguration
            ? [JSON.stringify(result.promptSnapshot.agentConfiguration)]
            : []
        )
      ).size,
    };
  });
  const guidanceByKey = new Map(
    versions.map((version) => [version.key, (JSON.parse(version.key) as [string, string])[1]])
  );
  for (const version of versions) {
    version.sameGuidanceAs = versions
      .filter(
        (other) =>
          other.key !== version.key &&
          guidanceByKey.get(other.key) === guidanceByKey.get(version.key)
      )
      .map((other) => other.label);
  }
  versions.sort((a, b) => a.firstRecordedAt - b.firstRecordedAt || a.key.localeCompare(b.key));
  const incompleteStarts = incomplete.map((start) => start.id).sort();
  return {
    attempts,
    slots,
    versions,
    distinctGuidanceBodies: new Set(guidanceByKey.values()).size,
    incompleteStarts,
  };
}

export function proteinCorpusEvidenceBundle(input: ProteinCorpusInput, generatedAt = Date.now()) {
  return {
    schemaVersion: 1 as const,
    generatedAt,
    starts: structuredClone(input.starts),
    results: structuredClone(input.results),
    ledger: buildProteinCorpusLedger(input),
  };
}
