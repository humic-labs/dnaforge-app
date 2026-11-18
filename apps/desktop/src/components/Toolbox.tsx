import { INTERACTION_CLASS } from '@waypoint/ui-components';
import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { useToolboxStatus } from '../hooks/useToolboxStatus';
import { useSidecarStatus } from '../hooks/use-sidecar-status';
import { CheckIcon, ChevronRightIcon, RefreshIcon } from './icons/glyphs';

interface ComponentStatus {
  id: string;
  label: string;
  status: string;
  version?: string;
  source: string;
  path?: string;
  progress?: { phase: string; percent: number; detail: string };
  size_mb?: number;
}

interface CapabilityStatus {
  id: string;
  label: string;
  status: string;
  source: string;
  tier: string;
  auto_install: boolean;
  components: ComponentStatus[];
}

function StatusDot({ status, capId }: { status: string; capId: string }) {
  if (status === 'downloading') {
    return (
      <div
        data-testid={`status-dot-${capId}`}
        className="w-2.5 h-2.5 border border-accent border-t-transparent rounded-full animate-spin"
      />
    );
  }
  const colorClass =
    status === 'ready' ? 'bg-success' : status === 'error' ? 'bg-error' : 'bg-fg-muted';
  return (
    <div data-testid={`status-dot-${capId}`} className={`w-2.5 h-2.5 rounded-full ${colorClass}`} />
  );
}

function formatStatus(status: string): UserMessage {
  switch (status) {
    case 'ready':
      return userMessage('tools.ready');
    case 'extracting_archive':
    case 'extracting':
      return userMessage('tools.extracting');
    case 'installing':
      return userMessage('tools.installing');
    case 'verifying':
      return userMessage('tools.verifying');
    case 'done':
      return userMessage('tools.ready');
    case 'downloading':
      return userMessage('tools.updating');
    case 'error':
      return userMessage('tools.attention');
    case 'unavailable':
      return userMessage('tools.unavailable');
    default:
      return userMessage('tools.preparing');
  }
}

function statusBadgeClass(status: string) {
  if (status === 'ready') return 'border-success/20 bg-success/10 text-success';
  if (status === 'downloading') return 'border-accent/20 bg-accent/10 text-accent';
  if (status === 'error') return 'border-error/25 bg-error/10 text-error';
  return 'border-border bg-bg-muted/70 text-fg-subtle';
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none ${statusBadgeClass(
        status
      )}`}
    >
      {formatStatus(status)}
    </span>
  );
}

function SummaryBadge({
  label,
  value,
  status,
}: {
  label: string;
  value: number | string;
  status: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${statusBadgeClass(
        status
      )}`}
    >
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-current/80">{label}</span>
    </span>
  );
}

function ToolboxSummary({ capabilities }: { capabilities: CapabilityStatus[] }) {
  const total = capabilities.length;
  const ready = capabilities.filter((cap) => cap.status === 'ready').length;
  const downloading = capabilities.filter((cap) => cap.status === 'downloading').length;
  const error = capabilities.filter((cap) => cap.status === 'error').length;
  const unavailable = capabilities.filter((cap) => cap.status === 'unavailable').length;

  return (
    <div data-testid="toolbox-summary" className="border-b border-border bg-bg-subtle/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
          Health
        </span>
        <SummaryBadge label="ready" value={`${ready}/${total}`} status="ready" />
        {downloading > 0 && (
          <SummaryBadge label="updating" value={downloading} status="downloading" />
        )}
        {error > 0 && <SummaryBadge label="attention" value={error} status="error" />}
        {unavailable > 0 && (
          <SummaryBadge label="offline" value={unavailable} status="unavailable" />
        )}
      </div>
    </div>
  );
}

function formatSizeMb(sizeMb?: number) {
  if (!sizeMb) return null;
  if (sizeMb >= 100) return `${Math.round(sizeMb)} MB`;
  return `${sizeMb.toFixed(1).replace(/\.0$/, '')} MB`;
}

function ComponentRow({ comp }: { comp: ComponentStatus }) {
  const meta = [comp.version, formatSizeMb(comp.size_mb)].filter(Boolean);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1 text-xs text-fg-muted">
      <div className="min-w-0">
        <div className="truncate">{comp.label}</div>
        {meta.length > 0 && (
          <div className="truncate text-[11px] text-fg-subtle">{meta.join(' / ')}</div>
        )}
      </div>
      <StatusBadge status={comp.status} />
    </div>
  );
}

function componentSummary(cap: CapabilityStatus): UserMessage {
  const total = cap.components.length;
  if (total === 0) return userMessage('tools.noDetails');
  const ready = cap.components.filter((comp) => comp.status === 'ready').length;
  const downloading = cap.components.filter((comp) => comp.status === 'downloading').length;
  const errorCount = cap.components.filter((comp) => comp.status === 'error').length;
  if (downloading > 0)
    return userMessageWithValues('tools.updatingCount', {
      count: userMessageValue(downloading),
      total: userMessageValue(total),
    });
  if (errorCount > 0)
    return userMessageWithValues('tools.attentionCount', {
      count: userMessageValue(errorCount),
      total: userMessageValue(total),
    });
  return userMessageWithValues('tools.readyCount', {
    count: userMessageValue(ready),
    total: userMessageValue(total),
  });
}

function clampPercent(percent: number) {
  return Math.min(100, Math.max(0, percent));
}

function CapabilityProgress({ components }: { components: ComponentStatus[] }) {
  const progressComponents = components.filter(
    (comp): comp is ComponentStatus & { progress: NonNullable<ComponentStatus['progress']> } =>
      Boolean(comp.progress)
  );
  if (progressComponents.length === 0) return null;

  return (
    <div className="space-y-1 px-2.5 pb-2 pl-7">
      {progressComponents.map((comp) => {
        const progress = comp.progress;
        const percent = clampPercent(progress.percent);
        const label = userMessageWithValues('tools.progress', {
          name: userMessageValue(comp.label),
          phase: userMessageValue(formatStatus(progress.phase)),
        });

        return (
          <div key={comp.id} className="space-y-1">
            <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-fg-muted">
              <span className="truncate">{label}</span>
              <span className="shrink-0 tabular-nums text-accent">{percent}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-bg-muted">
              <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CapabilityRow({
  cap,
  onRetry,
  onHealthCheck,
}: {
  cap: CapabilityStatus;
  onRetry: (capId: string) => void;
  onHealthCheck: (capId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = cap.components.length > 0;
  const hasRetry = cap.status === 'error' && cap.auto_install;
  const hasHealthCheck = cap.source === 'plugin';

  return (
    <div data-testid={`capability-row-${cap.id}`} className="group">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 px-2.5 py-2">
        <StatusDot status={cap.status} capId={cap.id} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg">{cap.label}</div>
          <div className="truncate text-[11px] text-fg-subtle">
            {componentSummary(cap)}
            {cap.source === 'plugin' ? ' / plugin' : ''}
          </div>
        </div>
        <StatusBadge status={cap.status} />
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          disabled={!hasDetails}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${cap.label} details`}
          className={`${INTERACTION_CLASS} flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors disabled:pointer-events-none disabled:opacity-30`}
        >
          <ChevronRightIcon
            size={12}
            className={`transition-transform duration-fast ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
      </div>

      <CapabilityProgress components={cap.components} />

      {(hasRetry || hasHealthCheck) && (
        <div className="flex flex-wrap items-center gap-2 px-2.5 pb-2 pl-7 text-[11px]">
          {hasRetry && (
            <button
              type="button"
              onClick={() => onRetry(cap.id)}
              className="inline-flex h-5 items-center gap-1 rounded px-1 text-error/80 transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error"
            >
              <RefreshIcon size={11} />
              Retry Download
            </button>
          )}
          {hasHealthCheck && (
            <button
              type="button"
              onClick={() => onHealthCheck(cap.id)}
              className={`${INTERACTION_CLASS} inline-flex h-5 items-center gap-1 rounded px-1 text-fg-subtle transition-colors`}
            >
              <CheckIcon size={11} />
              Test Connection
            </button>
          )}
        </div>
      )}

      {expanded && hasDetails && (
        <div className="border-t border-border bg-bg-subtle/40 px-2.5 py-1.5 pl-7">
          {cap.components.map((comp) => (
            <ComponentRow key={comp.id} comp={comp} />
          ))}
        </div>
      )}
    </div>
  );
}

function CapabilitySection({
  title,
  capabilities,
  onRetry,
  onHealthCheck,
}: {
  title: string;
  capabilities: CapabilityStatus[];
  onRetry: (capId: string) => void;
  onHealthCheck: (capId: string) => void;
}) {
  if (capabilities.length === 0) return null;

  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{title}</h3>
        <span className="text-[11px] text-fg-subtle tabular-nums">
          {capabilities.length} {capabilities.length === 1 ? 'capability' : 'capabilities'}
        </span>
      </div>
      <div className="divide-y divide-border border-y border-border">
        {capabilities.map((cap) => (
          <CapabilityRow key={cap.id} cap={cap} onRetry={onRetry} onHealthCheck={onHealthCheck} />
        ))}
      </div>
    </section>
  );
}

export function Toolbox() {
  const { data, loadState, refetch, retry, healthCheck } = useToolboxStatus();
  const sidecarStatus = useSidecarStatus();

  const isInitializing =
    (sidecarStatus === 'starting' || sidecarStatus === 'restarting') && loadState === 'error';

  useEffect(() => {
    if (sidecarStatus === 'ready' && loadState !== 'loaded') {
      refetch();
    }
  }, [loadState, refetch, sidecarStatus]);

  const baseCaps = data?.capabilities.filter((c) => c.tier === 'base') ?? [];
  const optionalCaps = data?.capabilities.filter((c) => c.tier === 'optional') ?? [];
  const allCaps = data?.capabilities ?? [];

  return (
    <div data-testid="toolbox-panel" className="flex flex-col h-full">
      <div className="p-4 border-b border-border">
        <h2 className="text-sm font-semibold text-fg">Toolbox</h2>
        <p className="text-xs text-fg-muted mt-0.5">Capability health and background setup</p>
      </div>

      {loadState === 'loaded' && <ToolboxSummary capabilities={allCaps} />}

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {loadState === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <div className="w-3 h-3 border border-fg-muted border-t-transparent rounded-full animate-spin" />
            Loading toolbox...
          </div>
        )}

        {loadState === 'error' && isInitializing && (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <div className="w-3 h-3 border border-fg-muted border-t-transparent rounded-full animate-spin" />
            Starting analysis engine...
          </div>
        )}

        {loadState === 'error' && !isInitializing && (
          <div className="text-xs text-fg-muted">
            <p className="text-xs text-error">Cannot connect to sidecar</p>
            <button
              type="button"
              onClick={refetch}
              className={`${INTERACTION_CLASS} mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-fg-subtle transition-colors`}
            >
              <RefreshIcon size={11} />
              Retry
            </button>
          </div>
        )}

        {loadState === 'unavailable' && (
          <div className="text-xs text-fg-muted">
            <p>
              Toolbox status needs the desktop app&rsquo;s session credential, which this context
              does not have.
            </p>
            <p className="mt-1 text-fg-subtle">
              Expected outside Electron (browser-only dev). Retrying will not help.
            </p>
          </div>
        )}

        {loadState === 'loaded' && (
          <>
            <CapabilitySection
              title="Base Packages"
              capabilities={baseCaps}
              onRetry={retry}
              onHealthCheck={healthCheck}
            />

            <CapabilitySection
              title="Optional"
              capabilities={optionalCaps}
              onRetry={retry}
              onHealthCheck={healthCheck}
            />
          </>
        )}
      </div>
    </div>
  );
}
