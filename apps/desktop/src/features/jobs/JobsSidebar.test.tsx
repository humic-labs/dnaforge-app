import { userMessage } from '@waypoint/user-messages';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JobsSidebar } from './JobsSidebar';
import type { JobsSidebarActionHistory, JobsSidebarJob, JobsSidebarSnapshot } from './presentation';

const NOW = Date.UTC(2026, 8, 9, 20, 0, 0);

function job(overrides: Partial<JobsSidebarJob> = {}): JobsSidebarJob {
  const requestedId = overrides.id ?? 'operation-1';
  const nativeId = overrides.owner?.nativeId ?? requestedId.replace(/^operation:/, '');
  return {
    title: 'Annotate sequence',
    target: 'pBR322.dna',
    actorLabel: 'Peter',
    state: 'running',
    observation: { freshness: 'current', observedAtMs: NOW },
    result: { availability: 'none' },
    review: { state: 'not-required' },
    executionContext: {
      mode: 'managed',
      ownerLabel: 'DNAForge local service',
      locationLabel: 'This Mac',
      lifetimeLabel: 'Runs while DNAForge is open',
    },
    createdAtMs: NOW - 90_000,
    startedAtMs: NOW - 65_000,
    canStop: true,
    canLoadActions: true,
    ...overrides,
    id: requestedId.startsWith('operation:') ? requestedId : `operation:${requestedId}`,
    owner: overrides.owner ?? { kind: 'managed-operation', nativeId },
  };
}

function snapshot(jobs: readonly JobsSidebarJob[]): JobsSidebarSnapshot {
  return {
    jobs,
    nowMs: NOW,
    collectionObservation: { state: 'current', observedAtMs: NOW },
  };
}

function renderSidebar(
  value: JobsSidebarSnapshot,
  options: {
    onLoadActions?: (owner: JobsSidebarJob['owner']) => Promise<JobsSidebarActionHistory>;
    onImportRecordedRun?: () => void;
    importingRecordedRun?: boolean;
  } = {}
) {
  const onStop = vi.fn();
  const onImportResult = vi.fn();
  const onOpenResult = vi.fn();
  const onReleaseResult = vi.fn();
  const onScopeChange = vi.fn();
  const rendered = render(
    <div style={{ width: 180, height: 700 }}>
      <JobsSidebar
        snapshot={value}
        onStop={onStop}
        onImportResult={onImportResult}
        onOpenResult={onOpenResult}
        onReleaseResult={onReleaseResult}
        onScopeChange={onScopeChange}
        onLoadActions={options.onLoadActions}
        onImportRecordedRun={options.onImportRecordedRun}
        importingRecordedRun={options.importingRecordedRun}
      />
    </div>
  );
  return { ...rendered, onStop, onImportResult, onOpenResult, onReleaseResult, onScopeChange };
}

describe('JobsSidebar', () => {
  it('shows the saved review outcome and history before optional technical identifiers', async () => {
    const user = userEvent.setup();
    renderSidebar(
      snapshot([
        job({
          state: 'succeeded',
          canStop: false,
          result: { availability: 'available' },
          review: { state: 'applied' },
          inputRevision: 'long-input-digest',
          actions: [
            { id: 'save-action', label: 'Apply to document', outcomeLabel: 'Document saved' },
          ],
        }),
      ])
    );
    const row = screen.getByTestId('job-row-operation-1');
    expect(within(row).getByText('Review: Applied')).toBeVisible();
    await user.click(
      within(row).getByRole('button', { name: /^Show details for Annotate sequence\b/ })
    );
    expect(within(row).getByText('Available', { exact: true })).toBeVisible();
    expect(within(row).getByText('Applied', { exact: true })).toBeVisible();
    expect(within(row).getByText('Apply to document · Document saved')).toBeVisible();
    expect(within(row).getByText('operation-1', { exact: true })).not.toBeVisible();
    expect(within(row).getByText('long-input-digest')).not.toBeVisible();
    await user.click(within(row).getByText('Technical details', { selector: 'summary' }));
    expect(within(row).getByText('operation-1', { exact: true })).toBeVisible();
    expect(within(row).getByText('long-input-digest')).toBeVisible();
  });

  it('shows Active, Needs attention and Recent with truthful states and reasons', () => {
    renderSidebar(
      snapshot([
        job({
          id: 'run',
          progress: { completed: 12, total: 40, label: 'Scanning features' },
          inputRevision: 'rev-7',
        }),
        job({ id: 'stop', title: 'Stopping export', state: 'stopping', canStop: false }),
        job({ id: 'wait', title: 'Waiting annotation', state: 'queued', startedAtMs: undefined }),
        job({
          id: 'failure',
          title: 'Failed annotation',
          state: 'failed',
          canStop: false,
          error: 'Reference data is unavailable',
        }),
        job({
          id: 'done',
          title: 'Completed annotation',
          state: 'succeeded',
          canStop: false,
          result: { availability: 'available' },
        }),
      ])
    );

    expect(screen.getByRole('heading', { name: 'Active' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Waiting' })).not.toBeInTheDocument();
    expect(screen.getByText('12/40')).toBeInTheDocument();
    expect(screen.getByText(/Scanning features/)).toBeInTheDocument();
    expect(screen.getAllByText('1m 5s')).not.toHaveLength(0);
    expect(screen.getByText('Stopping')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText(userMessage('jobs.failed'))).toBeInTheDocument();
  });

  it('uses explicit result availability and never offers Stop for settled review work', async () => {
    const user = userEvent.setup();
    const { onStop, onOpenResult, onReleaseResult } = renderSidebar(
      snapshot([
        job({ id: 'running' }),
        job({ id: 'stopping', title: 'Stopping job', state: 'stopping', canStop: true }),
        job({
          id: 'expired',
          title: 'Expired result',
          state: 'succeeded',
          canStop: false,
          result: { availability: 'expired', reason: 'Retention period ended' },
        }),
        job({
          id: 'review',
          title: 'Review annotations',
          state: 'succeeded',
          canStop: true,
          result: { availability: 'available' },
          review: { state: 'awaiting-review', reason: 'Choose annotations to apply' },
        }),
        job({
          id: 'external-result',
          title: 'External input result',
          state: 'succeeded',
          canStop: false,
          canOpenResult: false,
          result: { availability: 'available' },
        }),
        job({
          id: 'releaseable',
          title: 'Release retained output',
          state: 'succeeded',
          canStop: false,
          canOpenResult: false,
          canReleaseResult: true,
          result: { availability: 'available' },
          review: { state: 'not-checked' },
        }),
        job({
          id: 'released',
          title: 'Released output',
          state: 'succeeded',
          canStop: false,
          canOpenResult: false,
          canReleaseResult: false,
          result: {
            availability: 'released',
            reason: 'Retained output was deleted; execution history remains',
          },
          review: { state: 'applied' },
        }),
      ])
    );

    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Open result' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Release result' })).toHaveLength(1);
    expect(screen.getByText('Choose annotations to apply')).toBeInTheDocument();

    const expired = screen.getByTestId('job-row-expired');
    expect(within(expired).getByText('Completed')).toBeInTheDocument();
    await user.click(
      within(expired).getByRole('button', { name: /^Show details for Expired result\b/ })
    );
    expect(within(expired).getByText('Expired')).toBeInTheDocument();
    expect(within(expired).getByText('Retention period ended')).toBeInTheDocument();

    const released = screen.getByTestId('job-row-released');
    await user.click(
      within(released).getByRole('button', { name: /^Show details for Released output\b/ })
    );
    expect(within(released).getByText('Released')).toBeInTheDocument();
    expect(within(released).getByText(userMessage('jobs.resultReleased'))).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(screen.getByRole('button', { name: 'Open result' }));
    await user.click(screen.getByRole('button', { name: 'Release result' }));
    expect(onStop).toHaveBeenCalledWith({ kind: 'managed-operation', nativeId: 'running' });
    expect(onOpenResult).toHaveBeenCalledWith({
      kind: 'managed-operation',
      nativeId: 'review',
    });
    expect(onReleaseResult).toHaveBeenCalledWith({
      kind: 'managed-operation',
      nativeId: 'releaseable',
    });
  });

  it('keeps hosted result import distinct from reopening an imported result', async () => {
    const user = userEvent.setup();
    const { onImportResult, onOpenResult } = renderSidebar(
      snapshot([
        job({
          id: 'compute:completed',
          owner: { kind: 'hosted-compute', nativeId: 'completed' },
          title: 'Completed hosted prediction',
          state: 'succeeded',
          canStop: false,
          canImportResult: true,
          canOpenResult: false,
          canLoadActions: false,
          executionContext: { mode: 'connected' },
          result: { availability: 'available' },
        }),
        job({
          id: 'compute:imported',
          owner: { kind: 'hosted-compute', nativeId: 'imported' },
          title: 'Imported hosted prediction',
          state: 'succeeded',
          canStop: false,
          canImportResult: false,
          canOpenResult: true,
          canLoadActions: false,
          executionContext: { mode: 'connected' },
          result: { availability: 'available' },
        }),
      ])
    );

    await user.click(screen.getByRole('button', { name: 'Import result' }));
    await user.click(screen.getByRole('button', { name: 'Open result' }));

    expect(onImportResult).toHaveBeenCalledWith({
      kind: 'hosted-compute',
      nativeId: 'completed',
    });
    expect(onOpenResult).toHaveBeenCalledWith({
      kind: 'hosted-compute',
      nativeId: 'imported',
    });
  });

  it('updates elapsed time for quiet current work without observing execution', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const view = renderSidebar(
      snapshot([
        job({
          id: 'quiet-run',
          createdAtMs: NOW - 1_000,
          startedAtMs: NOW - 1_000,
        }),
      ])
    );

    try {
      expect(screen.getByText('1s')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByText('3s')).toBeInTheDocument();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('shows supplied ownership, location, lifetime, tracking mode and unsupported Stop reason', async () => {
    const user = userEvent.setup();
    renderSidebar(
      snapshot([
        job({
          id: 'connected',
          title: 'Cluster alignment',
          executionContext: {
            mode: 'connected',
            ownerLabel: 'Lab Slurm',
            ownerInstanceId: 'cluster-owner-session-42',
            locationLabel: 'Research cluster',
            lifetimeLabel: 'Continues after DNAForge closes',
          },
          canStop: false,
          stopUnavailableReason: 'This connection does not support cancellation',
        }),
        job({
          id: 'recorded',
          title: 'Imported analysis',
          state: 'succeeded',
          canStop: false,
          executionContext: {
            mode: 'recorded',
            ownerLabel: 'Imported workflow receipt',
            locationLabel: 'External system',
          },
          result: { availability: 'available' },
        }),
      ])
    );

    await user.click(screen.getByRole('button', { name: /^Show details for Cluster alignment\b/ }));
    expect(screen.getByText('Connected execution')).toBeInTheDocument();
    expect(screen.getByText('Lab Slurm')).toBeInTheDocument();
    expect(screen.getByText('cluster-owner-session-42')).toBeInTheDocument();
    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('Research cluster')).toBeInTheDocument();
    expect(screen.getByText('Continues after DNAForge closes')).toBeInTheDocument();
    expect(screen.getByText('This connection does not support cancellation')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Show details for Imported analysis\b/ }));
    expect(screen.getByText('Recorded history · no live control')).toBeInTheDocument();
    expect(screen.getByText('Imported workflow receipt')).toBeInTheDocument();
  });

  it('labels a recorded row by its actual importer and keeps reported facts explicit', async () => {
    const user = userEvent.setup();
    renderSidebar(
      snapshot([
        job({
          id: 'recorded',
          state: 'succeeded',
          canStop: false,
          actorLabel: 'receipt-importer@example.test',
          actorActionLabel: 'Imported by',
          actorChannelLabel: 'Managed CLI',
          durationLabel: 'Recorded result',
          executionContext: { mode: 'recorded' },
          recordedProvenance: {
            sourceLabel: 'Self-reported receipt',
            runId: 'offline-run-42',
            tool: 'dnaforge-annotation 0.1.0',
            startedAt: '2026-09-09T17:00:00Z',
            finishedAt: '2026-09-09T17:02:30Z',
            input: 'pUC19 · 2,686 bases · sha256:aaaa',
            referenceVersions: 'snapgene: 2026.09',
          },
        }),
      ])
    );

    expect(screen.getByText('Recorded result')).toBeInTheDocument();
    expect(
      screen.getByText('Imported by receipt-importer@example.test · Managed CLI')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Started by receipt-importer/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Show details for Annotate sequence\b/ }));
    expect(screen.getByText('Recorded history · no live control')).toBeInTheDocument();
    expect(screen.getByText('Self-reported receipt')).toBeInTheDocument();
    expect(screen.getByText('offline-run-42')).toBeInTheDocument();
    expect(screen.getByText('dnaforge-annotation 0.1.0')).toBeInTheDocument();
    expect(screen.getByText('2026-09-09T17:00:00Z')).toBeInTheDocument();
    expect(screen.getByText('2026-09-09T17:02:30Z')).toBeInTheDocument();
    expect(screen.queryByText('Runs while DNAForge is open')).not.toBeInTheDocument();
  });

  it('shows the retained execution tool after details load without replacing it with current-engine metadata', async () => {
    const user = userEvent.setup();
    const onLoadActions = vi.fn(async () => ({
      actions: [],
      total: 0,
      truncated: false,
      toolVersion: 'MAFFT v7.505 (2022/Apr/10)',
    }));
    renderSidebar(snapshot([job({ id: 'tool', toolVersion: 'Not reported by execution owner' })]), {
      onLoadActions,
    });
    await user.click(
      within(screen.getByTestId('job-row-tool')).getByRole('button', {
        name: /^Show details for Annotate sequence\b/,
      })
    );
    expect(await screen.findByText('MAFFT v7.505 (2022/Apr/10)')).toBeInTheDocument();
    expect(screen.queryByText('Not reported by execution owner')).not.toBeInTheDocument();
    expect(onLoadActions).toHaveBeenCalledOnce();
    expect(onLoadActions).toHaveBeenCalledWith({ kind: 'managed-operation', nativeId: 'tool' });
  });

  it('loads one bounded action page only after disclosure and reports truncation', async () => {
    const user = userEvent.setup();
    let resolveHistory!: (history: JobsSidebarActionHistory) => void;
    const onLoadActions = vi.fn(
      () =>
        new Promise<JobsSidebarActionHistory>((resolve) => {
          resolveHistory = resolve;
        })
    );
    renderSidebar(snapshot([job({ id: 'one' }), job({ id: 'two' })]), { onLoadActions });

    expect(onLoadActions).not.toHaveBeenCalled();
    const disclosure = within(screen.getByTestId('job-row-one')).getByRole('button', {
      name: /^Show details for Annotate sequence\b/,
    });
    await user.click(disclosure);
    expect(onLoadActions).toHaveBeenCalledOnce();
    expect(onLoadActions).toHaveBeenCalledWith({
      kind: 'managed-operation',
      nativeId: 'one',
    });
    expect(screen.getByText('Loading history…')).toBeInTheDocument();

    resolveHistory({
      actions: [
        {
          id: 'action-1',
          label: 'Import recorded',
          outcomeLabel: 'Imported',
          actorLabel: 'importer@example.test',
          actorKindLabel: 'Human',
          channelLabel: 'Managed CLI',
          atMs: NOW - 1_000,
        },
      ],
      total: 3,
      truncated: true,
      omittedCount: 7,
      historyComplete: false,
    });

    expect(await screen.findByText(/Import recorded · Imported/)).toHaveTextContent(
      'Human importer@example.test · Managed CLI'
    );
    expect(screen.getByText('Showing 1 of 3 retained actions.')).toBeInTheDocument();
    expect(
      screen.getByText("7 earlier actions were omitted by the execution owner's history policy.")
    ).toBeInTheDocument();
    await user.click(disclosure);
    await user.click(disclosure);
    expect(onLoadActions).toHaveBeenCalledOnce();
  });

  it('reports a lazy action-history failure without retrying automatically', async () => {
    const user = userEvent.setup();
    const onLoadActions = vi.fn(async () => {
      throw new Error('Operation read completed after the execution runtime changed.');
    });
    renderSidebar(snapshot([job({ id: 'history-error' })]), { onLoadActions });

    await user.click(screen.getByRole('button', { name: /^Show details for Annotate sequence\b/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'History unavailable. ' + userMessage('operation.failed')
    );
    expect(onLoadActions).toHaveBeenCalledOnce();
  });

  it('refreshes history on request and includes actions from another client', async () => {
    const user = userEvent.setup();
    const onLoadActions = vi
      .fn()
      .mockResolvedValueOnce({
        actions: [{ id: 'created', label: 'Started' }],
        total: 1,
        truncated: false,
      })
      .mockResolvedValueOnce({
        actions: [
          { id: 'created', label: 'Started' },
          { id: 'stopped', label: 'Stop requested', channelLabel: 'Managed CLI' },
        ],
        total: 2,
        truncated: false,
      });
    renderSidebar(snapshot([job({ id: 'refresh' })]), { onLoadActions });
    await user.click(screen.getByRole('button', { name: /^Show details for Annotate sequence\b/ }));
    expect(await screen.findByText('Started')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh history' }));
    expect(await screen.findByText('Stop requested · Managed CLI')).toBeInTheDocument();
    expect(onLoadActions).toHaveBeenCalledTimes(2);
    expect(onLoadActions).toHaveBeenLastCalledWith({
      kind: 'managed-operation',
      nativeId: 'refresh',
    });
  });

  it('allows an explicit history retry after failure and disables duplicate reads', async () => {
    const user = userEvent.setup();
    let resolveHistory!: (history: JobsSidebarActionHistory) => void;
    const onLoadActions = vi
      .fn()
      .mockRejectedValueOnce(new Error('Owner unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<JobsSidebarActionHistory>((resolve) => {
            resolveHistory = resolve;
          })
      );
    renderSidebar(snapshot([job({ id: 'retry-history' })]), { onLoadActions });
    await user.click(screen.getByRole('button', { name: /^Show details for Annotate sequence\b/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(userMessage('operation.failed'));
    await user.click(screen.getByRole('button', { name: 'Refresh history' }));
    const pending = screen.getByRole('button', { name: 'Refreshing history…' });
    expect(pending).toBeDisabled();
    await user.click(pending);
    expect(onLoadActions).toHaveBeenCalledTimes(2);
    resolveHistory({ actions: [], total: 0, truncated: false });
    expect(await screen.findByText('No retained actions.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers recorded-run import only when the caller supplies the capability', async () => {
    const user = userEvent.setup();
    const unsupported = renderSidebar(snapshot([]));
    expect(screen.queryByRole('button', { name: 'Record completed run…' })).not.toBeInTheDocument();
    unsupported.unmount();

    const onImportRecordedRun = vi.fn();
    renderSidebar(snapshot([]), { onImportRecordedRun, importingRecordedRun: true });
    const button = screen.getByRole('button', { name: 'Recording completed run…' });
    expect(button).toBeDisabled();

    await user.click(button);
    expect(onImportRecordedRun).not.toHaveBeenCalled();
  });

  it('preserves stale owner truth and labels active state as last known', async () => {
    const user = userEvent.setup();
    renderSidebar(
      snapshot([
        job({
          id: 'stale',
          title: 'Remote annotation',
          observation: {
            freshness: 'stale',
            observedAtMs: NOW - 120_000,
            reason: 'Owner heartbeat is overdue',
          },
        }),
      ])
    );

    expect(screen.queryByRole('heading', { name: 'Active' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(screen.getByText('Last known: Running')).toBeInTheDocument();
    expect(screen.getByText(userMessage('jobs.statusStale'))).toBeInTheDocument();
    expect(screen.queryByText(/active$/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Show details for Remote annotation\b/ }));
    expect(screen.getByText(/Stale · last observed/)).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('uses the whole narrow row header as a keyboard disclosure and exposes full values in details', async () => {
    const user = userEvent.setup();
    renderSidebar(
      snapshot([
        job({
          id: 'narrow',
          title: 'Annotate a long construct name',
          target: 'extremely-long-construct-name-that-does-not-fit.dna',
          actorLabel: 'Dr. Alexandra Example-With-A-Long-Name',
          inputRevision: 'sha256:1234',
        }),
      ])
    );

    const row = screen.getByTestId('job-row-narrow');
    const disclosure = within(row).getByRole('button', {
      name: /^Show details for Annotate a long construct name\b/,
    });
    const stop = within(row).getByRole('button', { name: 'Stop' });
    expect(disclosure).toHaveClass('w-full');
    expect(disclosure.contains(stop)).toBe(false);
    expect(disclosure).toHaveAccessibleName(
      'Show details for Annotate a long construct name. Target extremely-long-construct-name-that-does-not-fit.dna. Running. Started by Dr. Alexandra Example-With-A-Long-Name'
    );

    disclosure.focus();
    await user.keyboard('{Enter}');

    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(disclosure);
    const detailsId = disclosure.getAttribute('aria-controls');
    const details = detailsId ? document.getElementById(detailsId) : null;
    expect(details).not.toBeNull();
    expect(
      within(details as HTMLElement).getByText(
        'extremely-long-construct-name-that-does-not-fit.dna'
      )
    ).toBeInTheDocument();
    expect(
      within(details as HTMLElement).getByText('Dr. Alexandra Example-With-A-Long-Name')
    ).toBeInTheDocument();
  });

  it('keeps exact target identity in details when a human label is available', async () => {
    const user = userEvent.setup();
    renderSidebar(
      snapshot([
        job({
          id: 'labelled-target',
          target: 'pUC19.gb',
          targetIdentity: 'fixture:sequence:jobs-annotation-puc19',
        }),
      ])
    );

    const row = screen.getByTestId('job-row-labelled-target');
    expect(within(row).getByText('pUC19.gb')).toBeInTheDocument();
    expect(
      within(row).queryByText('fixture:sequence:jobs-annotation-puc19')
    ).not.toBeInTheDocument();

    await user.click(
      within(row).getByRole('button', { name: /^Show details for Annotate sequence\b/ })
    );

    expect(within(row).getByText('fixture:sequence:jobs-annotation-puc19')).toBeInTheDocument();
  });

  it('expands only real batch children and preserves partial failures in the rollup', async () => {
    const user = userEvent.setup();
    const { onStop } = renderSidebar(
      snapshot([
        job({
          id: 'batch',
          title: 'Annotate batch',
          state: 'succeeded',
          canStop: false,
          children: [
            job({ id: 'one', title: 'Sample one', state: 'succeeded', canStop: false }),
            job({ id: 'two', title: 'Sample two', state: 'failed', canStop: false }),
            job({ id: 'three', title: 'Sample three', state: 'queued', startedAtMs: undefined }),
          ],
        }),
        job({
          id: 'ordinary',
          title: 'Ordinary job',
          target: undefined,
          actorLabel: '',
          executionContext: { mode: 'managed' },
        }),
      ])
    );

    expect(screen.getByText('2/3 finished · 1 failed')).toBeInTheDocument();
    expect(screen.queryByText('Sample one')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Show details for Annotate batch\b/ }));
    const children = screen.getByRole('list', { name: 'Items in Annotate batch' });
    expect(within(children).getByText('Sample one')).toBeInTheDocument();
    expect(within(children).getByText('Sample two')).toBeInTheDocument();
    expect(within(children).getByText('Sample three')).toBeInTheDocument();
    await user.click(within(children).getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledWith({ kind: 'managed-operation', nativeId: 'three' });
  });

  it('renders a scope filter only when real scopes are supplied', () => {
    const { onScopeChange } = renderSidebar({
      ...snapshot([job({ scopeId: 'a' })]),
      scopes: [
        { id: 'a', label: 'Workspace A' },
        { id: 'b', label: 'Workspace B' },
      ],
      selectedScopeId: 'a',
    });

    const filter = screen.getByRole('combobox', { name: 'Job scope' });
    expect(within(filter).getByRole('option', { name: 'All workspaces' })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'b' } });
    expect(onScopeChange).toHaveBeenCalledWith('b');
  });

  it('does not render invented filters, work, or controls for an empty snapshot', () => {
    renderSidebar(snapshot([]));

    expect(screen.getByText('No tracked jobs yet.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Job scope' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open result' })).not.toBeInTheDocument();
  });

  it('states when policy-limited history omits finished rows but includes every active row', () => {
    const value = snapshot([
      job({ id: 'active-one' }),
      job({ id: 'active-two', state: 'queued', startedAtMs: undefined }),
      job({ id: 'visible-terminal', state: 'succeeded', canStop: false }),
    ]);
    renderSidebar({
      ...value,
      historySummary: {
        operationCount: 12,
        activeCount: 2,
        terminalCount: 10,
        historyComplete: false,
      },
    });

    expect(screen.getByText('Recent history is limited.')).toBeInTheDocument();
    expect(
      screen.getByText('All 2 active jobs are shown. Showing 1 of 10 finished jobs.')
    ).toBeInTheDocument();
    expect(screen.getByText('2 active')).toBeInTheDocument();
  });

  it('describes limited active coverage as last-refresh truth when observation is stale', () => {
    const stale = job({
      id: 'stale-active',
      observation: {
        freshness: 'stale',
        observedAtMs: NOW - 1_000,
        reason: 'Execution owner is offline',
      },
    });
    renderSidebar({
      ...snapshot([stale]),
      collectionObservation: {
        state: 'unavailable',
        observedAtMs: NOW - 1_000,
        reason: 'Execution owner is offline',
      },
      historySummary: {
        operationCount: 11,
        activeCount: 1,
        terminalCount: 10,
        historyComplete: false,
      },
    });

    expect(
      screen.getByText('The last refresh included all 1 active job. Showing 0 of 10 finished jobs.')
    ).toBeInTheDocument();
    expect(screen.queryByText('All 1 active job is shown.')).not.toBeInTheDocument();
  });

  it('distinguishes connecting and unavailable history from verified connected-empty history', () => {
    const callbacks = {
      onStop: vi.fn(),
      onImportResult: vi.fn(),
      onOpenResult: vi.fn(),
      onReconnect: vi.fn(),
    };
    const view = render(
      <JobsSidebar
        snapshot={{
          jobs: [],
          nowMs: NOW,
          collectionObservation: { state: 'connecting' },
        }}
        {...callbacks}
      />
    );

    expect(screen.getByText('Connecting to job history…')).toBeInTheDocument();
    expect(screen.queryByText('No tracked jobs yet.')).not.toBeInTheDocument();

    view.rerender(
      <JobsSidebar
        snapshot={{
          jobs: [],
          nowMs: NOW,
          collectionObservation: {
            state: 'unavailable',
            observedAtMs: NOW - 60_000,
            reason: 'Execution owner is offline',
            canReconnect: true,
          },
        }}
        {...callbacks}
      />
    );

    expect(screen.getByText('Job status is unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Last known/)).toBeInTheDocument();
    expect(screen.getByText('Execution owner is offline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(callbacks.onReconnect).toHaveBeenCalledOnce();
    expect(screen.queryByText('No tracked jobs yet.')).not.toBeInTheDocument();
  });
});
