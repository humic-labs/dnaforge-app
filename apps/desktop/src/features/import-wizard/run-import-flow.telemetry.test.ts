import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackRendererEvent = vi.fn(() => true);
const observeWorkflowAction = vi.fn();
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: (event: string, properties?: Record<string, unknown>) =>
    trackRendererEvent(event, properties),
}));
vi.mock('../../lib/workflow-telemetry', () => ({ observeWorkflowAction }));

const { runImportFlow } = await import('./run-import-flow');
type ImportFlowDeps = Parameters<typeof runImportFlow>[1];

const state = {
  items: [{ path: '/d/a.gb', name: 'a.gb', kind: 'file' as const }],
  destination: { kind: 'existing-root' as const, rootPath: '/ws' },
  requiresExplicitChoice: false,
  destinationChosen: true,
  agentRequested: false,
};

function deps(over: Partial<ImportFlowDeps> = {}): ImportFlowDeps {
  return {
    buildState: vi.fn(async () => state),
    openWizard: vi.fn(async () => ({
      items: state.items,
      destination: state.destination,
      agentRequested: false,
    })),
    execDeps: {
      importFile: vi.fn(async () => ({ destPath: '/ws/a.gb', relPath: 'a.gb', committed: true })),
      importFolder: vi.fn(async () => ({ destPath: '/ws/x', relPath: 'x', committed: true })),
      importManaged: vi.fn(async () => ({ repoPath: '/managed/repo' })),
    },
    ...over,
  } as ImportFlowDeps;
}

function emitted(): { event: string; properties?: Record<string, unknown> }[] {
  return trackRendererEvent.mock.calls.map(([event, properties]) => ({ event, properties }));
}

beforeEach(() => {
  trackRendererEvent.mockClear();
  observeWorkflowAction.mockClear();
});

describe('import funnel telemetry ', () => {
  it('emits started then completed for a confirmed import', async () => {
    await runImportFlow(['/d/a.gb'], deps());
    const observed = emitted();
    const events = observed.map((e) => e.event);
    expect(events).toEqual(['import_started', 'import_completed']);
    const operationIds = observed.map((event) => event.properties?.operation_id);
    expect(operationIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(operationIds).size).toBe(1);
    expect(observeWorkflowAction).toHaveBeenCalledWith({
      workflow: 'file',
      action: 'import',
      status: 'completed',
      resultCount: 1,
    });
  });

  it('stamps the completed event with registry-shaped buckets, never raw counts', async () => {
    await runImportFlow(['/d/a.gb'], deps());
    const completed = emitted().find((e) => e.event === 'import_completed');
    expect(completed?.properties).toMatchObject({
      feature_area: 'import',
      source_system_type: 'file',
      file_type_category: 'dna',
      record_count_bucket: '1',
    });
    expect(completed?.properties?.import_duration_bucket).toMatch(/^(lt_1s|1_5s|5_30s|30s_plus)$/);
  });

  it('records a dismissed wizard without counting it as a started import', async () => {
    await runImportFlow(['/d/a.gb'], deps({ openWizard: vi.fn(async () => null) }));
    const observed = emitted();
    expect(observed.map((e) => e.event)).toEqual(['import_wizard_dismissed']);
    expect(observed[0]?.properties).toMatchObject({
      feature_area: 'import',
      source_system_type: 'file',
      file_type_category: 'dna',
      record_count_bucket: '1',
    });
    expect(observed[0]?.properties?.import_duration_bucket).toMatch(
      /^(lt_1s|1_5s|5_30s|30s_plus)$/
    );
    expect(JSON.stringify(observed)).not.toContain('a.gb');
    expect(observeWorkflowAction).not.toHaveBeenCalled();
  });

  it('emits NOTHING for an empty path list', async () => {
    await runImportFlow([], deps());
    expect(emitted()).toEqual([]);
  });

  it('does NOT report a total write failure as a completed import', () => {
    return runImportFlow(
      ['/d/a.gb'],
      deps({
        execDeps: {
          importFile: vi.fn(async () => {
            throw new Error('disk full');
          }),
          importFolder: vi.fn(async () => ({ destPath: '/ws/x', relPath: 'x', committed: true })),
          importManaged: vi.fn(async () => ({ repoPath: '/managed/repo' })),
        } as ImportFlowDeps['execDeps'],
      })
    )
      .catch(() => undefined)
      .then(() => {
        const events = emitted().map((e) => e.event);
        expect(events).toContain('import_failed');
        expect(events).not.toContain('import_completed');
      });
  });

  it('classifies a write failure with an allowlist-shaped error class', () => {
    return runImportFlow(
      ['/d/a.gb'],
      deps({
        execDeps: {
          importFile: vi.fn(async () => {
            throw new Error('super secret /Users/scientist/patient.gb detail');
          }),
          importFolder: vi.fn(async () => ({ destPath: '/ws/x', relPath: 'x', committed: true })),
          importManaged: vi.fn(async () => ({ repoPath: '/managed/repo' })),
        } as ImportFlowDeps['execDeps'],
      })
    )
      .catch(() => undefined)
      .then(() => {
        const failure = emitted().find((e) => e.event === 'import_failed');
        expect(failure?.properties?.failure_stage).toMatch(
          /^(parse|validate|normalize|write|unknown)$/
        );
        expect(failure?.properties?.error_class).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
        expect(JSON.stringify(emitted())).not.toContain('patient');
      });
  });

  it('never lets a telemetry failure break the import', async () => {
    trackRendererEvent.mockImplementation(() => {
      throw new Error('posthog exploded');
    });
    const onComplete = vi.fn();
    try {
      const result = await runImportFlow(['/d/a.gb'], deps({ onComplete }));
      expect(result).toMatchObject({ imported: 1 });
      expect(onComplete).toHaveBeenCalled();
    } finally {
      trackRendererEvent.mockImplementation(() => true);
    }
  });

  it('emits workspace_created only when the import minted a new workspace', async () => {
    await runImportFlow(['/d/a.gb'], deps());
    expect(emitted().some((e) => e.event === 'workspace_created')).toBe(false);
  });

  it('emits completion plus failure when a registry copy lands but registration is rejected', async () => {
    const registryItem = {
      path: '/d/rejected.gb',
      name: 'rejected.gb',
      kind: 'file' as const,
      target: { kind: 'registry' as const },
    };
    const registryState = { ...state, items: [registryItem] };
    const result = await runImportFlow(
      [registryItem.path],
      deps({
        buildState: vi.fn(async () => registryState),
        openWizard: vi.fn(async () => ({
          items: registryState.items,
          destination: registryState.destination,
          agentRequested: false,
        })),
        execDeps: {
          ...deps().execDeps,
          registerImportedSequence: vi.fn(async () => ({
            destPath: '/ws/rejected.gb',
            registered: false,
            batchId: null,
            entityIds: [],
            reason: 'The file was imported, but registry registration failed: duplicate entity',
          })),
        } as ImportFlowDeps['execDeps'],
      })
    );

    expect(result).toMatchObject({ imported: 1, failed: 1 });
    expect(emitted().map((event) => event.event)).toEqual([
      'import_started',
      'import_completed',
      'import_failed',
    ]);
    expect(new Set(emitted().map((event) => event.properties?.operation_id)).size).toBe(1);
  });

  it('never emits a file name or path in any property', async () => {
    await runImportFlow(['/d/patient-BRCA1-sample.gb'], deps());
    const serialized = JSON.stringify(emitted());
    expect(serialized).not.toContain('BRCA1');
    expect(serialized).not.toContain('patient');
    expect(serialized).not.toContain('/d/');
  });
});

describe('nothing-written imports  review follow-up)', () => {
  const nothingWritten = {
    importFile: vi.fn(async () => ({ destPath: '', relPath: '', skipped: true })),
    importFolder: vi.fn(async () => ({ destPath: '/ws/x', relPath: 'x', committed: true })),
    importManaged: vi.fn(async () => ({ repoPath: '/managed/repo' })),
  };

  it('never books a completed import that wrote zero items', async () => {
    await runImportFlow(
      ['/d/a.gb'],
      deps({ execDeps: nothingWritten as ImportFlowDeps['execDeps'] })
    ).catch(() => undefined);

    const completed = emitted().filter((e) => e.event === 'import_completed');
    for (const event of completed) {
      expect(
        event.properties?.record_count_bucket,
        'a completed import must have written something'
      ).not.toBe('0');
    }
    expect(emitted().length, 'the attempt must be recorded somehow').toBeGreaterThan(0);
  });

  it('records a terminal event for every started import', async () => {
    for (const execDeps of [nothingWritten, deps().execDeps]) {
      trackRendererEvent.mockClear();
      await runImportFlow(
        ['/d/a.gb'],
        deps({ execDeps: execDeps as ImportFlowDeps['execDeps'] })
      ).catch(() => undefined);
      const events = emitted().map((e) => e.event);
      const starts = events.filter((e) => e === 'import_started').length;
      const terminals = events.filter(
        (e) => e === 'import_completed' || e === 'import_failed'
      ).length;
      expect(starts, `starts for ${JSON.stringify(events)}`).toBe(1);
      expect(terminals, `terminals for ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('additive drag consistency  review follow-up)', () => {
  const confirmedItems = [
    { path: '/d/dropped.csv', name: 'dropped.csv', kind: 'file' as const },
    { path: '/d/appended-1.gb', name: 'appended-1.gb', kind: 'file' as const },
    { path: '/d/appended-2.gb', name: 'appended-2.gb', kind: 'file' as const },
  ];

  function additiveDeps() {
    return deps({
      openWizard: vi.fn(async () => ({
        items: confirmedItems,
        destination: state.destination,
        agentRequested: false,
      })),
    });
  }

  it('labels both ends of the funnel from the CONFIRMED set, not the first drop', async () => {
    await runImportFlow(['/d/dropped.csv'], additiveDeps());
    const started = emitted().find((e) => e.event === 'import_started');
    expect(started?.properties?.file_type_category).toBe('dna');
  });

  it('keeps the labels matched even when only SOME confirmed files land', async () => {
    const d = deps({
      openWizard: vi.fn(async () => ({
        items: confirmedItems,
        destination: state.destination,
        agentRequested: false,
      })),
      execDeps: {
        importFile: vi.fn(async ({ sourcePath }: { sourcePath: string }) =>
          sourcePath.endsWith('.gb')
            ? { destPath: '', relPath: '', skipped: true }
            : { destPath: '/ws/dropped.csv', relPath: 'dropped.csv', committed: true }
        ),
        importFolder: vi.fn(async () => ({ destPath: '/ws/x', relPath: 'x', committed: true })),
        importManaged: vi.fn(async () => ({ repoPath: '/managed/repo' })),
      } as ImportFlowDeps['execDeps'],
    });
    await runImportFlow(['/d/dropped.csv'], d);
    const started = emitted().find((e) => e.event === 'import_started');
    const completed = emitted().find((e) => e.event === 'import_completed');
    expect(completed, 'one file landed, so the import completed').toBeDefined();
    expect(started?.properties?.file_type_category).toBe('dna');
    expect(completed?.properties?.file_type_category).toBe('dna');
  });

  it('gives start and finish the SAME file-type label', async () => {
    await runImportFlow(['/d/dropped.csv'], additiveDeps());
    const started = emitted().find((e) => e.event === 'import_started');
    const completed = emitted().find((e) => e.event === 'import_completed');
    expect(completed).toBeDefined();
    expect(completed?.properties?.file_type_category).toBe(started?.properties?.file_type_category);
  });
});
