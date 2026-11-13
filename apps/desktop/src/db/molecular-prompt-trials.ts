import {
  createEntityReference,
  getEntityReference,
  updateEntityReference,
  type DBEntityReference,
} from './entity-references';
import { getConnection } from './index';
import {
  parseMolecularPromptTrial,
  parseMolecularTrialSentPromptSnapshot,
  type MolecularPromptTrial,
  type MolecularTrialSentPromptSnapshot,
} from '../features/ai/molecular-prompt-trials';
import {
  molecularViewFromReferenceData,
  molecularViewSourceDigests,
} from '../features/page/public/embeds/structure3d/molecularView';
import { resolveMolecularDocumentResult } from '../features/molecular-documents/public/references';

const SOURCE = 'dnaforge-dev-protein-visualization';
const START_TYPE = 'protein_visual_prompt_trial';
const RESULT_TYPE = 'protein_visual_prompt_result';

export interface MolecularFixtureCandidate {
  referenceId: string;
  savedViewId: string;
  label: string;
  pdbId: string;
  coordinateSha256: string;
  scene: string;
}

export interface MolecularSavedViewIndexEntry {
  id: string;
  label: string;
  createdAt: number;
  pdbId: string | null;
  conversationId: string | null;
  conversationCount: number;
}

export interface MolecularPromptTrialVersion {
  resultId: string;
  referenceId: string;
  savedViewId: string;
  label: string;
  recordedAt: number;
  coordinateSha256: string;
}

export interface MolecularPromptTrialSiblingStructure {
  referenceId: string;
  savedViewId: string;
  label: string;
  coordinateSha256: string;
}

export async function listMolecularPromptTrialSiblingStructuresForSavedView(
  savedViewId: string
): Promise<MolecularPromptTrialSiblingStructure[]> {
  if (!savedViewId.startsWith('saved-view:')) return [];
  const db = await getConnection();
  const current = await db.select<Array<{ id: string; digest: string | null }>>(
    `SELECT id, json_extract(data, '$.coordinates.sha256') AS digest
     FROM entity_references WHERE entity_type = 'structure' AND locator = ?
     ORDER BY created_at DESC LIMIT 1`,
    [`entity://structure/${savedViewId}`]
  );
  if (!current[0]?.digest) return [];

  const rows = await db.select<
    Array<{
      reference_ids: string | null;
      coordinate_digests: string | null;
      recorded_at: number | null;
    }>
  >(
    `SELECT json_extract(data, '$.result.referenceIds') AS reference_ids,
            json_extract(data, '$.result.coordinateDigests') AS coordinate_digests,
            json_extract(data, '$.result.recordedAt') AS recorded_at
     FROM entity_references WHERE entity_type = ? AND source = ?
       AND json_extract(data, '$.result.status') = 'rendered'`,
    [RESULT_TYPE, SOURCE]
  );
  const owner = rows
    .flatMap((row) => {
      try {
        const referenceIds: unknown = JSON.parse(row.reference_ids ?? 'null');
        const coordinateDigests: unknown = JSON.parse(row.coordinate_digests ?? 'null');
        if (
          !Array.isArray(referenceIds) ||
          !Array.isArray(coordinateDigests) ||
          referenceIds.length < 2 ||
          referenceIds.length !== coordinateDigests.length ||
          !referenceIds.every((id) => typeof id === 'string') ||
          !coordinateDigests.every((digest) => typeof digest === 'string') ||
          new Set(coordinateDigests).size !== coordinateDigests.length ||
          !referenceIds.some(
            (id, index) => id === current[0].id && coordinateDigests[index] === current[0].digest
          )
        )
          return [];
        return [
          {
            referenceIds: referenceIds as string[],
            coordinateDigests: coordinateDigests as string[],
            recordedAt: row.recorded_at ?? 0,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.recordedAt - a.recordedAt)[0];
  if (!owner) return [];

  const references = await db.select<
    Array<{ id: string; locator: string; label: string; digest: string | null }>
  >(
    `SELECT id, locator, display_label AS label,
            json_extract(data, '$.coordinates.sha256') AS digest
     FROM entity_references WHERE entity_type = 'structure'
       AND id IN (${owner.referenceIds.map(() => '?').join(',')})`,
    owner.referenceIds
  );
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const siblings = owner.referenceIds.map((referenceId, index) => {
    const reference = byId.get(referenceId);
    const id = reference?.locator.match(/^entity:\/\/structure\/(saved-view:[^/]+)$/)?.[1];
    if (!reference || !id || reference.digest !== owner.coordinateDigests[index]) return null;
    return {
      referenceId,
      savedViewId: id,
      label: reference.label,
      coordinateSha256: owner.coordinateDigests[index],
    };
  });
  return siblings.every((sibling) => sibling !== null)
    ? (siblings as MolecularPromptTrialSiblingStructure[])
    : [];
}

export async function listMolecularPromptTrialVersionsForSavedView(
  savedViewId: string
): Promise<MolecularPromptTrialVersion[]> {
  if (!savedViewId.startsWith('saved-view:')) return [];
  const db = await getConnection();
  const views = await db.select<Array<{ id: string; digest: string | null }>>(
    `SELECT id, json_extract(data, '$.coordinates.sha256') AS digest
     FROM entity_references WHERE entity_type = 'structure' AND locator = ?
     ORDER BY created_at DESC LIMIT 1`,
    [`entity://structure/${savedViewId}`]
  );
  const current = views[0];
  if (!current?.digest) return [];
  const coordinateSha256 = current.digest;

  const rows = await db.select<
    Array<{
      id: string;
      case_id: string | null;
      label: string | null;
      profile_id: string | null;
      status: string | null;
      reference_ids: string | null;
      coordinate_digests: string | null;
      recorded_at: number | null;
    }>
  >(
    `SELECT id,
       json_extract(data, '$.result.trial.caseId') AS case_id,
       json_extract(data, '$.result.trial.profileLabel') AS label,
       json_extract(data, '$.result.trial.profileId') AS profile_id,
       json_extract(data, '$.result.status') AS status,
       json_extract(data, '$.result.referenceIds') AS reference_ids,
       json_extract(data, '$.result.coordinateDigests') AS coordinate_digests,
       json_extract(data, '$.result.recordedAt') AS recorded_at
     FROM entity_references WHERE entity_type = ? AND source = ?`,
    [RESULT_TYPE, SOURCE]
  );
  const parsed = rows.flatMap((row) => {
    try {
      const referenceIds = JSON.parse(row.reference_ids ?? 'null');
      const coordinateDigests = JSON.parse(row.coordinate_digests ?? 'null');
      if (
        row.status !== 'rendered' ||
        !row.case_id ||
        !Array.isArray(referenceIds) ||
        !Array.isArray(coordinateDigests) ||
        referenceIds.length !== coordinateDigests.length ||
        typeof row.recorded_at !== 'number'
      )
        return [];
      return [
        {
          resultId: row.id,
          caseId: row.case_id,
          label: row.label || row.profile_id || 'Recorded run',
          referenceIds: referenceIds as string[],
          coordinateDigests: coordinateDigests as string[],
          recordedAt: row.recorded_at,
        },
      ];
    } catch {
      return [];
    }
  });
  const owner = parsed
    .filter((row) =>
      row.referenceIds.some(
        (id, index) => id === current.id && row.coordinateDigests[index] === coordinateSha256
      )
    )
    .sort((a, b) => b.recordedAt - a.recordedAt)[0];
  if (!owner) return [];
  const outputIndex = owner.referenceIds.indexOf(current.id);
  const comparable = parsed.filter(
    (row) =>
      row.caseId === owner.caseId &&
      row.coordinateDigests[outputIndex] === coordinateSha256 &&
      typeof row.referenceIds[outputIndex] === 'string'
  );
  if (comparable.length === 0) return [];

  const ids = [...new Set(comparable.map((row) => row.referenceIds[outputIndex]))];
  const references = await db.select<Array<{ id: string; locator: string }>>(
    `SELECT id, locator FROM entity_references WHERE entity_type = 'structure'
     AND id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const locators = new Map(references.map((row) => [row.id, row.locator]));
  return comparable
    .flatMap((row) => {
      const referenceId = row.referenceIds[outputIndex];
      const candidateSavedViewId = locators
        .get(referenceId)
        ?.match(/^entity:\/\/structure\/(saved-view:[^/]+)$/)?.[1];
      return candidateSavedViewId
        ? [
            {
              resultId: row.resultId,
              referenceId,
              savedViewId: candidateSavedViewId,
              label: row.label,
              recordedAt: row.recordedAt,
              coordinateSha256,
            },
          ]
        : [];
    })
    .sort((a, b) => a.recordedAt - b.recordedAt || a.resultId.localeCompare(b.resultId));
}

export async function listMolecularSavedViewsForIndex(): Promise<MolecularSavedViewIndexEntry[]> {
  const rows = await getConnection().select<
    Array<{
      id: string;
      display_label: string;
      created_at: number;
      pdb_id: string | null;
      conversation_id: string | null;
      conversation_count: number;
    }>
  >(
    `SELECT er.id, er.display_label, er.created_at,
       json_extract(er.data, '$.source.sourceId') AS pdb_id,
       (SELECT COUNT(DISTINCT m.conversation_id)
        FROM message_references mr JOIN messages m ON m.id = mr.message_id
        WHERE mr.reference_id = er.id) AS conversation_count,
       (SELECT CASE WHEN COUNT(DISTINCT m.conversation_id) = 1
                    THEN MIN(m.conversation_id) ELSE NULL END
        FROM message_references mr JOIN messages m ON m.id = mr.message_id
        WHERE mr.reference_id = er.id) AS conversation_id
     FROM entity_references er
     WHERE er.entity_type = 'structure'
       AND json_extract(er.data, '$.kind') = 'molecular-view'
     ORDER BY er.created_at DESC, er.id DESC`
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.display_label,
    createdAt: row.created_at,
    pdbId: row.pdb_id,
    conversationId: row.conversation_id,
    conversationCount: row.conversation_count,
  }));
}

export async function listMolecularFixtureCandidates(): Promise<MolecularFixtureCandidate[]> {
  const rows = await getConnection().select<
    Array<{
      id: string;
      locator: string;
      display_label: string;
      pdb_id: string | null;
      coordinate_sha256: string | null;
      scene: string | null;
    }>
  >(
    `SELECT id, locator, display_label,
       json_extract(data, '$.source.sourceId') AS pdb_id,
       json_extract(data, '$.coordinates.sha256') AS coordinate_sha256,
       json_extract(data, '$.scene') AS scene
     FROM entity_references
     WHERE entity_type = 'structure' AND json_extract(data, '$.kind') = 'molecular-view'
       AND json_extract(data, '$.version') = 1
       AND length(json_extract(data, '$.source.sourceId')) = 4
       AND json_extract(data, '$.coordinates.sha256') IS NOT NULL
       AND json_extract(data, '$.scene') IS NOT NULL
     ORDER BY created_at DESC`
  );
  return rows.flatMap((row) => {
    const savedViewId = row.locator.match(/^entity:\/\/structure\/(saved-view:[^/]+)$/)?.[1];
    if (!savedViewId || !row.pdb_id || !row.coordinate_sha256 || !row.scene) return [];
    return [
      {
        referenceId: row.id,
        savedViewId,
        label: row.display_label,
        pdbId: row.pdb_id.toUpperCase(),
        coordinateSha256: row.coordinate_sha256,
        scene: row.scene,
      },
    ];
  });
}

export interface MolecularPromptTrialResult {
  trial: MolecularPromptTrial;
  status: 'rendered' | 'failed' | 'noncomparable';
  observation: string;
  referenceIds: string[];
  coordinateDigests: string[];

  sourceCoverage?: string[];
  cameraNodePresent: boolean;
  cameraChanged: boolean;
  sceneChanged: boolean;
  routeKey: string | null;
  promptSnapshot?: MolecularTrialSentPromptSnapshot | null;
  failure?: { stage: 'preparation'; agentDispatched: false };
  recordedAt: number;
}

export interface MolecularPromptTrialResultRecord extends MolecularPromptTrialResult {
  id: string;
  feedback: MolecularPromptTrialFeedback[];
}

export interface MolecularPromptTrialFeedback {
  id: string;
  viewReferenceId: string;
  text: string;
  assessment?: MolecularPromptTrialAssessment;
  recordedAt: number;
}

export type MolecularPromptTrialAssessment = 'acceptable' | 'needs-work' | 'uncertain';

function isMolecularPromptTrialAssessment(value: unknown): value is MolecularPromptTrialAssessment {
  return value === 'acceptable' || value === 'needs-work' || value === 'uncertain';
}

export const MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT = 'dnaforge:protein-prompt-trial-change';

export interface MolecularPromptTrialStartRecord {
  id: string;
  trial: MolecularPromptTrial;
}

export async function listMolecularPromptTrialStarts(): Promise<MolecularPromptTrialStartRecord[]> {
  const rows = await getConnection().select<DBEntityReference[]>(
    `SELECT * FROM entity_references WHERE entity_type = ? AND source = ? ORDER BY created_at DESC, id DESC`,
    [START_TYPE, SOURCE]
  );
  return rows.map((row) => {
    try {
      const data = JSON.parse(row.data ?? 'null');
      const trial =
        data?.kind === START_TYPE && data.version === 1
          ? parseMolecularPromptTrial(data.trial)
          : null;
      if (!trial) throw new Error('Invalid trial body.');
      return { id: row.id, trial };
    } catch {
      throw new Error(`Malformed protein trial start ${row.id}; corpus history is incomplete.`);
    }
  });
}

export interface MolecularPromptTrialViewPreview {
  id: string;
  label: string;
  preview: string | null;
  coordinateSha256: string | null;
}

export async function listMolecularPromptTrialViewPreviews(
  ids: string[]
): Promise<MolecularPromptTrialViewPreview[]> {
  if (ids.length === 0) return [];
  const results: MolecularPromptTrialViewPreview[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await getConnection().select<
      Array<{
        id: string;
        display_label: string;
        preview: string | null;
        coordinate_sha256: string | null;
      }>
    >(
      `SELECT id, display_label, json_extract(data, '$.preview') AS preview,
              json_extract(data, '$.coordinates.sha256') AS coordinate_sha256
       FROM entity_references WHERE entity_type = 'structure' AND id IN (${placeholders})`,
      chunk
    );
    results.push(
      ...rows.map((row) => ({
        id: row.id,
        label: row.display_label,
        preview: row.preview,
        coordinateSha256: row.coordinate_sha256,
      }))
    );
  }
  return results;
}

export async function saveMolecularPromptTrialStart(trial: MolecularPromptTrial): Promise<string> {
  const validated = parseMolecularPromptTrial(trial);
  if (!validated) throw new Error('Invalid fixed protein trial.');
  const row = await createEntityReference({
    entityType: START_TYPE,
    displayLabel: `Started ${validated.caseId} · ${validated.profileId}`,
    locator: `dnaforge-dev://protein-prompt-trial/${validated.conversationId}`,
    deepLinkParams: null,
    data: { kind: START_TYPE, version: 1, trial: validated },
    source: SOURCE,
    workspaceScope: null,
    workspaceRootPath: null,
  });
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT));
  return row.id;
}

export async function saveMolecularPromptTrialResult(
  result: MolecularPromptTrialResult
): Promise<string> {
  const trial = parseMolecularPromptTrial(result.trial);
  if (!trial || !trial.startRecordId) throw new Error('The trial has no recorded fixed start.');
  if (result.failure) {
    if (
      result.failure.stage !== 'preparation' ||
      result.failure.agentDispatched !== false ||
      result.status !== 'failed' ||
      result.promptSnapshot != null ||
      result.routeKey !== null ||
      result.referenceIds.length !== 0 ||
      result.coordinateDigests.length !== 0 ||
      result.cameraNodePresent ||
      result.cameraChanged ||
      result.sceneChanged
    )
      throw new Error(
        'A preparation failure cannot claim an agent prompt, route, or rendered output.'
      );
    const turns = await getConnection().select<Array<{ id: string }>>(
      'SELECT id FROM chat_turns WHERE conversation_id = ? LIMIT 1',
      [trial.conversationId]
    );
    if (turns.length !== 0)
      throw new Error('Cannot record a preparation failure after an agent turn was created.');
  } else if (!result.promptSnapshot?.scenePolicy)
    throw new Error(
      'Cannot record a comparison result without the exact app-sent prompt and enforced scene rules.'
    );
  if (
    result.promptSnapshot?.channel === 'cli-seed' &&
    !result.promptSnapshot.continuationPrompt?.trim()
  )
    throw new Error('Cannot record a CLI comparison result without its exact continuation prompt.');
  if (
    result.promptSnapshot &&
    (!parseMolecularTrialSentPromptSnapshot(result.promptSnapshot) ||
      result.promptSnapshot.conversationId !== trial.conversationId)
  )
    throw new Error('The sent prompt snapshot does not belong to this trial.');
  if (result.status === 'rendered') {
    let validCoverage: boolean;
    if (result.sourceCoverage) {
      const outputs = await Promise.all(
        result.referenceIds.map(async (id) => {
          const reference = await getEntityReference(id);
          return reference?.entity_type === 'molecular-document'
            ? (await resolveMolecularDocumentResult(reference.id)).snapshot
            : reference?.entity_type === 'structure'
              ? molecularViewFromReferenceData(reference.data)
              : null;
        })
      );
      const coverage = new Set(
        outputs.flatMap((view) => (view ? molecularViewSourceDigests(view) : []))
      );
      validCoverage =
        outputs.length > 0 &&
        outputs.every(Boolean) &&
        new Set(result.referenceIds).size === result.referenceIds.length &&
        result.coordinateDigests.length === outputs.length &&
        outputs.every(
          (view, index) => view!.coordinates.sha256 === result.coordinateDigests[index]
        ) &&
        result.sourceCoverage.length === coverage.size &&
        result.sourceCoverage.every((digest) => coverage.has(digest)) &&
        coverage.size === trial.fixtures.length &&
        trial.fixtures.every((f) => coverage.has(f.coordinateSha256));
    } else {
      validCoverage =
        result.referenceIds.length === trial.fixtures.length &&
        result.coordinateDigests.length === trial.fixtures.length &&
        result.coordinateDigests.every(
          (digest, index) => digest === trial.fixtures[index].coordinateSha256
        );
    }
    if (!validCoverage || !result.sceneChanged || !result.cameraNodePresent)
      throw new Error(
        'A rendered trial needs new camera-controlled scenes covering every exact pinned coordinate structure.'
      );
  }
  const row = await createEntityReference({
    entityType: RESULT_TYPE,
    displayLabel: `${trial.caseId} · ${trial.profileId} · ${result.status}`,
    locator: `dnaforge-dev://protein-prompt-result/${crypto.randomUUID()}`,
    deepLinkParams: null,
    data: { kind: RESULT_TYPE, version: 1, result },
    source: SOURCE,
    workspaceScope: null,
    workspaceRootPath: null,
  });
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT));
  return row.id;
}

function parseResultRow(row: DBEntityReference): MolecularPromptTrialResultRecord | null {
  try {
    const data = JSON.parse(row.data ?? 'null');
    if (data?.kind !== RESULT_TYPE || data?.version !== 1 || !data.result) return null;
    const result = data.result as MolecularPromptTrialResult;
    const trial = parseMolecularPromptTrial(result.trial);
    if (!trial || !['rendered', 'failed', 'noncomparable'].includes(result.status)) return null;
    const promptSnapshot = result.promptSnapshot
      ? parseMolecularTrialSentPromptSnapshot(result.promptSnapshot)
      : null;
    const rawFeedback = data.feedback ?? [];
    if (!Array.isArray(rawFeedback)) return null;
    const feedback: MolecularPromptTrialFeedback[] = rawFeedback.filter(
      (item: unknown): item is MolecularPromptTrialFeedback => {
        if (!item || typeof item !== 'object') return false;
        const entry = item as Record<string, unknown>;
        return (
          typeof entry.id === 'string' &&
          typeof entry.viewReferenceId === 'string' &&
          result.referenceIds.includes(entry.viewReferenceId) &&
          typeof entry.text === 'string' &&
          (entry.assessment === undefined || isMolecularPromptTrialAssessment(entry.assessment)) &&
          typeof entry.recordedAt === 'number'
        );
      }
    );
    if (feedback.length !== rawFeedback.length) return null;
    if (
      result.promptSnapshot &&
      (!promptSnapshot || promptSnapshot.conversationId !== trial.conversationId)
    )
      return null;
    return {
      ...result,
      promptSnapshot,
      trial,
      id: row.id,
      feedback,
    };
  } catch {
    return null;
  }
}

export async function appendMolecularPromptTrialFeedback(
  resultId: string,
  viewReferenceId: string,
  text: string,
  assessment?: MolecularPromptTrialAssessment
): Promise<MolecularPromptTrialFeedback> {
  const row = await getEntityReference(resultId);
  const result = row && parseResultRow(row);
  if (!row || !result) throw new Error('The recorded protein trial does not exist.');
  if (!result.referenceIds.includes(viewReferenceId))
    throw new Error('This saved view does not belong to the recorded trial.');
  const note = text.trim();
  if (!note || note.length > 2_000) throw new Error('Feedback must contain 1–2,000 characters.');
  if (assessment !== undefined && !isMolecularPromptTrialAssessment(assessment))
    throw new Error('Unknown protein view assessment.');
  const entry: MolecularPromptTrialFeedback = {
    id: crypto.randomUUID(),
    viewReferenceId,
    text: note,
    ...(assessment ? { assessment } : {}),
    recordedAt: Date.now(),
  };
  const data = JSON.parse(row.data ?? 'null') as Record<string, unknown>;
  await updateEntityReference(resultId, {
    data: { ...data, feedback: [...result.feedback, entry] },
  });
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT));
  return entry;
}

export async function listMolecularPromptTrialResults(): Promise<
  MolecularPromptTrialResultRecord[]
> {
  const rows = await getConnection().select<DBEntityReference[]>(
    `SELECT * FROM entity_references WHERE entity_type = ? AND source = ? ORDER BY created_at DESC, id DESC`,
    [RESULT_TYPE, SOURCE]
  );
  return rows.map((row) => {
    const result = parseResultRow(row);
    if (!result)
      throw new Error(`Malformed protein trial result ${row.id}; corpus history is incomplete.`);
    return result;
  });
}

export function matchingMolecularTrialView(row: DBEntityReference, digest: string): boolean {
  const view = row.entity_type === 'structure' ? molecularViewFromReferenceData(row.data) : null;
  return view?.coordinates.sha256 === digest;
}
