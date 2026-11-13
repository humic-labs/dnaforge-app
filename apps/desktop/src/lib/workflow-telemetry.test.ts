// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetTelemetryCorrelationForTests } from './telemetry-correlation';
import {
  abandonOpenWorkflowActions,
  beginWorkflowAction,
  errorClassFor,
  observeWorkflowAction,
  workflowCountBucket,
  WORKFLOW_ACTION_OBSERVED,
} from './workflow-telemetry';
import { MEANINGFUL_ACTIVITY_COMPLETED } from '../shared/meaningful-activity.generated';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';

const APP_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001';
const EPISODE_ID = '550e8400-e29b-41d4-a716-446655440002';
const ACTION_ID = '550e8400-e29b-41d4-a716-446655440005';
const EFFECT_ID = '550e8400-e29b-41d4-a716-446655440006';
const externalActivityAuthority = () => ({
  actorKind: 'external' as const,
  executionMode: 'interactive' as const,
  impersonated: false,
});
const meaningfulAuthorityProperties = {
  actor_kind: 'external',
  execution_mode: 'interactive',
  workspace_kind: 'unknown',
  historical: false,
  identity_resolution: 'direct_session',
  impersonated: false,
  $insert_id: ACTION_ID,
};

describe('workflow telemetry', () => {
  it('joins acknowledged Save counters to one native result through the production sanitizer', () => {
    const observations: Record<string, unknown>[] = [];
    const operation = beginWorkflowAction(
      {
        workflow: 'content',
        action: 'save',
        operationId: ACTION_ID,
        capturedRevision: 3,
      },
      {
        createId: () => EFFECT_ID,
        track: (_event, properties) => {
          observations.push(sanitizeClosedBetaProperties(properties));
          return true;
        },
        isIdentified: () => false,
      }
    );
    operation.complete({
      nativeActionId: APP_SESSION_ID,
      attemptCount: 1,
      wrote: true,
      dirty: false,
      acknowledgedRevision: 3,
      revisionRelation: 'acknowledged',
      outcomeKind: 'history_pending',
      status: 'saved',
    });
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      operation_id: ACTION_ID,
      action_phase: 'start',
      captured_revision: 3,
    });
    expect(observations[1]).toMatchObject({
      operation_id: ACTION_ID,
      native_action_id: APP_SESSION_ID,
      action_phase: 'result',
      captured_revision: 3,
      acknowledged_revision: 3,
      revision_relation: 'acknowledged',
      attempt_count: 1,
      wrote: true,
      dirty: false,
      outcome_kind: 'history_pending',
    });
    expect(operation.complete({ outcomeKind: 'history_committed' })).toBe(false);
    expect(observations).toHaveLength(2);
  });

  it('retains closed assembly material context across start and cancellation without another workflow', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const context = {
      assemblyComputeStage: 'draft_primers',
      assemblyMaterialRoute: 'mixed',
      pcrTemplateCount: 1,
    } as const;
    const operation = beginWorkflowAction(
      { workflow: 'assembly', action: 'compute', ...context },
      {
        track,
        isIdentified: () => false,
        createId: () => ACTION_ID,
      }
    );
    operation.cancel();
    expect(track).toHaveBeenCalledTimes(2);
    for (const [, properties] of track.mock.calls)
      expect(properties).toMatchObject({
        workflow: 'assembly',
        assembly_compute_stage: 'draft_primers',
        assembly_material_route: 'mixed',
        pcr_template_count: 1,
      });
  });

  it.each([1.5, 100001, Number.POSITIVE_INFINITY, '2'])(
    'rejects invalid PCR template count %s',
    (count) => {
      expect(sanitizeClosedBetaProperties({ pcr_template_count: count })).toEqual({});
    }
  );

  it('accepts only bounded assembly roles and counts in the production sanitizer', () => {
    expect(
      sanitizeClosedBetaProperties({
        assembly_compute_stage: 'draft_primers',
        assembly_material_route: 'mixed',
        pcr_template_count: 2,
      })
    ).toEqual({
      assembly_compute_stage: 'draft_primers',
      assembly_material_route: 'mixed',
      pcr_template_count: 2,
    });
    expect(
      sanitizeClosedBetaProperties({
        assembly_compute_stage: '/private/template',
        assembly_material_route: 'Private template',
        pcr_template_count: -1,
      })
    ).toEqual({});
  });

  it('joins a projection to its exact parent and never qualifies a second task', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const operation = beginWorkflowAction(
      {
        workflow: 'registry',
        action: 'create',
        workflowOrigin: 'projection',
        parentActionId: ACTION_ID,
      },
      { track, isIdentified: () => true, activityAuthority: externalActivityAuthority }
    );
    operation.complete({ status: 'created', affectedCount: 1 });
    expect(track).toHaveBeenCalledTimes(2);
    for (const [, properties] of track.mock.calls) {
      expect(properties).toMatchObject({
        workflow_origin: 'projection',
        parent_action_id: ACTION_ID,
      });
      expect(sanitizeClosedBetaProperties(properties)).toMatchObject({
        workflow_origin: 'projection',
        parent_action_id: ACTION_ID,
      });
    }
  });

  it.each(['registry', 'primer'] as const)(
    'does not qualify identical existing authority as a newly created %s task',
    (workflow) => {
      const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
      const operation = beginWorkflowAction(
        { workflow, action: 'create', workflowOrigin: 'direct' },
        { track, isIdentified: () => true, activityAuthority: externalActivityAuthority }
      );
      operation.complete({
        status: 'success',
        outcomeKind: 'record_existing',
        affectedCount: 0,
        recordWriteStatus: 'existing',
        recordProjectionStatus: 'ready',
        recordHistoryStatus: 'not_applicable',
      });
      expect(track).toHaveBeenCalledTimes(2);
    }
  );

  it('retains only closed record statuses and UUID parents at the real sanitizer', () => {
    expect(
      sanitizeClosedBetaProperties({
        workflow_origin: 'projection',
        parent_action_id: ACTION_ID,
        record_write_status: 'written',
        record_projection_status: 'failed',
        record_history_status: 'not_attempted',
        outcome_kind: 'record_existing',
        name: 'private name',
        fields: { secret: 'private content' },
      })
    ).toEqual({
      workflow_origin: 'projection',
      parent_action_id: ACTION_ID,
      record_write_status: 'written',
      record_projection_status: 'failed',
      record_history_status: 'not_attempted',
      outcome_kind: 'record_existing',
    });
    expect(
      sanitizeClosedBetaProperties({
        workflow_origin: 'private name',
        parent_action_id: '/private/file',
        record_write_status: 'private content',
        record_projection_status: 'private content',
        record_history_status: 'private content',
      })
    ).toEqual({});
  });

  afterEach(() => {
    sessionStorage.clear();
    __resetTelemetryCorrelationForTests();
  });

  it('pairs start and result with the same semantic action and session context', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const now = vi.fn().mockReturnValueOnce(1_100).mockReturnValueOnce(1_375);
    const ids = [ACTION_ID, EFFECT_ID];
    const operation = beginWorkflowAction(
      { workflow: 'annotation', action: 'create' },
      { track, now, createId: () => ids.shift() as string }
    );

    expect(operation.complete({ status: 'created', affectedCount: 1 })).toBe(true);
    expect(operation.complete()).toBe(false);
    expect(track).toHaveBeenNthCalledWith(
      1,
      WORKFLOW_ACTION_OBSERVED,
      expect.objectContaining({
        action_id: ACTION_ID,
        action_phase: 'start',
        workflow: 'annotation',
        workflow_action: 'create',
        app_session_id: APP_SESSION_ID,
        episode_correlation_id: EPISODE_ID,
      })
    );
    expect(track).toHaveBeenNthCalledWith(
      2,
      WORKFLOW_ACTION_OBSERVED,
      expect.objectContaining({
        action_id: ACTION_ID,
        effect_id: EFFECT_ID,
        action_phase: 'result',
        workflow_status: 'created',
        duration_ms: 275,
        affected_count: 1,
        success: true,
      })
    );
    const terminalProperties = track.mock.calls[1]?.[1];
    expect(terminalProperties).not.toHaveProperty('result_count');
    expect(terminalProperties).not.toHaveProperty('selected_count');
    expect(terminalProperties).not.toHaveProperty('state_revision');
    expect(terminalProperties).not.toHaveProperty('error_class');
    expect(terminalProperties).not.toHaveProperty('cached');
  });

  it('retains all query roles without qualifying catalog search as scientific activity', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const storePending = vi.fn(async () => {});
    for (const role of ['superseded', 'first_result', 'continuation'] as const) {
      beginWorkflowAction(
        {
          workflow: 'search',
          action: 'search',
          searchEpisodeId: EPISODE_ID,
          searchQueryRevision: 1,
        },
        {
          track,
          isIdentified: () => true,
          activityAuthority: externalActivityAuthority,
          storePending,
        }
      ).complete({ status: 'no_match', resultCount: 0, searchActivityRole: role });
    }
    expect(track.mock.calls.filter(([event]) => event === WORKFLOW_ACTION_OBSERVED)).toHaveLength(
      6
    );
    expect(
      track.mock.calls.filter(([event]) => event === MEANINGFUL_ACTIVITY_COMPLETED)
    ).toHaveLength(0);
    expect(track.mock.calls[0][1]).toEqual(
      expect.objectContaining({ search_episode_id: EPISODE_ID, search_query_revision: 1 })
    );
    expect(storePending).not.toHaveBeenCalled();
  });

  it('does not store catalog search for later scientific-activity identity linking', () => {
    const track = vi.fn(() => true);
    const storePending = vi.fn(async () => {});
    for (const role of ['first_result', 'continuation', 'superseded'] as const) {
      beginWorkflowAction(
        { workflow: 'search', action: 'search', searchEpisodeId: EPISODE_ID },
        {
          track,
          isIdentified: () => false,
          activityAuthority: externalActivityAuthority,
          storePending,
        }
      ).complete({ status: 'success', searchActivityRole: role });
    }
    expect(storePending).not.toHaveBeenCalled();
  });

  it('does not emit an orphan result when the start was rejected', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => false);
    const operation = beginWorkflowAction(
      { workflow: 'primer', action: 'attach' },
      { track, now: () => 100, createId: () => ACTION_ID }
    );

    expect(operation.complete({ status: 'attached' })).toBe(false);
    expect(track).toHaveBeenCalledTimes(1);
    expect(operation.consumed).toBe(true);
  });

  it('records one-shot commits with exact counts and one timestamp read', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const now = vi.fn(() => 2_000);
    const accepted = observeWorkflowAction(
      {
        workflow: 'amino_acid_selection',
        action: 'save',
        status: 'saved',
        selectedCount: 17,
      },
      { track, now, createId: () => ACTION_ID }
    );

    expect(accepted).toBe(true);
    expect(now).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith(
      WORKFLOW_ACTION_OBSERVED,
      expect.objectContaining({
        action_phase: 'commit',
        action_id: ACTION_ID,
        selected_count: 17,
        workflow_status: 'saved',
        occurred_at_ms: 2_000,
      })
    );
  });

  it('projects one identified qualifying terminal result into meaningful activity', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const ids = [ACTION_ID, EFFECT_ID];
    const operation = beginWorkflowAction(
      { workflow: 'annotation', action: 'create' },
      {
        track,
        isIdentified: () => true,
        activityAuthority: externalActivityAuthority,
        now: () => 2_000,
        createId: () => ids.shift() as string,
      }
    );

    expect(operation.complete({ status: 'created', affectedCount: 1 })).toBe(true);
    expect(operation.complete({ status: 'created', affectedCount: 1 })).toBe(false);
    expect(track).toHaveBeenCalledTimes(3);
    expect(track).toHaveBeenNthCalledWith(3, MEANINGFUL_ACTIVITY_COMPLETED, {
      feature_area: 'scientific_workflow',
      workflow: 'annotation',
      workflow_action: 'create',
      workflow_status: 'created',
      identity_kind: 'identified',
      ...meaningfulAuthorityProperties,
      action_id: ACTION_ID,
      initiated_at_ms: 2_000,
      qualified_at_ms: 2_000,
    });
  });

  it('projects an identified qualifying one-shot commit', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);

    expect(
      observeWorkflowAction(
        {
          workflow: 'amino_acid_selection',
          action: 'save',
          status: 'saved',
          selectedCount: 4,
        },
        {
          track,
          isIdentified: () => true,
          activityAuthority: externalActivityAuthority,
          now: () => 2_000,
          createId: () => ACTION_ID,
        }
      )
    ).toBe(true);
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenLastCalledWith(MEANINGFUL_ACTIVITY_COMPLETED, {
      feature_area: 'scientific_workflow',
      workflow: 'amino_acid_selection',
      workflow_action: 'save',
      workflow_status: 'saved',
      identity_kind: 'identified',
      ...meaningfulAuthorityProperties,
      action_id: ACTION_ID,
      initiated_at_ms: 2_000,
      qualified_at_ms: 2_000,
    });
  });

  it('attributes a one-shot completion to its supplied initiation time', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);

    expect(
      observeWorkflowAction(
        {
          workflow: 'benchling_migration',
          action: 'import',
          status: 'completed',
          usableResult: true,
          initiatedAtMs: 1_000,
        },
        {
          track,
          isIdentified: () => true,
          activityAuthority: externalActivityAuthority,
          now: () => 2_000,
          createId: () => ACTION_ID,
        }
      )
    ).toBe(true);
    expect(track).toHaveBeenLastCalledWith(
      MEANINGFUL_ACTIVITY_COMPLETED,
      expect.objectContaining({ initiated_at_ms: 1_000, qualified_at_ms: 2_000 })
    );
  });

  it('projects identified Hosted AI completion but not send or failure', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);

    expect(
      observeWorkflowAction(
        {
          workflow: 'hosted_ai',
          action: 'complete',
          status: 'completed',
          valueDelivered: true,
        },
        {
          track,
          isIdentified: () => true,
          activityAuthority: externalActivityAuthority,
          now: () => 2_000,
          createId: () => ACTION_ID,
        }
      )
    ).toBe(true);
    expect(track).toHaveBeenLastCalledWith(MEANINGFUL_ACTIVITY_COMPLETED, {
      feature_area: 'scientific_workflow',
      workflow: 'hosted_ai',
      workflow_action: 'complete',
      workflow_status: 'completed',
      identity_kind: 'identified',
      ...meaningfulAuthorityProperties,
      action_id: ACTION_ID,
      initiated_at_ms: 2_000,
      qualified_at_ms: 2_000,
      value_delivered: true,
    });

    track.mockClear();
    observeWorkflowAction(
      {
        workflow: 'hosted_ai',
        action: 'send',
        status: 'started',
      },
      {
        track,
        isIdentified: () => true,
        activityAuthority: externalActivityAuthority,
        now: () => 2_000,
        createId: () => ACTION_ID,
      }
    );
    observeWorkflowAction(
      {
        workflow: 'hosted_ai',
        action: 'complete',
        status: 'failed',
        success: false,
      },
      {
        track,
        isIdentified: () => true,
        activityAuthority: externalActivityAuthority,
        now: () => 2_000,
        createId: () => ACTION_ID,
      }
    );
    expect(track).not.toHaveBeenCalledWith(MEANINGFUL_ACTIVITY_COMPLETED, expect.anything());
  });

  it('projects only a non-empty successful Benchling migration result', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const dependencies = {
      track,
      isIdentified: () => true,
      activityAuthority: externalActivityAuthority,
      now: () => 2_000,
      createId: () => ACTION_ID,
    };

    observeWorkflowAction(
      {
        workflow: 'benchling_migration',
        action: 'import',
        status: 'completed',
        resultCount: 1,
        usableResult: true,
      },
      dependencies
    );
    expect(track).toHaveBeenLastCalledWith(MEANINGFUL_ACTIVITY_COMPLETED, {
      feature_area: 'scientific_workflow',
      workflow: 'benchling_migration',
      workflow_action: 'import',
      workflow_status: 'completed',
      identity_kind: 'identified',
      ...meaningfulAuthorityProperties,
      action_id: ACTION_ID,
      initiated_at_ms: 2_000,
      qualified_at_ms: 2_000,
      usable_result: true,
    });

    track.mockClear();
    observeWorkflowAction(
      {
        workflow: 'benchling_migration',
        action: 'import',
        status: 'completed',
        resultCount: 0,
        usableResult: false,
      },
      dependencies
    );
    expect(track).not.toHaveBeenCalledWith(MEANINGFUL_ACTIVITY_COMPLETED, expect.anything());
  });

  it('does not project system-initiated bookkeeping as meaningful activity', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const ids = [ACTION_ID, EFFECT_ID];
    const operation = beginWorkflowAction(
      { workflow: 'registry', action: 'link', initiator: 'system' },
      {
        track,
        isIdentified: () => true,
        activityAuthority: externalActivityAuthority,
        now: () => 2_000,
        createId: () => ids.shift() as string,
      }
    );

    expect(operation.complete({ status: 'attached', affectedCount: 1 })).toBe(true);
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).not.toHaveBeenCalledWith(MEANINGFUL_ACTIVITY_COMPLETED, expect.anything());
  });

  it.each([
    {
      name: 'anonymous qualifying success',
      input: {
        workflow: 'annotation' as const,
        action: 'create' as const,
        status: 'created' as const,
      },
      identified: false,
    },
    {
      name: 'identified AI completion without visible value',
      input: {
        workflow: 'local_codex' as const,
        action: 'complete' as const,
        status: 'completed' as const,
      },
      identified: true,
    },
    {
      name: 'identified qualifying failure',
      input: {
        workflow: 'annotation' as const,
        action: 'create' as const,
        status: 'failed' as const,
        success: false,
      },
      identified: true,
    },
    {
      name: 'identified empty selection',
      input: {
        workflow: 'selection' as const,
        action: 'select' as const,
        status: 'selected' as const,
        selectedCount: 0,
      },
      identified: true,
    },
  ])('does not project $name', ({ input, identified }) => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);

    expect(
      observeWorkflowAction(input, {
        track,
        isIdentified: () => identified,
        activityAuthority: externalActivityAuthority,
        storePending: vi.fn(async () => undefined),
        now: () => 2_000,
        createId: () => ACTION_ID,
      })
    ).toBe(true);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalledWith(MEANINGFUL_ACTIVITY_COMPLETED, expect.anything());
  });

  it('stores one content-free receipt when a qualifying action finishes before identity', async () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const storePending = vi.fn(async () => undefined);

    observeWorkflowAction(
      {
        workflow: 'local_codex',
        action: 'complete',
        status: 'stopped',
        valueDelivered: true,
      },
      {
        track,
        isIdentified: () => false,
        activityAuthority: () => ({
          actorKind: 'unknown',
          executionMode: 'interactive',
          impersonated: false,
        }),
        storePending,
        now: () => 2_000,
        createId: () => ACTION_ID,
      }
    );

    await vi.waitFor(() =>
      expect(storePending).toHaveBeenCalledWith({
        actionId: ACTION_ID,
        workflow: 'local_codex',
        action: 'complete',
        status: 'stopped',
        initiatedAtMs: 2_000,
        qualifiedAtMs: 2_000,
        valueDelivered: true,
        usableResult: undefined,
        selectedCount: undefined,
        appSessionId: APP_SESSION_ID,
      })
    );
  });

  it.each([
    {
      actorKind: 'test' as const,
      executionMode: 'automated' as const,
      impersonated: false,
    },
    {
      actorKind: 'test' as const,
      executionMode: 'synthetic' as const,
      impersonated: false,
    },
    {
      actorKind: 'external' as const,
      executionMode: 'interactive' as const,
      impersonated: true,
    },
  ])(
    'does not retain an anonymous pending receipt for excluded authority %#',
    async (authority) => {
      seedCorrelation();
      const storePending = vi.fn(async () => undefined);

      observeWorkflowAction(
        {
          workflow: 'content',
          action: 'view',
          status: 'viewed',
        },
        {
          track: vi.fn((_event: string, _properties: Record<string, unknown>) => true),
          isIdentified: () => false,
          activityAuthority: () => authority,
          storePending,
          now: () => 2_000,
          createId: () => ACTION_ID,
        }
      );

      await Promise.resolve();
      expect(storePending).not.toHaveBeenCalled();
    }
  );
});

function seedCorrelation(): void {
  sessionStorage.setItem('dnaforge_telemetry_app_session_id', APP_SESSION_ID);
  sessionStorage.setItem('dnaforge_telemetry_episode_correlation_id', EPISODE_ID);
}

describe('workflow journey completeness', () => {
  afterEach(() => {
    abandonOpenWorkflowActions();
  });

  it('closes every still-open action as abandoned exactly once', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const finished = beginWorkflowAction(
      { workflow: 'primer', action: 'create' },
      { track, now: () => 1_000, createId: () => crypto.randomUUID() }
    );
    const open = beginWorkflowAction(
      { workflow: 'alignment', action: 'compute' },
      { track, now: () => 1_000, createId: () => crypto.randomUUID() }
    );
    finished.complete({ status: 'created' });

    expect(abandonOpenWorkflowActions()).toBe(1);
    expect(abandonOpenWorkflowActions()).toBe(0);
    expect(open.consumed).toBe(true);
    const abandoned = track.mock.calls.filter(
      ([, properties]) => properties.workflow_status === 'abandoned'
    );
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.[1]).toMatchObject({
      workflow: 'alignment',
      action_phase: 'cancel',
      success: false,
    });
    expect(
      sanitizeClosedBetaProperties({ workflow_status: 'abandoned', workflow: 'sequence_edit' })
    ).toEqual({ workflow_status: 'abandoned', workflow: 'sequence_edit' });
  });

  it('prefers a bounded error code over the generic error name', () => {
    const coded = Object.assign(new Error('Could not write /Users/ada/secret.gb'), {
      code: 'primer_path-collision',
    });
    expect(errorClassFor(coded)).toBe('primer_path_collision');
    expect(errorClassFor(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('enoent');
    expect(errorClassFor(Object.assign(new Error('x'), { code: 'has spaces /Users/ada' }))).toBe(
      'error'
    );
    expect(errorClassFor(new TypeError('x'))).toBe('typeerror');
  });

  it('buckets counts without sending raw values', () => {
    expect([0, 1, 3, 20, 100, 101, -1, Number.NaN].map(workflowCountBucket)).toEqual([
      '0',
      '1',
      '2_5',
      '6_20',
      '21_100',
      '100_plus',
      'unknown',
      'unknown',
    ]);
  });

  it('keeps the new journey properties through the real sanitizer', () => {
    seedCorrelation();
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const operation = beginWorkflowAction(
      {
        workflow: 'assembly',
        action: 'compute',
        assemblyMethod: 'goldengate',
        exportFormat: 'genbank',
        fileTypeCategory: 'dna',
        agentToolName: 'create_annotation',
      },
      { track, now: () => 1_000, createId: () => crypto.randomUUID() }
    );
    operation.complete({
      status: 'completed',
      resultRank: 2,
      basesInsertedBucket: '2_5',
      basesDeletedBucket: '0',
      basesSubstitutedBucket: '1',
      saveAttemptCount: 1,
    });
    const terminal = sanitizeClosedBetaProperties(track.mock.calls[1]?.[1] ?? {});
    expect(terminal).toMatchObject({
      assembly_method: 'goldengate',
      export_format: 'genbank',
      file_type_category: 'dna',
      agent_tool_name: 'create_annotation',
      result_rank: 2,
      bases_inserted_bucket: '2_5',
      bases_deleted_bucket: '0',
      bases_substituted_bucket: '1',
      save_attempt_count: 1,
    });
    expect(
      sanitizeClosedBetaProperties({
        assembly_method: 'secret',
        export_format: 'exe',
        agent_tool_name: 'Has Spaces',
        bases_inserted_bucket: '42',
      })
    ).toEqual({});
  });
});
