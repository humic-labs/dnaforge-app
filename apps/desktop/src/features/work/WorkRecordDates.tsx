import { useEffect, useState } from 'react';
import { platform } from '../../platform';
import type { WorkRecordDate } from '../../shared/work-tasks-ipc';
import { navigateToRegistryEntity } from '../lims/public/registry-presentation';
import { observeWorkChanges, useWorkAccount } from './use-work-query';
import { describeDate } from './task-form';
import { workTimeStart } from '@waypoint/domain-services';

export async function openWorkRecordDate(row: WorkRecordDate) {
  const result = await navigateToRegistryEntity({
    entityId: row.entityId,
    fallbackSearch: row.entityName,
  });
  if (result.status !== 'presented')
    throw new Error('The source record could not be opened. Refresh the project and try again.');
}

export function useWorkRecordDates(root?: string) {
  const account = useWorkAccount();
  const key = JSON.stringify([root, account]);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    rows: WorkRecordDate[];
    error?: string;
  }>();
  useEffect(() => observeWorkChanges(() => setAttempt((n) => n + 1)), []);
  useEffect(() => {
    if (!root) return;
    let active = true;
    async function read() {
      try {
        const rows: WorkRecordDate[] = [];
        let offset: number | null = 0;
        while (active && offset !== null) {
          const result = await platform().workTasks.dates({
            workspaceRoot: root,
            offset,
            limit: 100,
          });
          if (result.nextOffset !== null && result.nextOffset <= offset)
            throw new Error('Record dates changed while loading. Refresh to try again.');
          rows.push(...result.rows);
          offset = result.nextOffset;
        }
        if (active)
          setSnapshot({
            key,
            rows: [...new Map(rows.map((row) => [row.id, row])).values()].sort((a, b) =>
              a.status === 'unresolved'
                ? b.status === 'unresolved'
                  ? a.id.localeCompare(b.id)
                  : 1
                : b.status === 'unresolved'
                  ? -1
                  : workTimeStart(a.value) - workTimeStart(b.value) || a.id.localeCompare(b.id)
            ),
          });
      } catch (cause) {
        if (active)
          setSnapshot({
            key,
            rows: [],
            error: cause instanceof Error ? cause.message : 'Record dates are unavailable.',
          });
      }
    }
    void read();
    return () => {
      active = false;
    };
  }, [key, root, attempt]);
  return snapshot?.key === key ? snapshot : { rows: [] };
}

export function WorkRecordDateAgenda({ rows }: { rows: WorkRecordDate[] }) {
  const [error, setError] = useState('');
  if (!rows.length) return null;
  return (
    <section className="space-y-2" aria-label="Record dates">
      <h3 className="text-xs font-medium text-fg-muted">Record dates</h3>
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border px-3 py-2 text-left text-xs hover:bg-bg-muted"
              onClick={() => void openWorkRecordDate(row).catch((cause) => setError(cause.message))}
            >
              <span className="min-w-0 flex-1 font-medium">
                {row.entityName} · {row.label}
              </span>
              <span className="text-fg-muted">
                {row.role === 'deadline'
                  ? 'Deadline'
                  : row.role === 'observation'
                    ? 'Recorded date'
                    : 'Milestone'}{' '}
                · {row.status === 'resolved' ? describeDate(row.value) : 'Needs clarification'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
