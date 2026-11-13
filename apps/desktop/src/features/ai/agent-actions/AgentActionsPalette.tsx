import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';

import { platform } from '../../../platform';
import type {
  AgentCapabilityControl,
  AgentCapabilityKind,
  AgentCapabilitySnapshot,
} from '../../../shared/agent-capability-controls';
import type { AgentTransport } from '../../../shared/agent-runtime-ipc';
import { safeFocus } from '../../../shared/utils/safeFocus';

export interface AgentCapabilityChoice {
  snapshotId: string;
  control: AgentCapabilityControl;
}

export interface AgentActionsPaletteProps {
  open: boolean;
  provider: AgentTransport | null;
  workspacePath: string | null;
  conversationId?: string | null;
  onClose: () => void;
  onSelect: (choice: AgentCapabilityChoice) => void;
  onManage?: () => void;
}

const KIND_LABELS: Record<AgentCapabilityKind, string> = {
  command: 'Commands',
  'custom-command': 'Custom commands',
  skill: 'Skills',
  plugin: 'Plugins',
  memory: 'Memory',
  'attachment-input': 'Inputs',
  'attachment-output': 'Outputs',
  'structured-output': 'Structured output',
  account: 'Provider status',
};

const KIND_ORDER: AgentCapabilityKind[] = [
  'command',
  'custom-command',
  'plugin',
  'memory',
  'attachment-input',
  'attachment-output',
  'structured-output',
  'account',
];

type CapabilityFilterId = 'all' | 'commands' | 'plugins' | 'memory';

const CAPABILITY_FILTERS: Array<{
  id: CapabilityFilterId;
  label: string;
  kinds: AgentCapabilityKind[] | null;
}> = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'commands', label: 'Commands', kinds: ['command', 'custom-command'] },
  { id: 'plugins', label: 'Plugins', kinds: ['plugin'] },
  { id: 'memory', label: 'Memory', kinds: ['memory'] },
];

const PROVIDER_LABELS: Record<AgentTransport, string> = {
  'codex-sdk': 'Codex CLI',
  'claude-agent-sdk': 'Claude Code',
  'grok-acp': 'Grok Build',
};

function isInvocable(control: AgentCapabilityControl): boolean {
  return control.availability.state === 'supported' && control.stages.invocable;
}

function belongsInActions(control: AgentCapabilityControl): boolean {
  if (control.kind === 'skill') return false;
  return control.kind !== 'plugin' || control.providerPlugin?.installed !== false;
}

export function AgentActionsPalette({
  open,
  provider,
  workspacePath,
  conversationId,
  onClose,
  onSelect,
  onManage,
}: AgentActionsPaletteProps) {
  const [snapshot, setSnapshot] = useState<AgentCapabilitySnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [activeControlId, setActiveControlId] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<CapabilityFilterId>('all');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !provider) return;
    let current = true;
    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedFilter('all');
    void platform()
      .agentCapabilities.discover({
        provider,
        workspacePath,
        ...(conversationId ? { conversationId } : {}),
      })
      .then((nextSnapshot) => {
        if (current) setSnapshot(nextSnapshot);
      })
      .catch((cause: unknown) => {
        if (current) {
          setSnapshot(null);
          setError(toUserMessage(cause, 'failure.capability-discovery-failed'));
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [conversationId, open, provider, workspacePath]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => safeFocus(searchRef.current));
    return () => cancelAnimationFrame(frame);
  }, [open, snapshot]);

  const filterCounts = useMemo(() => {
    const controls = (snapshot?.controls ?? []).filter(belongsInActions);
    return Object.fromEntries(
      CAPABILITY_FILTERS.map((filter) => [
        filter.id,
        filter.kinds
          ? controls.filter((control) => filter.kinds?.includes(control.kind)).length
          : controls.length,
      ])
    ) as Record<CapabilityFilterId, number>;
  }, [snapshot]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const activeKinds = CAPABILITY_FILTERS.find((filter) => filter.id === selectedFilter)?.kinds;
    const controls = (snapshot?.controls ?? []).filter(
      (control) =>
        belongsInActions(control) &&
        (!activeKinds || activeKinds.includes(control.kind)) &&
        (!needle ||
          control.label.toLowerCase().includes(needle) ||
          control.description.toLowerCase().includes(needle) ||
          control.kind.includes(needle))
    );
    return KIND_ORDER.map((kind) => ({
      kind,
      controls: controls.filter((control) => control.kind === kind),
    })).filter((group) => group.controls.length > 0);
  }, [query, selectedFilter, snapshot]);

  const selectableControls = useMemo(
    () => groups.flatMap((group) => group.controls).filter(isInvocable),
    [groups]
  );

  useEffect(() => {
    setActiveControlId((current) =>
      current && selectableControls.some((control) => control.id === current)
        ? current
        : (selectableControls[0]?.id ?? null)
    );
  }, [selectableControls]);

  const moveActive = (delta: number): void => {
    setActiveControlId((current) => {
      if (selectableControls.length === 0) return null;
      const currentIndex = selectableControls.findIndex((control) => control.id === current);
      if (currentIndex < 0) {
        return delta < 0
          ? (selectableControls[selectableControls.length - 1]?.id ?? null)
          : (selectableControls[0]?.id ?? null);
      }
      const nextIndex =
        (currentIndex + delta + selectableControls.length) % selectableControls.length;
      return selectableControls[nextIndex].id;
    });
  };

  if (!open || !provider) return null;

  const select = async (control: AgentCapabilityControl): Promise<void> => {
    if (!snapshot || !isInvocable(control)) return;
    setResolvingId(control.id);
    setError(null);
    try {
      const result = await platform().agentCapabilities.resolve({
        snapshotId: snapshot.snapshotId,
        provider,
        capabilityId: control.id,
      });
      if (!result.ok) {
        setError(
          result.reason === 'stale-snapshot'
            ? userMessage(
                'notice.this-provider-catalog-changed-refresh-it-before-choosing-an-action'
              )
            : userMessage('failure.this-action-is-no-longer-available')
        );
        return;
      }
      onSelect({ snapshotId: snapshot.snapshotId, control: result.control });
      onClose();
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.could-not-select-this-action'));
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/45 px-4 pt-[9vh] backdrop-blur-[2px]"
      data-testid="agent-actions-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Agent actions"
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border/80 bg-bg shadow-2xl ring-1 ring-black/5"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="border-b border-border/70 bg-bg-subtle/40 px-5 pb-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-sm font-semibold text-accent">
                AI
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-fg">Choose an agent action</h2>
                <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                  <span>{PROVIDER_LABELS[provider]}</span>
                  <span aria-hidden="true">·</span>
                  <span>{filterCounts.all} discovered actions</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-transparent px-2.5 py-1.5 text-xs text-fg-muted hover:border-border hover:bg-bg hover:text-fg"
              aria-label="Close agent actions"
            >
              Close
            </button>
          </div>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveActive(event.key === 'ArrowDown' ? 1 : -1);
                return;
              }
              if (event.key === 'Enter') {
                const active =
                  selectableControls.find((control) => control.id === activeControlId) ??
                  selectableControls[0];
                if (active) {
                  event.preventDefault();
                  void select(active);
                }
              }
            }}
            placeholder="Search commands, plugins, memory…"
            aria-label="Search agent actions"
            aria-controls="agent-actions-results"
            aria-activedescendant={
              activeControlId ? `agent-action-option-${activeControlId}` : undefined
            }
            className="mt-3 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg shadow-sm outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/15"
          />
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Action types">
            {CAPABILITY_FILTERS.map((filter) => {
              const selected = selectedFilter === filter.id;
              return (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedFilter(filter.id)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    selected
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-border bg-bg text-fg-muted hover:bg-bg-muted hover:text-fg'
                  }`}
                >
                  <span>{filter.label}</span>
                  <span
                    className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                      selected ? 'bg-accent/15' : 'bg-bg-muted'
                    }`}
                  >
                    {filterCounts[filter.id]}
                  </span>
                </button>
              );
            })}
          </div>
        </header>

        <div id="agent-actions-results" className="min-h-28 flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <p className="px-3 py-6 text-center text-sm text-fg-muted">Loading actions…</p>
          )}
          {!loading && error && (
            <p
              role="alert"
              className="mx-2 my-2 rounded-md bg-error/10 px-3 py-2 text-xs text-error"
            >
              {toUserMessage(error, 'assistant.failed')}
            </p>
          )}
          {!loading && !error && groups.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-3 py-10 text-center">
              <p className="text-sm font-medium text-fg">No actions to show</p>
              <p className="mt-1 text-xs text-fg-muted">
                {query
                  ? 'Try a different search.'
                  : selectedFilter === 'all'
                    ? 'This provider did not advertise any actions.'
                    : 'This provider did not advertise actions in this category.'}
              </p>
            </div>
          )}
          {!loading &&
            groups.map((group) => (
              <div key={group.kind} className="mb-4" data-testid={`agent-actions-${group.kind}`}>
                <h3 className="mb-1.5 flex items-center gap-2 px-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                  {KIND_LABELS[group.kind]}
                  <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
                </h3>
                <ul
                  role="list"
                  aria-label={KIND_LABELS[group.kind]}
                  className="overflow-hidden rounded-lg border border-border/80 bg-bg"
                >
                  {group.controls.map((control) => {
                    const enabled = isInvocable(control);
                    const reason =
                      control.availability.state === 'supported'
                        ? enabled
                          ? null
                          : 'Available for inspection; invocation is not implemented yet.'
                        : control.availability.reason;
                    return (
                      <li key={control.id} className="border-b border-border/70 last:border-b-0">
                        <button
                          id={`agent-action-option-${control.id}`}
                          type="button"
                          disabled={!enabled || resolvingId !== null}
                          onClick={() => void select(control)}
                          className={`group flex w-full items-center justify-between gap-3 border-l-2 px-3 py-2 text-left transition-colors hover:bg-bg-muted disabled:cursor-default disabled:opacity-55 ${
                            activeControlId === control.id
                              ? 'border-l-accent bg-accent/[0.06]'
                              : 'border-l-transparent bg-bg'
                          }`}
                          title={
                            reason != null
                              ? toUserMessage(reason, 'assistant.failed')
                              : toUserMessage(control.description, 'assistant.failed')
                          }
                          data-testid={`agent-action-${control.id}`}
                          onFocus={() => enabled && setActiveControlId(control.id)}
                          onMouseEnter={() => enabled && setActiveControlId(control.id)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-fg">
                              {control.label}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] leading-4 text-fg-muted">
                              {control.description}
                            </span>
                          </span>
                          <span className="shrink-0 rounded bg-bg-muted px-1.5 py-0.5 text-[10px] capitalize text-fg-subtle">
                            {resolvingId === control.id
                              ? 'Selecting…'
                              : reason
                                ? control.availability.state === 'supported'
                                  ? 'Browse only'
                                  : 'Unavailable'
                                : control.scope}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border/70 bg-bg-subtle/30 px-5 py-3 text-[11px] text-fg-subtle">
          <span>
            <kbd className="rounded border border-border bg-bg px-1 py-0.5">↑↓</kbd> navigate ·{' '}
            <kbd className="rounded border border-border bg-bg px-1 py-0.5">Enter</kbd> select
          </span>
          {onManage && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onManage();
              }}
              className="shrink-0 rounded-lg border border-border bg-bg px-3 py-1.5 font-medium text-fg shadow-sm hover:border-accent/30 hover:bg-bg-muted"
              aria-label="Manage agent extensions"
            >
              Manage extensions
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
