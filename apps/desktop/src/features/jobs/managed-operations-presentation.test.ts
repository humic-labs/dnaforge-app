// @vitest-environment node

import type { OperationActionPage, OperationSnapshot } from '@waypoint/api-client';
import { describe, expect, it } from 'vitest';
import type { ManagedOperationsSnapshot } from '../../services/managed-operations';
import type {
  ManagedOperationPresenterRegistry,
  ManagedOperationReviewProjection,
} from '../../shared/managed-operation-presenters';
import {
  projectManagedOperationActionPage,
  projectManagedOperationsSnapshot,
} from './managed-operations-presentation';

const NOW = Date.UTC(2026, 8, 9, 20, 0, 0);

function operation(id: string, overrides: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id,
    kind: 'annotation',
    kind_contract_version: 1,
    subject: {
      scope_id: 'scope-a',
      subject_id: `document-${id}`,
      input_revision: `revision-${id}`,
    },
    state: 'running',
    actor_kind: 'human',
    actor_id: 'peter@example.test',
    channel: 'desktop_ui',
    owner_instance_id: 'owner-instance-a',
    version: 1,
    created_at: (NOW - 90_000) / 1_000,
    started_at: (NOW - 60_000) / 1_000,
    updated_at: (NOW - 1_000) / 1_000,
    cancellation_mode: 'cooperative',
    cancellation_availability: 'available',
    result_status: 'none',
    ...overrides,
  };
}

function managed(operations: readonly OperationSnapshot[]): ManagedOperationsSnapshot {
  return {
    status: 'connected',
    scopeId: 'scope-a',
    ownerId: 'local-human',
    ownerInstanceId: 'owner-instance-a',
    historySummary: null,
    supportedActionsByKind: { annotation: ['release_result'] },
    kindCatalogByKind: {
      annotation: {
        kind: 'annotation',
        registration: 'executable',
        title: 'Annotate sequence',
        contract_version: 1,
        result_schema_version: 1,
        executable: true,
        input_schema: {},
        result_schema: {},
        recorded_import_capabilities: ['operations.import'],
        start_capabilities: ['operations.start'],
        actions: ['start', 'release_result'],
        surfaces: {},
      },
    },
    reconnectAvailable: false,
    records: operations.map((snapshot) => ({
      snapshot,
      observation: { freshness: 'current', observedAtMs: NOW - 1_000 },
    })),
  };
}

interface TestPresenterOptions {
  readonly reviewByOperationId?: Readonly<Record<string, ManagedOperationReviewProjection>>;
  readonly canOpenResult?: (operation: OperationSnapshot) => boolean;
  readonly targetLabel?: (operation: OperationSnapshot) => string | undefined;
}

function presentationOptions(options: TestPresenterOptions = {}) {
  const presentersByKind = {
    annotation: {
      title: () => 'Annotate sequence',
      targetLabel: (operation) => options.targetLabel?.(operation),
      review: (operation) =>
        options.reviewByOperationId?.[operation.id] ??
        (operation.state === 'succeeded' && operation.result_status !== 'none'
          ? {
              state: 'not-checked' as const,
              reason: 'Review status is not recorded for this result.',
            }
          : { state: 'not-required' as const }),
      canOpenResult: options.canOpenResult ?? (() => true),
      openResult: async () => undefined,
    },
  } satisfies ManagedOperationPresenterRegistry;
  return {
    nowMs: NOW,
    presentersByKind,
  };
}

describe('projectManagedOperationsSnapshot', () => {
  it('projects collection observation even when there are no operation rows', () => {
    const current = projectManagedOperationsSnapshot(managed([]), presentationOptions());
    expect(current.collectionObservation).toEqual({ state: 'current' });

    const unavailable = projectManagedOperationsSnapshot(
      {
        ...managed([]),
        status: 'stale',
        reason: 'Execution owner is offline',
      },
      presentationOptions()
    );
    expect(unavailable.collectionObservation).toEqual({
      state: 'unavailable',
      reason: 'Execution owner is offline',
    });
  });

  it('keeps execution, observation, result availability and review as separate facts', () => {
    const running = operation('running');
    const stale = operation('stale');
    const succeeded = operation('succeeded', {
      state: 'succeeded',
      settled_at: (NOW - 500) / 1_000,
      cancellation_availability: 'already_settled',
      result_status: 'available',
    });
    const snapshot = managed([running, stale, succeeded]);
    snapshot.records[1] = {
      snapshot: stale,
      observation: {
        freshness: 'stale',
        observedAtMs: NOW - 20_000,
        reason: 'Connection to the execution owner was interrupted',
      },
    };

    const projected = projectManagedOperationsSnapshot(
      snapshot,
      presentationOptions({
        reviewByOperationId: {
          succeeded: { state: 'in-review' },
        },
        canOpenResult: (candidate) => candidate.id === 'succeeded',
      })
    );

    expect(projected.jobs).toEqual([
      expect.objectContaining({
        id: 'operation:running',
        owner: { kind: 'managed-operation', nativeId: 'running' },
        state: 'running',
        observation: { freshness: 'current', observedAtMs: NOW - 1_000 },
        result: { availability: 'none' },
        review: { state: 'not-required' },
        canStop: true,
      }),
      expect.objectContaining({
        id: 'operation:stale',
        owner: { kind: 'managed-operation', nativeId: 'stale' },
        state: 'running',
        observation: expect.objectContaining({ freshness: 'stale' }),
        result: { availability: 'none' },
        review: { state: 'not-required' },
        canStop: false,
      }),
      expect.objectContaining({
        id: 'operation:succeeded',
        owner: { kind: 'managed-operation', nativeId: 'succeeded' },
        state: 'succeeded',
        observation: { freshness: 'current', observedAtMs: NOW - 1_000 },
        result: { availability: 'available' },
        review: { state: 'in-review' },
        canStop: false,
        canOpenResult: true,
      }),
    ]);
  });

  it('does not invent review status for historical available work', () => {
    const projected = projectManagedOperationsSnapshot(
      managed([
        operation('review', {
          state: 'succeeded',
          settled_at: (NOW - 500) / 1_000,
          cancellation_availability: 'already_settled',
          result_status: 'available',
        }),
      ]),
      presentationOptions({ canOpenResult: () => true })
    );

    expect(projected.jobs[0]).toMatchObject({
      state: 'succeeded',
      review: {
        state: 'not-checked',
        reason: 'Review status is not recorded for this result.',
      },
      canStop: false,
      canOpenResult: true,
      canReleaseResult: true,
    });
  });

  it('uses catalog facts and conservative behavior for an unrecognized operation kind', () => {
    const unknown = operation('report', {
      kind: 'report',
      origin: 'recorded',
      state: 'succeeded',
      settled_at: (NOW - 500) / 1_000,
      cancellation_availability: 'already_settled',
      result_status: 'available',
      provenance: {
        source: 'self_reported_receipt',
        schema_version: 1,
        reported_run_id: 'report-run',
        reported_started_at: '2026-09-09T17:00:00Z',
        reported_finished_at: '2026-09-09T17:01:00Z',
        tool_name: 'report-tool',
        tool_version: '2.0',
        parameters: {},
        inputs: [{ role: 'primary', identity: 'batch-42', size: 12, size_unit: 'files' }],
        outputs: [{ role: 'primary', format: 'json' }],
        runtime: { executables: {} },
        resources: {},
      },
    });
    const base = managed([unknown]);
    const snapshot: ManagedOperationsSnapshot = {
      ...base,
      kindCatalogByKind: {
        report: {
          kind: 'report',
          registration: 'executable',
          title: 'Build report',
          contract_version: 2,
          result_schema_version: 1,
          executable: false,
          input_schema: null,
          result_schema: {},
          start_capabilities: [],
          recorded_import_capabilities: [],
          actions: ['list', 'get', 'result', 'actions', 'release_result'],
          surfaces: {},
        } as unknown as ManagedOperationsSnapshot['kindCatalogByKind'][string],
      },
    };

    expect(projectManagedOperationsSnapshot(snapshot, presentationOptions()).jobs[0]).toMatchObject(
      {
        title: 'Build report',
        target: 'batch-42',
        review: { state: 'not-required' },
        canOpenResult: false,
        canReleaseResult: true,
        recordedProvenance: {
          input: 'batch-42 · 12 files',
          output: 'json',
        },
      }
    );
  });

  it('preserves a stale terminal success and expired unreviewed result without inventing failure', () => {
    const succeeded = operation('expired', {
      state: 'succeeded',
      settled_at: (NOW - 60_000) / 1_000,
      cancellation_availability: 'already_settled',
      result_status: 'expired',
    });
    const snapshot = managed([succeeded]);
    snapshot.records[0] = {
      snapshot: succeeded,
      observation: {
        freshness: 'stale',
        observedAtMs: NOW - 30_000,
        reason: 'Execution owner is stopped',
      },
    };

    expect(projectManagedOperationsSnapshot(snapshot, presentationOptions()).jobs[0]).toMatchObject(
      {
        state: 'succeeded',
        observation: { freshness: 'stale' },
        result: { availability: 'expired' },
        review: { state: 'not-checked', reason: 'Review status is not recorded for this result.' },
        canStop: false,
        canOpenResult: false,
      }
    );
  });

  it('retains last-known result availability while withholding Open when observation is stale', () => {
    const succeeded = operation('stale-available', {
      state: 'succeeded',
      settled_at: (NOW - 60_000) / 1_000,
      cancellation_availability: 'already_settled',
      result_status: 'available',
    });
    const base = managed([succeeded]);
    const snapshot: ManagedOperationsSnapshot = {
      ...base,
      status: 'stale',
      records: [
        {
          snapshot: succeeded,
          observation: {
            freshness: 'stale',
            observedAtMs: NOW - 30_000,
            reason: 'Execution owner is unavailable',
          },
        },
      ],
    };

    expect(
      projectManagedOperationsSnapshot(
        snapshot,
        presentationOptions({
          canOpenResult: () => true,
        })
      ).jobs[0]
    ).toMatchObject({
      state: 'succeeded',
      result: { availability: 'available' },
      review: { state: 'not-checked' },
      canOpenResult: false,
    });
  });

  it('keeps released result availability separate from successful execution and review', () => {
    const projected = projectManagedOperationsSnapshot(
      managed([
        operation('released', {
          state: 'succeeded',
          settled_at: (NOW - 500) / 1_000,
          cancellation_availability: 'already_settled',
          result_status: 'released',
        }),
      ]),
      presentationOptions({ canOpenResult: () => true })
    );

    expect(projected.jobs[0]).toMatchObject({
      state: 'succeeded',
      result: {
        availability: 'released',
        reason: 'The retained result was released. Execution history remains.',
      },
      review: { state: 'not-checked' },
      canOpenResult: false,
      canReleaseResult: false,
    });
  });

  it('forwards exact collection history coverage into the sidebar projection', () => {
    const snapshot = managed([operation('active')]);
    snapshot.historySummary = {
      operationCount: 8,
      activeCount: 1,
      terminalCount: 7,
      historyComplete: false,
    };

    expect(
      projectManagedOperationsSnapshot(snapshot, presentationOptions()).historySummary
    ).toEqual(snapshot.historySummary);
  });

  it('uses an application-supplied target label while retaining exact subject identity', () => {
    const snapshot = managed([operation('uncancellable')]);
    snapshot.records[0] = {
      ...snapshot.records[0]!,
      snapshot: operation('uncancellable', { cancellation_availability: 'unavailable' }),
      cancelResponse: {
        disposition: 'unavailable',
        reason: 'The execution owner does not support cancellation for this operation.',
        snapshot: operation('uncancellable', { cancellation_availability: 'unavailable' }),
      },
    };

    expect(
      projectManagedOperationsSnapshot(
        snapshot,
        presentationOptions({
          targetLabel: (candidate) =>
            candidate.subject.subject_id === 'document-uncancellable' ? 'pUC19.gb' : undefined,
        })
      ).jobs[0]
    ).toMatchObject({
      target: 'pUC19.gb',
      targetIdentity: 'document-uncancellable',
      actorLabel: 'peter@example.test',
      actorActionLabel: 'Started by',
      actorChannelLabel: 'DNAForge',
      inputRevision: 'revision-uncancellable',
      toolVersion: 'Not reported by execution owner',
      dataVersion: 'Not reported by execution owner',
      canStop: false,
      stopUnavailableReason:
        'The execution owner does not support cancellation for this operation.',
      executionContext: {
        mode: 'managed',
        ownerLabel: 'This computer',
        ownerInstanceId: 'owner-instance-a',
        locationLabel: 'This computer',
        lifetimeLabel: 'Runs while DNAForge is open',
      },
    });
  });

  it('describes hosted browser jobs as durable hosted execution', () => {
    const projected = projectManagedOperationsSnapshot(
      managed([operation('hosted', { channel: 'hosted_browser' })]),
      presentationOptions()
    );

    expect(projected.jobs[0]).toMatchObject({
      actorChannelLabel: 'Web app',
      executionContext: {
        mode: 'managed',
        locationLabel: 'DNAForge hosted service',
        lifetimeLabel: 'Persists independently of this browser tab',
      },
    });
  });

  it('separates the actual importer from self-reported recorded-run facts', () => {
    const projected = projectManagedOperationsSnapshot(
      managed([
        operation('recorded', {
          origin: 'recorded',
          state: 'succeeded',
          actor_kind: 'human',
          actor_id: 'receipt-importer@example.test',
          channel: 'managed_cli',
          started_at: null,
          settled_at: (NOW - 500) / 1_000,
          cancellation_mode: 'queued_only',
          cancellation_availability: 'already_settled',
          result_status: 'available',
          provenance: {
            schema_version: 1,
            source: 'self_reported_receipt',
            reported_run_id: 'offline-run-42',
            tool_name: 'dnaforge-annotation',
            tool_version: '0.1.0',
            reported_started_at: '2026-09-09T17:00:00Z',
            reported_finished_at: '2026-09-09T17:02:30Z',
            parameters: { mode: 'default' },
            inputs: [
              {
                role: 'primary',
                identity: 'pUC19',
                revision: 'revision-recorded',
                size: 2686,
                size_unit: 'bases',
                sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                path: '/reported/input/pUC19.fasta',
              },
            ],
            outputs: [
              {
                role: 'primary',
                path: '/reported/output/pUC19.json',
                format: 'json',
              },
            ],
            runtime: {
              threads: 4,
              data_path: '/reported/reference-data',
              executables: { blastn: '/reported/bin/blastn' },
            },
            resource_manifest: '/reported/reference-data/databases.yml',
            resources: { custom: null, snapgene: '2026.09' },
          },
        }),
      ]),
      presentationOptions()
    );

    expect(projected.jobs[0]).toMatchObject({
      actorLabel: 'receipt-importer@example.test',
      target: 'pUC19',
      targetIdentity: 'document-recorded',
      actorActionLabel: 'Imported by',
      actorChannelLabel: 'Managed CLI',
      durationLabel: 'Recorded result',
      canStop: false,
      canOpenResult: true,
      executionContext: { mode: 'recorded' },
      recordedProvenance: {
        sourceLabel: 'Self-reported receipt',
        runId: 'offline-run-42',
        tool: 'dnaforge-annotation 0.1.0',
        startedAt: '2026-09-09T17:00:00Z',
        finishedAt: '2026-09-09T17:02:30Z',
        input:
          'pUC19 · 2,686 bases · sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        inputPath: '/reported/input/pUC19.fasta',
        output: 'json · /reported/output/pUC19.json',
        referenceVersions:
          'custom: version not reported · snapgene: 2026.09 · manifest: /reported/reference-data/databases.yml',
        runtime: '4 threads',
      },
    });
    expect(projected.jobs[0]?.executionContext).not.toHaveProperty('ownerLabel');
    expect(projected.jobs[0]?.executionContext).not.toHaveProperty('ownerInstanceId');
    expect(projected.jobs[0]?.executionContext).not.toHaveProperty('locationLabel');
    expect(projected.jobs[0]?.executionContext).not.toHaveProperty('lifetimeLabel');
  });

  it('maps bounded action pages without hiding the actual actor, channel, or truncation', () => {
    const page: OperationActionPage & { omitted_count: number; history_complete: boolean } = {
      actions: [
        {
          id: 'action-1',
          action: 'import_recorded',
          actor_kind: 'human',
          actor_id: 'importer@example.test',
          channel: 'managed_cli',
          outcome: 'imported',
          recorded_at: (NOW - 2_000) / 1_000,
        },
        {
          id: 'action-2',
          action: 'release_result',
          actor_kind: 'agent',
          actor_id: 'analysis-agent',
          channel: 'agent',
          outcome: 'released',
          recorded_at: (NOW - 1_000) / 1_000,
        },
      ],
      total: 4,
      next_offset: 2,
      omitted_count: 7,
      history_complete: false,
    };

    expect(projectManagedOperationActionPage(page)).toEqual({
      actions: [
        {
          id: 'action-1',
          label: 'Import recorded',
          outcomeLabel: 'Imported',
          actorLabel: 'importer@example.test',
          actorKindLabel: 'Human',
          channelLabel: 'Managed CLI',
          atMs: NOW - 2_000,
        },
        {
          id: 'action-2',
          label: 'Release result',
          outcomeLabel: 'Released',
          actorLabel: 'analysis-agent',
          actorKindLabel: 'Agent',
          channelLabel: 'Agent',
          atMs: NOW - 1_000,
        },
      ],
      total: 4,
      truncated: true,
      omittedCount: 7,
      historyComplete: false,
    });
  });
});

it('keeps account and execution UUIDs out of public job identity labels', () => {
  const internalId = '4e21cfea-7ee0-4ff1-871a-a4b42c171bd7';
  const snapshot = managed([
    operation('identity', {
      actor_id: internalId,
      owner_instance_id: internalId,
      channel: 'hosted_browser',
    }),
  ]);
  const job = projectManagedOperationsSnapshot(
    { ...snapshot, ownerId: internalId },
    presentationOptions()
  ).jobs[0]!;
  expect(job.actorLabel).toBe('User');
  expect(job.executionContext.ownerLabel).toBe('DNAForge web app');
  expect(job.executionContext.ownerInstanceId).toBe(internalId);
  const history = projectManagedOperationActionPage({
    actions: [
      {
        id: 'action',
        action: 'release_result',
        actor_kind: 'human',
        actor_id: internalId,
        channel: 'hosted_browser',
        outcome: 'released',
        recorded_at: NOW / 1000,
      },
    ],
    total: 1,
    next_offset: null,
  });
  expect(history.actions[0]?.actorLabel).toBe('User');
});
