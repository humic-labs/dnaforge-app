import type { DnaSequenceTopology } from '../../shared/lims';
import type { RegisterableOpenSequenceKind } from './register-open-sequence';

export type RegisterableOpenSequenceSourceType = 'file_dna_sequence';

export interface OpenSequenceRegistrationContext {
  sourceType?: RegisterableOpenSequenceSourceType;
  topology?: DnaSequenceTopology;
  length?: number;
}

export interface OpenSequenceRegistrationKindOption {
  kind: RegisterableOpenSequenceKind;
  label: string;
  title: string;
  disabled?: boolean;
  disabledReason?: string;
}

interface OpenSequenceRegistrationKindRule {
  kind: RegisterableOpenSequenceKind;
  label: string;
  title: (context: OpenSequenceRegistrationContext, lengthLabel: string) => string;
}

const OPEN_SEQUENCE_KIND_RULES: readonly OpenSequenceRegistrationKindRule[] = [
  {
    kind: 'sequence',
    label: 'DNA sequence',
    title: (_context, lengthLabel) => `Register as a DNA sequence${lengthLabel}`,
  },
];

export function getOpenSequenceRegistrationKindOptions(
  context: OpenSequenceRegistrationContext
): OpenSequenceRegistrationKindOption[] {
  const normalizedContext: OpenSequenceRegistrationContext = {
    sourceType: context.sourceType ?? 'file_dna_sequence',
    topology: context.topology,
    length: context.length,
  };
  const lengthLabel = normalizedContext.length
    ? ` (${new Intl.NumberFormat().format(normalizedContext.length)} bp)`
    : '';

  return OPEN_SEQUENCE_KIND_RULES.map((rule) => ({
    kind: rule.kind,
    label: rule.label,
    title: rule.title(normalizedContext, lengthLabel),
    disabled: false,
  }));
}

export function isOpenSequenceRegistrationKindCompatible(
  kind: RegisterableOpenSequenceKind,
  context: OpenSequenceRegistrationContext
): boolean {
  const option = getOpenSequenceRegistrationKindOptions(context).find((item) => item.kind === kind);
  return Boolean(option && !option.disabled);
}
