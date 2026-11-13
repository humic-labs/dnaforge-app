import { renderUserMessage, toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { annotationTypeBadgeStyle } from '@waypoint/genome-renderer/pure';

import type { IndexedGenomeVariantSourceState } from '../../../shared/indexed-genome';
import type {
  AffectedMutationAnnotation,
  MutationAnnotationImpact,
  MutationAnnotationImpactState,
} from '../mutation-annotation-impact';
import type { VariantSummary } from '../variant-client';

interface MutationNavigatorDrawerProps {
  readonly open: boolean;
  readonly source: IndexedGenomeVariantSourceState | null;
  readonly variants: ReadonlyArray<VariantSummary>;
  readonly annotationImpacts: ReadonlyMap<string, MutationAnnotationImpactState>;
  readonly selectedVariantId: string | null;
  readonly nextCursor: string | null;
  readonly phase: 'idle' | 'preparing' | 'loading' | 'loading-more';
  readonly error: UserMessage | null;
  readonly trimmed: boolean;
  readonly themeMode: 'light' | 'dark';
  readonly onClose: () => void;
  readonly onChooseSource: () => void;
  readonly onLoadMore: () => void;
  readonly onSelectVariant: (variant: VariantSummary) => void;
}

export function MutationNavigatorDrawer({
  open,
  source,
  variants,
  annotationImpacts,
  selectedVariantId,
  nextCursor,
  phase,
  error,
  trimmed,
  themeMode,
  onClose,
  onChooseSource,
  onLoadMore,
  onSelectVariant,
}: MutationNavigatorDrawerProps) {
  if (!open) return null;
  const busy = phase !== 'idle';

  return (
    <aside
      data-testid="mutation-navigator"
      aria-label="Mutations"
      className="flex min-h-0 w-[460px] min-w-0 shrink flex-col border-l border-border bg-bg"
      style={{ width: 460 }}
    >
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">Mutations</h2>
          <button
            type="button"
            aria-label="Close mutations"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-lg leading-none text-fg-muted hover:bg-bg-subtle"
          >
            ×
          </button>
        </div>
        {source ? (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-fg-muted" title={source.sourcePath}>
              {source.label}
            </span>
            <button
              type="button"
              onClick={onChooseSource}
              disabled={busy}
              className="shrink-0 text-xs text-accent hover:underline disabled:opacity-50"
            >
              Change…
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="m-3 shrink-0 rounded border border-red-400/50 bg-red-500/10 px-2.5 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {renderUserMessage(error)}
        </div>
      ) : null}

      {!source ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-sm text-fg">Choose a called-variant file to browse mutations.</p>
          <p className="mt-2 text-xs leading-5 text-fg-muted">
            DNAForge reads indexed VCF or BCF calls. Your BAM and reference stay in place.
          </p>
          <button
            type="button"
            onClick={onChooseSource}
            disabled={busy}
            className="mt-4 rounded border border-border px-3 py-2 text-sm font-medium text-fg hover:border-accent hover:bg-bg-subtle disabled:cursor-wait disabled:opacity-50"
          >
            {phase === 'preparing' ? 'Preparing calls…' : 'Choose VCF or BCF…'}
          </button>
        </div>
      ) : (
        <>
          {busy && phase !== 'loading-more' ? (
            <div role="status" className="px-3 py-3 text-xs text-fg-muted">
              {phase === 'preparing' ? 'Checking and indexing calls…' : 'Loading mutations…'}
            </div>
          ) : null}
          {!busy && variants.length === 0 && !error ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-fg-muted">
              No called variants were found on the reference chromosomes.
            </div>
          ) : null}
          {variants.length > 0 ? (
            <ol className="min-h-0 flex-1 overflow-y-auto" aria-label="Mutation list">
              {variants.map((variant) => {
                const genotype = firstGenotype(variant);
                const selected = variant.id === selectedVariantId;
                const annotationImpact = annotationImpacts.get(variant.id);
                const coordinate = `${variant.chrom}:${variant.position.toLocaleString()}`;
                const allele = `${variant.ref} → ${variant.alts.join(', ')}`;
                return (
                  <li key={variant.id} className="border-b border-border/70">
                    <button
                      type="button"
                      aria-label={`${coordinate} ${allele}`}
                      aria-pressed={selected}
                      onClick={() => onSelectVariant(variant)}
                      className={`w-full px-3 py-2.5 text-left hover:bg-bg-subtle ${
                        selected ? 'bg-accent/10' : ''
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-xs font-medium text-fg">{coordinate}</span>
                        <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
                          {variant.variantClass}
                        </span>
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-fg">{allele}</div>
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
                        {genotype ? <span>{genotype}</span> : null}
                        {variant.quality !== null ? (
                          <span>{`QUAL ${formatQuality(variant.quality)}`}</span>
                        ) : null}
                        {variant.filters.length > 0 ? (
                          <span>{variant.filters.join(', ')}</span>
                        ) : null}
                      </div>
                      <MutationImpact
                        state={annotationImpact}
                        selected={selected}
                        themeMode={themeMode}
                      />
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {trimmed ? (
            <p className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-fg-muted">
              Showing the latest 1,000 loaded mutations.
            </p>
          ) : null}
          {nextCursor ? (
            <div className="shrink-0 border-t border-border p-2">
              <button
                type="button"
                aria-label="Load more mutations"
                onClick={onLoadMore}
                disabled={busy}
                className="w-full rounded border border-border px-3 py-1.5 text-xs text-fg hover:bg-bg-subtle disabled:cursor-wait disabled:opacity-50"
              >
                {phase === 'loading-more' ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

function MutationImpact({
  state,
  selected,
  themeMode,
}: {
  readonly state: MutationAnnotationImpactState | undefined;
  readonly selected: boolean;
  readonly themeMode: 'light' | 'dark';
}) {
  if (!state || state.status === 'loading') {
    return <div className="mt-1.5 text-[11px] text-fg-subtle">Checking reference annotations…</div>;
  }
  if (state.status === 'unavailable') {
    return (
      <div
        className="mt-1.5 text-[11px] text-fg-subtle"
        title={toUserMessage(state.message, 'tracks.loadFailed')}
      >
        Reference annotation context unavailable
      </div>
    );
  }

  const { impact } = state;
  if (!impact.overlapsAnnotation) {
    return (
      <div className="mt-1.5 text-[11px] text-fg-subtle">No overlapping reference annotation</div>
    );
  }
  const compactNames = compactAnnotationNames(impact);

  return (
    <div data-testid={`mutation-impact-${impact.variantId}`} className="mt-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
        {impact.codingEffect ? (
          <span className="rounded px-1.5 py-0.5 font-medium" style={badgeStyle('CDS', themeMode)}>
            {impact.codingEffect.label}
          </span>
        ) : (
          <span className="font-medium text-fg-muted">Overlaps annotation</span>
        )}
        {compactNames.map((name) => (
          <span key={name} className="max-w-[180px] truncate text-fg-muted" title={name}>
            {name}
          </span>
        ))}
      </div>
      {selected ? <MutationImpactDetails impact={impact} themeMode={themeMode} /> : null}
    </div>
  );
}

function MutationImpactDetails({
  impact,
  themeMode,
}: {
  readonly impact: MutationAnnotationImpact;
  readonly themeMode: 'light' | 'dark';
}) {
  return (
    <div className="mt-2 rounded border border-border/80 bg-bg-subtle/60 px-2.5 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
        Affected annotations
      </div>
      <div className="mt-1.5 space-y-1.5">
        {impact.annotations.map((annotation) => (
          <AffectedAnnotationRow
            key={[annotation.type, annotation.label, annotation.start, annotation.end].join(':')}
            annotation={annotation}
            themeMode={themeMode}
          />
        ))}
      </div>
      {impact.hiddenAnnotationCount > 0 ? (
        <div className="mt-1.5 text-[10px] text-fg-subtle">
          {`+${impact.hiddenAnnotationCount} additional overlapping annotations`}
        </div>
      ) : null}
      {impact.truncated ? (
        <div className="mt-1.5 text-[10px] text-fg-subtle">
          Very large variant: annotation context is limited to its endpoints.
        </div>
      ) : null}
    </div>
  );
}

function AffectedAnnotationRow({
  annotation,
  themeMode,
}: {
  readonly annotation: AffectedMutationAnnotation;
  readonly themeMode: 'light' | 'dark';
}) {
  return (
    <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)_max-content] items-center gap-2">
      <span
        className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
        style={badgeStyle(annotation.type, themeMode)}
      >
        {annotation.type}
      </span>
      <span className="truncate text-[11px] text-fg" title={annotation.label}>
        {annotation.label}
      </span>
      <span className="font-mono text-[10px] text-fg-subtle">
        {`${(annotation.start + 1).toLocaleString()}–${annotation.end.toLocaleString()}`}
      </span>
    </div>
  );
}

function compactAnnotationNames(impact: MutationAnnotationImpact): string[] {
  const preferred = impact.annotations.filter(({ type }) =>
    ['gene', 'mrna', 'transcript', 'lnc_rna'].includes(type.toLowerCase())
  );
  const source = preferred.length > 0 ? preferred : impact.annotations;
  return [...new Set(source.map(({ label }) => label))].slice(0, 2);
}

function badgeStyle(type: string, themeMode: 'light' | 'dark') {
  const style = annotationTypeBadgeStyle(type, themeMode);
  return { background: style.background, color: style.color };
}

function firstGenotype(variant: VariantSummary): string | null {
  const first = Object.entries(variant.genotypes)[0];
  return first ? `${first[0]} ${first[1]}` : null;
}

function formatQuality(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
