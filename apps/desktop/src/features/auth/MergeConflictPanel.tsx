import { useState } from 'react';
import {
  workspaceSyncMergeConflictItemFingerprint,
  type WorkspaceSyncMergeChoice,
  type WorkspaceSyncMergeConflictItemView,
  type WorkspaceSyncMergeConflictView,
  type WorkspaceSyncMergeSequenceSummary,
} from '../../shared/workspace-sync-ipc';

const REASON_LABEL: Record<WorkspaceSyncMergeConflictItemView['reason'], string> = {
  'edit-edit': 'Both of you changed this',
  'rename-rename': 'Renamed differently on both sides',
  'delete-edit': 'Deleted on one side, changed on the other',
  'move-delete': 'Moved on one side, deleted on the other',
  'membership-remove-edit': 'Removed on one side, changed on the other',
  'identity-conflict': 'Created separately on both sides',
  'path-conflict': 'Two items want the same name',
};

const KIND_LABEL: Record<WorkspaceSyncMergeConflictItemView['kind'], string> = {
  file: 'file',
  'sequence-package': 'sequence',
  'notebook-package': 'notebook',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sideSummary(side: WorkspaceSyncMergeConflictItemView['local'], label: string): string {
  if (!side) return `${label}: deleted`;
  const files = side.fileCount === 1 ? '1 file' : `${side.fileCount} files`;
  return `${label}: ${side.path} · ${files} · ${formatBytes(side.sizeBytes)}`;
}

function SequenceComparison({ item }: { item: WorkspaceSyncMergeConflictItemView }) {
  const sides = [item.base, item.local, item.remote];
  const rows: {
    label: string;
    describe: (sequence: WorkspaceSyncMergeSequenceSummary) => string;
    fingerprint: (sequence: WorkspaceSyncMergeSequenceSummary) => string | undefined;
  }[] = [
    {
      label: 'Bases and topology',
      describe: (sequence) =>
        sequence.baseCount === undefined
          ? 'Inline inspection unavailable'
          : `${sequence.baseCount.toLocaleString()} bases · ${sequence.topology}`,
      fingerprint: (sequence) =>
        sequence.basesSha256 ? `${sequence.basesSha256}:${sequence.topology}` : undefined,
    },
    {
      label: 'Annotations',
      describe: (sequence) =>
        sequence.annotationCount === undefined
          ? 'Inline inspection unavailable'
          : `${sequence.annotationCount} annotations`,
      fingerprint: (sequence) => sequence.annotationsSha256,
    },
    {
      label: 'Package record',
      describe: (sequence) => `${sequence.buildRecordCount} build records`,
      fingerprint: (sequence) => sequence.metadataSha256,
    },
    {
      label: 'Attachments',
      describe: (sequence) => `${sequence.attachmentCount} attachments`,
      fingerprint: (sequence) => sequence.attachmentSha256,
    },
  ];
  return (
    <div className="space-y-1">
      <table className="w-full table-fixed text-left" data-testid="merge-sequence-comparison">
        <thead>
          <tr>
            <th scope="col">Comparison</th>
            <th scope="col">Before</th>
            <th scope="col">Yours</th>
            <th scope="col">Theirs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className="align-top font-normal">
                {row.label}
              </th>
              {sides.map((side, index) => {
                const sequence = side?.sequence;
                const baseline = item.base?.sequence;
                const fingerprint = sequence && row.fingerprint(sequence);
                const before = baseline && row.fingerprint(baseline);
                const change =
                  index === 0
                    ? null
                    : !side
                      ? null
                      : !item.base
                        ? 'Added since before'
                        : !fingerprint || !before
                          ? 'Comparison unavailable'
                          : fingerprint === before
                            ? 'Unchanged from before'
                            : 'Changed from before';
                return (
                  <td key={index} className="align-top px-1">
                    <span>
                      {!side
                        ? 'Not present'
                        : sequence
                          ? row.describe(sequence)
                          : 'Comparison unavailable'}
                    </span>
                    {change ? <span className="block">{change}</span> : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {sides.map((side, index) =>
        side?.sequence ? (
          <div key={index} className="break-words">
            <p>
              {['Before', 'Yours', 'Theirs'][index]}: {side.sequence.productPath}
            </p>
            {side.sequence.annotationNames?.length ? (
              <p>
                Annotations: {side.sequence.annotationNames.join('; ')}
                {(side.sequence.annotationCount ?? 0) > side.sequence.annotationNames.length
                  ? '; more in sequence file'
                  : ''}
              </p>
            ) : null}
            {side.sequence.attachments.length ? (
              <p>
                Attachments:{' '}
                {side.sequence.attachments
                  .map((attachment) => `${attachment.path} (${attachment.role})`)
                  .join('; ')}
                {side.sequence.attachmentCount > side.sequence.attachments.length
                  ? '; more in package'
                  : ''}
              </p>
            ) : null}
            {side.sequence.inspectionUnavailableReason ? (
              <p>{side.sequence.inspectionUnavailableReason}</p>
            ) : null}
          </div>
        ) : null
      )}
    </div>
  );
}

export interface MergeConflictPanelProps {
  conflict: WorkspaceSyncMergeConflictView;
  commandInFlight: boolean;
  onResolve: (choices: Record<string, WorkspaceSyncMergeChoice>) => void;
  onReconcileAgain: () => void;
}

export function MergeConflictPanel({
  conflict,
  commandInFlight,
  onResolve,
  onReconcileAgain,
}: MergeConflictPanelProps) {
  const reviewKey = JSON.stringify([
    conflict.conflictId,
    conflict.items.map(workspaceSyncMergeConflictItemFingerprint),
  ]);
  const [review, setReview] = useState<{
    key: string;
    choices: Record<string, WorkspaceSyncMergeChoice>;
  }>({ key: reviewKey, choices: {} });
  const choices = review.key === reviewKey ? review.choices : {};
  const choose = (resourceId: string, choice: WorkspaceSyncMergeChoice) => {
    setReview((current) => ({
      key: reviewKey,
      choices: {
        ...(current.key === reviewKey ? current.choices : {}),
        [resourceId]: choice,
      },
    }));
  };
  const [expanded, setExpanded] = useState<string | null>(null);
  const author = conflict.remoteAuthor ?? 'A collaborator';
  const version =
    conflict.remoteVersionNumber !== null ? ` (v${conflict.remoteVersionNumber})` : '';
  const allChosen = conflict.items.every((item) => choices[item.resourceId] !== undefined);

  return (
    <div
      data-testid="merge-conflict-panel"
      className="mt-2 rounded border border-error/30 bg-error/5 p-2"
    >
      <p className="text-[11px] leading-4 text-fg">
        {author} published changes{version} that need your review. Your changes are kept on this
        computer while you choose what to keep. Applying choices is followed by an upload; it does
        not mean another device has applied them.
      </p>
      <ul className="mt-2 space-y-2" data-testid="merge-conflict-items">
        {conflict.items.map((item) => {
          const choice = choices[item.resourceId];
          const isOpen = expanded === item.resourceId;
          return (
            <li
              key={`${item.resourceId}:${item.reason}`}
              data-testid="merge-conflict-item"
              className="rounded border border-border bg-bg p-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-[11px] text-fg hover:underline"
                  title={item.path}
                  onClick={() => setExpanded(isOpen ? null : item.resourceId)}
                >
                  {item.path}{' '}
                  <span className="text-fg-muted">
                    · {KIND_LABEL[item.kind]} · {REASON_LABEL[item.reason]}
                  </span>
                </button>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1">
                <button
                  type="button"
                  disabled={commandInFlight}
                  onClick={() => choose(item.resourceId, 'mine')}
                  aria-pressed={choice === 'mine'}
                  data-testid="merge-choice-mine"
                  className={`rounded border px-1 py-1 text-[10px] disabled:opacity-40 ${
                    choice === 'mine'
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-fg-muted hover:bg-bg-muted hover:text-fg'
                  }`}
                >
                  {item.local === null ? 'Keep my deletion' : 'Keep mine'}
                </button>
                <button
                  type="button"
                  disabled={commandInFlight}
                  onClick={() => choose(item.resourceId, 'theirs')}
                  aria-pressed={choice === 'theirs'}
                  data-testid="merge-choice-theirs"
                  className={`rounded border px-1 py-1 text-[10px] disabled:opacity-40 ${
                    choice === 'theirs'
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-fg-muted hover:bg-bg-muted hover:text-fg'
                  }`}
                >
                  {item.remote === null ? (
                    'Use their deletion'
                  ) : (
                    <>Use {author.split(' ')[0]}&apos;s</>
                  )}
                </button>
                <button
                  type="button"
                  disabled={commandInFlight || !item.canKeepBoth}
                  onClick={() => choose(item.resourceId, 'both')}
                  aria-pressed={choice === 'both'}
                  data-testid="merge-choice-both"
                  title={
                    item.canKeepBoth
                      ? 'Keep your copy and add theirs under a labeled name'
                      : 'Keeping both is only possible for plain files'
                  }
                  className={`rounded border px-1 py-1 text-[10px] disabled:opacity-40 ${
                    choice === 'both'
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-fg-muted hover:bg-bg-muted hover:text-fg'
                  }`}
                >
                  Keep both
                </button>
              </div>
              {isOpen ? (
                <div
                  className="mt-1 space-y-1 text-[10px] text-fg-muted"
                  data-testid="merge-conflict-detail"
                >
                  <p>{sideSummary(item.local, 'Yours')}</p>
                  <p>{sideSummary(item.remote, author)}</p>
                  {item.base ? (
                    <p>{sideSummary(item.base, 'Before')}</p>
                  ) : (
                    <p>Before: not present</p>
                  )}
                  {item.kind === 'sequence-package' ? (
                    <>
                      <SequenceComparison item={item} />
                      <p>
                        This choice keeps the whole sequence package: bases, annotations, metadata,
                        attachments, and its build records. They are not combined automatically.
                      </p>
                    </>
                  ) : null}
                  {item.local?.preview || item.remote?.preview ? (
                    <div className="grid grid-cols-2 gap-1">
                      <pre className="max-h-32 overflow-auto rounded border border-border bg-bg-subtle p-1 text-[9px] leading-3 text-fg">
                        {item.local?.preview ?? '(deleted)'}
                      </pre>
                      <pre className="max-h-32 overflow-auto rounded border border-border bg-bg-subtle p-1 text-[9px] leading-3 text-fg">
                        {item.remote?.preview ?? '(deleted)'}
                      </pre>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 grid grid-cols-2 gap-1">
        <button
          type="button"
          disabled={commandInFlight || !allChosen}
          onClick={() => onResolve(choices)}
          data-testid="merge-conflict-apply"
          className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {commandInFlight ? 'Applying…' : 'Apply choices'}
        </button>
        <button
          type="button"
          disabled={commandInFlight}
          onClick={onReconcileAgain}
          data-testid="merge-conflict-refresh"
          className="rounded border border-border px-1 py-1 text-center text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          Check again
        </button>
      </div>
    </div>
  );
}
