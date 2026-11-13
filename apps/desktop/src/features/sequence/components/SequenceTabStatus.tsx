import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { SequenceSkeleton } from './SequenceSkeleton';

function sequenceLoadMessage(error: string) {
  const diagnostic =
    /^(?:This file could not be read as a sequence\. )?Line (\d+): Invalid sequence character ("(?:\\.|[^"\\])*") at column (\d+)$/.exec(
      error
    );
  if (diagnostic) {
    try {
      const character: unknown = JSON.parse(diagnostic[2]);
      const line = Number(diagnostic[1]);
      const column = Number(diagnostic[3]);
      if (
        typeof character === 'string' &&
        Array.from(character).length === 1 &&
        Number.isSafeInteger(line) &&
        line > 0 &&
        Number.isSafeInteger(column) &&
        column > 0
      ) {
        return userMessageWithValues('sequence.invalidCharacter', {
          line: userMessageValue(line),
          column: userMessageValue(column),
          character: userMessageValue(JSON.stringify(character)),
        });
      }
    } catch {}
  }
  return toUserMessage(error, 'sequence.loadFailed');
}

export function SequenceTabStatus(props: {
  isLoading: boolean;
  error: string | null | undefined;
  sequence: unknown;
  displaySequence: unknown;
  parsedPlasmid: unknown;
  ready: () => JSX.Element;
}): JSX.Element {
  if (props.isLoading && (!props.sequence || !props.displaySequence || !props.parsedPlasmid)) {
    return (
      <div data-testid="sequence-loading" className="h-full">
        <SequenceSkeleton />
      </div>
    );
  }
  if (props.error) {
    return (
      <div
        data-testid="sequence-error"
        className="h-full flex items-center justify-center text-fg-muted"
      >
        <div className="text-center max-w-md">
          <div className="text-4xl mb-4">!</div>
          <div className="text-lg font-medium text-fg mb-2">Failed to load sequence</div>
          <div className="text-sm text-fg-muted">{sequenceLoadMessage(props.error)}</div>
        </div>
      </div>
    );
  }
  if (!props.sequence || !props.displaySequence || !props.parsedPlasmid) {
    return (
      <div
        data-testid="sequence-error"
        className="h-full flex items-center justify-center text-fg-muted"
      >
        Failed to load sequence
      </div>
    );
  }
  return props.ready();
}
