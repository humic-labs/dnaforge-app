import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useToastStore } from '../../stores/toast-store';

const trackRendererEvent = vi.fn(() => true);
const observeWorkflowAction = vi.fn();
const ingressMocks = vi.hoisted(() => ({ applyAcceptedLimsImportPlan: vi.fn() }));
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: (event: string, properties?: Record<string, unknown>) =>
    trackRendererEvent(event, properties),
}));
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction }));
vi.mock('../lims/ingress', () => ({
  applyAcceptedLimsImportPlan: ingressMocks.applyAcceptedLimsImportPlan,
}));

const { applyTabularEntries, runTabularImportFlow, TabularApplyPartialError } =
  await import('./run-tabular-import-flow');

const files = [{ name: 'plates.csv', text: 'a,b\n1,2\n' }];
const entries = [{ fileName: 'plates.csv', plan: { canApply: true } }] as never;

function deps(over: Record<string, unknown> = {}) {
  return {
    buildPlans: vi.fn(async () => entries),
    openWizard: vi.fn(async () => entries),
    apply: vi.fn(async () => ({ registered: 3, links: 1, batchIds: ['b1'] })),
    undo: vi.fn(async () => 0),
    ...over,
  } as Parameters<typeof runTabularImportFlow>[1];
}

function emitted(): { event: string; properties?: Record<string, unknown> }[] {
  return trackRendererEvent.mock.calls.map(([event, properties]) => ({ event, properties }));
}

beforeEach(() => {
  trackRendererEvent.mockClear();
  observeWorkflowAction.mockClear();
  ingressMocks.applyAcceptedLimsImportPlan.mockReset();
  useToastStore.getState().clearToasts();
});

describe('tabular import funnel telemetry ', () => {
  it('emits started then completed for a confirmed spreadsheet import', async () => {
    await runTabularImportFlow(files, deps());
    const observed = emitted();
    expect(observed.map((e) => e.event)).toEqual(['import_started', 'import_completed']);
    const operationIds = observed.map((event) => event.properties?.operation_id);
    expect(operationIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(operationIds).size).toBe(1);
    expect(observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'file',
      action: 'import',
      status: 'completed',
      resultCount: 3,
    });
  });

  it('reports the registered entity count, bucketed', async () => {
    await runTabularImportFlow(files, deps());
    const completed = emitted().find((e) => e.event === 'import_completed');
    expect(completed?.properties).toMatchObject({
      feature_area: 'import',
      source_system_type: 'file',
      file_type_category: 'spreadsheet',
      record_count_bucket: '2_5',
    });
  });

  it('classifies only the files the user confirms', async () => {
    const mixedFiles = [
      { name: 'sequence.gb', text: 'LOCUS' },
      { name: 'plates.csv', text: 'a,b\n1,2\n' },
    ];
    const confirmedSpreadsheet = [{ fileName: 'plates.csv', plan: { canApply: true } }] as never;
    await runTabularImportFlow(
      mixedFiles,
      deps({ openWizard: vi.fn(async () => confirmedSpreadsheet) })
    );

    expect(emitted()[0]?.properties?.file_type_category).toBe('spreadsheet');
  });

  it('emits NOTHING when the user cancels', async () => {
    await runTabularImportFlow(files, deps({ openWizard: vi.fn(async () => null) }));
    expect(emitted()).toEqual([]);
  });

  it('does not report an all-duplicates import as completed', async () => {
    await runTabularImportFlow(
      files,
      deps({ apply: vi.fn(async () => ({ registered: 0, links: 0, batchIds: [] })) })
    );
    const events = emitted();
    expect(events.map((e) => e.event)).toContain('import_failed');
    expect(events.map((e) => e.event)).not.toContain('import_completed');
    expect(events.find((e) => e.event === 'import_failed')?.properties?.failure_stage).toBe(
      'validate'
    );
  });

  it('emits a failure and rethrows when registration throws', async () => {
    const boom = new Error('db locked');
    await expect(
      runTabularImportFlow(
        files,
        deps({
          apply: vi.fn(async () => {
            throw boom;
          }),
        })
      )
    ).rejects.toBe(boom);
    expect(emitted().map((e) => e.event)).toEqual(['import_started', 'import_failed']);
  });

  it('preserves the durable tally when a later spreadsheet entry throws', async () => {
    const boom = new Error('second sheet failed');
    ingressMocks.applyAcceptedLimsImportPlan
      .mockResolvedValueOnce({
        batchId: 'b1',
        insertedEntities: 3,
        insertedLinks: 1,
      })
      .mockRejectedValueOnce(boom);

    const twoEntries = [
      { fileName: 'first.csv', plan: { canApply: true } },
      { fileName: 'second.csv', plan: { canApply: true } },
    ] as never;
    const applyError = await applyTabularEntries(twoEntries).catch((error: unknown) => error);

    expect(applyError).toBeInstanceOf(TabularApplyPartialError);
    expect((applyError as InstanceType<typeof TabularApplyPartialError>).originalError).toBe(boom);
    expect((applyError as InstanceType<typeof TabularApplyPartialError>).partialResult).toEqual({
      registered: 3,
      links: 1,
      batchIds: ['b1'],
    });
  });

  it('reports and preserves Undo for a durable partial spreadsheet import', async () => {
    const boom = new Error('second sheet failed');
    const partialError = new TabularApplyPartialError(boom, {
      registered: 3,
      links: 1,
      batchIds: ['b1'],
    });
    const partialDeps = deps({
      apply: vi.fn(async () => {
        throw partialError;
      }),
    });

    await expect(runTabularImportFlow(files, partialDeps)).resolves.toBeUndefined();

    const events = emitted();
    expect(events.map((event) => event.event)).toEqual([
      'import_started',
      'import_completed',
      'import_failed',
      'user_notification_observed',
    ]);
    expect(new Set(events.slice(0, 3).map((event) => event.properties?.operation_id)).size).toBe(1);
    expect(events[3]?.properties).toEqual({
      feature_area: 'reliability',
      notification_id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
      occurred_at_ms: expect.any(Number),
      notification_definition: 'tabular-import-partial-failure',
      notification_variant: 'with-undo',
      notification_severity: 'error',
    });
    expect(emitted().find((event) => event.event === 'import_completed')?.properties).toMatchObject(
      {
        record_count_bucket: '2_5',
      }
    );
    expect(emitted().find((event) => event.event === 'import_failed')?.properties).toMatchObject({
      failure_stage: 'write',
      error_class: 'import_item_write_failed',
    });

    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast).toMatchObject({ type: 'error', duration: 0 });
    expect(toast?.message).toContain('Registered 3 entities');
    expect(toast?.message).toContain('remaining import failed');
    expect(toast?.message).not.toContain('second sheet failed');
    expect(toast?.actions?.[0]?.label).toBe('Undo');

    toast?.actions?.[0]?.onClick();
    await vi.waitFor(() => expect(partialDeps.undo).toHaveBeenCalledWith(['b1']));
  });

  it('never emits a spreadsheet file name', async () => {
    await runTabularImportFlow([{ name: 'patient-cohort-BRCA1.xlsx', text: 'a\n1\n' }], deps());
    const serialized = JSON.stringify(emitted());
    expect(serialized).not.toContain('BRCA1');
    expect(serialized).not.toContain('patient');
    expect(serialized).not.toContain('.xlsx');
  });
});
