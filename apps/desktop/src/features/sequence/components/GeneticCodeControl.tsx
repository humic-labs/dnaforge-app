import { toUserMessage } from '@waypoint/user-messages';
import { useMemo } from 'react';
import { resolveSequenceGeneticCode, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { MetadataPicker } from '../../../shared/components/entity-metadata/MetadataPicker';
import { ExclamationCircleIcon } from '../../../components/icons';
import {
  effectiveGeneticCodeChoice,
  geneticCodeOptions,
  geneticCodeStatus,
  geneticCodeTriggerLabel,
  type GeneticCodeChoice,
} from '../genetic-code-field-model';

export interface GeneticCodeControlProps {
  sequence: AnnotatedSequence;

  value?: GeneticCodeChoice;

  onChange?: (choice: GeneticCodeChoice) => void;
  testId?: string;

  showStatusTitle?: boolean;
  defaultOpen?: boolean;
  onSelect?: () => void;
  menuAttributes?: Record<`data-${string}`, string | undefined>;
}

export const currentGeneticCodeChoice = effectiveGeneticCodeChoice;

export function GeneticCodeControl({
  sequence,
  value,
  onChange,
  testId = 'genetic-code-control',
  showStatusTitle = true,
  defaultOpen,
  onSelect,
  menuAttributes,
}: GeneticCodeControlProps) {
  const resolution = useMemo(() => resolveSequenceGeneticCode(sequence), [sequence]);
  const current = currentGeneticCodeChoice(sequence);
  const choice = value ?? current;
  const options = useMemo(() => geneticCodeOptions(sequence, resolution), [sequence, resolution]);
  const status = geneticCodeStatus(resolution, sequence.annotations ?? []);

  return (
    <span
      className="block w-full min-w-0"
      data-genetic-code={current}
      data-genetic-code-basis={resolution.basis}
      data-genetic-code-needs-choice={resolution.needsUserChoice ? 'true' : 'false'}
    >
      <MetadataPicker
        value={choice}
        options={options.map((option) => ({
          value: option.value,
          label: option.labelNode,
          selectedLabel: (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{geneticCodeTriggerLabel(choice)}</span>
              {resolution.needsUserChoice ? (
                <span data-testid={`${testId}-warn`}>
                  <ExclamationCircleIcon className="h-3 w-3 text-warning" />
                </span>
              ) : null}
            </span>
          ),
          description: option.detail
            ? toUserMessage(option.detail, 'tracks.loadFailed')
            : undefined,
          searchText: option.label,
          testId: option.testId,
        }))}
        onValueChange={(next) => onChange?.(next)}
        onSelect={onSelect}
        disabled={!onChange}
        title={showStatusTitle ? status?.text : undefined}
        ariaLabel="Genetic code"
        testId={testId}
        defaultOpen={defaultOpen}
        menuAttributes={menuAttributes}
        searchLabel="Search genetic codes"
      />
    </span>
  );
}

export function GeneticCodeStatusLine({
  sequence,
  testId = 'genetic-code-status',
}: {
  sequence: AnnotatedSequence;
  testId?: string;
}) {
  const resolution = useMemo(() => resolveSequenceGeneticCode(sequence), [sequence]);
  const status = geneticCodeStatus(resolution, sequence.annotations ?? []);
  if (!status) return null;
  return (
    <p
      data-testid={testId}
      data-warn={status.warn ? 'true' : 'false'}
      className={`mt-1 text-[11px] leading-snug ${status.warn ? 'text-warning' : 'text-fg-subtle'}`}
    >
      {status.text}
    </p>
  );
}
