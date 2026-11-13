import { useEffect, useId, useRef, useState } from 'react';
import { CopyIcon, CheckIcon } from '../icons';

interface CopyButtonProps {
  text: string;
  size?: number;
  testId?: string;
  showLabel?: boolean;
  label?: string;
}

export function CopyButton({
  text,
  size = 14,
  testId,
  showLabel = false,
  label = 'Copy',
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorId = useId();

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = async () => {
    if (state === 'copying') return;
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setState('copying');
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      resetTimer.current = setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        aria-disabled={state === 'copying'}
        aria-label={label}
        aria-busy={state === 'copying'}
        aria-describedby={state === 'error' ? errorId : undefined}
        className="p-1 rounded hover:bg-bg-muted text-fg-muted hover:text-fg transition-colors flex items-center gap-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 aria-disabled:cursor-wait"
        title={label}
        data-testid={testId}
      >
        {state === 'copied' ? (
          <span
            data-testid={testId ? `${testId.replace('button', 'success')}` : undefined}
            className="flex items-center gap-1"
          >
            <CheckIcon size={size} />
            {showLabel && <span>Copied!</span>}
          </span>
        ) : (
          <>
            <CopyIcon size={size} />
            {showLabel && <span>Copy</span>}
          </>
        )}
      </button>
      {state === 'copied' && (
        <span role="status" className="sr-only">
          Copied!
        </span>
      )}
      {state === 'error' && (
        <span id={errorId} role="alert" className="text-xs text-error">
          Could not copy. Try again.
        </span>
      )}
    </>
  );
}
