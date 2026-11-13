import type { TerminalCompletion } from '../../shared/terminal-completion';

export interface TerminalCompletionsProps {
  items: TerminalCompletion[];
  selected: number;
  loading: boolean;
  id: string;
  onSelect(index: number): void;
  onChoose(index: number): void;
  onClose(): void;
}

export function TerminalCompletions(props: TerminalCompletionsProps) {
  return (
    <div className="dnaforge-terminal-completions" onMouseDown={(event) => event.preventDefault()}>
      <div role="listbox" id={props.id} aria-label="Terminal suggestions" aria-busy={props.loading}>
        {props.items.map((item, index) => (
          <div
            key={item.token}
            id={`terminal-completion-${item.token}`}
            role="option"
            aria-selected={index === props.selected}
            onMouseEnter={() => props.onSelect(index)}
            onClick={() => props.onChoose(index)}
          >
            <span>{item.label}</span>
            <small>{item.kind}</small>
          </div>
        ))}
      </div>
      <div role="status">
        {props.loading
          ? 'Finding suggestions…'
          : props.items.length
            ? '↑↓ select · Tab or Enter inserts · Esc closes'
            : 'No suggestions at this prompt.'}
      </div>
      <button type="button" aria-label="Close terminal suggestions" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}
