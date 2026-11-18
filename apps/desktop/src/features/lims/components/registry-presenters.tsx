import { iconForEntityKind } from '../../../components/icons';
import { RegistryOpenButton } from './registry/RegistryOpenButton';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../../shared/entity-schema';
import {
  formatLimsRelationshipType,
  type InlineDnaSequenceRef,
  type LimsEntity,
  type LimsEntityHistoryEntry,
  type LimsFieldChange,
  type LimsRegistryLinkedEntitySummary,
  type LimsRegistryOpenTarget,
  type LimsRegistrationStatus,
  type LimsRegistrySummary,
} from '../../../shared/lims';

const REGISTRY_UPDATED_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function registryLinkEvidenceText(summary: LimsRegistrySummary): string {
  const linkedNames = summary.linkSummary.notable.map((entry) => entry.label);
  if (summary.evidenceSummary) {
    return [summary.evidenceSummary.confidenceLabel, ...linkedNames].join(' · ');
  }
  if (linkedNames.length > 0) return linkedNames.join(', ');
  const linkCount = summary.linkSummary.incomingCount + summary.linkSummary.outgoingCount;
  return linkCount > 0 ? `${linkCount} linked` : 'No links';
}

export function formatRegistryUpdatedAt(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 'Unknown';
  return REGISTRY_UPDATED_FORMATTER.format(new Date(updatedAt));
}

export function registrySequenceText(summary: LimsRegistrySummary): string {
  const targetKind = summary.representation.openTarget?.kind;
  if (targetKind === 'managed_sequence' || targetKind === 'sequence_file') return 'Open sequence';
  return summary.sequenceSummary?.inlineBases ?? '-';
}

function historyDotClass(eventType: LimsEntityHistoryEntry['eventType']): string {
  switch (eventType) {
    case 'entity_registered':
    case 'entity_restored':
      return 'bg-success';
    case 'entity_updated':
      return 'bg-accent';
    case 'entity_reverted':
      return 'bg-warning';
    case 'entity_archived':
    case 'entity_tombstoned':
      return 'bg-error';
    case 'entity_registry_id_assigned':
      return 'bg-fg-muted';
    default:
      return 'bg-fg-muted';
  }
}

function HistoryChange({ change }: { change: LimsFieldChange }) {
  if (change.description)
    return <span className="block text-xs leading-4 text-fg-muted">{change.description}</span>;
  const before = change.kind === 'added' ? undefined : change.before;
  const after = change.kind === 'removed' ? undefined : change.after;
  return (
    <div
      data-history-comparison
      className="flex flex-wrap items-start gap-x-2 text-xs leading-4 text-fg-muted"
    >
      <span data-history-field className="min-w-0 text-fg [overflow-wrap:anywhere]">
        {change.label}:
      </span>
      <span className="grid max-w-full grid-cols-[minmax(0,max-content)_auto_minmax(0,max-content)] items-start gap-x-2">
        <span
          data-history-value="before"
          className={`min-w-0 whitespace-pre-wrap text-[color:color-mix(in_srgb,hsl(var(--color-error))_75%,hsl(var(--color-fg)))] [overflow-wrap:anywhere] ${before ? 'line-through' : 'italic'}`}
        >
          <span className="sr-only">Previous value: </span>
          {before || 'Empty'}
        </span>
        <span data-history-arrow aria-hidden="true">
          →
        </span>
        <span
          data-history-value="after"
          className={`min-w-0 whitespace-pre-wrap text-[color:color-mix(in_srgb,hsl(var(--color-success))_75%,hsl(var(--color-fg)))] [overflow-wrap:anywhere] ${after ? '' : 'italic'}`}
        >
          <span className="sr-only">New value: </span>
          {after || 'Empty'}
        </span>
      </span>
    </div>
  );
}

export function RegistryHistoryTimeline({
  entries,
  loading,
  error,
}: {
  entries: LimsEntityHistoryEntry[] | null;
  schema: ProjectableEntitySchemaRevisionSnapshot;
  loading: boolean;
  error: boolean;
}) {
  const visibleEntries = entries?.map((entry) => ({ entry, changes: entry.changes }));
  return (
    <div data-testid="lims-registry-history" data-layout="flow">
      <div className="mb-1.5 text-[11px] font-semibold uppercase text-fg-subtle">
        Version history
      </div>
      {error ? (
        <div data-testid="lims-registry-history-error" className="text-xs text-error">
          Failed to load history
        </div>
      ) : loading && !entries ? (
        <div className="text-xs text-fg-subtle">Loading…</div>
      ) : !visibleEntries || visibleEntries.length === 0 ? (
        <div className="text-xs text-fg-subtle">No history</div>
      ) : (
        <ol className="text-xs">
          {visibleEntries.map(({ entry, changes }, index) => {
            const isFirst = index === 0;
            const isLast = index === visibleEntries.length - 1;
            return (
              <li
                key={entry.eventSeq}
                data-testid={`lims-history-entry-${entry.eventSeq}`}
                className="relative flex gap-2.5"
              >
                <div className="relative w-3 flex-shrink-0">
                  {!isFirst && (
                    <span className="absolute left-1/2 top-0 h-[9px] w-px -translate-x-1/2 bg-border" />
                  )}
                  {!isLast && (
                    <span className="absolute bottom-0 left-1/2 top-[9px] w-px -translate-x-1/2 bg-border" />
                  )}
                  <span
                    className={`absolute left-1/2 top-1 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-2 ring-bg ${historyDotClass(
                      entry.eventType
                    )}`}
                  />
                </div>
                <div className="min-w-0 flex-1 pb-3">
                  <div
                    data-history-heading
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                  >
                    <span className="font-medium text-fg">{entry.label}</span>
                    <time
                      dateTime={new Date(entry.at).toISOString()}
                      className="flex-shrink-0 text-[11px] text-fg-subtle"
                    >
                      {REGISTRY_UPDATED_FORMATTER.format(new Date(entry.at))}
                    </time>
                  </div>
                  {changes.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {changes.map((change, idx) => (
                        <li
                          key={`${change.field}-${idx}`}
                          data-testid={`lims-history-change-${entry.eventSeq}-${idx}`}
                          className="text-[11px] text-fg-muted"
                        >
                          <HistoryChange change={change} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function RegistryProvenance({ summary }: { summary: LimsRegistrySummary }) {
  const sequenceTarget = sequenceOpenTarget(summary);
  const rows = [
    ['Format', summary.sequenceSummary?.sourceFormat ?? sequenceTarget?.sequence.sourceFormat],
    ['Hash', summary.sequenceSummary?.contentHash ?? sequenceTarget?.sequence.contentHash],
    [
      'Size',
      typeof sequenceTarget?.sequence.sizeBytes === 'number'
        ? `${sequenceTarget.sequence.sizeBytes.toLocaleString()} bytes`
        : undefined,
    ],
    [
      'Modified',
      typeof sequenceTarget?.sequence.modifiedAt === 'number'
        ? formatRegistryUpdatedAt(sequenceTarget.sequence.modifiedAt)
        : undefined,
    ],
    ['Source', sequenceTarget?.source],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);

  if (rows.length === 0) return null;
  return (
    <dl data-testid="lims-registry-preview-provenance" className="mt-2 space-y-1 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
          <dt className="text-fg-subtle">{label}</dt>
          <dd className="min-w-0 truncate font-mono text-[11px] text-fg-muted" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RegistryInlineSequence({
  label,
  sequence,
}: {
  label: string;
  sequence: InlineDnaSequenceRef | null;
}) {
  if (!sequence) return null;

  return (
    <div
      data-testid="lims-registry-preview-inline-sequence"
      className="rounded border border-border bg-bg-subtle px-3 py-2"
    >
      <div className="text-[11px] font-semibold uppercase text-fg-subtle">{label}</div>
      <div className="mt-1 max-h-28 overflow-auto break-all font-mono text-xs leading-5 text-fg">
        {sequence.bases}
      </div>
      {sequence.contentHash && (
        <dl className="mt-2 grid grid-cols-[44px_minmax(0,1fr)] gap-2 text-xs">
          <dt className="text-fg-subtle">Hash</dt>
          <dd className="min-w-0 truncate font-mono text-[11px] text-fg-muted">
            {sequence.contentHash}
          </dd>
        </dl>
      )}
    </div>
  );
}

export function inlineSequenceForEntity(entity: LimsEntity): InlineDnaSequenceRef | null {
  const value = entity.fields.sequence;
  if (!value || typeof value !== 'object') return null;
  const sequence = value as Partial<InlineDnaSequenceRef>;
  if (sequence.mode !== 'inline' || typeof sequence.bases !== 'string' || !sequence.bases) {
    return null;
  }
  return {
    mode: 'inline',
    bases: sequence.bases,
    topology: 'linear',
    length: typeof sequence.length === 'number' ? sequence.length : sequence.bases.length,
    contentHash: sequence.contentHash,
  };
}

export function RegistryLinkedRecordRow({
  entry,
  onPreview,
  onOpen,
}: {
  entry: LimsRegistryLinkedEntitySummary;
  onPreview(): void;
  onOpen(): void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs">
      <button
        type="button"
        data-testid={`lims-registry-link-preview-${entry.entity.id}`}
        aria-label={`Show details for ${entry.entity.name}`}
        onClick={onPreview}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span>{iconForLimsKind(entry.entity.kind)}</span>
        <div className="min-w-0">
          <div className="truncate text-fg">{entry.entity.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase text-fg-subtle">
            <span>{formatLimsRelationshipType(entry.link.type)}</span>
            <span>{entry.summary.representation.label}</span>
          </div>
        </div>
      </button>
      <RegistryOpenButton
        summary={entry.summary}
        onOpen={onOpen}
        testId={`lims-registry-link-open-${entry.entity.id}`}
      />
    </div>
  );
}

function sequenceOpenTarget(
  summary: LimsRegistrySummary
): Extract<LimsRegistryOpenTarget, { kind: 'sequence_file' }> | null {
  const target = summary.representation.openTarget;
  return target?.kind === 'sequence_file' ? target : null;
}

export function StatusPill({
  children,
  title,
  status,
}: {
  children: string;
  title?: string;
  status?: LimsRegistrationStatus;
}) {
  if (status === 'tracked') return null;

  const tone =
    status === 'unresolved'
      ? 'border-warning/40 bg-warning/10 text-warning'
      : 'border-border bg-bg-subtle text-fg-subtle';
  return (
    <span
      title={title}
      data-registration-status={status}
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${tone}`}
    >
      {children}
    </span>
  );
}

export function iconForLimsKind(kind: string, className = 'h-3.5 w-3.5 flex-shrink-0') {
  return iconForEntityKind(kind, className);
}

export function registryTypeLabel(kind: string): string {
  if (kind === 'genome') return 'assembly';
  if (kind === 'track-view') return 'track view';
  if (kind === 'molecular-document') return 'molecular views';
  return kind;
}

export function singularKindLabel(kind: string): string {
  switch (kind) {
    case 'sequence':
      return 'DNA sequence';
    case 'oligo':
      return 'DNA oligo';
    case 'rna_oligo':
      return 'RNA oligo';
    case 'plasmid':
      return 'plasmid';
    case 'genome':
      return 'assembly';
    case 'chromosome':
      return 'chromosome';
    case 'strain':
      return 'strain';
    case 'organism':
      return 'organism';
    case 'protein':
      return 'protein';
    case 'dna_sequence':
      return 'DNA sequence';
    case 'rna_sequence':
      return 'RNA sequence';
    case 'track-view':
      return 'track view';
    case 'molecular-document':
      return 'molecular document';
    case 'guide_rna':
      return 'guide RNA';
    case 'allele':
      return 'allele';
    case 'locus':
      return 'locus';
    case 'part':
      return 'part';
    case 'fragment':
      return 'fragment';
    case 'marker':
      return 'marker';
    case 'external_ref':
      return 'external reference';
    default:
      return kind;
  }
}
