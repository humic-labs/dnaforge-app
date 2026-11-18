import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { useState, useMemo } from 'react';
import { useToolboxStatus } from '../hooks/useToolboxStatus';
import { userMessage } from '@waypoint/user-messages';

const PHASE_LABELS: Record<string, string> = {
  pending: 'waiting',
  downloading: 'downloading',
  extracting: 'installing',
  done: 'ready',
  error: 'failed',
};

const TOOL_LABELS: Record<string, string> = {
  blast: 'BLAST+',
  diamond: 'Diamond',
  infernal: 'Infernal',
  mafft: 'MAFFT',
};

export function SetupBanner() {
  const { data } = useToolboxStatus();
  const [dismissed, setDismissed] = useState(false);

  const downloads = data?.downloads;

  const { isActive, allDone, toolStatuses } = useMemo(() => {
    if (!downloads || Object.keys(downloads).length === 0) {
      return { isActive: false, allDone: true, toolStatuses: [] };
    }

    const statuses = Object.entries(downloads).map(([name, status]) => ({
      name,
      label: TOOL_LABELS[name] || userMessage('setup.tool'),
      phase: status.phase,
      phaseLabel: PHASE_LABELS[status.phase] || userMessage('setup.preparing'),
      percent: status.percent,
    }));

    const allToolsDone = statuses.every((s) => s.phase === 'done');
    const anyActive = statuses.some((s) => s.phase !== 'done' && s.phase !== 'error');

    return { isActive: anyActive, allDone: allToolsDone, toolStatuses: statuses };
  }, [downloads]);

  if (dismissed || !isActive || allDone) return null;

  const doneCount = toolStatuses.filter((s) => s.phase === 'done').length;
  const total = toolStatuses.length;

  return (
    <div className="flex items-center justify-between bg-accent/10 border-b border-accent/20 px-4 py-1.5 text-xs">
      <div className="flex items-center gap-3">
        <span className="text-fg-muted font-medium">
          Setting up bioinformatics tools ({doneCount}/{total})
        </span>
        <div className="flex items-center gap-2">
          {toolStatuses.map((tool) => (
            <span
              key={tool.name}
              className={`${
                tool.phase === 'done'
                  ? 'text-green-500'
                  : tool.phase === 'error'
                    ? 'text-red-400'
                    : 'text-fg-muted'
              }`}
            >
              {tool.label}{' '}
              <span className="opacity-70">
                {tool.phase === 'downloading' || tool.phase === 'extracting'
                  ? tool.phaseLabel + '...'
                  : tool.phaseLabel}
              </span>
            </span>
          ))}
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className={`${INTERACTION_CLASS} text-fg-muted ml-2`}
        title="Dismiss (downloads continue in background)"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
