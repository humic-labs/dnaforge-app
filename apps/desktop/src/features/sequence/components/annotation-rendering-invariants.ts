import type { Feature, Genome } from '../../../../../../packages/core/genome-renderer/src/types';
import type { FilteredRendererFeatureResult } from './indexed-genome-legacy-adapter';

export interface InvariantViolation {
  invariant: 'I1' | 'I2' | 'I5';
  message: string;
  detail: Record<string, unknown>;
  timestamp: number;
}

export interface InvariantFilterStateFingerprint {
  transcriptDisplayMode: string;
  expandedGeneIdsKey: string;
}

export function checkAnnotationRenderingInvariants(
  rendered: Pick<Genome, 'features'>,
  filtered: FilteredRendererFeatureResult,
  filterState: InvariantFilterStateFingerprint
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const features = rendered.features ?? [];
  const ts = Date.now();

  if (features.length !== filtered.features.length) {
    violations.push({
      invariant: 'I1',
      message:
        `rendered.length (${features.length}) !== filtered.length (${filtered.features.length}). ` +
        `The rendered set is diverging from the upstream filter. ` +
        `See docs/plans/2026-06-04-annotation-rendering-architecture-smell.md`,
      detail: {
        renderedCount: features.length,
        filteredCount: filtered.features.length,
        delta: features.length - filtered.features.length,
        ...filterState,
      },
      timestamp: ts,
    });
  }

  const byLane = new Map<number, Feature[]>();
  for (const f of features) {
    if (f.type === 'CDS') continue;
    if (typeof f.lane !== 'number') continue;
    const list = byLane.get(f.lane);
    if (list) list.push(f);
    else byLane.set(f.lane, [f]);
  }
  for (const [lane, items] of byLane) {
    items.sort((a, b) => a.start - b.start);
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const curr = items[i];
      if (curr.start < prev.end) {
        violations.push({
          invariant: 'I2',
          message:
            `lane ${lane}: features overlap ` +
            `(${prev.displayName ?? prev.id ?? 'unnamed'} ${prev.start}-${prev.end} ` +
            `vs ${curr.displayName ?? curr.id ?? 'unnamed'} ${curr.start}-${curr.end}). ` +
            `Cross-tile lane reconciliation broken.`,
          detail: {
            lane,
            featureA: { id: prev.id, name: prev.displayName, start: prev.start, end: prev.end },
            featureB: { id: curr.id, name: curr.displayName, start: curr.start, end: curr.end },
            ...filterState,
          },
          timestamp: ts,
        });
        break;
      }
    }
  }

  let mrnaWithoutExonsCount = 0;
  let firstMrnaWithoutExons: Feature | undefined;
  const idCounts = new Map<number, number>();
  for (const f of features) {
    if ((f.type === 'mRNA' || f.type === 'transcript') && (!f.exons || f.exons.length === 0)) {
      mrnaWithoutExonsCount++;
      if (!firstMrnaWithoutExons) firstMrnaWithoutExons = f;
    }
    if (typeof f.id === 'number') {
      idCounts.set(f.id, (idCounts.get(f.id) ?? 0) + 1);
    }
  }
  if (mrnaWithoutExonsCount > 0 && firstMrnaWithoutExons) {
    violations.push({
      invariant: 'I5',
      message:
        `${mrnaWithoutExonsCount} mRNA/transcript feature(s) have no exons. ` +
        `Glyph geometry will be invalid.`,
      detail: {
        count: mrnaWithoutExonsCount,
        firstExample: {
          id: firstMrnaWithoutExons.id,
          name: firstMrnaWithoutExons.displayName,
          type: firstMrnaWithoutExons.type,
          start: firstMrnaWithoutExons.start,
          end: firstMrnaWithoutExons.end,
        },
        ...filterState,
      },
      timestamp: ts,
    });
  }
  const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1);
  if (duplicateIds.length > 0) {
    violations.push({
      invariant: 'I5',
      message:
        `${duplicateIds.length} feature id(s) appear more than once in the rendered set. ` +
        `Duplicate features will overdraw.`,
      detail: {
        duplicateCount: duplicateIds.length,
        firstFew: duplicateIds.slice(0, 3).map(([id, n]) => ({ id, occurrences: n })),
        ...filterState,
      },
      timestamp: ts,
    });
  }

  return violations;
}

export function reportInvariantViolations(violations: InvariantViolation[]): void {
  for (const v of violations) {
    console.error(`[ invariant ${v.invariant}] ${v.message}`, v.detail);
  }
}
