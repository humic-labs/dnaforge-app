import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';
import { useMemo, useState } from 'react';
import { TOAST_REVIEW_ENTRIES, TOAST_TIMING_POLICIES } from '../stores/toast-definitions';
import { useToastStore } from '../stores/toast-store';

export function ToastReviewPanel() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('post-update/default');
  const [seen, setSeen] = useState(new Set<string>());
  const [lastAction, setLastAction] = useState<string | null>(null);
  const entries = useMemo(
    () =>
      TOAST_REVIEW_ENTRIES.filter((entry) =>
        `${entry.id} ${entry.category} ${entry.message} ${entry.duration === 0 ? 'persistent' : 'timed'}`
          .toLowerCase()
          .includes(query.toLowerCase())
      ),
    [query]
  );
  const entry = entries.find((e) => e.id === selected) ?? entries[0];
  const clear = () => {
    const store = useToastStore.getState();
    for (const toast of store.toasts) if (toast.preview) store.removeToast(toast.id);
  };
  const show = (id = entry?.id) => {
    const next = TOAST_REVIEW_ENTRIES.find((e) => e.id === id);
    if (!next) return;
    clear();
    setSelected(next.id);
    setLastAction(null);
    useToastStore.getState().addRichToast({
      definition: next.definition,
      variant: next.variant,
      preview: true,
      actions: next.actionLabels.map((label) => ({ label, onClick: () => setLastAction(label) })),
    });
    setSeen((current) => new Set([...current, next.id]));
  };
  const next = () => {
    const index = entries.findIndex((e) => e.id === entry?.id);
    show(entries[(index + 1) % entries.length]?.id);
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs"
      data-testid="toast-review-panel"
    >
      <p className="text-fg-muted">
        Preview every notification with its real timing and dismissal rules. Actions are
        demonstrations; they do not perform the underlying operation.
      </p>
      <input
        type="search"
        aria-label="Filter toast notifications"
        placeholder="Filter notifications…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="rounded border border-border bg-bg-subtle p-2"
      />
      <div data-testid="toast-review-progress" className="text-fg-muted">
        {seen.size} of {TOAST_REVIEW_ENTRIES.length} previews triggered · {entries.length} match
      </div>
      <span className="inline-block min-w-0">
        <MenuNativeSelect
          density="compact"
          aria-label="Toast notification"
          data-testid="toast-review-select"
          value={entry?.id ?? ''}
          onChange={(event) => setSelected(event.target.value)}
        >
          {entries.map((item) => (
            <option key={item.id} value={item.id}>
              {seen.has(item.id) ? '✓ ' : ''}
              {item.category} · {toUserMessage(item.message, 'operation.failed').slice(0, 90)}
              {item.message.length > 90 ? '…' : ''}
              {item.variant === 'default' ? '' : ` (${item.variant})`} ·{' '}
              {item.duration ? `${item.duration / 1000}s` : 'persistent'}
            </option>
          ))}
        </MenuNativeSelect>
      </span>
      {entry ? (
        <>
          <p
            className="rounded border border-border bg-bg-subtle p-2"
            data-testid="toast-review-message"
          >
            {toUserMessage(entry.message, 'operation.failed')}
          </p>
          <dl
            className="grid grid-cols-[7rem_1fr] gap-1 text-fg-muted"
            data-testid="toast-review-policy"
          >
            <dt>Timing policy</dt>
            <dd title={TOAST_TIMING_POLICIES[entry.timing].description}>
              {TOAST_TIMING_POLICIES[entry.timing].label}
            </dd>
            <dt>Disappearance</dt>
            <dd>
              {entry.duration
                ? `${entry.duration / 1000} seconds; pauses on hover or focus`
                : 'Persistent until dismissed or replaced'}
            </dd>
            <dt>Countdown</dt>
            <dd>{entry.duration ? 'Remaining seconds' : 'None'}</dd>
            <dt>Close button</dt>
            <dd>{entry.closeButton ? 'Available' : 'Hidden'}</dd>
            <dt>Surface click</dt>
            <dd>{entry.dismissOn === 'surface' ? 'Dismisses' : 'Does not dismiss'}</dd>
            <dt>Actions</dt>
            <dd>
              {entry.actionLabels.join(', ') || 'None'}
              {entry.actionLabels.length && entry.actionDismisses ? ' · dismisses' : ''}
            </dd>
            <dt>Replacement</dt>
            <dd>
              {entry.group
                ? `Replaces the previous ${entry.group} notification`
                : 'Stacks independently'}
            </dd>
            <dt>Duplicates</dt>
            <dd>
              {entry.oncePerKey
                ? entry.keyScope === 'group'
                  ? 'Unchanged status stays quiet; a new transition can notify again'
                  : 'Shown once per version or event identity'
                : 'No additional duplicate suppression'}
            </dd>
            {entry.clearsGroups?.length ? (
              <>
                <dt>Also clears</dt>
                <dd>{entry.clearsGroups.join(', ')}</dd>
              </>
            ) : null}
            <dt>Feature</dt>
            <dd>{entry.category}</dd>
          </dl>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="toast-review-show"
              onClick={() => show()}
              className="flex-1 rounded bg-accent p-2 font-medium text-white"
            >
              Show notification
            </button>
            <button
              type="button"
              data-testid="toast-review-next"
              onClick={next}
              className="rounded border border-border p-2"
            >
              Next
            </button>
            <button type="button" onClick={clear} className="rounded border border-border p-2">
              Clear preview
            </button>
          </div>
        </>
      ) : (
        <p>No notifications match.</p>
      )}
      {lastAction ? (
        <p role="status" data-testid="toast-review-action">
          Demonstrated “{lastAction}”.
        </p>
      ) : null}
    </section>
  );
}
