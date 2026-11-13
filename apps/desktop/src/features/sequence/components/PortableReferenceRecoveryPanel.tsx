import { toUserMessage } from '@waypoint/user-messages';
import type { PreparedReferenceAssemblyEntryV1 } from '../../../shared/reference-assets-ipc';

export interface PortableReferenceRecoveryPanelProps {
  readonly viewName: string;
  readonly assemblyId: string;
  readonly candidates: ReadonlyArray<PreparedReferenceAssemblyEntryV1>;
  readonly busy: boolean;
  readonly progressLabel: string | null;
  readonly error: string | null;
  readonly onAddReference: () => void;
  readonly onUseCandidate: (entry: PreparedReferenceAssemblyEntryV1) => void;
  readonly onCancel: () => void;
}

export function PortableReferenceRecoveryPanel({
  viewName,
  assemblyId,
  candidates,
  busy,
  progressLabel,
  error,
  onAddReference,
  onUseCandidate,
  onCancel,
}: PortableReferenceRecoveryPanelProps) {
  return (
    <section
      aria-labelledby="portable-reference-recovery-heading"
      data-testid="portable-reference-recovery"
      className="flex-shrink-0 space-y-3 border-b border-border bg-bg-subtle/40 px-5 py-4"
    >
      <h3 id="portable-reference-recovery-heading" className="text-sm font-semibold text-fg">
        Restore {viewName}
      </h3>
      <p className="text-xs text-fg-muted">
        This view was saved against library reference{' '}
        <span className="font-mono text-fg">{assemblyId}</span>, which is not in this library. Add
        that reference from its FASTA file, annotated folder, or NCBI Datasets package
        {candidates.length > 0 ? ', or use a library reference with the same chromosome table' : ''}
        . DNAForge checks the chromosome table before it opens the view.
      </p>
      {candidates.length > 0 ? (
        <ul aria-label="References with the same chromosome table" className="space-y-1.5">
          {candidates.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border bg-bg px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-fg">{entry.name}</div>
                <div className="truncate text-fg-muted">
                  {entry.organism} · same chromosome table, a different prepared copy
                </div>
              </div>
              <button
                type="button"
                data-testid={`portable-reference-recovery-use-${entry.id}`}
                disabled={busy}
                onClick={() => onUseCandidate(entry)}
                className="rounded border border-border px-2 py-1 font-medium text-fg hover:border-emerald-500 disabled:opacity-50"
              >
                Use {entry.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {busy ? (
        <p role="status" aria-live="polite" className="text-xs text-fg-muted">
          {progressLabel ?? 'Preparing the reference…'}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          data-testid="portable-reference-recovery-error"
          className="text-xs text-red-700 dark:text-red-300"
        >
          {toUserMessage(error, 'tracks.loadFailed')}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="portable-reference-recovery-add"
          disabled={busy}
          onClick={onAddReference}
          className="h-8 rounded bg-accent px-3 text-xs font-semibold text-white hover:brightness-95 disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? 'Preparing reference…' : 'Add reference file…'}
        </button>
        <button
          type="button"
          data-testid="portable-reference-recovery-cancel"
          disabled={busy}
          onClick={onCancel}
          className="h-8 rounded border border-border px-3 text-xs font-medium text-fg hover:bg-bg-subtle disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
