import { toUserMessage } from '@waypoint/user-messages';
import { useId, useState } from 'react';
import type { SessionMode } from '../types';

export interface PendingFile {
  path: string;
  name: string;
}

interface InlineSessionFormProps {
  files: PendingFile[];
  referenceName: string;
  onCancel: () => void;
  onSubmit: (name: string, mode: SessionMode) => Promise<void> | void;
  onAddFiles?: () => void;
}

export function InlineSessionForm({
  files,
  referenceName,
  onCancel,
  onSubmit,
  onAddFiles,
}: InlineSessionFormProps) {
  const sessionNameId = useId();
  const defaultName = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${referenceName}`;
  const [name, setName] = useState('');
  const [mode, setMode] = useState<SessionMode>('one-per-clone');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    const finalName = name.trim() || defaultName;
    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(finalName, mode);
    } catch (err) {
      setError(toUserMessage(err, 'failure.failed-to-create-session'));
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && !name.trim()) {
      e.preventDefault();
      setName(defaultName);
    }
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    if (error) setError(null);
  };

  return (
    <div className="border-2 border-accent rounded-lg p-4 mb-4 bg-accent/5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-fg">New Alignment Session</h3>
        <button
          onClick={onCancel}
          className="text-fg-muted wp-interactive text-sm"
          aria-label="Cancel"
        >
          ✕
        </button>
      </div>

      {}
      <div className="mb-3">
        <label htmlFor={sessionNameId} className="block text-xs text-fg-muted mb-1">
          Session name <span className="text-fg-muted/50">(Tab for default)</span>
        </label>
        <input
          id={sessionNameId}
          type="text"
          value={name}
          onChange={handleNameChange}
          onKeyDown={handleKeyDown}
          placeholder={defaultName}
          className="w-full px-2 py-1.5 text-sm bg-bg border border-border rounded focus:outline-none focus:border-accent"
          autoFocus
          disabled={isSubmitting}
        />
        {error && (
          <p className="text-xs text-red-400 mt-1">{toUserMessage(error, 'alignment.failed')}</p>
        )}
      </div>

      {}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-fg-muted">Files to align ({files.length})</label>
          {onAddFiles && (
            <button
              onClick={onAddFiles}
              className="text-xs text-accent hover:text-accent/80"
              aria-label="Add more files"
            >
              + Add more
            </button>
          )}
        </div>
        <div className="max-h-24 overflow-y-auto text-xs text-fg-muted bg-bg rounded border border-border p-2">
          {files.map((f, i) => (
            <div key={i}>• {f.name}</div>
          ))}
        </div>
      </div>

      {}
      <div className="mb-4">
        <label className="block text-xs text-fg-muted mb-2">Session mode</label>
        <div className="space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === 'one-per-clone'}
              onChange={() => setMode('one-per-clone')}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm text-fg">1 clone per sequence</div>
              <div className="text-xs text-fg-muted">Compare independent clones</div>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === 'multi-per-clone'}
              onChange={() => setMode('multi-per-clone')}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm text-fg">Multiple sequences per clone</div>
              <div className="text-xs text-fg-muted">Build consensus from multiple reads</div>
            </div>
          </label>
        </div>
      </div>

      {}
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={isSubmitting}
          className="px-3 py-1.5 text-sm text-fg-muted wp-interactive rounded disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="px-3 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/80 disabled:opacity-50 flex items-center gap-2"
        >
          {isSubmitting ? (
            <>
              <span className="animate-spin">⟳</span>
              Aligning...
            </>
          ) : (
            'Create & Align'
          )}
        </button>
      </div>
    </div>
  );
}
