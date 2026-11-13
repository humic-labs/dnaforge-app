// @vitest-environment node

import type {
  AnnotationDocumentApplyResponse,
  AnnotationDocumentInspection,
  AnnotationDocumentSelection,
  OperationInitial,
  AnnotationRequest,
  AnnotationSubmission,
  OperationCancelResponse,
  OperationCatalog,
  AnnotationOperationResultEnvelope,
  OperationEvent,
  OperationSnapshot,
} from '@waypoint/api-client';
import { describe, expect, it, vi } from 'vitest';
import {
  ManagedOperationSubmissionUncertainError,
  ManagedOperationsStore,
  type ManagedOperationsApi,
  type ManagedOperationsEventSource,
  type ManagedOperationsRuntimeSource,
} from './managed-operations';

function operation(
  id: string,
  version: number,
  overrides: Partial<OperationSnapshot> = {}
): OperationSnapshot {
  return {
    id,
    kind: 'annotation',
    kind_contract_version: 1,
    subject: {
      scope_id: 'scope-a',
      subject_id: `subject-${id}`,
      input_revision: `revision-${id}`,
    },
    state: 'running',
    actor_kind: 'human',
    actor_id: 'local-human',
    channel: 'desktop_ui',
    owner_instance_id: 'owner-instance-a',
    version,
    created_at: 100,
    updated_at: 101,
    cancellation_mode: 'cooperative',
    cancellation_availability: 'available',
    result_status: 'none',
    ...overrides,
  };
}

type StreamCounts = Pick<
  OperationInitial,
  'operation_count' | 'active_count' | 'terminal_count' | 'history_complete'
>;

function streamCounts(
  operations: readonly OperationSnapshot[],
  historyComplete = true
): StreamCounts {
  const activeCount = operations.filter((candidate) =>
    ['queued', 'running', 'stopping'].includes(candidate.state)
  ).length;
  return {
    operation_count: operations.length,
    active_count: activeCount,
    terminal_count: operations.length - activeCount,
    history_complete: historyComplete,
  };
}

function initialEvent(operations: readonly OperationSnapshot[]): OperationInitial {
  return { operations: [...operations], ...streamCounts(operations) };
}

function snapshotEvent(
  snapshot: OperationSnapshot,
  counts = streamCounts([snapshot])
): OperationEvent & StreamCounts {
  return { kind: 'snapshot', snapshot, ...counts };
}

class FakeEventSource implements ManagedOperationsEventSource {
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  close = vi.fn();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown = ''): void {
    const event = {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeRuntimeSource implements ManagedOperationsRuntimeSource {
  status = 'ready';
  baseUrl = 'http://127.0.0.1:8010';
  readonly getStatus = vi.fn(async () => this.status);
  readonly getBaseUrl = vi.fn(async () => this.baseUrl);
  readonly unsubscribe = vi.fn();
  private listener: ((status: string) => void) | null = null;
  readonly subscribeStatus = vi.fn((listener: (status: string) => void) => {
    this.listener = listener;
    return this.unsubscribe;
  });

  emit(status: string): void {
    this.status = status;
    this.listener?.(status);
  }
}

function setup() {
  let configuredBaseUrl = '';
  let now = 1_000;
  const catalog: OperationCatalog = {
    scope_id: 'scope-a',
    owner_id: 'local-human',
    owner_instance_id: 'owner-instance-a',
    kinds: [
      {
        kind: 'annotation',
        registration: 'executable',
        title: 'Annotation',
        contract_version: 1,
        result_schema_version: 1,
        executable: true,
        actions: ['start', 'list', 'get', 'result', 'request_cancel', 'release_result'],
        start_capabilities: ['operations.start'],
        recorded_import_capabilities: ['operations.import'],
        surfaces: {},
        input_schema: {},
        result_schema: {},
      },
    ],
  };
  const api: ManagedOperationsApi = {
    configureBaseUrl: vi.fn((baseUrl: string) => {
      configuredBaseUrl = baseUrl;
    }),
    getBaseUrl: vi.fn(() => configuredBaseUrl),
    bindGeneratedClient: vi.fn(),
    discover: vi.fn(async () => catalog),
    startAnnotation: vi.fn(async () => operation('started', 1, { state: 'queued' })),
    getOperation: vi.fn(async (id: string) => operation(id, 2)),
    getActions: vi.fn(async () => ({
      actions: [
        {
          id: 'action-1',
          action: 'submit',
          actor_kind: 'human',
          actor_id: 'local-human',
          channel: 'desktop_ui',
          outcome: 'accepted',
          recorded_at: 100,
        },
      ],
      total: 1,
      next_offset: null,
    })),
    getResult: vi.fn(async (id: string) => ({
      operation_id: id,
      status: 'available',
      result: { features: [], report: '', version: 'test' },
    })),
    inspectAnnotationDocument: vi.fn(async () => documentInspection()),
    applyAnnotationDocument: vi.fn(async () => documentReceipt()),
    releaseResult: vi.fn(async (id: string) => ({
      disposition: 'released',
      reason: 'Retained result released; execution history remains.',
      snapshot: operation(id, 4, {
        state: 'succeeded',
        cancellation_availability: 'already_settled',
        result_status: 'released',
      }),
    })),
    requestCancel: vi.fn(async (id: string) => ({
      disposition: 'accepted',
      reason: 'Cancellation was requested; waiting for physical settlement.',
      snapshot: operation(id, 3, {
        state: 'stopping',
        cancellation_availability: 'already_requested',
      }),
    })),
  };
  const eventSources: FakeEventSource[] = [];
  const createEventSource = vi.fn((url: string) => {
    const source = new FakeEventSource();
    eventSources.push(source);
    return source;
  });
  const store = new ManagedOperationsStore({
    api,
    createEventSource,
    now: () => now,
    createSubmissionKey: () => 'generated-key',
  });
  const runtime = new FakeRuntimeSource();

  return {
    api,
    catalog,
    createEventSource,
    eventSources,
    runtime,
    store,
    setNow(value: number) {
      now = value;
    },
  };
}

async function waitForEventSources(eventSources: readonly FakeEventSource[], count: number) {
  await vi.waitFor(() => expect(eventSources).toHaveLength(count));
}

it('keeps the hosted workspace proxy prefix when opening the operation event stream', async () => {
  const { createEventSource, eventSources, runtime, store } = setup();
  runtime.baseUrl =
    'https://dnaforge.test/api/hosted-operations/22222222-2222-4222-8222-222222222222';

  store.attach(runtime);
  await waitForEventSources(eventSources, 1);

  expect(createEventSource).toHaveBeenCalledWith(
    'https://dnaforge.test/api/hosted-operations/22222222-2222-4222-8222-222222222222/operations/events?scope_id=scope-a'
  );
});

function documentInspection(): AnnotationDocumentInspection {
  return {
    operationId: 'document-job',
    targetDocumentId: 'subject-document-job',
    operationVersion: 2,
    resultSha256: `sha256:${'a'.repeat(64)}`,
    targetDocumentRevision: `annotation-document-v1:sha256:${'b'.repeat(64)}`,
    analyzedInputRevision: 'revision-document-job',
    candidates: [],
    applicable: true,
  };
}

function documentSelection(): AnnotationDocumentSelection {
  const review = documentInspection();
  return {
    operationId: review.operationId,
    targetDocumentId: review.targetDocumentId,
    expectedOperationVersion: review.operationVersion,
    expectedResultSha256: review.resultSha256,
    expectedTargetDocumentRevision: review.targetDocumentRevision,
    selectedCandidateIds: ['document-job:0'],
  };
}

function documentReceipt(): AnnotationDocumentApplyResponse {
  return {
    actionId: 'document-action',
    outcome: {
      status: 'saved',
      targetDocumentRevision: 'saved-revision',
      checkpoint: { status: 'not-required' },
      display: 'refreshed',
    },
  };
}

describe('native document commands from the UI client', () => {
  async function connected() {
    const fixture = setup();
    fixture.store.attach(fixture.runtime);
    await waitForEventSources(fixture.eventSources, 1);
    fixture.eventSources[0].emit(
      'initial',
      initialEvent([
        operation('document-job', 2, { state: 'succeeded', result_status: 'available' }),
      ])
    );
    return fixture;
  }

  it('sends the frozen reviewed selection once without silently inspecting again', async () => {
    const { api, store } = await connected();
    let finish!: (response: AnnotationDocumentApplyResponse) => void;
    vi.mocked(api.applyAnnotationDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const selection = documentSelection();
    const expected = structuredClone(selection);
    const pending = store.applyAnnotationDocument(selection);
    selection.selectedCandidateIds.push('document-job:1');
    selection.expectedOperationVersion = 99;
    finish(documentReceipt());
    await expect(pending).resolves.toEqual(documentReceipt());
    expect(api.applyAnnotationDocument).toHaveBeenCalledExactlyOnceWith(expected);
    expect(api.inspectAnnotationDocument).not.toHaveBeenCalled();
  });

  it('rejects an inspection that completes after the execution connection changes', async () => {
    const { api, runtime, store } = await connected();
    let finish!: (response: AnnotationDocumentInspection) => void;
    vi.mocked(api.inspectAnnotationDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = store.inspectAnnotationDocument({
      operationId: 'document-job',
      targetDocumentId: 'subject-document-job',
    });
    runtime.emit('restarting');
    finish(documentInspection());
    await expect(pending).rejects.toThrow('runtime changed');
    expect(api.inspectAnnotationDocument).toHaveBeenCalledOnce();
  });

  it('preserves the original save receipt when it arrives after a connection change', async () => {
    const { api, runtime, store } = await connected();
    let finish!: (response: AnnotationDocumentApplyResponse) => void;
    vi.mocked(api.applyAnnotationDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const selection = documentSelection();
    const pending = store.applyAnnotationDocument(selection);
    selection.operationId = 'changed-by-the-caller';
    runtime.emit('restarting');
    finish(documentReceipt());
    await expect(pending).rejects.toMatchObject({
      name: 'ManagedDocumentReceiptFromPreviousRuntimeError',
      operationId: 'document-job',
      receipt: documentReceipt(),
    });
    expect(api.applyAnnotationDocument).toHaveBeenCalledOnce();
  });

  it('preserves a native admission refusal and makes no automatic retry', async () => {
    const { api, store } = await connected();
    const refusal = {
      status: 503,
      body: { detail: { code: 'NATIVE_DOCUMENT_CONNECTION_UNAVAILABLE' } },
    };
    vi.mocked(api.applyAnnotationDocument).mockRejectedValueOnce(refusal);
    await expect(store.applyAnnotationDocument(documentSelection())).rejects.toBe(refusal);
    expect(api.applyAnnotationDocument).toHaveBeenCalledOnce();
  });

  it('does not send a document command while detached', async () => {
    const { api, store } = setup();
    await expect(store.applyAnnotationDocument(documentSelection())).rejects.toThrow(
      'not connected'
    );
    expect(api.applyAnnotationDocument).not.toHaveBeenCalled();
  });
});

describe('ManagedOperationsStore', () => {
  it('keeps a newer ready push when the initial status read later fails', async () => {
    const { eventSources, runtime, store } = setup();
    let rejectStatus!: (error: Error) => void;
    const statusRead = new Promise<string>((_resolve, reject) => {
      rejectStatus = reject;
    });
    runtime.getStatus.mockReturnValueOnce(statusRead);
    const release = store.attach(runtime);
    try {
      runtime.emit('ready');
      await waitForEventSources(eventSources, 1);
      eventSources[0].emit('initial', initialEvent([operation('current', 1)]));
      rejectStatus(new Error('obsolete startup read failed'));
      await statusRead.catch(() => undefined);
      expect(store.getSnapshot().status).toBe('connected');
      expect(store.getSnapshot().records[0].observation.freshness).toBe('current');
      expect(eventSources[0].close).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('shares one application observer across duplicate attaches and detaches on the final release', async () => {
    const { eventSources, runtime, store } = setup();

    const releaseFirst = store.attach(runtime);
    const releaseSecond = store.attach(runtime);
    await waitForEventSources(eventSources, 1);

    expect(runtime.subscribeStatus).toHaveBeenCalledOnce();
    releaseFirst();
    expect(eventSources[0]?.close).not.toHaveBeenCalled();

    releaseSecond();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('detached'));
    expect(eventSources[0]?.close).toHaveBeenCalledOnce();
    expect(runtime.unsubscribe).toHaveBeenCalledOnce();
  });

  it('releases synchronously before an immediate attach to a replacement runtime source', async () => {
    const { eventSources, runtime, store } = setup();

    const releaseOriginal = store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    releaseOriginal();

    expect(runtime.subscribeStatus).toHaveBeenCalledOnce();
    expect(runtime.getStatus).toHaveBeenCalledOnce();
    expect(runtime.unsubscribe).toHaveBeenCalledOnce();
    expect(eventSources[0]?.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot().status).toBe('detached');

    const replacement = new FakeRuntimeSource();
    const releaseReplacement = store.attach(replacement);
    await waitForEventSources(eventSources, 2);

    expect(replacement.subscribeStatus).toHaveBeenCalledOnce();
    expect(replacement.getStatus).toHaveBeenCalledOnce();
    releaseReplacement();
    expect(replacement.unsubscribe).toHaveBeenCalledOnce();
  });

  it('atomically installs the initial scope and accepts only higher versions for the same ID', async () => {
    const { eventSources, runtime, setNow, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    const stream = eventSources[0];

    stream?.emit('initial', initialEvent([operation('one', 3), operation('two', 1)]));
    expect(store.getSnapshot()).toMatchObject({
      status: 'connected',
      scopeId: 'scope-a',
      records: [
        { snapshot: { id: 'one', version: 3 }, observation: { freshness: 'current' } },
        { snapshot: { id: 'two', version: 1 }, observation: { freshness: 'current' } },
      ],
    });

    setNow(2_000);
    stream?.emit(
      'snapshot',
      snapshotEvent(operation('one', 2), {
        operation_count: 2,
        active_count: 2,
        terminal_count: 0,
        history_complete: true,
      })
    );
    expect(store.getSnapshot().records[0]?.snapshot.version).toBe(3);

    stream?.emit(
      'snapshot',
      snapshotEvent(operation('one', 4, { state: 'succeeded', result_status: 'available' }), {
        operation_count: 2,
        active_count: 1,
        terminal_count: 1,
        history_complete: true,
      })
    );
    expect(store.getSnapshot().records[0]).toMatchObject({
      snapshot: { id: 'one', version: 4, state: 'succeeded', result_status: 'available' },
      observation: { freshness: 'current', observedAtMs: 2_000 },
    });

    stream?.emit('initial', initialEvent([operation('replacement', 1)]));
    expect(store.getSnapshot().records.map((record) => record.snapshot.id)).toEqual([
      'replacement',
    ]);
  });

  it('atomically retains exact collection counts and replaces them from snapshot events', async () => {
    const { eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    const stream = eventSources[0];
    const active = operation('active', 1);
    const visibleTerminal = operation('terminal', 1, {
      state: 'succeeded',
      cancellation_availability: 'already_settled',
      result_status: 'available',
    });

    stream?.emit('initial', {
      operations: [active, visibleTerminal],
      operation_count: 12,
      active_count: 1,
      terminal_count: 11,
      history_complete: false,
    });
    expect(store.getSnapshot().historySummary).toEqual({
      operationCount: 12,
      activeCount: 1,
      terminalCount: 11,
      historyComplete: false,
    });

    stream?.emit('snapshot', {
      kind: 'snapshot',
      snapshot: operation('active', 2, {
        state: 'succeeded',
        cancellation_availability: 'already_settled',
        result_status: 'available',
      }),
      operation_count: 12,
      active_count: 0,
      terminal_count: 12,
      history_complete: false,
    });
    expect(store.getSnapshot().historySummary).toEqual({
      operationCount: 12,
      activeCount: 0,
      terminalCount: 12,
      historyComplete: false,
    });
  });

  it('lets EventSource recover transient transport loss without restarting or recataloging work', async () => {
    const { api, eventSources, runtime, setNow, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    const stream = eventSources[0];
    stream?.emit('initial', initialEvent([operation('one', 1)]));

    setNow(2_000);
    stream?.emit('error');
    expect(stream?.close).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      records: [
        {
          snapshot: { id: 'one', state: 'running' },
          observation: { freshness: 'stale', observedAtMs: 1_000 },
        },
      ],
    });

    stream?.emit('snapshot', snapshotEvent(operation('one', 2)));
    expect(store.getSnapshot().records[0]?.snapshot.version).toBe(1);

    runtime.emit('ready');
    expect(eventSources).toHaveLength(1);
    expect(api.discover).toHaveBeenCalledOnce();

    stream?.emit('initial', initialEvent([operation('one', 2)]));
    expect(store.getSnapshot()).toMatchObject({
      status: 'connected',
      records: [
        {
          snapshot: { id: 'one', version: 2, state: 'running' },
          observation: { freshness: 'current', observedAtMs: 2_000 },
        },
      ],
    });
  });

  it('does not reconnect an already current observer for duplicate ready notifications', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));

    runtime.emit('ready');
    await Promise.resolve();

    expect(eventSources).toHaveLength(1);
    expect(api.discover).toHaveBeenCalledOnce();
  });

  it('obsoletes the prior runtime stream before accepting a replacement scope', async () => {
    const { api, catalog, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    const oldStream = eventSources[0];
    oldStream?.emit('initial', initialEvent([operation('old', 1)]));

    runtime.emit('restarting');
    expect(oldStream?.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot().records[0]?.observation.freshness).toBe('stale');

    runtime.baseUrl = 'http://127.0.0.1:8020';
    catalog.scope_id = 'scope-b';
    catalog.owner_instance_id = 'owner-instance-b';
    vi.mocked(api.discover).mockResolvedValueOnce(catalog);
    runtime.emit('ready');
    await waitForEventSources(eventSources, 2);

    oldStream?.emit('initial', initialEvent([operation('obsolete', 99)]));
    expect(store.getSnapshot().records[0]?.snapshot.id).toBe('old');

    const replacement = operation('new', 1, {
      subject: {
        scope_id: 'scope-b',
        subject_id: 'subject-new',
        input_revision: 'revision-new',
      },
      owner_instance_id: 'owner-instance-b',
    });
    eventSources[1]?.emit('initial', initialEvent([replacement]));
    expect(store.getSnapshot()).toMatchObject({
      status: 'connected',
      scopeId: 'scope-b',
      ownerInstanceId: 'owner-instance-b',
      records: [{ snapshot: { id: 'new' }, observation: { freshness: 'current' } }],
    });
    expect(eventSources[1]).not.toBe(oldStream);
  });

  it('rebinds authority only after explicit recovery from revocation', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    const oldStream = eventSources[0];
    oldStream?.emit('initial', initialEvent([operation('old', 1)]));

    vi.mocked(api.discover).mockResolvedValueOnce({
      scope_id: 'scope-b',
      owner_id: 'replacement-human',
      owner_instance_id: 'owner-instance-b',
      kinds: [],
    });
    oldStream?.emit('authorization_revoked');

    expect(oldStream?.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot().records[0]?.observation.freshness).toBe('stale');
    expect(store.getSnapshot().reconnectAvailable).toBe(true);
    expect(eventSources).toHaveLength(1);

    await store.reconnect();
    await waitForEventSources(eventSources, 2);

    eventSources[1]?.emit(
      'initial',
      initialEvent([
        operation('new', 1, {
          subject: {
            scope_id: 'scope-b',
            subject_id: 'subject-new',
            input_revision: 'revision-new',
          },
          owner_instance_id: 'owner-instance-b',
        }),
      ])
    );
    expect(store.getSnapshot()).toMatchObject({
      status: 'connected',
      scopeId: 'scope-b',
      ownerId: 'replacement-human',
      records: [{ snapshot: { id: 'new' }, observation: { freshness: 'current' } }],
      reconnectAvailable: false,
    });
  });

  it('stops on a malformed stream contract and exposes explicit recovery', async () => {
    const { eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);

    eventSources[0]?.emit('initial', '{not valid json');

    expect(eventSources[0]?.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({
      status: 'stale',
      reconnectAvailable: true,
      reason: expect.stringContaining('initial state was invalid'),
    });
  });

  it('names an unavailable web jobs service in words', async () => {
    const { api, runtime, store } = setup();
    vi.mocked(api.discover).mockRejectedValueOnce({
      status: 503,
      statusText: 'Service Unavailable',
      body: { error: 'UNAVAILABLE', message: 'Hosted operation service unavailable.' },
    });
    store.attach(runtime);
    await vi.waitFor(() =>
      expect(store.getSnapshot().reason).toBe(
        'Could not connect to the execution owner: Hosted operation service unavailable.'
      )
    );
  });

  it('uses catalog scope and generated commands once without trusting stale cached records', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));
    const request: AnnotationRequest = { sequence: 'ATGC', linear: true };

    await expect(
      store.startAnnotation('document-1', request, 'submission-1')
    ).resolves.toMatchObject({
      id: 'started',
    });
    expect(api.startAnnotation).toHaveBeenCalledWith({
      input: request,
      subject: { scope_id: 'scope-a', subject_id: 'document-1' },
      submission_key: 'submission-1',
    } satisfies AnnotationSubmission);

    await expect(store.getOperation('started')).resolves.toMatchObject({
      id: 'started',
      version: 2,
    });
    await expect(store.getActions('started')).resolves.toMatchObject({
      total: 1,
      actions: [{ id: 'action-1', actor_id: 'local-human' }],
    });
    await expect(store.getResult('started')).resolves.toMatchObject({
      operation_id: 'started',
      status: 'available',
    } satisfies Partial<AnnotationOperationResultEnvelope>);
    await expect(store.requestCancel('started')).resolves.toMatchObject({
      disposition: 'accepted',
    } satisfies Partial<OperationCancelResponse>);
    await expect(store.releaseResult('started')).resolves.toMatchObject({
      disposition: 'released',
    });

    expect(api.startAnnotation).toHaveBeenCalledOnce();
    expect(api.getOperation).toHaveBeenCalledOnce();
    expect(api.getActions).toHaveBeenCalledWith('started', { limit: 20, offset: 0 });
    expect(api.getResult).toHaveBeenCalledOnce();
    expect(api.requestCancel).toHaveBeenCalledOnce();
    expect(api.releaseResult).toHaveBeenCalledOnce();
    expect(api.bindGeneratedClient).toHaveBeenCalledTimes(7);
    expect(store.getSnapshot().records[0]).toMatchObject({
      snapshot: { id: 'started', version: 4, state: 'succeeded', result_status: 'released' },
      cancelResponse: {
        disposition: 'accepted',
        reason: 'Cancellation was requested; waiting for physical settlement.',
      },
    });
  });

  it('starts a registered operation through the current owner and accepts its snapshot', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));
    const starter = vi.fn(async ({ scopeId, submissionKey }) =>
      operation('coverage', 1, {
        kind: 'alignment-coverage-preparation',
        state: 'queued',
        subject: {
          scope_id: scopeId,
          subject_id: 'aligned-read-source-v1:sha256:subject',
          input_revision: 'alignment-coverage-v1:sha256:revision',
        },
      })
    );

    await expect(store.startRegisteredOperation(starter, 'coverage-key')).resolves.toMatchObject({
      id: 'coverage',
      kind: 'alignment-coverage-preparation',
    });
    expect(starter).toHaveBeenCalledExactlyOnceWith({
      scopeId: 'scope-a',
      submissionKey: 'coverage-key',
    });
    expect(api.bindGeneratedClient).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().records).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({ id: 'coverage', state: 'queued' }),
        observation: expect.objectContaining({ freshness: 'current' }),
      }),
    ]);
  });

  it('does not submit prepared hosted inputs after their execution connection changes', async () => {
    const { eventSources, runtime, store } = setup();
    let finishPreparation!: (
      value: import('@waypoint/api-client').OperationAcceptedWorkspaceInput
    ) => void;
    const prepareAcceptedInput = vi.fn(
      () =>
        new Promise<import('@waypoint/api-client').OperationAcceptedWorkspaceInput>((resolve) => {
          finishPreparation = resolve;
        })
    );
    store.attach(Object.assign(runtime, { prepareAcceptedInput }));
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));
    const start = vi.fn(async () => operation('must-not-start', 1));
    const pending = store.startRegisteredOperation(start, 'prepared-key', [
      {
        key: 'reference',
        path: '/hosted/22222222-2222-4222-8222-222222222222/sequences/reference/reference.gb',
      },
    ]);
    const refused = expect(pending).rejects.toThrow(/owner changed before the job was submitted/i);
    runtime.emit('restarting');
    finishPreparation({
      workspace_id: '22222222-2222-4222-8222-222222222222',
      version_id: '33333333-3333-4333-8333-333333333333',
      manifest_sha256: 'a'.repeat(64),
      files: [],
    });
    await refused;
    expect(start).not.toHaveBeenCalled();
  });

  it('fences result publication to the connected runtime instead of accepting a late acknowledgement', async () => {
    const { eventSources, runtime, store } = setup();
    let finish!: () => void;
    const publishWorkspaceResult = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    store.attach(Object.assign(runtime, { publishWorkspaceResult }));
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));
    const result = {
      operationId: 'retained',
      inputRevision: 'revision',
      path: '/hosted/project/history.json',
      content: '{}',
    };
    const pending = store.publishWorkspaceResult(result);
    const refused = expect(pending).rejects.toThrow(/Result attachment/);
    expect(publishWorkspaceResult).toHaveBeenCalledExactlyOnceWith(result);
    runtime.emit('restarting');
    finish();
    await refused;
    await expect(store.publishWorkspaceResult(result)).rejects.toThrow();
    expect(publishWorkspaceResult).toHaveBeenCalledTimes(1);
  });

  it('does not substitute an ordinary filesystem save when guarded publication is unavailable', async () => {
    const { eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));
    await expect(
      store.publishWorkspaceResult({
        operationId: 'retained',
        inputRevision: 'revision',
        path: '/hosted/project/history.json',
        content: '{}',
      })
    ).rejects.toThrow('cannot safely attach');
  });

  it('waits for the same streamed operation record to become terminal without polling', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    const queued = operation('alignment-index', 1, {
      kind: 'alignment-index-preparation',
      state: 'queued',
    });
    eventSources[0]?.emit('initial', initialEvent([queued]));

    let settled = false;
    const pending = store.waitForTerminal('alignment-index', { timeoutMs: 1_000 }).then((value) => {
      settled = true;
      return value;
    });
    eventSources[0]?.emit('snapshot', snapshotEvent({ ...queued, state: 'running', version: 2 }));
    await Promise.resolve();
    expect(settled).toBe(false);

    const succeeded = {
      ...queued,
      state: 'succeeded' as const,
      version: 3,
      cancellation_availability: 'already_settled' as const,
      result_status: 'available' as const,
    };
    eventSources[0]?.emit('snapshot', snapshotEvent(succeeded));

    await expect(pending).resolves.toEqual(succeeded);
    expect(api.getOperation).not.toHaveBeenCalled();
  });

  it('waits for the execution owner to connect before observing a job resumed after reload', async () => {
    const { eventSources, runtime, store } = setup();
    store.attach(runtime);
    const pending = store.waitForTerminal('alignment-index', { timeoutMs: 1_000 });
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([operation('alignment-index', 1)]));
    const succeeded = operation('alignment-index', 2, {
      state: 'succeeded',
      result_status: 'available',
      cancellation_availability: 'already_settled',
    });
    eventSources[0]?.emit('snapshot', snapshotEvent(succeeded));

    await expect(pending).resolves.toEqual(succeeded);
  });

  it('survives a transient stream gap and resolves after the same owner resynchronizes', async () => {
    const { eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([operation('alignment-index', 1)]));

    const pending = store.waitForTerminal('alignment-index', { timeoutMs: 1_000 });
    eventSources[0]?.emit('error');
    eventSources[0]?.emit('initial', initialEvent([operation('alignment-index', 2)]));
    const succeeded = operation('alignment-index', 3, {
      state: 'succeeded',
      result_status: 'available',
      cancellation_availability: 'already_settled',
    });
    eventSources[0]?.emit('snapshot', snapshotEvent(succeeded));

    await expect(pending).resolves.toEqual(succeeded);
  });

  it('detaches a terminal waiter when the execution owner changes while retaining the job', async () => {
    const { eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([operation('alignment-index', 1)]));

    const pending = store.waitForTerminal('alignment-index', { timeoutMs: 1_000 });
    runtime.emit('restarting');

    await expect(pending).rejects.toThrow('observation was interrupted');
    expect(store.getSnapshot().records).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({ id: 'alignment-index', state: 'running' }),
        observation: expect.objectContaining({ freshness: 'stale' }),
      }),
    ]);
  });

  it('holds a registered start until the authoritative runtime identity is connected', async () => {
    const { api, eventSources, runtime, store } = setup();
    const starter = vi.fn(async ({ scopeId }) =>
      operation('coverage-after-startup', 1, {
        kind: 'alignment-coverage-preparation',
        subject: {
          scope_id: scopeId,
          subject_id: 'aligned-read-source-v1:sha256:subject',
          input_revision: 'alignment-coverage-v1:sha256:revision',
        },
      })
    );

    const pending = store.startRegisteredOperation(starter, 'coverage-startup-key');
    await Promise.resolve();
    expect(starter).not.toHaveBeenCalled();

    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    expect(starter).not.toHaveBeenCalled();
    eventSources[0]?.emit('initial', initialEvent([]));

    await expect(pending).resolves.toMatchObject({ id: 'coverage-after-startup' });
    expect(starter).toHaveBeenCalledExactlyOnceWith({
      scopeId: 'scope-a',
      submissionKey: 'coverage-startup-key',
    });
    expect(api.bindGeneratedClient).toHaveBeenCalledTimes(2);
  });

  it('rejects a registered-operation snapshot from a different owner scope', async () => {
    const { eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));

    await expect(
      store.startRegisteredOperation(
        async () =>
          operation('foreign', 1, {
            subject: {
              scope_id: 'scope-b',
              subject_id: 'foreign-subject',
              input_revision: 'foreign-revision',
            },
          }),
        'coverage-key'
      )
    ).rejects.toThrow('different scope');
    expect(store.getSnapshot().records).toEqual([]);
  });

  it('rejects late action history from an obsolete runtime without retrying', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([operation('history', 1)]));

    let resolveActions!: (value: Awaited<ReturnType<ManagedOperationsApi['getActions']>>) => void;
    vi.mocked(api.getActions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveActions = resolve;
        })
    );
    const pending = store.getActions('history');

    runtime.emit('restarting');
    resolveActions({ actions: [], total: 0, next_offset: null });

    await expect(pending).rejects.toThrow('runtime changed');
    expect(api.getActions).toHaveBeenCalledOnce();
  });

  it('rejects action history when the operation identity changes during the read', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([operation('history', 1)]));

    let resolveActions!: (value: Awaited<ReturnType<ManagedOperationsApi['getActions']>>) => void;
    vi.mocked(api.getActions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveActions = resolve;
        })
    );
    const pending = store.getActions('history');

    eventSources[0]?.emit(
      'snapshot',
      snapshotEvent(
        operation('history', 2, {
          subject: {
            scope_id: 'scope-a',
            subject_id: 'replacement-subject',
            input_revision: 'replacement-revision',
          },
        })
      )
    );
    resolveActions({ actions: [], total: 0, next_offset: null });

    await expect(pending).rejects.toThrow('operation identity changed');
    expect(api.getActions).toHaveBeenCalledOnce();
  });

  it('does not request action history for an unknown operation identity', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));

    await expect(store.getActions('unknown')).rejects.toThrow('not in the current operation scope');
    expect(api.getActions).not.toHaveBeenCalled();
  });

  it('reports an uncertain submission key without retrying when runtime authority changes', async () => {
    const { api, eventSources, runtime, store } = setup();
    store.attach(runtime);
    await waitForEventSources(eventSources, 1);
    eventSources[0]?.emit('initial', initialEvent([]));

    let resolveSubmission!: (snapshot: OperationSnapshot) => void;
    vi.mocked(api.startAnnotation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        })
    );
    const pending = store.startAnnotation(
      'document-1',
      { sequence: 'ATGC', linear: true },
      'stable-submission-key'
    );

    runtime.emit('restarting');
    resolveSubmission(operation('started', 1, { state: 'queued' }));

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<ManagedOperationSubmissionUncertainError>>({
        name: 'ManagedOperationSubmissionUncertainError',
        submissionKey: 'stable-submission-key',
      })
    );
    expect(api.startAnnotation).toHaveBeenCalledOnce();
  });
});
