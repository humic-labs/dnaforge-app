import { userMessageWithValues, userMessageValue, type UserMessage } from '@waypoint/user-messages';
import {
  geneticCodeLabel,
  geneticCodesAssignIdenticalAminoAcids,
  isCustomGeneticCodeSpec,
  isKnownGeneticCodeId,
  validateCustomGeneticCode,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import type { Annotation } from '@waypoint/sequence-utils';
import type { EditorPasteFragment } from '@waypoint/workspace-editor';
import type { RichSequenceFragment } from './rich-sequence-clipboard';

export type GeneticCodePastePlanKind = 'silent' | 'notice' | 'conflict';

export interface GeneticCodePastePlan {
  readonly kind: GeneticCodePastePlanKind;
  readonly sourceGeneticCode?: GeneticCodeSpec;
  readonly destinationGeneticCode: GeneticCodeSpec;
  readonly preservable: boolean;
  readonly conflictingFeatureNames: readonly string[];
  readonly message: UserMessage | '';
}

const SILENT = (destinationGeneticCode: GeneticCodeSpec): GeneticCodePastePlan => ({
  kind: 'silent',
  destinationGeneticCode,
  preservable: false,
  conflictingFeatureNames: [],
  message: '',
});

function fragmentSourceGeneticCode(fragment: RichSequenceFragment): GeneticCodeSpec | undefined {
  const code = fragment.sourceGeneticCode;
  if (isKnownGeneticCodeId(code)) return code;
  if (isCustomGeneticCodeSpec(code) && validateCustomGeneticCode(code).length === 0) return code;
  return undefined;
}

const CODING_TYPES = new Set(['CDS', 'mat_peptide', 'sig_peptide', 'transit_peptide']);

function fragmentCodingAnnotations(fragment: RichSequenceFragment) {
  return fragment.annotations.filter((annotation) => CODING_TYPES.has(annotation.type));
}

function annotationGeneticCode(
  annotation: { qualifiers?: Record<string, string> },
  fallback: GeneticCodeSpec | undefined
): GeneticCodeSpec | undefined {
  const raw = annotation.qualifiers?.transl_table;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (isKnownGeneticCodeId(parsed)) return parsed;
  }
  return fallback;
}

export function planGeneticCodePaste(
  fragment: RichSequenceFragment,
  destinationGeneticCode: GeneticCodeSpec
): GeneticCodePastePlan {
  const sourceGeneticCode = fragmentSourceGeneticCode(fragment);

  const coding = fragmentCodingAnnotations(fragment);
  const conflicting = coding.filter((annotation) => {
    const code = annotationGeneticCode(annotation, sourceGeneticCode);
    return (
      code !== undefined && !geneticCodesAssignIdenticalAminoAcids(code, destinationGeneticCode)
    );
  });

  if (conflicting.length > 0) {
    const featureCode =
      annotationGeneticCode(conflicting[0], sourceGeneticCode) ?? sourceGeneticCode;
    const preservable = typeof featureCode === 'number';
    const count = conflicting.length;
    return {
      kind: 'conflict',
      ...(featureCode !== undefined ? { sourceGeneticCode: featureCode } : {}),
      destinationGeneticCode,
      preservable,
      conflictingFeatureNames: conflicting.map((annotation) => annotation.name),
      message: preservable
        ? userMessageWithValues('clipboard.geneticCodePreserved', {
            features: userMessageValue(describeFeatureCount(count)),
            source: userMessageValue(geneticCodeLabel(featureCode)),
            destination: userMessageValue(geneticCodeLabel(destinationGeneticCode)),
            ownership: userMessageValue(count === 1 ? 'feature keeps its' : 'features keep their'),
          })
        : userMessageWithValues('clipboard.geneticCodeCustom', {
            features: userMessageValue(describeFeatureCount(count)),
            source: userMessageValue(geneticCodeLabel(featureCode)),
            destination: userMessageValue(geneticCodeLabel(destinationGeneticCode)),
            subject: userMessageValue(count === 1 ? 'it is' : 'they are'),
          }),
    };
  }

  if (sourceGeneticCode === undefined) return SILENT(destinationGeneticCode);
  if (geneticCodesAssignIdenticalAminoAcids(sourceGeneticCode, destinationGeneticCode)) {
    return SILENT(destinationGeneticCode);
  }
  if (!fragment.sourceHadCodingContext) return SILENT(destinationGeneticCode);

  return {
    kind: 'notice',
    sourceGeneticCode,
    destinationGeneticCode,
    preservable: false,
    conflictingFeatureNames: [],
    message: userMessageWithValues('clipboard.geneticCodeNotice', {
      source: userMessageValue(geneticCodeLabel(sourceGeneticCode)),
      destination: userMessageValue(geneticCodeLabel(destinationGeneticCode)),
    }),
  };
}

function describeFeatureCount(count: number): string {
  return count === 1 ? '1 coding feature' : `${count} coding features`;
}

export function reReadFragmentUnderDestinationCode(
  fragment: EditorPasteFragment
): EditorPasteFragment {
  return { ...fragment, annotations: fragment.annotations.map(dropDeclaredTable) };
}

function dropDeclaredTable(annotation: Annotation): Annotation {
  if (!annotation.qualifiers?.transl_table) return annotation;
  const { transl_table: _dropped, ...rest } = annotation.qualifiers;
  const next: Annotation = { ...annotation };
  if (Object.keys(rest).length > 0) next.qualifiers = rest;
  else delete next.qualifiers;
  return next;
}

export function preserveInsertedGeneticCodes(
  fragment: EditorPasteFragment,
  plan: GeneticCodePastePlan
): EditorPasteFragment {
  if (plan.kind !== 'conflict' || !plan.preservable || typeof plan.sourceGeneticCode !== 'number') {
    return fragment;
  }
  const named = new Set(plan.conflictingFeatureNames);
  const code = String(plan.sourceGeneticCode);
  let changed = false;

  const annotations = fragment.annotations.map((annotation) => {
    if (!named.has(annotation.name) || !CODING_TYPES.has(annotation.type)) return annotation;
    if (annotation.qualifiers?.transl_table !== undefined) return annotation;
    changed = true;
    return {
      ...annotation,
      qualifiers: { ...(annotation.qualifiers ?? {}), transl_table: [code] },
    };
  });

  return changed ? { ...fragment, annotations } : fragment;
}

export function reReadInsertedAnnotations(
  annotations: readonly Annotation[],
  plan: GeneticCodePastePlan,
  insertedRange: { start: number; end: number } | null
): Annotation[] | null {
  if (plan.kind !== 'conflict') return null;
  const named = new Set(plan.conflictingFeatureNames);
  let changed = false;

  const next = annotations.map((annotation) => {
    if (!named.has(annotation.name)) return annotation;
    if (!CODING_TYPES.has(annotation.type)) return annotation;
    if (insertedRange) {
      const startsInside = annotation.start - 1 >= insertedRange.start;
      const endsInside = annotation.end <= insertedRange.end;
      if (!startsInside || !endsInside) return annotation;
    }
    const declared = annotation.qualifiers?.transl_table?.[0];
    if (declared === undefined) return annotation;
    const parsed = Number.parseInt(declared, 10);
    if (!isKnownGeneticCodeId(parsed)) return annotation;
    if (geneticCodesAssignIdenticalAminoAcids(parsed, plan.destinationGeneticCode)) {
      return annotation;
    }
    changed = true;
    return dropDeclaredTable(annotation);
  });

  return changed ? next : null;
}
