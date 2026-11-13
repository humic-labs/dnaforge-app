import type { TrackStatus } from '../types';

export function StatusBadge({ status }: { status: TrackStatus }) {
  const colors = {
    pass: 'bg-green-500/20 text-green-400',
    variants: 'bg-yellow-500/20 text-yellow-400',
    fail: 'bg-red-500/20 text-red-400',
    incomplete: 'bg-slate-500/20 text-fg-muted',
  };

  const labels = {
    pass: '✓',
    variants: '⚠',
    fail: '✗',
    incomplete: '?',
  };

  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[status]}`}>
      {labels[status]}
    </span>
  );
}
