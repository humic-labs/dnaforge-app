import type { Annotation, AnnotatedSequence } from '@waypoint/sequence-utils';
import type { LimsGenotypeEdit, LimsParsedGenotype } from '../lims';

type GenotypeTarget = Extract<LimsGenotypeEdit, { target: unknown }>['target'];

export type ResolvedGenotypeEdit = {
  edit: LimsGenotypeEdit;
  start: number;
  end: number;
  replacement: string;
  label: string;
};

export interface ApplyGenotypeEditsResult {
  sequence: string;
  applied: ResolvedGenotypeEdit[];
}

const BASE_PATTERN = '[ACGTURYSWKMBDHVN]+';

export function parseLimsGenotype(genotype: string): LimsParsedGenotype {
  const edits: LimsGenotypeEdit[] = [];
  const errors: string[] = [];
  const tokens = genotype
    .split(/[\n;]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const edit = parseGenotypeToken(token);
    if (edit) {
      edits.push(edit);
    } else {
      errors.push(`Unsupported genotype token: ${token}`);
    }
  }

  return { genotype, edits, errors };
}

export function applyLimsGenotypeEdits(
  parent: AnnotatedSequence,
  edits: readonly LimsGenotypeEdit[],
  markerSequences: Record<string, string> = {}
): ApplyGenotypeEditsResult {
  const resolved = edits.map((edit) => resolveEdit(parent, edit, markerSequences));
  const sorted = [...resolved].sort((a, b) => b.start - a.start || b.end - a.end);

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current.end >= previous.start && current.start <= previous.end) {
      throw new Error(
        `Genotype edits overlap: ${current.edit.token} overlaps ${previous.edit.token}`
      );
    }
  }

  let sequence = parent.sequence.toUpperCase();
  for (const edit of sorted) {
    sequence = sequence.slice(0, edit.start - 1) + edit.replacement + sequence.slice(edit.end);
  }

  return { sequence, applied: sorted.reverse() };
}

export function findAnnotationForGenotypeTarget(
  sequence: AnnotatedSequence,
  targetName: string
): Annotation | null {
  const target = normalizeFeatureName(targetName);
  const matches = sequence.annotations.filter((annotation) =>
    annotationNames(annotation).some((name) => {
      const normalized = normalizeFeatureName(name);
      return normalized === target || normalized.startsWith(target) || normalized.includes(target);
    })
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => annotationRank(a) - annotationRank(b) || spanLength(a) - spanLength(b));
  return matches[0];
}

function parseGenotypeToken(token: string): LimsGenotypeEdit | null {
  const marker = token.match(/^([A-Za-z0-9_.-]+)\s*(?:Δ|∆|del|delta)\s*::\s*([A-Za-z0-9_.-]+)$/i);
  if (marker) {
    return {
      kind: 'marker_replacement',
      token,
      target: { type: 'feature', name: marker[1] },
      markerName: marker[2],
    };
  }

  const featureDeletion = token.match(/^([A-Za-z0-9_.-]+)\s*(?:Δ|∆|del|delta)$/i);
  if (featureDeletion) {
    return {
      kind: 'deletion',
      token,
      target: { type: 'feature', name: featureDeletion[1] },
    };
  }

  const rangeDeletion =
    token.match(/^(?:del(?:etion)?\s*)?(\d+)\s*(?:\.\.|-|_)\s*(\d+)\s*(?:del|Δ|∆)?$/i) ??
    token.match(/^del(?:etion)?\s*[:@(]\s*(\d+)\s*(?:\.\.|-|_)\s*(\d+)\s*\)?$/i);
  if (rangeDeletion) {
    const start = Number(rangeDeletion[1]);
    const end = Number(rangeDeletion[2]);
    return {
      kind: 'deletion',
      token,
      target: { type: 'range', start: Math.min(start, end), end: Math.max(start, end) },
    };
  }

  const insertion =
    token.match(
      new RegExp(`^(?:ins|insert)(?:@|:|\\s+)(\\d+)\\s*[:=]\\s*(${BASE_PATTERN})$`, 'i')
    ) ?? token.match(new RegExp(`^(\\d+)\\s*ins\\s*(${BASE_PATTERN})$`, 'i'));
  if (insertion) {
    return {
      kind: 'insertion',
      token,
      position: Number(insertion[1]),
      bases: insertion[2].toUpperCase(),
    };
  }

  const genomicSubstitution = token.match(
    new RegExp(`^(?:g\\.)?(\\d+)\\s*([ACGTURYSWKMBDHVN])\\s*>\\s*([ACGTURYSWKMBDHVN])$`, 'i')
  );
  if (genomicSubstitution) {
    return {
      kind: 'substitution',
      token,
      position: Number(genomicSubstitution[1]),
      refBase: genomicSubstitution[2].toUpperCase(),
      altBase: genomicSubstitution[3].toUpperCase(),
    };
  }

  const legacySubstitution = token.match(
    new RegExp(`^([ACGTURYSWKMBDHVN])(\\d+)([ACGTURYSWKMBDHVN])$`, 'i')
  );
  if (legacySubstitution) {
    return {
      kind: 'substitution',
      token,
      position: Number(legacySubstitution[2]),
      refBase: legacySubstitution[1].toUpperCase(),
      altBase: legacySubstitution[3].toUpperCase(),
    };
  }

  return null;
}

function resolveEdit(
  parent: AnnotatedSequence,
  edit: LimsGenotypeEdit,
  markerSequences: Record<string, string>
): ResolvedGenotypeEdit {
  switch (edit.kind) {
    case 'deletion': {
      const range = resolveTarget(parent, edit.target, edit.token);
      return { edit, ...range, replacement: '', label: edit.token };
    }
    case 'marker_replacement': {
      const marker =
        markerSequences[edit.markerName] ?? markerSequences[edit.markerName.toLowerCase()];
      if (!marker) {
        throw new Error(`Marker sequence not found for ${edit.markerName}`);
      }
      const range = resolveTarget(parent, edit.target, edit.token);
      return { edit, ...range, replacement: marker.toUpperCase(), label: edit.token };
    }
    case 'insertion': {
      if (!Number.isInteger(edit.position) || edit.position < 0 || edit.position > parent.length) {
        throw new Error(`Insertion ${edit.token} is outside parent length ${parent.length}`);
      }
      return {
        edit,
        start: edit.position + 1,
        end: edit.position,
        replacement: edit.bases.toUpperCase(),
        label: edit.token,
      };
    }
    case 'substitution': {
      if (!Number.isInteger(edit.position) || edit.position < 1 || edit.position > parent.length) {
        throw new Error(`Substitution ${edit.token} is outside parent length ${parent.length}`);
      }
      const observed = parent.sequence[edit.position - 1]?.toUpperCase();
      if (edit.refBase && observed !== edit.refBase) {
        throw new Error(
          `Substitution ${edit.token} expected ${edit.refBase} at ${edit.position}, found ${observed}`
        );
      }
      return {
        edit,
        start: edit.position,
        end: edit.position,
        replacement: edit.altBase.toUpperCase(),
        label: edit.token,
      };
    }
  }
}

function resolveTarget(
  parent: AnnotatedSequence,
  target: GenotypeTarget,
  token: string
): { start: number; end: number } {
  if (target.type === 'range') {
    assertRange(target.start, target.end, parent.length, token);
    return { start: target.start, end: target.end };
  }

  const annotation = findAnnotationForGenotypeTarget(parent, target.name);
  if (!annotation) {
    throw new Error(`Could not find feature ${target.name} for genotype token ${token}`);
  }
  if (annotation.start > annotation.end) {
    throw new Error(`Origin-spanning feature edits are not supported yet: ${token}`);
  }
  assertRange(annotation.start, annotation.end, parent.length, token);
  return { start: annotation.start, end: annotation.end };
}

function assertRange(start: number, end: number, length: number, token: string): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > length
  ) {
    throw new Error(`Genotype token ${token} targets invalid range ${start}..${end}`);
  }
}

function annotationNames(annotation: Annotation): string[] {
  const values = [
    annotation.name,
    annotation.type,
    ...Object.values(annotation.qualifiers ?? {}).flat(),
  ];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function annotationRank(annotation: Annotation): number {
  const type = annotation.type.toLowerCase();
  if (type === 'gene') return 0;
  if (type === 'cds') return 1;
  return 2;
}

function spanLength(annotation: Annotation): number {
  return Math.abs(annotation.end - annotation.start);
}

function normalizeFeatureName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
