import { type UserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import {
  GENETIC_CODES,
  geneticCodeLabel,
  getGeneticCode,
  isCodingFeature,
  parseTranslTableQualifier,
  resolveSequenceGeneticCode,
  STANDARD_GENETIC_CODE_ID,
  type AnnotatedSequence,
  type Annotation,
  type GeneticCodeSpec,
  type SequenceGeneticCodeResolution,
} from '@waypoint/sequence-utils';
import type { ReactNode } from 'react';

export type GeneticCodeChoice = string;

export interface GeneticCodeOption {
  value: GeneticCodeChoice;
  label: string;
  labelNode: ReactNode;
  detail?: UserMessage;
  emphasis?: boolean;
  warn?: boolean;
  testId: string;
}

export function declaredCodeCounts(annotations: readonly Annotation[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const annotation of annotations) {
    if (!isCodingFeature(annotation)) continue;
    const declared = parseTranslTableQualifier(annotation);
    if (declared === null) continue;
    counts.set(declared, (counts.get(declared) ?? 0) + 1);
  }
  return counts;
}

function features(count: number): string {
  return count === 1 ? '1 feature' : `${count} features`;
}

export function fileDeclaredGeneticCode(sequence: AnnotatedSequence): number {
  const { code } = resolveSequenceGeneticCode({ annotations: sequence.annotations ?? [] });
  return typeof code === 'number' ? code : STANDARD_GENETIC_CODE_ID;
}

function choiceFor(spec: GeneticCodeSpec): GeneticCodeChoice {
  return `${spec}`;
}

export function effectiveGeneticCodeChoice(sequence: AnnotatedSequence): GeneticCodeChoice {
  return choiceFor(resolveSequenceGeneticCode(sequence).code);
}

export function geneticCodeOverrideFor(
  choice: GeneticCodeChoice,
  sequence: AnnotatedSequence
): GeneticCodeSpec | null {
  const chosen = Number.parseInt(choice, 10);
  if (!Number.isInteger(chosen)) return null;
  return chosen === fileDeclaredGeneticCode(sequence) ? null : chosen;
}

function row(id: number | null, name: string, emphasis: boolean): ReactNode {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {}
      <span
        className={`w-5 shrink-0 text-right tabular-nums ${emphasis ? 'text-accent' : 'text-fg-muted'}`}
      >
        {id ?? ''}
      </span>
      {}
      <span className="min-w-0 max-w-[18rem] truncate" title={name}>
        {name}
      </span>
    </span>
  );
}

export function geneticCodeOptions(
  sequence: AnnotatedSequence,
  resolution: SequenceGeneticCodeResolution
): GeneticCodeOption[] {
  const counts = declaredCodeCounts(sequence.annotations ?? []);
  const fileCode = fileDeclaredGeneticCode(sequence);

  const published = (id: number): GeneticCodeOption => {
    const name = getGeneticCode(id)?.name ?? `Genetic code ${id}`;
    const count = counts.get(id);
    const isFileCode = id === fileCode;
    const detail = count
      ? userMessageWithValues('copy.declared-by-value', {
          value0: userMessageValue(features(count)),
        })
      : undefined;
    return {
      value: `${id}`,
      label: geneticCodeLabel(id),
      labelNode: row(id, name, isFileCode),
      ...(detail ? { detail } : {}),
      ...(isFileCode ? { emphasis: true } : {}),
      ...(isFileCode && resolution.needsUserChoice ? { warn: true } : {}),
      testId: `genetic-code-option-${id}`,
    };
  };

  const rest = GENETIC_CODES.filter((code) => code.id !== fileCode).map((code) =>
    published(code.id)
  );
  return [published(fileCode), ...rest];
}

export function geneticCodeTriggerLabel(choice: GeneticCodeChoice): string {
  return geneticCodeLabel(Number.parseInt(choice, 10) || STANDARD_GENETIC_CODE_ID);
}

export interface GeneticCodeStatus {
  text: string;
  warn: boolean;
}

export function geneticCodeStatus(
  resolution: SequenceGeneticCodeResolution,
  annotations: readonly Annotation[]
): GeneticCodeStatus | null {
  const counts = declaredCodeCounts(annotations);

  if (resolution.basis === 'chosen') {
    const declaring = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const unaffected =
      declaring === 0
        ? ''
        : declaring === 1
          ? ' 1 feature declares its own code and is unaffected.'
          : ` ${declaring} features declare their own code and are unaffected.`;

    return {
      text: declaring > 0 ? `Set by you.${unaffected}` : 'Set by you, and saved in this file.',
      warn: false,
    };
  }

  if (resolution.basis === 'declared-mixed') {
    return {
      text: `Mixed file: features declare ${resolution.declaredCodes.join(' and ')}. Each is read by its own.`,
      warn: false,
    };
  }

  if (resolution.basis === 'declared' && typeof resolution.code === 'number') {
    const count = counts.get(resolution.code) ?? 0;
    return { text: `Declared by ${features(count)} in this file.`, warn: false };
  }

  if (resolution.unreadableGeneticCode !== undefined) {
    return {
      text: `This file names a custom genetic code DNAForge cannot read (${resolution.unreadableGeneticCode}). Pick one.`,
      warn: true,
    };
  }

  if (resolution.needsUserChoice) {
    return {
      text: `Source says "${resolution.organelle}" but no code is declared, and organelles use several. Pick one.`,
      warn: true,
    };
  }

  return null;
}
