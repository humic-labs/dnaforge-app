import { useMemo, useState } from 'react';
import type { ProteinRunIndexEntry } from './run-index';
import { diffRecordedPrompt } from './prompt-diff';

function fullPrompt(entry: ProteinRunIndexEntry): string | null {
  if (!entry.sentPrompt) return null;
  return [
    entry.sentPrompt,
    entry.continuationPrompt && `\nContinuation prompt:\n${entry.continuationPrompt}`,
    entry.supplementalInstructions &&
      `\nSeparate agent instructions:\n${entry.supplementalInstructions}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function PromptDifference({
  before,
  after,
  guidance,
}: {
  before: ProteinRunIndexEntry;
  after: ProteinRunIndexEntry;
  guidance: (instructions: string) => string;
}) {
  const [content, setContent] = useState('guidance');
  const beforeText =
    content === 'full'
      ? fullPrompt(before)
      : before.promptInstructions
        ? guidance(before.promptInstructions)
        : null;
  const afterText =
    content === 'full'
      ? fullPrompt(after)
      : after.promptInstructions
        ? guidance(after.promptInstructions)
        : null;
  const changes = useMemo(
    () =>
      beforeText !== null && afterText !== null ? diffRecordedPrompt(beforeText, afterText) : null,
    [beforeText, afterText]
  );
  return (
    <div data-testid="protein-prompt-diff" className="mt-2 select-text">
      <p className="text-fg-muted">
        {before.promptLabel} → {after.promptLabel}
      </p>
      <select
        aria-label="Prompt comparison content"
        value={content}
        className="my-2 max-w-full rounded border border-border bg-bg px-2 py-1 text-xs"
        onChange={(event) => setContent(event.target.value)}
      >
        <option value="guidance">Variant guidance</option>
        <option value="full">Full app-sent prompts</option>
      </select>
      {changes ? (
        <div
          className="rounded border border-border text-xs"
          onMouseDownCapture={(event) => event.stopPropagation()}
          onDragStartCapture={(event) => event.preventDefault()}
        >
          {changes.every((change) => change.kind === 'unchanged') && (
            <p className="p-2 text-fg-muted">These recorded prompts are identical.</p>
          )}
          {changes.map((change, index) =>
            change.kind === 'unchanged' ? (
              <details key={index} className="p-2 text-fg-muted">
                <summary className="cursor-pointer">{change.lines.length} unchanged lines</summary>
                <pre data-change="unchanged" className="mt-1 whitespace-pre-wrap break-words">
                  {change.lines.join('\n')}
                </pre>
              </details>
            ) : (
              <div
                key={index}
                data-change={change.kind}
                className={`p-2 ${change.kind === 'added' ? 'bg-green-500/10' : 'bg-red-500/10'}`}
              >
                <span className="font-medium">{change.kind === 'added' ? 'Added' : 'Removed'}</span>
                <pre className="mt-1 whitespace-pre-wrap break-words">
                  {change.lines.join('\n')}
                </pre>
              </div>
            )
          )}
        </div>
      ) : (
        <p className="text-fg-muted">
          {beforeText === null ? before.promptLabel : after.promptLabel}: this prompt was not
          recorded.
        </p>
      )}
    </div>
  );
}

export function ProteinPromptComparison({
  current,
  alternate,
  guidance,
}: {
  current: ProteinRunIndexEntry;
  alternate: ProteinRunIndexEntry;
  guidance: (instructions: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [before, after] =
    current.createdAt < alternate.createdAt ? [current, alternate] : [alternate, current];
  return (
    <details className="mt-1" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="w-fit cursor-pointer text-accent">Compare prompts</summary>
      {expanded && <PromptDifference before={before} after={after} guidance={guidance} />}
    </details>
  );
}
