import type { AgentStructuredOutputReceipt } from '../../shared/agent-structured-output';

interface StructuredOutputCardProps {
  receipt: AgentStructuredOutputReceipt;
}

export function StructuredOutputCard({ receipt }: StructuredOutputCardProps) {
  const valid = receipt.status === 'valid';
  const content = valid ? JSON.stringify(receipt.parsed, null, 2) : receipt.rawResult;
  return (
    <div
      className={`mt-3 overflow-hidden rounded-lg border ${
        valid ? 'border-success/30 bg-success/5' : 'border-error/30 bg-error/5'
      }`}
      data-testid="structured-output-card"
      data-validation-status={receipt.status}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <span className={`text-xs font-medium ${valid ? 'text-success' : 'text-error'}`}>
          {valid ? 'Valid structured result' : 'Invalid structured result'}
        </span>
        <span className="max-w-[55%] truncate font-mono text-[10px] text-fg-subtle">
          {receipt.artifactId}
        </span>
      </div>
      {!valid && receipt.validationError && (
        <p className="px-3 pt-2 text-xs text-error">{receipt.validationError}</p>
      )}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-fg">
        {content}
      </pre>
    </div>
  );
}
