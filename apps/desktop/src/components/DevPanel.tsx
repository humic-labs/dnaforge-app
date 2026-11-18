import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { usePresentationListener } from '../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { platform } from '../platform';
import { safeFocus } from '../shared/utils/safeFocus';
import type { UpdateSimulationArguments } from '../shared/update-ipc';
import { useDevFixturesMounted } from '../dev/dev-fixtures-mount';
import { MemoryPressureDevControls } from '../features/memory-pressure/public';
import { ToastReviewPanel } from './ToastReviewPanel';
import {
  applyDevScenarioPreset,
  getLastAppliedDevScenarioPresetId,
  resetToLiveState,
} from '../test/scenarios/apply-dev';
import {
  DEV_SCENARIO_PRESET_GROUPS,
  DEV_SCENARIO_PRESETS,
  filterDevScenarioPresetGroups,
  type DevScenarioPreset,
} from '../test/scenarios/dev-presets';

interface DevPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DevPanel({ isOpen, onClose }: DevPanelProps) {
  const presentationEvents = usePresentationListener();

  const [view, setView] = useState<'scenarios' | 'toasts'>('scenarios');
  const [activePreset, setActivePreset] = useState<string | null>(() =>
    getLastAppliedDevScenarioPresetId()
  );
  const [scenarioError, setScenarioError] = useState<string | null>(null);
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const queryRef = useRef(query);
  queryRef.current = query;
  const searchRef = useRef<HTMLInputElement | null>(null);

  const visibleGroups = useMemo(
    () => filterDevScenarioPresetGroups(DEV_SCENARIO_PRESET_GROUPS, query),
    [query]
  );
  const matchCount = useMemo(
    () => visibleGroups.reduce((sum, group) => sum + group.presets.length, 0),
    [visibleGroups]
  );
  const [devFixturesMounted, setDevFixturesMounted] = useDevFixturesMounted();

  const handleApply = useCallback(
    (preset: DevScenarioPreset) => {
      if (pendingPreset) return;
      setScenarioError(null);
      setPendingPreset(preset.id);
      void applyDevScenarioPreset(preset.id)
        .then(() => setActivePreset(preset.id))
        .catch((err) => {
          console.error('[DevPanel] Failed to apply scenario:', err);
          setScenarioError(toUserMessage(err, 'operation.failed'));
        })
        .finally(() => setPendingPreset(null));
    },
    [pendingPreset]
  );

  const handleSimulateUpdate = useCallback((...args: UpdateSimulationArguments) => {
    void platform().update.simulate?.(...args);
  }, []);

  const handleReset = useCallback(() => {
    setScenarioError(null);
    try {
      resetToLiveState();
      setActivePreset(null);
    } catch (err) {
      console.error('[DevPanel] Failed to reset scenario state:', err);
      setActivePreset(getLastAppliedDevScenarioPresetId());
      setScenarioError(toUserMessage(err, 'operation.failed'));
    }
  }, []);

  const openProteinRunComparison = useCallback(() => {
    setScenarioError(null);
    void import('../features/ai/molecular-prompt-notebook')
      .then(({ openMolecularPromptNotebook }) => openMolecularPromptNotebook(null))
      .then(onClose)
      .catch((cause: unknown) =>
        setScenarioError(toUserMessage(cause, 'failure.could-not-open-protein-run-comparison'))
      );
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      safeFocus(searchRef.current);
    } else {
      setQuery('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (queryRef.current) {
        setQuery('');
        return;
      }
      onClose();
    };
    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [isOpen, onClose, presentationEvents]);

  return (
    <div
      data-testid="devpanel"
      data-open={isOpen}
      className={`fixed bottom-4 ${view === 'toasts' ? 'left-4' : 'right-4'} z-50 flex w-[32rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-border bg-bg shadow-2xl transition-all duration-200 ease-out ${
        isOpen ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0'
      }`}
      style={{ maxHeight: 'min(80vh, 780px)' }}
    >
      <div className="flex items-center justify-between rounded-t-lg border-b border-border bg-bg-subtle/50 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          Dev Scenarios
        </span>
        <button
          onClick={onClose}
          className={`${INTERACTION_CLASS} rounded p-1 text-fg-muted transition-colors`}
          title="Close"
          type="button"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-border p-2">
        <button
          type="button"
          data-testid="devpanel-scenarios"
          onClick={() => setView('scenarios')}
          aria-pressed={view === 'scenarios'}
          className="rounded border border-border px-3 py-1 text-xs"
        >
          Scenarios
        </button>
        <button
          type="button"
          data-testid="devpanel-toast-review"
          onClick={() => setView('toasts')}
          aria-pressed={view === 'toasts'}
          className="rounded border border-border px-3 py-1 text-xs"
        >
          Toast review
        </button>
      </div>
      {view === 'toasts' ? (
        <ToastReviewPanel />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setDevFixturesMounted(!devFixturesMounted)}
            className={`${INTERACTION_CLASS} flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs transition-colors`}
            data-testid="dev-fixtures-toggle"
            title="Show or hide developer folders used for preview and import. This does not reset the database."
          >
            <span className="font-semibold uppercase tracking-wider text-fg-muted">
              Dev fixtures
            </span>
            <span
              className={
                devFixturesMounted
                  ? 'rounded bg-accent/15 px-1.5 py-0.5 font-medium text-accent'
                  : 'rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning'
              }
            >
              {devFixturesMounted ? 'Mounted' : 'Unmounted'}
            </span>
          </button>

          <MemoryPressureDevControls />

          <button
            type="button"
            data-testid="devpanel-protein-run-comparison"
            onClick={openProteinRunComparison}
            className={`${INTERACTION_CLASS} border-b border-border px-3 py-2 text-left text-xs font-medium text-accent`}
          >
            Protein run comparison
          </button>

          <div className="border-b border-border px-3 py-2" data-testid="devpanel-update-toasts">
            <div className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Update toasts
            </div>
            <div className="grid grid-cols-2 gap-1">
              {(
                [
                  {
                    label: 'Update ready',
                    testid: 'devpanel-update-downloaded',
                    args: ['update:downloaded', { version: '9.9.9' }],
                  },
                  {
                    label: 'Up to date',
                    testid: 'devpanel-update-no-update',
                    args: ['update:no-update', { version: '9.9.9' }],
                  },
                  {
                    label: 'Check failed',
                    testid: 'devpanel-update-error-check',
                    args: [
                      'update:error',
                      {
                        message: 'Unable to check for updates',
                        stage: 'check',
                        isManual: true,
                        reason: 'network',
                      },
                    ],
                  },
                  {
                    label: 'Download failed',
                    testid: 'devpanel-update-error-download',
                    args: [
                      'update:error',
                      {
                        message: 'Unable to download the update',
                        stage: 'download',
                        isManual: false,
                      },
                    ],
                  },
                ] as const
              ).map((b) => (
                <button
                  key={b.testid}
                  type="button"
                  data-testid={b.testid}
                  onClick={() => handleSimulateUpdate(...b.args)}
                  className={`${INTERACTION_CLASS} rounded border border-border px-2 py-1.5 text-xs text-fg transition-colors`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {scenarioError ? (
            <div className="mx-3 mt-3 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300">
              {toUserMessage(scenarioError, 'operation.failed')}
            </div>
          ) : null}

          <div className="border-b border-border px-3 py-2">
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter scenarios…"
              aria-label="Filter scenarios"
              data-testid="devpanel-search"
              className="w-full rounded border border-border bg-bg-subtle/50 px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
            {query ? (
              <div className="pt-1 text-[10px] text-fg-muted" data-testid="devpanel-search-count">
                {matchCount} of {DEV_SCENARIO_PRESETS.length} scenarios
              </div>
            ) : null}
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto p-2">
            {matchCount === 0 ? (
              <div
                className="px-3 py-6 text-center text-xs text-fg-muted"
                data-testid="devpanel-search-empty"
              >
                No scenarios match “{query}”.
              </div>
            ) : null}
            {visibleGroups.map((group, index) => (
              <div key={group.id}>
                <div
                  className={`px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-fg-muted ${
                    index === 0 ? 'pt-1' : 'pt-2'
                  }`}
                >
                  {group.heading}
                </div>
                {group.presets.map((preset) => {
                  const isActive = activePreset === preset.id;
                  const isPending = pendingPreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => handleApply(preset)}
                      aria-pressed={isActive}
                      aria-busy={isPending}
                      disabled={pendingPreset !== null}
                      className={`${INTERACTION_CLASS} w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                        isActive
                          ? 'border border-accent/30 bg-accent/15 text-accent'
                          : isPending
                            ? 'cursor-wait border border-accent/30 bg-accent/10 text-fg'
                            : pendingPreset
                              ? 'cursor-not-allowed border border-transparent text-fg-muted opacity-60'
                              : 'border border-transparent text-fg '
                      }`}
                      data-testid={`devpanel-${preset.id}`}
                    >
                      <div className="font-mono text-xs">
                        {isPending ? `Loading ${preset.label}…` : preset.label}
                      </div>
                      <div className="mt-0.5 text-xs text-fg-muted">{preset.description}</div>
                      {isPending ? (
                        <div
                          className="mt-1 text-[10px] text-accent"
                          role="status"
                          aria-live="polite"
                        >
                          Loading {preset.label}. The view will open automatically.
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="border-t border-border px-3 py-2">
            <button
              onClick={handleReset}
              disabled={!activePreset}
              type="button"
              className={`${INTERACTION_CLASS} w-full rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                activePreset
                  ? 'bg-bg-muted text-fg '
                  : 'cursor-not-allowed bg-bg-muted/50 text-fg-muted'
              }`}
            >
              Reset to Live
            </button>
          </div>
        </>
      )}
    </div>
  );
}
