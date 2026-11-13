import {
  aminoAcidNameForLetter,
  codonExceptionDisplay,
  parseTranslExcept,
  residueAbbreviationFromNote,
  residueNameFromNote,
} from './transl-except';
import { codonDisplay } from './custom-genetic-codes';
import {
  resolveAnnotationGeneticCode,
  resolveGeneticCode,
  type GeneticCodeSpec,
  type RecordGeneticCodeBasis,
} from './genetic-codes';

export type CodonQualifiers = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface CodonContext {
  readonly codon: string;

  readonly at: number;

  readonly qualifiers?: CodonQualifiers;

  readonly qualifierValues?: Readonly<Record<string, readonly string[]>>;

  readonly recordCode?: GeneticCodeSpec;

  readonly recordBasis?: RecordGeneticCodeBasis;
}

type BoundCodonContext = Omit<CodonContext, 'codon' | 'at'>;

export interface CodonReading {
  readonly short: string;

  readonly full: string;
  readonly kind: 'amino-acid' | 'stop' | 'residue' | 'unassigned';

  readonly name: string;

  readonly fromException: boolean;

  readonly alsoTerminates: boolean;
}

export function codonPositionOf(
  first: number | undefined,
  second: number | undefined,
  third: number | undefined
): number {
  let lowest = Number.POSITIVE_INFINITY;
  if (first !== undefined && first < lowest) lowest = first;
  if (second !== undefined && second < lowest) lowest = second;
  if (third !== undefined && third < lowest) lowest = third;
  return Number.isFinite(lowest) ? lowest : 0;
}

function values(context: BoundCodonContext, key: string): readonly string[] {
  const raw = context.qualifierValues?.[key] ?? context.qualifiers?.[key];
  if (raw === undefined) return [];
  return typeof raw === 'string' ? [raw] : raw;
}

function nameFor(
  display: { readonly short: string; readonly full: string; readonly kind: string },
  residueName: string | null
): string {
  switch (display.kind) {
    case 'stop':
      return 'Stop';
    case 'unassigned':
      return 'Unassigned';
    case 'residue':
      return residueName ?? (display.full === 'X' ? 'Unnamed residue' : display.full);
    default:
      return aminoAcidNameForLetter(display.short) ?? display.full;
  }
}

export function readCodon(context: CodonContext): CodonReading {
  return readCodonWithContext(context.codon, context.at, context);
}

function readCodonWithContext(bases: string, at: number, context: BoundCodonContext): CodonReading {
  const codon = bases.toUpperCase();

  for (const raw of values(context, 'transl_except')) {
    const except = parseTranslExcept(raw);
    if (!except || except.location.start !== at) continue;

    const recodesAStop =
      except.aa.kind === 'other' ||
      (except.aa.kind === 'standard' && (except.aa.letter === 'U' || except.aa.letter === 'O'));
    if (
      recodesAStop &&
      !resolveGeneticCode(
        resolveAnnotationGeneticCode(context, context.recordCode, context.recordBasis)
      ).stopCodons.has(codon)
    ) {
      continue;
    }
    const note = values(context, 'note')[0];
    const display = codonExceptionDisplay({
      except,
      residueName: except.aa.kind === 'other' ? residueNameFromNote(note) : null,
      residueAbbreviation: except.aa.kind === 'other' ? residueAbbreviationFromNote(note) : null,
    });

    const underlying = resolveGeneticCode(
      resolveAnnotationGeneticCode(context, context.recordCode, context.recordBasis)
    );
    const suppressesAStop = display.kind !== 'stop' && underlying.stopCodons.has(codon);

    const declaredName =
      except.aa.kind === 'modified' ? except.aa.name : (residueNameFromNote(note) ?? null);
    return {
      ...display,
      name: nameFor(display, display.kind === 'residue' ? declaredName : null),
      fromException: true,
      alsoTerminates: suppressesAStop,
    };
  }

  const code = resolveGeneticCode(
    resolveAnnotationGeneticCode(context, context.recordCode, context.recordBasis)
  );
  const display = codonDisplay(codon, code);
  return {
    short: display.short,
    full: display.full,
    kind: display.kind,
    name: nameFor(display, null),
    fromException: false,

    alsoTerminates: code.dualFunctionCodons.has(codon),
  };
}

export function codonReaderFor(
  feature:
    | {
        readonly qualifiers?: CodonQualifiers;
        readonly qualifierValues?: Readonly<Record<string, readonly string[]>>;
      }
    | undefined,
  recordCode?: GeneticCodeSpec,
  recordBasis?: RecordGeneticCodeBasis
): (codon: string, at: number) => CodonReading {
  const base: BoundCodonContext = {
    ...(feature?.qualifiers ? { qualifiers: feature.qualifiers } : {}),
    ...(feature?.qualifierValues ? { qualifierValues: feature.qualifierValues } : {}),
    ...(recordCode !== undefined ? { recordCode } : {}),
    ...(recordBasis !== undefined ? { recordBasis } : {}),
  };
  return (codon, at) => readCodonWithContext(codon, at, base);
}
