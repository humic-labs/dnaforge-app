import type { FastaKindReadAuthority } from '../shared/fasta-kind';

export function FastaKindReadStatus({
  authority,
}: {
  authority: Exclude<FastaKindReadAuthority, { status: 'declared' }>;
}) {
  return (
    <div
      className="mb-3 rounded border border-border p-3 text-sm text-fg-muted"
      data-testid="fasta-kind-status"
      data-status={authority.status}
    >
      <p>
        {authority.status === 'needs-classification'
          ? 'This FASTA needs classification. Its historical view is read-only.'
          : 'This legacy FASTA view is read-only until its scientific kind is declared.'}
      </p>
      <p>Ask the agent to classify this FASTA as DNA or protein in a writable project.</p>
    </div>
  );
}
