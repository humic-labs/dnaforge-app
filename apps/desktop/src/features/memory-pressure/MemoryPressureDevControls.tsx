import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import { platform } from '../../platform';
import type { MemoryPressureLevel } from '../../shared/memory-pressure';
import { useMemoryPressureStore } from './pressure-store';
import { listRetentionPools } from './registry';

const CHOICES: ReadonlyArray<{ label: string; level: MemoryPressureLevel | null }> = [
  { label: 'Real', level: null },
  { label: 'Normal', level: 'normal' },
  { label: 'Moderate', level: 'moderate' },
  { label: 'Critical', level: 'critical' },
];

export function MemoryPressureDevControls() {
  const reading = useMemoryPressureStore();
  const [error, setError] = useState<string | null>(null);

  const force = (level: MemoryPressureLevel | null) => {
    setError(null);
    void platform()
      .runtime.forceMemoryPressure(level)
      .then((snapshot) => useMemoryPressureStore.getState().apply(snapshot))
      .catch((err: unknown) => setError(toUserMessage(err, 'operation.failed')));
  };

  return (
    <div className="border-b border-border px-3 py-2" data-testid="devpanel-memory-pressure">
      <div className="flex items-center justify-between pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        <span>Memory pressure</span>
        <span data-testid="devpanel-memory-pressure-level" className="normal-case tracking-normal">
          {reading.level} · {reading.source}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {CHOICES.map((choice) => (
          <button
            key={choice.label}
            type="button"
            data-testid={`devpanel-memory-pressure-${choice.label.toLowerCase()}`}
            onClick={() => force(choice.level)}
            className="rounded border border-border px-2 py-1.5 text-xs text-fg transition-colors hover:bg-bg-muted"
          >
            {choice.label}
          </button>
        ))}
      </div>
      <ul className="pt-1 text-[11px] text-fg-muted">
        {listRetentionPools().map((pool) => (
          <li key={pool.id}>
            {pool.id}: {pool.recency.length} kept (budget {pool.budgets.normal}/
            {pool.budgets.moderate}/{pool.budgets.critical})
          </li>
        ))}
      </ul>
      {error ? (
        <div className="pt-1 text-xs text-red-600">{toUserMessage(error, 'operation.failed')}</div>
      ) : null}
    </div>
  );
}
