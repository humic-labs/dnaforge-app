import type { StructureCandidate, StructureCandidateGroup } from '../types/structure-drawer';

export type CandidateSourceCounts = Record<'all' | StructureCandidateGroup, number>;

export const SOURCE_STYLES: Record<
  StructureCandidateGroup,
  {
    countDot: string;
    stripe: string;
    badge: string;
    filterActive: string;
    filterIdle: string;
    link: string;
  }
> = {
  rcsb: {
    countDot: 'bg-blue-500',
    stripe: 'bg-blue-500',
    badge: 'border-blue-500/30 bg-blue-500/10 text-blue-700',
    filterActive: 'border-blue-500/40 bg-blue-500/10 text-blue-700',
    filterIdle: 'border-border text-fg-muted hover:border-blue-500/30 hover:bg-blue-500/5',
    link: 'hover:bg-blue-500/10 hover:text-blue-700',
  },
  alphafold: {
    countDot: 'bg-emerald-500',
    stripe: 'bg-emerald-500',
    badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
    filterActive: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
    filterIdle: 'border-border text-fg-muted hover:border-emerald-500/30 hover:bg-emerald-500/5',
    link: 'hover:bg-emerald-500/10 hover:text-emerald-700',
  },
};

export function countCandidatesBySource(candidates: StructureCandidate[]): CandidateSourceCounts {
  const counts: CandidateSourceCounts = { all: candidates.length, rcsb: 0, alphafold: 0 };
  for (const candidate of candidates) {
    counts[candidate.group]++;
  }
  return counts;
}

export function SourceCountDots({ counts }: { counts: CandidateSourceCounts }) {
  const sources = (
    [
      { group: 'rcsb', label: 'PDB' },
      { group: 'alphafold', label: 'AlphaFold' },
    ] satisfies Array<{ group: StructureCandidateGroup; label: string }>
  ).filter(({ group }) => counts[group] > 0);

  if (sources.length === 0) return null;

  return (
    <span
      data-testid="structure-source-counts"
      className="inline-flex min-w-0 items-center gap-2 text-[11px] text-fg-muted"
    >
      {sources.map(({ group, label }) => (
        <span key={group} className="inline-flex items-center gap-1 whitespace-nowrap">
          <span className={`h-1.5 w-1.5 rounded-full ${SOURCE_STYLES[group].countDot}`} />
          {counts[group]} {label}
        </span>
      ))}
    </span>
  );
}

export function SourceBadge({ group }: { group: StructureCandidateGroup }) {
  return (
    <span
      data-testid={`structure-candidate-source-${group}`}
      className={`inline-flex h-4 items-center gap-1 rounded-sm border px-1 text-[9px] font-medium leading-none ${SOURCE_STYLES[group].badge}`}
    >
      <span className={`h-1 w-1 rounded-full ${SOURCE_STYLES[group].countDot}`} />
      {group === 'rcsb' ? 'PDB' : 'AlphaFold'}
    </span>
  );
}

export function ExternalLinkIcon() {
  return (
    <svg
      data-icon="external-link"
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

export function candidateTitle(candidate: StructureCandidate): string {
  return (
    candidate.metadata.title ??
    candidate.metadata.entityDescriptions?.[0] ??
    candidate.metadata.description ??
    (candidate.provider === 'pdb' ? 'Experimental structure' : 'Predicted structure')
  );
}

export function sourceLinkForCandidate(candidate: StructureCandidate): { href: string } | null {
  if (candidate.metadata.sourceUrl) return { href: candidate.metadata.sourceUrl };
  if (candidate.structure.kind === 'pdb') {
    return { href: `https://www.rcsb.org/structure/${candidate.structure.pdbId}` };
  }
  if (candidate.structure.kind === 'uniprot') {
    return { href: `https://alphafold.ebi.ac.uk/entry/${candidate.structure.accession}` };
  }
  if (candidate.structure.kind === 'url') {
    return { href: candidate.structure.url };
  }
  return null;
}
