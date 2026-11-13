export interface SpanCandidate {
  start: number;
  end: number;
  type?: string;
  displayName?: string;
  name?: string;
}

export interface GenomeSpanReport {
  genomeLength: number;
  fractionThreshold: number;
  spanning: Array<{
    type: string;
    name: string;
    start: number;
    end: number;
    span: number;
    fraction: number;
  }>;
  count: number;
}

export function featureArcLength(start: number, end: number, genomeLength: number): number {
  return end >= start ? end - start + 1 : genomeLength - start + end + 1;
}

export function reportGenomeSpanningFeatures(
  features: readonly SpanCandidate[],
  genomeLength: number,
  fractionThreshold = 0.5
): GenomeSpanReport {
  const spanning: GenomeSpanReport['spanning'] = [];
  if (genomeLength > 0) {
    for (const f of features) {
      if ((f.type ?? '').toLowerCase() === 'source') continue;
      const span = featureArcLength(f.start, f.end, genomeLength);
      const fraction = span / genomeLength;
      if (fraction > fractionThreshold) {
        spanning.push({
          type: f.type ?? 'unknown',
          name: f.displayName ?? f.name ?? '(unnamed)',
          start: f.start,
          end: f.end,
          span,
          fraction,
        });
      }
    }
  }
  spanning.sort((a, b) => b.span - a.span);
  return { genomeLength, fractionThreshold, spanning, count: spanning.length };
}

export const MAX_GENOME_SPANNING_FEATURES = 2;

export function formatGenomeSpanReport(report: GenomeSpanReport, label = 'features'): string {
  const head =
    `${report.count} ${label} span >${(report.fractionThreshold * 100).toFixed(0)}% of the ` +
    `${report.genomeLength.toLocaleString()} bp genome (max allowed ${MAX_GENOME_SPANNING_FEATURES}, excluding source).`;
  const rows = report.spanning
    .slice(0, 10)
    .map(
      (s) =>
        `  - ${s.type} "${s.name}" ${s.start}..${s.end} = ${s.span.toLocaleString()} bp (${(s.fraction * 100).toFixed(1)}%)`
    )
    .join('\n');
  return report.count > 0 ? `${head}\n${rows}` : head;
}
