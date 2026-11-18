import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import type {
  LimsRecordRelationshipTarget,
  LimsRecordRelationshipTargetPage,
} from '../../../../shared/lims';
import { queryLimsRecordRelationshipTargets } from '../../operations';
import { RegistryRecordValue } from './RegistryRecordFields';

type SearchState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: LimsRecordRelationshipTargetPage }
  | { kind: 'error'; message: string };

export function RegistryRelationshipInput({
  entityId,
  label,
  value,
  onChange,
}: {
  entityId: string;
  label: string;
  value: unknown;
  onChange: (target: LimsRecordRelationshipTarget | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SearchState>({ kind: 'loading' });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    const timer = setTimeout(() => {
      void queryLimsRecordRelationshipTargets({ entityId, search, offset }).then(
        (page) => {
          if (!cancelled) setState({ kind: 'ready', page });
        },
        (cause) => {
          if (!cancelled)
            setState({
              kind: 'error',
              message: toUserMessage(cause, 'failure.could-not-load-records-try-again'),
            });
        }
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, entityId, search, offset, attempt]);
  const close = () => {
    setOpen(false);
    setSearch('');
    setOffset(0);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2 rounded border border-border bg-bg px-2 py-1.5">
        <div className="min-w-0 break-words">
          <RegistryRecordValue type="record_relationship" value={value} />
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            aria-label={`Change ${label}`}
            className="text-accent hover:underline"
            onClick={() => setOpen(!open)}
          >
            Change
          </button>
          {value !== null && value !== undefined && (
            <button
              type="button"
              aria-label={`Clear ${label}`}
              className="text-fg-muted hover:underline"
              onClick={() => {
                onChange(null);
                close();
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="space-y-2 rounded border border-border bg-bg p-2">
          <label className="block">
            <span className="sr-only">Search {label} targets</span>
            <input
              autoFocus
              value={search}
              placeholder="Search name or Registry ID"
              className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-accent focus:outline-none"
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
          </label>
          <p className="text-[11px] text-fg-subtle">Records in this project</p>
          {state.kind === 'loading' && (
            <p role="status" className="text-fg-muted">
              Loading records…
            </p>
          )}
          {state.kind === 'error' && (
            <div>
              <p role="alert" className="text-error">
                {toUserMessage(state.message, 'account.failed')}
              </p>
              <button
                type="button"
                className="mt-1 text-accent"
                onClick={() => setAttempt(attempt + 1)}
              >
                Try again
              </button>
            </div>
          )}
          {state.kind === 'ready' && (
            <>
              {!state.page.targets.length && (
                <p className="text-fg-muted">No matching records in this project.</p>
              )}
              <ul
                aria-label={`${label} targets`}
                className="max-h-48 overflow-y-auto divide-y divide-border"
              >
                {state.page.targets.map((target) => (
                  <li key={target.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left wp-interactive "
                      onClick={() => {
                        onChange(target);
                        close();
                      }}
                    >
                      <span className="min-w-0 truncate" title={target.name}>
                        {target.name}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-fg-subtle">
                        {target.registryId ?? target.id}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {(offset > 0 || state.page.hasMore) && (
                <div className="flex justify-between">
                  <button
                    type="button"
                    disabled={offset === 0}
                    className="text-accent disabled:opacity-40"
                    onClick={() => setOffset(Math.max(0, offset - 50))}
                  >
                    Previous records
                  </button>
                  <button
                    type="button"
                    disabled={!state.page.hasMore}
                    className="text-accent disabled:opacity-40"
                    onClick={() => setOffset(offset + 50)}
                  >
                    Next records
                  </button>
                </div>
              )}
            </>
          )}
          <button type="button" className="text-fg-muted hover:underline" onClick={close}>
            Cancel selection
          </button>
        </div>
      )}
    </div>
  );
}
