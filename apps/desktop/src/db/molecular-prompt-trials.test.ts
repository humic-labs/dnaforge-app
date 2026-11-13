import {
  createEntityReferenceInDb,
  updateEntityReferenceInDb,
} from '../main/entity-reference-commands';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { createTestDb } from '../main/__tests__/test-db';
import { ensureSchema } from '../main/schema';
import { platform } from '../platform';
import { createEntityReference } from './entity-references';
import { molecularViewFixture } from '../test/fixtures/molecular-documents';
import type { MolecularView } from '../shared/molecular-view';
import { createMolecularPromptTrial } from '../features/ai/molecular-prompt-trials';
import { resolveMolecularDocumentResult } from '../features/molecular-documents/public/references';
import { molecularDocumentReferenceLocator } from '../shared/molecular-document-reference';
import {
  appendMolecularPromptTrialFeedback,
  listMolecularFixtureCandidates,
  listMolecularPromptTrialViewPreviews,
  listMolecularPromptTrialSiblingStructuresForSavedView,
  listMolecularPromptTrialVersionsForSavedView,
  listMolecularPromptTrialStarts,
  listMolecularPromptTrialResults,
  saveMolecularPromptTrialResult,
  saveMolecularPromptTrialStart,
  type MolecularPromptTrialResult,
} from './molecular-prompt-trials';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../main/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../features/molecular-documents/public/references', () => ({
  resolveMolecularDocumentResult: vi.fn(),
}));

describe('fixed-input protein prompt trial records', () => {
  let realDb: Database.Database | null = null;
  let snapshot: MolecularView;
  beforeEach(async () => {
    await initializeTestSchema();
    snapshot = await molecularViewFixture();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    realDb?.close();
    realDb = null;
  });

  it('keeps original fixed fixtures discoverable after more than 200 saved outputs', async () => {
    realDb = createTestDb();
    ensureSchema(realDb, ':memory:');
    const sqlite = realDb;
    vi.spyOn(platform().db, 'createEntityReference').mockImplementation(async (row) =>
      createEntityReferenceInDb(sqlite, row)
    );
    vi.spyOn(platform().db, 'updateEntityReference').mockImplementation(async (id, updates) =>
      updateEntityReferenceInDb(sqlite, id, updates)
    );
    vi.spyOn(platform().db, 'select').mockImplementation(
      async (sql, params) => sqlite.prepare(sql).all(...(params ?? [])) as never
    );
    vi.spyOn(platform().db, 'execute').mockImplementation(async (sql, params) => {
      const r = sqlite.prepare(sql).run(...(params ?? []));
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    });
    const create = async (sourceId?: string) =>
      createEntityReference({
        entityType: 'structure',
        displayLabel: 'Saved view',
        locator: 'entity://structure/saved-view:' + crypto.randomUUID(),
        deepLinkParams: null,
        data: {
          ...snapshot,
          kind: 'molecular-view',
          version: 1,
          source: { sourceId },
          coordinates: { ...snapshot.coordinates, sha256: 'a'.repeat(64) },
          scene: '{"root":{"kind":"root"}}',
        },
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: null,
      });
    const fixed = await create('1MK5');
    sqlite.prepare('UPDATE entity_references SET created_at=1 WHERE id=?').run(fixed.id);
    for (let i = 0; i < 205; i++) await create();
    const candidates = await listMolecularFixtureCandidates();
    expect(candidates.map((c) => c.referenceId)).toContain(fixed.id);
    expect(candidates.every((c) => c.pdbId === '1MK5')).toBe(true);
    for (let i = 0; i < 205; i++) await create('2XYZ');
    expect((await listMolecularFixtureCandidates()).map((c) => c.referenceId)).toContain(fixed.id);
  });

  it('reads coordinate identities for saved-output navigation without fetching coordinate text', async () => {
    realDb = createTestDb();
    ensureSchema(realDb, ':memory:');
    const sqlite = realDb;
    vi.spyOn(platform().db, 'createEntityReference').mockImplementation(async (row) =>
      createEntityReferenceInDb(sqlite, row)
    );
    vi.spyOn(platform().db, 'updateEntityReference').mockImplementation(async (id, updates) =>
      updateEntityReferenceInDb(sqlite, id, updates)
    );
    vi.spyOn(platform().db, 'select').mockImplementation(
      async (sql, params) => sqlite.prepare(sql).all(...(params ?? [])) as never
    );
    vi.spyOn(platform().db, 'execute').mockImplementation(async (sql, params) => {
      const result = sqlite.prepare(sql).run(...(params ?? []));
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    });
    const first = await createEntityReference({
      entityType: 'structure',
      displayLabel: 'Prefusion F',
      locator: 'entity://structure/saved-view:prefusion',
      deepLinkParams: null,
      data: {
        ...snapshot,
        kind: 'molecular-view',
        preview: 'data:image/png;base64,AA==',
        coordinates: {
          ...snapshot.coordinates,
          sha256: 'a'.repeat(64),
          text: 'large pinned coordinates',
        },
      },
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });
    const second = await createEntityReference({
      entityType: 'structure',
      displayLabel: 'Postfusion F',
      locator: 'entity://structure/saved-view:postfusion',
      deepLinkParams: null,
      data: {
        ...snapshot,
        kind: 'molecular-view',
        preview: 'data:image/png;base64,BB==',
        coordinates: {
          ...snapshot.coordinates,
          sha256: 'b'.repeat(64),
          text: 'other pinned coordinates',
        },
      },
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });
    const previews = await listMolecularPromptTrialViewPreviews([first.id, second.id]);
    expect(previews).toHaveLength(2);
    expect(previews).toEqual(
      expect.arrayContaining([
        {
          id: first.id,
          label: 'Prefusion F',
          preview: 'data:image/png;base64,AA==',
          coordinateSha256: 'a'.repeat(64),
        },
        {
          id: second.id,
          label: 'Postfusion F',
          preview: 'data:image/png;base64,BB==',
          coordinateSha256: 'b'.repeat(64),
        },
      ])
    );
  });

  it('records the actual preparation error only when no agent turn exists', async () => {
    realDb = createTestDb();
    ensureSchema(realDb, ':memory:');
    const sqlite = realDb;
    vi.spyOn(platform().db, 'createEntityReference').mockImplementation(async (row) =>
      createEntityReferenceInDb(sqlite, row)
    );
    vi.spyOn(platform().db, 'updateEntityReference').mockImplementation(async (id, updates) =>
      updateEntityReferenceInDb(sqlite, id, updates)
    );
    vi.spyOn(platform().db, 'select').mockImplementation(
      async (sql, params) => sqlite.prepare(sql).all(...(params ?? [])) as never
    );
    vi.spyOn(platform().db, 'execute').mockImplementation(async (sql, params) => {
      const result = sqlite.prepare(sql).run(...(params ?? []));
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    });

    const conversationId = crypto.randomUUID();
    const trial = createMolecularPromptTrial({
      conversationId,
      caseId: 'kcsa',
      profileId: 'camera-v1',
      fixtures: [
        {
          pdbId: '1K4C',
          referenceId: crypto.randomUUID(),
          savedViewId: `saved-view:${crypto.randomUUID()}`,
          coordinateSha256: 'a'.repeat(64),
          initialSceneSha256: 'b'.repeat(64),
          initialCameraSignature: '[]',
          structureSignature: '["assembly:1"]',
        },
      ],
    });
    const startRecordId = await saveMolecularPromptTrialStart(trial);
    const failure: MolecularPromptTrialResult = {
      trial: { ...trial, startRecordId },
      status: 'failed',
      observation:
        "Cannot read properties of undefined (reading 'name'). The previous scene was restored.",
      referenceIds: [],
      coordinateDigests: [],
      cameraNodePresent: false,
      cameraChanged: false,
      sceneChanged: false,
      routeKey: null,
      promptSnapshot: null,
      failure: { stage: 'preparation', agentDispatched: false },
      recordedAt: Date.now(),
    };
    const id = await saveMolecularPromptTrialResult(failure);
    expect(await listMolecularPromptTrialResults()).toContainEqual(
      expect.objectContaining({
        id,
        observation: failure.observation,
        status: 'failed',
        promptSnapshot: null,
        failure: { stage: 'preparation', agentDispatched: false },
      })
    );
    await expect(
      saveMolecularPromptTrialResult({ ...failure, failure: undefined })
    ).rejects.toThrow(/exact app-sent prompt/);
    await expect(
      saveMolecularPromptTrialResult({ ...failure, status: 'rendered' })
    ).rejects.toThrow(/cannot claim/);
    await expect(
      saveMolecularPromptTrialResult({ ...failure, sceneChanged: true })
    ).rejects.toThrow(/cannot claim/);

    sqlite
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(conversationId, 'Actual dispatched turn', 1, 1);
    sqlite
      .prepare(
        `INSERT INTO chat_turns
      (id, conversation_id, route_kind, host_id, route_snapshot_json, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), conversationId, 'cli', 'codex-sdk', '{}', 'running', 2);
    await expect(saveMolecularPromptTrialResult(failure)).rejects.toThrow(/after an agent turn/);
    expect(await listMolecularPromptTrialResults()).toHaveLength(1);
  });

  it('retains a separate fixed start and comparable saved-view outcome', async () => {
    const scene = JSON.stringify({
      kind: 'single',
      root: {
        kind: 'root',
        children: [{ kind: 'structure', params: { type: 'assembly', assembly_id: '1' } }],
      },
    });
    const savedViewId = 'saved-view:00000000-0000-4000-8000-000000000005';
    const reference = await createEntityReference({
      entityType: 'structure',
      displayLabel: 'Pinned KcsA assembly',
      locator: `entity://structure/${savedViewId}`,
      deepLinkParams: null,
      data: {
        ...snapshot,
        kind: 'molecular-view',
        source: { sourceId: '1K4C' },
        coordinates: { ...snapshot.coordinates, sha256: 'a'.repeat(64) },
        scene,
      },
      source: 'ai',
      workspaceScope: null,
      workspaceRootPath: null,
    });
    const trial = createMolecularPromptTrial({
      conversationId: '00000000-0000-4000-8000-000000000006',
      caseId: 'kcsa',
      profileId: 'camera-v1',
      fixtures: [
        {
          pdbId: '1K4C',
          referenceId: reference.id,
          savedViewId,
          coordinateSha256: 'a'.repeat(64),
          initialSceneSha256: 'b'.repeat(64),
          initialCameraSignature: '[]',
          structureSignature: '["assembly:1"]',
        },
      ],
      startedAt: 10,
    });
    const startRecordId = await saveMolecularPromptTrialStart(trial);
    expect(await listMolecularPromptTrialStarts()).toContainEqual(
      expect.objectContaining({
        id: startRecordId,
        trial: expect.objectContaining({
          conversationId: trial.conversationId,
          profileId: 'camera-v1',
          promptInstructions: trial.promptInstructions,
        }),
      })
    );
    const comparableResult = {
      trial: { ...trial, startRecordId },
      status: 'rendered' as const,
      observation: 'Camera and depiction changed on the pinned assembly.',
      referenceIds: [reference.id],
      coordinateDigests: ['a'.repeat(64)],
      cameraNodePresent: true,
      cameraChanged: true,
      sceneChanged: true,
      routeKey: '["cli","codex-sdk"]',
      promptSnapshot: {
        version: 1 as const,
        conversationId: trial.conversationId,
        turnId: '00000000-0000-4000-8000-000000000007',
        channel: 'cli-seed' as const,
        prompt: 'Exact prompt at send time',
        continuationPrompt: 'Exact continuation prompt',
        additionalAgentInstructions: null,
        capturedAt: 15,
        scenePolicy: {
          id: 'mvs-agent-scene-v1',
          enforcedConstraints: [
            {
              id: 'background-locked',
              errorCode: 'MVS_BACKGROUND_LOCKED',
              label: 'Background locked',
              enforcement: 'Agent scene application',
            },
          ],
        },
      },
      recordedAt: 20,
    };
    await expect(
      saveMolecularPromptTrialResult({
        ...comparableResult,
        promptSnapshot: null,
      })
    ).rejects.toThrow(/exact app-sent prompt/);
    await expect(
      saveMolecularPromptTrialResult({
        ...comparableResult,
        promptSnapshot: { ...comparableResult.promptSnapshot, continuationPrompt: null },
      })
    ).rejects.toThrow(/continuation prompt/);
    await expect(
      saveMolecularPromptTrialResult({
        ...comparableResult,
        coordinateDigests: ['c'.repeat(64)],
      })
    ).rejects.toThrow(/exact pinned coordinate structure/);
    await expect(
      saveMolecularPromptTrialResult({
        ...comparableResult,
        promptSnapshot: {
          ...comparableResult.promptSnapshot,
          conversationId: '00000000-0000-4000-8000-000000000008',
        },
      })
    ).rejects.toThrow(/does not belong to this trial/);
    const resultRecordId = await saveMolecularPromptTrialResult(comparableResult);
    const documentReference = {
      kind: 'molecular-document' as const,
      version: 1 as const,
      projectId: 'trial-project',
      documentId: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      revisionSha256: 'd'.repeat(64),
    };
    const documentRow = await createEntityReference({
      entityType: 'molecular-document',
      displayLabel: 'Owned trial output',
      locator: molecularDocumentReferenceLocator(documentReference),
      deepLinkParams: null,
      data: documentReference,
      source: 'ai',
      workspaceScope: documentReference.projectId,
      workspaceRootPath: '/workspace/trial-project',
    });
    const ownedResult = {
      ...comparableResult,
      referenceIds: [documentRow.id],
      sourceCoverage: ['a'.repeat(64)],
    };
    vi.mocked(resolveMolecularDocumentResult).mockRejectedValueOnce(
      Error('The document file is unavailable.')
    );
    await expect(saveMolecularPromptTrialResult(ownedResult)).rejects.toThrow(
      'document file is unavailable'
    );
    vi.mocked(resolveMolecularDocumentResult).mockResolvedValueOnce({
      snapshot: {
        ...snapshot,
        scene,
        coordinates: { ...snapshot.coordinates, sha256: 'a'.repeat(64) },
      },
    } as never);
    await saveMolecularPromptTrialResult(ownedResult);
    expect(resolveMolecularDocumentResult).toHaveBeenLastCalledWith(documentRow.id);
    expect(startRecordId).not.toBe(resultRecordId);
    expect(await listMolecularPromptTrialResults()).toContainEqual(
      expect.objectContaining({
        id: resultRecordId,
        status: 'rendered',
        referenceIds: [reference.id],
        promptSnapshot: expect.objectContaining({ prompt: 'Exact prompt at send time' }),
        trial: expect.objectContaining({
          conversationId: trial.conversationId,
          context: trial.context,
          fixtures: trial.fixtures,
        }),
      })
    );
    await expect(
      appendMolecularPromptTrialFeedback(
        resultRecordId,
        '00000000-0000-4000-8000-000000000099',
        'This view is one of the best yet.'
      )
    ).rejects.toThrow(/does not belong/);
    await appendMolecularPromptTrialFeedback(
      resultRecordId,
      reference.id,
      'This view is one of the best yet.'
    );
    expect(await listMolecularPromptTrialResults()).toContainEqual(
      expect.objectContaining({
        id: resultRecordId,
        observation: 'Camera and depiction changed on the pinned assembly.',
        feedback: [
          expect.objectContaining({
            viewReferenceId: reference.id,
            text: 'This view is one of the best yet.',
          }),
        ],
      })
    );
    const assessment = await appendMolecularPromptTrialFeedback(
      resultRecordId,
      reference.id,
      'The pocket and ion positions are legible.',
      'acceptable'
    );
    expect(assessment).toMatchObject({
      viewReferenceId: reference.id,
      assessment: 'acceptable',
    });
    expect(
      (await listMolecularPromptTrialResults()).find((item) => item.id === resultRecordId)?.feedback
    ).toContainEqual(expect.objectContaining({ id: assessment.id, assessment: 'acceptable' }));
    await expect(
      appendMolecularPromptTrialFeedback(
        resultRecordId,
        reference.id,
        'Invalid',
        'excellent' as never
      )
    ).rejects.toThrow(/assessment/);
    const malformed = await createEntityReference({
      entityType: 'protein_visual_prompt_result',
      displayLabel: 'Malformed result',
      locator: 'dnaforge-dev://protein-prompt-result/broken',
      deepLinkParams: null,
      data: { kind: 'protein_visual_prompt_result', version: 1, result: { status: 'invalid' } },
      source: 'dnaforge-dev-protein-visualization',
      workspaceScope: null,
      workspaceRootPath: null,
    });
    await expect(listMolecularPromptTrialResults()).rejects.toThrow(malformed.id);
  });

  it('lists only recorded versions of the same question and coordinate resource', async () => {
    realDb = createTestDb();
    realDb.exec(`CREATE TABLE entity_references (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, display_label TEXT NOT NULL,
      locator TEXT NOT NULL, deep_link_params TEXT, data TEXT,
      source TEXT NOT NULL, status TEXT NOT NULL,
      workspace_scope TEXT, workspace_root_path TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const sqlite = realDb;
    vi.spyOn(platform().db, 'createEntityReference').mockImplementation(async (row) =>
      createEntityReferenceInDb(sqlite, row)
    );
    vi.spyOn(platform().db, 'updateEntityReference').mockImplementation(async (id, updates) =>
      updateEntityReferenceInDb(sqlite, id, updates)
    );
    vi.spyOn(platform().db, 'select').mockImplementation(
      async (sql, params) => sqlite.prepare(sql).all(...(params ?? [])) as never
    );
    vi.spyOn(platform().db, 'execute').mockImplementation(async (sql, params) => {
      const result = sqlite.prepare(sql).run(...(params ?? []));
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    });
    const wildTypeDigest = 'a'.repeat(64);
    const mutantDigest = 'b'.repeat(64);
    const createView = async (savedViewId: string, digest: string) =>
      createEntityReference({
        entityType: 'structure',
        displayLabel: savedViewId,
        locator: `entity://structure/${savedViewId}`,
        deepLinkParams: null,
        data: { ...snapshot, coordinates: { ...snapshot.coordinates, sha256: digest } },
        source: 'ai',
        workspaceScope: null,
        workspaceRootPath: null,
      });
    const v3WildTypeId = 'saved-view:00000000-0000-4000-8000-000000000031';
    const v3MutantId = 'saved-view:00000000-0000-4000-8000-000000000032';
    const v4WildTypeId = 'saved-view:00000000-0000-4000-8000-000000000041';
    const v4MutantId = 'saved-view:00000000-0000-4000-8000-000000000042';
    const v3WildType = await createView(v3WildTypeId, wildTypeDigest);
    const v3Mutant = await createView(v3MutantId, mutantDigest);
    const v4WildType = await createView(v4WildTypeId, wildTypeDigest);
    const v4Mutant = await createView(v4MutantId, mutantDigest);

    const saveVersion = async (
      conversationId: string,
      label: string,
      recordedAt: number,
      wildType: typeof v3WildType,
      mutant: typeof v3Mutant,
      wildTypeId: string,
      mutantId: string
    ) => {
      const trial = createMolecularPromptTrial({
        conversationId,
        caseId: 'streptavidin-w120f',
        variant: { id: `custom:${label}`, label, instructions: 'Show the binding evidence.' },
        fixtures: [
          {
            pdbId: '1MK5',
            referenceId: wildType.id,
            savedViewId: wildTypeId,
            coordinateSha256: wildTypeDigest,
            initialSceneSha256: 'c'.repeat(64),
            initialCameraSignature: '[]',
            structureSignature: '["assembly:1"]',
          },
          {
            pdbId: '1SWP',
            referenceId: mutant.id,
            savedViewId: mutantId,
            coordinateSha256: mutantDigest,
            initialSceneSha256: 'd'.repeat(64),
            initialCameraSignature: '[]',
            structureSignature: '["assembly:1"]',
          },
        ],
        startedAt: recordedAt - 1,
      });
      const startRecordId = await saveMolecularPromptTrialStart(trial);
      await saveMolecularPromptTrialResult({
        trial: { ...trial, startRecordId },
        status: 'rendered',
        observation: 'Saved.',
        referenceIds: [wildType.id, mutant.id],
        coordinateDigests: [wildTypeDigest, mutantDigest],
        cameraNodePresent: true,
        cameraChanged: true,
        sceneChanged: true,
        routeKey: '["cli","codex-sdk"]',
        recordedAt,
        promptSnapshot: {
          version: 1,
          conversationId,
          turnId: crypto.randomUUID(),
          channel: 'hosted-system',
          prompt: 'Exact prompt',
          additionalAgentInstructions: null,
          scenePolicy: {
            id: 'mvs-agent-scene-v4',
            enforcedConstraints: [
              {
                id: 'background-locked',
                label: 'Background locked',
                errorCode: 'MVS_BACKGROUND_LOCKED',
                enforcement: 'Scene validation',
              },
            ],
          },
          capturedAt: recordedAt,
        },
      });
    };
    await saveVersion(
      '00000000-0000-4000-8000-000000000033',
      'Relational evidence · v3',
      30,
      v3WildType,
      v3Mutant,
      v3WildTypeId,
      v3MutantId
    );
    await saveVersion(
      '00000000-0000-4000-8000-000000000043',
      'Evidence + context · v4',
      40,
      v4WildType,
      v4Mutant,
      v4WildTypeId,
      v4MutantId
    );

    expect(
      (await listMolecularPromptTrialVersionsForSavedView(v4WildTypeId)).map(
        ({ label, savedViewId }) => [label, savedViewId]
      )
    ).toEqual([
      ['Relational evidence · v3', v3WildTypeId],
      ['Evidence + context · v4', v4WildTypeId],
    ]);
    expect(
      (await listMolecularPromptTrialVersionsForSavedView(v4MutantId)).map(
        ({ savedViewId }) => savedViewId
      )
    ).toEqual([v3MutantId, v4MutantId]);
    expect(await listMolecularPromptTrialSiblingStructuresForSavedView(v4WildTypeId)).toEqual([
      {
        referenceId: v4WildType.id,
        savedViewId: v4WildTypeId,
        label: v4WildTypeId,
        coordinateSha256: wildTypeDigest,
      },
      {
        referenceId: v4Mutant.id,
        savedViewId: v4MutantId,
        label: v4MutantId,
        coordinateSha256: mutantDigest,
      },
    ]);
    expect(await listMolecularPromptTrialSiblingStructuresForSavedView(v4MutantId)).toHaveLength(2);
    const duplicateDigest = 'e'.repeat(64);
    const duplicateIds = [
      'saved-view:00000000-0000-4000-8000-000000000051',
      'saved-view:00000000-0000-4000-8000-000000000052',
    ];
    const duplicateViews = [
      await createView(duplicateIds[0], duplicateDigest),
      await createView(duplicateIds[1], duplicateDigest),
    ];
    const duplicateTrial = createMolecularPromptTrial({
      conversationId: '00000000-0000-4000-8000-000000000053',
      caseId: 'streptavidin-w120f',
      variant: {
        id: 'custom:duplicate-coordinates',
        label: 'Duplicate coordinates',
        instructions: 'Show both outputs.',
      },
      fixtures: duplicateViews.map((view, index) => ({
        pdbId: index === 0 ? '1MK5' : '1SWP',
        referenceId: view.id,
        savedViewId: duplicateIds[index],
        coordinateSha256: duplicateDigest,
        initialSceneSha256: 'f'.repeat(64),
        initialCameraSignature: '[]',
        structureSignature: '["assembly:1"]',
      })),
      startedAt: 49,
    });
    const duplicateStartId = await saveMolecularPromptTrialStart(duplicateTrial);
    await saveMolecularPromptTrialResult({
      trial: { ...duplicateTrial, startRecordId: duplicateStartId },
      status: 'rendered',
      observation: 'Two views of the same coordinates.',
      referenceIds: duplicateViews.map((view) => view.id),
      coordinateDigests: [duplicateDigest, duplicateDigest],
      cameraNodePresent: true,
      cameraChanged: true,
      sceneChanged: true,
      routeKey: '["cli","codex-sdk"]',
      recordedAt: 50,
      promptSnapshot: {
        version: 1,
        conversationId: duplicateTrial.conversationId,
        turnId: crypto.randomUUID(),
        channel: 'hosted-system',
        prompt: 'Exact prompt',
        additionalAgentInstructions: null,
        scenePolicy: {
          id: 'mvs-agent-scene-v4',
          enforcedConstraints: [
            {
              id: 'background-locked',
              label: 'Background locked',
              errorCode: 'MVS_BACKGROUND_LOCKED',
              enforcement: 'Scene validation',
            },
          ],
        },
        capturedAt: 50,
      },
    });
    expect(await listMolecularPromptTrialSiblingStructuresForSavedView(duplicateIds[0])).toEqual(
      []
    );
    expect(
      await listMolecularPromptTrialVersionsForSavedView(
        'saved-view:00000000-0000-4000-8000-000000000099'
      )
    ).toEqual([]);
    expect(
      await listMolecularPromptTrialSiblingStructuresForSavedView(
        'saved-view:00000000-0000-4000-8000-000000000099'
      )
    ).toEqual([]);
  });
});
